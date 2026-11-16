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
import { config, readJson, exists, toWin } from './config.mjs';
import { loadShared } from './shared.mjs';
import { hasLibraryWriteLease, withLibraryWriteLease } from './library-lease.mjs';

const { N } = loadShared();

export const DEFAULT_WAV_FOLDER = '成品WAV';
export const OUTPUT_FOLDER = '整理輸出';
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
export function ownershipOf({ files, songs, state, proofs, downloadDir }) {
    const byId = new Map(songs.filter((song) => song && song.task_id).map((song) => [song.task_id, song]));
    const claims = new Map(); // lower absolute path -> Set(taskId)
    const claim = (file, taskId) => {
        if (!file || !taskId || !byId.has(taskId) || !path.isAbsolute(file)) return;
        const key = keyOf(file);
        if (!claims.has(key)) claims.set(key, new Set());
        claims.get(key).add(taskId);
    };
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
export function planWavCopies({ files, songs, state, proofs, downloadDir, outDir }) {
    const { ownerOf, byId } = ownershipOf({ files, songs, state, proofs, downloadDir });
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
    for (const item of ordered) {
        const bytes = sizeOf(item.file);
        let number = 1;
        let name = `${item.title}.wav`;
        for (;;) {
            if (!taken.has(name.toLowerCase())) {
                const target = path.join(outDir, name);
                const targetBytes = sizeOf(target);
                if (targetBytes === null) { taken.add(name.toLowerCase()); plan.push({ ...item, target }); break; }
                if (bytes !== null && targetBytes === bytes) { taken.add(name.toLowerCase()); already.push({ ...item, target }); break; }
                // 同名但不同內容（例如另一個 take 已佔用這個名字）→ 換下一個編號
            }
            number += 1;
            name = `${item.title} (${number}).wav`;
        }
    }
    return { plan, already, loose };
}

/** 掃描 成品WAV 並把乾淨名字複製到整理輸出；來源檔永不移動。 */
export async function copyCollectedWavs({ root = 'ai音樂', folder = DEFAULT_WAV_FOLDER, outFolder = OUTPUT_FOLDER, cfg = config(), songs = null, dryRun = false, onProgress = null } = {}) {
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
    const { plan, already, loose } = planWavCopies({ files, songs: pool, state, proofs, downloadDir: cfg.downloadDir, outDir });
    report.planned = plan.length;
    report.already = already.length;
    report.loose = loose.length;
    if (dryRun) {
        for (const item of plan.slice(0, REPORT_ITEM_LIMIT)) report.items.push({ from: path.basename(item.file), to: path.basename(item.target), task_id: item.taskId });
        report.finishedAt = new Date().toISOString();
        return report;
    }
    if (!plan.length) { report.finishedAt = new Date().toISOString(); return report; }
    await fsp.mkdir(outDir, { recursive: true });
    const { copyFileSafely } = await import('./file-ops.mjs');
    let done = 0;
    for (const item of plan) {
        done += 1;
        if (typeof onProgress === 'function') {
            try { onProgress({ done, total: plan.length, current: path.basename(item.target) }); } catch { /* ignore */ }
        }
        try {
            const result = await copyFileSafely(cfg, item.file, item.target, { conflict: 'unique', reason: 'wav-copy' });
            if (result.copied) {
                report.copied += 1;
                if (report.items.length < REPORT_ITEM_LIMIT) report.items.push({ from: path.basename(item.file), to: path.basename(result.to || item.target), task_id: item.taskId });
            } else if (result.skipped) {
                report.already += 1;
            } else {
                report.failed.push({ file: path.basename(item.file), error: '未複製（目標已有不同內容）' });
            }
        } catch (error) {
            report.failed.push({ file: path.basename(item.file), error: String((error && error.message) || error).slice(0, 300) });
        }
    }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    return report;
}
