/* ============================================================
   命名爐 · 詞典模式（NOMENCLATOR / CORPUS）
   用《夜城人物事典》與《靈感電子百科大全》抽出的詞庫，做「有意義」的
   中文名 + 對應英文名；同一個 seed（檔案指紋）永遠得到同一個名字。
   純函數，瀏覽器與 Node 共用（Node 需 require('./corpus-lexicon.json')）。
   ============================================================ */
(function (global) {
  'use strict';

  const R = (global.NOMEN_CORPUS_LEXICON) || null; // 瀏覽器：先載入 corpus-lexicon.json 指定給這個全域

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

  // 電子／低頻語彙：只取「可以接在名字後面」的短詞，來源是電子百科的裝置與主題
  const TAILS = [
    ['迴路', 'Circuit'], ['儀式', 'Rite'], ['餘燼', 'Ember'], ['雜訊', 'Noise'],
    ['載體', 'Carrier'], ['迴聲', 'Echo'], ['頻段', 'Band'], ['殘響', 'Reverb'],
    ['底噪', 'Noise Floor'], ['訊號', 'Signal'], ['潮汐', 'Tide'], ['裂縫', 'Fissure'],
  ];
  const HEADS = [
    ['低頻', 'Sub'], ['深夜', 'Deep Night'], ['長波', 'Longwave'], ['霓虹', 'Neon'],
    ['冷光', 'Cold Light'], ['碎拍', 'Broken Beat'], ['暗場', 'Blackout'], ['地下', 'Underground'],
  ];

  function byTag(pool, tag, exclude) {
    const out = (pool || []).filter((row) => row !== exclude && Array.isArray(row.tags) && row.tags.includes(tag));
    return out;
  }

  /** 產生一個名：{ zh, en, pattern, parts } */
  function generate(seed, opts) {
    const o = opts || {};
    const lexicon = o.lexicon || R;
    if (!lexicon) throw new Error('corpus lexicon 未載入');
    const rng = rngOf(seed + '|' + (o.flavor || 'mixed'));
    const used = o.used || null;
    const places = lexicon.places || [];
    const concepts = lexicon.concepts || [];
    const weapons = (lexicon.weapons || []).filter((w) => /^[\u3400-\u9fff]{2,4}$/.test(w.zh));
    const tags = (lexicon.tags || []).map((x) => x.zh).filter((t) => zhLen(t) >= 2 && zhLen(t) <= 3);
    const avoid = o.avoid || null;

    for (let attempt = 0; attempt < 64; attempt++) {
      const roll = rng();
      let zh = '', en = '', pattern = '';
      if (roll < 0.3) {
        // 場所 + 概念：太平洲義體 / 日本街超夢
        const p = pick(rng, places), c = pick(rng, concepts);
        if (!p || !c || p === c) continue;
        zh = p.zh + c.zh; pattern = 'place+concept';
        en = p.en && c.en ? `${p.en} ${c.en}` : '';
      } else if (roll < 0.5) {
        // 短武器名 + 尾詞：野心迴路 / 幻影餘燼
        const w = pick(rng, weapons.filter((x) => zhLen(x.zh) <= 3));
        const t = pick(rng, TAILS);
        if (!w || !t) continue;
        zh = w.zh + t[0]; pattern = 'weapon+tail';
        en = w.en && t[1] ? `${w.en} ${t[1]}` : '';
      } else if (roll < 0.68) {
        // 標籤 + 概念：霓虹黑牆 / 禁區神輿
        const tag = pick(rng, tags);
        const c = byTag(concepts, tag).length ? pick(rng, byTag(concepts, tag)) : pick(rng, concepts);
        if (!tag || !c) continue;
        zh = (byTag(concepts, tag).length ? '' : tag) + c.zh; pattern = 'tag+concept';
        en = c.en || '';
      } else if (roll < 0.82) {
        // 頭詞 + 概念：低頻聖物 / 深夜企業
        const h = pick(rng, HEADS), c = pick(rng, concepts);
        if (!h || !c) continue;
        zh = h[0] + c.zh; pattern = 'head+concept';
        en = h[1] && c.en ? `${h[1]} ${c.en}` : (c.en || '');
      } else if (roll < 0.92) {
        // 概念 + 尾詞：義體迴路 / 超夢殘響
        const c = pick(rng, concepts), t = pick(rng, TAILS);
        if (!c || !t) continue;
        zh = c.zh + t[0]; pattern = 'concept+tail';
        en = c.en && t[1] ? `${c.en} ${t[1]}` : '';
      } else {
        // 純短名：幻影 / 青牙 / 白虎（武器庫就是最短、最有辨識度的詞）
        const w = pick(rng, weapons.filter((x) => zhLen(x.zh) <= 2));
        if (!w) continue;
        zh = w.zh; pattern = 'short';
        en = w.en || '';
      }

      if (!zh || zhLen(zh) < 2 || zhLen(zh) > 8) continue;
      if (avoid && avoid.has(zh)) continue;
      const display = o.paren === false ? zh : (en ? `${zh} (${en})` : zh);
      if (used && used.has(display)) continue;
      return { zh, en, display, pattern, parts: [zh] };
    }
    return null;
  }

  const API = { generate, hash, rngOf, TAILS, HEADS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.NOMEN_CORPUS = API;
})(typeof window !== 'undefined' ? window : globalThis);
