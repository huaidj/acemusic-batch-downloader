// ace.mjs — ACE Music API 客戶端 + 批次下載 + 檔案整理（給 CLI / MCP / Skill 共用）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config, readJson, writeJson, exists, toWin, sleep, appendLog, cacheRead, cacheWrite, cacheClear, cachePeek } from './config.mjs';
import { loadShared } from './shared.mjs';
import { inspectAudioFile, stripWavMetadata, validateAudioBuffer } from './audio-library.mjs';
import { hasLibraryWriteLease, withLibraryWriteLease } from './library-lease.mjs';
import { invalidateLocalIndex } from './local-index-service.mjs';
import { sameFileContent, moveFileSafely, recordRelocations } from './file-ops.mjs';
export { localDownloadIndex } from './local-index-service.mjs';
export { startPlayer } from './player-process.mjs';
import { assertDirectGenerationPermission } from './provider-policy.mjs';
import * as SiteLikes from './site-likes.mjs';

const { N, P, PR } = loadShared();
const SNAPSHOT_NAME = 'library-snapshot';
function clearFsCaches(cfg) { cacheClear('fs-index', cfg); cacheClear(SNAPSHOT_NAME, cfg); invalidateLocalIndex(cfg); }
const STEM_LABELS = Object.values(N.STEM_TYPE_NAMES).map((s) => s.toLowerCase());
const FILE_TYPES = ['stems', 'midi', 'musicxml', 'mp3', 'wav', 'cover'];

/* ------------------------------------------------------------------ *
 * Session / HTTP
 * ------------------------------------------------------------------ */
export async function loadSession(cfg = config()) {
    const data = await readJson(cfg.sessionFile);
    if (!data || !data.cookie) {
        const err = new Error(
            `找不到登入狀態：${cfg.sessionFile}\n` +
            '請到瀏覽器打開 acemusic.ai 的 Create 頁面 → 右下角「批量下載」面板 → 按「同步登入狀態給 Agent」。',
        );
        err.code = 'NO_SESSION';
        throw err;
    }
    return data;
}

export async function sessionStatus(cfg = config(), { force = false, ttlMs = Number(process.env.ACE_SESSION_TTL_MS || 120000) } = {}) {
    const cacheKey = 'session-status';
    const sessionMtimeMs = (() => {
        try { return fs.statSync(cfg.sessionFile).mtimeMs; } catch { return 0; }
    })();
    if (!force) {
        const cached = await cacheRead(cacheKey, { cfg }).catch(() => null);
        const age = cached ? Date.now() - Number(cached.cachedAt || 0) : Infinity;
        const ttl = cached && cached.ttlMs != null ? Number(cached.ttlMs) : ttlMs;
        // 重新匯出登入狀態（session.json 變動）要立即失效，不能等 TTL
        if (cached && cached.status && age < ttl && Number(cached.sessionMtimeMs || 0) === sessionMtimeMs) return cached.status;
    }
    const status = { sessionFile: cfg.sessionFile, hasSession: exists(cfg.sessionFile), exportedAt: null, authenticated: false, error: '' };
    try {
        const session = await loadSession(cfg);
        status.exportedAt = session.savedAt ? new Date(session.savedAt).toISOString() : null;
        const res = await aceFetch(cfg, session, '/api/songs?limit=1&sort=new');
        status.authenticated = res.ok;
        status.httpStatus = res.status;
        if (!res.ok) status.error = '伺服器回應 HTTP ' + res.status + '（登入可能已過期，請重新按「同步登入狀態給 Agent」）';
    } catch (err) {
        status.error = err.message;
    }
    // 失敗（尤其 401）只快取很短，讓使用者重新匯出後能立刻生效
    const cacheTtl = status.authenticated ? ttlMs : Math.min(ttlMs, 15000);
    await cacheWrite(cacheKey, { status, ttlMs: cacheTtl, sessionMtimeMs }, cfg).catch(() => {});
    return status;
}

export function absolutize(cfg, url) {
    const s = String(url || '');
    if (/^https?:/i.test(s)) return s;
    if (s.startsWith('//')) return 'https:' + s;
    if (s.startsWith('/')) return cfg.baseUrl + s;
    return cfg.baseUrl + '/' + s;
}

async function aceFetch(cfg, session, url, options = {}) {
    if (cfg.controlledRun && !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())) {
        throw Object.assign(new Error('受控中樞未批准舊轉譜或其他可能扣額度的站點寫入；保留下載預覽，請另行核對費用與授權。'), { code: 'LEGACY_PAID_OPERATION_NOT_AUTHORIZED' });
    }
    let target = new URL(absolutize(cfg, url));
    const origin = new URL(cfg.baseUrl).origin;
    let method = String(options.method || 'GET').toUpperCase();
    let body = options.body;
    const signal = options.signal || AbortSignal.timeout(180000);
    for (let redirect = 0; redirect <= 5; redirect++) {
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('不支援的站點檔案來源');
        const headers = new Headers({ 'User-Agent': session.ua || cfg.ua, Accept: '*/*', Referer: cfg.baseUrl + '/create/', ...options.headers });
        if (target.origin === origin && session.cookie) headers.set('Cookie', session.cookie);
        else { headers.delete('Cookie'); headers.delete('Authorization'); headers.delete('Proxy-Authorization'); }
        const response = await fetch(target, { ...options, method, body, signal, headers, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirect === 5) throw new Error('站點檔案轉址過多，已停止');
        const next = new URL(location, target);
        if (!['GET', 'HEAD'].includes(method) && next.origin !== origin) throw Object.assign(new Error('站點寫入請求轉址到其他來源，提交狀態待核對'), { code: 'SUBMISSION_UNKNOWN' });
        if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = undefined; }
        target = next;
    }
}

/* ------------------------------------------------------------------ *
 * Direct v1.1 generation. Cookie stays in the local session store.
 * Charged submissions are serialized and durably deduplicated by Hub.
 * ------------------------------------------------------------------ */
const GENERATION_MODEL = 'acemusic-v1.1';
const GENERATION_FIELDS = new Set(['mode', 'model', 'prompt', 'style', 'lyrics', 'title', 'style_influence', 'dry_run', 'confirm_credit_spend', 'max_credits', 'idempotency_key', 'request_created_at']);
const GENERATION_LIMITS = { prompt: 2000, style: 1000, lyrics: 5000, title: 80 };

function generationError(code, message, extra = {}) {
    return Object.assign(new Error(message), { code, ...extra });
}

function generationBase(cfg) {
    let base;
    try { base = new URL(cfg.baseUrl); } catch { throw generationError('GENERATION_BASE_URL', '生成服務網址無效。'); }
    const local = base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if ((!local && base.origin !== 'https://acemusic.ai') || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw generationError('GENERATION_BASE_URL', '生成僅支援 https://acemusic.ai；測試可使用本機回環網址。');
    }
    return base.origin;
}

function generationText(value, name, limit) {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw generationError('GENERATION_INPUT', `${name} 必須是文字。`);
    const text = value.trim();
    if ([...text].length > limit) throw generationError('GENERATION_INPUT', `${name} 超過 ${limit} 字元，請縮短後再試。`);
    return text;
}

function normalizeGeneration(opts) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw generationError('GENERATION_INPUT', '生成參數必須是物件。');
    const unknown = Object.keys(opts).filter((key) => !GENERATION_FIELDS.has(key));
    if (unknown.length) throw generationError('GENERATION_INPUT', '含有不支援的生成參數；目前僅支援 v1.1 的文字與歌詞生成。');
    if (opts.model !== undefined && opts.model !== GENERATION_MODEL) throw generationError('GENERATION_MODEL', '此工具僅支援 ACE Music v1.1 Preview。');
    for (const key of ['dry_run', 'confirm_credit_spend']) {
        if (opts[key] !== undefined && typeof opts[key] !== 'boolean') throw generationError('GENERATION_INPUT', `${key} 必須是布林值。`);
    }
    const prompt = generationText(opts.prompt, 'prompt', GENERATION_LIMITS.prompt);
    const style = generationText(opts.style, 'style', GENERATION_LIMITS.style);
    const lyrics = generationText(opts.lyrics, 'lyrics', GENERATION_LIMITS.lyrics);
    const title = generationText(opts.title, 'title', GENERATION_LIMITS.title);
    const mode = opts.mode === undefined ? (prompt ? 'idea' : 'custom') : opts.mode;
    if (!['idea', 'custom'].includes(mode)) throw generationError('GENERATION_INPUT', 'mode 必須是 idea 或 custom。');
    if (mode === 'idea' && (!prompt || style || lyrics || title || opts.style_influence !== undefined)) {
        throw generationError('GENERATION_INPUT', 'Idea 請只填 prompt；Style、Lyrics 與 Title 請使用 Custom。');
    }
    if (mode === 'custom' && (prompt || !style)) throw generationError('GENERATION_INPUT', 'Custom 必須填寫 style，並將 prompt 留空。');
    if (opts.style_influence !== undefined && (typeof opts.style_influence !== 'number' || !Number.isFinite(opts.style_influence) || opts.style_influence < 0 || opts.style_influence > 100)) {
        throw generationError('GENERATION_INPUT', 'style_influence 必須介於 0 至 100。');
    }
    if (opts.max_credits !== undefined && (typeof opts.max_credits !== 'number' || !Number.isFinite(opts.max_credits) || opts.max_credits < 0)) {
        throw generationError('GENERATION_INPUT', 'max_credits 必須是非負數。');
    }
    if (opts.idempotency_key !== undefined && (typeof opts.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(opts.idempotency_key))) {
        throw generationError('GENERATION_INPUT', 'idempotency_key 請使用 1 至 128 個英數字、點、底線、冒號或連字號。');
    }
    if (opts.request_created_at !== undefined && (!Number.isSafeInteger(opts.request_created_at) || opts.request_created_at <= 0)) {
        throw generationError('GENERATION_INPUT', 'request_created_at 必須是有效的毫秒時間戳。');
    }
    const dryRun = opts.dry_run !== false;
    if (!dryRun && (opts.confirm_credit_spend !== true || opts.max_credits === undefined || !opts.idempotency_key)) {
        throw generationError('GENERATION_CREDIT_CONFIRMATION', '實際生成需 confirm_credit_spend=true、明確的 max_credits 與 idempotency_key；預覽不扣額度。');
    }
    const body = mode === 'idea'
        ? { prompt, references: [], model: GENERATION_MODEL, media: [] }
        : { mode: 'cover', model: GENERATION_MODEL, references: [], style, lyrics, lyricsMode: 'own', style_influence: opts.style_influence ?? 80, ...(title ? { title } : {}) };
    return { mode, dryRun, body, endpoint: mode === 'idea' ? '/api/idea' : '/api/custom', requestCreatedAt: opts.request_created_at };
}

/** Pure canonical request for Hub receipt lookup, including when session is offline. */
export function prepareGenerationRequest(opts = {}) {
    const normalized = normalizeGeneration(opts);
    return { endpoint: normalized.endpoint, body: normalized.body };
}

async function generationFetch(cfg, session, route, options = {}) {
    const base = generationBase(cfg);
    try {
        return await fetch(base + route, {
            ...options,
            headers: {
                'User-Agent': session.ua || cfg.ua,
                Accept: 'application/json',
                Origin: base,
                Referer: base + '/create/',
                Cookie: session.cookie,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            },
            redirect: 'error',
            signal: AbortSignal.timeout(45000),
        });
    } catch {
        const submitting = options.method === 'POST';
        throw generationError(
            submitting ? 'GENERATION_SUBMISSION_UNKNOWN' : 'GENERATION_NETWORK',
            submitting ? '生成請求已送出但未取得明確回應；請用原 idempotency_key 查詢，勿重新提交。' : '無法讀取 ACE Music，請稍後檢查連線與登入狀態。',
            { submission_unknown: submitting },
        );
    }
}

async function generationJson(response, { submitting = false } = {}) {
    if (!response.ok) {
        const status = response.status;
        const uncertain = submitting && (status === 408 || status >= 500);
        const code = status === 401 ? 'GENERATION_AUTH' : status === 402 ? 'GENERATION_CREDITS' : status === 429 ? 'GENERATION_RATE_LIMIT' : uncertain ? 'GENERATION_SUBMISSION_UNKNOWN' : 'GENERATION_HTTP';
        throw generationError(code, uncertain ? `生成請求回應 HTTP ${status}，站點是否已建立任務尚未確認；請核對原請求，勿重新提交。` : status === 401 ? '登入已過期，請在 ACE Music 面板重新同步登入狀態。' : `ACE Music 回應 HTTP ${status}；請檢查登入、方案與額度後再處理。`, { http_status: status, submission_unknown: uncertain });
    }
    let data;
    try { data = await response.json(); } catch {
        throw generationError(submitting ? 'GENERATION_SUBMISSION_UNKNOWN' : 'GENERATION_RESPONSE', submitting ? '生成回應格式無法辨識；請查詢原請求，勿重新提交。' : 'ACE Music 回應格式無法辨識。', { submission_unknown: submitting });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false || data.error) {
        throw generationError(submitting ? 'GENERATION_SUBMISSION_UNKNOWN' : 'GENERATION_RESPONSE', submitting ? '生成回應未確認成功；請查詢原請求，勿重新提交。' : 'ACE Music 未回傳有效資料。', { submission_unknown: submitting });
    }
    return data;
}

function safeGenerationUrl(value, cfg) {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        const base = generationBase(cfg);
        const url = new URL(value, base);
        if (url.origin !== base || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/data/')) return undefined;
        return url.pathname;
    } catch { return undefined; }
}

function generationSong(song, cfg) {
    if (!song || typeof song !== 'object' || typeof song.task_id !== 'string') return null;
    const out = { task_id: song.task_id };
    for (const key of ['status', 'model', 'capability']) if (typeof song[key] === 'string') out[key] = song[key];
    if (typeof song.created_at === 'number' && Number.isFinite(song.created_at)) out.created_at = song.created_at;
    if (typeof song.meta?.title === 'string') out.title = song.meta.title;
    if (typeof song.result?.duration_sec === 'number' && Number.isFinite(song.result.duration_sec)) out.duration_sec = song.result.duration_sec;
    for (const key of ['local_audio', 'local_play', 'local_cover']) {
        const value = safeGenerationUrl(song[key], cfg);
        if (value) out[key] = value;
    }
    return out;
}

function generationModelInfo(taskIds, songs) {
    const actualModels = [...new Set(songs.map((song) => song.model).filter((model) => typeof model === 'string' && model.length > 0))];
    const modelsById = new Map();
    for (const song of songs) {
        if (typeof song.model !== 'string' || !song.model) continue;
        const models = modelsById.get(song.task_id) || new Set();
        models.add(song.model);
        modelsById.set(song.task_id, models);
    }
    const mismatch = taskIds.filter((id) => [...(modelsById.get(id) || [])].some((model) => model !== GENERATION_MODEL));
    const unknown = taskIds.filter((id) => !modelsById.has(id));
    return {
        requested_model: GENERATION_MODEL,
        model: actualModels.length === 1 && unknown.length === 0 ? actualModels[0] : null,
        actual_models: actualModels,
        model_mismatch_task_ids: mismatch,
        model_unknown_task_ids: unknown,
        model_verified: taskIds.length > 0 && mismatch.length === 0 && unknown.length === 0,
    };
}

/** Preview reads live cost/model/limits; actual submission is exactly one POST. */
export async function generateSong(cfg = config(), opts = {}) {
    const normalized = normalizeGeneration(opts);
    assertDirectGenerationPermission(cfg, opts);
    generationBase(cfg);
    const session = await loadSession(cfg);
    const status = await generationJson(await generationFetch(cfg, session, '/api/status'));
    const model = Array.isArray(status.models) && status.models.find((entry) => (typeof entry === 'string' ? entry : entry?.id) === GENERATION_MODEL);
    if (!model) throw generationError('GENERATION_MODEL_UNAVAILABLE', '目前帳戶未提供 ACE Music v1.1 Preview，已停止生成。');
    const cost = status.costs?.song;
    const credits = status.user?.credits;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw generationError('GENERATION_COST_UNKNOWN', '無法確認本次生成費用，已停止生成。');
    if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) throw generationError('GENERATION_BALANCE_UNKNOWN', '無法確認可用 Credits，已停止生成。');
    if (credits < cost) throw generationError('GENERATION_INSUFFICIENT_CREDITS', `本次需要 ${cost} Credits，可用 ${credits} Credits，已停止生成。`);
    if (!normalized.dryRun && opts.max_credits < cost) throw generationError('GENERATION_CREDIT_LIMIT', `本次需要 ${cost} Credits，超過 max_credits=${opts.max_credits}，已停止生成。`);
    for (const field of ['prompt', 'style', 'lyrics']) {
        const liveLimit = model.limits?.[field];
        if (Number.isInteger(liveLimit) && liveLimit > 0 && normalized.body[field] !== undefined) generationText(normalized.body[field], field, Math.min(liveLimit, GENERATION_LIMITS[field]));
    }
    const preview = {
        ok: true,
        dry_run: normalized.dryRun,
        model: GENERATION_MODEL,
        requested_model: GENERATION_MODEL,
        mode: normalized.mode,
        estimated_credits: cost,
        credits_before: credits,
        ...(typeof status.user?.plan === 'string' ? { plan: status.user.plan } : {}),
        request_created_at: normalized.requestCreatedAt ?? Date.now(),
        request: { endpoint: normalized.endpoint, body: normalized.body },
    };
    if (normalized.dryRun) return preview;
    const body = { ...normalized.body, created_at: preview.request_created_at };
    const data = await generationJson(await generationFetch(cfg, session, normalized.endpoint, { method: 'POST', body: JSON.stringify(body) }), { submitting: true });
    const songs = [data.song, ...(Array.isArray(data.songs) ? data.songs : []), ...(Array.isArray(data.items) ? data.items : [])].map((song) => generationSong(song, cfg)).filter(Boolean);
    const ids = [data.task_id, ...(Array.isArray(data.task_ids) ? data.task_ids : []), ...songs.map((song) => song.task_id)].filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id));
    const taskIds = [...new Set(ids)];
    const modelInfo = generationModelInfo(taskIds, songs);
    return {
        ok: true, dry_run: false, ...modelInfo, mode: normalized.mode,
        estimated_credits: cost, credits_before: credits, created_at: preview.request_created_at,
        task_ids: taskIds, songs,
        submission_state: taskIds.length ? 'accepted' : 'unresolved',
        ...(taskIds.length ? {} : { message: '請求已獲回應但未提供可辨識的任務 ID；請查閱歌庫及原請求，勿重送。' }),
        ...(modelInfo.model_mismatch_task_ids.length ? { model_warning: '伺服器回傳的模型與要求的 v1.1 不同；已保留任務 ID，請查詢原任務，勿重送。' } : {}),
    };
}

