// named-copy.mjs — 成品WAV → 改名WAV（新名字、帶封面、藝人、可倒查的命名日誌）
//
// 使用者 2026-11-17 指定：
//   * 名字用《夜城人物事典》《靈感電子百科大全》抽出的詞庫組合（中文 + 英文）
//   * 產出是「複製」：<root>/改名WAV/<新名字>.aiff，來源 成品WAV 不動
//   * 每筆都寫進 <root>/改名WAV/_命名日誌.json，可以用新名字倒查原本是哪個檔
//   * AIFF 轉換只換容器（pcm_s16le → pcm_s16be），封面與藝人寫入 ID3v2.4
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config, localSettings, readJson, writeJson } from './config.mjs';

const require = createRequire(import.meta.url);
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const NAMING_ROOT = path.resolve(LIB_DIR, '..', '..', 'naming');
const CORPUS = require(path.join(NAMING_ROOT, 'corpus.js'));
const LEXICON = JSON.parse(fs.readFileSync(path.join(NAMING_ROOT, 'corpus-lexicon.json'), 'utf8'));

export const NAMED_OUTPUT_FOLDER = '改名WAV';
export const NAMING_JOURNAL = '_命名日誌.json';
export const NAMING_SCHEMA = 'vdb_naming_journal_v1';
export const DEFAULT_ARTIST = 'VooDooBoys';

const TASK_SUFFIX = /\s*\[[0-9a-f]{6,}\]\s*$/i;
const COVER_FOLDER = '封面';

const baseOf = (n) => String(n || '').replace(/\.(wav|aiff?|jpe?g|png)$/i, '').replace(/\s*-\s*Cover$/i, '').replace(TASK_SUFFIX, '').trim();
const normBase = (n) => baseOf(n).toLowerCase();
const legal = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);

export function namingSettings(cfg = config()) {
    const raw = (localSettings(cfg.stateDir) || {}).naming;
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        enabled: s.enabled !== false,
        artist: typeof s.artist === 'string' && s.artist.trim() ? s.artist.trim() : DEFAULT_ARTIST,
        outFolder: typeof s.outFolder === 'string' && s.outFolder.trim() ? s.outFolder.trim() : NAMED_OUTPUT_FOLDER,
        paren: s.paren !== false,
        stamp: s.stamp === false ? '' : (s.stamp === 'date' ? 'date' : 'datetime'),
        concurrency: Math.max(1, Math.min(6, Number(s.concurrency) || 3)),
    };
}

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

