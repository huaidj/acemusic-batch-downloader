// aiff-export.mjs — 成品WAV → 成品AIFF（原檔名、嵌入封面、寫入藝人、丟掉來源 metadata）
//
// 為什麼要轉：rekordbox 不顯示 WAV 的封面（Pioneer 的 metadata 表把 WAV 歸在 RIFF INFO 文字欄位），
// AIFF 是同樣的 PCM、同樣大小，但吃 ID3v2.4，封面與藝人都帶得走。
//
// 規則（使用者 2026-11-17 指定）：
//   * 檔名保持原樣（不再用命名爐改名）
//   * 每首嵌入 <root>/封面/<歌名> - Cover.jpg；沒有封面照樣轉，計入 noCover
//   * 藝人預設 VooDooBoys，可用 <stateDir>/config.json 的 aiff.artist 覆寫
//   * 只做容器轉換：pcm_s16le → pcm_s16be，樣本不重算；-map_metadata -1 不搬任何來源 metadata
//   * 只複製、不刪來源；輸出 <root>/成品AIFF/<原檔名>.aiff，已存在就跳過（--force 才重做）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, localSettings, readJson, writeJson } from './config.mjs';

export const AIFF_SOURCE_FOLDER = '成品WAV';
export const AIFF_OUTPUT_FOLDER = '成品AIFF';
export const AIFF_MAP_FILE = '_對照表.json';
export const AIFF_SCHEMA = 'vdb_aiff_v1';
export const DEFAULT_ARTIST = 'VooDooBoys';
const COVER_FOLDER = '封面';
const TASK_SUFFIX = /\s*\[[0-9a-f]{6,}\]\s*$/i;

const baseOf = (name) => String(name || '')
    .replace(/\.(wav|aiff?|jpe?g|png)$/i, '')
    .replace(/\s*-\s*Cover$/i, '')
    .replace(TASK_SUFFIX, '')
    .trim();
const normBase = (name) => baseOf(name).toLowerCase();
const cleanTitle = (name) => String(name || '').replace(/\.wav$/i, '').replace(TASK_SUFFIX, '').trim();

/** 讀 <stateDir>/config.json 的 aiff 設定；預設啟用、藝人 VooDooBoys。 */
export function aiffSettings(cfg = config()) {
    const raw = (localSettings(cfg.stateDir) || {}).aiff;
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const artist = typeof s.artist === 'string' && s.artist.trim() ? s.artist.trim() : DEFAULT_ARTIST;
    return {
        enabled: s.enabled !== false,
        artist,
        concurrency: Number.isFinite(Number(s.concurrency)) ? Math.min(6, Math.max(1, Number(s.concurrency))) : 3,
    };
}

function ffmpegBin() {
    return process.env.ACE_FFMPEG || 'ffmpeg';
}

function runFfmpeg(args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (error) {
            resolve({ code: -1, error: String(error.message || error) });
            return;
        }
        let err = '';
        child.on('error', (error) => resolve({ code: -1, error: String(error.message || error) }));
        child.stderr.on('data', (chunk) => { err += chunk.toString(); });
        child.on('close', (code) => resolve({ code, error: code === 0 ? null : err.slice(-400) }));
    });
}

/** 封面索引：歌名（去掉 [hash] 與 - Cover）→ [絕對路徑]。 */
function coverIndex(root) {
    const dir = path.join(root, COVER_FOLDER);
    const index = new Map();
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png)$/i.test(n)); } catch { return index; }
    for (const name of names.sort((a, b) => a.localeCompare(b, 'zh-Hant'))) {
        const key = normBase(name);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(path.join(dir, name));
    }
    return index;
}

/**
 * 把 成品WAV 轉成 成品AIFF。
 * @returns {{ok:boolean,total:number,converted:number,skipped:number,noCover:number,failed:Array,out:string,artist:string,dryRun:boolean}}
 */
