// build-corpus.mjs — 從兩本詞典抽「有關係」的取名語料（v2）
//
// v1 只抽孤立詞條，組合起來常常沒邏輯（例：企業廣場＋超夢）。
// v2 保留來源的結構關係，取名器才能依音樂特徵挑「說得通」的組合：
//   places/concepts/orgs → tags、faction（夜城的分區與勢力）
//   weapons              → cat（手槍/刀…）、tech（power/tech/melee）
//   devices              → 出自哪個作品、對應哪些 themes（電子百科）
//   themes               → 作品主題（幽靈與殼、機械的日常勞動…）
//
// 用法：node naming/build-corpus.mjs [--night <html>] [--elec <html>] [--out <json>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
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
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
}

const CJK = /[\u3400-\u9fff]/;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const zhLen = (s) => Array.from(clean(s).replace(/[^\u3400-\u9fff]/g, '')).length;
const isName = (s, min = 2, max = 6) => {
    const t = clean(s);
    return t && CJK.test(t) && zhLen(t) >= min && zhLen(t) <= max && !/[，。、；：！？「」（）]/.test(t);
};
const tagsOf = (row) => [...new Set([...(Array.isArray(row.tags) ? row.tags : []), row.faction || ''].map(clean).filter((t) => t && zhLen(t) <= 4))].slice(0, 8);

const nightRaw = fs.existsSync(NIGHT) ? fs.readFileSync(NIGHT, 'utf8') : '';
const elecRaw = fs.existsSync(ELEC) ? fs.readFileSync(ELEC, 'utf8') : '';
const night = nightRaw ? payloadOf(nightRaw, 'character') : null;
const elec = elecRaw ? payloadOf(elecRaw, 'works') : null;
if (!night) console.warn('warn: 讀不到夜城資料（' + NIGHT + '）');
if (!elec) console.warn('warn: 讀不到電子百科資料（' + ELEC + '）');

const pool = {
    version: 2,
    builtAt: new Date().toISOString(),
    sources: { night: night ? path.basename(NIGHT) : null, elec: elec ? path.basename(ELEC) : null },
    places: [], orgs: [], concepts: [], weapons: [], devices: [], themes: [], tags: [],
};
const seen = new Set();
const push = (bucket, row, extra = {}) => {
    if (!isName(row.zh)) return;
    const key = bucket + '|' + row.zh;
    if (seen.has(key)) return;
    seen.add(key);
    const entry = { zh: clean(row.zh) };
    const gloss = clean(row.en);
    if (gloss && /[A-Za-z]/.test(gloss)) entry.en = gloss;
    if (Array.isArray(row.tags) && row.tags.length) entry.tags = row.tags;
    if (row.faction) entry.faction = clean(row.faction);
    Object.assign(entry, extra);
    pool[bucket].push(entry);
};

for (const row of (night && night.place) || []) push('places', { zh: row.name, en: row.en, tags: tagsOf(row), faction: row.faction });
for (const row of (night && night.org) || []) {
    const aliases = (Array.isArray(row.aliases) ? row.aliases : []).map(clean).filter((alias) => alias && zhLen(alias) >= 2 && zhLen(alias) <= 3);
    push('orgs', { zh: row.name, en: row.en, tags: tagsOf(row), faction: row.faction, aliases });
}
for (const row of (night && night.concept) || []) push('concepts', { zh: row.name, en: row.en, tags: tagsOf(row), faction: row.faction });
for (const row of (night && night.weapons) || []) {
    if (!isName(row.name, 2, 4) || !/^[\u3400-\u9fff]+$/.test(clean(row.name))) continue;
    push('weapons', { zh: row.name, en: row.en }, { cat: clean(row.cat), tech: clean(row.tech), iconic: !!row.iconic });
}
const tagUniverse = new Set();
for (const bucket of ['places', 'orgs', 'concepts']) {
    for (const row of pool[bucket]) for (const tag of row.tags || []) { tagUniverse.add(tag); pool.tags.push({ zh: tag }); }
}
pool.tags = [...new Map(pool.tags.map((t) => [t.zh, t])).values()].filter((t) => zhLen(t.zh) >= 2).slice(0, 200);

