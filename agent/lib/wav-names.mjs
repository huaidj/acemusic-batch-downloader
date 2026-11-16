// wav-names.mjs — 成品WAV 分類後的「複製式重新命名」。
//
// 規則（2026-11-17 使用者指定）：
//   * 只複製、不移動／不改名來源檔 → 插件永遠讀得到原本的路徑
//   * 乾淨名字放到 <root>/整理輸出/成品WAV/（與「收藏」同級的隔離資料夾，索引／去重／分類都不碰）
//   * 每次生成會有兩首同名歌 → 用 task id 區分，依 created_at 依序 (2)(3)…，同名不覆寫
// 歸屬只認證據：agent-state 的 wav 紀錄、verified-audio 的 wav 驗證紀錄、舊檔名 [8hex] 尾碼。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, readJson, writeJson, exists, toWin } from './config.mjs';
import { loadShared } from './shared.mjs';
import { hasLibraryWriteLease, withLibraryWriteLease } from './library-lease.mjs';

const { N } = loadShared();

export const DEFAULT_WAV_FOLDER = '成品WAV';
export const OUTPUT_FOLDER = '整理輸出';
export const MAP_FILE = '_對照表.json';
const MAP_SCHEMA = 'ace_wav_names_map_v1';
const TASK_SUFFIX = /\[([0-9a-f]{8})\]\s*$/i;
const TITLE_LIMIT = 80;
const REPORT_ITEM_LIMIT = 200;

const keyOf = (file) => path.resolve(file).toLowerCase();
const titleOf = (song) => N.sanitizeComponent((song && song.meta && song.meta.title) || '', TITLE_LIMIT) || '';
const sizeOf = (file) => {
    try { return fs.statSync(file).size; } catch { return null; }
};

async function offlineSongs(cfg) {
    const page = await readJson(path.join(cfg.stateDir, 'page-songs.json'), {});
    const cache = await readJson(path.join(cfg.stateDir, 'cache', 'songs.json'), {});
    const pool = new Map();
    for (const song of [...(cache.known || []), ...(cache.songs || []), ...(page.songs || [])]) {
        if (song && typeof song.task_id === 'string' && !pool.has(song.task_id)) pool.set(song.task_id, song);
    }
    return [...pool.values()];
}

/** 建立「檔案 → 歸屬 task」的證據表；同一個檔被兩個 task 主張就標成 null（ambiguous）。 */
export function ownershipOf({ files, songs, state, proofs, downloadDir, indexClaims = null }) {
    const byId = new Map(songs.filter((song) => song && song.task_id).map((song) => [song.task_id, song]));
    const claims = new Map(); // lower absolute path -> Set(taskId)
    const claim = (file, taskId) => {
        if (!file || !taskId || !byId.has(taskId) || !path.isAbsolute(file)) return;
        const key = keyOf(file);
        if (!claims.has(key)) claims.set(key, new Set());
        claims.get(key).add(taskId);
    };
    // 可信本機索引的 WAV 證據（Chrome 下載紀錄、搬移鏈等；只收 verified／recorded，不收待核對）。
    // 舊版只看 agent-state／proof／尾碼，成品WAV 有近半數因此被當成「無證據」而沒複製。
    if (indexClaims && typeof indexClaims[Symbol.iterator] === 'function') for (const [file, taskId] of indexClaims) claim(file, taskId);
    for (const [taskId, entry] of Object.entries((state && state.history) || {})) {
        for (const [name, record] of Object.entries((entry && entry.files) || {})) {
            if (!/^wav$/i.test(name) || !record) continue;
            const absolute = record.absolute || (record.path && downloadDir ? path.resolve(downloadDir, String(record.path).replace(/[\\/]/g, path.sep)) : '');
            claim(absolute, taskId);
        }
    }
    for (const proof of (proofs && Array.isArray(proofs.files) ? proofs.files : [])) {
        if (!proof || proof.kind !== 'wav' || !proof.absolute) continue;
        claim(proof.absolute, proof.task_id);
    }
    const suffixOwners = new Map(); // 8hex -> [taskId...]
    for (const taskId of byId.keys()) {
        const tail = taskId.slice(-8).toLowerCase();
        if (!suffixOwners.has(tail)) suffixOwners.set(tail, []);
        suffixOwners.get(tail).push(taskId);
    }
    const ownerOf = new Map();
    for (const file of files) {
        const owners = new Set(claims.get(keyOf(file)) || []);
        const match = path.basename(file, path.extname(file)).match(TASK_SUFFIX);
        if (match) {
            const candidates = suffixOwners.get(match[1].toLowerCase()) || [];
            if (candidates.length === 1) owners.add(candidates[0]);
        }
        if (owners.size === 1) ownerOf.set(file, [...owners][0]);
        else if (owners.size > 1) ownerOf.set(file, null);
    }
    return { ownerOf, byId };
}

/**
 * 規劃複製（純函式，不碰磁碟）。回傳：
 *   plan    — [{ file, taskId, title, target }] 需要複製的
 *   already — 目標已存在且大小相同（上次已複製）
 *   loose   — 沒有證據或證據衝突，不複製
 */
