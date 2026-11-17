/* ============================================================
   命名爐 · 詞典模式 v2.1（NOMENCLATOR / CORPUS）
   語料：《夜城人物事典》＋《靈感電子百科大全》。
   取名依音樂特徵（BPM／調性／能量）挑詞，而且只用「語料本身有關係」的組合：
     * 場所＋概念：兩者共享 tag 或同勢力（例：紺碧廣場↔聖物＝荒坂）
     * 組織＋概念：概念 tag 直接指名該組織（例：荒坂↔神輿）
     * 概念＋裝置短名：裝置主題與音樂特徵相符（例：聖物＋長鏡）
   名字語感以來源資料為準（場所＋概念＝地點擁有的東西；概念＋裝置＝手法／質地）。
   純函數，瀏覽器與 Node 共用。
   ============================================================ */
(function (global) {
  'use strict';

  function hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rngOf(seed) {
    let a = hash(String(seed)) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (rng, arr) => (arr && arr.length ? arr[Math.floor(rng() * arr.length) % arr.length] : null);
  const zhLen = (s) => Array.from(String(s || '').replace(/[^\u3400-\u9fff]/g, '')).length;
  const sharedTags = (a, b) => {
    const left = new Set(a && a.tags ? a.tags : []);
    return (b && b.tags ? b.tags : []).filter((tag) => left.has(tag));
  };

  // ---- 音樂特徵 → 語意權重 ----
  function profileFromAudio(audio) {
    const a = audio || {};
    const bpm = Number(a.bpm) || 0;
    const energy = Number.isFinite(Number(a.energy)) ? Number(a.energy) : 0.12;
    const minor = /min/i.test(a.key || '') || /A$/.test(a.camelot || '');
    const slow = bpm ? Math.max(0, (118 - bpm) / 40) : 0.3;
    const fast = bpm ? Math.max(0, (bpm - 118) / 40) : 0.3;
    const dark = (minor ? 0.55 : 0.2) + Math.min(0.35, Math.max(0, 0.12 - energy) * 2.2);
    const bright = (minor ? 0.15 : 0.6) + Math.min(0.25, Math.max(0, energy - 0.14) * 1.6);
    const heavy = Math.min(1, 0.35 + slow * 0.5 + Math.max(0, energy - 0.1) * 1.4);
    const machine = Math.min(1, 0.3 + fast * 0.6 + (a.vocalFraction === 0 ? 0.15 : 0));
    const organic = Math.max(0, 1 - machine * 0.7);
    const ritual = Math.min(1, 0.35 + dark * 0.5 + (slow > 0.25 ? 0.15 : 0));
    return { bpm, minor, energy, slow, fast, dark, bright, heavy, machine, organic, ritual };
  }

  function categoryOf(text) {
    const t = String(text || '');
    if (/黑|冥|暗|夜|荒|禁|深|沉|墓|墳|死亡|恐怖|幽|靈魂|亡/.test(t)) return 'dark';
    if (/霓虹|光|遊行|雲頂|門面|舞台|娛樂|超夢|歌舞伎|海報|燈/.test(t)) return 'bright';
    if (/企業|軍火|武器|義體|機械|網路|情報|駭|保安|工業|科技|集團|國家|警|機器/.test(t)) return 'machine';
    if (/部落|有機|生技|藥|糧食|海|潮|土|泥|森林|生物/.test(t)) return 'organic';
    if (/重|低|壓力|音量|核|震|爆/.test(t)) return 'heavy';
    if (/儀式|巫|薩滿|祭|宗教|信仰|祖靈|神/.test(t)) return 'ritual';
    return 'neutral';
  }

  function tagScore(tag, profile) {
    const weight = { dark: profile.dark, bright: profile.bright, machine: profile.machine, organic: profile.organic, heavy: profile.heavy, ritual: profile.ritual }[categoryOf(tag)];
    return weight == null ? 0.35 : weight;
  }
  const avgTagScore = (row, profile) => {
    const tags = (row && row.tags) || [];
    if (!tags.length) return 0.3;
    return tags.slice(0, 4).reduce((sum, tag) => sum + tagScore(tag, profile), 0) / Math.min(4, tags.length);
  };

  const display = (zh, en) => {
    const hasEn = en && /[A-Za-z]/.test(en) && en.trim().split(/\s+/).length >= 2;
    return hasEn ? `${zh} (${en})` : zh;
  };

  /**
   * @param {string} seed 檔案指紋（檔名｜大小）
   * @param {{lexicon:object,audio:object,used:Set,usage:Map,salt:number}} opts
   */
  function generateFromAudio(seed, opts) {
    const o = opts || {};
    const lex = o.lexicon;
    if (!lex) throw new Error('corpus lexicon 未載入');
    const profile = profileFromAudio(o.audio);
    const rng = rngOf(seed + '|' + (o.salt || ''));
    const used = o.used || new Set();
    const usage = o.usage || new Map();
    const markUsage = (rows) => { for (const row of rows) { if (row) usage.set(row.zh, (usage.get(row.zh) || 0) + 1); } };
    const repeatPenalty = (parts) => parts.reduce((sum, part) => sum + ((part && usage.get(part.zh)) || 0), 0) * 0.7;

    const places = lex.places || [];
    const concepts = lex.concepts || [];
    const orgs = lex.orgs || [];
    const MUNDANE = /撬|棒|鎚|錘|釘|棍|鋼|螺|鉗|剪|匙|杯|瓶|器|槍|刀|銃|劍|鞭|矛|斧|弓|弩|盾|管|刃|鉤|爪|糞|屌|偽/;
    const weapons = (lex.weapons || []).filter((w) => zhLen(w.zh) <= 4 && w.iconic === true && !MUNDANE.test(w.zh));
    const devices = (lex.devices || []).filter((d) => d.short);
    const deviceFit = (device) => {
      const themeScore = (device.themes || []).reduce((sum, theme) => sum + tagScore(theme, profile), 0) / Math.max(1, (device.themes || []).length);
      return themeScore * 0.7 + tagScore(device.short, profile) * 0.3;
    };

    const candidate = [];
    const sourceOfKind = (kind) => (/^(place\+concept|org\+concept|short-weapon)$/.test(kind) ? 'night'
        : /^(elec-core|elec\+tail)$/.test(kind) ? 'elec' : 'mixed');
    const add = (kind, baseScore, parts, build) => candidate.push({ kind, baseScore, parts, build, source: sourceOfKind(kind) });

    // 1) 場所＋概念（需有關係）
    for (const place of places) for (const concept of concepts) {
        if (place === concept) continue;
        const tags = sharedTags(place, concept);
        const sameFaction = place.faction && concept.faction && place.faction === concept.faction;
        const named = (concept.tags || []).includes(place.zh);
        const weak = !tags.length && !sameFaction && !named
            && (place.tags || []).some((tag) => categoryOf(tag) !== 'neutral' && categoryOf(tag) === categoryOf((concept.tags || [])[0]));
        if (!tags.length && !sameFaction && !named && !weak) continue;
        const strength = tags.length * 0.45 + (sameFaction ? 0.2 : 0) + (named ? 0.4 : 0) + (weak ? 0.15 : 0);
        const relation = tags.length ? `共同 tag：${tags.slice(0, 2).join('、')}` : named ? `概念 tag 指名 ${place.zh}` : sameFaction ? `同勢力：${place.faction}` : '同語意類別';
        for (const useDe of zhLen(place.zh) + zhLen(concept.zh) > 6 ? [true] : [false, true]) {
            const zh = useDe ? `${place.zh}的${concept.zh}` : `${place.zh}${concept.zh}`;
            const en = useDe ? `${concept.en || ''} of ${place.en || ''}`.trim() : `${place.en || ''} ${concept.en || ''}`.trim();
            add('place+concept', strength + avgTagScore(concept, profile) * 0.8, [place, concept], () => ({ zh, en, reason: `場所＋概念（${relation}）` }));
        }
    }

    // 2) 組織（用別名）＋概念：概念 tag 指名該組織
    for (const org of orgs) for (const concept of concepts) {
        const tags = concept.tags || [];
        const aliases = Array.isArray(org.aliases) ? org.aliases.filter((alias) => zhLen(alias) >= 2 && zhLen(alias) <= 3) : [];
        const direct = tags.includes(org.zh) || aliases.some((alias) => tags.includes(alias));
        const factionHit = concept.faction && (concept.faction === org.zh || concept.faction === org.faction);
        if (!direct && !factionHit) continue;
        const headRow = aliases.length ? { zh: aliases[0], en: org.en } : org;
        const zh = headRow.zh + concept.zh;
        if (zhLen(zh) > 7) continue;
        add('org+concept', (direct ? 0.9 : 0.55) + avgTagScore(concept, profile) * 0.6, [headRow, concept],
            () => ({ zh, en: `${org.en || ''} ${concept.en || ''}`.trim(), reason: `組織＋概念（${direct ? '概念 tag 直接指名' : '同陣營'}：${org.zh}）` }));
    }

    // 3) 概念＋裝置短名：裝置主題要跟音樂特徵相符
    for (const concept of concepts) for (const device of devices) {
        const fit = deviceFit(device);
        if (fit < 0.42) continue;
        for (const useDe of [false, true]) {
            const zh = useDe ? `${concept.zh}的${device.short}` : `${concept.zh}${device.short}`;
            if (zhLen(zh) < 3 || zhLen(zh) > 7) continue;
            const en = `${concept.en || ''} ${device.shortEn || ''}`.trim();
            add('concept+device', fit + avgTagScore(concept, profile) * 0.5,
                [concept, { zh: device.short }],
                () => ({ zh, en, reason: `概念＋裝置（${device.zh}，出自《${device.work}》，${useDe ? '質地修飾' : '直接合成'}）` }));
        }
    }

    // 4) 場所＋裝置短名（電影感場景）
    for (const place of places) for (const device of devices) {
        const fit = deviceFit(device);
        if (fit < 0.5) continue;
        const zh = place.zh + device.short;
        if (zhLen(zh) > 7) continue;
        add('place+device', fit + avgTagScore(place, profile) * 0.4, [place, { zh: device.short }],
            () => ({ zh, en: `${place.en || ''} ${device.shortEn || ''}`.trim(), reason: `場所＋裝置（《${device.work}》的 ${device.short}）` }));
    }

    // 5) 抽象 × 具體：用句法把兩本書的詞接成有畫面、有哲理、偶爾荒謬的名字
    const themeCores = (lex.themeCores || []).filter((core) => zhLen(core.zh) >= 2 && zhLen(core.zh) <= 4);
    const sceneCores = [];
    const works = (lex.works || []).filter((work) => zhLen(work.zh) >= 2 && zhLen(work.zh) <= 6);
    const inspPool = (lex.inspiration || {});
    const concrete = [
        ...places.map((row) => ({ ...row, kind: 'place' })),
        ...devices.filter((device) => device.short).map((device) => ({ zh: device.short, en: device.shortEn, work: device.work, kind: 'device' })),
        ...works.map((row) => ({ ...row, kind: 'work' })),
        ...(inspPool.concrete || []).map((row) => ({ ...row, kind: 'insp' })),
    ];
    const abstract = [
        ...concepts.map((row) => ({ ...row, kind: 'concept' })),
        ...themeCores.map((row) => ({ ...row, kind: 'theme' })),
        ...(inspPool.abstract || []).map((row) => ({ ...row, kind: 'insp' })),
    ];
    const pairFit = (a, b) => {
        const score = avgTagScore(a, profile) * 0.5 + (b.theme ? tagScore(b.theme, profile) * 0.3 : 0);
        const cross = (a.kind === 'concept' && b.kind !== 'place') || (a.kind === 'theme' && b.kind === 'place') ? 0.25 : 0;
        return score + cross + (zhLen(a.zh) + zhLen(b.zh) <= 7 ? 0.2 : 0);
    };
    for (const a of abstract) {
        for (const b of concrete) {
            if (zhLen(a.zh) + zhLen(b.zh) > 6) continue;
            const fit = pairFit(a, b);
            add('A的B', 0.35 + fit, [a, b],
                () => ({ zh: `${a.zh}的${b.zh}`, en: '', reason: `句法：抽象（${a.zh}）的具體（${b.zh}）` }));
            add('A與B', 0.3 + fit, [a, b],
                () => ({ zh: `${a.zh}與${b.zh}`, en: '', reason: `並置：${a.zh} × ${b.zh}` }));
            add('在B的A', 0.22 + fit, [b, a],
                () => ({ zh: `在${b.zh}的${a.zh}`, en: '', reason: `場景裡的抽象：在${b.zh}的${a.zh}` }));
        }
    }

    // 5b) 靈感語料：子代理讀書後產出的短語、荒謬並置與句法
    const insp = lex.inspiration || {};
    const pickRows = (rows, n) => (rows || []).slice(0, n);
    for (const phrase of pickRows(insp.phrases)) {
        add('insp-phrase', 0.95 + tagScore(phrase.zh, profile) * 0.6, [{ zh: phrase.zh }],
            () => ({ zh: phrase.zh, en: '', reason: '靈感短語（讀書筆記）' }));
    }
    for (const absurd of pickRows(insp.absurd)) {
        add('insp-absurd', 0.9 + tagScore(absurd.zh, profile) * 0.5, [{ zh: absurd.zh }],
            () => ({ zh: absurd.zh, en: '', reason: '荒謬並置（讀書筆記）' }));
    }
    for (const pair of pickRows(insp.pairs, 60)) {
        if (!pair.a || !pair.b) continue;
        add('insp-pair', 0.45 + tagScore(pair.a, profile) * 0.4, [{ zh: pair.a }, { zh: pair.b }],
            () => ({ zh: `${pair.a}的${pair.b}`, en: '', reason: '荒謬配對：' + pair.a + '×' + pair.b }));
    }
    const inspAbstract = insp.abstract || [];
    const inspConcrete = insp.concrete || [];
    const inspVerbs = insp.verbs || [];
    const UNITS = ['赫茲', '分貝', '毫秒', '小時', '伏特', '樓層'];
    for (const a of inspAbstract) {
        for (const b of inspConcrete) {
            if (zhLen(a.zh) + zhLen(b.zh) > 7) continue;
            add('insp-A的B', 0.4 + tagScore(a.zh, profile) * 0.4, [a, b],
                () => ({ zh: `${a.zh}的${b.zh}`, en: '', reason: '句法：概念的私產' }));
            add('insp-A是B', 0.36 + tagScore(a.zh, profile) * 0.4, [a, b],
                () => ({ zh: `${a.zh}是${b.zh}`, en: '', reason: '句法：錯誤定義' }));
            add('insp-給A的B', 0.34 + tagScore(a.zh, profile) * 0.35, [a, b],
                () => ({ zh: `給${a.zh}的${b.zh}`, en: '', reason: '句法：給誰的供品' }));
            add('insp-沒有B的A', 0.33 + tagScore(a.zh, profile) * 0.35, [a, b],
                () => ({ zh: `沒有${b.zh}的${a.zh}`, en: '', reason: '句法：缺席定義' }));
            add('insp-B在V', 0.3, [b],
                () => ({ zh: `${b.zh}在${pick(inspVerbs) ? pick(inspVerbs).zh : '祈禱'}`, en: '', reason: '句法：機器的禮拜' }));
        }
        for (const verb of inspVerbs.slice(0, 12)) {
            const b = pick(inspConcrete);
            if (!b) break;
            add('insp-把A成B', 0.42, [a, b],
                () => ({ zh: `把${a.zh}${verb.zh}成${b.zh}`, en: '', reason: '句法：鍊金工單' }));
            add('insp-在B裡V', 0.4, [b],
                () => ({ zh: `在${b.zh}裡${verb.zh}`, en: '', reason: '句法：場所裡的儀式' }));
        }
        const unit = UNITS[Math.floor(rng() * UNITS.length)];
        const b = pick(inspConcrete);
        if (b && zhLen(a.zh) + unit.length + 1 <= 8) {
            const numberText = String(3 + Math.floor(rng() * 120));
            add('insp-計量', 0.38, [a],
                () => ({ zh: `${numberText}${unit}的${a.zh}`, en: '', reason: '句法：偽計量' }));
        }
    }

    // 6) 短武器名：快、重、有能量的曲子才用（高辨識度）
    if (profile.fast > 0.45 || profile.heavy > 0.85) {
        for (const weapon of weapons) {
            const tech = String(weapon.tech || '');
            const cat = String(weapon.cat || '');
            let score = 0.18 + profile.fast * 0.45;
            if (/tech/i.test(tech)) score += profile.machine * 0.4;
            if (/power/i.test(tech)) score += profile.heavy * 0.35;
            if (/melee|blade|blunt|club/i.test(cat)) score += profile.heavy * 0.45;
            add('short-weapon', score, [weapon], () => ({ zh: weapon.zh, en: weapon.en || '', reason: `短名（${cat}/${tech}）` }));
        }
    }

    const weighted = candidate
        .map((item) => {
            // 兩本書平衡：夜城類超過 45% 就壓低、電子百科超過 55% 也壓低；太少則拉高。
            const nightRatio = Number.isFinite(o.nightRatio) ? o.nightRatio : 0.4;
            const elecRatio = Number.isFinite(o.elecRatio) ? o.elecRatio : 0.3;
            let balance = 1;
            if (item.source === 'night' && nightRatio > 0.45) balance = 0.3;
            if (item.source === 'night' && nightRatio < 0.18) balance = 1.4;
            if (item.source === 'elec' && elecRatio > 0.55) balance = 0.3;
            if (item.source === 'elec' && elecRatio < 0.3) balance = 1.5;
            const weaponScale = item.kind === 'short-weapon' ? 0.7 : 1;
            return { item, total: item.baseScore * balance * weaponScale + (rng() - 0.5) * 0.6 };
        })
        .sort((a, b) => b.total - a.total);

    // 依「部件使用次數」由少到多挑：先挑沒用過的，再放寬，最後才接受重複。
    const limit = (maxUse) => {
        for (const entry of weighted) {
            const item = entry.item;
            const built = item.build();
            if (!built || !built.zh) continue;
            const zh = built.zh;
            if (zhLen(zh) < 2 || zhLen(zh) > 8) continue;
            const text = display(zh, built.en);
            if (used.has(text)) continue;
            if (maxUse != null && item.parts.some((part) => ((part && usage.get(part.zh)) || 0) >= maxUse)) continue;
            markUsage(item.parts);
            return { item, built, text, zh };
        }
        return null;
    };
    const chosen = limit(1) || limit(2) || limit(4) || limit(null);
    if (chosen) {
        const { item, built, text, zh } = chosen;
        return {
            zh,
            en: built.en || '',
            display: text,
            pattern: item.kind,
            reason: built.reason,
            profile: { bpm: profile.bpm, minor: profile.minor, energy: profile.energy },
            parts: item.parts.map((part) => part.zh),
        };
    }
    return null;
  }

  function generate(seed, opts) {
    const o = opts || {};
    return generateFromAudio(seed, { ...o, audio: o.audio || null });
  }

  const API = { generate, generateFromAudio, profileFromAudio, categoryOf, hash, rngOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.NOMEN_CORPUS = API;
})(typeof window !== 'undefined' ? window : globalThis);