/** Read only the exact requested IDs; never starts transcription or downloads. */
export async function generationStatus(cfg = config(), opts = {}) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).some((key) => key !== 'task_ids')) throw generationError('GENERATION_INPUT', '狀態查詢僅接受 task_ids。');
    const ids = opts.task_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) {
        throw generationError('GENERATION_INPUT', 'task_ids 必須包含 1 至 10 個有效任務 ID。');
    }
    const taskIds = [...new Set(ids)];
    generationBase(cfg);
    const session = await loadSession(cfg);
    const data = await generationJson(await generationFetch(cfg, session, '/api/songs?ids=' + encodeURIComponent(taskIds.join(','))));
    if (!Array.isArray(data.items)) throw generationError('GENERATION_RESPONSE', 'ACE Music 未提供歌曲狀態清單。');
    const wanted = new Set(taskIds);
    const songs = data.items.filter((song) => wanted.has(song?.task_id)).map((song) => generationSong(song, cfg)).filter(Boolean);
    const found = new Set(songs.map((song) => song.task_id));
    const statusesById = new Map();
    for (const song of songs) {
        if (typeof song.status !== 'string') continue;
        const statuses = statusesById.get(song.task_id) || new Set();
        statuses.add(song.status);
        statusesById.set(song.task_id, statuses);
    }
    // Contradictory duplicate rows cannot establish a terminal result.
    const conflicting = taskIds.filter((id) => (statusesById.get(id)?.size || 0) > 1);
    const conflictingSet = new Set(conflicting);
    const coherentSongs = songs.filter((song) => !conflictingSet.has(song.task_id));
    const failed = [...new Set(coherentSongs.filter((song) => ['failed', 'interrupted', 'cancelled', 'canceled'].includes(song.status)).map((song) => song.task_id))];
    const succeeded = [...new Set(coherentSongs.filter((song) => song.status === 'succeeded' && !!song.local_audio).map((song) => song.task_id))];
    const terminal = new Set([...failed, ...succeeded]);
    const modelInfo = generationModelInfo(taskIds, songs);
    return {
        ok: true, ...modelInfo, task_ids: taskIds, songs,
        missing_task_ids: taskIds.filter((id) => !found.has(id)),
        conflicting_task_ids: conflicting,
        succeeded_task_ids: succeeded, failed_task_ids: failed,
        pending_task_ids: taskIds.filter((id) => !terminal.has(id)),
        complete: taskIds.every((id) => terminal.has(id)), failed: failed.length > 0,
        audio_complete: taskIds.every((id) => succeeded.includes(id)),
        v11_complete: modelInfo.model_verified && taskIds.every((id) => succeeded.includes(id)),
    };
}

/* ------------------------------------------------------------------ *
 * 歌單 / MIDI / 音檔 URL
 * ------------------------------------------------------------------ */
/** 面板（頁面）交給 agent 的歌單快照：%LOCALAPPDATA%\AceMusicDL\page-songs.json */
export async function readPageSongs(cfg = config()) {
    const raw = await readJson(path.join(cfg.stateDir, 'page-songs.json'), null);
    if (!raw || !Array.isArray(raw.songs)) return null;
    const songs = raw.songs.filter((song) => song && song.task_id && P.isDone(song));
    if (!songs.length) return null;
    return { savedAt: Number(raw.savedAt) || 0, songs };
}

/** 面板的收藏清單（page-favorites.json）：新 → 舊；附上歌名與（若歌單裡有）本機狀態 */
export async function readFavorites(cfg = config()) {
    const raw = await readJson(path.join(cfg.stateDir, 'page-favorites.json'), null);
    const list = raw && Array.isArray(raw.favorites) ? raw.favorites : [];
    return { ok: true, savedAt: raw && raw.savedAt ? new Date(raw.savedAt).toISOString() : null, total: list.length, favorites: list.map((f) => ({ task_id: f.task_id, title: f.title || '', at: f.at || 0 })) };
}

/** 面板送來的頁面事件（song_new／auto_download／download_done），由舊到新 */
export async function readPageEvents(cfg = config(), { since = 0 } = {}) {
    const raw = await readJson(path.join(cfg.stateDir, 'page-events.json'), null);
    const events = raw && Array.isArray(raw.events) ? raw.events : [];
    return events.filter((evt) => evt && Number(evt.at) > Number(since || 0));
}

/**
 * 曲庫分類總覽：ai音樂 下每個分類（成品MP3／成品WAV／採樣包各樂器／MIDI…）的檔案數；
 * withSizes=true 另算大小（需 stat，較慢）。音頻分類是 hardlink 檢視，只列檔數、不重複算大小。
 */
export async function libraryOverview(cfg = config(), { withSizes = false } = {}) {
    const index = await collectDownloadIndex(cfg);
    const root = path.join(cfg.downloadDir, 'ai音樂');
    const rootLower = root.toLowerCase() + path.sep;
    const groups = new Map();
    let songFolders = 0;
    for (const full of index.files || []) {
        if (!full.toLowerCase().startsWith(rootLower)) continue;
        const parts = full.slice(rootLower.length).split(/[\\/]/);
        if (parts.length < 2) continue;
        const top = parts[0];
        const sub = (top === '採樣包' || top === '採樣包WAV') && parts.length > 2 ? parts[1] : '';
        const key = sub ? `${top}/${sub}` : top;
        const entry = groups.get(key) || { category: top, sub: sub || null, dir: path.join(root, ...(sub ? [top, sub] : [top])), files: 0, bytes: withSizes ? 0 : undefined };
        entry.files += 1;
        if (withSizes && top !== '音頻分類') {
            try {
                entry.bytes += fs.statSync(full).size;
            } catch {
                /* ignore */
            }
        }
        groups.set(key, entry);
    }
    const KNOWN = ['成品MP3', '成品WAV', '採樣包', '採樣包WAV', 'MIDI', 'MusicXML', '封面', '壓縮檔', '其他', '音頻分類', '俱樂部版'];
    const categories = [...groups.values()];
    for (const cat of categories) if (!KNOWN.includes(cat.category)) songFolders += 1;
    categories.sort((a, b) => {
        const ia = KNOWN.indexOf(a.category);
        const ib = KNOWN.indexOf(b.category);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.sub || '').localeCompare(String(b.sub || ''));
    });
    return {
        ok: true,
        root,
        indexedAt: index.at ? new Date(index.at).toISOString() : null,
        note: '音頻分類 是 hardlink 檢視（同一份資料），索引深度 3 層，深層檔案未全數列入',
        categories: categories.filter((c) => KNOWN.includes(c.category)),
        otherFolders: categories.filter((c) => !KNOWN.includes(c.category)).map((c) => ({ name: c.category, dir: c.dir, files: c.files })),
        otherFolderCount: songFolders,
    };
}

/* ------------------------------------------------------------------ *
 * 備份保留（organize-backups）：預設只預覽；commit 才刪
 * ------------------------------------------------------------------ */
function dirStats(dir) {
    let files = 0;
    let bytes = 0;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(cur, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else {
                files += 1;
                try {
                    bytes += fs.statSync(full).size;
                } catch {
                    /* ignore */
                }
            }
        }
    }
    return { files, bytes };
}

/**
 * 列出備份並計算「依規則會刪哪些」。規則：保留最近 keepLast 個（預設 1）；其餘超過 keepDays 天
 * 或總量超過 maxBytes（由舊到新刪）才列為可刪。commit=true 才真的刪（移除整個備份資料夾）。
 */
export async function pruneBackups(cfg = config(), { keepDays = 7, keepLast = 1, maxBytes = 0, commit = false, now = Date.now() } = {}) {
    const root = path.join(cfg.stateDir, 'organize-backups');
    let names = [];
    try {
        names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return { ok: true, root, exists: false, backups: [], prune: [], keep: [], bytesTotal: 0, bytesReclaimable: 0, committed: false };
    }
    const backups = names
        .map((name) => {
            const dir = path.join(root, name);
            const mtimeMs = fs.statSync(dir).mtimeMs;
            return { name, dir, mtime: new Date(mtimeMs).toISOString(), mtimeMs, ageDays: Math.round(((now - mtimeMs) / 86400000) * 10) / 10, ...dirStats(dir) };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs); // 新 → 舊
    const keep = new Set(backups.slice(0, Math.max(0, keepLast)).map((b) => b.name));
    const prune = new Set();
    for (const b of backups) {
        if (!keep.has(b.name) && keepDays >= 0 && b.ageDays > keepDays) prune.add(b.name);
    }
    if (maxBytes > 0) {
        let total = backups.filter((b) => !prune.has(b.name)).reduce((s, b) => s + b.bytes, 0);
        for (const b of [...backups].reverse()) {
            if (total <= maxBytes) break;
            if (keep.has(b.name) || prune.has(b.name)) continue;
            prune.add(b.name);
            total -= b.bytes;
        }
    }
    const pruneList = backups.filter((b) => prune.has(b.name));
    const removed = [];
    const failed = [];
    if (commit) {
        for (const b of pruneList) {
            try {
                fs.rmSync(b.dir, { recursive: true, force: true });
                removed.push(b.name);
            } catch (err) {
                failed.push({ name: b.name, error: String((err && err.message) || err) });
            }
        }
        await appendLog(`prune-backups removed=${removed.join(',') || '-'} failed=${failed.length}`, cfg);
    }
    const strip = ({ mtimeMs, ...rest }) => rest;
    return {
        ok: failed.length === 0,
        root,
        exists: true,
        rules: { keepDays, keepLast, maxBytes },
        backups: backups.map(strip),
        prune: pruneList.map(strip),
        keep: backups.filter((b) => !prune.has(b.name)).map((b) => b.name),
        bytesTotal: backups.reduce((s, b) => s + b.bytes, 0),
        bytesReclaimable: pruneList.reduce((s, b) => s + b.bytes, 0),
        committed: !!commit,
        removed,
        failed,
    };
}

/* ------------------------------------------------------------------ *
 * 母帶清單（唯讀）：俱樂部版／舊版對照的音檔格式；不刪任何檔
 * ------------------------------------------------------------------ */
export function readWavInfo(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(4096);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        if (n < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
        let off = 12;
        let fmt = null;
        let dataBytes = 0;
        while (off + 8 <= n) {
            const id = head.toString('ascii', off, off + 4);
            const size = head.readUInt32LE(off + 4);
            if (id === 'fmt ' && off + 24 <= n) {
                fmt = {
                    format: head.readUInt16LE(off + 8),
                    channels: head.readUInt16LE(off + 10),
                    sampleRate: head.readUInt32LE(off + 12),
                    byteRate: head.readUInt32LE(off + 16),
                    bitsPerSample: head.readUInt16LE(off + 22),
                };
            } else if (id === 'data') {
                dataBytes = size;
                break;
            }
            off += 8 + size + (size % 2);
        }
        if (!fmt) return null;
        const durationSec = fmt.byteRate ? Math.round((dataBytes / fmt.byteRate) * 10) / 10 : null;
        return { ...fmt, durationSec, codec: fmt.format === 3 ? 'float' : fmt.format === 1 ? 'pcm' : 'fmt' + fmt.format };
    } catch {
        return null;
    } finally {
        if (fd != null) fs.closeSync(fd);
    }
}

export async function listMasters(cfg = config(), { folders = ['俱樂部版', '舊版對照'] } = {}) {
    const root = path.join(cfg.downloadDir, 'ai音樂');
    const out = [];
    for (const folder of folders) {
        const dir = path.join(root, folder);
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (!['.wav', '.mp3', '.flac', '.aif', '.aiff', '.m4a'].includes(ext)) continue;
            const full = path.join(dir, entry.name);
            const size = fs.statSync(full).size;
            const base = path.basename(entry.name, ext);
            // 「歌名_HD_48k24」→ song=歌名、version=HD_48k24（第一個版本標記之後全算版本）
            const m = /^(.*?)_((?:ClubHD|Club|HD|Master|Ext|Radio)(?:_.*)?)$/i.exec(base);
            out.push({
                folder,
                file: full,
                name: entry.name,
                song: m ? m[1] : base,
                version: m ? m[2] : null,
                ext: ext.slice(1),
                bytes: size,
                wav: ext === '.wav' ? readWavInfo(full) : undefined,
            });
        }
    }
    const bySong = {};
    for (const item of out) (bySong[item.song] = bySong[item.song] || []).push(item.name);
    return { ok: true, root, total: out.length, note: '唯讀清單；不同版本（HD／Club…）不是重複，是否刪除由使用者決定', masters: out, bySong };
}

/** 站點健康（唯讀）：/api/status 的方案／模型；不回傳個資 */
export async function probeSite(cfg = config()) {
    const started = Date.now();
    const out = { ok: false, baseUrl: cfg.baseUrl, checkedAt: new Date().toISOString() };
    let session = null;
    try {
        session = await loadSession(cfg);
    } catch (err) {
        out.session = { ok: false, error: String(err.code || err.message) };
    }
    try {
        const res = await aceFetch(cfg, session || {}, '/api/status', { headers: { Accept: 'application/json' } });
        out.status = { http: res.status };
        const data = await res.json().catch(() => null);
        if (data && typeof data === 'object') {
            const user = data.user || null;
            out.status.loggedIn = !!user;
            if (user) out.status.plan = user.plan || null;
            if (Array.isArray(data.models)) out.status.models = data.models.map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean);
            out.status.upload = !!data.upload;
            out.status.cover = !!data.cover;
        }
        out.ok = res.ok;
    } catch (err) {
        out.status = { error: String((err && err.message) || err) };
    }
    if (session) out.session = { ok: !!(out.status && out.status.loggedIn), exportedAt: session.savedAt ? new Date(session.savedAt).toISOString() : null };
    out.elapsedMs = Date.now() - started;
    return out;
}

/** 頁面通道健康度：快照時間、筆數、是否新鮮、不可用紀錄數 */
export async function pageChannelStatus(cfg = config(), { freshMs = 10 * 60 * 1000 } = {}) {
    const [page, na] = await Promise.all([
        readPageSongs(cfg),
        readJson(path.join(cfg.stateDir, 'page-unavailable.json'), null),
    ]);
    const ageMs = page ? Date.now() - page.savedAt : null;
    let unavailableCount = 0;
    for (const kinds of Object.values((na && na.unavailable) || {})) unavailableCount += Object.keys(kinds || {}).length;
    return {
        songs: page ? page.songs.length : 0,
        savedAt: page ? new Date(page.savedAt).toISOString() : null,
        ageMs,
        fresh: page ? ageMs < freshMs : false,
        unavailable: unavailableCount,
    };
}

/* ------------------------------------------------------------------ *
 * 網站原生點讚（唯讀）。不走 listSongs 的快照回落：點讚必須來自完整的即時分頁。
 * ------------------------------------------------------------------ */
export async function syncSiteLikesFromSite(cfg = config(), { pageLimit = 50, maxPages = 200 } = {}) {
    let session;
    try {
        session = await loadSession(cfg);
    } catch (err) {
        return SiteLikes.syncSiteLikes(cfg, async () => { throw Object.assign(new Error(err.message), { code: 'NO_SESSION' }); }, { maxPages });
    }
    const fetchPage = async (after) => {
        const params = new URLSearchParams({ limit: String(pageLimit), sort: 'new' });
        if (after) params.set('after', after);
        const res = await aceFetch(cfg, session, '/api/songs?' + params.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
        const data = res.status === 200 ? await res.json().catch(() => null) : (await res.body?.cancel(), null);
        return { status: res.status, data };
    };
    return SiteLikes.syncSiteLikes(cfg, fetchPage, { maxPages });
}

export async function siteLikes(cfg = config()) {
    return SiteLikes.siteLikesView(await SiteLikes.readSiteLikes(cfg));
}

function withKnown(songs, known) {
    const map = new Map();
    for (const song of known || []) if (song && song.task_id) map.set(song.task_id, song);
    for (const song of songs) map.set(song.task_id, song);
    return [...map.values()];
}

export async function listSongs(cfg = config(), { pageLimit = 50, maxPages = 40, refresh = false, includeKnown = false } = {}) {
    const SONGS_TTL_MS = 10 * 60 * 1000;
    const cached = await cacheRead('songs', { maxAgeMs: SONGS_TTL_MS, cfg });
    // 頁面快照比 API 快取新（且本身仍新鮮）→ 直接用，免網路、免 session
    const page = refresh ? null : await readPageSongs(cfg);
    const pageFresh = page && Date.now() - page.savedAt < SONGS_TTL_MS && page.savedAt > Number((cached && cached.cachedAt) || 0);
    if (pageFresh) {
        if (!includeKnown) return page.songs;
        const old = cached || (await cacheRead('songs', { cfg }));
        return withKnown(page.songs, old && old.known);
    }
    if (!refresh && cached && Array.isArray(cached.songs) && cached.songs.length) {
        return includeKnown && Array.isArray(cached.known) ? cached.known : cached.songs;
    }
    // 連不到站點（沒 session／登入過期／離線）：唯讀查詢沿用「頁面快照／舊快取」中較新的一份；下載仍會因 session 失效而中止
    const fallback = async (reason, err) => {
        if (process.env.ACE_NO_STALE_SONGS) throw err;
        const old = cached || (await cacheRead('songs', { cfg }));
        const pageSnap = page || (await readPageSongs(cfg));
        const oldAt = Number((old && old.cachedAt) || 0);
        if (pageSnap && pageSnap.savedAt >= oldAt) {
            process.stderr.write(`[ace] ${reason}，暫用頁面歌單快照（${pageSnap.songs.length} 首）\n`);
            return includeKnown ? withKnown(pageSnap.songs, old && old.known) : pageSnap.songs;
        }
        if (old && Array.isArray(old.songs) && old.songs.length) {
            process.stderr.write(`[ace] ${reason}，暫用快取歌單（${old.songs.length} 首）\n`);
            return includeKnown && Array.isArray(old.known) ? old.known : old.songs;
        }
        throw err;
    };
    let session;
    try {
        session = await loadSession(cfg);
    } catch (err) {
        return fallback('沒有登入狀態', err);
    }
    const songs = [];
    let after = '';
    for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
        const params = new URLSearchParams({ limit: String(pageLimit), sort: 'new' });
        if (after) params.set('after', after);
        let res;
        try {
            res = await aceFetch(cfg, session, '/api/songs?' + params.toString(), {
                headers: { Accept: 'application/json' },
            });
        } catch (err) {
            return fallback('站點連線失敗', err);
        }
        if (res.status === 401 || res.status === 403) {
            const err = new Error('登入已過期（HTTP ' + res.status + '），請回擴充功能面板按「同步登入狀態給 Agent」重新匯出。');
            err.code = 'AUTH_EXPIRED';
            return fallback('登入已過期（請回面板按「同步 Agent」）', err);
        }
        if (!res.ok) throw new Error('歌單讀取失敗 HTTP ' + res.status);
        const data = await res.json().catch(() => null);
        const items = data && Array.isArray(data.items) ? data.items : [];
        songs.push(...items);
        after = (data && data.next) || '';
        if (!after || !items.length) break;
    }
    const fresh = songs.filter((song) => song && song.task_id && P.isDone(song));
    // 快取合併：保留之前抓過但這次已不在清單裡的歌（全量回溯用）
    const oldKnown = new Map();
    const prevCache = cached || (await cacheRead('songs', { cfg }));
    for (const song of (prevCache && Array.isArray(prevCache.known) ? prevCache.known : [])) {
        if (song && song.task_id) oldKnown.set(song.task_id, song);
    }
    for (const song of fresh) oldKnown.set(song.task_id, song);
    const known = [...oldKnown.values()];
    await cacheWrite('songs', { songs: fresh, known, fetchedAt: new Date().toISOString() }, cfg);
    return includeKnown ? known : fresh;
}