export function planWavCopies({ files, songs, state, proofs, downloadDir, outDir, assigned = {}, sameContent = null, ownCopy = null, indexClaims = null }) {
    // sameContent(來源, 目標)：判斷目標是否就是這首歌的副本。預設只比大小——同一次生成的兩首常常長度相同、大小也相同，
    // 實際整理時一定要傳入內容比對（copyCollectedWavs 會傳 sha256 比對）。
    const isSame = typeof sameContent === 'function' ? sameContent : (a, b) => { const x = sizeOf(a); return x !== null && x === sizeOf(b); };
    // ownCopy(taskId, 目標)：目標是否仍是我們上次寫入、使用者沒動過的副本（來源變了時可以原地更新）。
    const isOwnCopy = typeof ownCopy === 'function' ? ownCopy : () => false;
    const { ownerOf, byId } = ownershipOf({ files, songs, state, proofs, downloadDir, indexClaims });
    const taken = new Set();
    const loose = [];
    const candidates = [];
    for (const file of files) {
        const owner = ownerOf.has(file) ? ownerOf.get(file) : undefined;
        const title = owner ? titleOf(byId.get(owner)) : '';
        if (!owner || !title) { loose.push(file); continue; }
        candidates.push({ file, taskId: owner, title });
    }
    const ordered = candidates.sort((a, b) => {
        const ca = Number((byId.get(a.taskId) || {}).created_at) || 0;
        const cb = Number((byId.get(b.taskId) || {}).created_at) || 0;
        return ca - cb || a.taskId.localeCompare(b.taskId) || a.file.localeCompare(b.file);
    });
    const plan = [], already = [];
    // 已在對照表裡的名字保留給原本那首歌，別首不能搶（名字跨次執行保持穩定）。
    const reservedBy = new Map();
    for (const [taskId, name] of Object.entries(assigned || {})) if (typeof name === 'string' && name) reservedBy.set(name.toLowerCase(), taskId);
    for (const item of ordered) {
        const pinned = assigned && typeof assigned[item.taskId] === 'string' ? assigned[item.taskId] : '';
        if (pinned && !taken.has(pinned.toLowerCase())) {
            const target = path.join(outDir, pinned);
            taken.add(pinned.toLowerCase());
            if (sizeOf(target) === null) { plan.push({ ...item, target }); continue; }
            if (isSame(item.file, target)) { already.push({ ...item, target }); continue; }
            // 來源變了（修復、指紋清除…），而目標仍是我們上次寫入、沒被改過的副本 → 原地更新（舊副本先歸檔）
            if (isOwnCopy(item.taskId, target)) { plan.push({ ...item, target, replace: true }); continue; }
            // 使用者改過這份副本 → 保留它，這首改用下一個編號
        }
        let number = 1;
        let name = `${item.title}.wav`;
        for (;;) {
            const lower = name.toLowerCase();
            const reservedForOther = reservedBy.has(lower) && reservedBy.get(lower) !== item.taskId;
            if (!taken.has(lower) && !reservedForOther) {
                const target = path.join(outDir, name);
                if (sizeOf(target) === null) { taken.add(lower); plan.push({ ...item, target }); break; }
                if (isSame(item.file, target)) { taken.add(lower); already.push({ ...item, target }); break; }
                // 同名但不同內容（另一個 take 或使用者的檔）→ 換下一個編號
            }
            number += 1;
            name = `${item.title} (${number}).wav`;
        }
    }
    return { plan, already, loose };
}

