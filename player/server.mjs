// Local-only player: its state is independent of the downloader's job state.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config, replaceFileAtomic } from '../agent/lib/config.mjs';
import { buildAudioLibrary } from '../agent/lib/audio-library.mjs';
import { readSiteLikes, siteLikesView } from '../agent/lib/site-likes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 256 * 1024;
const STATE_FIELDS = new Set(['revision', 'queue', 'playlists', 'favorites', 'history', 'volume', 'repeat', 'shuffle', 'currentFileId', 'currentTime']);
const STATIC_FILES = new Map([
  ['/', [path.join(HERE, 'public', 'index.html'), 'text/html; charset=utf-8']],
  ['/index.html', [path.join(HERE, 'public', 'index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [path.join(HERE, 'public', 'app.js'), 'text/javascript; charset=utf-8']],
  ['/style.css', [path.join(HERE, 'public', 'style.css'), 'text/css; charset=utf-8']],
  ['/styles.css', [path.join(HERE, 'public', 'style.css'), 'text/css; charset=utf-8']],
  ['/tokens.css', [path.join(HERE, '..', 'design', 'tokens.css'), 'text/css; charset=utf-8']],
]);
const MEDIA_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', aiff: 'audio/aiff', aif: 'audio/aiff', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg' };

function failure(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

function checkIds(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || value.some((id) => !validId(id))) throw failure(400, `${label} 格式不正確或超過上限`, 'INVALID_STATE');
}

function validateState(value) {
  if (!object(value) || Object.keys(value).some((key) => !STATE_FIELDS.has(key))) throw failure(400, '播放器狀態含不支援的欄位', 'INVALID_STATE');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw failure(400, '狀態版本不正確', 'INVALID_STATE');
  checkIds(value.queue, 10000, '播放佇列');
  checkIds(value.favorites, 10000, '收藏');
  if (!Array.isArray(value.playlists) || value.playlists.length > 100) throw failure(400, '播放清單數量超過上限', 'INVALID_STATE');
  const playlistIds = new Set();
  for (const playlist of value.playlists) {
    if (!object(playlist) || Object.keys(playlist).some((key) => !['id', 'name', 'fileIds'].includes(key)) || !validId(playlist.id) || playlistIds.has(playlist.id) || typeof playlist.name !== 'string' || !playlist.name.trim() || playlist.name.length > 120 || /[\x00-\x1f\x7f]/.test(playlist.name)) throw failure(400, '播放清單格式不正確', 'INVALID_STATE');
    playlistIds.add(playlist.id);
    checkIds(playlist.fileIds, 10000, '播放清單曲目');
  }
  if (!Array.isArray(value.history) || value.history.length > 1000 || value.history.some((item) => !object(item) || Object.keys(item).some((key) => !['fileId', 'at'].includes(key)) || !validId(item.fileId) || !Number.isSafeInteger(item.at) || item.at < 0)) throw failure(400, '播放歷史格式不正確', 'INVALID_STATE');
  if (typeof value.volume !== 'number' || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) throw failure(400, '音量必須在 0 到 1 之間', 'INVALID_STATE');
  if (!['off', 'all', 'one'].includes(value.repeat) || typeof value.shuffle !== 'boolean') throw failure(400, '循環或隨機設定不正確', 'INVALID_STATE');
  if (value.currentFileId !== null && !validId(value.currentFileId)) throw failure(400, '目前曲目不正確', 'INVALID_STATE');
  if (typeof value.currentTime !== 'number' || !Number.isFinite(value.currentTime) || value.currentTime < 0 || value.currentTime > 31536000) throw failure(400, '播放位置不正確', 'INVALID_STATE');
  return value;
}

async function readBody(req, optional = false) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const length = Number(req.headers['content-length'] || 0);
  if (length > BODY_LIMIT) throw failure(413, '請求資料過大', 'BODY_TOO_LARGE');
  if (type !== 'application/json' && !(optional && !length && !req.headers['transfer-encoding'])) throw failure(415, '請使用 application/json', 'JSON_REQUIRED');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw failure(413, '請求資料過大', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size && optional) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, 'JSON 格式不正確', 'INVALID_JSON'); }
  if (!object(body)) throw failure(400, '請求必須是 JSON 物件', 'INVALID_JSON');
  return body;
}

async function atomicWrite(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await replaceFileAtomic(temporary, file);
  } finally {
    await fsp.unlink(temporary).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (!match[1] && !match[2])) throw failure(416, '不支援此播放範圍', 'INVALID_RANGE');
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) throw failure(416, '播放範圍超過上限', 'INVALID_RANGE');
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  if ((first === null && last === 0) || start < 0 || start >= size || end < start) throw failure(416, '播放範圍超出檔案', 'INVALID_RANGE');
  return { start, end };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