export function summarizeSong(song, index, unavailable = {}) {
    const group = P.pickStemGroup(song.stems);
    const summary = {
        task_id: song.task_id,
        title: (song.meta && song.meta.title) || 'Untitled',
        capability: song.capability || '',
        duration_sec: (song.result && (song.result.duration_sec || song.result.duration)) || null,
        stems: group ? { mode: group.mode, count: group.tracks.length, types: group.tracks.map((t) => t.type) } : null,
        midi_available: P.notationRequested(song),
        wav_available: P.supportsWav(song),
        cover: !!song.local_cover,
        local_audio: !!song.local_audio,
    };
    if (index) summary.downloaded = songDownloadSummary(song, index, unavailable);
    return summary;
}

const escRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 站點 error 可能是物件 { code, message }；取 message 避免 [object Object] */
function siteErrorDetail(data, status) {
    const error = data && (data.error || data.message);
    if (!error) return 'HTTP ' + status;
    if (typeof error === 'string') return error;
    return error.message || error.code || JSON.stringify(error);
}

/** 掃描下載資料夾，回傳 { rel:Set<相對路徑小寫>, names:Set<檔名小寫> } */
export async function collectDownloadIndex(cfg = config(), { refresh = false } = {}) {
    const ttlMs = Number(process.env.ACE_FS_INDEX_TTL_MS || 180000);
    if (!refresh) {
        const cached = await cacheRead('fs-index', { maxAgeMs: ttlMs, cfg });
        if (cached && Array.isArray(cached.files)) {
            return {
                rel: new Set(cached.rel || []),
                names: new Set(cached.names || []),
                files: cached.files,
                at: Number(cached.cachedAt) || Date.now(),
            };
        }
    }
    // 上限必須高於 Downloads 實際檔數，否則索引被截斷 → 誤判「未下載」→ 重複下載／重複資料夾
    const files = walkFiles(cfg.downloadDir, 3, [], 200000);
    const rel = new Set();
    const names = new Set();
    for (const full of files) {
        const relPath = path.relative(cfg.downloadDir, full).split(path.sep).join('/').toLowerCase();
        rel.add(relPath);
        names.add(path.basename(full).toLowerCase());
    }
    await cacheWrite('fs-index', { files, rel: [...rel], names: [...names] }, cfg);
    return { rel, names, files, at: Date.now() };
}

/* ------------------------------------------------------------------ *
 * locate：歌曲 → 本機真實目錄（給 agent 直接拿路徑用）
 * ------------------------------------------------------------------ */
const VIEW_DIR_RE = /[\\/]音頻分類[\\/]/;


function classifyLocatedFile(base) {
    const m = /^(.*?)(?: - (.+))?\.([a-z0-9]+)$/i.exec(base);
    const suffix = m && m[2] ? m[2].trim() : '';
    const ext = m ? m[3].toLowerCase() : '';
    if (/^cover$/i.test(suffix)) return 'cover';
    if (/^midi$/i.test(suffix) || ext === 'mid' || ext === 'midi') return 'midi';
    if (/^musicxml$/i.test(suffix) || ext === 'musicxml') return 'musicxml';
    if (suffix) return 'stem:' + suffix;
    if (ext === 'mp3') return 'mp3';
    if (ext === 'wav') return 'wav';
    return 'other';
}

/** 純函式：在檔案清單中找出某首歌的檔案（folder 為這首歌指派到的資料夾名，可含 take 編號） */
export function matchSongFiles(song, files, { folder = '', includeViews = false, takenFolders = null } = {}) {
    const rawTitle = (song.meta && song.meta.title) || '';
    const title = N.songFolderLabel(rawTitle);
    const exact = folder ? [folder] : [...new Set([title, N.sanitizeComponent(rawTitle, 120)].filter(Boolean))];
    // 有資料夾指派：名稱必須精確等於該 take（"X (2)" 不會吃到 "X"）；沒有才放寬到任一 take
    const takeRe = folder ? '' : '(?: \\(\\d+\\))?';
    const reges = exact.map((name) => new RegExp('^' + escRe(name) + takeRe + '(?: - .+)?\\.[a-z0-9]+$', 'i'));
    const out = [];
    for (const full of files || []) {
        if (!includeViews && VIEW_DIR_RE.test(full)) continue;
        const base = path.basename(full);
        if (!reges.some((re) => re.test(base))) continue;
        // 放寬比對時，排除已指派給其他 take 的名稱（避免同名歌互相吃檔）
        if (!folder && takenFolders) {
            const prefix = base.replace(/\.[^.]+$/, '').split(' - ')[0].trim().toLowerCase();
            if (takenFolders.has(prefix)) continue;
        }
        out.push({ path: full, kind: classifyLocatedFile(base) });
    }
    return out;
}

/**
 * 找歌曲的真實目錄。
 * @param {{songId?:string, query?:string, latest?:number, includeViews?:boolean, limitFiles?:number}} opts
 */
/* ------------------------------------------------------------------ *
 * 選歌器（Selector）— CLI／MCP／Hub 共用的唯一實作（見 docs/CONVENTIONS.md §3）
 *   { song_ids?: string[], query?: string, latest?: number, all?: boolean }
 *   - 條件可疊加：先 song_ids、再 query，最後依建立時間取最新 latest 首
 *   - 沒有任何條件且 all !== true → 空（避免誤下載全部）
 * 新增選歌條件只改這裡＋normalizeSelector，三個入口自動支援。
 * ------------------------------------------------------------------ */
export function songCreatedMs(song) {
    const n = Number(song && (song.created_at || song.finished_at));
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(song && (song.created_at || song.finished_at));
    return Number.isFinite(parsed) ? parsed : 0;
}

/** 把各入口的參數（snake_case／camelCase／CLI 字串）正規化成 Selector */
export function normalizeSelector(input = {}) {
    const ids = input.song_ids || input.songIds || input.song || input.songId || [];
    const songIds = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
    const latest = Number(input.latest === true ? 1 : input.latest) || 0;
    const query = input.query != null && input.query !== true ? String(input.query).trim() : input.q ? String(input.q).trim() : '';
    return { songIds, query, latest: latest > 0 ? Math.floor(latest) : 0, all: input.all === true || input.all === 'true' || input.all === '1' };
}

export function selectSongs(songs, input = {}) {
    const sel = normalizeSelector(input);
    const hasCriteria = sel.songIds.length || sel.query || sel.latest;
    if (!hasCriteria && !sel.all) return [];
    let picked = [...(songs || [])];
    if (sel.songIds.length) {
        const want = new Set(sel.songIds);
        picked = picked.filter((song) => want.has(song.task_id));
    }
    if (sel.query) {
        const q = sel.query.toLowerCase();
        picked = picked.filter((song) => String((song.meta && song.meta.title) || '').toLowerCase().includes(q) || String(song.task_id).includes(q));
    }
    if (sel.latest) picked = picked.sort((a, b) => songCreatedMs(b) - songCreatedMs(a)).slice(0, sel.latest);
    return picked;
}

/** 檔案類型：'all' 展開成全部（FILE_TYPES 為唯一清單）；未知類型丟錯，避免靜默忽略 */
export const DEFAULT_DOWNLOAD_TYPES = Object.freeze(['stems', 'midi', 'musicxml', 'mp3', 'wav', 'cover']);
export function normalizeTypes(types, fallback = DEFAULT_DOWNLOAD_TYPES) {
    const list = (Array.isArray(types) ? types : types ? String(types).split(',') : []).map((t) => String(t).trim()).filter(Boolean);
    if (!list.length) return [...fallback];
    if (list.includes('all')) return [...FILE_TYPES];
    const unknown = list.filter((t) => !FILE_TYPES.includes(t));
    if (unknown.length) throw new Error('未知的檔案類型：' + unknown.join(',') + '（可用：' + FILE_TYPES.join(',') + ',all）');
    return [...new Set(list)];
}

/* locate 的輸入（4 MB 歌單快取＋檔案索引）依檔案 mtime 記憶，Hub 熱路徑不必每次重新解析 JSON。
   只給 locate 用（唯讀、不改內容）；最多沿用 30 秒，避免跨過 listSongs 的新鮮度判斷。 */
const locateMemo = { key: '', at: 0, songs: null, index: null };
function fileSig(file) {
    try {
        const st = fs.statSync(file);
        return st.mtimeMs + ':' + st.size;
    } catch {
        return '-';
    }
}
async function locateInputs(cfg) {
    const sig = () =>
        [cfg.stateDir, cfg.downloadDir, fileSig(path.join(cfg.stateDir, 'cache', 'songs.json')), fileSig(path.join(cfg.stateDir, 'page-songs.json')), fileSig(path.join(cfg.stateDir, 'cache', 'fs-index.json'))].join('|');
    const key = sig();
    if (locateMemo.key === key && Date.now() - locateMemo.at < 30000) return locateMemo;
    const [songs, index] = await Promise.all([listSongs(cfg), collectDownloadIndex(cfg)]);
    // 載入時可能剛寫回快取：用載入後的簽名當 key
    Object.assign(locateMemo, { key: sig(), at: Date.now(), songs, index });
    return locateMemo;
}

export async function locateSongs(cfg = config(), { songId = '', query = '', latest = 0, includeViews = false, limitFiles = 200 } = {}) {
    const [{ songs, index }, state] = await Promise.all([locateInputs(cfg), loadState(cfg)]);
    // 共用選歌器；locate 的預設：沒條件 → 最新 1 首；只有 query → 最新 20 首內的符合者
    const defLatest = Number(latest) > 0 ? Number(latest) : songId ? 0 : query ? 20 : 1;
    const picked = selectSongs(songs, { song_ids: songId ? [songId] : [], query, latest: defLatest }).sort((a, b) => songCreatedMs(b) - songCreatedMs(a));
    const root = path.join(cfg.downloadDir, 'ai音樂');
    const files = index.files || [];
    const results = picked.map((song) => {
        const folder = (state.folderByTask && state.folderByTask[song.task_id]) || '';
        const takenFolders = new Set();
        for (const [taskId, name] of Object.entries(state.folderByTask || {})) {
            if (taskId !== song.task_id && name) takenFolders.add(String(name).toLowerCase());
        }
        const matched = matchSongFiles(song, files, { folder, includeViews, takenFolders });
        const dirs = new Map();
        for (const file of matched) {
            const dir = path.dirname(file.path);
            const entry = dirs.get(dir) || { dir, count: 0, kinds: new Set() };
            entry.count += 1;
            entry.kinds.add(file.kind.startsWith('stem:') ? 'stems' : file.kind);
            dirs.set(dir, entry);
        }
        // 沒指派資料夾：用實際檔名最常見的前綴（例如 "X (2)"）
        let inferred = '';
        if (!folder && matched.length) {
            const counts = new Map();
            for (const file of matched) {
                const prefix = path.basename(file.path).replace(/\.[^.]+$/, '').split(' - ')[0].trim();
                counts.set(prefix, (counts.get(prefix) || 0) + 1);
            }
            inferred = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        const folderName = folder || inferred || N.songFolderLabel((song.meta && song.meta.title) || '');
        const songDir = path.join(root, folderName);
        const time = songCreatedMs(song);
        return {
            task_id: song.task_id,
            title: (song.meta && song.meta.title) || 'Untitled',
            created_at: time ? new Date(time).toISOString() : null,
            folder: folderName,
            songDir: exists(songDir) ? songDir : null,
            dirs: [...dirs.values()]
                .map((d) => ({ dir: d.dir, count: d.count, kinds: [...d.kinds].sort() }))
                .sort((a, b) => (a.dir === songDir ? -1 : b.dir === songDir ? 1 : b.count - a.count)),
            files: matched.slice(0, limitFiles),
            fileCount: matched.length,
        };
    });
    return { ok: true, root, total: results.length, songs: results };
}

/** 檔名索引快取（同一個 names Set 只建一次） */
const nameIndexCache = new WeakMap();
function nameIndexOf(names) {
    let idx = nameIndexCache.get(names);
    if (!idx) {
        idx = P.buildNameIndex(names);
        nameIndexCache.set(names, idx);
    }
    return idx;
}

/** 每首歌已下載進度（依檔名比對，含 CLI/擴充功能/站點下載的檔案） */
export function songDownloadSummary(song, index, unavailable = {}) {
    const rawTitle = (song.meta && song.meta.title) || '';
    const title = N.songFolderLabel(rawTitle);
    // 檔名可能用完整標題（songFolderLabel 遇到 '[' 會截斷），兩種都比對
    const titleCandidates = [...new Set([title, N.sanitizeComponent(rawTitle, 120)].filter(Boolean))];
    const group = P.pickStemGroup(song.stems);
    const labels = new Map();
    if (group) {
        for (const track of group.tracks) labels.set(N.stemLabel(track.type).toLowerCase(), N.stemLabel(track.type));
    }
    const stems = new Set();
    let midi = false;
    let musicxml = false;
    let mp3 = false;
    let wav = false;
    let cover = false;
    if (index && index.names) {
        for (const { suffix, ext } of P.lookupNames(nameIndexOf(index.names), titleCandidates)) {
            if (suffix === 'cover') cover = true;
            else if (suffix === 'midi') midi = true;
            else if (suffix === 'musicxml') musicxml = true;
            else if (!suffix) {
                if (ext === 'mp3') mp3 = true;
                else if (ext === 'wav') wav = true;
                else if (ext === 'mid' || ext === 'midi') midi = true;
                else if (ext === 'musicxml') musicxml = true;
            } else if (labels.has(suffix)) stems.add(labels.get(suffix));
        }
    }
    const stemsTotal = group ? group.tracks.length : 0;
    const stemsHave = stemsTotal ? Math.min(stemsTotal, stems.size) : 0;
    const detail = [];
    if (stemsTotal) detail.push({ type: 'stems', label: '分軌', have: stemsHave, total: stemsTotal, done: stemsHave >= stemsTotal });
    const na = (kind) => P.isUnavailable(unavailable, song.task_id, kind);
    if (P.notationRequested(song)) detail.push(P.statusItem('midi', 'MIDI', midi, na('midi')));
    if (P.notationRequested(song)) detail.push(P.statusItem('musicxml', 'MusicXML', musicxml, na('musicxml')));
    if (P.supportsWav(song)) detail.push(P.statusItem('wav', 'WAV', wav, false));
    if (song.local_cover) detail.push({ type: 'cover', label: '封面', have: cover ? 1 : 0, total: 1, done: cover });
    const have = detail.reduce((sum, item) => sum + item.have, 0);
    const total = detail.reduce((sum, item) => sum + item.total, 0);
    const unavailableKinds = detail.filter((item) => item.na).map((item) => item.type);
    const allDone = detail.every((item) => item.done);
    return { have, total, allDone, any: have > 0, mp3, wav, detail, unavailable: unavailableKinds };
}

async function createApiFile(cfg, session, songId, kind) {
    const endpoint = `/api/songs/${encodeURIComponent(songId)}/download`;
    const deadline = Date.now() + 180000;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await appendLog(JSON.stringify({ event: 'notation_submit', taskId: songId, kind, attempt: attempt + 1 }), cfg);
        let res = await aceFetch(cfg, session, endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ kind }),
        });
        while (res.status === 202) {
            if (Date.now() > deadline) throw new Error(kind + ' 生成逾時');
            await sleep(1500);
            res = await aceFetch(cfg, session, `${endpoint}?kind=${encodeURIComponent(kind)}`, {
                headers: { Accept: 'application/json' },
            });
        }
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.url) return absolutize(cfg, data.url);
        const detail = siteErrorDetail(data, res.status);
        const code = data && data.error && data.error.code;
        if (res.status === 401 || /log ?in|login/i.test(detail)) throw new Error('登入已過期，請重新整理頁面並按「同步 Agent」');
        if (res.status === 404 && code === 'no_download') {
            const err = new Error('站點不提供此檔案（no_download）');
            err.code = 'NOT_AVAILABLE';
            throw err;
        }
        if (res.status === 429 || code === 'rate_limited' || /too often|too many/i.test(detail)) {
            if (attempt < 1) {
                await sleep(60000);
                continue;
            }
            const err = new Error('站點限流（429）：' + detail);
            err.code = 'RATE_LIMIT';
            throw err;
        }
        if (res.status === 402) throw new Error('目前方案不含 ' + kind + ' 下載（HTTP 402）：' + detail);
        throw new Error('無法取得 ' + kind + '：' + detail);
    }
    throw new Error('站點限流，請稍後再試');
}