/** 掃描 成品WAV 並把乾淨名字複製到整理輸出；來源檔永不移動。 */
export async function copyCollectedWavs({ root = 'ai音樂', folder = DEFAULT_WAV_FOLDER, outFolder = OUTPUT_FOLDER, cfg = config(), songs = null, dryRun = false, onProgress = null, useIndex = true } = {}) {
    if (!dryRun && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => copyCollectedWavs(...arguments));
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const sourceDir = path.join(rootDir, toWin(folder));
    const outDir = path.join(rootDir, toWin(outFolder), toWin(folder));
    const report = { ok: true, dryRun: !!dryRun, folder: sourceDir, outDir, total: 0, planned: 0, copied: 0, already: 0, loose: 0, failed: [], items: [] };
    if (!exists(sourceDir)) return { ...report, ok: false, error: '找不到 ' + sourceDir };
    let entries = [];
    try { entries = await fsp.readdir(sourceDir, { withFileTypes: true }); } catch (error) { return { ...report, ok: false, error: String(error.message || error) }; }
    const files = entries.filter((entry) => entry.isFile() && /\.wav$/i.test(entry.name)).map((entry) => path.join(sourceDir, entry.name));
    report.total = files.length;
    if (!files.length) return report;
    const pool = songs || (await offlineSongs(cfg));
    const state = await readJson(cfg.stateFile || path.join(cfg.stateDir, 'agent-state.json'), {});
    const proofs = await readJson(path.join(cfg.stateDir, 'verified-audio.json'), { files: [] });
    // 對照表：每首歌（task）固定一個輸出名字，並記下我們寫入的副本內容，跨次執行保持穩定。
    const mapFile = path.join(outDir, MAP_FILE);
    const map = await readJson(mapFile, null);
    const entries2 = map && map.schema === MAP_SCHEMA && map.items && typeof map.items === 'object' ? map.items : {};
    const assigned = Object.fromEntries(Object.entries(entries2).filter(([, v]) => v && typeof v.name === 'string').map(([k, v]) => [k, v.name]));
    // 內容比對：大小不同就不同；大小相同才算 sha256（同一次生成的兩首常常大小相同）。
    const hashes = new Map();
    const hashOf = (file) => { const key = keyOf(file); if (!hashes.has(key)) hashes.set(key, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')); return hashes.get(key); };
    const sameContent = (a, b) => { const x = sizeOf(a); if (x === null || x !== sizeOf(b)) return false; try { return hashOf(a) === hashOf(b); } catch { return false; } };
    const ownCopy = (taskId, target) => { const entry = entries2[taskId]; if (!entry || !entry.copySha256 || path.basename(target) !== entry.name) return false; try { return hashOf(target) === entry.copySha256; } catch { return false; } };
    // 本機索引的 WAV 歸屬：每首歌自己的證據；索引失敗時退回原本的三種證據，不中斷整理。
    let indexClaims = null;
    if (useIndex) {
        try {
            const { buildLocalDownloadIndex } = await import('./local-index.mjs');
            const index = await buildLocalDownloadIndex({ cfg, root, songs: pool });
            indexClaims = [];
            for (const [taskId, row] of Object.entries(index.byTask || {})) for (const file of row.files || []) {
                if (file.kind === 'wav' && ['verified', 'recorded'].includes(file.confidence) && file.absolute) indexClaims.push([file.absolute, taskId]);
            }
        } catch (error) { report.indexError = String((error && error.message) || error).slice(0, 200); }
    }
    const { plan, already, loose } = planWavCopies({ files, songs: pool, state, proofs, downloadDir: cfg.downloadDir, outDir, assigned, sameContent, ownCopy, indexClaims });
    report.planned = plan.length;
    report.already = already.length;
    report.loose = loose.length;
    report.replaced = 0;
    if (dryRun) {
        for (const item of plan.slice(0, REPORT_ITEM_LIMIT)) report.items.push({ from: path.basename(item.file), to: path.basename(item.target), task_id: item.taskId, ...(item.replace ? { replace: true } : {}) });
        report.finishedAt = new Date().toISOString();
        return report;
    }
    const nextMap = { schema: MAP_SCHEMA, updatedAt: new Date().toISOString(), items: { ...entries2 } };
    const remember = (item, target) => {
        try { nextMap.items[item.taskId] = { name: path.basename(target), source: path.basename(item.file), sourceSize: sizeOf(item.file), copySha256: hashOf(target), copiedAt: new Date().toISOString() }; } catch { /* 對照表只是加速與穩定名字用 */ }
    };
    // 已存在且內容相同的也記進對照表（舊版沒有對照表時第一次執行會補齊）。
    for (const item of already) if (!nextMap.items[item.taskId] || nextMap.items[item.taskId].name !== path.basename(item.target)) remember(item, item.target);
    const { copyFileSafely } = await import('./file-ops.mjs');
    let done = 0;
    if (plan.length) await fsp.mkdir(outDir, { recursive: true });
    for (const item of plan) {
        done += 1;
        if (typeof onProgress === 'function') {
            try { onProgress({ done, total: plan.length, current: path.basename(item.target) }); } catch { /* ignore */ }
        }
        try {
            // 更新自己的舊副本時用 overwrite：舊檔先歸檔到 organize-backups，可還原。
            const result = await copyFileSafely(cfg, item.file, item.target, { conflict: item.replace ? 'overwrite' : 'unique', reason: item.replace ? 'wav-copy-refresh' : 'wav-copy' });
            if (result.copied) {
                report.copied += 1;
                if (item.replace) report.replaced += 1;
                hashes.delete(keyOf(result.to || item.target));
                remember(item, result.to || item.target);
                if (report.items.length < REPORT_ITEM_LIMIT) report.items.push({ from: path.basename(item.file), to: path.basename(result.to || item.target), task_id: item.taskId, ...(item.replace ? { replace: true } : {}) });
            } else if (result.skipped) {
                report.already += 1;
            } else {
                report.failed.push({ file: path.basename(item.file), error: '未複製（目標已有不同內容）' });
            }
        } catch (error) {
            report.failed.push({ file: path.basename(item.file), error: String((error && error.message) || error).slice(0, 300) });
        }
    }
    if (plan.length || already.length) {
        await fsp.mkdir(outDir, { recursive: true });
        await writeJson(mapFile, nextMap).catch((error) => report.failed.push({ file: MAP_FILE, error: String(error.message || error).slice(0, 200) }));
    }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    return report;
}