const works = (elec && elec.works) || [];
for (const work of works) {
    const workTitle = clean(work.title);
    const themes = (work.themes || []).map(clean).filter((t) => zhLen(t) >= 2);
    for (const theme of themes) {
        if (!seen.has('themes|' + theme)) { seen.add('themes|' + theme); pool.themes.push({ zh: theme, work: workTitle }); }
    }
    for (const device of work.devices || []) {
        const name = clean(String(device.name || '').replace(/[：:].*$/, ''));
        if (!isName(name, 2, 8)) continue;
        if (seen.has('devices|' + name)) continue;
        seen.add('devices|' + name);
        pool.devices.push({ zh: name, en: '', work: workTitle, themes: themes.slice(0, 4) });
    }
}
// 裝置短名：整句放進歌名不像歌名，取核心 2~3 字（手動對照，來源可回查）
const DEVICE_SHORT = {
    '尾燈光軌': ['光軌', 'Light Trail'],
    '手繪的光': ['手繪', 'Hand-Drawn Light'],
    '低周波音': ['低周波', 'Subsonic'],
    '新聞嵌片': ['嵌片', 'News Insert'],
    '熱光學迷彩': ['迷彩', 'Thermal Camo'],
    '靜止長鏡': ['長鏡', 'Long Take'],
    '固定長鏡': ['長鏡', 'Long Take'],
    '長定鏡': ['長鏡', 'Long Take'],
    '資訊過載的城市拼貼': ['城市拼貼', 'City Collage'],
    '資訊洪水快切': ['快切', 'Fast Cut'],
    '黑底白字字卡': ['字卡', 'Title Card'],
};
for (const device of pool.devices) {
    const short = DEVICE_SHORT[device.zh];
    if (short) { device.short = short[0]; device.shortEn = short[1]; }
    else { device.short = Array.from(device.zh).slice(0, 3).join(''); device.shortEn = ''; }
}
pool.devices = pool.devices.filter((d) => zhLen(d.zh) <= 6);

// ---- 電子百科：作品、主題、場景、提示語的核心詞（2~4 字）----
const CORE_SPLIT = /[的與和及、，。：:；;\/／｜|·・\-—\(\)（）「」『』]/;
const CORE_STOP = /^(一個|一種|這個|那個|我們|他們|自己|之後|之前|同時|因為|所以|但是|可以|沒有|什麼|如何|變成|成為|透過|關於|所有|每一|以及|或是|並非|不是|而是|就是|還是|而是)$/;
const coreOf = (text, min = 2, max = 4) => String(text || '')
    .split(CORE_SPLIT)
    .map((part) => part.replace(/[^\u3400-\u9fff]/g, '').trim())
    .filter((part) => part && Array.from(part).length >= min && Array.from(part).length <= max && !CORE_STOP.test(part));

pool.works = [];
pool.themeCores = [];
pool.sceneCores = [];
pool.promptCores = [];
for (const work of works) {
    const workTitle = clean(work.title);
    if (isName(workTitle, 2, 8)) pool.works.push({ zh: workTitle, en: clean(work.en) });
    for (const theme of (work.themes || []).map(clean)) {
        for (const core of coreOf(theme)) {
            const key = 'themeCores|' + core;
            if (seen.has(key)) continue;
            seen.add(key);
            pool.themeCores.push({ zh: core, work: workTitle, theme });
        }
    }
    for (const scene of work.scenes || []) {
        const name = clean(String(scene.name || '').replace(/^[^：:]{1,8}[：:]/, ''));
        for (const core of coreOf(name, 2, 4)) {
            const key = 'sceneCores|' + core;
            if (seen.has(key)) continue;
            seen.add(key);
            pool.sceneCores.push({ zh: core, work: workTitle });
        }
    }
    for (const idea of work.prompt_ideas || []) {
        for (const core of coreOf(idea.title, 2, 4)) {
            const key = 'promptCores|' + core;
            if (seen.has(key)) continue;
            seen.add(key);
            pool.promptCores.push({ zh: core, work: workTitle });
        }
    }
}
// ---- 靈感子代理（讀《靈感電子百科大全》各章）產出的語料 ----
const inspDir = path.join(HERE, 'inspiration');
const inspiration = { abstract: [], concrete: [], phrases: [], absurd: [], verbs: [], pairs: [] };
const pushUnique = (bucket, zh, gloss) => {
    const name = clean(zh);
    if (!name || Array.from(name).length > 10) return;
    if (inspiration[bucket].some((row) => row.zh === name)) return;
    inspiration[bucket].push({ zh: name, gloss: clean(gloss) });
};
if (fs.existsSync(inspDir)) {
    for (const file of fs.readdirSync(inspDir).filter((name) => name.endsWith('.json')).sort()) {
        let data = null;
        try { data = JSON.parse(fs.readFileSync(path.join(inspDir, file), 'utf8')); } catch { continue; }
        for (const key of ['abstract', 'concrete', 'phrases', 'absurd']) {
            for (const row of data[key] || []) pushUnique(key, typeof row === 'string' ? row : (row && row.zh), row && row.gloss);
        }
        for (const verb of data.verbs || []) pushUnique('verbs', verb.zh || verb, verb.gloss);
        for (const pair of data.absurdPairs || []) {
            if (Array.isArray(pair) && pair.length >= 2) inspiration.pairs.push({ a: clean(pair[0]), b: clean(pair[1]) });
        }
    }
}
pool.inspiration = inspiration;

pool.stats = Object.fromEntries(Object.entries(pool).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(pool, null, 1), 'utf8');
console.log(JSON.stringify({ out: OUT, stats: pool.stats }, null, 1));