async function resolveFileUrl(cfg, session, songId, kind) {
    const direct = `/api/songs/${encodeURIComponent(songId)}/file?kind=${encodeURIComponent(kind)}`;
    let res;
    try {
        res = await aceFetch(cfg, session, `${direct}&as=parts`, { headers: { Accept: 'application/json' } });
    } catch {
        return direct;
    }
    if (!res.ok) {
        if (res.status === 402) throw new Error('目前方案不含 ' + kind + ' 下載（HTTP 402）');
        if (res.status === 401) throw new Error('登入已過期，請重新整理頁面再試');
        if (kind === 'wav' && (res.status === 404 || res.status === 400)) { const err = new Error('站點暫時找不到 WAV（HTTP ' + res.status + '），保留待補'); err.code = 'FILE_NOT_READY'; throw err; }
        return direct;
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return direct;
    if (data.server) return direct;
    if (typeof data.audio === 'string' && data.audio) return absolutize(cfg, data.audio);
    if (typeof data.url === 'string' && data.url) return absolutize(cfg, data.url);
    return direct;
}

/* ------------------------------------------------------------------ *
 * 下載
 * ------------------------------------------------------------------ */
async function downloadToFile(cfg, session, url, relPath) {
    const target = path.join(cfg.downloadDir, toWin(relPath));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const res = await aceFetch(cfg, session, url, { headers: { Accept: '*/*' } });
    if (!res.ok) throw new Error('檔案下載 HTTP ' + res.status);
    const contentType = String(res.headers.get('content-type') || '');
    if (/json|html/i.test(contentType)) {
        await res.body?.cancel();
        throw new Error('伺服器回傳非檔案內容（' + contentType + '）');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('檔案為空');
    const extension = path.extname(relPath).slice(1).toLowerCase();
    if (extension === 'wav' || extension === 'mp3') validateAudioBuffer(buffer, extension);
    // WAV downloads from ACE can carry LIST/INFO (IART/ICMT/ISFT) with the generator
    // name, creation time and account id. Strip it before the file ever lands in the library.
    const payload = extension === 'wav' ? stripWavMetadata(buffer) : buffer;
    const tmp = target + '.' + process.pid + '.' + crypto.randomUUID() + '.part';
    await fsp.writeFile(tmp, payload, { flag: 'wx' });
    // A fresh source/version must not overwrite an older take or a user edit.
    // The verified file operation chooses a distinct final name on collision.
    const moved = await moveFileSafely(cfg, tmp, target, { conflict: 'unique', reason: 'download-file' });
    return { target: moved.to, bytes: payload.length };
}

export async function loadState(cfg = config()) {
    const [raw, pageNa] = await Promise.all([
        readJson(cfg.stateFile, {}),
        readJson(path.join(cfg.stateDir, 'page-unavailable.json'), null),
    ]);
    return {
        folderByTask: raw.folderByTask || {},
        ownerByFolder: raw.ownerByFolder || {},
        history: raw.history || {},
        aliases: raw.aliases || {},
        removedPaths: raw.removedPaths || {},
        // 面板記到的「站點不提供」（page-unavailable.json）合併進來，兩邊共用
        unavailable: P.mergeUnavailable(raw.unavailable || {}, (pageNa && pageNa.unavailable) || {}),
    };
}

async function saveState(cfg, buildPlanResult, state) {
    const current = await readJson(cfg.stateFile, {});
    const history = { ...(current.history || {}) };
    for (const [id, incoming] of Object.entries(state.history || {})) {
        const previous = history[id] || {};
        const files = { ...(previous.files || {}) };
        for (const [key, file] of Object.entries(incoming.files || {})) {
            if (!files[key] || Number(file.at || 0) > Number(files[key].at || 0)) files[key] = file;
        }
        history[id] = { ...incoming, ...previous, files };
    }
    await writeJson(cfg.stateFile, {
        ...current,
        folderByTask: { ...(buildPlanResult ? buildPlanResult.folderByTask : state.folderByTask), ...(current.folderByTask || {}) },
        ownerByFolder: { ...(buildPlanResult ? buildPlanResult.ownerByFolder : state.ownerByFolder), ...(current.ownerByFolder || {}) },
        history,
        aliases: { ...(state.aliases || {}), ...(current.aliases || {}) },
        removedPaths: { ...(state.removedPaths || {}), ...(current.removedPaths || {}) },
        unavailable: P.mergeUnavailable(current.unavailable || {}, state.unavailable || {}),
    });
}

/**
 * 站點模型的 lossy 集合（/api/status 的 models[].lossy）：lossy 模型（ACE-Step 的 m4a）沒有 WAV。
 * 快取 6 小時；讀不到（沒登入／離線）回 null → planner 用後備規則（ace-step* 視為 lossy）。
 */
export async function getSiteModels(cfg = config()) {
    const cached = await cacheRead('site-models', { maxAgeMs: 6 * 3600 * 1000, cfg }).catch(() => null);
    if (cached && Array.isArray(cached.models)) return new Map(cached.models.map((m) => [m.id, m]));
    try {
        const session = await loadSession(cfg);
        const res = await aceFetch(cfg, session, '/api/status', { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        const raw = data && Array.isArray(data.models) ? data.models : [];
        if (!raw.length) return null;
        // 只留模型資訊（id、名稱、字數上限、旗標）；不存方案／額度／個資
        const models = raw.filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.name, limits: m.limits, reads: !!m.reads, free: !!m.free, lossy: !!m.lossy, hidden: !!m.hidden }));
        await cacheWrite('site-models', { lossy: models.filter((m) => m.lossy).map((m) => m.id), models }, cfg).catch(() => {});
        return new Map(models.map((m) => [m.id, m]));
    } catch {
        return null;
    }
}

export async function getLossyModels(cfg = config()) {
    const models = await getSiteModels(cfg);
    return models ? new Set([...models.values()].filter((m) => m.lossy).map((m) => m.id)) : null;
}

/**
 * 隨機提示詞（與面板共用 src/prompts.js）：依「模型＋模式」選詞典與欄位上限。
 * 只回傳文字與追溯資訊；agent 不會也不會填進頁面、不會提交生成。
 */
export async function randomPrompt(cfg = config(), { model = 'acemusic-v1.1', mode = 'custom', seed, lockA, lockB, count = 1 } = {}) {
    const siteModels = await getSiteModels(cfg);
    const base = { modelId: model, mode, siteModels };
    const opts = { ...base, seed: seed != null && seed !== '' ? Number(seed) : undefined, lockA: lockA || undefined, lockB: lockB || undefined };
    const n = Math.max(1, Math.min(24, Number(count) || 1));
    const results = n > 1 ? PR.randomBatch(opts, n) : [PR.randomPrompt(opts)];
    const clean = results.map((r) => ({ ...r, context: undefined }));
    return { ok: clean.every((r) => r.ok), model, mode, limitsFrom: siteModels ? 'site' : 'fallback', count: clean.length, prompts: clean };
}
export async function buildPlanForSongs(cfg = config(), songs, options = {}) {
    const { buildLocalDownloadIndex } = await import('./local-index.mjs');
    const { compactLocalIndex } = await import('./local-index-service.mjs');
    const state = await loadState(cfg);
    const types = options.types || DEFAULT_DOWNLOAD_TYPES;
    const lossyModels = P.normalizeOptions({ types }).types.has('wav') ? await getLossyModels(cfg) : null;
    const plan = P.buildDownloadPlan({
        songs,
        options: { types, root: options.root || 'ai音樂', typeFolders: !!options.typeFolders, force: !!options.force, origin: cfg.baseUrl, lossyModels },
        // A persisted path alone is not completion evidence. The exact index below is authoritative.
        state: { ...state, history: {} }, origin: cfg.baseUrl,
    });
    const page = await readJson(path.join(cfg.stateDir, 'page-songs.json'), {});
    const cached = await readJson(path.join(cfg.stateDir, 'cache', 'songs.json'), {});
    const pool = new Map([...(cached.known || []), ...(cached.songs || []), ...(page.songs || []), ...(songs || [])].filter((song) => song && song.task_id).map((song) => [song.task_id, song]));
    const exact = await buildLocalDownloadIndex({ cfg, root: plan.options.root, songs: [...pool.values()] });
    Object.defineProperty(plan, '_exactLocalIndex', { value: compactLocalIndex(exact), configurable: true });
    await applyLocalSkips(cfg, plan, state);
    return { plan, state };
}


/** 以本機檔案／去重紀錄／alias 套用跳過（給 runDownload 與 dry-run 共用） */
export async function applyLocalSkips(cfg = config(), plan, state = {}) {
    if (plan.options?.force) return 0;
    let exact = plan._exactLocalIndex;
    if (!exact) {
        const { buildLocalDownloadIndex } = await import('./local-index.mjs');
        const { compactLocalIndex } = await import('./local-index-service.mjs');
        const page = await readJson(path.join(cfg.stateDir, 'page-songs.json'), {});
        const cached = await readJson(path.join(cfg.stateDir, 'cache', 'songs.json'), {});
        const pool = new Map([...(cached.known || []), ...(cached.songs || []), ...(page.songs || [])].filter((song) => song && song.task_id).map((song) => [song.task_id, song]));
        for (const task of plan.tasks || []) {
            if (pool.has(task.task_id)) continue;
            const tracks = (task.files || []).filter((file) => file.kind === 'stems' && String(file.key || '').startsWith('stem:') && file.sourceUrl)
                .map((file) => ({ id: file.key.slice(5), type: file.stemType || file.label, local_audio: file.sourceUrl }));
            pool.set(task.task_id, { task_id: task.task_id, status: 'succeeded', capability: task.capability || 'music_generate', model: task.model || null,
                local_audio: (task.files || []).find((file) => file.kind === 'mp3' && file.sourceUrl)?.sourceUrl || '/data/' + task.task_id + '.mp3',
                meta: { title: task.title || '' }, stems: task.stems || (task.stemsMode && tracks.length ? { [task.stemsMode]: { status: 'done', tracks } } : {}) });
        }
        exact = compactLocalIndex(await buildLocalDownloadIndex({ cfg, root: plan.options?.root || 'ai音樂', songs: [...pool.values()] }));
        Object.defineProperty(plan, '_exactLocalIndex', { value: exact, configurable: true });
    }
    let skipped = 0;
    for (const task of plan.tasks || []) {
        const completed = new Set(exact.byTask[task.task_id]?.completedKeys || []);
        for (const file of task.files || []) {
            if (file.skip) continue;
            const key = file.key || (file.kind !== 'stems' ? file.kind : null);
            if (!key || !completed.has(key)) continue;
            file.skip = true;
            skipped++;
        }
    }
    if (skipped) {
        plan.skipped = (Number(plan.skipped) || 0) + skipped;
        plan.toDownload = Math.max(0, Number(plan.toDownload) - skipped);
    }
    return skipped;
}


export async function runDownload({ songs, options = {}, concurrency = 4, onProgress = null, isCancelled = null, cfg = config() }) {
    if (!hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => runDownload(...arguments), { isCancelled });
    const notifyProgress = (value) => { try { onProgress?.(value); } catch { /* Display failures do not undo completed file writes. */ } };
    const session = await loadSession(cfg);
    const { plan, state } = await buildPlanForSongs(cfg, songs, options);
    const runId = crypto.randomUUID();
    const log = (event, fields = {}) => appendLog(JSON.stringify({ event, runId, ...fields }), cfg);
    await log('download_start', { songs: songs.length, total: plan.total, types: plan.options.types, force: !!options.force });
    await saveState(cfg, plan, state);

    // 以實際檔案存在／去重紀錄／alias 再跳過一次（之前由擴充功能/CLI/站點下載過的檔案）
    if (!options.force) {
        await applyLocalSkips(cfg, plan, state);
    }

    if (!plan.toDownload) {
        await log('download_done', { done: 0, skipped: plan.skipped, failed: 0, stateSaved: true });
        return { ok: true, message: '沒有需要下載的檔案（可加 force=true 或勾「強制重下」）', total: plan.total, done: 0, skipped: plan.skipped, failed: 0, failedList: [] };
    }

    const entries = [];
    for (const task of plan.tasks) {
        for (const file of task.files) {
            if (!file.skip) entries.push({ task, file, prepDone: file.source === 'url', prepError: null, url: '' });
        }
    }
    entries.sort((a, b) => (a.file.source === 'url' ? 0 : 1) - (b.file.source === 'url' ? 0 : 1));

    const prepEntries = entries.filter((e) => e.file.source !== 'url');
    let prepCursor = 0;
    const prepLimit = Math.min(3, Math.max(1, prepEntries.length));
    const prepProgress = { active: 0 };
    const startedAt = Date.now();

    const cancelled = () => !!(isCancelled && isCancelled());
    const prepWorker = async () => {
        while (true) {
            if (cancelled()) return;
            const index = prepCursor++;
            if (index >= prepEntries.length) return;
            const entry = prepEntries[index];
            prepProgress.active += 1;
            try {
                // 站點 MIDI 生成有速率限制：MIDI 間隔 2.5 秒
                if (entry.file.source === 'api') await sleep(entry.file.apiKind === 'full' || entry.file.apiKind === 'midi' ? 2500 : 600);
                entry.url =
                    entry.file.source === 'api'
                        ? await createApiFile(cfg, session, entry.task.task_id, entry.file.apiKind)
                        : entry.file.sourceUrl && !/\/api\/songs\/[^/]+\/file\?kind=(mp3|wav)\b/i.test(entry.file.sourceUrl)
                            ? entry.file.sourceUrl
                            : await resolveFileUrl(cfg, session, entry.task.task_id, entry.file.kind);
            } catch (err) {
                entry.prepError = err;
            } finally {
                entry.prepDone = true;
                prepProgress.active -= 1;
            }
        }
    };
    const prepPromise = Promise.all(Array.from({ length: prepLimit }, () => prepWorker()));

    let done = 0;
    let failed = 0;
    let skipped = 0;
    let bytes = 0;
    const failedList = [];
    let cursor = 0;
    const total = entries.length;
    const stateWarnings = [];
    const workers = Math.min(Math.max(1, concurrency), 6);

    const worker = async () => {
        while (true) {
            if (cancelled()) return;
            const index = cursor++;
            if (index >= total) return;
            const { task, file } = entries[index];
            try {
                const entry = entries[index];
                while (!entry.prepDone) {
                    if (cancelled()) return;
                    await sleep(100);
                }
                if (entry.prepError) throw entry.prepError;
                const url = file.source === 'url' ? file.sourceUrl : entry.url;
                const result = await downloadToFile(cfg, session, url, file.path);
                done += 1;
                bytes += result.bytes;
                state.history = P.mergeHistory(state.history, task.task_id, task.folder, file, result.target);
                await log('file_complete', { taskId: task.task_id, kind: file.kind, bytes: result.bytes });
                notifyProgress({ done, skipped, failed, total, current: file.path, bytes });
                try { await saveState(cfg, plan, state); }
                catch (error) { stateWarnings.push({ taskId: task.task_id, kind: file.kind, code: error.code || 'STATE_WRITE_FAILED' }); }
            } catch (err) {
                if (err && (err.code === 'WAV_UNSUPPORTED' || err.code === 'NOT_AVAILABLE' || err.code === 'RATE_LIMIT')) {
                    skipped += 1;
                    await log('file_skipped', { taskId: task.task_id, kind: file.kind, code: err.code });
                    if (err.code === 'NOT_AVAILABLE') {
                        // 記住「站點不提供」，下次不再請求、狀態顯示 N/A（force 可重試）
                        state.unavailable = P.markUnavailable(state.unavailable, task.task_id, file.kind, 'no_download');
                        try { await saveState(cfg, plan, state); }
                        catch (error) { stateWarnings.push({ taskId: task.task_id, kind: file.kind, code: error.code || 'STATE_WRITE_FAILED' }); }
                    }
                    notifyProgress({ done, skipped, failed, total, current: file.path, bytes, skippedReason: err.message });
                    continue;
                }
                failed += 1;
                await log('file_failed', { taskId: task.task_id, kind: file.kind, code: String(err.code || 'DOWNLOAD_FAILED').slice(0, 80) });
                failedList.push({ name: `${task.folder}/${file.filename}`, error: String((err && err.message) || err) });
                notifyProgress({ done, skipped, failed, total, current: file.path, bytes });
            }
        }
    };

    await Promise.all(Array.from({ length: workers }, () => worker()));
    await prepPromise;

    skipped += plan.skipped;
    let stateSaved = true;
    try { await saveState(cfg, plan, state); }
    catch (error) { stateSaved = false; stateWarnings.push({ code: error.code || 'STATE_WRITE_FAILED' }); }
    clearFsCaches(cfg); // 下載後讓 list/overview 立即看到新檔案
    if (stateWarnings.length) await appendLog(`download-state saved=${stateSaved} warnings=${stateWarnings.length}`, cfg);
    await log('download_done', { done, skipped, failed, stateSaved, stateWarnings: stateWarnings.length });
    return { ok: failed === 0 && stateSaved, runId, total: plan.total, done, skipped, failed, bytes, failedList, stateSaved, stateWarnings, elapsedMs: Date.now() - startedAt };
}

/* ------------------------------------------------------------------ *
 * 檔案整理（改名 + 移動到 ai音樂/<歌名>/）
 * ------------------------------------------------------------------ */
function uniquePath(target) {
    const dir = path.dirname(target);
    const ext = path.extname(target);
    const base = path.basename(target, ext);
    for (let i = 2; i < 1000; i += 1) {
        const candidate = path.join(dir, `${base} (${i})${ext}`);
        if (!exists(candidate)) return candidate;
    }
    return path.join(dir, `${base} (${Date.now()})${ext}`);
}

function classifyUrl(url) {
    const s = String(url || '');
    let m = s.match(/-stem\d+-([a-z_]+)\.mp3/i);
    if (m) return { kind: 'stem', stemType: m[1].toLowerCase() };
    if (/[?&]kind=mp3\b/i.test(s)) return { kind: 'mp3' };
    if (/[?&]kind=wav\b/i.test(s)) return { kind: 'wav' };
    if (/-parts-dl\.mid/i.test(s)) return { kind: 'midi' };
    if (/score\.musicxml/i.test(s)) return { kind: 'musicxml' };
    return null;
}

function titleKey(value) {
    return N.sanitizeComponent(value, 80).toLowerCase();
}

function walkFiles(dir, depth, out, limit = 4000) {
    if (out.length >= limit) return out;
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (out.length >= limit) return out;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (depth > 0) walkFiles(full, depth - 1, out, limit);
        } else {
            out.push(full);
        }
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * 成品 MP3：所有已完成歌曲的「完整成品」集中到 <root>/<folder>/，檔名 = 歌名
 * ------------------------------------------------------------------ */
export const DEFAULT_MP3_FOLDER = '成品MP3';

function songTitleText(song) {
    return (song.meta && song.meta.title) || 'Untitled';
}

function songTitleFile(song) {
    return N.sanitizeComponent(songTitleText(song), 80) || 'Untitled';
}

/** 取得一首歌「完整成品」的音檔 URL；生成歌曲走 kind=mp3，上傳歌曲回退 local_audio */
export async function resolveFullAudioUrl(cfg, session, song) {
    const direct = `/api/songs/${encodeURIComponent(song.task_id)}/file?kind=mp3`;
    try {
        const res = await aceFetch(cfg, session, `${direct}&as=parts`, { headers: { Accept: 'application/json' } });
        if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data && typeof data === 'object') {
                if (data.server) return direct;
                if (typeof data.audio === 'string' && data.audio) return absolutize(cfg, data.audio);
                if (typeof data.url === 'string' && data.url) return absolutize(cfg, data.url);
            }
            return direct;
        }
    } catch {
        /* fall through */
    }
    if (song.local_audio) return absolutize(cfg, song.local_audio);
    throw new Error('沒有成品音檔可下載（kind=mp3 不可用且沒有 local_audio）');
}

/**
 * 把全部已完成歌曲的成品 MP3 補齊/集中到 <downloadDir>/<root>/<folder>/<歌名>.mp3
 * - 已存在就跳過（--force 可重下）
 * - 歌曲資料夾已有成品 mp3 就複製，沒有才下載（回溯之前漏掉的）
 */
