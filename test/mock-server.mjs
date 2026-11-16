// test/mock-server.mjs — 本地 mock ACE Music 站（純 node:http，無外部依賴）。
//
// 依 CONTRACT.md 第 4 節需求模擬：
//   GET  /create/、/zh/create/           登入態頁面（頁面 script 設 document.cookie="sess=1"）
//   GET  /api/songs?limit&sort&after     分頁歌單（需 cookie；未帶 401）
//   GET  /api/songs/<id>/file?kind=mp3|wav
//   POST /api/songs/<id>/download        → 202（MIDI/MusicXML 生成）
//   GET  /api/songs/<id>/download?kind=full|musicxml → 輪詢數次後回 { url }
//   GET  /data/mock/*、/data/stems/*     固定 bytes（需 cookie；檔名/路徑不同 => bytes 不同）
//
// 假資料（5 種類、6 筆）：
//   A  song-a  "Neon Drive"     succeeded / music_generate / stems mode 2（3 有效軌 + 1 empty）+ MIDI
//   B  song-b  "Paper Sky"      succeeded / music_transcribe / 只有 stems mode 0（2 軌）+ MIDI + MusicXML
//   C  song-c  "Rain: Loop? v2" succeeded / music_generate / 無分軌、只有 MIDI（title 含非法字元，測清理）
//   D  song-d  "Still Cooking"  processing（未完成，面板須忽略）
//   E1 song-e1 "Where Am I"     succeeded / stem_split / stems mode 2（2 軌，無 MIDI）
//   E2 song-e2 "Where Am I"     同上（同名，驗證資料夾 (2) 後綴）
//
// e2e 的期望值一律以 CONTRACT.md 2.4 手寫，不從 src/planner.js 推導（保持驗證獨立性）。
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const TS = (iso) => iso;

// 固定 bytes：同一 tag+name 永遠相同；不同 tag/name 不同（e2e 以內容區分每個檔案）。
const FILLER = 'F'.repeat(24);
export const expectedBytes = (tag, name) => Buffer.from(`${tag}:${name}:${FILLER}`, 'utf8');

const track = (id, type, extra = {}) => ({
  id,
  type,
  local_audio: `/data/stems/${id}.mp3`,
  duration: 12.5,
  peaks: null,
  ...extra,
});

export const SONGS = [
  {
    task_id: 'song-a',
    capability: 'music_generate',
    status: 'succeeded',
    model: 'acemusic-v1.1',
    created_at: TS('2026-11-15T10:00:00Z'),
    local_audio: '/data/mock/song-a.mp3',
    local_play: '/data/mock/song-a.mp3',
    local_cover: '/data/mock/song-a-cover.jpg',
    meta: { title: 'Neon Drive', stem: 'neon-drive' },
    result: { duration_sec: 95.4 },
    stems: {
      '2': {
        status: 'done',
        tracks: [
          track('song-a-vocal', 'vocal'),
          track('song-a-drums', 'drums'),
          track('song-a-bass', 'bass'),
          // empty 軌：面板/planner 必須跳過，不得下載
          { id: 'song-a-perc', type: 'percussion', empty: true, local_audio: null },
        ],
      },
      '0': {
        status: 'done',
        tracks: [track('song-a0-vocal', 'vocal'), track('song-a0-inst', 'instrumental')],
      },
    },
  },
  {
    task_id: 'song-b',
    capability: 'music_transcribe',
    status: 'succeeded',
    model: 'ace-step-v2',
    created_at: TS('2026-11-15T09:00:00Z'),
    local_audio: '/data/mock/song-b.mp3',
    local_play: '/data/mock/song-b.mp3',
    local_cover: null,
    meta: { title: 'Paper Sky', stem: 'paper-sky' },
    result: { duration_sec: 61 },
    stems: {
      '0': {
        status: 'done',
        tracks: [track('song-b-vocal', 'vocal'), track('song-b-inst', 'instrumental')],
      },
    },
  },
  {
    task_id: 'song-c',
    capability: 'music_generate',
    status: 'succeeded',
    model: 'ace-step-v2',
    created_at: TS('2026-11-15T08:00:00Z'),
    local_audio: '/data/mock/song-c.mp3',
    local_play: '/data/mock/song-c.mp3',
    local_cover: null,
    meta: { title: 'Rain: Loop? v2', stem: 'rain-loop' },
    result: { duration_sec: 30 },
    stems: {},
  },
  {
    task_id: 'song-d',
    capability: 'music_generate',
    status: 'processing',
    model: 'ace-step-v2',
    created_at: TS('2026-11-15T07:00:00Z'),
    local_audio: null,
    local_play: null,
    local_cover: null,
    meta: { title: 'Still Cooking', stem: 'still-cooking' },
    result: { duration_sec: 0 },
    stems: { '2': { status: 'running', tracks: [] } },
  },
  {
    task_id: 'song-e1',
    capability: 'stem_split',
    status: 'succeeded',
    model: 'ace-stem-v1',
    created_at: TS('2026-11-15T06:00:00Z'),
    local_audio: '/data/mock/song-e1.mp3',
    local_play: '/data/mock/song-e1.mp3',
    local_cover: null,
    meta: { title: 'Where Am I', stem: 'where-am-i' },
    result: { duration_sec: 44 },
    stems: {
      '2': {
        status: 'done',
        tracks: [track('song-e1-vocal', 'vocal'), track('song-e1-drums', 'drums')],
      },
    },
  },
  {
    task_id: 'song-e2',
    capability: 'stem_split',
    status: 'succeeded',
    model: 'ace-stem-v1',
    created_at: TS('2026-11-15T05:00:00Z'),
    local_audio: '/data/mock/song-e2.mp3',
    local_play: '/data/mock/song-e2.mp3',
    local_cover: null,
    meta: { title: 'Where Am I', stem: 'where-am-i-2' },
    result: { duration_sec: 52 },
    stems: {
      '2': {
        status: 'done',
        tracks: [track('song-e2-vocal', 'vocal'), track('song-e2-drums', 'drums')],
      },
    },
  },
];

