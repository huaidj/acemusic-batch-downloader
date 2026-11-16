#!/usr/bin/env node
// agent/hub.mjs — ACE Agent Hub：常駐本地服務（預設 127.0.0.1:8788）
// 單一寫入者 + 記憶體快照 + job 佇列 + SSE；設計見 agent/HUB.md
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, cachePeek } from './lib/config.mjs';
import * as ACE from './lib/ace.mjs';
import { musicHttp } from './lib/music-http.mjs';
import { MUSIC_CONTRACT } from './lib/music-contract.mjs';
import { directGenerationPermission } from './lib/provider-policy.mjs';
import { createHttp, createApiController } from './lib/create-http.mjs';
import { CREATE_CONTRACT } from './lib/create-tools.mjs';

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
const PAGE_FILES = new Set(['page-songs.json', 'page-unavailable.json', 'page-events.json', 'page-favorites.json']);
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
        if (name === 'page-favorites.json') return; // 只廣播 page 事件；收藏不影響曲庫快照
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
const GENERATION_RECEIPTS_FILE = path.join(cfg.stateDir, 'generation-receipts.json');
const generationReceipts = new Map();
let generationReceiptError = '';

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined && key !== 'created_at').sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function saveGenerationReceipts() {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const temporary = GENERATION_RECEIPTS_FILE + '.' + process.pid + '.tmp';
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ version: 1, receipts: [...generationReceipts.values()] }, null, 2));
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, GENERATION_RECEIPTS_FILE);
}

function persistGenerationJob(job) {
  const receipt = generationReceipts.get(job.meta && job.meta.generationReceiptKey);
  if (!receipt) return;
  receipt.job = publicJob(job);
  saveGenerationReceipts();
}

function restoreGenerationReceipts() {
  if (!fs.existsSync(GENERATION_RECEIPTS_FILE)) return;
  try {
    const stored = JSON.parse(fs.readFileSync(GENERATION_RECEIPTS_FILE, 'utf8'));
    if (stored.version !== 1 || !Array.isArray(stored.receipts)) throw new Error('unsupported receipt format');
    for (const receipt of stored.receipts) {
      if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.key) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !receipt.job || !/^job_[A-Za-z0-9_]+$/.test(receipt.job.id) || receipt.job.kind !== 'generate') throw new Error('invalid receipt');
      const job = { ...receipt.job, request_created_at: receipt.request_created_at, meta: { generationReceiptKey: receipt.key }, progress: receipt.job.progress || null };
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'interrupted';
        job.error_code = 'GENERATION_HUB_INTERRUPTED';
        job.submission_unknown = true;
        job.submission_state = 'unknown';
        job.finishedAt = new Date().toISOString();
        job.error = 'Hub 已重啟，這次生成的送出結果尚未確認；不會自動重送，請依 created_at 與曲庫核對。';
        receipt.job = publicJob(job);
      }
      generationReceipts.set(receipt.key, receipt);
      jobs.set(job.id, job);
      jobOrder.push(job.id);
    }
  } catch {
    // 收據損壞時保留檔案且停用付費生成；讀取與下載仍可使用。
    generationReceiptError = '生成收據無法讀取；為避免重複扣額度，請先修復 generation-receipts.json。';
  }
}

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
    ...(job.kind === 'generate' ? {
      error_code: job.error_code || null,
      submission_unknown: !!job.submission_unknown,
      submission_state: job.submission_state || null,
      request_created_at: job.request_created_at || null,
    } : {}),
    cancelled: !!job.cancelled,
  };
}

function trimJobs() {
  while (jobOrder.length > MAX_JOBS) {
    const id = jobOrder[0];
    const job = jobs.get(id);
    if (!job || ['done', 'failed', 'cancelled', 'interrupted', 'unresolved'].includes(job.status)) {
      jobOrder.shift();
      jobs.delete(id);
    } else {
      break;
    }
  }
}