export async function extractFullMp3s({
    songs = null,
    root = 'ai音樂',
    folder = DEFAULT_MP3_FOLDER,
    force = false,
    limit = 0,
    concurrency = 4,
    onProgress = null,
    isCancelled = null,
    cfg = config(),
} = {}) {
    if (!hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => extractFullMp3s(...arguments), { isCancelled });
    const session = await loadSession(cfg);
    const all = songs || (await listSongs(cfg));
    const completed = all.filter((song) => song && song.task_id && P.isDone(song));
    const nativeOnly = (song) => song.capability !== 'music_generate' && /\.(?:wav|flac|m4a|ogg|aif|aiff|aifc)$/i.test(String(song.local_audio || '').split(/[?#]/)[0]);
    const list = completed.filter((song) => !nativeOnly(song));
    const orderedAll = [...list].sort(
        (a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || songTitleFile(a).localeCompare(songTitleFile(b)) || String(a.task_id).localeCompare(String(b.task_id)),
    );
    const state = await loadState(cfg).catch(() => ({ folderByTask: {} }));
    const outDir = path.join(cfg.downloadDir, toWin(root), folder);
    await fsp.mkdir(outDir, { recursive: true });
    const manifestPath = path.join(outDir, '_manifest.json');
    const previous = await readJson(manifestPath).catch(() => null);
    const previousItems = previous && Array.isArray(previous.items) ? previous.items : [];
    const browserHistory = await readJson(cfg.historyFile, { items: [] });

    const audioUrlKey = (value) => {
        try { const url = new URL(value, cfg.baseUrl); return url.origin + url.pathname; } catch { return ''; }
    };
    const localAudioOwners = new Map();
    for (const song of list) {
        if (!song.local_audio) continue;
        const key = audioUrlKey(song.local_audio);
        if (!localAudioOwners.has(key)) localAudioOwners.set(key, new Set());
        localAudioOwners.get(key).add(song.task_id);
    }
    const isSongAudioUrl = (song, value) => {
        try {
            const url = new URL(value, cfg.baseUrl);
            if (url.origin !== new URL(cfg.baseUrl).origin && audioUrlKey(value) !== audioUrlKey(song.local_audio || '')) return false;
            if (url.pathname === `/data/${song.task_id}.mp3`) return true;
            if (url.pathname === `/api/songs/${encodeURIComponent(song.task_id)}/file` && url.searchParams.get('kind') === 'mp3') return true;
            const key = audioUrlKey(value);
            return !!song.local_audio && key === audioUrlKey(song.local_audio) && localAudioOwners.get(key)?.size === 1;
        } catch { return false; }
    };
    const pathOwners = new Map();
    const filesByTask = new Map();
    const addOwnedPath = (taskId, file, bytes = null) => {
        if (!file || !/\.mp3$/i.test(file)) return;
        const full = path.resolve(file);
        const key = full.toLowerCase();
        if (!pathOwners.has(key)) pathOwners.set(key, new Set());
        pathOwners.get(key).add(taskId);
        if (!filesByTask.has(taskId)) filesByTask.set(taskId, []);
        filesByTask.get(taskId).push({ full, bytes });
    };
    for (const item of (browserHistory && Array.isArray(browserHistory.items) ? browserHistory.items : [])) {
        if (item.state !== 'complete' || !item.filename || !/\.mp3$/i.test(item.filename)) continue;
        for (const song of list) {
            if (isSongAudioUrl(song, item.url) || isSongAudioUrl(song, item.finalUrl)) addOwnedPath(song.task_id, item.filename, item.fileSize);
        }
    }
    for (const [taskId, item] of Object.entries(state.history || {})) {
        const mp3 = item && item.files && item.files.mp3;
        if (mp3) addOwnedPath(taskId, mp3.absolute || (mp3.path && path.join(cfg.downloadDir, toWin(mp3.path))));
    }
    const ownsPath = (song, full) => {
        const owners = pathOwners.get(path.resolve(full).toLowerCase());
        return owners && owners.size === 1 && owners.has(song.task_id);
    };
    const ownsSource = (song, entry) => {
        if (!entry.source) return false;
        return /^https?:/i.test(entry.source) || entry.source.startsWith('/')
            ? isSongAudioUrl(song, entry.source)
            : ownsPath(song, entry.source);
    };
    const invalidMp3Paths = new Set();
    const candidates = new Set([...filesByTask.values()].flat().map((item) => item.full));
    for (const entry of previousItems) if (entry?.file && path.basename(entry.file) === entry.file) candidates.add(path.join(outDir, entry.file));
    for (const full of candidates) {
        if (!exists(full)) continue;
        const inspected = await inspectAudioFile(full);
        if (inspected.validity === 'damaged' || !['mp3', 'unknown'].includes(inspected.format)) invalidMp3Paths.add(path.resolve(full).toLowerCase());
    }
    const usableFile = (full, expectedBytes = null) => {
        if (invalidMp3Paths.has(path.resolve(full).toLowerCase())) return false;
        try {
            const stat = fs.statSync(full);
            return stat.isFile() && stat.size > 0 && (!(Number(expectedBytes) > 0) || stat.size === Number(expectedBytes));
        } catch { return false; }
    };
    const validName = (name) => typeof name === 'string' && name === path.basename(name) && /\.mp3$/i.test(name);
    const filenameOwners = new Map();
    for (const entry of previousItems) {
        if (!entry.task_id || !validName(entry.file)) continue;
        const key = entry.file.toLowerCase();
        if (!filenameOwners.has(key)) filenameOwners.set(key, new Set());
        filenameOwners.get(key).add(entry.task_id);
    }
    const verifiedTarget = (song, name) => previousItems.some((entry) => entry.task_id === song.task_id && entry.file === name && ownsSource(song, entry) && usableFile(path.join(outDir, name), entry.size));
    const used = new Set();
    const availableName = (song, name) => {
        const key = name.toLowerCase();
        const owners = filenameOwners.get(key);
        if (used.has(key) || (owners && (owners.size !== 1 || !owners.has(song.task_id)))) return false;
        // A file without task-specific provenance is an original to preserve, not a title match.
        return !exists(path.join(outDir, name)) || verifiedTarget(song, name);
    };

    const assigned = orderedAll.map((song) => {
        const base = songTitleFile(song);
        const oldNames = previousItems.filter((entry) => entry.task_id === song.task_id && validName(entry.file))
            .sort((a, b) => Number(ownsSource(song, b)) - Number(ownsSource(song, a)) || String(b.at || '').localeCompare(String(a.at || '')) || a.file.localeCompare(b.file));
        let filename = oldNames.find((entry) => availableName(song, entry.file))?.file;
        for (let count = 1; !filename; count++) {
            const candidate = count === 1 ? `${base}.mp3` : `${base} (${count}).mp3`;
            if (availableName(song, candidate)) filename = candidate;
        }
        used.add(filename.toLowerCase());
        return { song, title: songTitleText(song), filename };
    });
    const items = Number(limit) > 0 ? assigned.slice(0, Number(limit)) : assigned;
    const findExisting = (song) => {
        for (const item of filesByTask.get(song.task_id) || []) {
            if (ownsPath(song, item.full) && usableFile(item.full, item.bytes)) return item.full;
        }
        for (const entry of previousItems) {
            if (entry.task_id === song.task_id && validName(entry.file) && ownsSource(song, entry) && usableFile(path.join(outDir, entry.file), entry.size)) return path.join(outDir, entry.file);
        }
        return null;
    };

    const report = {
        ok: true,
        folder: outDir,
        total: items.length,
        unsupported: completed.filter(nativeOnly).map((song) => ({ task_id: song.task_id, title: songTitleText(song), reason: '原始音檔不是 MP3，保留原格式' })),
        skipped: 0,
        copied: 0,
        downloaded: 0,
        failed: [],
        bytes: 0,
        startedAt: new Date().toISOString(),
    };
    const manifest = new Map();
    for (const entry of previousItems) {
        if (entry && entry.task_id) manifest.set(entry.task_id + '|' + entry.file, entry);
    }
    let done = 0;
    const emit = (current) => {
        if (typeof onProgress === 'function') {
            try {
                onProgress({ ...report, done, current: current || '', manifestPath });
            } catch {
                /* ignore */
            }
        }
    };
    emit('');

    const queue = [...items];
    const concurrencyCount = Math.max(1, Math.min(6, Math.round(Number(concurrency) || 4)));
    const worker = async () => {
        while (queue.length) {
            if (typeof isCancelled === 'function' && isCancelled()) {
                report.cancelled = true;
                return;
            }
            const item = queue.shift();
            if (!item) return;
            const target = path.join(outDir, item.filename);
            const temp = target + '.part';
            let mode = '';
            let source = '';
            try {
                if (!force && verifiedTarget(item.song, item.filename)) {
                    report.skipped += 1;
                    mode = 'skipped';
                } else {
                    const found = force ? null : findExisting(item.song);
                    if (found) {
                        await fsp.copyFile(found, temp);
                        await fsp.rename(temp, target);
                        source = found;
                        mode = 'copied';
                        report.copied += 1;
                    } else {
                        const url = /\.mp3$/i.test(String(item.song.local_audio || '').split(/[?#]/)[0]) ? absolutize(cfg, item.song.local_audio) : await resolveFullAudioUrl(cfg, session, item.song);
                        const res = await aceFetch(cfg, session, url, { headers: { Accept: '*/*' } });
                        if (!res.ok) throw new Error('MP3 檔案下載 HTTP ' + res.status);
                        const contentType = String(res.headers.get('content-type') || '');
                        if (/json|html/i.test(contentType)) throw new Error('伺服器回傳非音檔內容（' + contentType + '）');
                        const buffer = Buffer.from(await res.arrayBuffer());
                        if (!buffer.length) throw new Error('檔案為空');
                        validateAudioBuffer(buffer, 'mp3');
                        await fsp.writeFile(temp, buffer);
                        await fsp.rename(temp, target);
                        source = url;
                        mode = 'downloaded';
                        report.downloaded += 1;
                    }
                }
                const size = fs.statSync(target).size;
                if (mode !== 'skipped') {
                    report.bytes += size;
                    manifest.set(item.song.task_id + '|' + item.filename, {
                        title: item.title,
                        task_id: item.song.task_id,
                        file: item.filename,
                        size,
                        mode,
                        source,
                        at: new Date().toISOString(),
                    });
                }
            } catch (err) {
                report.failed.push({ title: item.title, task_id: item.song.task_id, error: String((err && err.message) || err) });
                try {
                    fs.rmSync(temp, { force: true });
                } catch {
                    /* ignore */
                }
            }
            done += 1;
            emit(item.title);
        }
    };
    await Promise.all(Array.from({ length: concurrencyCount }, worker));
    report.finishedAt = new Date().toISOString();
    report.ok = report.failed.length === 0 && !report.cancelled;
    report.done = done;
    await writeJson(manifestPath, {
        schema: 'ace_full_mp3_manifest_v1',
        generatedAt: report.finishedAt,
        root,
        folder,
        total: items.length,
        items: [...manifest.values()],
    });
    report.manifestPath = manifestPath;
    clearFsCaches(cfg);
    emit('');
    return report;
}

/**
 * 把各歌曲資料夾內的 WAV 集中到 <root>/<folder>/（預設「成品WAV」）。
 * - 只搬「歌名資料夾」內的 WAV；成品MP3／採樣包／封面／音頻分類／自訂資料夾不動
 * - 同名同內容 → 來源歸檔保留回滾；同名不同內容 → 改名 (n)
 * - 保留硬連結（搬移後音頻分類的 mirror 仍然有效）
 */
export async function collectFullWavs({ root = 'ai音樂', folder = '成品WAV', cfg = config(), onProgress = null } = {}) {
    if (!hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => collectFullWavs(...arguments));
    const { moveFileSafely, recordRelocations } = await import('./file-ops.mjs');
    const rootDir = path.join(cfg.downloadDir, toWin(root)), outDir = path.join(rootDir, folder);
    const report = { ok: true, total: 0, moved: 0, skipped: 0, duplicates: 0, failed: [], outDir, startedAt: new Date().toISOString() };
    if (!exists(rootDir)) return { ...report, ok: false, error: '找不到 ' + rootDir };
    const protectedTop = new Set([...DEDUPE_CATEGORY_DIRS, folder, '_未對應', ...DEDUPE_CUSTOM_TOP]);
    const roles = new Set([...Object.values(N.STEM_TYPE_NAMES), 'Piano', 'Percussion', 'Melody', 'Other'].map((value) => String(value).toLowerCase()));
    const files = walkFiles(rootDir, 4, [], 60000).filter((file) => {
        if (!/\.wav$/i.test(file)) return false;
        const parts = path.relative(rootDir, file).split(path.sep);
        if (protectedTop.has(parts[0])) return false;
        if (parts.slice(1, -1).some((part) => /^(stems|採樣包(?:WAV)?)$/i.test(part))) return false;
        const stem = path.basename(file, path.extname(file));
        if (stem.toLowerCase() === parts[0].toLowerCase() || parts.slice(1, -1).some((part) => /^Audio$/i.test(part))) return true;
        const suffix = stem.split(' - ').at(-1).replace(/ \(\d+\)$/, '').trim().toLowerCase();
        return !stem.includes(' - ') || !roles.has(suffix);
    });
    await fsp.mkdir(outDir, { recursive: true });
    const moves = [];
    for (const file of files) {
        report.total++;
        try {
            const result = await moveFileSafely(cfg, file, path.join(outDir, path.basename(file)), { conflict: 'unique', reason: 'collect_full_wavs' });
            if (result.moved) report.moved++;
            else if (result.deduped) report.duplicates++;
            else report.skipped++;
            if (result.moved || result.deduped) moves.push(result);
        } catch (error) { report.failed.push({ file, error: String(error.message || error) }); }
        if (typeof onProgress === 'function') onProgress({ done: report.total, total: files.length, current: path.basename(file) });
    }
    await recordRelocations(cfg, moves);
    report.finishedAt = new Date().toISOString();
    report.ok = report.failed.length === 0;
    clearFsCaches(cfg);
    return report;
}


/**
 * 把各歌曲資料夾內的「分軌/採樣」音檔集中到 <root>/<folder>/，檔名保留 <歌名> - <分軌>.mp3
 * 只複製、不搬動原始檔案；相同內容才跳過，同名不同內容保留獨立版本。
 */
export async function collectSamples({ root = 'ai音樂', folder = '採樣包', cfg = config() } = {}) {
    if (!hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => collectSamples(...arguments));
    const { copyFileSafely } = await import('./file-ops.mjs');
    const rootDir = path.join(cfg.downloadDir, toWin(root)), outDir = path.join(rootDir, folder), wavOutDir = path.join(rootDir, '採樣包WAV');
    await fsp.mkdir(outDir, { recursive: true });
    const roles = new Map([...Object.values(N.STEM_TYPE_NAMES), 'Piano', 'Percussion', 'Melody', 'Other'].map((value) => [String(value).toLowerCase(), String(value)]));
    const excluded = new Set([folder, '採樣包WAV', '_成品MP3', '_未對應', 'sample', 'WAI', 'WAMI', '俱樂部版', '舊版對照', '成品MP3', '成品WAV', 'MIDI', 'MusicXML', '封面', '壓縮檔', '其他', '音頻分類']);
    const report = { ok: true, folder: outDir, total: 0, copied: 0, skipped: 0, migrated: 0, failed: [], bytes: 0 };
    const manifestPath = path.join(outDir, '_manifest.json'), previous = await readJson(manifestPath).catch(() => null), manifest = new Map();
    for (const entry of previous && Array.isArray(previous.items) ? previous.items : []) if (entry && entry.file) manifest.set((entry.container || folder) + '/' + (entry.type || '') + '/' + entry.file, entry);
    const pending = [], seenPaths = new Set();
    for (const full of walkFiles(rootDir, 4, [], 60000)) {
        if (!/\.(mp3|wav|flac|aiff?)$/i.test(full)) continue;
        const parts = path.relative(rootDir, full).split(path.sep);
        if (parts.length < 2 || excluded.has(parts[0])) continue;
        const base = path.basename(full), stem = path.basename(full, path.extname(full));
        if (stem.toLowerCase() === parts[0].toLowerCase()) continue;
        const dirs = parts.slice(1, -1), explicitStems = dirs.some((part) => /^Stems$/i.test(part));
        if (dirs.some((part) => /^(MIDI|Audio)$/i.test(part))) continue;
        const rawRole = stem.includes(' - ') ? stem.split(' - ').at(-1).replace(/ \(\d+\)$/, '').trim() : '';
        const role = roles.get(rawRole.toLowerCase());
        if (!explicitStems && !role) continue;
        const key = path.resolve(full).toLowerCase();
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        const isWav = /\.wav$/i.test(base), container = isWav ? '採樣包WAV' : folder, type = role || 'Other';
        pending.push({ from: full, to: path.join(isWav ? wavOutDir : outDir, type, base), song: parts[0], container, type, legacy: parts[0] === '採樣' });
    }
    report.total = pending.length;
    for (const item of pending) {
        try {
            const result = await copyFileSafely(cfg, item.from, item.to, { conflict: 'unique', reason: 'collect_samples' });
            if (result.skipped) report.skipped++;
            else { report.copied++; report.bytes += fs.statSync(result.to).size; if (item.legacy) report.migrated++; }
            const file = path.basename(result.to), key = item.container + '/' + item.type + '/' + file, prior = manifest.get(key);
            manifest.set(key, { file, type: item.type, container: item.container, song: item.song, source: item.from,
                sources: [...new Set([...(prior && prior.sources || []), ...(prior && prior.source ? [prior.source] : []), item.from])],
                size: fs.statSync(result.to).size, at: new Date().toISOString() });
        } catch (error) { report.failed.push({ file: path.basename(item.from), source: item.from, error: String(error.message || error) }); }
    }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, { schema: 'ace_samples_manifest_v1', generatedAt: report.finishedAt, root, folder, total: report.total, items: [...manifest.values()] });
    report.manifestPath = manifestPath;
    clearFsCaches(cfg);
    return report;
}


/**
 * 依「檔案屬性/類型」把各歌曲資料夾內的非音訊檔集中分類到：
 *   ai音樂/MIDI, ai音樂/MusicXML, ai音樂/封面, ai音樂/壓縮檔, ai音樂/其他
 * （音訊由 extractFullMp3s / collectSamples 處理）
 */
export async function classifyByAttributes({ root = 'ai音樂', move = true, cfg = config() } = {}) {
    if (!hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => classifyByAttributes(...arguments));
    const { moveFileSafely, copyFileSafely, recordRelocations } = await import('./file-ops.mjs');
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const categories = { mid: 'MIDI', midi: 'MIDI', musicxml: 'MusicXML', jpg: '封面', jpeg: '封面', png: '封面', webp: '封面', gif: '封面', avif: '封面', zip: '壓縮檔', rar: '壓縮檔', '7z': '壓縮檔', asd: '其他', als: '其他', amxd: '其他', pdf: '其他' };
    const excluded = new Set([...Object.values(categories), '成品MP3', '成品WAV', '採樣包', '採樣包WAV', '採樣', '_未對應', 'sample', 'WAI', 'WAMI', '俱樂部版', '音頻分類']);
    const byCategory = new Map();
    for (const full of walkFiles(rootDir, 3, [], 30000)) {
        const ext = path.extname(full).slice(1).toLowerCase(), category = categories[ext], parts = path.relative(rootDir, full).split(path.sep);
        if (!category || parts.length < 2 || excluded.has(parts[0])) continue;
        let name = path.basename(full);
        if ((ext === 'mid' || ext === 'midi') && !name.includes(' - ')) name = parts[0] + ' - MIDI.mid';
        else if (ext === 'musicxml' && !name.includes(' - ')) name = parts[0] + ' - MusicXML.musicxml';
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push({ from: full, to: path.join(rootDir, category, name) });
    }
    const report = { ok: true, categories: {}, total: 0, copied: 0, moved: 0, deduped: 0, skipped: 0, failed: [] }, moves = [];
    try {
        for (const [category, items] of byCategory) {
            const outDir = path.join(rootDir, category), manifestPath = path.join(outDir, '_manifest.json');
            const previous = await readJson(manifestPath).catch(() => null), manifest = new Map();
            for (const entry of previous && Array.isArray(previous.items) ? previous.items : []) if (entry && entry.file) manifest.set(entry.file, entry);
            for (const item of items) {
                try {
                    const result = await (move ? moveFileSafely : copyFileSafely)(cfg, item.from, item.to, { conflict: 'unique', reason: 'classify_by_attributes' });
                    if (result.moved) report.moved++;
                    else if (result.copied) report.copied++;
                    else if (result.deduped) report.deduped++;
                    else report.skipped++;
                    if (result.moved || result.deduped) moves.push(result);
                    const file = path.basename(result.to), prior = manifest.get(file);
                    manifest.set(file, { file, source: item.from, sources: [...new Set([...(prior && prior.sources || []), ...(prior && prior.source ? [prior.source] : []), item.from])], size: fs.statSync(result.to).size, at: new Date().toISOString() });
                    report.categories[category] = (report.categories[category] || 0) + 1;
                    report.total++;
                } catch (error) { report.failed.push({ file: path.basename(item.from), error: String(error.message || error) }); }
            }
            await writeJson(manifestPath, { schema: 'ace_file_category_v1', category, generatedAt: new Date().toISOString(), items: [...manifest.values()] });
        }
    } finally { await recordRelocations(cfg, moves); }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    clearFsCaches(cfg);
    return report;
}


/**
 * 一鍵自動整理管線：整理舊檔 → 補齊成品 MP3 → 採樣包分類 → 檔案屬性分類
 */
/**
 * 按「音頻屬性」分類：BPM / 調性(Camelot) / 能量，分軌再加樂器類型。
 * 對 ai音樂 內所有音檔（成品、分軌、未對應）分析後用 hardlink 建分類視圖（不佔額外空間）。
 */
/**
 * 音頻分類是 hardlink 檢視。去重／整理把原件歸檔後，它在音頻分類裡的連結仍指向歸檔的那份資料，
 * 變成「只存在於音頻分類」的孤兒（常見症狀：播放器出現十六進位檔名、同一首重複、檔數虛增）。
 * 規則：檢視檔的實體檔若不屬於任何曲庫內的來源檔，且曲庫內有內容完全相同的來源，才把這個檢視連結
 * 移到 organize-backups（同磁碟改名，可復原，不刪資料）；沒有相同來源的唯一音訊只回報、不動。
 */
export async function pruneStaleAudioViews({ cfg = config(), outDir, liveFiles, commit = false } = {}) {
    const report = { checked: 0, stale: 0, moved: 0, keptUnique: 0, rescued: 0, kept: [], rescuedItems: [], movedItems: [], failed: [], archive: null };
    // 沒有相同來源的孤兒是這份音訊唯一可見的位置：以 hardlink 補回曲庫（不佔空間），讓它成為正常來源並被分析。
    const rescueDir = path.join(path.dirname(outDir), '_未對應', '音頻分類找回');
    if (!outDir || !exists(outDir)) return report;
    const { physicalFileKey } = await import('./file-id.mjs');
    const liveByKey = new Map(), liveBySize = new Map();
    for (const file of liveFiles || []) {
        let stat;
        try { stat = fs.statSync(file, { bigint: true }); } catch { continue; }
        liveByKey.set(physicalFileKey(stat, file), file);
        const size = Number(stat.size);
        if (!liveBySize.has(size)) liveBySize.set(size, []);
        liveBySize.get(size).push(file);
    }
    const views = walkFiles(outDir, 8, [], 200000).filter((file) => /\.(mp3|wav|flac)$/i.test(file));
    const hashes = new Map();
    const hashOf = async (file) => { if (!hashes.has(file)) hashes.set(file, await streamFileHash(file)); return hashes.get(file); };
    const rescuedByHash = new Set();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveRoot = path.join(cfg.stateDir, 'organize-backups', 'stale-audio-views-' + stamp);
    for (const view of views) {
        report.checked++;
        let stat;
        try { stat = fs.statSync(view, { bigint: true }); } catch { continue; }
        if (liveByKey.has(physicalFileKey(stat, view))) continue;
        // 只處理「仍與別處（歸檔）共用資料」的 hardlink；獨立複本（nlink=1）是使用者或舊版留下的檔案，照舊保留。
        if (stat.nlink <= 1n) continue;
        report.stale++;
        let keeper = null;
        try {
            const digest = await hashOf(view);
            for (const candidate of liveBySize.get(Number(stat.size)) || []) if (await hashOf(candidate) === digest) { keeper = candidate; break; }
        } catch (error) { report.failed.push({ file: path.relative(outDir, view), error: String(error.message || error) }); continue; }
        if (!keeper) {
            report.keptUnique++;
            if (report.kept.length < 200) report.kept.push(path.relative(outDir, view));
            const digest = hashes.get(view);
            if (rescuedByHash.has(digest)) continue;
            if (!commit) { report.rescuedItems.push({ view: path.relative(outDir, view), preview: true }); rescuedByHash.add(digest); continue; }
            try {
                await fsp.mkdir(rescueDir, { recursive: true });
                const ext = path.extname(view), stem = path.basename(view, ext);
                let target = path.join(rescueDir, stem + ext);
                for (let n = 2; exists(target); n++) {
                    if (await streamFileHash(target) === digest) { target = null; break; }
                    target = path.join(rescueDir, stem + ' (' + n + ')' + ext);
                }
                if (target) { await fsp.link(view, target); report.rescued++; report.rescuedItems.push({ view: path.relative(outDir, view), to: path.relative(path.dirname(outDir), target) }); }
                rescuedByHash.add(digest);
            } catch (error) { report.failed.push({ file: path.relative(outDir, view), error: String(error.message || error) }); }
            continue;
        }
        if (!commit) { report.movedItems.push({ view: path.relative(outDir, view), keeper: path.relative(path.dirname(outDir), keeper), preview: true }); continue; }
        const target = path.join(archiveRoot, path.relative(outDir, view));
        try {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.rename(view, target);
            report.moved++;
            report.archive = archiveRoot;
            if (report.movedItems.length < 500) report.movedItems.push({ view: path.relative(outDir, view), keeper: path.relative(path.dirname(outDir), keeper) });
        } catch (error) { report.failed.push({ file: path.relative(outDir, view), error: String(error.message || error) }); }
    }
    if (commit && report.moved) await fsp.writeFile(path.join(archiveRoot, '_stale-views.json'), JSON.stringify({ reason: 'classification view whose source was archived; identical live source exists', createdAt: new Date().toISOString(), items: report.movedItems }, null, 2)).catch(() => {});
    return report;
}

export async function classifyByAudio({ root = 'ai音樂', folder = '音頻分類', linkMode = 'hardlink', limit = 0, refresh = false, onProgress = null, cfg = config() } = {}) {
    if (!hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => classifyByAudio(...arguments));
    const { sameFileContent, copyFileSafely } = await import('./file-ops.mjs');
    const algorithmVersion = 'huaidj-audio-v2-pitch-class-c';
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    if (!exists(rootDir)) return { ok: false, total: 0, error: '找不到 ' + rootDir };
    const outDir = path.join(rootDir, folder);
    const files = walkFiles(rootDir, 3, [], 30000).filter((file) => {
        if (!/\.(mp3|wav|flac)$/i.test(file)) return false;
        const lower = file.toLowerCase();
        return !lower.startsWith(outDir.toLowerCase());
    });
    const unique = [...new Set(files.map((file) => path.resolve(file)))];
    const selected = Number(limit) > 0 ? unique.slice(0, Number(limit)) : unique;
    const cache = (await cacheRead('audio-analysis', { cfg }).catch(() => null)) || { items: {}, thresholds: null };
    const cacheItems = cache.items || {};
    const previousAlgorithmItems = { ...(cache.previousAlgorithmItems || {}) };
    const analyses = [];
    const todo = [];
    for (const file of selected) {
        const stat = fs.statSync(file);
        const key = path.resolve(file);
        const cached = cacheItems[key];
        const matchingAlgorithm = !!cached && cached.algorithmVersion === algorithmVersion;
        if (cached && !matchingAlgorithm) {
            const priorVersion = String(cached.algorithmVersion || 'unversioned');
            const retained = { ...(previousAlgorithmItems[priorVersion] || {}) };
            if (!retained[key] || (retained[key].ok !== true && cached.ok === true)) retained[key] = cached;
            previousAlgorithmItems[priorVersion] = retained;
        }
        // JSON 讀回後 mtime 可能是字串，統一換算成毫秒再比對，否則快取永遠不會命中
        const cachedMtime = cached ? (typeof cached.mtime === 'number' ? cached.mtime : Date.parse(cached.mtime)) : NaN;
        const sameTime = Number.isFinite(cachedMtime) && Math.abs(cachedMtime - stat.mtimeMs) < 1.5;
        // 只有「成功」的分析結果可以重用；失敗紀錄一旦重用，暫時性錯誤會永遠卡在失敗
        if (!refresh && cached && cached.ok === true && matchingAlgorithm && cached.size === stat.size && sameTime) {
            analyses.push(cached);
        } else {
            todo.push({ file: key, size: stat.size, mtime: stat.mtimeMs });
        }
    }
    const report = { ok: true, folder: outDir, total: selected.length, analyzed: todo.length, cached: analyses.length, linked: 0, skipped: 0, failed: [], unanalyzable: [], thresholds: cache.thresholds };
    const analyzerScript = path.join(PROJECT_ROOT_FOR_AI(), 'agent', 'analyze_audio.py');
    const pythonExe = process.env.ACE_PYTHON || 'python';
    const spawnEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const runAnalyzer = (files) => {
        const res = spawnSync(pythonExe, [analyzerScript, ...files], {
            encoding: 'utf8',
            timeout: 600000,
            maxBuffer: 64 * 1024 * 1024,
            env: spawnEnv,
            windowsHide: true,
        });
        const stderr = String(res.stderr || '').trim();
        const spawnError = res.error ? String(res.error.message || res.error) : '';
        let parsed = [];
        try { parsed = JSON.parse(res.stdout || '[]'); } catch { parsed = []; }
        if (!Array.isArray(parsed)) parsed = [];
        return { parsed, stderr, status: res.status, spawnError };
    };
    let done = analyses.length;
    const batchSize = 8;
    for (let i = 0; i < todo.length; i += batchSize) {
        const batch = todo.slice(i, i + batchSize);
        const result = runAnalyzer(batch.map((item) => item.file));
        const byPath = new Map(result.parsed.filter((entry) => entry && entry.path).map((entry) => [path.resolve(entry.path), entry]));
        const missing = batch.filter((item) => !byPath.has(item.file));
        // 批次輸出解析失敗（python 沒起來／輸出被截斷）→ 逐檔重試，避免整批 8 檔被誤判失敗
        for (const item of missing) {
            const single = runAnalyzer([item.file]);
            const hit = single.parsed.find((entry) => entry && entry.path && path.resolve(entry.path) === item.file);
            if (hit) {
                byPath.set(item.file, hit);
            } else {
                const reason = single.spawnError || single.stderr || (single.status === null ? 'python 無法啟動' : 'python exit ' + single.status);
                byPath.set(item.file, { path: item.file, ok: false, error: String(reason).slice(0, 300) });
            }
        }
        for (const item of batch) {
            const hit = byPath.get(item.file) || { ok: false, error: result.spawnError || result.stderr || 'analyzer produced no output' };
            const record = {
                file: item.file,
                relative: path.relative(cfg.downloadDir, item.file).split(path.sep).join('/'),
                size: item.size,
                mtime: item.mtime,
                ok: !!hit.ok,
                algorithmVersion: typeof hit.algorithmVersion === 'string' ? hit.algorithmVersion : null,
                duration: hit.duration ?? null,
                bpm: hit.bpm ?? null,
                key: hit.key ?? null,
                camelot: hit.camelot ?? null,
                energy: hit.energy ?? null,
                analyzedAt: new Date().toISOString(),
            };
            if (record.ok && record.algorithmVersion !== algorithmVersion) {
                record.ok = false;
                record.error = 'Analyzer algorithm version does not match the required pitch-class correction.';
            }
            if (!record.ok && !record.error) record.error = String(hit.error || 'analysis failed').slice(0, 300);
            analyses.push(record);
            cacheItems[item.file] = record;
            // 單檔分析失敗 = 檔案本身無法分析（略過但不讓整輪整理變失敗）；批次/啟動失敗才算管線失敗
            if (!record.ok) report.unanalyzable.push({ file: item.file, error: record.error });
            done += 1;
            if (typeof onProgress === 'function') {
                try { onProgress({ done, total: todo.length, current: path.basename(item.file) }); } catch { /* ignore */ }
            }
        }
        await cacheWrite('audio-analysis', { items: cacheItems, previousAlgorithmItems, algorithmVersion, thresholds: cache.thresholds }, cfg).catch(() => {});
    }
    // 能量分級門檻（用整體分位數，之後固定沿用，讓增量分類一致）
    if (!cache.thresholds) {
        const energies = analyses.map((item) => item.energy).filter((value) => typeof value === 'number');
        if (energies.length >= 12) {
            const sorted = [...energies].sort((a, b) => a - b);
            const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
            cache.thresholds = { low: Number(q(0.33).toFixed(4)), high: Number(q(0.66).toFixed(4)) };
        } else {
            cache.thresholds = { low: 0.1, high: 0.18 };
        }
        await cacheWrite('audio-analysis', { items: cacheItems, previousAlgorithmItems, algorithmVersion, thresholds: cache.thresholds }, cfg).catch(() => {});
    }
    report.thresholds = cache.thresholds;
    const low = cache.thresholds.low;
    const high = cache.thresholds.high;
    const sanitize = (value) => N.sanitizeComponent(String(value || ''), 80) || 'Unknown';
    const bucketBpm = (bpm) => (bpm == null ? 'Unknown' : String(Math.max(0, Math.floor(bpm / 5) * 5)) + '-' + String(Math.max(5, Math.floor(bpm / 5) * 5 + 5)));
    const tierEnergy = (energy) => (energy == null ? 'Unknown' : energy < low ? 'Low' : energy < high ? 'Mid' : 'High');
    const stemRoles = new Map([...Object.values(N.STEM_TYPE_NAMES), 'Piano', 'Percussion', 'Melody', 'Other'].map((value) => [String(value).toLowerCase(), String(value)]));
    const stemTypeOf = (base) => {
        const stem = base.replace(/\.[^.]+$/, '');
        const parts = stem.split(' - ');
        const raw = (parts.length > 1 ? parts.at(-1) : '').replace(/ \(\d+\)$/, '').trim().toLowerCase();
        return stemRoles.get(raw) || '';
    };
    const manifest = [];
    const safeLinkPath = async (file) => {
        const base = path.resolve(cfg.downloadDir), full = path.resolve(file), relative = path.relative(base, full);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Object.assign(new Error('Classification path is outside the download directory.'), { code: 'FILE_OUTSIDE_ROOT' });
        let current = base;
        for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
            if (part) current = path.join(current, part);
            try {
                if ((await fsp.lstat(current)).isSymbolicLink()) throw Object.assign(new Error('Classification refuses symbolic links.'), { code: 'FILE_SYMLINK' });
            } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        }
    };
    const linkFile = async (source, target) => {
        await safeLinkPath(source);
        await safeLinkPath(target);
        if (linkMode === 'copy') {
            const result = await copyFileSafely(cfg, source, target, { conflict: 'unique', reason: 'classify_audio_view' });
            if (result.skipped) report.skipped++;
            else report.linked++;
            return result.to;
        }
        const desired = target;
        for (let number = 2; ; number++) {
            await safeLinkPath(target);
            if (exists(target)) {
                if (await sameFileContent(source, target)) { report.skipped++; return target; }
                target = path.join(path.dirname(desired), path.basename(desired, path.extname(desired)) + ' (' + number + ')' + path.extname(desired));
                continue;
            }
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await safeLinkPath(target);
            try {
                await fsp.link(source, target);
            } catch (error) {
                if (error.code === 'EEXIST') continue;
                if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(error.code)) throw error;
                const result = await copyFileSafely(cfg, source, target, { conflict: 'unique', reason: 'classify_audio_view_fallback' });
                if (result.skipped) report.skipped++;
                else report.linked++;
                return result.to;
            }
            if (!await sameFileContent(source, target)) throw Object.assign(new Error('Source changed while its classification view was checked.'), { code: 'SOURCE_CHANGED' });
            report.linked++;
            return target;
        }
    };
    for (const record of analyses) {
        if (!record.ok) continue;
        const base = path.basename(record.file);
        const item = { ...record, links: [] };
        const parts = path.relative(rootDir, record.file).split(path.sep), directories = parts.slice(0, -1);
        const fullFolder = /^(成品MP3|成品WAV|俱樂部版)$/i.test(parts[0]) || directories.some((part) => /^Audio$/i.test(part))
            || path.basename(base, path.extname(base)).toLowerCase() === parts[0].toLowerCase();
        const explicitStem = directories.some((part) => /^(Stems|採樣包(?:WAV)?)$/i.test(part));
        const isStem = !fullFolder && (explicitStem || !!stemTypeOf(base));
        const isUnknown = record.file.includes('_未對應');
        const kind = isUnknown ? '其他音檔' : isStem ? '分軌' : '完整歌曲';
        const stemType = isStem ? sanitize(stemTypeOf(base) || stemRoles.get(String(directories.at(-1) || '').toLowerCase()) || 'Other') : '';
        const axes = [
            ['BPM', bucketBpm(record.bpm)],
            ['Key', sanitize(record.camelot || (record.key ? record.key.replace(':', ' ') : 'Unknown'))],
            ['Energy', tierEnergy(record.energy)],
        ];
        try {
            for (const [axis, bucket] of axes) {
                const target = await linkFile(record.file, path.join(outDir, kind, axis, sanitize(bucket), base));
                item.links.push(path.relative(outDir, target).split(path.sep).join('/'));
            }
            if (stemType) {
                const target = await linkFile(record.file, path.join(outDir, '分軌', '類型', stemType, base));
                item.links.push(path.relative(outDir, target).split(path.sep).join('/'));
            }
            manifest.push(item);
        } catch (error) { report.failed.push({ file: record.file, error: String(error.message || error), code: error.code }); }
    }
    if (linkMode === 'hardlink') report.staleViews = await pruneStaleAudioViews({ cfg, outDir, liveFiles: unique, commit: true });
    await writeJson(path.join(outDir, '_manifest.json'), {
        schema: 'ace_audio_classification_v1',
        generatedAt: new Date().toISOString(),
        root,
        folder,
        axes: ['BPM', 'Key', 'Energy'],
        thresholds: cache.thresholds,
        total: manifest.length,
        unanalyzable: report.unanalyzable.slice(0, 200),
        items: manifest,
    });
    report.total = selected.length;
    report.linkedFiles = manifest.length;
    report.unanalyzableCount = report.unanalyzable.length;
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    clearFsCaches(cfg);
    return report;
}

function PROJECT_ROOT_FOR_AI() {
    return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
}

/**
 * 把歌曲資料夾裡「已有分類副本」的檔案刪掉，完成真正的單一分類庫（省空間）。
 * 同名/同格式/同大小只是候選；內容 hash 相同才歸檔，保留可回滾副本。
 */
/** 歌名資料夾內與分類庫內容相同的副本歸檔。commit:false 只預覽（不取寫入鎖、不搬移）；整理流程預設照舊執行。 */
export async function dedupeSongCopies({ root = 'ai音樂', commit = true, cfg = config() } = {}) {
    if (commit && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => dedupeSongCopies(...arguments));
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const CATEGORY_DIRS = ['成品MP3', '成品WAV', '採樣包', '採樣包WAV', 'MIDI', 'MusicXML', '封面', '壓縮檔', '其他'];
    const normalize = (name) => name.replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)\s*$/, '').toLowerCase();
    const index = new Map(); // key: normExt|size -> categoryPath
    for (const dir of CATEGORY_DIRS) {
        const full = path.join(rootDir, dir);
        if (!exists(full)) continue;
        for (const file of walkFiles(full, 3, [], 30000)) {
            try {
                const stat = fs.statSync(file);
                const key = path.extname(file).toLowerCase() + '|' + normalize(path.basename(file)) + '|' + stat.size;
                if (!index.has(key)) index.set(key, []);
                index.get(key).push(file);
            } catch { /* ignore */ }
        }
    }
    const report = { ok: true, commit, removed: 0, archived: 0, savedBytes: 0, failed: [], scanned: 0, candidates: [] };
    const relocations = [];
    const skipTop = new Set([...CATEGORY_DIRS, '音頻分類', '_未對應', 'sample', 'WAI', '俱樂部版', '舊版對照']);
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || skipTop.has(entry.name)) continue;
        const songDir = path.join(rootDir, entry.name);
        for (const file of walkFiles(songDir, 2, [], 20000)) {
            report.scanned += 1;
            try {
                const stat = fs.statSync(file);
                const key = path.extname(file).toLowerCase() + '|' + normalize(path.basename(file)) + '|' + stat.size;
                if (!index.has(key)) continue;
                const keeper = await (async () => { for (const candidate of index.get(key)) if (await sameFileContent(file, candidate)) return candidate; return null; })();
                if (!keeper) continue;
                if (!commit) { report.candidates.push({ file: path.relative(rootDir, file), keep: path.relative(rootDir, keeper), bytes: stat.size }); continue; }
                const moved = await moveFileSafely(cfg, file, keeper, { reason: 'song-copy-dedupe' });
                relocations.push(moved);
                if (moved.deduped) { report.removed += 1; report.archived += 1; }
            } catch (err) {
                report.failed.push({ file, error: String((err && err.message) || err) });
            }
        }
    }
    report.ok = report.failed.length === 0;
    report.candidateCount = report.candidates.length;
    if (!commit) return report;
    await recordRelocations(cfg, relocations);
    clearFsCaches(cfg);
    return report;
}

