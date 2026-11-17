// liked-folder.mjs — 「已點讚」資料夾：把網站上按了拇指向上的歌，成品 MP3／WAV 複製到 <root>/已點讚/，
// 並用 DeepSeek 取一個雙語新名字（使用者 2026-11-17 指定；費用硬上限，名字記在對照表，重跑不重複付費）。
//
// 原則：
//   * 只複製，曲庫原檔永不移動／改名；只用本機索引確認屬於這首歌的檔（verified／recorded，不收損壞檔）。
//   * 網站點讚快照必須完整（site-likes.json complete）才處理，避免把沒抓到的歌當成「取消點讚」。
//   * 取消點讚的歌：我們放的、沒被改過的副本移到 已點讚/_已取消點讚/（不刪）。
//   * DeepSeek 每批先預留最壞費用；結果未知的請求以預留額計入、同次不重送；累計超過上限就停，改用網站歌名，下次再補。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, readJson, writeJson, exists, toWin } from './config.mjs';
import { loadShared } from './shared.mjs';
import { hasLibraryWriteLease, withLibraryWriteLease } from './library-lease.mjs';
import { LIKED_FOLDER } from './copy-folders.mjs';
import { readSiteLikes } from './site-likes.mjs';

const { N } = loadShared();

export const LIKED_MAP_FILE = '_命名對照.json';
export const UNLIKED_DIR = '_已取消點讚';
export const LIKED_SCHEMA = 'ace_liked_folder_v1';
export const NAMING_MODEL = 'deepseek-flash';
export const DEFAULT_CAP_USD = 0.5;
// 與 1.8.4 研究模組相同的尖峰價（USD／百萬 tokens）；寧可多估。
const PRICE_INPUT = 0.3, PRICE_CACHE_HIT = 0.006, PRICE_OUTPUT = 1.2;
const BATCH = 15;
const TOKENS_PER_SONG_OUT = 40;
const TEXT_LIMIT = 280;

const SYSTEM_PROMPT = [
    '你替器樂電子音樂取名。每首歌給一個新名字：',
    '- zh：繁體中文（台灣用字，不可用簡體字），2 到 6 個字，有畫面感；',
    '- en：1 到 4 個英文單字；',
    '- 不要照抄原本的歌名，同一批裡名字不要重複。',
    '只回 JSON：{"names":[{"id":"n1","zh":"幽石回響","en":"Stone Echoes"}]}',
].join('\n');

const sizeAndTime = (file) => { try { const st = fs.statSync(file); return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }; } catch { return null; } };
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clean = (value, limit) => N.sanitizeComponent(String(value || '').replace(/\s+/g, ' ').trim(), limit) || '';
const usd = (miss, hit, out) => (Math.max(0, miss) * PRICE_INPUT + Math.max(0, hit) * PRICE_CACHE_HIT + Math.max(0, out) * PRICE_OUTPUT) / 1e6;

function songText(song) {
    const meta = (song && song.meta) || {};
    const style = [song?.text?.style, meta.style, meta.prompt, song?.params?.prompt].find((v) => typeof v === 'string' && v.trim()) || '';
    return { title: clean(meta.title, 80), style: String(style).replace(/\s+/g, ' ').slice(0, TEXT_LIMIT) };
}

/** 每首點讚歌選它自己的成品 MP3／WAV：本機索引 verified 優先，再來 recorded；跳過損壞與分軌。 */
export function pickLikedFiles(row) {
    const rank = { verified: 0, recorded: 1 };
    const picked = {};
    for (const kind of ['mp3', 'wav']) {
        const files = (row && Array.isArray(row.files) ? row.files : [])
            .filter((file) => file && file.kind === kind && file.absolute && file.validity !== 'damaged' && rank[file.confidence] !== undefined)
            .sort((a, b) => rank[a.confidence] - rank[b.confidence] || String(a.absolute).length - String(b.absolute).length);
        if (files[0]) picked[kind] = files[0].absolute;
    }
    return picked;
}

/** 解析模型回覆：容忍 ```json 包裝、前後文字、陣列或 {names:[…]}；解析不了回傳空陣列。 */
export function parseNames(content) {
    const text = String(content || '').trim();
    const candidates = [text, text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()];
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
    const firstArr = text.indexOf('['), lastArr = text.lastIndexOf(']');
    if (firstArr >= 0 && lastArr > firstArr) candidates.push(text.slice(firstArr, lastArr + 1));
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate);
            const list = Array.isArray(value) ? value : Array.isArray(value?.names) ? value.names : Array.isArray(value?.songs) ? value.songs : null;
            if (list) return list.filter((entry) => entry && typeof entry === 'object');
        } catch { /* try next form */ }
    }
    return [];
}