function addJob(kind, meta = {}) {
  let id;
  do { jobSeq += 1; id = `job_${Date.now().toString(36)}_${jobSeq}`; } while (jobs.has(id));
  const job = { id, kind, status: 'queued', createdAt: new Date().toISOString(), progress: null, meta };
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
      if (job.kind === 'generate') {
        job.submission_state = 'not_submitted';
        job.submission_unknown = false;
        try { persistGenerationJob(job); } catch { job.error = '取消狀態無法寫入收據；保留原收據且不會自動重送。'; }
      }
      broadcast('job', publicJob(job));
      return;
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    broadcast('job', publicJob(job));
    try {
      if (job.kind === 'generate') persistGenerationJob(job);
      job.result = await runner();
      if (job.kind === 'generate') {
        job.submission_state = job.result.submission_state;
        job.submission_unknown = job.result.submission_state === 'unresolved';
      }
      job.status = job.cancelled ? 'cancelled' : job.submission_unknown ? 'unresolved' : 'done';
    } catch (err) {
      job.submission_unknown = job.kind === 'generate' && (!!err.submission_unknown || err.code === 'GENERATION_SUBMISSION_UNKNOWN');
      job.status = job.submission_unknown ? 'unresolved' : 'failed';
      job.error = String((err && err.message) || err);
      if (job.kind === 'generate') {
        job.error_code = err.code || null;
        job.submission_state = job.submission_unknown ? 'unknown' : 'not_submitted';
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      if (job.kind === 'generate') {
        try { persistGenerationJob(job); } catch { job.error = (job.error ? job.error + '；' : '') + '收據更新失敗；保留原收據且不會自動重送。'; }
      }
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
// 選歌與類型一律交給 ACE.selectSongs／normalizeTypes（CLI／MCP 共用同一規則，見 docs/CONVENTIONS.md）
async function selectSongs(body) {
  return ACE.selectSongs(await ACE.listSongs(cfg), body);
}

function downloadOptions(body) {
  return { types: ACE.normalizeTypes(body.types), root: body.root || 'ai音樂', typeFolders: !!body.type_folders, force: !!body.force };
}
async function runDownloadJob(job, body) {
  const songs = await selectSongs(body);
  if (!songs.length) throw new Error('沒有選到歌：請給 song_ids／query／latest，或 all=true');
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

/* ------------------------------------------------------------------ *
 * 對外整合契約（給其他擴充功能／agent，見 docs/CONVENTIONS.md §6）
 * ------------------------------------------------------------------ */
export const API_VERSION = 1; // 破壞性變更才 +1；新增欄位／端點不算
const EXT_ALLOW = new Set(String(process.env.ACE_HUB_EXTENSIONS || '').split(',').map((s) => s.trim()).filter(Boolean));
/**
 * 來源檢查：沒有 Origin（CLI／MCP／native host）放行；擴充功能（chrome-extension:// 等）放行
 * （設了 ACE_HUB_EXTENSIONS 則只放行清單內 ID）；本機頁面（127.0.0.1／localhost）放行；
 * 其他網頁一律拒絕——避免任意網站對 127.0.0.1 發 text/plain POST 觸發下載（CSRF）。
 */
function originAllowed(origin) {
  if (!origin) return true;
  const ext = /^(?:chrome|moz|edge)-extension:\/\/([a-z0-9-]+)$/i.exec(origin);
  if (ext) return EXT_ALLOW.size ? EXT_ALLOW.has(ext[1]) : true;
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin);
}
const ENDPOINTS = [
  { method: 'GET', path: '/health', desc: '版本、pid、apiVersion、counts、jobs' },
  { method: 'GET', path: '/capabilities', desc: '本契約（機器可讀）' },
  { method: 'GET', path: '/overview', desc: '登入＋曲庫統計' },
  { method: 'GET', path: '/songs', query: 'q, undownloaded=1, limit, compact=0', desc: '歌單（記憶體快照）' },
  { method: 'GET', path: '/locate', query: 'latest, q, song, views=1, limit_files', desc: '歌曲 → 本機真實目錄與檔案' },
  { method: 'GET', path: '/library', query: 'sizes=1', desc: '曲庫分類總覽' },
  { method: 'GET', path: '/download-index', query: 'root, full=1', desc: '按歌曲 ID 與實存檔案核對下載狀態' },
  { method: 'POST', path: '/player', desc: '啟動獨立本機播放器（不提交生成）' },
  { method: 'GET', path: '/favorites', desc: '面板的收藏清單（新 → 舊）' },
  { method: 'GET', path: '/prompts/random', query: 'model, mode(idea|custom), seed, lock_a, lock_b, count', desc: '隨機提示詞（依模型＋模式選詞典；不提交生成）' },
  { method: 'GET', path: '/page', desc: '頁面通道健康度' },
  { method: 'GET', path: '/page/events', query: 'since, type, limit', desc: '事件環' },
  { method: 'GET', path: '/wait', query: 'type, task_id, since, timeout', desc: '長輪詢等事件' },
  { method: 'GET', path: '/events', desc: 'SSE：job / progress / snapshot / page / event' },
  { method: 'GET', path: '/jobs', desc: '最近 job' },
  { method: 'GET', path: '/jobs/:id', desc: 'job 詳情' },
  { method: 'POST', path: '/generate', body: 'mode, prompt|style, lyrics, title, style_influence, dry_run=true, confirm_credit_spend, max_credits, idempotency_key', desc: 'v1.1 Preview 生成預覽／單次送出（持久化收據）' },
  { method: 'GET', path: '/generation-status', query: 'task_ids（逗號分隔，最多 10 筆）', desc: '依精確 task_id 唯讀查生成結果' },
  { method: 'POST', path: '/download', body: 'Selector＋types, root, type_folders, force, concurrency, dry_run, idempotency_key', desc: '下載 job' },
  { method: 'POST', path: '/tidy', body: 'root', desc: '一鍵整理 job' },
  { method: 'POST', path: '/dedupe', body: 'kind, commit, include_custom', desc: '去重 job' },
  { method: 'POST', path: '/organize', body: 'commit, root, type_folders', desc: '整理舊檔 job' },
  { method: 'POST', path: '/warm', body: 'refresh, refresh_session', desc: '預熱 job' },
  { method: 'POST', path: '/jobs/:id/cancel', desc: '取消 job' },
  { method: 'POST', path: '/shutdown', desc: '關閉 Hub（僅 loopback）' },
];
const EVENT_TYPES = ['song_new', 'auto_download', 'download_done'];
function capabilities() {
  return {
    ok: true,
    name: 'ace-agent-hub',
    apiVersion: API_VERSION,
    version: VERSION,
    endpoints: [...ENDPOINTS, ...MUSIC_CONTRACT, ...CREATE_CONTRACT].map(({ method, path, description, ...entry }) => ({ ...entry, method, path, ...(description ? { desc: description } : {}) })),
    musicAgent: { mode: 'controlled_workflow', ui: '/music', externalCalls: 'server_authorized_only', realGeneration: 'requires_finite_server_grant', automaticPlayback: false },
    legacyExecutionPolicy: { controlled: cfg.controlledRun, writes: cfg.controlledRun ? 'blocked_outside_granted_adapters' : 'existing_downloader_policy' },
    directGeneration: { adapter: 'site_internal_http', model: 'acemusic-v1.1', enabled: directGenerationPermission(cfg), public_api_contract: false, real_verified: false },
    events: { types: EVENT_TYPES, shape: '{ type, at(ms), seq, source:"page"|"hub", task_id?, task_ids?, title?, ... }' },
    sse: ['job', 'progress', 'snapshot', 'page', 'event', 'music'],
    fileTypes: [...ACE.FILE_TYPES, 'all'],
    selector: '{ song_ids?: string[], query?: string, latest?: number, all?: boolean }（無條件且 all≠true → 不選任何歌）',
    pageFiles: ['page-songs.json', 'page-unavailable.json', 'page-events.json', 'page-favorites.json'],
    auth: { token: !!TOKEN, header: 'X-Hub-Token', extensionAllowlist: EXT_ALLOW.size ? [...EXT_ALLOW] : null },
    generation: { model: 'acemusic-v1.1', defaultDryRun: true, persistentReceipts: true, available: !generationReceiptError },
  };
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
const createApi = createApiController({ cfg, addJob, enqueue });
const handleMusic = musicHttp({ stateDir: path.join(cfg.stateDir, 'music-agent'), cfg, createApi, onEvent: e => broadcast('music', e) });
const handleCreate = createHttp({ controller: createApi });
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin ? String(req.headers.origin) : '';
  if (!originAllowed(origin)) return json(res, 403, { ok: false, error: 'origin not allowed: ' + origin });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Token',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (await handleMusic(req, res, url, { readBody, json })) return;
    if (await handleCreate(req, res, url, { readBody, json })) return;

    if (pathname === '/capabilities' && req.method === 'GET') return json(res, 200, capabilities());

    if (pathname === '/health' && req.method === 'GET') {
      const running = [...jobs.values()].filter((job) => job.status === 'running').length;
      const queued = [...jobs.values()].filter((job) => job.status === 'queued').length;
      return json(res, 200, {
        ok: true,
        version: VERSION,
        apiVersion: API_VERSION,
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
    if (pathname === '/download-index' && req.method === 'GET') {
      return json(res, 200, await ACE.localDownloadIndex(cfg, { root: url.searchParams.get('root') || 'ai音樂', full: url.searchParams.get('full') === '1' }));
    }
    if (pathname === '/player' && req.method === 'POST') return json(res, 200, await ACE.startPlayer(cfg));

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
      const already = url.searchParams.has('since') ? EVENTS.find((e) => e.seq > since && match(e)) : null;
      const event = already || (await waitForEvent(match, timeoutMs));
      return json(res, 200, { ok: true, timedOut: !event, event });
    }

    if (pathname === '/favorites' && req.method === 'GET') {
      return json(res, 200, await ACE.readFavorites(cfg));
    }

    if (pathname === '/prompts/random' && req.method === 'GET') {
      const sp = url.searchParams;
      const result = await ACE.randomPrompt(cfg, {
        model: sp.get('model') || 'acemusic-v1.1',
        mode: sp.get('mode') || 'custom',
        seed: sp.get('seed') || undefined,
        lockA: sp.get('lock_a') || undefined,
        lockB: sp.get('lock_b') || undefined,
        count: Number(sp.get('count') || 1),
      });
      return json(res, result.ok ? 200 : 422, result);
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

    if (pathname === '/generation-status' && req.method === 'GET') {
      const task_ids = String(url.searchParams.get('task_ids') || '').split(',').map((id) => id.trim()).filter(Boolean);
      return json(res, 200, await ACE.generationStatus(cfg, { task_ids }));
    }

    if (pathname === '/generate' && req.method === 'POST') {
      const body = await readBody(req);
      if (body?.dry_run === false && !directGenerationPermission(cfg)) return json(res, 403, { ok: false, status: 'awaiting_authorization', error_code: 'GENERATION_AUTHORIZATION_REQUIRED', error: '真實生成未啟用；請求中的 confirm/max 不能替代批次預算及平台範圍授權。', submission_unknown: false });
      const allowed = new Set(['mode', 'model', 'prompt', 'style', 'lyrics', 'title', 'style_influence', 'dry_run', 'confirm_credit_spend', 'max_credits', 'idempotency_key']);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { ok: false, error: '生成請求包含不支援的欄位。' });
      // 先以純函式比對收據。扣完最後一筆額度或登入失效後仍能查原結果。
      let request;
      try { request = ACE.prepareGenerationRequest(body); }
      catch (err) { return json(res, 400, { ok: false, error: err.message, error_code: err.code || null, submission_unknown: false }); }
      const fingerprint = digest(stableJson(request));
      const key = typeof body.idempotency_key === 'string' ? digest(body.idempotency_key) : '';
      const existing = body.dry_run === false && key ? generationReceipts.get(key) : null;
      if (existing) {
        if (existing.fingerprint !== fingerprint) return json(res, 409, { ok: false, error: '相同 idempotency_key 已用於不同生成內容；請核對原收據。' });
        return json(res, 200, { ok: true, jobId: existing.job.id, idempotent: true, request_created_at: existing.request_created_at, job: existing.job });
      }
      // 預覽只讀；實際送出仍由核心重新核對即時費用及所有授權欄位。
      const preview = await ACE.generateSong(cfg, { ...body, dry_run: true });
      if (body.dry_run !== false) return json(res, 200, preview);
      if (generationReceiptError) return json(res, 503, { ok: false, error: generationReceiptError });
      if (body.confirm_credit_spend !== true || !Number.isFinite(body.max_credits) || body.max_credits < 0 || typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim()) {
        return json(res, 400, { ok: false, error: '實際生成必須明確提供 confirm_credit_spend=true、max_credits 與 idempotency_key。' });
      }
      if (!preview.request || typeof preview.request !== 'object' || !Number.isSafeInteger(preview.request_created_at) || preview.request_created_at <= 0) return json(res, 502, { ok: false, error: '無法準備可追蹤的生成請求；未送出站點請求。' });
      // 多個相同請求可能同時等預覽；回來後再核對一次，才可保留單一收據。
      const concurrent = generationReceipts.get(key);
      if (concurrent) {
        if (concurrent.fingerprint !== fingerprint) return json(res, 409, { ok: false, error: '相同 idempotency_key 已用於不同生成內容；請核對原收據。' });
        return json(res, 200, { ok: true, jobId: concurrent.job.id, idempotent: true, request_created_at: concurrent.request_created_at, job: concurrent.job });
      }
      const job = addJob('generate', { generationReceiptKey: key });
      job.request_created_at = preview.request_created_at;
      const receipt = { key, fingerprint, request_created_at: preview.request_created_at, job: publicJob(job) };
      generationReceipts.set(key, receipt);
      try {
        // 必須先落盤，才允許任何有扣額度風險的網路請求。
        saveGenerationReceipts();
      } catch {
        generationReceipts.delete(key);
        jobs.delete(job.id);
        jobOrder.splice(jobOrder.indexOf(job.id), 1);
        return json(res, 503, { ok: false, error: '生成收據無法寫入，未送出站點請求。' });
      }
      enqueue(job, () => ACE.generateSong(cfg, { ...body, request_created_at: receipt.request_created_at }));
      return json(res, 202, { ok: true, jobId: job.id, request_created_at: receipt.request_created_at, status: 'queued', hint: '用 /jobs/:id 查送出結果；勿以新 key 重送。' });
    }

    if (pathname === '/jobs' && req.method === 'GET') {
      const list = [...jobs.values()].slice(-50).reverse().map(publicJob);
      return json(res, 200, { ok: true, jobs: list });
    }

    const jobMatch = pathname.match(/^\/jobs\/([A-Za-z0-9_]+)(\/cancel)?$/);
    if (jobMatch) {
      const saved = [...generationReceipts.values()].find((receipt) => receipt.job.id === jobMatch[1]);
      const job = jobs.get(jobMatch[1]) || (saved && { ...saved.job, meta: { generationReceiptKey: saved.key } });
      if (!job) return json(res, 404, { ok: false, error: 'job not found' });
      if (jobMatch[2] && req.method === 'POST') {
        if (job.kind === 'generate' && job.status !== 'queued') return json(res, 409, { ok: false, error: '生成已送出或狀態未明；本機取消不能撤回站點任務，請查生成結果。' });
        job.cancelled = true;
        if (job.kind === 'generate') {
          job.submission_state = 'not_submitted';
          persistGenerationJob(job);
        }
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
restoreGenerationReceipts();
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