const DEDUPE_CATEGORY_DIRS = ['成品MP3', '成品WAV', '採樣包', '採樣包WAV', 'MIDI', 'MusicXML', '封面', '壓縮檔', '其他', '音頻分類'];
const DEDUPE_PROTECTED_TOP = new Set([...DEDUPE_CATEGORY_DIRS, '_未對應']);
// 使用者手動整理的自訂資料夾：預設不動，--include-custom 才納入
const DEDUPE_CUSTOM_TOP = new Set(['sample', 'WAI', 'WAMI', '俱樂部版', '舊版對照']);
const CONTENT_KEEPER_PRIORITY = { 成品WAV: 0, 成品MP3: 0, 採樣包: 1, 採樣包WAV: 2, _未對應: 3 };

function keeperRank(rel) {
    const parts = rel.split(path.sep);
    const top = parts[0];
    const base = parts[parts.length - 1];
    const numbered = / \(\d+\)\.[^.]+$/.test(base) ? 1 : 0;
    const group = CONTENT_KEEPER_PRIORITY[top] != null ? CONTENT_KEEPER_PRIORITY[top] : DEDUPE_CUSTOM_TOP.has(top) ? 4 : 2;
    return [group, numbered, rel.length, rel.toLowerCase()];
}

function compareRank(a, b) {
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

async function streamFileHash(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

/** 保留歷史 alias 線索，不把其他歌曲的檔案狀態當成本曲的證據。 */
export function applyAliases(rows, state) {
    const aliases = (state && state.aliases) || {};
    const byId = new Map(rows.map((row) => [row.task_id, row]));
    for (const row of rows) {
        const keeperId = aliases[row.task_id];
        if (!keeperId) continue;
        const keeper = byId.get(keeperId);
        if (!keeper) continue;
        row.aliasOf = keeperId;
    }
    return rows;
}

/* ------------------------------------------------------------------ *
 * 本地快取層：library snapshot（一次算好，後續查詢直接讀）
 * ------------------------------------------------------------------ */
export async function buildLibrarySnapshot(cfg = config(), { refresh = false } = {}) {
    const { buildLocalDownloadIndex } = await import('./local-index.mjs');
    const { compactLocalIndex } = await import('./local-index-service.mjs');
    const [songs, state, page, cached] = await Promise.all([
        listSongs(cfg, { refresh }), loadState(cfg),
        readJson(path.join(cfg.stateDir, 'page-songs.json'), {}), readJson(path.join(cfg.stateDir, 'cache', 'songs.json'), {}),
    ]);
    const pool = new Map([...(cached.known || []), ...(cached.songs || []), ...(page.songs || []), ...songs].filter((song) => song && song.task_id).map((song) => [song.task_id, song]));
    const exact = await buildLocalDownloadIndex({ cfg, root: 'ai音樂', songs: [...pool.values()] });
    const compact = compactLocalIndex(exact);
    const rows = songs.map((song) => {
        const summary = summarizeSong(song);
        const indexed = compact.byTask[song.task_id], raw = exact.byTask[song.task_id];
        const completed = new Set(indexed?.completedKeys || []), group = P.pickStemGroup(song.stems);
        const downloaded = { stems: (group?.tracks || []).filter((track) => completed.has('stem:' + track.id)).length };
        for (const kind of ['mp3', 'wav', 'midi', 'musicxml', 'cover']) downloaded[kind] = completed.has(kind);
        const status = P.downloadStatusForTypes(song, { types: DEFAULT_DOWNLOAD_TYPES, downloaded, unavailable: state.unavailable });
        const uncertainKinds = new Set(indexed?.uncertainKinds || []), known = !!indexed;
        const detail = Array.from(status.detail, (item) => ({ ...item, uncertain: !item.done && !item.na && (!known || uncertainKinds.has(item.type)) }));
        const missingCount = detail.reduce((sum, item) => sum + (!item.done && !item.na && !item.uncertain ? Math.max(0, item.total - item.have) : 0), 0);
        const uncertainCount = detail.reduce((sum, item) => sum + (item.uncertain ? Math.max(0, item.total - item.have) : 0), 0);
        summary.downloaded = { ...status, detail, known, missingCount, uncertainCount, allDone: status.allDone && uncertainCount === 0,
            mp3: downloaded.mp3, wav: downloaded.wav,
            wavVerified: !!downloaded.wav && !!raw?.files.some((file) => file.kind === 'wav' && file.confidence === 'verified' && file.validity === 'valid'),
            unavailable: detail.filter((item) => item.na).map((item) => item.type) };
        return summary;
    });
    const counts = { songs: rows.length, downloaded: 0, partial: 0, undownloaded: 0, midiAvailable: 0 };
    for (const row of rows) {
        if (row.downloaded.allDone) counts.downloaded++;
        else if (row.downloaded.any) counts.partial++;
        else counts.undownloaded++;
        if (row.midi_available) counts.midiAvailable++;
    }
    const snapshot = { schema: 'ace-library-snapshot-v2-exact-task-index', builtAt: new Date().toISOString(), revision: exact.revision, downloadTypes: [...DEFAULT_DOWNLOAD_TYPES], counts, songs: rows };
    await cacheWrite(SNAPSHOT_NAME, snapshot, cfg).catch(() => {});
    return snapshot;
}


export async function getLibrarySnapshot(cfg = config(), { refresh = false, ttlMs = Number(process.env.ACE_SNAPSHOT_TTL_MS || 60000) } = {}) {
    if (!refresh) {
        const peek = await cachePeek(SNAPSHOT_NAME, { ttlMs, cfg });
        if (peek.fresh && peek.data?.schema === 'ace-library-snapshot-v2-exact-task-index' && Array.isArray(peek.data.songs)) return { ...peek.data, cached: true, ageMs: peek.ageMs };
    }
    const built = await buildLibrarySnapshot(cfg, { refresh });
    return { ...built, cached: false, ageMs: 0 };
}


/** 預熱：登入狀態、歌單、檔案索引、曲庫快照一次備好（refresh=false 時全部走快取） */
export async function warmCaches(cfg = config(), { refreshSession = false, refresh = false } = {}) {
    const started = Date.now();
    const timings = {};
    let t = Date.now();
    let session;
    try { session = await sessionStatus(cfg, { force: refreshSession }); } catch (err) { session = { authenticated: false, error: String((err && err.message) || err) }; }
    timings.sessionMs = Date.now() - t;
    t = Date.now();
    const snapshot = await buildLibrarySnapshot(cfg, { refresh });
    timings.snapshotMs = Date.now() - t;
    const result = { ok: true, elapsedMs: Date.now() - started, timings, counts: snapshot.counts, songs: snapshot.songs.length, session };
    await cacheWrite('warm-status', result, cfg).catch(() => {});
    return result;
}

/**
 * 內容去重（歷史遺留自動處理）：全庫依 size→sha256 找完全相同內容，只保留一份。
 * keeper 優先序：成品MP3 > 採樣包 > 歌名資料夾 > _未對應 > 自訂資料夾；同層喜歡無 (n) 的名稱。
 * 被移除的檔案若對應到某個 task，會記錄 alias 到保留 task，避免下次被誤判未下載而重下。
 */
export async function dedupeContent({ root = 'ai音樂', commit = false, includeCustom = false, cfg = config() } = {}) {
    if (commit && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => dedupeContent(...arguments));
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    if (!exists(rootDir)) return { ok: false, total: 0, error: '找不到 ' + rootDir };
    const excludedTop = new Set(['音頻分類', ...(includeCustom ? [] : DEDUPE_CUSTOM_TOP)]);
    const files = walkFiles(rootDir, 6, [], 200000).filter((file) => {
        const rel = path.relative(rootDir, file);
        return !!rel && !excludedTop.has(rel.split(path.sep)[0]);
    });
    const report = { ok: true, root: rootDir, commit, scanned: files.length, groups: [], duplicateFiles: [], aliases: {}, moved: 0, bytesReclaimable: 0, bytesReclaimed: 0, errors: [] };
    const bySize = new Map();
    for (const file of files) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (!stat.size) continue;
        const groupKey = path.extname(file).toLowerCase() + '|' + stat.size;
        if (!bySize.has(groupKey)) bySize.set(groupKey, []);
        bySize.get(groupKey).push({ file, size: stat.size, nlink: stat.nlink });
    }
    const hashCache = new Map();
    const hashOf = (file) => {
        if (!hashCache.has(file)) hashCache.set(file, streamFileHash(file));
        return hashCache.get(file);
    };
    for (const [, list] of bySize) {
        const size = list[0].size;
        if (list.length < 2) continue;
        const byHash = new Map();
        for (const item of list) {
            let hash;
            try { hash = await hashOf(item.file); } catch (err) { report.errors.push({ file: item.file, error: String((err && err.message) || err) }); continue; }
            if (!byHash.has(hash)) byHash.set(hash, []);
            byHash.get(hash).push(item);
        }
        for (const group of byHash.values()) {
            if (group.length < 2) continue;
            const ranked = group
                .map((item) => ({ ...item, rel: path.relative(rootDir, item.file) }))
                .sort((a, b) => compareRank(keeperRank(a.rel), keeperRank(b.rel)));
            const keeper = ranked[0];
            report.groups.push({ size, count: ranked.length, keeper: keeper.rel, members: ranked.map((item) => item.rel) });
            for (const dup of ranked.slice(1)) {
                report.duplicateFiles.push({ file: dup.file, rel: dup.rel, keep: keeper.file, keepRel: keeper.rel, size: dup.size, hardlink: dup.nlink > 1 });
                if (dup.nlink <= 1) report.bytesReclaimable += dup.size;
            }
        }
    }
    // history 路徑 → task_id，用來建立 alias
    const rawState = await readJson(cfg.stateFile, {});
    const pathToTask = new Map();
    for (const [taskId, entry] of Object.entries(rawState.history || {})) {
        for (const item of Object.values((entry && entry.files) || {})) {
            if (!item) continue;
            const raw = String(item.absolute || item.path || '');
            if (!raw) continue;
            const absolute = path.isAbsolute(raw) ? raw : path.join(cfg.downloadDir, toWin(raw));
            pathToTask.set(path.resolve(absolute).toLowerCase(), taskId);
        }
    }
    // 成品 MP3 manifest 記錄 task_id→檔名，用來補齊「同內容不同 task」的 alias
    const mp3Manifest = await readJson(path.join(rootDir, '成品MP3', '_manifest.json'), null);
    const taskByFile = new Map();
    for (const item of (mp3Manifest && Array.isArray(mp3Manifest.items) ? mp3Manifest.items : [])) {
        if (item && item.task_id && item.file) taskByFile.set(String(item.file).toLowerCase(), item.task_id);
    }
    const taskFromPath = (file) => pathToTask.get(file.toLowerCase()) || taskByFile.get(path.basename(file).toLowerCase()) || '';
    const aliases = {};
    for (const dup of report.duplicateFiles) {
        const dupTask = taskFromPath(dup.file);
        const keeperTask = taskFromPath(dup.keep);
        if (dupTask && keeperTask && dupTask !== keeperTask) aliases[dupTask] = keeperTask;
    }
    // 已記錄在 removedPaths 的歷史去重，也一起補 alias（沒有 history 的歌同樣能對到 task）
    for (const [from, to] of Object.entries(rawState.removedPaths || {})) {
        const dupTask = taskFromPath(String(from));
        const keeperTask = taskFromPath(String(to));
        if (dupTask && keeperTask && dupTask !== keeperTask) aliases[dupTask] = keeperTask;
    }
    report.aliases = aliases;
    if (commit) {
        const relocations = [];
        for (const dup of report.duplicateFiles) {
            try {
                const moved = await moveFileSafely(cfg, dup.file, dup.keep, { conflict: 'skip', reason: 'content-dedupe' });
                if (!moved.deduped) throw new Error('去重前內容已變，原件保留');
                relocations.push(moved);
                dup.backup = moved.backup;
                report.moved += 1;
            } catch (err) {
                report.errors.push({ file: dup.file, error: String((err && err.message) || err) });
            }
        }
        await recordRelocations(cfg, relocations);
        if (relocations.length) {
            const latest = await readJson(cfg.stateFile, {});
            const confirmedAliases = {};
            for (const moved of relocations) {
                const fromTask = taskFromPath(moved.from), toTask = taskFromPath(moved.to);
                if (fromTask && toTask && fromTask !== toTask) confirmedAliases[fromTask] = toTask;
            }
            latest.aliases = { ...(latest.aliases || {}), ...confirmedAliases };
            await writeJson(cfg.stateFile, latest);
        }
        clearFsCaches(cfg);
    }
    report.ok = report.errors.length === 0;
    report.groupCount = report.groups.length;
    report.duplicateCount = report.duplicateFiles.length;
    report.hardlinkDuplicates = report.duplicateFiles.filter((item) => item.hardlink).length;
    report.realDuplicateFiles = report.duplicateCount - report.hardlinkDuplicates;
    report.finishedAt = new Date().toISOString();
    return report;
}

/**
 * 歷史遺留清理：移除空的歌名資料夾，並把「在分類庫已有相同內容」的分軌/成品副本搬走。
 * 只依 hash 相同才判定重複，同名不同內容（例如多首同名歌）一律保留。
 * commit=false 只回報，不動檔案。
 */
export async function dedupeFolders({ root = 'ai音樂', commit = false, includeCustom = false, cfg = config() } = {}) {
    if (commit && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => dedupeFolders(...arguments));
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    if (!exists(rootDir)) return { ok: false, total: 0, error: '找不到 ' + rootDir };
    const protectedTop = new Set([...DEDUPE_PROTECTED_TOP, ...(includeCustom ? [] : DEDUPE_CUSTOM_TOP)]);
    const topDirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const report = {
        ok: true,
        root: rootDir,
        commit,
        duplicateFiles: [],
        emptyFolders: [],
        moved: 0,
        bytesReclaimable: 0,
        bytesReclaimed: 0,
        errors: [],
    };
    const categoryFiles = [];
    for (const dir of DEDUPE_CATEGORY_DIRS) {
        const full = path.join(rootDir, dir);
        if (exists(full)) categoryFiles.push(...walkFiles(full, 4, [], 50000));
    }
    const byNameSize = new Map();
    for (const file of categoryFiles) {
        let size;
        try { size = fs.statSync(file).size; } catch { continue; }
        const key = path.basename(file).toLowerCase() + '|' + size;
        if (!byNameSize.has(key)) byNameSize.set(key, []);
        byNameSize.get(key).push(file);
    }
    const hashCache = new Map();
    const hashOf = (file) => {
        if (!hashCache.has(file)) hashCache.set(file, streamFileHash(file));
        return hashCache.get(file);
    };
    const songFiles = [];
    for (const entry of topDirs) {
        if (protectedTop.has(entry.name)) continue;
        songFiles.push(...walkFiles(path.join(rootDir, entry.name), 5, [], 50000));
    }
    for (const file of songFiles) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        const candidates = (byNameSize.get(path.basename(file).toLowerCase() + '|' + stat.size) || []).filter(
            (candidate) => candidate.toLowerCase() !== file.toLowerCase(),
        );
        if (!candidates.length) continue;
        let hash = null;
        try { hash = await hashOf(file); } catch (err) { report.errors.push({ file, error: String(err.message || err) }); continue; }
        let keeper;
        for (const candidate of candidates) {
            try { if (await hashOf(candidate) === hash) { keeper = candidate; break; } } catch { /* Keep unique originals when comparison fails. */ }
        }
        if (!keeper) continue;
        const hardlink = Number(stat.nlink) > 1;
        report.duplicateFiles.push({ file, keep: keeper, size: stat.size, hardlink });
        if (!hardlink) report.bytesReclaimable += stat.size;
    }
    const empties = [];
    const scanEmpty = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
        let empty = true;
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!scanEmpty(path.join(dir, entry.name))) empty = false;
            } else {
                empty = false;
            }
        }
        if (empty) empties.push(dir);
        return empty;
    };
    for (const entry of topDirs) {
        if (protectedTop.has(entry.name)) continue;
        scanEmpty(path.join(rootDir, entry.name));
    }
    report.emptyFolders = empties;
    if (commit) {
        const relocations = [];
        for (const item of report.duplicateFiles) {
            try {
                const moved = await moveFileSafely(cfg, item.file, item.keep, { conflict: 'skip', reason: 'folder-dedupe' });
                if (!moved.deduped) throw new Error('去重前內容已變，原件保留');
                relocations.push(moved);
                item.backup = moved.backup;
                report.moved += 1;
            } catch (err) {
                report.errors.push({ file: item.file, error: String(err.message || err) });
            }
        }
        await recordRelocations(cfg, relocations);
        for (const dir of empties.slice().sort((a, b) => b.length - a.length)) {
            try { fs.rmdirSync(dir); } catch (err) { report.errors.push({ dir, error: String(err.message || err) }); }
        }
        clearFsCaches(cfg);
    }
    report.ok = report.errors.length === 0;
    report.duplicateCount = report.duplicateFiles.length;
    report.emptyFolderCount = report.emptyFolders.length;
    report.finishedAt = new Date().toISOString();
    return report;
}