/** 回覆裡的 id（n1／N1／1／"song 1"）→ 這批的索引；認不出回 -1。 */
function idIndex(entry) {
    const match = String(entry && entry.id !== undefined ? entry.id : '').match(/(\d+)/);
    return match ? Number(match[1]) - 1 : -1;
}

/** 依名字在整批裡唯一化（大小寫不敏感）：同名加 (2)(3)… */
export function assignBases(entries) {
    const used = new Set();
    const out = new Map();
    for (const [taskId, base] of entries) {
        let name = base, n = 1;
        while (used.has(name.toLowerCase())) { n += 1; name = `${base} (${n})`; }
        used.add(name.toLowerCase());
        out.set(taskId, name);
    }
    return out;
}

/**
 * 呼叫 DeepSeek 取名（分批）。ledger 會被就地更新：spent_usd、calls。
 * 回傳 Map(taskId → { zh, en })；拿不到的歌不在 Map 裡（呼叫端改用網站歌名，下次再補）。
 */
export async function nameWithDeepSeek(items, { apiKey, fetchImpl = fetch, ledger, capUsd = DEFAULT_CAP_USD, now = () => new Date().toISOString() } = {}) {
    const names = new Map();
    const result = { names, stopped: null };
    if (!apiKey) { result.stopped = 'no_api_key'; return result; }
    for (let start = 0; start < items.length; start += BATCH) {
        const batch = items.slice(start, start + BATCH);
        const songs = batch.map((item, i) => ({ id: 'n' + (i + 1), title: item.title, style: item.style }));
        const userText = JSON.stringify({ songs });
        const maxTokens = 40 + TOKENS_PER_SONG_OUT * batch.length;
        // 最壞估計：中英混合以 1 token／1.5 字元保守估算輸入
        const reserve = usd(Math.ceil((SYSTEM_PROMPT.length + userText.length) / 1.5), 0, maxTokens);
        if ((Number(ledger.spent_usd) || 0) + reserve > capUsd) { result.stopped = 'budget_cap'; break; }
        const call = { at: now(), model: NAMING_MODEL, songs: batch.length, reserved_usd: Number(reserve.toFixed(6)), state: 'sent' };
        ledger.calls.push(call);
        let response;
        try {
            response = await fetchImpl('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: NAMING_MODEL, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userText }], response_format: { type: 'json_object' }, max_tokens: maxTokens, temperature: 0.9, thinking: { type: 'disabled' } }),
                redirect: 'error',
                signal: AbortSignal.timeout(60000),
            });
        } catch {
            // 送出後結果未知：以預留額計入，這次不再送（避免重複計費）
            call.state = 'outcome_unknown'; call.cost_usd = call.reserved_usd;
            ledger.spent_usd = Number(((Number(ledger.spent_usd) || 0) + call.reserved_usd).toFixed(6));
            result.stopped = 'outcome_unknown';
            break;
        }
        const data = await response.json().catch(() => null);
        if (response.status !== 200 || !data) {
            call.state = 'http_' + response.status; call.cost_usd = 0;
            result.stopped = response.status === 401 || response.status === 402 ? 'auth_or_balance' : 'http_error';
            break;
        }
        const u = data.usage || {};
        const miss = Number.isFinite(Number(u.prompt_cache_miss_tokens)) ? Number(u.prompt_cache_miss_tokens) : Number(u.prompt_tokens) || 0;
        const cost = usd(miss, Number(u.prompt_cache_hit_tokens) || 0, Number(u.completion_tokens) || 0);
        call.state = 'completed'; call.cost_usd = Number(cost.toFixed(6)); call.usage = { prompt: Number(u.prompt_tokens) || 0, completion: Number(u.completion_tokens) || 0 };
        ledger.spent_usd = Number(((Number(ledger.spent_usd) || 0) + cost).toFixed(6));
        const content = String(data.choices?.[0]?.message?.content || '');
        const list = parseNames(content);
        // 對不上 id 但數量剛好等於這批時，才依順序對應；否則寧可不配，改用網站歌名。
        const byId = list.every((entry) => idIndex(entry) >= 0);
        list.forEach((entry, position) => {
            const index = byId ? idIndex(entry) : (list.length === batch.length ? position : -1);
            const item = batch[index];
            const zh = clean(entry && (entry.zh || entry.name_zh || entry.chinese), 12), en = clean(entry && (entry.en || entry.name_en || entry.english), 48);
            if (item && zh && en && !names.has(item.taskId)) names.set(item.taskId, { zh, en });
        });
        if (!batch.some((item) => names.has(item.taskId))) call.unparsed_excerpt = content.slice(0, 240);
        call.named = batch.filter((item) => names.has(item.taskId)).length;
    }
    return result;
}

