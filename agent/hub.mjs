#!/usr/bin/env node
// agent/hub.mjs — ACE Agent Hub：常駐本地服務（預設 127.0.0.1:8788）
// 單一寫入者 + 記憶體快照 + job 佇列 + SSE；設計見 agent/HUB.md
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, cachePeek } from './lib/config.mjs';
import * as ACE from './lib/ace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const cfg = config();
const PORT = Number(process.env.ACE_HUB_PORT || 8788);
const HOST = process.env.ACE_HUB_HOST || '127.0.0.1';
const TOKEN = process.env.ACE_HUB_TOKEN || '';
const SNAPSHOT_TTL = Number(process.env.ACE_HUB_SNAPSHOT_TTL_MS || 60000);
const LOCK_FILE = path.join(cfg.stateDir, 'hub.lock');
const STARTED_AT = new Date().toISOString();
const STARTED_MS = Date.now();
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT, 'manifest.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
})();

/* ------------------------------------------------------------------ *
 * 單一寫入者鎖
 * ------------------------------------------------------------------ */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  try {
    const current = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (current && current.pid && current.pid !== process.pid && pidAlive(current.pid)) {
      console.error(`[hub] 已有 hub 在執行（pid=${current.pid} port=${current.port || '?'}）；同一時間只允許一個寫入者。`);
      process.exit(2);
    }
  } catch { /* no lock */ }
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: PORT, version: VERSION, startedAt: STARTED_AT }, null, 2));
  process.on('exit', () => {
    try {
      const current = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (current && current.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch { /* ignore */ }
  });
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */
const clients = new Set();

function sseSend(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { clients.delete(res); }
}

function broadcast(event, data) {
  for (const res of clients) sseSend(res, event, data);
}

/* ------------------------------------------------------------------ *
 * 快照（記憶體 + stale-while-revalidate）
 * ------------------------------------------------------------------ */
let snapshot = null;
let snapshotAt = 0;
let refreshing = null;

async function refreshSnapshot(rebuild = false) {
  if (refreshing) {
    // 正在重算時又來了頁面更新：這輪結束後再重算一次，避免吃到舊資料
    if (rebuild) refreshing.finally(() => refreshSnapshot(true)).catch(() => {});
    return refreshing;
  }
  refreshing = (async () => {
    try {
      // rebuild：重算快照（不打網路，歌單優先吃頁面快照）；否則可用 60 秒內的磁碟快照
      const next = rebuild ? await ACE.buildLibrarySnapshot(cfg, { refresh: false }) : await ACE.getLibrarySnapshot(cfg, { refresh: false });
      noteSnapshotSongs(next);
      snapshot = next;
      snapshotAt = Date.now();
      broadcast('snapshot', { at: new Date(snapshotAt).toISOString(), counts: next.counts });
      return next;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/* ------------------------------------------------------------------ *
 * 事件環（最近 200 筆）：頁面事件＋Hub 自己從歌單差異推出的 song_new
 * /wait 長輪詢：agent 等「下一首新歌／下一次下載完成」
 * ------------------------------------------------------------------ */
const EVENTS = [];
const waiters = new Set();
let lastPageEventAt = 0;
let knownSongIds = null;
function pushEvent(evt) {
  const event = { ...evt, at: Number(evt.at) || Date.now(), seq: (EVENTS.length ? EVENTS[EVENTS.length - 1].seq : 0) + 1 };
  EVENTS.push(event);
  if (EVENTS.length > 200) EVENTS.splice(0, EVENTS.length - 200);
  broadcast('event', event);
  for (const waiter of [...waiters]) {
    if (waiter.match(event)) {
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  }
}
function noteSnapshotSongs(next) {
  const ids = new Set((next.songs || []).map((s) => s.task_id));
  if (knownSongIds) {
    for (const song of next.songs || []) {
      if (!knownSongIds.has(song.task_id)) pushEvent({ type: 'song_new', source: 'hub', task_id: song.task_id, title: song.title });
    }
  }
  knownSongIds = ids;
}
async function ingestPageEvents() {
  const fresh = await ACE.readPageEvents(cfg, { since: lastPageEventAt });
  for (const evt of fresh) {
    lastPageEventAt = Math.max(lastPageEventAt, Number(evt.at) || 0);
    pushEvent({ ...evt, source: 'page' });
  }
}
function waitForEvent(match, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { match, resolve };
    waiters.add(waiter);
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      resolve(null);
    }, Math.max(100, Math.min(timeoutMs, 30 * 60 * 1000)));
    timer.unref?.();
  });
}

/* 頁面 → agent：面板寫入 page-songs／page-unavailable／page-events 時立即處理並推 SSE（不等 TTL） */
const PAGE_FILES = new Set(['page-songs.json', 'page-unavailable.json', 'page-events.json']);
const pageTimers = new Map();
let pageWatcher = null;
let lastPageEvent = null;
function startPageWatch() {
  try {
    pageWatcher = fs.watch(cfg.stateDir, (_event, filename) => {
      const name = String(filename || '');
      if (!PAGE_FILES.has(name)) return;
      // 每個檔案各自 debounce（事件檔與歌單檔同時寫入時互不吃掉）
      clearTimeout(pageTimers.get(name));
      pageTimers.set(name, setTimeout(() => {
        lastPageEvent = { file: name, at: new Date().toISOString() };
        broadcast('page', lastPageEvent);
        if (name === 'page-events.json') {
          ingestPageEvents().catch(() => {});
          return;
        }
        snapshotAt = 0;
        refreshSnapshot(true).catch(() => {});
      }, name === 'page-events.json' ? 60 : 200));
    });
    pageWatcher.on('error', () => {});
  } catch (err) {
    console.error('[hub] 無法監看頁面快照：', (err && err.message) || err);
  }
}

async function getSnapshot() {
  if (snapshot && Date.now() - snapshotAt < SNAPSHOT_TTL) return snapshot;
  // stale-while-revalidate：有舊快照就立刻回，背景重算（讀取永遠是毫秒級，不等站點）
  if (snapshot) {
    refreshSnapshot().catch(() => {});
    return snapshot;
  }
  try {
    return await refreshSnapshot();
  } catch (err) {
    if (snapshot) return snapshot;
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Jobs（單一寫入佇列 + idempotency）
 * ------------------------------------------------------------------ */
const jobs = new Map();
const jobOrder = [];
const idempotent = new Map();
let jobSeq = 0;
let writeChain = Promise.resolve();
const MAX_JOBS = 200;

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    progress: job.progress || null,
    result: job.result === undefined ? null : job.result,
    error: job.error || '',
    cancelled: !!job.cancelled,
  };
}

function trimJobs() {
  while (jobOrder.length > MAX_JOBS) {
    const id = jobOrder[0];
    const job = jobs.get(id);
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      jobOrder.shift();
      jobs.delete(id);
    } else {
      break;
    }
  }
}

function addJob(kind, meta = {}) {
  jobSeq += 1;
  const job = { id: `job_${Date.now().toString(36)}_${jobSeq}`, kind, status: 'queued', createdAt: new Date().toISOString(), progress: null, meta };
  jobs.set(job.id, job);
  jobOrder.push(job.id);
  trimJobs();
  return job;
}

function enqueue(job, runner) {
  writeChain = writeChain.then(async () => {
    if (job.cancelled) {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      broadcast('job', publicJob(job));
      return;
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    broadcast('job', publicJob(job));
    try {
      job.result = await runner();
      job.status = job.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = String((err && err.message) || err);
    } finally {
      job.finishedAt = new Date().toISOString();
      broadcast('job', publicJob(job));
    }
  });
  return job;
}

function makeProgressReporter(job, intervalMs = 500) {
  let last = 0;
  return (progress) => {
    job.progress = progress && typeof progress === 'object' ? { ...progress } : { value: progress };
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      broadcast('progress', { jobId: job.id, progress: job.progress });
    }
  };
}

/* ------------------------------------------------------------------ *
 * Job runners
 * ------------------------------------------------------------------ */
async function selectSongs(body) {
  let songs = await ACE.listSongs(cfg);
  if (Array.isArray(body.song_ids) && body.song_ids.length) {
    const wanted = new Set(body.song_ids);
    songs = songs.filter((song) => wanted.has(song.task_id));
  }
  if (body.query) {
    const q = String(body.query).toLowerCase();
    songs = songs.filter((song) => {
      const title = String((song.meta && song.meta.title) || '').toLowerCase();
      return title.includes(q) || String(song.task_id).includes(q);
    });
  }
  return songs;
}

function downloadOptions(body) {
  const types = Array.isArray(body.types) && body.types.length ? body.types : ['stems', 'midi', 'cover'];
  return { types, root: body.root || 'ai音樂', typeFolders: !!body.type_folders, force: !!body.force };
}

async function runDownloadJob(job, body) {
  const songs = await selectSongs(body);
  const options = downloadOptions(body);
  if (body.dry_run) {
    const { plan, state } = await ACE.buildPlanForSongs(cfg, songs, options);
    const localSkipped = await ACE.applyLocalSkips(cfg, plan, state);
    return { dryRun: true, songs: songs.length, total: plan.total, toDownload: plan.toDownload, skipped: plan.skipped, localSkipped };
  }
  const report = makeProgressReporter(job);
  const result = await ACE.runDownload({
    songs,
    options,
    concurrency: Number(body.concurrency) || 4,
    cfg,
    isCancelled: () => job.cancelled,
    onProgress: report,
  });
  await refreshSnapshot().catch(() => {});
  return result;
}

/* ------------------------------------------------------------------ *
 * HTTP 工具
 * ------------------------------------------------------------------ */
function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('invalid json: ' + err.message)); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  return String(req.headers['x-hub-token'] || '') === TOKEN;
}