export async function tidyAll({ root = 'ai音樂', concurrency = 4, onProgress = null, cfg = config() } = {}) {
    if (!hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => tidyAll(...arguments));
    const steps = [];
    const emit = (phase, extra = {}) => {
        if (typeof onProgress === 'function') {
            try {
                onProgress({ phase, steps, ...extra });
            } catch {
                /* ignore */
            }
        }
    };
    const startedAt = new Date().toISOString();
    emit('organize');
    const organizeResult = await organize({ dryRun: false, root, conflict: 'unique', cfg });
    steps.push({
        name: 'organize',
        moved: organizeResult.movedCount || 0,
        deduped: organizeResult.dedupedCount || 0,
        failed: organizeResult.failedCount || 0,
    });
    emit('mp3', { organize: steps[0] });
    let lastMp3 = 0;
    const mp3Result = await extractFullMp3s({
        root,
        concurrency,
        cfg,
        onProgress: (progress) => {
            const now = Date.now();
            if (now - lastMp3 < 700 && progress.done !== progress.total) return;
            lastMp3 = now;
            emit('mp3', { done: progress.done, total: progress.total, current: progress.current || '', organize: steps[0] });
        },
    });
    steps.push({
        name: 'mp3',
        total: mp3Result.total,
        skipped: mp3Result.skipped,
        copied: mp3Result.copied,
        downloaded: mp3Result.downloaded,
        failed: mp3Result.failed.length,
    });
    emit('wav', { mp3: steps[1] });
    const wavResult = await collectFullWavs({
        root,
        cfg,
        onProgress: (progress) => emit('wav', { done: progress.done, total: progress.total, current: progress.current || '', mp3: steps[1] }),
    });
    steps.push({
        name: 'wav',
        total: wavResult.total,
        moved: wavResult.moved,
        skipped: wavResult.skipped,
        duplicates: wavResult.duplicates,
        failed: wavResult.failed.length,
    });
    emit('samples', { mp3: steps[1], wav: steps[2] });
    const samplesResult = await collectSamples({ root, cfg });
    steps.push({ name: 'samples', total: samplesResult.total, copied: samplesResult.copied, skipped: samplesResult.skipped, failed: samplesResult.failed.length });
    emit('classify', { samples: steps[3] });
    const classifyResult = await classifyByAttributes({ root, move: true, cfg });
    steps.push({ name: 'classify', total: classifyResult.total, moved: classifyResult.moved, copied: classifyResult.copied, skipped: classifyResult.skipped, failed: classifyResult.failed.length });
    emit('dedupe', { classify: steps[4] });
    const dedupeResult = await dedupeSongCopies({ root, cfg });
    steps.push({ name: 'dedupe', removed: dedupeResult.removed, savedMB: Math.round(dedupeResult.savedBytes / 1048576), failed: dedupeResult.failed.length });
    emit('content', { dedupe: steps[5] });
    const contentResult = await dedupeContent({ root, commit: true, cfg });
    steps.push({
        name: 'content',
        duplicates: contentResult.duplicateCount || 0,
        moved: contentResult.moved || 0,
        reclaimedMB: Math.round((contentResult.bytesReclaimed || 0) / 1048576),
        aliases: Object.keys(contentResult.aliases || {}).length,
        failed: contentResult.errors.length,
    });
    emit('folders', { content: steps[6] });
    const foldersResult = await dedupeFolders({ root, commit: true, cfg });
    steps.push({
        name: 'folders',
        duplicates: foldersResult.duplicateCount || 0,
        emptyFolders: foldersResult.emptyFolderCount || 0,
        moved: foldersResult.moved || 0,
        reclaimedMB: Math.round((foldersResult.bytesReclaimed || 0) / 1048576),
        failed: foldersResult.errors.length,
    });
    emit('audio', { folders: steps[7] });
    let lastAudio = 0;
    const audioResult = await classifyByAudio({
        root,
        cfg,
        onProgress: (progress) => {
            const now = Date.now();
            if (now - lastAudio < 800 && progress.done !== progress.total) return;
            lastAudio = now;
            emit('audio', { done: progress.done, total: progress.total, current: progress.current || '' });
        },
    });
    steps.push({ name: 'audio', total: audioResult.total, analyzed: audioResult.analyzed, cached: audioResult.cached, linked: audioResult.linked, failed: audioResult.failed.length, unanalyzable: audioResult.unanalyzable ? audioResult.unanalyzable.length : 0 });
    // Relocations are recorded by each safe file operation. Refresh proof paths
    // once after the pipeline, under the same library lease and proof lock.
    emit('index');
    let indexFailed = 0;
    try {
        const { buildLocalDownloadIndex } = await import('./local-index.mjs');
        const index = await buildLocalDownloadIndex({ cfg, root, repairProofs: true });
        indexFailed = index.problems.filter((problem) => /^PROOF_REPAIR_/.test(problem.code)).length;
        steps.push({ name: 'index', revision: index.revision, repairedProofs: index.summary.metadataRepair?.repaired || 0, failed: indexFailed });
    } catch (error) {
        indexFailed = 1;
        steps.push({ name: 'index', failed: 1, error: String(error.message || error).slice(0, 300) });
    }
    clearFsCaches(cfg);
    const result = {
        ok:
            (organizeResult.failedCount || 0) === 0 &&
            mp3Result.failed.length === 0 &&
            wavResult.failed.length === 0 &&
            samplesResult.failed.length === 0 &&
            classifyResult.failed.length === 0 &&
            dedupeResult.failed.length === 0 &&
            contentResult.errors.length === 0 &&
            foldersResult.errors.length === 0 &&
            audioResult.failed.length === 0 && indexFailed === 0,
        root,
        startedAt,
        finishedAt: new Date().toISOString(),
        steps,
    };
    emit('done', { steps, result });
    return result;
}

