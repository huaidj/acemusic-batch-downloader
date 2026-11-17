// activity-log.mjs — 給人看的整理摘要（可打開）＋給機器看的原始紀錄（隱藏）
//
// 使用者要求（2026-11-17）：下載、分類、複製、改名都要在後台安靜跑完，
// 日誌要看得懂、預設收起，只留一個「打開」按鈕；追溯資訊完整保留在機器紀錄裡。
//
//   <root>/_整理摘要.md            人看的（最新在最上面，最多 20 輪）
//   <stateDir>/logs/activity.jsonl 機器看的（每輪一行 JSON，append-only，不刪）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';

export const SUMMARY_FILE = '_整理摘要.md';
const KEEP_ENTRIES = 20;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (date) => {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const durationText = (ms) => {
    const seconds = Math.max(0, Math.round(num(ms) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} 分 ${seconds % 60} 秒`;
};

function stepOf(steps, name) {
    return (steps || []).find((step) => step && step.name === name) || null;
}

/** 從 tidy-all 的 steps 產生一句句看得懂的摘要。 */
export function summarizeTidySteps(steps, { result } = {}) {
    const lines = [];
    const organize = stepOf(steps, 'organize');
    const mp3 = stepOf(steps, 'mp3');
    const wav = stepOf(steps, 'wav');
    const classify = stepOf(steps, 'classify');
    const samples = stepOf(steps, 'samples');
    const content = stepOf(steps, 'content');
    const dedupe = stepOf(steps, 'dedupe');
    const audio = stepOf(steps, 'audio');
    const favorites = stepOf(steps, 'favorites');
    const fingerprints = stepOf(steps, 'fingerprints');
    const liked = stepOf(steps, 'liked');
    const named = stepOf(steps, 'namedcopy');
    const hardlinks = stepOf(steps, 'hardlinks');
    if (organize) lines.push(`整理下載：搬 ${num(organize.moved)} 檔、合併重複 ${num(organize.deduped)} 檔`);
    if (mp3) lines.push(`成品 MP3：${num(mp3.total)} 首（新補 ${num(mp3.copied) + num(mp3.downloaded)}、跳過 ${num(mp3.skipped)}）`);
    if (wav) lines.push(`成品 WAV：搬 ${num(wav.moved)}、跳過 ${num(wav.skipped)}、重複 ${num(wav.duplicates)}`);
    if (samples) lines.push(`採樣包：複製 ${num(samples.copied)}、跳過 ${num(samples.skipped)}`);
    if (classify) lines.push(`檔案分類：搬 ${num(classify.moved)}、複製 ${num(classify.copied)}`);
    if (dedupe) lines.push(`歌名資料夾去重：移除 ${num(dedupe.removed)} 檔（省 ${num(dedupe.savedMB)} MB）`);
    if (content) lines.push(`內容去重：${num(content.duplicates)} 組、搬移 ${num(content.moved)} 檔、回收 ${num(content.reclaimedMB)} MB`);
    if (audio) lines.push(`音頻分析：${num(audio.total)} 首（新分析 ${num(audio.analyzed)}、快取 ${num(audio.cached)}）；分類檢視 ${num(audio.linked)} 個連結`);
    if (favorites) lines.push(`收藏：${num(favorites.total)} 首（新收 ${num(favorites.copied)}、已經有 ${num(favorites.skipped)}、沒有 WAV ${num(favorites.noWav)}）`);
    if (fingerprints) lines.push(`指紋清除：${num(fingerprints.cleaned)} 檔`);
    if (liked) lines.push(`已點讚：${num(liked.liked)} 首（新複製 ${num(liked.copied)}、已存在 ${num(liked.already)}）`);
    if (named) {
        lines.push(named.skipped === 'disabled'
            ? '改名WAV：這一輪關閉'
            : `改名WAV：${num(named.total)} 首（新寫 ${num(named.written)}、已存在 ${num(named.skipped)}、沒有封面 ${num(named.noCover)}）`);
    }
    if (hardlinks) lines.push(`硬連結：新連結 ${num(hardlinks.linked)} 個、已連結 ${num(hardlinks.alreadyLink)}（再省 ${num(hardlinks.savedMB)} MB）`);
    const failed = (steps || []).reduce((sum, step) => sum + num(step && step.failed), 0);
    lines.push(failed === 0 && (!result || result.ok !== false) ? '結果：全部成功（0 失敗）' : `結果：有 ${failed} 個步驟出錯，詳見機器紀錄`);
    return lines;
}

function renderEntry(entry) {
    const lines = [`## ${stamp(entry.finishedAt || entry.at)} · ${entry.kind === 'tidy' ? '一鍵整理' : entry.kind === 'namedcopy' ? '重新命名這批' : entry.kind}${entry.durationMs ? `（${durationText(entry.durationMs)}）` : ''}`];
    for (const line of entry.lines || []) lines.push(`- ${line}`);
    if (Array.isArray(entry.examples) && entry.examples.length) {
        lines.push('- 改名範例：');
        for (const example of entry.examples.slice(0, 5)) lines.push('  - `' + example.from + '` → `' + example.to + '`');
    }
    if (entry.note) lines.push(`- ${entry.note}`);
    return lines.join('\n');
}

function parseEntries(markdown) {
    return String(markdown || '').split(/^## /m).slice(1).map((block) => '## ' + block);
}

/** 寫入一輪摘要：人看的 Markdown（保留最近 20 輪）＋機器看的 JSONL（全部）。 */
export async function recordActivity({ root, cfg = config(), entry } = {}) {
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const payload = { at: new Date().toISOString(), ...entry };
    const summaryPath = path.join(rootDir, SUMMARY_FILE);
    // 機器紀錄：永不刪除，方便追溯
    try {
        const logDir = path.join(cfg.stateDir, 'logs');
        await fsp.mkdir(logDir, { recursive: true });
        await fsp.appendFile(path.join(logDir, 'activity.jsonl'), JSON.stringify(payload) + '\n', 'utf8');
    } catch { /* 機器紀錄失敗不影響主流程 */ }
    let previous = [];
    try { previous = parseEntries(fs.readFileSync(summaryPath, 'utf8')); } catch { previous = []; }
    const thisHeading = '## ' + stamp(payload.finishedAt || payload.at);
    // 標題保留在最上面，只留最近 N 輪
    const header = '# 整理摘要（最新在最上面）\n\n> 這一頁是給人看的：每一輪下載、分類、複製、改名各自做了什麼。\n> 完整機器紀錄在 `%LOCALAPPDATA%\\AceMusicDL\\logs\\activity.jsonl`。\n';
    const body = [renderEntry(payload), ...previous.filter((block) => !block.startsWith(thisHeading))]
        .slice(0, KEEP_ENTRIES)
        .join('\n\n');
    try { await fsp.writeFile(summaryPath, header + '\n' + body + '\n', 'utf8'); } catch { /* ignore */ }
    return { summaryPath, entry: payload };
}

/** 讀最近幾輪（給面板與 CLI 用）。 */
export async function readActivity({ root, cfg = config(), limit = 5 } = {}) {
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const summaryPath = path.join(rootDir, SUMMARY_FILE);
    let markdown = '';
    try { markdown = await fsp.readFile(summaryPath, 'utf8'); } catch { markdown = ''; }
    const entries = parseEntries(markdown).slice(0, Math.max(1, Math.min(50, Number(limit) || 5)));
    const raw = [];
    try {
        const text = await fsp.readFile(path.join(cfg.stateDir, 'logs', 'activity.jsonl'), 'utf8');
        for (const line of text.split('\n').filter(Boolean).slice(-Math.max(1, limit))) { try { raw.push(JSON.parse(line)); } catch { /* skip */ } }
    } catch { /* 沒有機器紀錄 */ }
    return { ok: true, summaryPath, exists: !!markdown, entries, raw: raw.reverse() };
}