// 面板會顯示的（isDone: succeeded 且有 local_audio）共 5 首，song-d 被忽略。
export const VISIBLE_SONG_IDS = SONGS.filter((s) => s.status === 'succeeded' && s.local_audio).map(
  (s) => s.task_id,
);

const PAGE_CREATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ACE Music Mock — Create</title>
<style>body{font-family:system-ui;margin:0;background:#111;color:#eee}main{padding:24px}</style></head>
<body><main><h1>ACE Music Mock /create/</h1><p id="status">mock create page</p>
<!-- 對齊真站的欄位 id（public/app.js）：Idea＝#prompt、Custom Style＝#caption；模式／模型存在 localStorage createMode／aceModel -->
<button id="modelBtn" type="button">ACE Music v1.1 Preview</button>
<div id="ideaMode"><textarea id="prompt" rows="3"></textarea></div>
<div id="customMode" style="display:none"><textarea id="caption" rows="3"></textarea><textarea id="lyrics" rows="2"></textarea></div>
<button id="generate" type="button">Generate</button></main>
<script>
  var noAuth = new URLSearchParams(location.search).has('auth-off');
  if (!noAuth) document.cookie = 'sess=1; path=/';
  document.getElementById('status').textContent = noAuth ? 'logged-out mock' : 'logged-in mock';
  window.__gen = 0; window.__inputEvents = 0;
  document.getElementById('generate').addEventListener('click', function () { window.__gen += 1; });
  document.getElementById('prompt').addEventListener('input', function () { window.__inputEvents += 1; });
  document.getElementById('caption').addEventListener('input', function () { window.__inputEvents += 1; });
</script></body></html>`;

const PAGE_OTHER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ACE Music Mock — Library</title></head>
<body><h1>mock library page (content script should not inject here)</h1></body></html>`;

const isAuthed = (req) => /(?:^|;\s*)sess=1(?:;|$)/.test(req.headers.cookie || '');

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** 1 秒、8 kHz、單聲道、8-bit 靜音 WAV（給 <audio> 播放用） */
const SILENT_WAV = (() => {
  const data = Buffer.alloc(8000, 128);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(8000, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
})();

const parseCursor = (cursor) => {
  if (!cursor) return -1;
  const idx = SONGS.findIndex((s) => `${s.created_at}~${s.task_id}` === cursor);
  return idx;
};

/**
 * @param {{pageSize?: number, pollsBeforeReady?: number}} options
 */
export function startMockServer(options = {}) {
  const pageSize = Math.max(1, Number(options.pageSize) || 4);
  const pollsBeforeReady = Math.max(0, Number(options.pollsBeforeReady ?? 1));

  const log = [];
  const polls = new Map(); // `${id}:${kind}` -> 已輪詢次數
  const failing = new Set(); // pathname 集合：命中就回 500（測失敗顯示）
  const failFirst = new Map(); // pathname -> 接下來的 N 次請求回 500（測 content 端 blob 備援）
  // 即時同步（對齊真站 /api/songs/events + /api/songs/changes?since=）
  const songs = [...SONGS];
  let ver = 1;
  const changes = []; // { ver, task_id }
  const sseClients = new Set();
  const noDownload = new Set(); // ${id}: → 404 no_download
  const rateLimited = new Set(); // ${id}: → 429
  const findSong = (id) => songs.find((s) => s.task_id === id);
  const bump = (id) => {
    ver += 1;
    changes.push({ ver, task_id: id });
    for (const client of sseClients) client.write(`data: ${JSON.stringify({ ver })}\n\n`);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const entry = {
      method: req.method,
      path: url.pathname + url.search,
      authed: isAuthed(req),
      cookie: req.headers.cookie || null,
      status: 0,
      at: Date.now(),
    };
    log.push(entry);
    res.on('finish', () => {
      entry.status = res.statusCode;
    });
    const send = (code, body, headers = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      res.writeHead(code, { 'content-length': buf.length, ...headers });
      res.end(buf);
    };
    const sendJson = (code, obj) => send(code, JSON.stringify(obj), { 'content-type': 'application/json' });
    const deny = () => sendJson(401, { error: 'unauthorized', message: 'login required' });

    // 測試用故障注入：讓指定 pathname 一律回 500
    if (failing.has(url.pathname)) {
      sendJson(500, { error: 'injected failure', message: 'mock 500' });
      return;
    }
    // 只讓前 N 次請求失敗：驗證 content 端「直連失敗 → fetch → blob → SW」備援成功路徑
    const remaining = failFirst.get(url.pathname) || 0;
    if (remaining > 0) {
      failFirst.set(url.pathname, remaining - 1);
      sendJson(500, { error: 'injected first-failure', message: 'mock 500 first request' });
      return;
    }

    // ---- pages ----
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?create\/?$/.test(url.pathname)) {
      send(200, PAGE_CREATE, { 'content-type': 'text/html; charset=utf-8' });
      return;
    }
    if (url.pathname === '/favicon.ico') {
      send(204, '');
      return;
    }
    if (url.pathname === '/library/' || url.pathname === '/library') {
      send(200, PAGE_OTHER, { 'content-type': 'text/html; charset=utf-8' });
      return;
    }

    // ---- auth helpers ----
    if (url.pathname === '/api/logout') {
      send(200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json',
        'set-cookie': 'sess=; path=/; max-age=0',
      });
      return;
    }

    // ---- site status（模型清單：lossy 模型沒有 WAV）----
    if (url.pathname === '/api/status' && req.method === 'GET') {
      sendJson(200, { ok: true, upload: true, cover: true, models: [
          { id: 'acemusic-v1', name: 'ACE Music v1', limits: { prompt: 2000, style: 1000, lyrics: 5000 } },
          { id: 'acemusic-v1.1', name: 'ACE Music v1.1 Preview', reads: true, limits: { prompt: 2000, style: 1000, lyrics: 5000 } },
          { id: 'ace-step-1.5-xl', name: 'ACE-Step v1.5 XL', lossy: true, free: true, limits: { prompt: 2000, style: 512, lyrics: 2000 } },
          { id: 'ace-step-v2', lossy: true },
        ] });
      return;
    }

    // ---- songs list ----
    if (url.pathname === '/api/songs' && req.method === 'GET') {
      if (!isAuthed(req)) {
        deny();
        return;
      }
      const sort = url.searchParams.get('sort') === 'old' ? 'old' : 'new';
      const after = url.searchParams.get('after') || '';
      let ordered = [...songs];
      if (sort === 'new') ordered.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      else ordered.sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
      const startIdx = after
        ? ordered.findIndex((s) => `${s.created_at}~${s.task_id}` === after) + 1
        : 0;
      const slice = ordered.slice(startIdx, startIdx + pageSize);
      const last = slice[slice.length - 1];
      const next = slice.length === pageSize && last ? `${last.created_at}~${last.task_id}` : null;
      sendJson(200, { items: slice, next, ver });
      return;
    }

    if (url.pathname === '/api/songs/events' && req.method === 'GET') {
      if (!isAuthed(req)) {
        deny();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ ver })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (url.pathname === '/api/songs/changes' && req.method === 'GET') {
      if (!isAuthed(req)) {
        deny();
        return;
      }
      const since = Number(url.searchParams.get('since')) || 0;
      const ids = [...new Set(changes.filter((c) => c.ver > since).map((c) => c.task_id))];
      sendJson(200, { items: ids.map(findSong).filter(Boolean), gone: [], ver, reset: false });
      return;
    }

    // ---- full-song audio file ----
    const fileMatch = url.pathname.match(/^\/api\/songs\/([^/]+)\/file$/);
    if (fileMatch && req.method === 'GET') {
      if (!isAuthed(req)) {
        deny();
        return;
      }
      const id = decodeURIComponent(fileMatch[1]);
      const kind = url.searchParams.get('kind') || 'mp3';
      atFullAudio(id, kind);
      send(200, expectedBytes(`AUDIO-${kind.toUpperCase()}`, id), {
        'content-type': kind === 'wav' ? 'audio/wav' : 'audio/mpeg',
      });
      return;
    }

    function atFullAudio(id, kind) {
      entry.audioId = id;
      entry.audioKind = kind;
    }

    // ---- MIDI / MusicXML generation: POST 202 + polling GET ----
    const genMatch = url.pathname.match(/^\/api\/songs\/([^/]+)\/download$/);
    if (genMatch) {
      if (!isAuthed(req)) {
        deny();
        return;
      }
      const id = decodeURIComponent(genMatch[1]);
      const song = findSong(id);
      if (!song) {
        sendJson(404, { error: 'not found' });
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const kind = body.kind === 'musicxml' ? 'musicxml' : 'full';
        if (noDownload.has(`${id}:${kind}`)) {
          sendJson(404, { error: { code: 'no_download', message: "This file isn't available for this song" } });
          return;
        }
        if (rateLimited.has(`${id}:${kind}`)) {
          sendJson(429, { error: { code: 'rate_limited', message: "You're doing that too often" } });
          return;
        }
        if (!(song.status === 'succeeded' && song.local_audio)) {
          sendJson(409, { error: 'song not ready' });
          return;
        }
        polls.set(`${id}:${kind}`, 0);
        sendJson(202, { status: 'pending', kind });
        return;
      }
      if (req.method === 'GET') {
        const kind = url.searchParams.get('kind') === 'musicxml' ? 'musicxml' : 'full';
        const key = `${id}:${kind}`;
        const seen = polls.get(key);
        if (seen == null) {
          sendJson(400, { error: 'poll without POST' });
          return;
        }
        if (seen < pollsBeforeReady) {
          polls.set(key, seen + 1);
          sendJson(202, { status: 'pending' });
          return;
        }
        const ext = kind === 'musicxml' ? 'musicxml' : 'mid';
        sendJson(200, { url: `/data/mock/${id}-${kind}.${ext}` });
        return;
      }
    }

    // ---- static /data/* (needs cookie, like the real site) ----
    if (url.pathname.startsWith('/data/mock/') || url.pathname.startsWith('/data/stems/')) {
      if (!isAuthed(req)) {
        deny();
        return;
      }
      // 瀏覽器的 <audio>（電臺播放）會帶 Sec-Fetch-Dest: audio：回一段真的靜音 WAV，播放才不會報錯；
      // 下載（chrome.downloads／fetch）不是 audio，仍回固定 bytes，e2e 的檔案內容斷言不變。
      if (req.headers['sec-fetch-dest'] === 'audio') {
        send(200, SILENT_WAV, { 'content-type': 'audio/wav', 'accept-ranges': 'none' });
        return;
      }
      if (url.pathname.startsWith('/data/stems/')) {
        send(200, expectedBytes('DATA-STEMS', url.pathname), { 'content-type': 'audio/mpeg' });
      } else {
        send(200, expectedBytes('DATA-MOCK', url.pathname), { 'content-type': 'application/octet-stream' });
      }
      return;
    }

    send(404, 'NOT_FOUND', { 'content-type': 'text/plain' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        base: `http://127.0.0.1:${port}`,
        log,
        songs: SONGS,
        visibleSongIds: VISIBLE_SONG_IDS,
        close: () => new Promise((r) => server.close(r)),
        requestCount: (prefix) => log.filter((e) => e.path.startsWith(prefix)).length,
        clearLog: () => {
          log.length = 0;
        },
        failPath: (pathname) => failing.add(pathname),
        clearFailures: () => failing.clear(),
        failFirstRequests: (pathname, n = 1) => failFirst.set(pathname, n),
        /** 模擬「站點新完成一首歌」：加入歌單、ver+1、推 SSE */
        addSong: (song) => {
          songs.unshift(song);
          bump(song.task_id);
        },
        /** 模擬既有歌曲更新（例如分軌完成） */
        updateSong: (id, patch) => {
          const song = findSong(id);
          if (song) Object.assign(song, patch);
          bump(id);
        },
        removeSong: (id) => {
          const i = songs.findIndex((s) => s.task_id === id);
          if (i >= 0) songs.splice(i, 1);
        },
        setNoDownload: (id, kind = 'full') => noDownload.add(`${id}:${kind}`),
        setRateLimited: (id, kind = 'full') => rateLimited.add(`${id}:${kind}`),
        clearSiteErrors: () => {
          noDownload.clear();
          rateLimited.clear();
        },
        sseClientCount: () => sseClients.size,
        get ver() {
          return ver;
        },
      });
    });
  });
}

// `node test/mock-server.mjs` → 手動開 mock 站除錯用（預設 8787）
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.MOCK_PORT) || 8787;
  const server = http.createServer((req, res) => {
    // 手動模式：把 handler 包成一層固定端口的 server（重用 startMockServer 的 handler 較麻煩，
    // 這裡直接提示用模組 API；e2e 才是主要用途）。
    res.writeHead(501, { 'content-type': 'text/plain' });
    res.end('mock server: 請用 startMockServer() 模組 API（e2e 測試使用 ephemeral port）');
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock server placeholder on http://127.0.0.1:${port}`);
  });
}