function runFfmpeg(args) {
    return new Promise((resolve) => {
        let child;
        try { child = spawn(process.env.ACE_FFMPEG || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
        catch (error) { resolve({ code: -1, error: String(error.message || error) }); return; }
        let err = '';
        child.on('error', (error) => resolve({ code: -1, error: String(error.message || error) }));
        child.stderr.on('data', (chunk) => { err += chunk.toString(); });
        child.on('close', (code) => resolve({ code, error: code === 0 ? null : err.slice(-400) }));
    });
}

/** 歌曲生成時間：優先用站點快照的 created_at（task_id 末 8 碼對應檔名 [8hex]），否則用檔案 mtime。 */
function generationTimes(cfg) {
    const byId = new Map();
    for (const file of [path.join(cfg.stateDir, 'page-songs.json'), path.join(cfg.stateDir, 'cache', 'songs.json')]) {
        let data = null;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        const rows = [...(data.songs || []), ...(data.known || []), ...(data.known_songs || [])];
        for (const row of rows) {
            if (!row || typeof row.task_id !== 'string') continue;
            const created = Number(row.created_at);
            if (Number.isFinite(created) && created > 0) byId.set(row.task_id, created < 1e12 ? created * 1000 : created);
        }
    }
    return byId;
}

const pad2 = (n) => String(n).padStart(2, '0');
function stampOf(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** 算出這一批的命名計畫（不寫檔）。同名/同檔已存在時標記 skip。 */
export function planNamedCopies({ root, cfg = config(), settings } = {}) {
    const s = settings || namingSettings(cfg);
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const srcDir = path.join(rootDir, '成品WAV');
    const outDir = path.join(rootDir, s.outFolder);
    const covers = coverIndex(rootDir);
    const times = generationTimes(cfg);
    const counters = new Map();
    const used = new Set();
    const plan = [];
    let wavs = [];
    try { wavs = fs.readdirSync(srcDir).filter((n) => /\.wav$/i.test(n)); } catch { return { rootDir, srcDir, outDir, plan, missingSource: true, settings: s }; }
    for (const name of wavs.sort((a, b) => a.localeCompare(b, 'zh-Hant'))) {
        const abs = path.join(srcDir, name);
        let size = 0, mtimeMs = Date.now();
        try { const st = fs.statSync(abs); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
        const key = normBase(name);
        const ordinal = counters.get(key) || 0;
        counters.set(key, ordinal + 1);
        const list = covers.get(key) || [];
        const cover = list.length ? list[Math.min(ordinal, list.length - 1)] : null;
        const seed = `${name}|${size}`;
        const suffixMatch = name.match(/\[([0-9a-f]{8})\]\s*\.wav$/i);
        let generatedMs = mtimeMs;
        if (suffixMatch) {
            for (const [taskId, created] of times) {
                if (taskId.toLowerCase().endsWith(suffixMatch[1].toLowerCase())) { generatedMs = created; break; }
            }
        }
        const stampFull = stampOf(generatedMs);
        const stamp = s.stamp === 'date' ? stampFull.slice(0, 10) : (s.stamp ? stampFull : '');
        let candidate = null;
        for (let attempt = 0; attempt < 40 && !candidate; attempt++) {
            const generated = CORPUS.generate(attempt === 0 ? seed : `${seed}#${attempt}`, { lexicon: LEXICON, used, paren: s.paren });
            if (!generated) continue;
            const display = stamp ? `${generated.display} ${stamp}` : generated.display;
            const fileName = legal(display) + '.aiff';
            if (used.has(display) || plan.some((p) => p.fileName === fileName)) continue;
            candidate = { ...generated, display, fileName };
        }
        if (!candidate) { plan.push({ name, error: 'no-name' }); continue; }
        used.add(candidate.display);
        plan.push({
            name,
            source: abs,
            title: candidate.zh,
            display: candidate.display,
            en: candidate.en,
            pattern: candidate.pattern,
            seed,
            stamp,
            generatedAt: new Date(generatedMs).toISOString(),
            cover: cover ? path.basename(cover) : null,
            coverPath: cover,
            fileName: candidate.fileName,
            target: path.join(outDir, candidate.fileName),
            exists: fs.existsSync(path.join(outDir, candidate.fileName)),
        });
    }
    return { rootDir, srcDir, outDir, plan, settings: s };
}

/** 依計畫輸出 AIFF（複製式），並把每一筆寫進命名日誌。 */
export async function applyNamedCopies({ root, cfg = config(), force = false, dryRun = false, concurrency, onProgress } = {}) {
    const planned = planNamedCopies({ root, cfg });
    const s = planned.settings;
    const report = { ok: true, out: planned.outDir, artist: s.artist, dryRun: !!dryRun, total: planned.plan.length, written: 0, skipped: 0, noCover: 0, failed: [], journal: path.join(planned.outDir, NAMING_JOURNAL), samples: [] };
    if (planned.missingSource) { report.ok = false; report.error = `找不到 ${planned.srcDir}`; return report; }
    if (!dryRun) await fsp.mkdir(planned.outDir, { recursive: true });

    const journalFile = path.join(planned.outDir, NAMING_JOURNAL);
    const existing = (await readJson(journalFile, null)) || { schema: NAMING_SCHEMA, entries: [] };
    const entries = Array.isArray(existing.entries) ? existing.entries : [];
    const batch = new Date().toISOString();
    const queue = planned.plan.filter((p) => !p.error);
    const pool = Math.max(1, Math.min(6, Number(concurrency) || s.concurrency));
    let finished = 0;

    const one = async (item) => {
        if (!item.cover) report.noCover++;
        if (!force && item.exists) { report.skipped++; return; }
        if (dryRun) {
            report.written++;
            if (report.samples.length < 12) report.samples.push({ from: item.name, to: item.fileName, pattern: item.pattern });
            return;
        }
        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', item.source];
        if (item.coverPath) args.push('-i', item.coverPath);
        args.push('-map', '0:a');
        if (item.coverPath) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
        args.push('-c:a', 'pcm_s16be', '-map_metadata', '-1', '-write_id3v2', '1', '-id3v2_version', '4',
            '-metadata', `title=${item.display}`, '-metadata', `artist=${s.artist}`, item.target);
        const result = await runFfmpeg(args);
        if (result.code === 0 && fs.existsSync(item.target) && fs.statSync(item.target).size > 1024) {
            report.written++;
            entries.push({
                batch,
                at: new Date().toISOString(),
                from: path.relative(planned.rootDir, item.source),
                to: item.fileName,
                title: item.display,
                zh: item.title,
                en: item.en || null,
                artist: s.artist,
                pattern: item.pattern,
                seed: item.seed,
                cover: item.cover,
                bytes: fs.statSync(item.target).size,
            });
        } else {
            report.failed.push({ file: item.name, error: result.error || `ffmpeg exit ${result.code}` });
            try { if (fs.existsSync(item.target) && fs.statSync(item.target).size <= 1024) fs.unlinkSync(item.target); } catch { /* ignore */ }
        }
    };

    async function worker() {
        while (queue.length) {
            const item = queue.shift();
            await one(item);
            finished++;
            if (onProgress) onProgress({ done: finished, total: queue.length + finished, current: item.fileName });
        }
    }
    await Promise.all(Array.from({ length: pool }, () => worker()));

    if (!dryRun) {
        await writeJson(journalFile, { schema: NAMING_SCHEMA, updatedAt: new Date().toISOString(), artist: s.artist, source: planned.srcDir, out: planned.outDir, entries });
        report.journalEntries = entries.length;
        report.ok = report.failed.length === 0;
    } else if (!report.samples.length) {
        for (const item of planned.plan.slice(0, 12)) report.samples.push({ from: item.name, to: item.fileName, pattern: item.pattern });
    }
    return report;
}

/** 用新的檔名倒查原本是哪個檔；找不到回 null。 */
export async function lookupNamed({ root, cfg = config(), name } = {}) {
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const settings = namingSettings(cfg);
    const journalFile = path.join(rootDir, settings.outFolder, NAMING_JOURNAL);
    const journal = await readJson(journalFile, null);
    if (!journal || !Array.isArray(journal.entries)) return null;
    const wanted = String(name || '').toLowerCase();
    return journal.entries.find((entry) => String(entry.to || '').toLowerCase() === wanted
        || String(entry.title || '').toLowerCase() === wanted
        || String(entry.zh || '').toLowerCase() === wanted) || null;
}
