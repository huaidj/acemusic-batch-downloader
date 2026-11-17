// build-corpus.mjs — 從兩本詞典（夜城人物事典／靈感電子百科大全）抽出取名用詞庫
//
// 只取「種類／概念／場所／裝備／主題」這類可再組合的詞，不搬角色專名，
// 輸出 naming/corpus-lexicon.json（純資料，瀏覽器與 Node 共用）。
//
// 用法：node naming/build-corpus.mjs [--night <html>] [--elec <html>] [--out <json>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const NIGHT = arg('night', 'C:\\Users\\win\\Documents\\夜城人物事典.html');
const ELEC = arg('elec', 'C:\\Users\\win\\Documents\\靈感電子百科大全.html');
const OUT = arg('out', path.join(HERE, 'corpus-lexicon.json'));

function payloadOf(raw, key) {
    const marker = '{"' + key + '"';
    const start = raw.indexOf(marker);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}

const CJK = /[\u3400-\u9fff]/;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const isName = (s) => {
    const t = clean(s);
    if (!t || !CJK.test(t)) return false;
    const zhLen = Array.from(t.replace(/[^\u3400-\u9fff]/g, '')).length;
    return zhLen >= 2 && zhLen <= 6 && !/[，。、；：！？「」（）]/.test(t);
};

const nightRaw = fs.existsSync(NIGHT) ? fs.readFileSync(NIGHT, 'utf8') : '';
const elecRaw = fs.existsSync(ELEC) ? fs.readFileSync(ELEC, 'utf8') : '';
const night = nightRaw ? payloadOf(nightRaw, 'character') : null;
const elec = elecRaw ? payloadOf(elecRaw, 'works') : null;
if (!night) console.warn('warn: 讀不到夜城資料（' + NIGHT + '）');
if (!elec) console.warn('warn: 讀不到電子百科資料（' + ELEC + '）');

const pool = {
    version: 1,
    builtAt: new Date().toISOString(),
    sources: { night: night ? path.basename(NIGHT) : null, elec: elec ? path.basename(ELEC) : null },
    places: [], orgs: [], concepts: [], weapons: [], devices: [], themes: [], tags: [],
};
const seen = new Set();
const push = (bucket, zh, en, extra) => {
    const name = clean(zh);
    if (!isName(name)) return;
    const key = bucket + '|' + name;
    if (seen.has(key)) return;
    seen.add(key);
    const row = { zh: name };
    const gloss = clean(en);
    if (gloss && /[A-Za-z]/.test(gloss)) row.en = gloss;
    if (Array.isArray(extra) && extra.length) row.tags = [...new Set(extra.filter(Boolean).map(clean).filter((t) => t && CJK.test(t)))].slice(0, 6);
    pool[bucket].push(row);
};

for (const row of (night && night.place) || []) push('places', row.name, row.en, [row.faction, ...(row.tags || [])]);
for (const row of (night && night.org) || []) push('orgs', row.name, row.en, [row.faction, ...(row.tags || [])]);
for (const row of (night && night.concept) || []) push('concepts', row.name, row.en, [row.faction, ...(row.tags || [])]);
for (const row of (night && night.weapons) || []) push('weapons', row.name, row.en, [row.cat, row.tech]);
for (const row of [...((night && night.place) || []), ...((night && night.org) || []), ...((night && night.concept) || []), ...((night && night.weapons) || [])]) {
    for (const tag of row.tags || []) {
        const t = clean(tag);
        if (Array.from(t).length >= 2 && Array.from(t).length <= 4 && CJK.test(t)) {
            const key = 'tags|' + t;
            if (!seen.has(key)) { seen.add(key); pool.tags.push({ zh: t }); }
        }
    }
}
for (const work of (elec && elec.works) || []) {
    for (const theme of work.themes || []) {
        const t = clean(theme);
        if (Array.from(t.replace(/[^\u3400-\u9fff]/g, '')).length >= 2) {
            const key = 'themes|' + t;
            if (!seen.has(key)) { seen.add(key); pool.themes.push({ zh: t, from: clean(work.title) }); }
        }
    }
    for (const device of work.devices || []) {
        const t = clean(String(device.name || '').replace(/[：:].*$/, ''));
        if (Array.from(t.replace(/[^\u3400-\u9fff]/g, '')).length >= 2) {
            const key = 'devices|' + t;
            if (!seen.has(key)) { seen.add(key); pool.devices.push({ zh: t, from: clean(work.title) }); }
        }
    }
}

pool.stats = Object.fromEntries(Object.entries(pool).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(pool, null, 1), 'utf8');
console.log(JSON.stringify({ out: OUT, stats: pool.stats }, null, 1));