export async function collectLikedSongs({ root = 'ai音樂', cfg = config(), dryRun = false, ai = true, capUsd = DEFAULT_CAP_USD, apiKey = process.env.DEEPSEEK_API_KEY, fetchImpl = fetch, index = null, songs = null, onProgress = null } = {}) {
    if (!dryRun && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => collectLikedSongs(...arguments));
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const outDir = path.join(rootDir, LIKED_FOLDER);
    const mapFile = path.join(outDir, LIKED_MAP_FILE);
    const report = { ok: true, dryRun: !!dryRun, folder: outDir, liked: 0, copied: 0, already: 0, renamed: 0, refreshed: 0, unlikedMoved: 0, aiNamed: 0, titleNamed: 0, needsNaming: 0, missingAudio: [], failed: [], spentUsd: 0, capUsd, aiStopped: null };
    let likes;
    try { likes = await readSiteLikes(cfg); } catch (error) { return { ...report, ok: false, error: '網站點讚快照無法讀取：' + error.message }; }
    if (!likes || likes.complete !== true || !Array.isArray(likes.likes)) return { ...report, ok: false, error: '網站點讚尚未完整同步；先同步網站點讚再整理已點讚資料夾' };
    const map = (await readJson(mapFile, null)) || {};
    const ledger = map.schema === LIKED_SCHEMA ? map : { schema: LIKED_SCHEMA, cap_usd: capUsd, spent_usd: 0, calls: [], items: {} };
    ledger.items = ledger.items && typeof ledger.items === 'object' ? ledger.items : {};
    ledger.calls = Array.isArray(ledger.calls) ? ledger.calls : [];
    ledger.cap_usd = capUsd;
    const pool = songs || (() => { const page = JSON.parse(fs.existsSync(path.join(cfg.stateDir, 'page-songs.json')) ? fs.readFileSync(path.join(cfg.stateDir, 'page-songs.json'), 'utf8') : '{}'); return page.songs || []; })();
    const songById = new Map(pool.filter((s) => s && s.task_id).map((s) => [s.task_id, s]));
    let idx = index;
    if (!idx) { const { buildLocalDownloadIndex } = await import('./local-index.mjs'); idx = await buildLocalDownloadIndex({ cfg, root, songs: pool.length ? pool : undefined }); }
    const likedIds = likes.likes.map((like) => like.task_id).filter(Boolean);
    report.liked = likedIds.length;

    // 1) 名字：沒名字或還在用網站歌名的，交給 DeepSeek（dryRun 只估算）
    const needing = likedIds.filter((id) => { const e = ledger.items[id]; return !e || !e.zh || !e.en || e.source !== 'deepseek'; })
        .map((id) => { const text = songText(songById.get(id) || { meta: { title: (likes.likes.find((l) => l.task_id === id) || {}).title } }); return { taskId: id, ...text }; });
    report.needsNaming = needing.length;
    if (dryRun) {
        report.estimatedUsd = Number(usd(Math.ceil((SYSTEM_PROMPT.length * Math.ceil(needing.length / BATCH) + JSON.stringify(needing).length) / 1.5), 0, needing.length * TOKENS_PER_SONG_OUT).toFixed(6));
    } else if (ai && needing.length) {
        const { names, stopped } = await nameWithDeepSeek(needing, { apiKey, fetchImpl, ledger, capUsd });
        report.aiStopped = stopped;
        for (const [taskId, name] of names) { ledger.items[taskId] = { ...(ledger.items[taskId] || {}), zh: name.zh, en: name.en, source: 'deepseek', named_at: new Date().toISOString() }; report.aiNamed += 1; }
    }
    for (const id of likedIds) {
        const e = ledger.items[id] || {};
        if (!e.zh || !e.en) {
            const title = songText(songById.get(id) || { meta: { title: (likes.likes.find((l) => l.task_id === id) || {}).title } }).title || 'Untitled';
            ledger.items[id] = { ...e, zh: title, en: '', source: 'site_title' };
            report.titleNamed += 1;
        }
    }
    report.spentUsd = Number(ledger.spent_usd) || 0;
    // 依點讚時間（歌的建立時間）排序後唯一化，名字跨次執行盡量穩定
    const ordered = likedIds.slice().sort((a, b) => (Number(songById.get(a)?.created_at) || 0) - (Number(songById.get(b)?.created_at) || 0) || a.localeCompare(b));
    const bases = assignBases(ordered.map((id) => { const e = ledger.items[id]; return [id, clean(e.en ? `${e.zh} - ${e.en}` : e.zh, 120) || 'Untitled']; }));
    if (dryRun) {
        report.items = ordered.slice(0, 50).map((id) => ({ task_id: id, name: bases.get(id), files: Object.keys(pickLikedFiles(idx.byTask?.[id])) }));
        report.missingAudio = ordered.filter((id) => !Object.keys(pickLikedFiles(idx.byTask?.[id])).length);
        return report;
    }

    // 2) 複製（或更新／改名我們自己的副本）
    await fsp.mkdir(outDir, { recursive: true });
    const { copyFileSafely } = await import('./file-ops.mjs');
    let done = 0;
    for (const id of ordered) {
        done += 1;
        if (typeof onProgress === 'function') { try { onProgress({ done, total: ordered.length, current: bases.get(id) }); } catch { /* ignore */ } }
        const picked = pickLikedFiles(idx.byTask?.[id]);
        if (!Object.keys(picked).length) { report.missingAudio.push(id); continue; }
        const entry = ledger.items[id];
        entry.copies = entry.copies || {};
        delete entry.unliked_at;
        for (const [kind, source] of Object.entries(picked)) {
            const ext = path.extname(source).toLowerCase() || '.' + kind;
            const wanted = bases.get(id) + ext;
            const prev = entry.copies[kind];
            const srcStat = sizeAndTime(source);
            try {
                // 名字變了（例如 AI 名字晚到）：把我們自己沒被改過的副本改名
                if (prev && prev.file && prev.file !== wanted && exists(path.join(outDir, prev.file))) {
                    const prevPath = path.join(outDir, prev.file);
                    const st = sizeAndTime(prevPath);
                    if (st && st.size === prev.size && st.mtimeMs === prev.mtimeMs && !exists(path.join(outDir, wanted))) { await fsp.rename(prevPath, path.join(outDir, wanted)); prev.file = wanted; report.renamed += 1; }
                }
                const target = path.join(outDir, prev && prev.file ? prev.file : wanted);
                const tgtStat = sizeAndTime(target);
                const sourceUnchanged = prev && srcStat && prev.source === source && prev.sourceSize === srcStat.size && prev.sourceMtimeMs === srcStat.mtimeMs;
                const targetUntouched = prev && tgtStat && prev.size === tgtStat.size && prev.mtimeMs === tgtStat.mtimeMs;
                if (tgtStat && sourceUnchanged && targetUntouched) { report.already += 1; continue; }
                if (tgtStat && srcStat && tgtStat.size === srcStat.size && sha256(target) === sha256(source)) {
                    entry.copies[kind] = { file: path.basename(target), source, sourceSize: srcStat.size, sourceMtimeMs: srcStat.mtimeMs, ...tgtStat };
                    report.already += 1; continue;
                }
                const refresh = !!(tgtStat && targetUntouched);
                const result = await copyFileSafely(cfg, source, target, { conflict: refresh ? 'overwrite' : 'unique', reason: refresh ? 'liked-copy-refresh' : 'liked-copy' });
                if (!result.copied && !result.skipped) { report.failed.push({ task_id: id, kind, error: '未複製' }); continue; }
                const written = result.to || target;
                entry.copies[kind] = { file: path.basename(written), source, sourceSize: srcStat?.size ?? null, sourceMtimeMs: srcStat?.mtimeMs ?? null, ...sizeAndTime(written) };
                if (refresh) report.refreshed += 1; else report.copied += 1;
            } catch (error) {
                report.failed.push({ task_id: id, kind, error: String(error.message || error).slice(0, 200) });
            }
        }
    }

    // 3) 取消點讚：我們放的、沒被改過的副本移到 _已取消點讚（不刪）
    const likedSet = new Set(likedIds);
    for (const [id, entry] of Object.entries(ledger.items)) {
        if (likedSet.has(id) || !entry || !entry.copies || entry.unliked_at) continue;
        for (const copy of Object.values(entry.copies)) {
            const from = path.join(outDir, copy.file);
            const st = sizeAndTime(from);
            if (!st || st.size !== copy.size || st.mtimeMs !== copy.mtimeMs) continue;
            const toDir = path.join(outDir, UNLIKED_DIR);
            await fsp.mkdir(toDir, { recursive: true });
            let to = path.join(toDir, copy.file), n = 1;
            while (exists(to)) { n += 1; to = path.join(toDir, path.basename(copy.file, path.extname(copy.file)) + ` (${n})` + path.extname(copy.file)); }
            try { await fsp.rename(from, to); report.unlikedMoved += 1; } catch (error) { report.failed.push({ task_id: id, error: String(error.message || error).slice(0, 200) }); }
        }
        entry.unliked_at = new Date().toISOString();
        entry.copies = {};
    }
    ledger.updated_at = new Date().toISOString();
    await writeJson(mapFile, ledger);
    report.ok = report.failed.length === 0;
    return report;
}