function compactRows(rows) {
  return rows.map((row) => ({
    id: row.task_id,
    title: row.title,
    stems: row.stems ? row.stems.count : 0,
    midi: row.midi_available,
    cover: row.cover,
    dur: row.duration_sec,
    dl: row.downloaded ? row.downloaded.have + '/' + row.downloaded.total : null,
    done: row.downloaded ? row.downloaded.allDone : false,
  }));
}

function filterSongs(rows, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase();
  const undownloaded = url.searchParams.get('undownloaded') === '1';
  let list = rows;
  if (q) list = list.filter((row) => String(row.title).toLowerCase().includes(q) || String(row.task_id).includes(q));
  if (undownloaded) list = list.filter((row) => !(row.downloaded && row.downloaded.allDone));
  const limit = Number(url.searchParams.get('limit') || 0);
  if (limit > 0) list = list.slice(0, limit);
  return list;
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      const running = [...jobs.values()].filter((job) => job.status === 'running').length;
      const queued = [...jobs.values()].filter((job) => job.status === 'queued').length;
      return json(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        port: PORT,
        startedAt: STARTED_AT,
        uptimeMs: Date.now() - STARTED_MS,
        snapshotAt: snapshot ? new Date(snapshotAt).toISOString() : null,
        counts: snapshot ? snapshot.counts : null,
        jobs: { running, queued, total: jobs.size },
      });
    }

    if (pathname === '/overview' && req.method === 'GET') {
      const snap = await getSnapshot();
      const peek = await cachePeek('session-status', { cfg }).catch(() => null);
      const session = peek && peek.data && peek.data.status ? peek.data.status : null;
      return json(res, 200, {
        ok: true,
        version: VERSION,
        builtAt: snap.builtAt,
        cached: !!snap.cached,
        ageMs: snap.ageMs || 0,
        authenticated: session ? !!session.authenticated : null,
        sessionError: session ? String(session.error || '') : '',
        counts: snap.counts,
        hub: { pid: process.pid, port: PORT, uptimeMs: Date.now() - STARTED_MS },
      });
    }

    if (pathname === '/locate' && req.method === 'GET') {
      const sp = url.searchParams;
      const result = await ACE.locateSongs(cfg, {
        songId: sp.get('song') || sp.get('song_id') || '',
        query: sp.get('q') || '',
        latest: Number(sp.get('latest') || 0),
        includeViews: sp.get('views') === '1',
        limitFiles: Number(sp.get('limit_files') || 200),
      });
      return json(res, 200, result);
    }

    if (pathname === '/page' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...(await ACE.pageChannelStatus(cfg)), lastEvent: lastPageEvent });
    }

    if (pathname === '/page/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const type = url.searchParams.get('type') || '';
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
      const rows = EVENTS.filter((e) => e.seq > since && (!type || e.type === type)).slice(-limit);
      return json(res, 200, { ok: true, total: rows.length, lastSeq: EVENTS.length ? EVENTS[EVENTS.length - 1].seq : 0, events: rows });
    }

    // 長輪詢：等下一個符合的事件（type、task_id 可選）；timeout 毫秒，預設 60 秒
    if (pathname === '/wait' && req.method === 'GET') {
      const type = url.searchParams.get('type') || 'song_new';
      const taskId = url.searchParams.get('task_id') || '';
      const since = Number(url.searchParams.get('since') || 0);
      const timeoutMs = Number(url.searchParams.get('timeout') || 60000);
      const match = (e) => e.type === type && (!taskId || e.task_id === taskId || (Array.isArray(e.task_ids) && e.task_ids.includes(taskId)));
      // since 之後已經發生過 → 立即回
      const already = since ? EVENTS.find((e) => e.seq > since && match(e)) : null;
      const event = already || (await waitForEvent(match, timeoutMs));
      return json(res, 200, { ok: true, timedOut: !event, event });
    }

    if (pathname === '/library' && req.method === 'GET') {
      return json(res, 200, await ACE.libraryOverview(cfg, { withSizes: url.searchParams.get('sizes') === '1' }));
    }

    if (pathname === '/songs' && req.method === 'GET') {
      const snap = await getSnapshot();
      const rows = filterSongs(snap.songs, url);
      const compact = url.searchParams.get('compact') !== '0';
      return json(res, 200, { ok: true, total: rows.length, songs: compact ? compactRows(rows) : rows });
    }

    if (pathname === '/jobs' && req.method === 'GET') {
      const list = [...jobs.values()].slice(-50).reverse().map(publicJob);
      return json(res, 200, { ok: true, jobs: list });
    }

    const jobMatch = pathname.match(/^\/jobs\/([A-Za-z0-9_]+)(\/cancel)?$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { ok: false, error: 'job not found' });
      if (jobMatch[2] && req.method === 'POST') {
        job.cancelled = true;
        broadcast('job', publicJob(job));
        return json(res, 200, { ok: true, cancelled: true, job: publicJob(job) });
      }
      if (req.method === 'GET') return json(res, 200, { ok: true, job: publicJob(job) });
      return json(res, 405, { ok: false, error: 'method not allowed' });
    }

    if (pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION, pid: process.pid })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && pathname === '/download') {
      const body = await readBody(req);
      const idem = body.idempotency_key ? String(body.idempotency_key) : '';
      if (idem) {
        const existingId = idempotent.get(idem);
        const existing = existingId ? jobs.get(existingId) : null;
        if (existing) return json(res, 200, { ok: true, jobId: existing.id, idempotent: true });
      }
      const job = addJob('download', { dryRun: !!body.dry_run });
      if (idem) idempotent.set(idem, job.id);
      enqueue(job, () => runDownloadJob(job, body));
      return json(res, 202, { ok: true, jobId: job.id });
    }

    if (req.method === 'POST' && pathname === '/tidy') {
      const body = await readBody(req);
      const job = addJob('tidy');
      enqueue(job, async () => {
        const report = makeProgressReporter(job);
        const result = await ACE.tidyAll({ root: body.root || 'ai音樂', onProgress: report, cfg });
        await refreshSnapshot().catch(() => {});
        return result;
      });
      return json(res, 202, { ok: true, jobId: job.id });
    }

    if (req.method === 'POST' && pathname === '/dedupe') {
      const body = await readBody(req);
      const kind = body.kind === 'folders' ? 'folders' : 'content';
      const job = addJob('dedupe', { kind, commit: !!body.commit });
      enqueue(job, async () => {
        const result = kind === 'folders'
          ? await ACE.dedupeFolders({ root: body.root || 'ai音樂', commit: !!body.commit, includeCustom: !!body.include_custom, cfg })
          : await ACE.dedupeContent({ root: body.root || 'ai音樂', commit: !!body.commit, includeCustom: !!body.include_custom, cfg });
        await refreshSnapshot().catch(() => {});
        return result;
      });
      return json(res, 202, { ok: true, jobId: job.id });
    }

    if (req.method === 'POST' && pathname === '/organize') {
      const body = await readBody(req);
      const job = addJob('organize', { commit: !!body.commit });
      enqueue(job, async () => {
        const result = await ACE.organize({
          dryRun: !body.commit,
          root: body.root || 'ai音樂',
          typeFolders: !!body.type_folders,
          cfg,
        });
        await refreshSnapshot().catch(() => {});
        return result;
      });
      return json(res, 202, { ok: true, jobId: job.id });
    }

    if (req.method === 'POST' && pathname === '/warm') {
      const body = await readBody(req);
      const job = addJob('warm');
      enqueue(job, async () => {
        const result = await ACE.warmCaches(cfg, { refresh: !!body.refresh, refreshSession: !!body.refresh_session });
        await refreshSnapshot().catch(() => {});
        return result;
      });
      return json(res, 202, { ok: true, jobId: job.id });
    }

    if (req.method === 'POST' && pathname === '/shutdown') {
      json(res, 200, { ok: true, stopping: true });
      setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500);
      }, 50);
      return;
    }

    return json(res, 404, { ok: false, error: 'not found: ' + pathname });
  } catch (err) {
    return json(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

/* ------------------------------------------------------------------ *
 * 啟動
 * ------------------------------------------------------------------ */
acquireLock();
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[hub] port ${PORT} 已被占用`);
    process.exit(3);
  }
  console.error('[hub] server error:', err && err.message);
  process.exit(4);
});
server.listen(PORT, HOST, () => {
  console.log(`[hub] ACE Agent Hub v${VERSION} 已啟動：http://${HOST}:${PORT}`);
  console.log(`[hub] 狀態目錄：${cfg.stateDir}`);
  console.log(`[hub] 讀取走記憶體快照；寫入走單一佇列；事件流：GET /events`);
  refreshSnapshot().catch((err) => console.error('[hub] 初次快照失敗：', (err && err.message) || err));
  startPageWatch();
  ingestPageEvents().catch(() => {}); // 載入既有頁面事件當歷史
});

const heartbeat = setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, 15000);
heartbeat.unref?.();

function shutdown(signal) {
  console.log(`[hub] 收到 ${signal}，關閉中…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
