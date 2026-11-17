// evidence-repair.mjs — 把「成品WAV 裡實際存在的檔案」補回 agent-state 的 wav 證據
//
// 為什麼需要：站點下載紀錄（Chrome history／agent-state）記的是下載當時的路徑，
// 檔案被整理到 成品WAV／換過磁碟之後，本機索引靠紀錄就認不出某些 WAV，
// 於是 收藏 會把那些歌算成 noWav。這裡只用兩種確定性證據補：
//   1. 檔名尾碼 [8hex] → task_id 末 8 碼（唯一才用）
//   2. 歌名完全相符（去版本序號後唯一才用）
// 不動音檔、不改檔名；只補 state.history[task].files.wav。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, readJson, writeJson } from './config.mjs';

const TASK_SUFFIX = /\[([0-9a-f]{8})\]\s*\.wav$/i;
const stripVersion = (s) => String(s || '').replace(/\s*[（(]\s*\d+\s*[)）]\s*$/, '').trim();

function loadSongs(cfg) {
    const rows = [];
    for (const file of [path.join(cfg.stateDir, 'page-songs.json'), path.join(cfg.stateDir, 'cache', 'songs.json')]) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            rows.push(...(data.songs || []), ...(data.known || []), ...(data.known_songs || []));
        } catch { /* 缺檔就跳過 */ }
    }
    const byId = new Map();
    for (const row of rows) {
        if (row && typeof row.task_id === 'string' && !byId.has(row.task_id)) byId.set(row.task_id, row);
    }
    return byId;
}

export async function repairWavEvidence({ root, cfg = config(), commit = false } = {}) {
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const wavDir = path.join(rootDir, '成品WAV');
    const state = await readJson(cfg.stateFile, null);
    const report = { ok: true, dryRun: !commit, scanned: 0, already: 0, repaired: 0, unresolved: 0, samples: [], failed: [] };
    if (!state || !state.history) return { ...report, ok: false, error: '讀不到 agent-state.json' };

    const songs = loadSongs(cfg);
    if (!songs.size) return { ...report, ok: false, error: '讀不到歌曲快照（page-songs／cache）' };

    const bySuffix = new Map();
    let files = [];
    try { files = fs.readdirSync(wavDir).filter((n) => /\.wav$/i.test(n)); } catch { return { ...report, ok: false, error: `找不到 ${wavDir}` }; }
    for (const title of songs.keys()) {
        const tail = title.slice(-8).toLowerCase();
        if (!bySuffix.has(tail)) bySuffix.set(tail, []);
        bySuffix.get(tail).push(title);
    }
    const byTitle = new Map();
    for (const [id, song] of songs) {
        const key = stripVersion((song.meta && song.meta.title) || '').toLowerCase();
        if (!key) continue;
        if (!byTitle.has(key)) byTitle.set(key, []);
        byTitle.get(key).push(id);
    }

    for (const name of files) {
        report.scanned++;
        const abs = path.join(wavDir, name);
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { continue; }
        let taskId = null;
        const suffix = name.match(TASK_SUFFIX);
        if (suffix) {
            const owners = bySuffix.get(suffix[1].toLowerCase()) || [];
            if (owners.length === 1) taskId = owners[0];
        }
        if (!taskId) {
            const owners = byTitle.get(stripVersion(name.replace(/\.wav$/i, '')).toLowerCase()) || [];
            if (owners.length === 1) taskId = owners[0];
        }
        if (!taskId) { report.unresolved++; continue; }
        const entry = state.history[taskId] || (state.history[taskId] = { files: {} });
        entry.files = entry.files || {};
        const current = entry.files.wav;
        if (current && current.absolute && path.resolve(current.absolute).toLowerCase() === path.resolve(abs).toLowerCase()) { report.already++; continue; }
        if (!commit) {
            report.repaired++;
            if (report.samples.length < 10) report.samples.push({ file: name, task_id: taskId });
            continue;
        }
        entry.files.wav = {
            path: path.relative(rootDir, abs).split(path.sep).join('/'),
            filename: name,
            absolute: abs,
            size,
            at: Date.now(),
            repairedAt: new Date().toISOString(),
            evidence: 'filename-suffix-or-title',
        };
        report.repaired++;
        if (report.samples.length < 10) report.samples.push({ file: name, task_id: taskId });
    }

    if (commit && report.repaired) {
        const backupDir = path.join(cfg.stateDir, 'backups');
        await fsp.mkdir(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.copyFile(cfg.stateFile, path.join(backupDir, `agent-state.wav-repair-${stamp}.json`));
        await writeJson(cfg.stateFile, state);
    }
    report.ok = report.failed.length === 0;
    return report;
}
