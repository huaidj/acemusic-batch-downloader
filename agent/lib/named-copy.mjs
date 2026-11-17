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

/** 讀整理管線的音頻分析快取（BPM／調性／能量），取名時依聲音特徵挑詞。 */
function audioFeatures(cfg) {
    const map = new Map();
    const file = path.join(cfg.stateDir, 'cache', 'audio-analysis.json');
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return map; }
    for (const [key, value] of Object.entries(data.items || {})) {
        if (!value || !value.ok) continue;
        const row = { bpm: value.bpm, key: value.key, camelot: value.camelot, energy: value.energy, duration: value.duration };
        map.set(path.resolve(key).toLowerCase(), row);
        if (value.relative) map.set(String(value.relative).toLowerCase(), row);
    }
    return map;
}

/** 同一個歌名家族：去掉 [hash] 與結尾 (n)；同家族共用基底名字，避免改名後看不出是同一首的變體。 */
function familyKeyOf(name) {
    return String(name || '')
        .replace(/\.wav$/i, '')
        .replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '')
        .replace(/\s*\(\s*\d+\s*\)\s*$/, '')
        .trim()
        .toLowerCase();
}

/** 檔名裡「不是純數字」的括號描述，例：(UK Bass Dub) → UK Bass Dub；沒有回空字串。 */
function variantLabelOf(name) {
    const matches = [...String(name || '').matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
    const meaningful = matches.filter((label) => label && !/^\d+$/.test(label));
    return meaningful.length ? meaningful[meaningful.length - 1] : '';
}

const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/** 算出這一批的命名計畫（不寫檔）。同名/同檔已存在時標記 skip。 */
export function planNamedCopies({ root, cfg = config(), settings } = {}) {
    const s = settings || namingSettings(cfg);
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const srcDir = path.join(rootDir, '成品WAV');
    const outDir = path.join(rootDir, s.outFolder);
    const covers = coverIndex(rootDir);
    const times = generationTimes(cfg);
    const features = audioFeatures(cfg);
    const counters = new Map();
    const used = new Set();
    const usage = new Map();
    const families = new Map();
    const kindCounts = new Map();
    const sourceCounts = new Map();
    let fallbackIndex = 0;
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
        const ratioOf = (key, fallback) => {
            const total = [...sourceCounts.values()].reduce((sum, value) => sum + value, 0);
            return total ? (sourceCounts.get(key) || 0) / total : fallback;
        };
        const audio = features.get(path.resolve(abs).toLowerCase())
            || features.get(path.join('ai音樂', '成品WAV', name).toLowerCase())
            || {};
        const suffixMatch = name.match(/\[([0-9a-f]{8})\]\s*\.wav$/i);
        let generatedMs = mtimeMs;
        if (suffixMatch) {
            for (const [taskId, created] of times) {
                if (taskId.toLowerCase().endsWith(suffixMatch[1].toLowerCase())) { generatedMs = created; break; }
            }
        }
        const familyKey = familyKeyOf(name);
        const familyEntry = families.get(familyKey) || null;
        const stampFull = stampOf(generatedMs);
        const stamp = s.stamp === 'date' ? stampFull.slice(0, 10) : (s.stamp ? stampFull : '');
        let candidate = null;
        if (familyEntry) {
            // 同家族：沿用基底名，加變體標記（原檔名的描述或羅馬序號）
            const index = familyEntry.next ?? 2;
            familyEntry.next = index + 1;
            const label = variantLabelOf(name) || ROMAN[index] || String(index);
            const zh = `${familyEntry.base.zh} · ${label}`;
            const en = familyEntry.base.en ? `${familyEntry.base.en} · ${label}` : '';
            const display = stamp ? (en ? `${zh} (${en}) ${stamp}` : `${zh} ${stamp}`) : (en ? `${zh} (${en})` : zh);
            candidate = { zh, en, display, pattern: familyEntry.base.pattern + '+variant', reason: `同家族變體（${label}）`, display, fileName: legal(display) + '.aiff' };
            familyEntry.members.push(name);
        } else {
            const weaponsUsed = () => kindCounts.get('short-weapon') || 0;
            for (let attempt = 0; attempt < 60 && !candidate; attempt++) {
                const generated = CORPUS.generateFromAudio(seed, { lexicon: LEXICON, audio, used, usage, salt: attempt * 7, nightRatio: ratioOf('night', 0.4), elecRatio: ratioOf('elec', 0.3) });
                if (!generated) continue;
                if (generated.pattern === 'short-weapon' && weaponsUsed() >= 60) continue;
                const display = stamp ? `${generated.display} ${stamp}` : generated.display;
                const fileName = legal(display) + '.aiff';
                if (used.has(display) || plan.some((p) => p.fileName === fileName)) continue;
                candidate = { ...generated, display, fileName };
            }
            if (candidate) families.set(familyKey, { base: candidate, members: [name], next: 2 });
        }
        if (!candidate) {
            // 退路：概念＋音樂尾詞（不隨機洗牌，仍從詞庫概念挑，確保這一批都能命名）
            const TAILS = ['殘響', '迴路', '底噪', '夜行', '餘燼', '斷訊', '長曝', '空轉', '低頻', '靜止', '頻段', '脈衝'];
            const concepts = LEXICON.concepts || [];
            for (let i = 0; i < concepts.length * TAILS.length && !candidate; i++) {
                const concept = concepts[(fallbackIndex + i) % concepts.length];
                const tail = TAILS[Math.floor(((fallbackIndex + i) / concepts.length)) % TAILS.length];
                const zh = concept.zh + tail;
                if (Array.from(zh.replace(/[^\u3400-\u9fff]/g, '')).length > 8) continue;
                const en = concept.en ? concept.en + ' ' + tail : '';
                const display = stamp ? (en ? `${zh} (${en}) ${stamp}` : `${zh} ${stamp}`) : (en ? `${zh} (${en})` : zh);
                if (used.has(display)) continue;
                candidate = { zh, en, display, pattern: 'concept+tail', reason: '退路：概念＋音樂尾詞' };
                fallbackIndex += 1;
                used.add(display);
                break;
            }
            if (!candidate) { plan.push({ name, error: 'no-name' }); continue; }
            continue;
        }
        // 檔名唯一：同一個顯示名（含時間戳）若已被占用，補羅馬序號直到不撞名
        let suffixIndex = 2;
        while (plan.some((p) => p.fileName === candidate.fileName)) {
            const label = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][suffixIndex] || String(suffixIndex);
            const baseZh = candidate.zh;
            const zh = `${baseZh} · ${label}`;
            const display = stamp ? `${zh} ${stamp}` : zh;
            candidate = { ...candidate, zh, display, fileName: legal(display) + '.aiff' };
            suffixIndex += 1;
        }
        used.add(candidate.display);
        kindCounts.set(candidate.pattern, (kindCounts.get(candidate.pattern) || 0) + 1);
        const kindBase = String(candidate.pattern || '').replace(/\+variant$/, '');
        const sourceKey = /^(place\+concept|org\+concept|short-weapon)$/.test(kindBase) ? 'night'
            : /^(elec-core|elec\+tail)$/.test(kindBase) ? 'elec' : 'mixed';
        sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) || 0) + 1);
        plan.push({
            name,
            source: abs,
            title: candidate.zh,
            display: candidate.display,
            en: candidate.en,
            pattern: candidate.pattern,
            reason: candidate.reason || null,
            audio: { bpm: audio.bpm || null, camelot: audio.camelot || null, key: audio.key || null, energy: audio.energy ?? null },
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
export async function applyNamedCopies({ root, cfg = config(), force = false, dryRun = false, concurrency, onProgress, record = true } = {}) {
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
                reason: item.reason || null,
                audio: item.audio || null,
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
    // 給人看的摘要（面板「重新命名這批」會讀這筆）；從 tidy 內部呼叫時由 tidy 統一記，不重複。
    if (!dryRun && record !== false) {
        try {
            const { recordActivity } = await import('./activity-log.mjs');
            const fresh = entries.filter((entry) => entry.batch === batch);
            await recordActivity({
                root: planned.rootDir,
                cfg,
                entry: {
                    kind: 'namedcopy',
                    finishedAt: new Date().toISOString(),
                    durationMs: null,
                    ok: report.ok,
                    lines: [
                        `新寫 ${report.written} 首、已存在 ${report.skipped} 首、沒有封面 ${report.noCover} 首、失敗 ${report.failed.length} 首`,
                        `命名日誌共 ${entries.length} 筆（可用新名字倒查原始檔案）`,
                        report.ok ? '結果：全部成功' : '結果：有失敗，請看機器紀錄',
                    ],
                    examples: fresh.slice(0, 5).map((entry) => ({ from: path.basename(entry.from), to: entry.to })),
                },
            });
        } catch { /* 摘要失敗不影響改名 */ }
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