export async function organize({ dryRun = true, root = 'ai音樂', typeFolders = false, conflict = 'skip', cfg = config() } = {}) {
    if (!dryRun && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => organize(...arguments));
    const session = await loadSession(cfg);
    const songs = await listSongs(cfg);
    const state = await loadState(cfg);
    const byTitle = new Map();
    for (const song of songs) {
        const key = titleKey((song.meta && song.meta.title) || '');
        byTitle.set(key, byTitle.has(key) ? null : song);
    }
    const byTask = new Map(songs.map((s) => [s.task_id, s]));
    const rootAbs = path.join(cfg.downloadDir, root);

    const assignFolder = (song) => {
        if (state.folderByTask[song.task_id]) return state.folderByTask[song.task_id];
        const folder = N.assignFolderName(N.songFolderLabel((song.meta && song.meta.title) || ''), song.task_id, state.ownerByFolder);
        state.folderByTask[song.task_id] = folder;
        state.ownerByFolder[folder.toLowerCase()] = song.task_id;
        return folder;
    };

    const titleLike = (folder, song) => {
        const title = N.songFolderLabel((song.meta && song.meta.title) || '');
        return folder === title || folder.startsWith(title + ' (');
    };

    const titleInFolder = (folder, song) => {
        const title = N.songFolderLabel((song.meta && song.meta.title) || '').toLowerCase();
        return title.length > 2 && folder.toLowerCase().includes(title);
    };

    /**
     * 決定檔案要去的資料夾：
     * - 已在 <root>/<歌名資料夾>/… 內 → 沿用該資料夾與子目錄，只修檔名（不重排使用者版面）
     * - 在 <root>/<包含歌名的資料夾>/…（例如站點 zip 解壓的「xx - stems」）→ 搬進正式歌名資料夾
     * - 在 Downloads 根目錄 → 依歌名指派資料夾搬入
     * - 在其他自訂資料夾（sample、WAI…）→ 不動（回傳 null），避免破壞使用者手動分類
     */
    const planForFile = (song, fullPath) => {
        let relative = null;
        try {
            const rel = path.relative(rootAbs, fullPath);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) relative = rel;
        } catch {
            relative = null;
        }
        if (relative) {
            const segments = relative.split(path.sep).filter(Boolean);
            if (segments.length >= 2 && segments[0]) {
                const folder = segments[0];
                if (titleLike(folder, song)) {
                    const owner = state.ownerByFolder[folder.toLowerCase()];
                    if (owner && owner !== song.task_id) return null;
                    state.folderByTask[song.task_id] = folder;
                    state.ownerByFolder[folder.toLowerCase()] = song.task_id;
                    return { folder, dir: path.dirname(segments.join(path.sep)) };
                }
                if (titleInFolder(folder, song)) {
                    const mapped = state.folderByTask[song.task_id];
                    if (mapped && !titleLike(mapped, song)) return null;
                    return { folder: mapped || assignFolder(song), dir: null };
                }
                return null;
            }
            return { folder: state.folderByTask[song.task_id] || assignFolder(song), dir: null };
        }
        return { folder: state.folderByTask[song.task_id] || assignFolder(song), dir: null };
    };

    const moves = [];
    const unmatched = [];
    const skippedCustom = [];
    const seenFrom = new Set();

    // fileKey: stems / midi / musicxml / mp3 / wav / cover；extra: 分軌標籤或封面副檔名
    const addMove = (from, song, fileKey, extra, reason) => {
        if (!from || seenFrom.has(from)) return;
        const plan = planForFile(song, from);
        if (!plan) {
            skippedCustom.push(from);
            return;
        }
        const names = N.fileNamesFor(plan.folder);
        let filename;
        if (fileKey === 'stems') filename = names.stems(extra);
        else if (fileKey === 'cover') filename = names.cover(extra);
        else filename = names[fileKey]();
        let to;
        if (plan.dir) {
            // plan.dir 是相對於 <root> 的子目錄；沿用它，只改檔名
            to = path.join(cfg.downloadDir, root, plan.dir, filename);
        } else {
            const rel = N.buildRelativePath({
                root,
                folder: plan.folder,
                typeDir: N.TYPE_DIRS[fileKey],
                filename,
                typeFolders,
            });
            to = path.join(cfg.downloadDir, toWin(rel));
        }
        if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return;
        // 同資料夾內已有同名目標 → 不再改名，避免 (2)/(3) 無限循環
        if (path.dirname(from).toLowerCase() === path.dirname(to).toLowerCase() && fs.existsSync(to)) return;
        seenFrom.add(from);
        moves.push({ from, to, reason: reason || '', song: (song.meta && song.meta.title) || plan.folder });
    };

    // (1) 擴充功能匯出的 Chrome 下載紀錄：用 URL 裡的 task_id 對回歌曲
    const history = await readJson(cfg.historyFile, null);
    const records = history && Array.isArray(history.items) ? history.items : [];
    for (const record of records) {
        if (!record || !record.filename || record.state !== 'complete') continue;
        // 只處理還存在的檔案（Chrome 下載紀錄可能指向已被搬走/刪除的舊路徑）
        if (!fs.existsSync(record.filename)) continue;
        const url = record.finalUrl || record.url || '';
        const song = [...byTask.values()].find((s) => url.includes(s.task_id) || (s.local_cover && (s.local_cover === url || url.endsWith(String(s.local_cover).split('?')[0]))));
        if (!song) {
            unmatched.push(record.filename);
            continue;
        }
        if (song.local_cover && (song.local_cover === url || url.endsWith(String(song.local_cover).split('?')[0]))) {
            const extMatch = url.match(/\.(jpe?g|png|webp|gif|avif)(?:\?|$)/i);
            const ext = extMatch ? (extMatch[1].toLowerCase() === 'jpeg' ? '.jpg' : '.' + extMatch[1].toLowerCase()) : '.jpg';
            addMove(record.filename, song, 'cover', ext, 'history:cover');
            continue;
        }
        const cls = classifyUrl(url);
        if (!cls) {
            unmatched.push(record.filename);
            continue;
        }
        addMove(record.filename, song, cls.kind === 'stem' ? 'stems' : cls.kind, cls.kind === 'stem' ? N.stemLabel(cls.stemType) : null, 'history:' + cls.kind);
    }

    // (2) 掃描下載資料夾：已命名但散落各處的檔案（站點下載 / zip 解壓）
    const files = walkFiles(cfg.downloadDir, 3, []);
    const stemLabelSet = new Set(STEM_LABELS);
    const stemLabelLookup = new Map(Object.values(N.STEM_TYPE_NAMES).map((v) => [String(v).toLowerCase(), v]));
    for (const full of files) {
        if (seenFrom.has(full)) continue;
        const base = path.basename(full);
        const lower = base.toLowerCase();
        let handled = false;
        const stripCopySuffix = (value) => String(value).replace(/\s*\(\d+\)\s*$/, '');
        let m = base.match(/^(.+?) - ([^.]+?)\.mp3$/i);
        if (m && stemLabelSet.has(m[2].trim().toLowerCase())) {
            const song = byTitle.get(titleKey(stripCopySuffix(m[1])));
            if (song) {
                const rawLabel = m[2].trim().toLowerCase();
                addMove(full, song, 'stems', stemLabelLookup.get(rawLabel) || N.stemLabel(rawLabel), 'scan:stem');
                handled = true;
            }
        }
        if (!handled) {
            const coverMatch = base.match(/^(.+?) - Cover\.(jpe?g|png|webp|gif|avif)$/i);
            if (coverMatch) {
                const song = byTitle.get(titleKey(stripCopySuffix(coverMatch[1])));
                if (song) {
                    const ext = coverMatch[2].toLowerCase() === 'jpeg' ? '.jpg' : '.' + coverMatch[2].toLowerCase();
                    addMove(full, song, 'cover', ext, 'scan:cover');
                    handled = true;
                }
            }
        }
        if (!handled) {
            const ext = path.extname(base).toLowerCase();
            const titlePart = base.slice(0, base.length - ext.length);
            const song = byTitle.get(titleKey(stripCopySuffix(titlePart)));
            if (song) {
                if (ext === '.mid' || ext === '.midi') { addMove(full, song, 'midi', null, 'scan:midi'); handled = true; }
                else if (ext === '.musicxml') { addMove(full, song, 'musicxml', null, 'scan:musicxml'); handled = true; }
                else if (ext === '.mp3') { addMove(full, song, 'mp3', null, 'scan:mp3'); handled = true; }
                else if (ext === '.wav') { addMove(full, song, 'wav', null, 'scan:wav'); handled = true; }
            }
        }
        if (!handled && /^[0-9a-f]{20,}\.(mp3|wav|mid|musicxml)$/i.test(base)) unmatched.push(full);
    }

    // (3) 歌名資料夾內的舊命名：<folder>.mid / <folder>.musicxml → <folder> - MIDI.mid / - MusicXML.musicxml
    const TYPE_DIR_NAMES = new Set(['Audio', 'MIDI', 'Stems']);
    const pushDirect = (from, to) => {
        if (seenFrom.has(from)) return;
        if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return;
        // 同資料夾內已有同名目標 → 不再改名，避免 (2)/(3) 無限循環
        if (path.dirname(from).toLowerCase() === path.dirname(to).toLowerCase() && fs.existsSync(to)) return;
        if (!fs.existsSync(from)) return;
        seenFrom.add(from);
        moves.push({ from, to, reason: 'canonicalize', song: path.basename(path.dirname(from)) });
    };
    for (const full of files) {
        const rel = path.relative(rootAbs, full).split(path.sep).filter(Boolean);
        if (rel.length < 2 || rel.length > 3) continue;
        if (rel.length === 3 && !TYPE_DIR_NAMES.has(rel[1])) continue;
        const folder = rel[0];
        const base = path.basename(full);
        const ext = path.extname(base).toLowerCase();
        const titlePart = base.slice(0, base.length - ext.length);
        if (titlePart !== folder) continue;
        let filename = null;
        if (ext === '.mid' || ext === '.midi') filename = folder + ' - MIDI.mid';
        else if (ext === '.musicxml') filename = folder + ' - MusicXML.musicxml';
        else if (ext === '.wav') filename = folder + '.wav';
        if (!filename) continue;
        pushDirect(full, path.join(path.dirname(full), filename));
    }

    const result = {
        ok: true,
        dryRun,
        movesFound: moves.length,
        unmatchedCount: unmatched.length,
        skippedCustomCount: skippedCustom.length,
        moves,
    };
    if (dryRun || !moves.length) {
        result.moves = moves;
        return result;
    }

    let movedCount = 0;
    let dedupedCount = 0;
    let conflictCount = 0;
    const conflicts = [];
    const failed = [];
    const relocations = [];
    for (const move of moves) {
        try {
            const actual = await moveFileSafely(cfg, move.from, move.to, { conflict, reason: 'organize' });
            if (actual.skipped) { conflictCount += 1; conflicts.push({ from: move.from, to: move.to }); continue; }
            relocations.push(actual);
            if (actual.deduped) dedupedCount += 1;
            if (actual.moved) movedCount += 1;
        } catch (err) {
            failed.push({ from: move.from, error: String((err && err.message) || err) });
        }
    }
    await recordRelocations(cfg, relocations);
    await saveState(cfg, null, state);
    clearFsCaches(cfg);
    return {
        ok: failed.length === 0,
        dryRun: false,
        movesFound: moves.length,
        movedCount,
        dedupedCount,
        conflictCount,
        conflicts,
        failedCount: failed.length,
        failed,
        unmatchedCount: unmatched.length,
        skippedCustomCount: skippedCustom.length,
    };
}

export { FILE_TYPES, config, cacheRead, cacheWrite, cacheClear };