export async function exportAiffs({ root, cfg = config(), artist, force = false, dryRun = false, concurrency, onProgress } = {}) {
    const settings = aiffSettings(cfg);
    const who = typeof artist === 'string' && artist.trim() ? artist.trim() : settings.artist;
    const pool = Math.max(1, Math.min(6, Number(concurrency) || settings.concurrency));
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const srcDir = path.join(rootDir, AIFF_SOURCE_FOLDER);
    const outDir = path.join(rootDir, AIFF_OUTPUT_FOLDER);
    const report = { ok: true, total: 0, converted: 0, skipped: 0, noCover: 0, failed: [], out: outDir, artist: who, dryRun: !!dryRun };

    let wavs = [];
    try { wavs = fs.readdirSync(srcDir).filter((n) => /\.wav$/i.test(n)); } catch { return { ...report, error: `找不到 ${srcDir}` }; }
    report.total = wavs.length;
    if (!wavs.length) return report;
    if (!dryRun) await fsp.mkdir(outDir, { recursive: true });

    const covers = coverIndex(rootDir);
    const counters = new Map();
    const plan = wavs.sort((a, b) => a.localeCompare(b, 'zh-Hant')).map((name) => {
        const key = normBase(name);
        const ordinal = counters.get(key) || 0;
        counters.set(key, ordinal + 1);
        const list = covers.get(key) || [];
        const cover = list.length ? list[Math.min(ordinal, list.length - 1)] : null;
        if (!cover) report.noCover++;
        return { name, title: cleanTitle(name), cover };
    });

    const queue = plan.slice();
    const mapFile = path.join(outDir, AIFF_MAP_FILE);
    const existing = (await readJson(mapFile, null)) || { schema: AIFF_SCHEMA, items: [] };
    const byFrom = new Map((existing.items || []).filter((i) => i && i.from).map((i) => [i.from, i]));
    let finished = 0;

    const convertOne = async (item) => {
        const dst = path.join(outDir, item.name.replace(/\.wav$/i, '.aiff'));
        if (!force && fs.existsSync(dst)) {
            report.skipped++;
            return;
        }
        if (dryRun) { report.converted++; return; }
        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(srcDir, item.name)];
        if (item.cover) args.push('-i', item.cover);
        args.push('-map', '0:a');
        if (item.cover) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
        args.push('-c:a', 'pcm_s16be', '-map_metadata', '-1', '-write_id3v2', '1', '-id3v2_version', '4',
            '-metadata', `title=${item.title}`, '-metadata', `artist=${who}`, dst);
        const result = await runFfmpeg(args);
        if (result.code === 0 && fs.existsSync(dst) && fs.statSync(dst).size > 1024) {
            report.converted++;
            byFrom.set(item.name, {
                from: item.name,
                to: path.basename(dst),
                title: item.title,
                artist: who,
                cover: item.cover ? path.basename(item.cover) : null,
                bytes: fs.statSync(dst).size,
                at: new Date().toISOString(),
            });
        } else {
            report.failed.push({ file: item.name, error: result.error || `ffmpeg exit ${result.code}` });
            try { if (fs.existsSync(dst) && fs.statSync(dst).size <= 1024) fs.unlinkSync(dst); } catch { /* ignore */ }
        }
    };

    async function worker() {
        while (queue.length) {
            const item = queue.shift();
            await convertOne(item);
            finished++;
            if (onProgress) onProgress({ done: finished, total: plan.length, current: item.name });
        }
    }
    await Promise.all(Array.from({ length: pool }, () => worker()));

    if (!dryRun) {
        await writeJson(mapFile, {
            schema: AIFF_SCHEMA,
            generatedAt: new Date().toISOString(),
            artist: who,
            source: srcDir,
            out: outDir,
            total: plan.length,
            converted: report.converted,
            items: [...byFrom.values()],
        });
    }
    report.ok = report.failed.length === 0;
    return report;
}

