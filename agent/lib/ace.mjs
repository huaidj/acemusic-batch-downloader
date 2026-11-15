// ace.mjs — ACE Music API 客戶端 + 批次下載 + 檔案整理（給 CLI / MCP / Skill 共用）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config, readJson, writeJson, exists, toWin, sleep, appendLog, cacheRead, cacheWrite, cacheClear, cachePeek } from './config.mjs';
import { loadShared } from './shared.mjs';

const { N, P } = loadShared();
const SNAPSHOT_NAME = 'library-snapshot';
function clearFsCaches(cfg) { cacheClear('fs-index', cfg); cacheClear(SNAPSHOT_NAME, cfg); }
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
    const target = absolutize(cfg, url);
    const headers = Object.assign(
        {
            'User-Agent': session.ua || cfg.ua,
            Accept: '*/*',
            Referer: cfg.baseUrl + '/create/',
        },
        session.cookie ? { Cookie: session.cookie } : {},
        options.headers || {},
    );
    return fetch(target, { ...options, headers, redirect: 'follow' });
}

/* ------------------------------------------------------------------ *
 * 歌單 / MIDI / 音檔 URL
 * ------------------------------------------------------------------ */
export async function listSongs(cfg = config(), { pageLimit = 50, maxPages = 40, refresh = false, includeKnown = false } = {}) {
    const SONGS_TTL_MS = 10 * 60 * 1000;
    const cached = await cacheRead('songs', { maxAgeMs: SONGS_TTL_MS, cfg });
    if (!refresh && cached && Array.isArray(cached.songs) && cached.songs.length) {
        return includeKnown && Array.isArray(cached.known) ? cached.known : cached.songs;
    }
    const session = await loadSession(cfg);
    const songs = [];
    let after = '';
    for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams({ limit: String(pageLimit), sort: 'new' });
        if (after) params.set('after', after);
        const res = await aceFetch(cfg, session, '/api/songs?' + params.toString(), {
            headers: { Accept: 'application/json' },
        });
        if (res.status === 401 || res.status === 403) {
            const err = new Error('登入已過期（HTTP ' + res.status + '），請回擴充功能面板按「同步登入狀態給 Agent」重新匯出。');
            err.code = 'AUTH_EXPIRED';
            throw err;
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
    for (const song of (cached && Array.isArray(cached.known) ? cached.known : [])) {
        if (song && song.task_id) oldKnown.set(song.task_id, song);
    }
    for (const song of fresh) oldKnown.set(song.task_id, song);
    const known = [...oldKnown.values()];
    await cacheWrite('songs', { songs: fresh, known, fetchedAt: new Date().toISOString() }, cfg);
    return includeKnown ? known : fresh;
}

export function summarizeSong(song, index) {
    const group = P.pickStemGroup(song.stems);
    const summary = {
        task_id: song.task_id,
        title: (song.meta && song.meta.title) || 'Untitled',
        capability: song.capability || '',
        duration_sec: (song.result && (song.result.duration_sec || song.result.duration)) || null,
        stems: group ? { mode: group.mode, count: group.tracks.length, types: group.tracks.map((t) => t.type) } : null,
        midi_available: P.midiAvailable(song),
        cover: !!song.local_cover,
        local_audio: !!song.local_audio,
    };
    if (index) summary.downloaded = songDownloadSummary(song, index);
    return summary;
}

const escRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 掃描下載資料夾，回傳 { rel:Set<相對路徑小寫>, names:Set<檔名小寫> } */
export async function collectDownloadIndex(cfg = config(), { refresh = false } = {}) {
    const ttlMs = Number(process.env.ACE_FS_INDEX_TTL_MS || 180000);
    if (!refresh) {
        const cached = await cacheRead('fs-index', { maxAgeMs: ttlMs, cfg });
        if (cached && Array.isArray(cached.files)) {
            return {
                rel: new Set(cached.rel || []),
                names: new Set(cached.names || []),
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
    return { rel, names, at: Date.now() };
}

/** 每首歌已下載進度（依檔名比對，含 CLI/擴充功能/站點下載的檔案） */
export function songDownloadSummary(song, index) {
    const title = N.songFolderLabel((song.meta && song.meta.title) || '');
    const group = P.pickStemGroup(song.stems);
    const labels = new Map();
    if (group) {
        for (const track of group.tracks) labels.set(N.stemLabel(track.type).toLowerCase(), N.stemLabel(track.type));
    }
    const stems = new Set();
    let midi = false;
    let musicxml = false;
    let mp3 = false;
    let cover = false;
    if (index && index.names) {
        const re = new RegExp('^' + escRe(title) + '(?: \\(\\d+\\))?(?: - (.+))?\\.([a-z0-9]+)$', 'i');
        for (const name of index.names) {
            const match = re.exec(name);
            if (!match) continue;
            const suffix = match[1] ? match[1].trim().toLowerCase() : '';
            const ext = match[2].toLowerCase();
            if (suffix === 'cover') cover = true;
            else if (suffix === 'midi') midi = true;
            else if (suffix === 'musicxml') musicxml = true;
            else if (!suffix) {
                if (ext === 'mp3') mp3 = true;
                else if (ext === 'mid' || ext === 'midi') midi = true;
                else if (ext === 'musicxml') musicxml = true;
            } else if (labels.has(suffix)) stems.add(labels.get(suffix));
        }
    }
    const stemsTotal = group ? group.tracks.length : 0;
    const stemsHave = stemsTotal ? Math.min(stemsTotal, stems.size) : 0;
    const detail = [];
    if (stemsTotal) detail.push({ type: 'stems', label: '分軌', have: stemsHave, total: stemsTotal, done: stemsHave >= stemsTotal });
    if (P.midiAvailable(song)) detail.push({ type: 'midi', label: 'MIDI', have: midi ? 1 : 0, total: 1, done: midi });
    if (P.midiAvailable(song)) detail.push({ type: 'musicxml', label: 'MusicXML', have: musicxml ? 1 : 0, total: 1, done: musicxml });
    if (song.local_cover) detail.push({ type: 'cover', label: '封面', have: cover ? 1 : 0, total: 1, done: cover });
    const have = detail.reduce((sum, item) => sum + item.have, 0);
    const total = detail.reduce((sum, item) => sum + item.total, 0);
    return { have, total, allDone: total > 0 && have >= total, any: have > 0, mp3, detail };
}

async function createApiFile(cfg, session, songId, kind) {
    const endpoint = `/api/songs/${encodeURIComponent(songId)}/download`;
    const deadline = Date.now() + 180000;
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
    if (!res.ok || !data || !data.url) {
        const detail = (data && (data.error || data.message)) || `HTTP ${res.status}`;
        throw new Error('無法取得 ' + kind + '：' + detail);
    }
    return absolutize(cfg, data.url);
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
        if (kind === 'wav' && res.status === 404) { const err = new Error('此歌曲的模型不提供 WAV（站點 404）'); err.code = 'WAV_UNSUPPORTED'; throw err; }
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
    if (!res.ok) throw new Error('HTTP ' + res.status + '：' + String(url).slice(-80));
    const contentType = String(res.headers.get('content-type') || '');
    if (/json|html/i.test(contentType)) {
        const body = (await res.text()).slice(0, 300);
        throw new Error('伺服器回傳非檔案內容（' + contentType + '）：' + body);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('檔案為空');
    const tmp = target + '.part';
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, target);
    return { target, bytes: buffer.length };
}

export async function loadState(cfg = config()) {
    const raw = await readJson(cfg.stateFile, {});
    return {
        folderByTask: raw.folderByTask || {},
        ownerByFolder: raw.ownerByFolder || {},
        history: raw.history || {},
        aliases: raw.aliases || {},
        removedPaths: raw.removedPaths || {},
    };
}

async function saveState(cfg, buildPlanResult, state) {
    await writeJson(cfg.stateFile, {
        folderByTask: buildPlanResult ? buildPlanResult.folderByTask : state.folderByTask,
        ownerByFolder: buildPlanResult ? buildPlanResult.ownerByFolder : state.ownerByFolder,
        history: state.history,
        aliases: state.aliases || {},
        removedPaths: state.removedPaths || {},
    });
}

export async function buildPlanForSongs(cfg = config(), songs, options = {}) {
    const state = await loadState(cfg);
    const plan = P.buildDownloadPlan({
        songs,
        options: {
            types: options.types || ['stems', 'midi'],
            root: options.root || 'ai音樂',
            typeFolders: !!options.typeFolders,
            force: !!options.force,
            origin: cfg.baseUrl,
        },
        state,
        origin: cfg.baseUrl,
    });
    return { plan, state };
}

/** 以本機檔案／去重紀錄／alias 套用跳過（給 runDownload 與 dry-run 共用） */
export async function applyLocalSkips(cfg = config(), plan, state = {}) {
    const index = await collectDownloadIndex(cfg);
    const aliases = state.aliases || {};
    const removedPaths = state.removedPaths || {};
    let skipped = 0;
    for (const task of plan.tasks) {
        const aliased = !!aliases[task.task_id];
        for (const file of task.files) {
            if (file.skip) continue;
            let found = aliased;
            if (!found) {
                const rel = String(file.path).toLowerCase();
                if (index.rel.has(rel)) {
                    found = true;
                } else {
                    const keeper = removedPaths[rel];
                    if (keeper) {
                        const keeperRel = path.relative(cfg.downloadDir, keeper).split(path.sep).join('/').toLowerCase();
                        found = index.rel.has(keeperRel);
                    }
                }
                // 名稱後備：分類庫（成品MP3／採樣包／…）已有同名檔
                if (!found) found = index.names.has(path.basename(String(file.path)).toLowerCase());
            }
            if (found) {
                file.skip = true;
                skipped += 1;
            }
        }
    }
    if (skipped) {
        plan.skipped += skipped;
        plan.toDownload = Math.max(0, plan.toDownload - skipped);
    }
    return skipped;
}

export async function runDownload({ songs, options = {}, concurrency = 4, onProgress = null, isCancelled = null, cfg = config() }) {
    const session = await loadSession(cfg);
    const { plan, state } = await buildPlanForSongs(cfg, songs, options);
    await saveState(cfg, plan, state);

    // 以實際檔案存在／去重紀錄／alias 再跳過一次（之前由擴充功能/CLI/站點下載過的檔案）
    if (!options.force) {
        await applyLocalSkips(cfg, plan, state);
    }

    if (!plan.toDownload) {
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
                entry.url =
                    entry.file.source === 'api'
                        ? await createApiFile(cfg, session, entry.task.task_id, entry.file.apiKind)
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
                if (onProgress) onProgress({ done, skipped, failed, total, current: file.path, bytes });
                await saveState(cfg, plan, state);
            } catch (err) {
                if (err && err.code === 'WAV_UNSUPPORTED') {
                    skipped += 1;
                    if (onProgress) onProgress({ done, skipped, failed, total, current: file.path, bytes, skippedReason: err.message });
                    continue;
                }
                failed += 1;
                failedList.push({ name: `${task.folder}/${file.filename}`, error: String((err && err.message) || err) });
                if (onProgress) onProgress({ done, skipped, failed, total, current: file.path, bytes });
            }
        }
    };

    await Promise.all(Array.from({ length: workers }, () => worker()));
    await prepPromise;

    skipped += plan.skipped;
    await saveState(cfg, plan, state);
    clearFsCaches(cfg); // 下載後讓 list/overview 立即看到新檔案
    return { ok: failed === 0, total: plan.total, done, skipped, failed, bytes, failedList, elapsedMs: Date.now() - startedAt };
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
    const session = await loadSession(cfg);
    const all = songs || (await listSongs(cfg));
    const list = all.filter((song) => song && song.task_id && P.isDone(song));
    const orderedAll = [...list].sort(
        (a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || songTitleFile(a).localeCompare(songTitleFile(b)),
    );
    const ordered = Number(limit) > 0 ? orderedAll.slice(0, Number(limit)) : orderedAll;
    const state = await loadState(cfg).catch(() => ({ folderByTask: {} }));
    const outDir = path.join(cfg.downloadDir, toWin(root), folder);
    await fsp.mkdir(outDir, { recursive: true });

    const used = new Map();
    const items = ordered.map((song) => {
        const base = songTitleFile(song);
        const key = base.toLowerCase();
        const count = (used.get(key) || 0) + 1;
        used.set(key, count);
        return { song, title: songTitleText(song), filename: count === 1 ? `${base}.mp3` : `${base} (${count}).mp3` };
    });

    const files = walkFiles(cfg.downloadDir, 3, [], 20000);
    const outDirLower = outDir.toLowerCase();
    const libraryFiles = files.filter((full) => {
        const fullLower = full.toLowerCase();
        return !fullLower.startsWith(outDirLower) && !fullLower.includes('\\_未對應\\') && /\.mp3$/i.test(full);
    });

    const findExisting = (song, title) => {
        const labels = new Set([N.sanitizeComponent(title, 80).toLowerCase()]);
        const stateLabel = state.folderByTask && state.folderByTask[song.task_id];
        if (stateLabel) labels.add(N.sanitizeComponent(String(stateLabel), 100).toLowerCase());
        for (const full of libraryFiles) {
            const base = path.basename(full).toLowerCase();
            if (base.includes(' - ')) continue;
            const stem = base.replace(/\.mp3$/, '');
            for (const label of labels) {
                if (!label) continue;
                if (stem === label) return full;
                if (new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(\\d+\\)$').test(stem)) return full;
            }
        }
        return null;
    };

    const report = {
        ok: true,
        folder: outDir,
        total: items.length,
        skipped: 0,
        copied: 0,
        downloaded: 0,
        failed: [],
        bytes: 0,
        startedAt: new Date().toISOString(),
    };
    const manifestPath = path.join(outDir, '_manifest.json');
    const previous = await readJson(manifestPath).catch(() => null);
    const manifest = new Map();
    for (const entry of (previous && Array.isArray(previous.items) ? previous.items : [])) {
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
            // 內容去重／alias 跳過：目標已被去重搬走且 keeper 還在 → 不要再下載一次
            const targetKey = target.toLowerCase();
            const keeperPath = state.removedPaths && state.removedPaths[targetKey];
            const aliased = state.aliases && state.aliases[item.song.task_id];
            if (!force && !exists(target) && ((keeperPath && exists(keeperPath)) || aliased)) {
                report.skipped += 1;
                report.deduped = (report.deduped || 0) + 1;
                done += 1;
                emit(item.title);
                continue;
            }
            let mode = '';
            let source = '';
            try {
                if (!force && exists(target) && fs.statSync(target).size > 0) {
                    report.skipped += 1;
                    mode = 'skipped';
                } else {
                    const found = force ? null : findExisting(item.song, item.title);
                    if (found) {
                        await fsp.copyFile(found, temp);
                        await fsp.rename(temp, target);
                        source = found;
                        mode = 'copied';
                        report.copied += 1;
                    } else {
                        const url = await resolveFullAudioUrl(cfg, session, item.song);
                        const res = await aceFetch(cfg, session, url, { headers: { Accept: '*/*' } });
                        if (!res.ok) throw new Error('HTTP ' + res.status + '：' + String(url).slice(-70));
                        const contentType = String(res.headers.get('content-type') || '');
                        if (/json|html/i.test(contentType)) throw new Error('伺服器回傳非音檔內容（' + contentType + '）');
                        const buffer = Buffer.from(await res.arrayBuffer());
                        if (!buffer.length) throw new Error('檔案為空');
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
 * 把各歌曲資料夾內的「分軌/採樣」音檔集中到 <root>/<folder>/，檔名保留 <歌名> - <分軌>.mp3
 * 只複製、不搬動原始檔案；已存在的跳過。
 */
export async function collectSamples({ root = 'ai音樂', folder = '採樣包', cfg = config() } = {}) {
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const outDir = path.join(rootDir, folder);
    await fsp.mkdir(outDir, { recursive: true });
    const stemLabelLookup = new Map(Object.values(N.STEM_TYPE_NAMES).map((value) => [String(value).toLowerCase(), String(value)]));
    const typeFolderFor = (base) => {
        const stem = base.replace(/\.[^.]+$/, '');
        const parts = stem.split(' - ');
        const rawLabel = parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
        const canonical = stemLabelLookup.get(rawLabel.toLowerCase()) || (rawLabel ? N.stemLabel(rawLabel) : 'Other');
        const safe = N.sanitizeComponent(canonical || 'Other', 40) || 'Other';
        return /^(vocals|drums|bass|guitar|keys|synth|strings|fx|backing vocals|other|piano|percussion|melody)$/i.test(safe)
            ? safe
            : 'Other';
    };
    // 舊版平面採樣夾（採樣/）→ 自動搬到 採樣包/<類型>/
    const legacyDir = path.join(rootDir, '採樣');
    const migrated = [];
    if (folder !== '採樣' && exists(legacyDir)) {
        for (const full of walkFiles(legacyDir, 2, [], 30000)) {
            if (!/\.(mp3|wav|flac|aiff?)$/i.test(full)) continue;
            const base = path.basename(full);
            if (!/ - /i.test(base)) continue;
            const typeDir = path.join(outDir, typeFolderFor(base));
            await fsp.mkdir(typeDir, { recursive: true });
            const target = path.join(typeDir, base);
            try {
                if (!exists(target)) {
                    await fsp.copyFile(full, target + '.part');
                    await fsp.rename(target + '.part', target);
                    migrated.push(base);
                }
            } catch {
                /* ignore */
            }
        }
    }
    const excludeTop = new Set([folder, '採樣', '_成品MP3', '_未對應', 'sample', 'WAI', 'WAMI', '俱樂部版', '舊版對照', '成品MP3', 'MIDI', 'MusicXML', '封面', '壓縮檔', '其他', '音頻分類']);
    const files = walkFiles(rootDir, 3, [], 30000);
    const report = { ok: true, folder: outDir, total: 0, copied: 0, skipped: 0, migrated: migrated.length, failed: [], bytes: 0 };
    const manifestPath = path.join(outDir, '_manifest.json');
    const previous = await readJson(manifestPath).catch(() => null);
    const manifest = new Map();
    for (const entry of (previous && Array.isArray(previous.items) ? previous.items : [])) {
        if (entry && entry.file) manifest.set(String(entry.file), entry);
    }
    const pending = [];
    const seen = new Set();
    for (const full of files) {
        if (!/\.(mp3|wav|flac|aiff?)$/i.test(full)) continue;
        const rel = path.relative(rootDir, full).split(path.sep).filter(Boolean);
        if (rel.length < 2) continue;
        if (excludeTop.has(rel[0])) continue;
        const base = path.basename(full);
        if (!/ - /i.test(base)) continue; // 只要分軌/採樣，不要完整成品
        const dirParts = rel.slice(1, -1);
        if (dirParts.some((part) => /^(MIDI|Audio)$/i.test(part))) continue;
        const typeDir = path.join(outDir, typeFolderFor(base));
        const target = path.join(typeDir, base);
        const key = base.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push({ from: full, to: target, song: rel[0], file: base, type: path.basename(typeDir) });
    }
    report.total = pending.length;
    for (const item of pending) {
        try {
            if (exists(item.to) && fs.statSync(item.to).size > 0) {
                report.skipped += 1;
                continue;
            }
            await fsp.mkdir(path.dirname(item.to), { recursive: true });
            const temp = item.to + '.part';
            await fsp.copyFile(item.from, temp);
            await fsp.rename(temp, item.to);
            const size = fs.statSync(item.to).size;
            report.copied += 1;
            report.bytes += size;
            manifest.set(item.type + '/' + item.file, {
                file: item.file,
                type: item.type,
                song: item.song,
                source: item.from,
                size,
                at: new Date().toISOString(),
            });
        } catch (err) {
            report.failed.push({ file: item.file, source: item.from, error: String((err && err.message) || err) });
        }
    }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, {
        schema: 'ace_samples_manifest_v1',
        generatedAt: report.finishedAt,
        root,
        folder,
        total: report.total,
        items: [...manifest.values()],
    });
    // 舊平面採樣夾若已清空就移除
    if (folder !== '採樣' && exists(legacyDir)) {
        try {
            const left = fs.readdirSync(legacyDir).filter((name) => !/^_manifest\.json$/i.test(name));
            if (!left.length) fs.rmdirSync(legacyDir);
        } catch {
            /* ignore */
        }
    }
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
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const CATEGORY = {
        mid: 'MIDI',
        midi: 'MIDI',
        musicxml: 'MusicXML',
        jpg: '封面',
        jpeg: '封面',
        png: '封面',
        webp: '封面',
        gif: '封面',
        avif: '封面',
        zip: '壓縮檔',
        rar: '壓縮檔',
        '7z': '壓縮檔',
        asd: '其他',
        als: '其他',
        amxd: '其他',
        pdf: '其他',
    };
    const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aiff', 'aif', 'ogg', 'm4a']);
    const EXCLUDE_TOP = new Set([...Object.values(CATEGORY), '成品MP3', '採樣包', '採樣', '_未對應', 'sample', 'WAI', '俱樂部版']);
    const files = walkFiles(rootDir, 3, [], 30000);
    const byCategory = new Map();
    for (const full of files) {
        const ext = path.extname(full).toLowerCase().replace(/^\./, '');
        if (!ext || AUDIO_EXT.has(ext)) continue;
        const category = CATEGORY[ext];
        if (!category) continue;
        const rel = path.relative(rootDir, full).split(path.sep).filter(Boolean);
        if (rel.length < 2) continue;
        if (EXCLUDE_TOP.has(rel[0])) continue;
        const songFolder = rel[0];
        const base = path.basename(full);
        let targetName = base;
        if ((ext === 'mid' || ext === 'midi') && !/ - /i.test(base)) targetName = `${songFolder} - MIDI.mid`;
        else if (ext === 'musicxml' && !/ - /i.test(base)) targetName = `${songFolder} - MusicXML.musicxml`;
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push({ from: full, to: path.join(rootDir, category, targetName), name: targetName });
    }
    const report = { ok: true, categories: {}, total: 0, copied: 0, moved: 0, skipped: 0, failed: [] };
    for (const [category, items] of byCategory) {
        const outDir = path.join(rootDir, category);
        await fsp.mkdir(outDir, { recursive: true });
        const manifestPath = path.join(outDir, '_manifest.json');
        const previous = await readJson(manifestPath).catch(() => null);
        const manifest = new Map();
        for (const entry of previous && Array.isArray(previous.items) ? previous.items : []) {
            if (entry && entry.file) manifest.set(String(entry.file), entry);
        }
        for (const item of items) {
            try {
                if (exists(item.to)) {
                    // 同名但內容不同（例如兩首同名歌的 MusicXML）→ 用唯一檔名分類，不要留在歌名資料夾
                    let same = false;
                    try {
                        same = fs.readFileSync(item.from).equals(fs.readFileSync(item.to));
                    } catch {
                        same = false;
                    }
                    if (same) {
                        report.skipped += 1;
                        continue;
                    }
                    item.to = uniquePath(item.to);
                    item.name = path.basename(item.to);
                }
                if (move) {
                    await fsp.rename(item.from, item.to);
                    report.moved += 1;
                } else {
                    await fsp.copyFile(item.from, item.to + '.part');
                    await fsp.rename(item.to + '.part', item.to);
                    report.copied += 1;
                }
                const size = fs.statSync(item.to).size;
                manifest.set(item.name, { file: item.name, source: item.from, size, at: new Date().toISOString() });
                report.categories[category] = (report.categories[category] || 0) + 1;
                report.total += 1;
            } catch (err) {
                report.failed.push({ file: item.name, error: String((err && err.message) || err) });
            }
        }
        await writeJson(manifestPath, {
            schema: 'ace_file_category_v1',
            category,
            generatedAt: new Date().toISOString(),
            items: [...manifest.values()],
        });
    }
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
export async function classifyByAudio({ root = 'ai音樂', folder = '音頻分類', linkMode = 'hardlink', limit = 0, refresh = false, onProgress = null, cfg = config() } = {}) {
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
    const analyses = [];
    const todo = [];
    for (const file of selected) {
        const stat = fs.statSync(file);
        const key = path.resolve(file);
        const cached = cacheItems[key];
        // JSON 讀回後 mtime 可能是字串，統一換算成毫秒再比對，否則快取永遠不會命中
        const cachedMtime = cached ? (typeof cached.mtime === 'number' ? cached.mtime : Date.parse(cached.mtime)) : NaN;
        const sameTime = Number.isFinite(cachedMtime) && Math.abs(cachedMtime - stat.mtimeMs) < 1.5;
        // 只有「成功」的分析結果可以重用；失敗紀錄一旦重用，暫時性錯誤會永遠卡在失敗
        if (!refresh && cached && cached.ok === true && cached.size === stat.size && sameTime) {
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
                duration: hit.duration ?? null,
                bpm: hit.bpm ?? null,
                key: hit.key ?? null,
                camelot: hit.camelot ?? null,
                energy: hit.energy ?? null,
                analyzedAt: new Date().toISOString(),
            };
            if (!record.ok) record.error = String(hit.error || 'analysis failed').slice(0, 300);
            analyses.push(record);
            cacheItems[item.file] = record;
            // 單檔分析失敗 = 檔案本身無法分析（略過但不讓整輪整理變失敗）；批次/啟動失敗才算管線失敗
            if (!record.ok) report.unanalyzable.push({ file: item.file, error: record.error });
            done += 1;
            if (typeof onProgress === 'function') {
                try { onProgress({ done, total: todo.length, current: path.basename(item.file) }); } catch { /* ignore */ }
            }
        }
        await cacheWrite('audio-analysis', { items: cacheItems, thresholds: cache.thresholds }, cfg).catch(() => {});
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
        await cacheWrite('audio-analysis', { items: cacheItems, thresholds: cache.thresholds }, cfg).catch(() => {});
    }
    report.thresholds = cache.thresholds;
    const low = cache.thresholds.low;
    const high = cache.thresholds.high;
    const sanitize = (value) => N.sanitizeComponent(String(value || ''), 80) || 'Unknown';
    const bucketBpm = (bpm) => (bpm == null ? 'Unknown' : String(Math.max(0, Math.floor(bpm / 5) * 5)) + '-' + String(Math.max(5, Math.floor(bpm / 5) * 5 + 5)));
    const tierEnergy = (energy) => (energy == null ? 'Unknown' : energy < low ? 'Low' : energy < high ? 'Mid' : 'High');
    const stemTypeOf = (base) => {
        const stem = base.replace(/\.[^.]+$/, '');
        const parts = stem.split(' - ');
        const raw = (parts.length > 1 ? parts.slice(1).join(' - ') : '').trim().toLowerCase();
        if (!raw) return '';
        const lookup = new Map(Object.values(N.STEM_TYPE_NAMES).map((value) => [String(value).toLowerCase(), String(value)]));
        return lookup.get(raw) || N.stemLabel(raw) || '';
    };
    const manifest = [];
    const linkFile = async (source, target) => {
        if (exists(target)) { report.skipped += 1; return; }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        if (linkMode === 'copy') {
            await fsp.copyFile(source, target);
        } else {
            try {
                await fsp.link(source, target);
            } catch {
                await fsp.copyFile(source, target);
            }
        }
        report.linked += 1;
    };
    for (const record of analyses) {
        if (!record.ok) continue;
        const base = path.basename(record.file);
        const item = { ...record, links: [] };
        const isStem = / - /.test(base) || record.file.includes('\\採樣包\\') || record.file.includes('/採樣包/');
        const isUnknown = record.file.includes('_未對應');
        const kind = isUnknown ? '其他音檔' : isStem ? '分軌' : '完整歌曲';
        const stemType = isStem ? sanitize(stemTypeOf(base) || 'Other') : '';
        const axes = [
            ['BPM', bucketBpm(record.bpm)],
            ['Key', sanitize(record.camelot || (record.key ? record.key.replace(':', ' ') : 'Unknown'))],
            ['Energy', tierEnergy(record.energy)],
        ];
        for (const [axis, bucket] of axes) {
            const target = path.join(outDir, kind, axis, sanitize(bucket), base);
            await linkFile(record.file, target);
            item.links.push(path.relative(outDir, target).split(path.sep).join('/'));
        }
        if (stemType) {
            const target = path.join(outDir, '分軌', '類型', stemType, base);
            await linkFile(record.file, target);
            item.links.push(path.relative(outDir, target).split(path.sep).join('/'));
        }
        manifest.push(item);
    }
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
 * 只刪同名/同大小（或同名去掉 (n) 後同大小）的副本，不碰沒有分類副本的檔案。
 */
export async function dedupeSongCopies({ root = 'ai音樂', cfg = config() } = {}) {
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const CATEGORY_DIRS = ['成品MP3', '採樣包', 'MIDI', 'MusicXML', '封面', '壓縮檔', '其他'];
    const normalize = (name) => name.replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)\s*$/, '').toLowerCase();
    const index = new Map(); // key: normExt|size -> categoryPath
    for (const dir of CATEGORY_DIRS) {
        const full = path.join(rootDir, dir);
        if (!exists(full)) continue;
        for (const file of walkFiles(full, 3, [], 30000)) {
            try {
                const stat = fs.statSync(file);
                index.set(normalize(path.basename(file)) + '|' + stat.size, file);
            } catch { /* ignore */ }
        }
    }
    const report = { ok: true, removed: 0, savedBytes: 0, failed: [], scanned: 0 };
    const skipTop = new Set([...CATEGORY_DIRS, '_未對應', 'sample', 'WAI', '俱樂部版']);
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || skipTop.has(entry.name)) continue;
        const songDir = path.join(rootDir, entry.name);
        for (const file of walkFiles(songDir, 2, [], 20000)) {
            report.scanned += 1;
            try {
                const stat = fs.statSync(file);
                const key = normalize(path.basename(file)) + '|' + stat.size;
                if (!index.has(key)) continue;
                fs.unlinkSync(file);
                report.removed += 1;
                report.savedBytes += stat.size;
            } catch (err) {
                report.failed.push({ file, error: String((err && err.message) || err) });
            }
        }
    }
    report.ok = report.failed.length === 0;
    clearFsCaches(cfg);
    return report;
}

const DEDUPE_CATEGORY_DIRS = ['成品MP3', '採樣包', 'MIDI', 'MusicXML', '封面', '壓縮檔', '其他', '音頻分類'];
const DEDUPE_PROTECTED_TOP = new Set([...DEDUPE_CATEGORY_DIRS, '_未對應']);
// 使用者手動整理的自訂資料夾：預設不動，--include-custom 才納入
const DEDUPE_CUSTOM_TOP = new Set(['sample', 'WAI', 'WAMI', '俱樂部版', '舊版對照']);
const CONTENT_KEEPER_PRIORITY = { 成品MP3: 0, 採樣包: 1, _未對應: 3 };

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

/** 把 alias（被去重的 task → 保留 task）套用到歌曲列表的「已下載」狀態 */
export function applyAliases(rows, state) {
    const aliases = (state && state.aliases) || {};
    const byId = new Map(rows.map((row) => [row.task_id, row]));
    for (const row of rows) {
        const keeperId = aliases[row.task_id];
        if (!keeperId) continue;
        const keeper = byId.get(keeperId);
        if (!keeper) continue;
        row.aliasOf = keeperId;
        if (keeper.downloaded) row.downloaded = { ...keeper.downloaded };
    }
    return rows;
}

/* ------------------------------------------------------------------ *
 * 本地快取層：library snapshot（一次算好，後續查詢直接讀）
 * ------------------------------------------------------------------ */
export async function buildLibrarySnapshot(cfg = config(), { refresh = false } = {}) {
    const [songs, index, state] = await Promise.all([
        listSongs(cfg, { refresh }),
        collectDownloadIndex(cfg, { refresh }),
        loadState(cfg),
    ]);
    const rows = applyAliases(songs.map((song) => summarizeSong(song, index)), state);
    const counts = { songs: rows.length, downloaded: 0, partial: 0, undownloaded: 0, midiAvailable: 0 };
    for (const row of rows) {
        const downloaded = row.downloaded;
        if (downloaded && downloaded.allDone) counts.downloaded += 1;
        else if (downloaded && downloaded.any) counts.partial += 1;
        else counts.undownloaded += 1;
        if (row.midi_available) counts.midiAvailable += 1;
    }
    const snapshot = { builtAt: new Date().toISOString(), counts, songs: rows };
    await cacheWrite(SNAPSHOT_NAME, snapshot, cfg).catch(() => {});
    return snapshot;
}

export async function getLibrarySnapshot(cfg = config(), { refresh = false, ttlMs = Number(process.env.ACE_SNAPSHOT_TTL_MS || 60000) } = {}) {
    if (!refresh) {
        const peek = await cachePeek(SNAPSHOT_NAME, { ttlMs, cfg });
        if (peek.fresh && peek.data && Array.isArray(peek.data.songs)) return { ...peek.data, cached: true, ageMs: peek.ageMs };
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
        if (!bySize.has(stat.size)) bySize.set(stat.size, []);
        bySize.get(stat.size).push({ file, size: stat.size, nlink: stat.nlink });
    }
    const hashCache = new Map();
    const hashOf = (file) => {
        if (!hashCache.has(file)) hashCache.set(file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
        return hashCache.get(file);
    };
    for (const [size, list] of bySize) {
        if (list.length < 2) continue;
        const byHash = new Map();
        for (const item of list) {
            let hash;
            try { hash = hashOf(item.file); } catch (err) { report.errors.push({ file: item.file, error: String((err && err.message) || err) }); continue; }
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
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(cfg.stateDir, 'organize-backups', 'content-' + stamp);
        for (const dup of report.duplicateFiles) {
            try {
                const dest = path.join(backupDir, dup.rel);
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                try {
                    await fsp.rename(dup.file, dest);
                } catch {
                    await fsp.copyFile(dup.file, dest);
                    await fsp.unlink(dup.file);
                }
                report.moved += 1;
                if (!dup.hardlink) report.bytesReclaimed += dup.size;
            } catch (err) {
                report.errors.push({ file: dup.file, error: String((err && err.message) || err) });
            }
        }
        if (Object.keys(aliases).length || report.duplicateFiles.length) {
            rawState.aliases = { ...(rawState.aliases || {}), ...aliases };
            // 路徑級跳過表：即使沒有 history 的歌，也能知道「這個路徑已被去重、內容在 keeper」
            rawState.removedPaths = { ...(rawState.removedPaths || {}) };
            for (const dup of report.duplicateFiles) rawState.removedPaths[dup.file.toLowerCase()] = dup.keep;
            await writeJson(cfg.stateFile, rawState);
        }
        clearFsCaches(cfg);
    }
    report.ok = report.errors.length === 0;
    report.groupCount = report.groups.length;
    report.duplicateCount = report.duplicateFiles.length;
    report.finishedAt = new Date().toISOString();
    return report;
}

/**
 * 歷史遺留清理：移除空的歌名資料夾，並把「在分類庫已有相同內容」的分軌/成品副本搬走。
 * 只依 hash 相同才判定重複，同名不同內容（例如多首同名歌）一律保留。
 * commit=false 只回報，不動檔案。
 */
export async function dedupeFolders({ root = 'ai音樂', commit = false, includeCustom = false, cfg = config() } = {}) {
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
        if (!hashCache.has(file)) hashCache.set(file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
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
        try { hash = hashOf(file); } catch (err) { report.errors.push({ file, error: String(err.message || err) }); continue; }
        const keeper = candidates.find((candidate) => {
            try { return hashOf(candidate) === hash; } catch { return false; }
        });
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
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(cfg.stateDir, 'organize-backups', 'dedupe-' + stamp);
        for (const item of report.duplicateFiles) {
            try {
                const rel = path.relative(rootDir, item.file);
                const dest = path.join(backupDir, rel);
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                try {
                    await fsp.rename(item.file, dest);
                } catch {
                    await fsp.copyFile(item.file, dest);
                    await fsp.unlink(item.file);
                }
                report.moved += 1;
                if (!item.hardlink) report.bytesReclaimed += item.size;
            } catch (err) {
                report.errors.push({ file: item.file, error: String(err.message || err) });
            }
        }
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
    emit('samples', { mp3: steps[1] });
    const samplesResult = await collectSamples({ root, cfg });
    steps.push({ name: 'samples', total: samplesResult.total, copied: samplesResult.copied, skipped: samplesResult.skipped, failed: samplesResult.failed.length });
    emit('classify', { samples: steps[2] });
    const classifyResult = await classifyByAttributes({ root, move: true, cfg });
    steps.push({ name: 'classify', total: classifyResult.total, moved: classifyResult.moved, copied: classifyResult.copied, skipped: classifyResult.skipped, failed: classifyResult.failed.length });
    emit('dedupe', { classify: steps[3] });
    const dedupeResult = await dedupeSongCopies({ root, cfg });
    steps.push({ name: 'dedupe', removed: dedupeResult.removed, savedMB: Math.round(dedupeResult.savedBytes / 1048576), failed: dedupeResult.failed.length });
    emit('content', { dedupe: steps[4] });
    const contentResult = await dedupeContent({ root, commit: true, cfg });
    steps.push({
        name: 'content',
        duplicates: contentResult.duplicateCount || 0,
        moved: contentResult.moved || 0,
        reclaimedMB: Math.round((contentResult.bytesReclaimed || 0) / 1048576),
        aliases: Object.keys(contentResult.aliases || {}).length,
        failed: contentResult.errors.length,
    });
    emit('folders', { content: steps[5] });
    const foldersResult = await dedupeFolders({ root, commit: true, cfg });
    steps.push({
        name: 'folders',
        duplicates: foldersResult.duplicateCount || 0,
        emptyFolders: foldersResult.emptyFolderCount || 0,
        moved: foldersResult.moved || 0,
        reclaimedMB: Math.round((foldersResult.bytesReclaimed || 0) / 1048576),
        failed: foldersResult.errors.length,
    });
    emit('audio', { folders: steps[5] });
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
    const result = {
        ok:
            (organizeResult.failedCount || 0) === 0 &&
            mp3Result.failed.length === 0 &&
            samplesResult.failed.length === 0 &&
            classifyResult.failed.length === 0 &&
            dedupeResult.failed.length === 0 &&
            contentResult.errors.length === 0 &&
            foldersResult.errors.length === 0 &&
            audioResult.failed.length === 0,
        root,
        startedAt,
        finishedAt: new Date().toISOString(),
        steps,
    };
    emit('done', { steps, result });
    return result;
}

export async function organize({ dryRun = true, root = 'ai音樂', typeFolders = false, conflict = 'skip', cfg = config() } = {}) {
    const session = await loadSession(cfg);
    const songs = await listSongs(cfg);
    const state = await loadState(cfg);
    const byTitle = new Map();
    for (const song of songs) {
        byTitle.set(titleKey((song.meta && song.meta.title) || ''), song);
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
    for (const move of moves) {
        try {
            await fsp.mkdir(path.dirname(move.to), { recursive: true });
            let target = move.to;
            if (exists(target)) {
                const a = await fsp.stat(move.from).catch(() => null);
                const b = await fsp.stat(target).catch(() => null);
                if (a && b && a.size === b.size) {
                    await fsp.unlink(move.from).catch(() => {});
                    dedupedCount += 1;
                    continue;
                }
                if (conflict === 'skip') {
                    conflictCount += 1;
                    conflicts.push({ from: move.from, to: target });
                    continue;
                }
                if (conflict === 'overwrite') {
                    await fsp.unlink(target).catch(() => {});
                } else {
                    target = uniquePath(target);
                }
            }
            try {
                await fsp.rename(move.from, target);
            } catch {
                await fsp.copyFile(move.from, target);
                await fsp.unlink(move.from);
            }
            movedCount += 1;
        } catch (err) {
            failed.push({ from: move.from, error: String((err && err.message) || err) });
        }
    }
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



