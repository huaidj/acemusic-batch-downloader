// src/prompts.js — 隨機提示詞引擎（純函式；瀏覽器面板與 Node agent 共用，不碰 DOM／網路）
//
// 設計原則（對應交接文件 §5–§7）：
//  1. 先確認「音樂模型＋模式」，再選詞典：詞典只對它驗證過的模型生效（dictionary.targets）。沒有對應詞典就不自動填入。
//  2. 長度以目標欄位的上限為準（Idea 的 prompt、Custom 的 style），不硬截字串：放不下就回報原因。
//  3. 隨機只用本地 seed（mulberry32）；權重 0 的詞永不抽中；同 seed＋同詞典版本可復現。
//  4. selection_weight 是產品內部的「抽選權重」，不是 ACE 的 influence，也不是模型提示詞權重。
(function () {
  'use strict';

  /** 站點的三個可見模型（/api/status 為準；這裡只是離線後備）。limits 單位：字元 */
  const MODEL_FALLBACK = Object.freeze({
    'acemusic-v1': { name: 'ACE Music v1', limits: { prompt: 2000, style: 1000, lyrics: 5000 } },
    'acemusic-v1.1': { name: 'ACE Music v1.1 Preview', limits: { prompt: 2000, style: 1000, lyrics: 5000 } },
    'ace-step-1.5-xl': { name: 'ACE-Step v1.5 XL', limits: { prompt: 2000, style: 512, lyrics: 2000 } },
  });

  /** 模式 → 頁面欄位：Idea 的自然語言框是 prompt；Custom 的 Style 框是 style（Lyrics 本工具預設留空） */
  const FIELD_BY_MODE = Object.freeze({ idea: 'prompt', custom: 'style' });

  /** 固定約束：每個輸出都必須含有（小寫比對）。缺任何一項就不給使用者 */
  const REQUIRED = Object.freeze([
    { id: 'instrumental', test: /\binstrumental\b/ },
    { id: 'no-vocals', test: /no vocals/ },
    { id: 'no-humming-chanting', test: /humming, chanting, speech or vocal samples/ },
    { id: 'sub-bass-centered', test: /sub-bass stays mono and centered/ },
  ]);

  function modelInfo(modelId, siteModels) {
    const id = String(modelId || '');
    const live = siteModels && (typeof siteModels.get === 'function' ? siteModels.get(id) : siteModels[id]);
    const fb = MODEL_FALLBACK[id] || null;
    if (!live && !fb) return null;
    const limits = (live && live.limits) || (fb && fb.limits) || null;
    return { id, name: (live && live.name) || (fb && fb.name) || id, limits, source: live ? 'site' : 'fallback' };
  }

  function dictionaries() {
    const data = globalThis.AceDLPromptData;
    return data && Array.isArray(data.dictionaries) ? data.dictionaries : [];
  }

  /**
   * 解析「這次要用哪個詞典、填哪個欄位、上限多少」。
   * status：ready ＝可自動填入；no_dictionary ＝這個模型／模式沒有驗證過的詞典；unknown_model ＝認不得模型；bad_mode
   */
  function resolveContext({ modelId, mode, siteModels } = {}) {
    const field = FIELD_BY_MODE[mode];
    if (!field) return { status: 'bad_mode', reason: '無法判斷目前是 Idea 還是 Custom 模式', modelId: modelId || '', mode: mode || '' };
    const info = modelInfo(modelId, siteModels);
    if (!info) return { status: 'unknown_model', reason: `不認得的模型「${modelId || '（讀不到）'}」，不自動填入`, modelId: modelId || '', mode, field };
    const limit = info.limits && Number(info.limits[field]) > 0 ? Number(info.limits[field]) : 0;
    const dict = dictionaries().find((d) => d.targets.includes(info.id) && d.modes.includes(mode)) || null;
    const base = { modelId: info.id, modelName: info.name, mode, field, limit, limitSource: info.source };
    if (!dict) {
      return { ...base, status: 'no_dictionary', reason: `「${info.name}」還沒有驗證過的詞典（目前詞典只對 ${dictionaries().flatMap((d) => d.targets).join('、') || '—'} 驗證），只提供複製，不自動填入` };
    }
    return { ...base, status: 'ready', dictionary: dict, dictionaryId: dict.id, dictionaryVersion: dict.version };
  }

  /** mulberry32：小而快的可復現 PRNG */
  function makeRng(seed) {
    let a = (Number(seed) >>> 0) || 0x9e3779b9;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function newSeed() {
    try {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      return buf[0] || 1;
    } catch (_) {
      return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
    }
  }

  /** 加權抽一個（不放回）；權重 ≤ 0、停用的永不抽中；沒有可抽的回 null */
  function weightedPick(items, rng, weightOf = (x) => x.selection_weight) {
    const pool = items.filter((x) => x && x.enabled !== false && Number(weightOf(x)) > 0);
    if (!pool.length) return null;
    const total = pool.reduce((s, x) => s + Number(weightOf(x)), 0);
    let r = rng() * total;
    for (const x of pool) {
      r -= Number(weightOf(x));
      if (r < 0) return x;
    }
    return pool[pool.length - 1];
  }

  /** 編譯一格：opening + A + B + closing；固定約束與長度必須通過（不截斷） */
  function compile(dict, aId, bId, limit) {
    const a = dict.axis_a.find((x) => x.id === aId);
    const b = dict.axis_b.find((x) => x.id === bId);
    if (!a || !b) return { ok: false, reason: `找不到格子 ${aId}×${bId}` };
    const text = [dict.opening_en, a.phrase_en, b.phrase_en, dict.closing_en].join(' ');
    const low = text.toLowerCase();
    const missing = REQUIRED.filter((r) => !r.test.test(low)).map((r) => r.id);
    if (missing.length) return { ok: false, reason: '缺少固定約束：' + missing.join('、'), a, b };
    if (limit > 0 && text.length > limit) {
      return { ok: false, reason: `長度 ${text.length} 超過這個欄位的上限 ${limit}（不硬截斷，需要這個模型專用的精簡詞典）`, length: text.length, a, b };
    }
    return { ok: true, text, length: text.length, a, b, cell: `${a.id}_${b.id}` };
  }

  /**
   * 隨機一格。lockA／lockB：固定某一軸（只變另一軸）；weightsA／weightsB：{ id: weight } 覆蓋（使用者調整）。
   * 回傳含完整追溯資訊：seed、詞典 id／版本、模型、模式、欄位、字數／上限。
   */
  function randomPrompt(options = {}) {
    const ctx = options.context || resolveContext(options);
    if (ctx.status !== 'ready') return { ok: false, status: ctx.status, reason: ctx.reason, context: ctx };
    const dict = ctx.dictionary;
    const seed = options.seed != null ? Number(options.seed) >>> 0 : newSeed();
    const rng = makeRng(seed);
    const w = (map) => (x) => (map && map[x.id] != null ? Number(map[x.id]) : x.selection_weight);
    const a = options.lockA ? dict.axis_a.find((x) => x.id === options.lockA) : weightedPick(dict.axis_a, rng, w(options.weightsA));
    const b = options.lockB ? dict.axis_b.find((x) => x.id === options.lockB) : weightedPick(dict.axis_b, rng, w(options.weightsB));
    if (!a || !b) return { ok: false, status: 'empty_pool', reason: options.lockA || options.lockB ? '鎖定的格子不存在' : '沒有可抽的詞條（權重都是 0 或已停用）', context: { ...ctx, dictionary: undefined } };
    const out = compile(dict, a.id, b.id, ctx.limit);
    const base = {
      seed,
      cell: `${a.id}_${b.id}`,
      a: { id: a.id, name_zh: a.name_zh },
      b: { id: b.id, name_zh: b.name_zh },
      model: ctx.modelId,
      modelName: ctx.modelName,
      mode: ctx.mode,
      field: ctx.field,
      limit: ctx.limit,
      dictionary: ctx.dictionaryId,
      dictionaryVersion: ctx.dictionaryVersion,
    };
    if (!out.ok) return { ok: false, status: 'compile_failed', reason: out.reason, ...base };
    return { ok: true, status: 'ready', text: out.text, length: out.length, ...base };
  }

  /** 一次產生多組、彼此不同的格子（同一 seed 可復現） */
  function randomBatch(options = {}, count = 6) {
    const results = [];
    const seen = new Set();
    const baseSeed = options.seed != null ? Number(options.seed) >>> 0 : newSeed();
    for (let i = 0; i < count * 6 && results.length < count; i += 1) {
      const r = randomPrompt({ ...options, seed: (baseSeed + i * 7919) >>> 0 });
      if (!r.ok) return results.length ? results : [r];
      if (seen.has(r.cell)) continue;
      seen.add(r.cell);
      results.push(r);
    }
    return results;
  }

  globalThis.AceDLPrompts = Object.freeze({
    MODEL_FALLBACK,
    FIELD_BY_MODE,
    REQUIRED,
    resolveContext,
    makeRng,
    newSeed,
    weightedPick,
    compile,
    randomPrompt,
    randomBatch,
  });
})();