export function createHubProbe({ port = Number(process.env.ACE_HUB_PORT || 8788), timeoutMs = 2000, cacheMs = 5000 } = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  agent.on('free', (socket) => socket.unref());
  let cachedAt = 0;
  let cached = false;
  let failures = 0;
  let pending;
  const probe = async () => {
    if (Date.now() - cachedAt < cacheMs) return cached;
    if (!pending) pending = new Promise((resolve) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve(false);
      // Hub 忙於快照或整理時事件迴圈可能短暫卡住；放寬逾時，並且連續兩次失敗才顯示離線。
      const request = http.get({ host: '127.0.0.1', port, path: '/health', agent, timeout: timeoutMs }, (response) => {
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 16384) response.destroy();
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try { resolve(response.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString('utf8')).ok === true); } catch { resolve(false); }
        });
        response.on('error', () => resolve(false));
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(false));
    }).then((online) => {
      failures = online ? 0 : failures + 1;
      cached = online || (cached && failures < 2);
      cachedAt = Date.now();
      pending = null;
      return cached;
    });
    return pending;
  };
  return { probe, close: () => agent.destroy() };
}

export function createPlayerServer(options = {}) {
  const cfg = options.cfg || config();
  const root = options.root || 'ai音樂';
  const libraryRoot = path.resolve(cfg.downloadDir, root);
  if (!inside(path.resolve(cfg.downloadDir), libraryRoot)) throw new Error('播放器曲庫必須位於下載資料夾內');
  const stateDir = options.stateDir || process.env.ACE_PLAYER_STATE_DIR || path.join(cfg.stateDir, 'player-state');
  const stateFile = path.join(stateDir, 'state.json');
  const buildLibrary = options.buildLibrary || buildAudioLibrary;
  // 網站原生點讚：唯讀來源，與本機收藏 state.favorites 分開保存，不寫入播放器 CAS 狀態。
  const readLikes = options.readSiteLikes || (async () => siteLikesView(await readSiteLikes(cfg)));
  const syncLikes = options.syncSiteLikes || (async () => (await import('../agent/lib/ace.mjs')).syncSiteLikesFromSite(cfg));
  const likesIntervalMs = options.siteLikesIntervalMs ?? Number(process.env.ACE_PLAYER_SITE_LIKES_INTERVAL_MS || 10 * 60 * 1000);
  let likesSync = null;
  let likesTimer = 0;
  const runLikesSync = () => {
    if (!likesSync) likesSync = Promise.resolve().then(syncLikes).finally(() => { likesSync = null; });
    return likesSync;
  };
  const likesRevision = async () => {
    // 輪詢用標記：點讚內容或最近一次同步結果有變才通知前端重讀。
    try { const view = await readLikes(); return view.synced || view.lastAttempt ? `${view.revision || ''}|${view.lastAttempt?.at || ''}` : ''; } catch { return ''; }
  };
  const hub = createHubProbe();
  const probeHub = options.probeHub || hub.probe;
  let snapshot;
  let indexedAt = 0;
  let indexing;
  let libraryGeneration = 0;
  let indexedGeneration = -1;
  const libraryWatchers = [];
  const watchedSources = new Set(['history.json', 'browser-download-state.json', 'agent-state.json', 'verified-audio.json', 'page-songs.json', 'page-unavailable.json', 'file-id-aliases.json']);
  for (const [directory, recursive] of [[libraryRoot, true], [cfg.stateDir, false]]) {
    try {
      const watcher = fs.watch(directory, { recursive }, (_event, filename) => {
        const name = String(filename || '');
        if (recursive && /\.(?:part|tmp|crdownload)$/i.test(name)) return;
        if (recursive || watchedSources.has(name)) libraryGeneration += 1;
      });
      watcher.on('error', () => { libraryGeneration += 1; });
      watcher.unref();
      libraryWatchers.push(watcher);
    } catch { /* The bounded cache TTL still recovers a directory created later. */ }
  }
  let savedState;
  let stateLoad;
  let writeChain = Promise.resolve();
  let selection = { serial: 0, songId: null };

  const library = async (refresh = false) => {
    if (refresh) libraryGeneration += 1;
    if (!refresh && snapshot && indexedGeneration === libraryGeneration && Date.now() - indexedAt < (libraryWatchers.length ? 30000 : 3000)) return snapshot;
    if (!indexing) {
      const generation = libraryGeneration;
      indexing = Promise.resolve(buildLibrary({ cfg, root })).then((value) => {
        if (!value || !object(value.library) || !(value.filesById instanceof Map)) throw new Error('曲庫索引回應格式不正確');
        snapshot = value;
        indexedAt = Date.now();
        indexedGeneration = generation;
        return value;
      }).finally(() => { indexing = null; });
    }
    return indexing;
  };

  const loadState = async () => {
    if (!stateLoad) stateLoad = (async () => {
      try {
        savedState = validateState(JSON.parse(await fsp.readFile(stateFile, 'utf8')));
      } catch (err) {
        if (err.code !== 'ENOENT') throw failure(422, '播放器狀態檔無法讀取，原檔已保留；請先備份再修復', 'STATE_UNREADABLE');
        let favorites = [];
        try {
          const page = JSON.parse(await fsp.readFile(path.join(cfg.stateDir, 'page-favorites.json'), 'utf8'));
          const source = page.favorites;
          favorites = (Array.isArray(source) ? source.map((item) => typeof item === 'string' ? item : item?.task_id) : object(source) ? Object.keys(source).filter((id) => source[id]) : []).filter(validId).slice(0, 10000);
        } catch { /* The player works without the page channel. */ }
        savedState = { revision: 0, queue: [], playlists: [], favorites, history: [], volume: 0.8, repeat: 'all', shuffle: false, currentFileId: null, currentTime: 0 };
      }
      return savedState;
    })();
    await stateLoad;
    return savedState;
  };

  const updateState = (body) => {
    const task = writeChain.then(async () => {
      const current = await loadState();
      const { expectedRevision, ...patch } = body;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure(400, '儲存時必須提供 expectedRevision', 'REVISION_REQUIRED');
      if (expectedRevision !== current.revision) throw failure(409, '播放器設定已在另一個視窗更新，請重新載入後再儲存', 'REVISION_CONFLICT');
      if (Object.keys(patch).some((key) => !STATE_FIELDS.has(key)) || ('revision' in patch && patch.revision !== expectedRevision)) throw failure(400, '播放器狀態含不支援的欄位或版本', 'INVALID_STATE');
      const next = validateState({ ...current, ...patch, revision: current.revision + 1 });
      await atomicWrite(stateFile, next);
      savedState = next;
      return next;
    });
    writeChain = task.catch(() => {});
    return task;
  };

  const knownFile = async (fileId) => {
    if (!validId(fileId)) throw failure(404, '找不到這個音檔', 'FILE_NOT_FOUND');
    const { filesById } = await library();
    const file = filesById.get(fileId);
    if (!file || typeof file.absolutePath !== 'string') throw failure(404, '找不到這個音檔，請重新掃描曲庫', 'FILE_NOT_FOUND');
    let realRoot;
    let realFile;
    let stat;
    try {
      [realRoot, realFile] = await Promise.all([fsp.realpath(libraryRoot), fsp.realpath(file.absolutePath)]);
      if (!inside(realRoot, realFile)) throw failure(403, '音檔已移出曲庫，請重新掃描', 'FILE_OUTSIDE_LIBRARY');
      stat = await fsp.stat(realFile);
    } catch (err) {
      if (err.status) throw err;
      throw failure(404, '音檔已搬移或不存在，請重新掃描', 'FILE_NOT_FOUND');
    }
    if (!stat.isFile()) throw failure(404, '找不到這個音檔', 'FILE_NOT_FOUND');
    return { file, absolutePath: realFile, stat };
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      const port = server.address()?.port;
      const host = String(req.headers.host || '');
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, '只允許播放器本機視窗存取', 'LOCAL_ORIGIN_REQUIRED');
      const url = new URL(req.url, `http://${host}`);
      const method = req.method || 'GET';
      if (url.pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, service: 'huaidj-player', version: '1.8.0', pid: process.pid });
      if (url.pathname === '/api/selection' && method === 'GET') return json(res, 200, selection);
      if (url.pathname === '/api/library/revision' && method === 'GET') {
        const [indexed, likes] = await Promise.all([library(), likesRevision()]);
        return json(res, 200, { ok: true, revision: String(indexed.library.revision || ''), siteLikesRevision: likes });
      }
      if (url.pathname === '/api/site-likes' && method === 'GET') {
        if (url.search) throw failure(400, '網站點讚查詢不接受參數', 'INVALID_REQUEST');
        return json(res, 200, { ...(await readLikes()), syncing: !!likesSync });
      }
      if (url.pathname === '/api/site-likes/sync' && method === 'POST') {
        const body = await readBody(req, true);
        if (Object.keys(body).length) throw failure(400, '同步網站點讚不接受參數', 'INVALID_REQUEST');
        return json(res, 200, await runLikesSync());
      }
      if (url.pathname === '/api/select' && method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(body).some((key) => key !== 'songId') || !validId(body.songId)) throw failure(400, '歌曲 ID 不正確', 'INVALID_REQUEST');
        selection = { serial: selection.serial + 1, songId: body.songId };
        return json(res, 200, { ok: true, ...selection });
      }
      if ((url.pathname === '/api/library' && method === 'GET') || (url.pathname === '/api/reindex' && method === 'POST')) {
        if (method === 'POST') {
          const body = await readBody(req, true);
          if (Object.keys(body).length) throw failure(400, '重新掃描不接受檔案路徑或其他參數', 'INVALID_REQUEST');
        }
        if ([...url.searchParams.keys()].some((key) => key !== 'refresh')) throw failure(400, '不支援此曲庫查詢參數', 'INVALID_REQUEST');
        const [indexed, online] = await Promise.all([library(method === 'POST' || url.searchParams.get('refresh') === '1'), probeHub()]);
        return json(res, 200, { ...indexed.library, hub: { ...(indexed.library.hub || {}), online: !!online } });
      }
      if (url.pathname === '/api/state' && method === 'GET') return json(res, 200, await loadState());
      if (url.pathname === '/api/state' && method === 'PUT') return json(res, 200, await updateState(await readBody(req)));
      if (url.pathname === '/api/reveal' && method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(body).some((key) => key !== 'fileId')) throw failure(400, '只接受音檔 ID', 'INVALID_REQUEST');
        const { absolutePath } = await knownFile(body.fileId);
        if (!(options.disableReveal || process.env.ACE_PLAYER_DISABLE_REVEAL === '1')) {
          if (process.platform !== 'win32') throw failure(501, '此版本的開啟資料夾功能需要 Windows', 'REVEAL_UNAVAILABLE');
          await new Promise((resolve, reject) => {
            const child = spawn('explorer.exe', ['/select,', absolutePath], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
            child.once('error', reject);
            child.once('spawn', () => { child.unref(); resolve(); });
          });
        }
        return json(res, 200, { ok: true });
      }
      const media = /^\/media\/([^/]+)$/.exec(url.pathname);
      if (media && (method === 'GET' || method === 'HEAD')) {
        if (url.search) throw failure(400, '播放只接受音檔 ID', 'INVALID_REQUEST');
        let fileId;
        try { fileId = decodeURIComponent(media[1]); } catch { throw failure(400, '音檔 ID 格式不正確', 'INVALID_REQUEST'); }
        const { file, absolutePath, stat } = await knownFile(fileId);
        if (!stat.size || ['invalid', 'truncated', 'corrupt', 'damaged'].includes(file.validity) || file.playable === false) throw failure(422, '音檔不完整或格式損壞，請重新下載；原檔已保留', 'AUDIO_INVALID');
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': MEDIA_TYPES[String(file.format || '').toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, no-cache', ETag: etag };
        let range;
        if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
          try { range = byteRange(req.headers.range, stat.size); } catch (err) { res.setHeader('Content-Range', `bytes */${stat.size}`); throw err; }
        }
        if (!range && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
        if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
        headers['Content-Length'] = range ? range.end - range.start + 1 : stat.size;
        res.writeHead(range ? 206 : 200, headers);
        if (method === 'HEAD') return res.end();
        const stream = fs.createReadStream(absolutePath, range || undefined);
        res.once('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }
      if (STATIC_FILES.has(url.pathname) && (method === 'GET' || method === 'HEAD')) {
        const [file, type] = STATIC_FILES.get(url.pathname);
        let body;
        try { body = await fsp.readFile(file); } catch { throw failure(404, '播放器介面檔案不存在', 'NOT_FOUND'); }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
        return res.end(method === 'HEAD' ? undefined : body);
      }
      throw failure(404, '找不到此功能', 'NOT_FOUND');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      const status = err.status || 500;
      json(res, status, { ok: false, error: status < 500 ? err.message : '播放器本機服務發生錯誤，請查看本機日誌', code: err.code || 'PLAYER_ERROR' });
      if (status >= 500) console.error('[HuaiDJ Player]', err.code || err.name || 'error');
    }
  });
  // 自動同步只在明確要求時啟用（正式啟動入口）；測試與嵌入使用者不會意外連到站點。
  if (options.autoSyncSiteLikes) {
    server.once('listening', () => {
      runLikesSync().catch(() => {});
      if (likesIntervalMs > 0) {
        likesTimer = setInterval(() => { runLikesSync().catch(() => {}); }, Math.max(60000, likesIntervalMs));
        likesTimer.unref?.();
      }
    });
  }
  server.on('close', () => {
    hub.close();
    clearInterval(likesTimer);
    for (const watcher of libraryWatchers) watcher.close();
  });
  server.playerStateFile = stateFile;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ACE_PLAYER_PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ACE_PLAYER_PORT 必須是 1 到 65535 的整數');
  const server = createPlayerServer({ autoSyncSiteLikes: process.env.ACE_PLAYER_SITE_LIKES !== '0' });
  server.once('error', (err) => { console.error('播放器無法啟動：', err.code || err.name); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`HuaiDJ Player 1.8.0 http://127.0.0.1:${port}`));
}