/** 已點讚：<root>/已點讚/*.wav → <root>/改名WAV/已點讚/<原名字>.aiff（封面、藝人，原名字直接用）。 */
export async function exportLikedAiffs({ root, cfg = config(), artist, force = false, dryRun = false, concurrency } = {}) {
    const settings = aiffSettings(cfg);
    const who = typeof artist === 'string' && artist.trim() ? artist.trim() : settings.artist;
    const pool = Math.max(1, Math.min(6, Number(concurrency) || settings.concurrency));
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const srcDir = path.join(rootDir, '已點讚');
    const outDir = path.join(rootDir, '改名WAV', '已點讚');
    const report = { ok: true, total: 0, converted: 0, skipped: 0, noCover: 0, failed: [], out: outDir, artist: who, dryRun: !!dryRun };

    let wavs = [];
    try { wavs = fs.readdirSync(srcDir).filter((n) => /\.wav$/i.test(n)); } catch { return { ...report, error: `找不到 ${srcDir}` }; }
    report.total = wavs.length;
    if (!wavs.length) return report;
    if (!dryRun) await fsp.mkdir(outDir, { recursive: true });

    // 命名對照表：已點讚的歌名 → 來源（成品WAV 的原檔名），用來找封面
    let nameMap = {};
    try { nameMap = JSON.parse(fs.readFileSync(path.join(srcDir, '_命名對照.json'), 'utf8')).items || {}; } catch { nameMap = {}; }
    const byFile = new Map();
    for (const row of Object.values(nameMap)) {
        const wav = row && row.copies && row.copies.wav;
        if (wav && wav.file) byFile.set(String(wav.file).toLowerCase(), String(wav.source || ''));
    }
    const covers = coverIndex(rootDir);
    const plan = wavs.sort((a, b) => a.localeCompare(b, 'zh-Hant')).map((name) => {
        const source = byFile.get(name.toLowerCase()) || '';
        const key = normBase(path.basename(source)) || normBase(name);
        const list = covers.get(key) || [];
        const cover = list.length ? list[0] : null;
        if (!cover) report.noCover++;
        return { name, title: cleanTitle(name), cover };
    });

    const queue = plan.slice();
    const journal = [];
    async function worker() {
        while (queue.length) {
            const item = queue.shift();
            const dst = path.join(outDir, item.name.replace(/\.wav$/i, '.aiff'));
            if (!force && fs.existsSync(dst)) { report.skipped++; continue; }
            if (dryRun) { report.converted++; continue; }
            const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(srcDir, item.name)];
            if (item.cover) args.push('-i', item.cover);
            args.push('-map', '0:a');
            if (item.cover) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
            args.push('-c:a', 'pcm_s16be', '-map_metadata', '-1', '-write_id3v2', '1', '-id3v2_version', '4',
                '-metadata', `title=${item.title}`, '-metadata', `artist=${who}`, dst);
            const result = await runFfmpeg(args);
            if (result.code === 0 && fs.existsSync(dst) && fs.statSync(dst).size > 1024) {
                report.converted++;
                journal.push({ from: item.name, to: path.basename(dst), title: item.title, artist: who, cover: item.cover ? path.basename(item.cover) : null, bytes: fs.statSync(dst).size });
            } else {
                report.failed.push({ file: item.name, error: result.error || `ffmpeg exit ${result.code}` });
            }
        }
    }
    await Promise.all(Array.from({ length: pool }, () => worker()));
    if (!dryRun && journal.length) {
        const mapFile = path.join(outDir, '_對照表.json');
        const previous = (await readJson(mapFile, null)) || { schema: 'vdb_liked_aiff_v1', items: [] };
        const byFrom = new Map((previous.items || []).filter((x) => x && x.from).map((x) => [x.from, x]));
        for (const row of journal) byFrom.set(row.from, row);
        await writeJson(mapFile, { schema: 'vdb_liked_aiff_v1', generatedAt: new Date().toISOString(), artist: who, source: srcDir, out: outDir, items: [...byFrom.values()] });
    }
    report.ok = report.failed.length === 0;
    return report;
}