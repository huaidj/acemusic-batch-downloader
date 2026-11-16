/* ============================================================
   命名爐 NOMENCLATOR · SUB-110 — 應用層
   單頁裝置：曲庫 / 名刻 / 校準 / 匯出
   ============================================================ */
(() => {
  'use strict';

  const N = window.NOMEN;
  const G = window.NOMEN_GROUP || { groupEntries: () => ({ groups: new Map(), groupOf: new Map() }) };
  const LIB = window.NOMEN_LIBRARY || { titles: [], tracks: [] };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'aiff', 'aif', 'opus', 'wma', 'mp4']);
  const LS_KEY = 'nominator.v1';
  const DEFAULT_ROOT = String.raw`%USERPROFILE%\Downloads\ai音樂`;
  const MAX_ENTRIES = 4000;

  const el = {
    statMode: $('#statMode'), statCount: $('#statCount'), statAdopted: $('#statAdopted'),
    seedHex: $('#seedHex'),
    drop: $('#drop'), btnFiles: $('#btnFiles'), btnDir: $('#btnDir'), btnDemo: $('#btnDemo'),
    search: $('#search'), chips: $('#chips'), list: $('#list'), bayHint: $('#bayHint'), btnRandom: $('#btnRandom'),
    slab: $('#slab'), rulerMarker: $('#rulerMarker'), rulerVal: $('#rulerVal'),
    regMark: $('#regMark'), code: $('#code'), namestack: $('#namestack'),
    nameZh: $('#nameZh'), nameEn: $('#nameEn'), srcLine: $('#srcLine'), groupLine: $('#groupLine'),
    sig: $('#sig'), sigLabel: $('#sigLabel'),
    mBpm: $('#mBpm'), mKey: $('#mKey'), mCam: $('#mCam'), mLen: $('#mLen'), mEnergy: $('#mEnergy'),
    srcDot: $('#srcDot'), sourceTag: $('#sourceTag'),
    btnAdopt: $('#btnAdopt'), btnReroll: $('#btnReroll'), btnCopy: $('#btnCopy'), btnPlay: $('#btnPlay'),
    playGlyph: $('#playGlyph'), alts: $('#alts'),
    analysisStatus: $('#analysisStatus'), seedShort: $('#seedShort'),
    mix: $('#mix'), mixVal: $('#mixVal'), shake: $('#shake'), shakeVal: $('#shakeVal'),
    seg: $('#seg'), fmt: $('#fmt'), root: $('#root'),
    btnPs1: $('#btnPs1'), btnCsv: $('#btnCsv'), btnJson: $('#btnJson'),
    btnConnect: $('#btnConnect'), btnApply: $('#btnApply'),
    btnBatch: $('#btnBatch'), btnClear: $('#btnClear'),
    ticker: $('#ticker'), toast: $('#toast'),
    fileInput: $('#fileInput'), dirInput: $('#dirInput'),
    corpusTracks: $('#corpusTracks'), corpusDown: $('#corpusDown'), corpusTitles: $('#corpusTitles'),
    corpusGroups: $('#corpusGroups'), corpusStems: $('#corpusStems'), hint: $('#hint')
  };

  const state = {
    entries: [],
    byId: new Map(),
    filtered: [],
    selId: null,
    settings: { mix: 50, shake: 52, register: 'auto' },
    format: 'paren',
    root: DEFAULT_ROOT,
    filter: 'reps',
    search: '',
    adopted: {},
    salts: {},
    cands: [],
    candIndex: 0,
    seedBase: '',
    playing: null,
    playRaf: 0,
    pendingManifest: new Map(),
    groups: new Map(),
    groupOf: new Map(),
    libraryMode: true
  };

  let EXISTING = N.prepareExisting((LIB.titles || []).concat((LIB.tracks || []).map(t => t.name)));
  function refreshExisting() {
    EXISTING = N.prepareExisting((LIB.titles || []).concat((LIB.tracks || []).map(t => t.name)));
  }
  const EXT = window.NOMEN_EXT_MODE && window.NOMEN_EXT ? window.NOMEN_EXT : null;

  /* ───────── 小工具 ───────── */

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const basename = p => (p || '').split(/[\\/]/).pop() || '';
  const extOf = p => { const m = basename(p).match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; };
  const stripExt = p => basename(p).replace(/\.[^.]+$/, '');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDur(sec) {
    if (!sec || !isFinite(sec)) return '—';
    const s = Math.round(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtKey(k) {
    if (!k) return '—';
    return String(k).replace(':minor', ' min').replace(':major', ' maj').replace(':', ' ');
  }

  function hex8(str) { return '0x' + N.hashStr(str).toString(16).toUpperCase().padStart(8, '0'); }

  let toastTimer = 0;
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  function copyText(text) {
    const fallback = () => new Promise((res, rej) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        const ok = document.execCommand('copy');
        ta.remove();
        ok ? res() : rej(new Error('copy failed'));
      } catch (e) {
        ta.remove();
        rej(e);
      }
    });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(fallback);
    }
    return fallback();
  }

  function setStatus(text) {
    el.analysisStatus.textContent = text || '—';
  }

  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        settings: state.settings,
        format: state.format,
        root: state.root,
        adopted: state.adopted
      }));
    } catch (e) { /* 空間不足時忽略 */ }
  }

  function restore() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    if (saved.settings) {
      state.settings.mix = clamp(Number(saved.settings.mix ?? 50), 0, 100);
      state.settings.shake = clamp(Number(saved.settings.shake ?? 52), 0, 100);
      state.settings.register = ['auto', 'sigil', 'liturgy', 'pair', 'abstract'].includes(saved.settings.register) ? saved.settings.register : 'auto';
    }
    if (saved.format) state.format = saved.format;
    if (saved.root) state.root = saved.root;
    if (saved.adopted && typeof saved.adopted === 'object') {
      for (const [k, v] of Object.entries(saved.adopted)) {
        if (v && typeof v === 'object' && v.zh) state.adopted[k] = v;
      }
    }
  }

  /* ───────── 資料載入 ───────── */

  function makeEntry(rel, file, meta) {
    const clean = String(rel).replace(/\\/g, '/');
    const ext = extOf(clean);
    const name = stripExt(clean);
    const m = meta || {};
    return {
      id: clean,
      rel: clean,
      name,
      ext,
      file: file || m.file || null,
      fileHandle: m.handle || null,
      size: m.size || (file ? file.size : 0),
      bpm: m.bpm != null ? Math.round(m.bpm * 10) / 10 : null,
      key: m.key || '',
      cam: m.camelot || '',
      duration: m.duration != null ? Number(m.duration) : null,
      energyRaw: m.energy != null ? Number(m.energy) : null,
      energy: m.energy != null ? N.normEnergy(Number(m.energy)) : .35,
      brightness: null,
      peaks: null,
      bpmEstimated: !!m.estimated,
      analysed: false,
      analysing: false,
      buffer: null,
      trackKind: m.kind || '',
      source: file ? 'file' : 'manifest'
    };
  }

  function loadLibrary(autoSelect = true) {
    stopPlayback();
    state.libraryMode = true;
    state.selId = null;
    const tracks = (LIB.tracks || []).slice(0, MAX_ENTRIES).map(t => makeEntry(t.rel, t.file || null, {
      kind: t.kind, bpm: t.bpm, key: t.key, camelot: t.cam, duration: t.dur, energy: t.en,
      handle: t.handle, size: t.size
    }));
    setEntries(tracks);
    el.bayHint.textContent = `示範曲庫 ${tracks.length} 檔 · ${state.groups.size} 組 · 分軌共用名字`;
    if (autoSelect) {
      const idx = Math.min(10, Math.max(0, state.filtered.length - 1));
      if (state.filtered[idx]) select(state.filtered[idx].id);
    }
  }

  function setEntries(list) {
    const seen = new Set();
    state.entries = [];
    for (const e of list) {
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      state.entries.push(e);
    }
    state.entries.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hant'));
    state.byId = new Map(state.entries.map(e => [e.id, e]));
    const grouped = G.groupEntries(state.entries);
    state.groups = grouped.groups;
    state.groupOf = grouped.groupOf;
    el.statCount.textContent = state.entries.length;
    if (state.pendingManifest.size) applyPendingManifest();
    applyFilter();
    updateAdoptedStat();
    updateCorpus();
    if (!state.byId.has(state.selId)) {
      state.selId = null;
      const first = state.filtered[0];
      if (first) select(first.id);
      else clearStage();
    }
  }

  function mergeMeta(entry, m) {
    if (m.bpm != null && isFinite(m.bpm)) entry.bpm = Math.round(Number(m.bpm) * 10) / 10;
    if (m.key) entry.key = m.key;
    if (m.camelot) entry.cam = m.camelot;
    if (m.duration != null) entry.duration = Number(m.duration);
    if (m.energy != null) {
      entry.energyRaw = Number(m.energy);
      entry.energy = N.normEnergy(Number(m.energy));
    }
    if (entry.source !== 'file') entry.source = 'manifest';
  }

  function ingestManifest(json) {
    const items = Array.isArray(json) ? json : (json && (json.items || json.files || json.entries)) || [];
    const map = new Map();
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const rel = it.relative || it.file || it.path;
      if (!rel) continue;
      const base = stripExt(rel).toLowerCase();
      if (!base) continue;
      map.set(base, {
        bpm: it.bpm, key: it.key, camelot: it.camelot,
        duration: it.duration, energy: it.energy
      });
    }
    let hits = 0;
    for (const e of state.entries) {
      const m = map.get(e.name.toLowerCase());
      if (m) { mergeMeta(e, m); hits++; }
    }
    if (hits === 0) {
      for (const [k, v] of map) state.pendingManifest.set(k, v);
    }
    return { hits, total: map.size };
  }

  function applyPendingManifest() {
    let hits = 0;
    for (const e of state.entries) {
      const m = state.pendingManifest.get(e.name.toLowerCase());
      if (m) { mergeMeta(e, m); hits++; }
    }
    if (hits) {
      state.pendingManifest.clear();
      applyFilter();
      if (current()) { buildCandidates(); renderStage(); }
      toast(`已套用分析清單 · ${hits} 首`);
    }
  }

  /* ───────── 選取 ───────── */

  function current() { return state.selId ? state.byId.get(state.selId) : null; }

  function select(id) {
    if (!state.byId.has(id)) return;
    if (state.selId === id) return;
    stopPlayback();
    state.selId = id;
    state.candIndex = 0;
    state.cands = [];
    state.seedBase = '';
    const e = state.byId.get(id);
    if (!state.adopted[id]) buildCandidates();
    renderStage();
    markSelectedRow();
    updateSeedReadout();
    if (e && e.file && !e.analysed) ensureAnalysis(e).catch(() => {});
    if (e && e.peaks) drawSignature(e.peaks, 0);
    else if (e) drawSignature(signatureFor(e), 0);
  }

  function markSelectedRow() {
    const rows = el.list.querySelectorAll('.row');
    for (const r of rows) {
      const on = r.dataset.id === state.selId;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) r.scrollIntoView({ block: 'center' });
    }
  }

  /* ───────── 名冊 / 過濾 ───────── */

  function applyFilter() {
    const q = state.search.trim().toLowerCase();
    state.filtered = state.entries.filter(e => {
      if (state.filter === 'reps') {
        const g = state.groups.get(e.groupKey);
        if (g && g.rep.id !== e.id) return false;
      }
      if (state.filter === 'down' && !(e.bpm && e.bpm >= 105 && e.bpm <= 118)) return false;
      if (state.filter === 'pending' && state.adopted[e.id]) return false;
      if (q && !(e.name.toLowerCase().includes(q) || e.rel.toLowerCase().includes(q))) return false;
      return true;
    });
    renderList();
  }

  function renderList() {
    const frag = document.createDocumentFragment();
    const rows = state.filtered.slice(0, 1500);
    for (let ri = 0; ri < rows.length; ri++) {
      const e = rows[ri];
      const ad = state.adopted[e.id];
      const grp = state.groups.get(e.groupKey);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row' + (e.id === state.selId ? ' sel' : '') + (ad ? ' adopted' : '');
      btn.dataset.id = e.id;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', e.id === state.selId ? 'true' : 'false');
      btn.title = e.rel + (grp && grp.count > 1 ? `　·　組 ${grp.base}（${grp.count} 檔）` : '');

      const idx = document.createElement('span');
      idx.className = 'row-idx';
      idx.textContent = String(ri + 1).padStart(3, '0');

      const nm = document.createElement('span');
      nm.className = 'row-name';
      const b = document.createElement('b');
      b.textContent = ad ? ad.zh : e.name;
      const em = document.createElement('em');
      const bits = [];
      if (e.stem) bits.push(e.stem);
      else if (grp && grp.count > 1) bits.push(grp.count + '檔');
      if (ad) bits.push(ad.en);
      else {
        bits.push(fmtKey(e.key));
        bits.push(fmtDur(e.duration));
      }
      em.textContent = bits.join(' · ');
      nm.append(b, em);

      const bpm = document.createElement('span');
      bpm.className = 'row-bpm';
      bpm.textContent = e.bpm ? (e.bpmEstimated ? '~' : '') + Math.round(e.bpm) : '—';

      const dot = document.createElement('span');
      dot.className = 'row-dot';

      btn.append(idx, nm, bpm, dot);
      btn.addEventListener('click', () => select(e.id));
      frag.append(btn);
    }
    if (!rows.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.innerHTML = state.entries.length
        ? '沒有符合條件的曲目<br>試著清除搜尋或換個篩選'
        : '曲庫是空的<br>拖入音檔或資料夾，或按「示範曲庫」';
      frag.append(d);
    } else if (state.filtered.length > rows.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = `僅顯示前 ${rows.length} 首 · 還有 ${state.filtered.length - rows.length} 首，請用搜尋縮小範圍`;
      frag.append(d);
    }
    el.list.replaceChildren(frag);
    markSelectedRow();
  }

  /* ───────── 生成 ───────── */

  function trackForEngine(e) {
    return {
      rel: e.rel, name: e.name,
      size: e.size || (e.file ? e.file.size : 0),
      bpm: e.bpm, key: e.key, duration: e.duration,
      energy: e.energy, brightness: e.brightness
    };
  }

  function groupFor(e) { return e ? state.groups.get(e.groupKey) : null; }
  function groupRep(e) { const g = groupFor(e); return g ? g.rep : e; }
  function groupMembers(e) { const g = groupFor(e); return g ? g.members : (e ? [e] : []); }

  function buildCandidates() {
    const e = current();
    if (!e) { state.cands = []; return; }
    const g = groupFor(e);
    const rep = g ? g.rep : e;
    const saltKey = g ? g.key : e.id;
    const salt = state.salts[saltKey] || 0;
    const seedBase = N.trackSeed(trackForEngine(rep), salt);
    const used = new Set();
    for (const [id, ad] of Object.entries(state.adopted)) {
      if (!g || state.groupOf.get(id) !== g.key) used.add(N.normZh(ad.zh) + '|' + N.normEn(ad.en));
    }
    const cands = N.candidates(trackForEngine(rep), state.settings, 3, {
      seed: seedBase,
      existing: EXISTING,
      used
    });
    state.seedBase = seedBase;
    state.cands = cands;
    if (state.candIndex >= cands.length) state.candIndex = 0;
  }

  function reroll() {
    const e = current();
    if (!e) return;
    const g = groupFor(e);
    const members = groupMembers(e);
    let had = false;
    for (const m of members) {
      if (state.adopted[m.id]) { delete state.adopted[m.id]; had = true; }
    }
    if (had) {
      persist();
      updateAdoptedStat();
      applyFilter();
      toast('已解除採用 · 重新擲名' + (members.length > 1 ? `（整組 ${members.length} 檔）` : ''));
    }
    const key = g ? g.key : e.id;
    state.salts[key] = (state.salts[key] || 0) + 1;
    state.candIndex = 0;
    buildCandidates();
    renderStage();
    updateSeedReadout();
    flashScan();
  }

  function flashScan() {
    el.slab.classList.remove('scanning');
    void el.slab.offsetWidth;
    el.slab.classList.add('scanning');
    setTimeout(() => el.slab.classList.remove('scanning'), 800);
  }

  function updateSeedReadout() {
    const e = current();
    const g = e ? groupFor(e) : null;
    const key = g ? g.key : (e ? e.id : '');
    const salt = key ? (state.salts[key] || 0) : 0;
    const ad = e ? state.adopted[e.id] : null;
    const seed = ad ? (ad.seed || '') : state.seedBase;
    el.seedShort.textContent = seed ? hex8(seed + '|' + salt) : '—';
    el.seedHex.textContent = seed ? hex8(seed) : '0x00000000';
  }

  /* ───────── 畫面 ───────── */

  function clearStage() {
    el.nameZh.textContent = '—';
    el.nameEn.textContent = '—';
    el.srcLine.textContent = '—';
    el.groupLine.textContent = '—';
    el.regMark.textContent = '—';
    el.code.textContent = 'No. —';
    el.alts.replaceChildren();
    el.mBpm.textContent = '—';
    el.mKey.textContent = '—';
    el.mCam.textContent = '—';
    el.mLen.textContent = '—';
    setEnergy(0);
    setRuler(null);
    drawSignature(signatureFor({ id: 'empty', name: 'empty' }), 0);
    setStatus('等待曲目');
  }

  function setRuler(bpm) {
    if (!bpm) { el.rulerMarker.style.display = 'none'; return; }
    el.rulerMarker.style.display = 'block';
    const p = clamp((bpm - 70) / 100, 0, 1) * 100;
    el.rulerMarker.style.left = p.toFixed(2) + '%';
    el.rulerVal.textContent = Math.round(bpm);
  }

  function setEnergy(v) {
    const n = clamp(Math.round((v || 0) * 6), 0, 6);
    el.mEnergy.replaceChildren(...Array.from({ length: 6 }, (_, i) => {
      const i2 = document.createElement('i');
      if (i < n) i2.className = 'on';
      i2.style.height = (30 + i * 12) + '%';
      return i2;
    }));
  }

  function renderStage() {
    const e = current();
    if (!e) { clearStage(); return; }
    const g = groupFor(e);
    const rep = g ? g.rep : e;
    const ad = state.adopted[e.id];
    const c = ad || state.cands[state.candIndex];
    if (!c) {
      el.nameZh.textContent = '—';
      el.nameEn.textContent = '無法生成 · 請重擲';
      return;
    }
    el.nameZh.textContent = c.zh;
    el.nameEn.textContent = c.en;
    el.srcLine.textContent = '來源 · ' + relFromRoot(e.rel) + (ad ? '　·　已採用' : '');
    if (g && g.count > 1) {
      el.groupLine.textContent = `組 · ${g.base} × ${g.count} 檔${g.stems ? `（分軌 ${g.stems}）` : ''} · 共用一名`;
    } else {
      el.groupLine.textContent = e.stem ? `單曲 · 分軌 ${e.stem}` : '單曲';
    }
    el.regMark.textContent = (N.REGISTERS[c.register] ? N.REGISTERS[c.register].label + ' · ' + N.REGISTERS[c.register].en : '名');
    el.code.textContent = 'No. ' + (c.code || '—');
    el.mBpm.textContent = e.bpm ? (e.bpmEstimated ? '~' : '') + Math.round(e.bpm) : '—';
    el.mKey.textContent = fmtKey(e.key);
    el.mCam.textContent = e.cam || '—';
    el.mLen.textContent = fmtDur(e.duration);
    setEnergy(e.energy);
    setRuler(e.bpm);
    el.srcDot.classList.toggle('live', !!e.file);
    el.sourceTag.textContent = e.analysed ? 'DECODED' : (e.source === 'file' ? 'FILE · 未解碼' : 'MANIFEST');
    const sigEntry = e.peaks ? e : rep;
    el.sigLabel.textContent = sigEntry.peaks ? 'WAVEFORM' : 'SEED SIGNATURE';
    el.slab.classList.remove('in');
    el.namestack.classList.remove('in');
    void el.namestack.offsetWidth;
    el.namestack.classList.add('in');
    fitName();
    renderAlts(ad, c);
    el.btnAdopt.disabled = !!ad;
    el.btnAdopt.innerHTML = ad ? '已採用 ✓' : '採用 <kbd>↵</kbd>';

    setStatus(statusText(e));
    el.code.title = c.code || '';
    updateSeedReadout();
    if (sigEntry.peaks) drawSignature(sigEntry.peaks, 0);
    else drawSignature(signatureFor(sigEntry), 0);
  }

  function statusText(e) {
    if (e.analysing) return '解碼 / 指紋分析中…';
    if (e.analysed) return `音頻分析 · ${e.bpm ? e.bpm + ' BPM' : 'BPM 未定'} · ${fmtDur(e.duration)}`;
    if (e.file) return '未解碼 · 按 P 試聽並分析';
    return '清單資料 · ' + (e.bpm ? e.bpm + ' BPM' : '未有 BPM');
  }

  function renderAlts(ad, currentCand) {
    const e = current();
    const frag = document.createDocumentFragment();
    if (ad) {
      const g = groupFor(e);
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = ad.applied
        ? '已改名 · 回 ACE 面板按「一鍵整理」重建索引；重新連接後可看到新檔名'
        : `已採用${g && g.count > 1 ? `（整組 ${g.count} 檔）` : ''} · 按 R 解除並重擲　·　重新選其他提案會覆蓋採用`;
      frag.append(d);
      el.alts.replaceChildren(frag);
      return;
    }
    state.cands.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'alt' + (i === state.candIndex ? ' on' : '');
      const reg = N.REGISTERS[c.register] || { label: '名', en: 'NAME' };
      b.innerHTML = `<span class="alt-reg">${esc(reg.label)} · ${esc(reg.en)}</span>
        <span class="alt-name">${esc(c.zh)}</span>
        <span class="alt-en">${esc(c.en)}</span>`;
      b.addEventListener('click', () => {
        state.candIndex = i;
        renderStage();
        flashScan();
      });
      frag.append(b);
    });
    el.alts.replaceChildren(frag);
  }

  function fitName() {
    const stack = el.namestack;
    const text = el.nameZh.textContent || '';
    const len = Math.max(1, Array.from(text).length);
    const w = stack.clientWidth || 640;
    const h = stack.clientHeight || 200;
    const byW = (w * 0.96) / (len * 1.1);
    const byH = h * 0.6;
    const cap = len <= 4 ? 132 : 112;
    const size = Math.round(clamp(Math.min(byW, byH), 34, cap));
    el.nameZh.style.fontSize = size + 'px';
    el.nameEn.style.fontSize = (size < 52 ? 10.5 : size < 72 ? 12 : 14) + 'px';
    const en = el.nameEn.textContent || '';
    el.nameEn.style.letterSpacing = en.length > 34 ? '0.18em' : en.length > 24 ? '0.26em' : '0.34em';
  }

  /* ───────── 波形 / 指紋 ───────── */

  function signatureFor(entry) {
    const rng = N.makeRng(N.hashStr((entry.id || '') + '|' + (entry.name || '')));
    const arr = new Float32Array(132);
    let v = .45;
    for (let i = 0; i < arr.length; i++) {
      v = clamp(v + (rng() - .5) * .5, .08, 1);
      const env = .35 + .65 * Math.sin(Math.PI * (i + 2) / (arr.length + 4));
      arr[i] = Math.max(.05, v * env);
    }
    return arr;
  }

  function drawSignature(peaks, progress) {
    const c = el.sig;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || 640;
    const h = 58;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = peaks.length;
    const gap = 1.5;
    const bw = Math.max(1, (w - gap * (n - 1)) / n);
    const mid = h / 2;
    for (let i = 0; i < n; i++) {
      const amp = clamp(peaks[i], 0, 1);
      const bh = Math.max(1.2, amp * (h - 8));
      const x = i * (bw + gap);
      const played = progress > 0 && (i / n) <= progress;
      ctx.fillStyle = played ? 'rgba(255,75,31,.95)' : 'rgba(236,228,212,.22)';
      ctx.fillRect(x, mid - bh / 2, bw, bh);
    }
    ctx.fillStyle = 'rgba(236,228,212,.10)';
    ctx.fillRect(0, mid, w, 1);
  }

  function redrawSignature() {
    const e = current();
    if (!e) return;
    let prog = 0;
    if (state.playing) prog = playbackProgress();
    drawSignature(e.peaks || signatureFor(e), prog);
  }

  /* ───────── 音頻 ───────── */

  let audioCtx = null;
  function getCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  async function decodeEntry(entry) {
    const file = entry.file;
    if (!file) throw new Error('no file');
    if (file.size > 200 * 1024 * 1024) throw new Error('檔案過大（>200MB）');
    const ab = await file.arrayBuffer();
    const buf = await getCtx().decodeAudioData(ab);
    return buf;
  }

  async function ensureAnalysis(entry, opts) {
    if (entry.analysed || !entry.file) return entry;
    if (entry.analysing) {
      while (entry.analysing) await new Promise(r => setTimeout(r, 80));
      return entry;
    }
    entry.analysing = true;
    if (entry.id === state.selId) setStatus('解碼 / 指紋分析中…');
    const t0 = performance.now();
    try {
      const buf = await decodeEntry(entry);
      const a = analyseBuffer(buf);
      entry.bpm = a.bpm || entry.bpm;
      entry.bpmEstimated = true;
      entry.duration = a.duration;
      entry.energy = a.energy;
      entry.brightness = a.brightness;
      entry.peaks = a.peaks;
      entry.analysed = true;
      entry.buffer = buf;
      trimBuffers(entry);
      if (entry.id === state.selId) {
        if (!state.adopted[entry.id]) buildCandidates();
        renderStage();
        drawSignature(entry.peaks, 0);
        setStatus(`音頻分析 · ${entry.bpm} BPM · ${fmtDur(entry.duration)} · ${Math.round(performance.now() - t0)}ms`);
      }
      applyFilter();
    } catch (err) {
      entry.analysing = false;
      if (entry.id === state.selId) setStatus('解碼失敗：' + (err && err.message ? err.message.slice(0, 40) : '未知錯誤'));
      toast('無法解碼此檔，將以清單資料命名');
      return entry;
    }
    entry.analysing = false;
    return entry;
  }

  const bufferOrder = [];
  function trimBuffers(keep) {
    bufferOrder.push(keep.id);
    while (bufferOrder.length > 2) {
      const oldId = bufferOrder.shift();
      const old = state.byId.get(oldId);
      if (old && old !== keep && !(state.playing && state.playing.id === oldId)) {
        old.buffer = null;
      }
    }
  }

  function stopPlayback() {
    if (state.playing) {
      try { state.playing.src.stop(); } catch (e) { }
      try { state.playing.src.disconnect(); } catch (e) { }
      state.playing = null;
    }
    if (state.playRaf) { cancelAnimationFrame(state.playRaf); state.playRaf = 0; }
    if (el.playGlyph) el.playGlyph.textContent = '▶';
    const e = current();
    if (e) drawSignature(e.peaks || signatureFor(e), 0);
  }

  function playbackProgress() {
    if (!state.playing) return 0;
    const t = getCtx().currentTime - state.playing.startedAt;
    return clamp(t / (state.playing.duration || 1), 0, 1);
  }

  async function togglePlay() {
    if (state.playing) { stopPlayback(); renderStage(); return; }
    const e = current();
    if (!e) return;
    if (!e.file) { toast('示範曲庫沒有音檔 · 拖入資料夾即可試聽'); return; }
    if (!e.analysed) await ensureAnalysis(e);
    if (!e.buffer) { toast('無法播放'); return; }
    const ctx = getCtx();
    const src = ctx.createBufferSource();
    src.buffer = e.buffer;
    const gain = ctx.createGain();
    gain.gain.value = .85;
    src.connect(gain).connect(ctx.destination);
    src.onended = () => {
      if (state.playing && state.playing.src === src) { stopPlayback(); }
    };
    src.start();
    state.playing = { src, startedAt: ctx.currentTime, duration: e.buffer.duration, id: e.id };
    if (el.playGlyph) el.playGlyph.textContent = '■';
    const tick = () => {
      if (!state.playing) return;
      drawSignature(e.peaks || signatureFor(e), playbackProgress());
      state.playRaf = requestAnimationFrame(tick);
    };
    state.playRaf = requestAnimationFrame(tick);
  }

  /* ───────── BPM / 音頻分析 ───────── */

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const j2 = i + k + len / 2;
          const vr = re[j2] * cr - im[j2] * ci;
          const vi = re[j2] * ci + im[j2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[j2] = ur - vr; im[j2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  let hann = null;
  function estimateBpm(data, sr) {
    const NFFT = 1024, hop = 256;
    const frames = Math.floor((data.length - NFFT) / hop);
    if (frames < 400) return null;
    if (!hann || hann.length !== NFFT) {
      hann = new Float32Array(NFFT);
      for (let i = 0; i < NFFT; i++) hann[i] = .5 - .5 * Math.cos(2 * Math.PI * i / (NFFT - 1));
    }
    const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
    const flux = new Float32Array(frames);
    let prev = null;
    for (let f = 0; f < frames; f++) {
      const off = f * hop;
      for (let i = 0; i < NFFT; i++) { re[i] = (data[off + i] || 0) * hann[i]; im[i] = 0; }
      fft(re, im);
      const mag = new Float32Array(NFFT / 2);
      for (let i = 0; i < NFFT / 2; i++) mag[i] = Math.log1p(120 * Math.sqrt(re[i] * re[i] + im[i] * im[i]));
      if (prev) {
        let s = 0;
        for (let i = 0; i < NFFT / 2; i++) { const d = mag[i] - prev[i]; if (d > 0) s += d; }
        flux[f] = s;
      }
      prev = mag;
    }
    const W = 43;
    const onset = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(frames - 1, i + W); j++) { s += flux[j]; c++; }
      onset[i] = Math.max(0, flux[i] - s / c);
    }
    const fps = sr / hop;
    const minLag = Math.floor(fps * 60 / 180), maxLag = Math.ceil(fps * 60 / 55);
    const S = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0, c = 0;
      for (let i = lag; i < frames; i++) { sum += onset[i] * onset[i - lag]; c++; }
      S[lag] = sum / Math.max(1, c);
    }
    const prior = bpm => Math.exp(-Math.pow(Math.log2(bpm / 112), 2) / (2 * .33 * .33));
    let bestBpm = 0, bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let v = S[lag];
      if (lag * 2 <= maxLag) v += .55 * S[lag * 2];
      if (lag * 3 <= maxLag) v += .3 * S[lag * 3];
      if (lag * 4 <= maxLag) v += .15 * S[lag * 4];
      const bpm = fps * 60 / lag;
      const score = v * prior(bpm);
      if (score > bestScore) { bestScore = score; bestBpm = bpm; }
    }
    let bpm = bestBpm;
    while (bpm < 74) bpm *= 2;
    while (bpm > 170) bpm /= 2;
    return Math.round(bpm);
  }

  function analyseBuffer(buf) {
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const dur = buf.duration;

    // 波形峰值
    const NP = 132;
    const peaks = new Float32Array(NP);
    const step = Math.max(1, Math.floor(ch0.length / NP));
    let maxAll = 1e-6;
    for (let i = 0; i < NP; i++) {
      let m = 0;
      const start = i * step, end = Math.min(ch0.length, start + step);
      for (let j = start; j < end; j += 6) {
        const v = Math.abs(ch0[j]) + (ch1 ? Math.abs(ch1[j]) : 0);
        if (v > m) m = v;
      }
      peaks[i] = m;
      if (m > maxAll) maxAll = m;
    }
    for (let i = 0; i < NP; i++) peaks[i] = clamp(peaks[i] / maxAll, .04, 1);

    // 降混 + 降取樣
    const factor = Math.max(1, Math.round(sr / 22050));
    const dsRate = sr / factor;
    const maxSeconds = Math.min(72, Math.max(20, dur * .85));
    const startSec = Math.max(0, Math.min(dur * .05, dur - maxSeconds));
    const startSample = Math.floor(startSec * sr);
    const dsLen = Math.floor(maxSeconds * sr / factor);
    const ds = new Float32Array(dsLen);
    for (let i = 0; i < dsLen; i++) {
      const off = startSample + i * factor;
      let s = 0;
      for (let k = 0; k < factor; k++) {
        const a = ch0[off + k] || 0;
        const b = ch1 ? (ch1[off + k] || 0) : 0;
        s += (a + b) * .5;
      }
      ds[i] = s / factor;
    }
    let sum = 0, zc = 0, prevSign = ds[0] >= 0;
    for (let i = 1; i < dsLen; i++) {
      const v = ds[i];
      sum += v * v;
      const sign = v >= 0;
      if (sign !== prevSign) { zc++; prevSign = sign; }
    }
    const rms = Math.sqrt(sum / Math.max(1, dsLen));
    const energy = clamp(Math.pow(clamp(rms / .32, 0, 1), .75), 0, 1);
    const zcr = zc / Math.max(1, dsLen);
    const brightness = clamp(zcr / .18, 0, 1);
    let bpm = null;
    try { bpm = estimateBpm(ds, dsRate); } catch (e) { bpm = null; }
    return { duration: dur, peaks, energy, brightness, bpm };
  }

  /* ───────── 採用 ───────── */

  function adoptCurrent() {
    const e = current();
    if (!e) return;
    if (state.adopted[e.id]) return;
    const c = state.cands[state.candIndex];
    if (!c) return;
    const g = groupFor(e);
    const members = g ? g.members : [e];
    const rec = {
      zh: c.zh, en: c.en, register: c.register, code: c.code,
      seed: state.seedBase, group: g ? g.key : ''
    };
    for (const m of members) state.adopted[m.id] = Object.assign({}, rec);
    persist();
    updateAdoptedStat();
    applyFilter();
    renderStage();
    const next = nextPending();
    toast(`已採用 · ${c.zh} (${c.en})` + (members.length > 1 ? ` · 套用 ${members.length} 檔` : ''));
    if (next) setTimeout(() => select(next.id), 420);
  }

  function nextPending() {
    const list = state.filtered.length ? state.filtered : state.entries;
    const i = list.findIndex(e => e.id === state.selId);
    for (let k = 1; k <= list.length; k++) {
      const e = list[(i + k) % list.length];
      if (!state.adopted[e.id]) return e;
    }
    return null;
  }

  function updateAdoptedStat() {
    el.statAdopted.textContent = state.entries.filter(e => state.adopted[e.id]).length;
  }

  function updateCorpus() {
    if (el.corpusTracks) el.corpusTracks.textContent = state.entries.length;
    if (el.corpusGroups) el.corpusGroups.textContent = state.groups.size;
    if (el.corpusStems) el.corpusStems.textContent = state.entries.filter(e => e.stem).length;
    if (el.corpusDown) {
      el.corpusDown.textContent = [...state.groups.values()].filter(g => g.rep.bpm && g.rep.bpm >= 105 && g.rep.bpm <= 118).length;
    }
    if (el.corpusTitles) el.corpusTitles.textContent = (LIB.titles || []).length;
  }

  function clearAdopted() {
    const n = Object.keys(state.adopted).length;
    if (!n) return toast('目前沒有已採用的名字');
    if (!confirm(`確定清除 ${n} 筆採用記錄？（不會動到任何檔案）`)) return;
    state.adopted = {};
    persist();
    updateAdoptedStat();
    applyFilter();
    if (current()) renderStage();
    toast('已清除採用記錄');
  }

  async function adoptAllPending() {
    const pendingGroups = [...state.groups.values()].filter(g => !g.members.every(m => state.adopted[m.id]));
    if (!pendingGroups.length) return toast('所有曲目都已有採用的名字');
    const pendingFiles = pendingGroups.reduce((a, g) => a + g.count, 0);
    if (!confirm(`為 ${pendingGroups.length} 組（${pendingFiles} 檔）批次產生名字？\n同一組的分軌／版本會共用一個名字。\n（只寫入採用記錄，不會動到檔案）`)) return;
    el.btnBatch.disabled = true;
    setStatus(`批次命名 0 / ${pendingGroups.length} 組`);
    const used = new Set();
    for (const [id, ad] of Object.entries(state.adopted)) used.add(N.normZh(ad.zh) + '|' + N.normEn(ad.en));
    let done = 0;
    for (const g of pendingGroups) {
      const rep = g.rep;
      const track = trackForEngine(rep);
      const seedBase = N.trackSeed(track, 0);
      const c = N.generate(seedBase, track, state.settings, { used, existing: EXISTING });
      if (c) {
        const rec = { zh: c.zh, en: c.en, register: c.register, code: c.code, seed: seedBase, group: g.key };
        for (const m of g.members) state.adopted[m.id] = Object.assign({}, rec);
      }
      done++;
      if (done % 16 === 0) {
        setStatus(`批次命名 ${done} / ${pendingGroups.length} 組`);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    persist();
    el.btnBatch.disabled = false;
    updateAdoptedStat();
    applyFilter();
    if (current()) renderStage();
    setStatus(`批次完成 · ${done} 組 / ${pendingFiles} 檔`);
    toast(`已採用 ${done} 組 / ${pendingFiles} 檔 · 可匯出改名腳本`, 3200);
  }

  /* ───────── 匯出 ───────── */

  function sanitizeName(s) {
    return String(s)
      .replace(/[\\/:*?"<>|]/g, '／')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 180);
  }

  function formatName(rec) {
    const zh = rec.zh || '';
    const en = rec.en || '';
    switch (state.format) {
      case 'dash': return en ? `${zh} - ${en}` : zh;
      case 'dashEn': return en ? `${en} - ${zh}` : zh;
      case 'zh': return zh;
      default: return en ? `${zh} (${en})` : zh;
    }
  }

  function rootBase() { return basename(state.root.replace(/[\\/]+$/, '')).toLowerCase(); }

  function relFromRoot(rel) {
    const parts = String(rel).split('/');
    if (parts.length > 1 && parts[0].toLowerCase() === rootBase()) return parts.slice(1).join('/');
    return parts.join('/');
  }

  function adoptedRecords() {
    const out = [];
    for (const e of state.entries) {
      const ad = state.adopted[e.id];
      if (!ad || ad.applied) continue;
      const ext = e.ext ? '.' + e.ext : '';
      const base = formatName(ad) + (e.version ? ` (${e.version})` : '') + (e.stem ? ` - ${e.stem}` : '');
      out.push({
        entry: e,
        ad,
        base: sanitizeName(base),
        newName: sanitizeName(base) + ext,
        ext,
        relFromRoot: relFromRoot(e.rel)
      });
    }
    // 同一資料夾內避免撞名（雜湊副本去掉後可能同名）
    const used = new Set();
    for (const r of out) {
      const dir = r.relFromRoot.includes('/') ? r.relFromRoot.slice(0, r.relFromRoot.lastIndexOf('/')) : '';
      let n = 1;
      let name = r.base;
      let key = (dir + '|' + name).toLowerCase();
      while (used.has(key)) { n++; name = r.base + ` (${n})`; key = (dir + '|' + name).toLowerCase(); }
      used.add(key);
      r.newName = name + r.ext;
    }
    return out;
  }

  function download(filename, text, mime, bom) {
    const blob = new Blob([bom ? '\ufeff' + text : text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function exportPs1() {
    const recs = adoptedRecords();
    if (!recs.length) return toast('先採用一些名字再匯出');
    const flat = recs.filter(r => !/[\\/]/.test(r.relFromRoot));
    const warnLines = flat.length
      ? `#\n# !! 注意：${flat.length} 筆只有檔名、沒有子資料夾路徑（用「選音檔」加入的）。\n#    腳本會在 $Root 根目錄找檔，可能找不到。\n#    建議改用「選資料夾」或拖入整個資料夾，保留完整相對路徑。\n`
      : '';
    const lines = recs.map(r => {
      const rel = r.relFromRoot.replace(/'/g, "''");
      const nw = r.newName.replace(/'/g, "''");
      return `    @{ Rel = '${rel}'; New = '${nw}' }`;
    });
    const script = `# ============================================================
# 命名爐 NOMENCLATOR · 改名計畫
# 產生：${new Date().toLocaleString('zh-TW')}   共 ${recs.length} 筆
#
# 用法：
#   1. 確認下面的 $Root 是你的音樂根目錄
#   2. 直接執行 = 預覽（$DryRun = $true）
#   3. 確認無誤後，把 $DryRun 改成 $false，再執行一次
# ============================================================
${warnLines}
$ErrorActionPreference = 'Stop'
$Root = '${state.root.replace(/'/g, "''")}'
$DryRun = $true

$Plan = @(
${lines.join('\r\n')}
)

$ok = 0; $skip = 0; $miss = 0
foreach ($p in $Plan) {
    $src = Join-Path -Path $Root -ChildPath $p.Rel
    if (-not (Test-Path -LiteralPath $src)) {
        Write-Warning ('MISSING  ' + $p.Rel)
        $miss++
        continue
    }
    $dir = Split-Path -Parent $src
    $dst = Join-Path -Path $dir -ChildPath $p.New
    if (Test-Path -LiteralPath $dst) {
        Write-Warning ('EXISTS   ' + $p.New)
        $skip++
        continue
    }
    if ($DryRun) {
        Write-Host ('DRY      ' + $p.Rel + '  ->  ' + $p.New)
        $ok++
        continue
    }
    Rename-Item -LiteralPath $src -NewName $p.New
    Write-Host ('RENAMED  ' + $p.Rel + '  ->  ' + $p.New)
    $ok++
}
Write-Host ''
Write-Host ('完成：可改名 {0} / 已存在 {1} / 找不到 {2}' -f $ok, $skip, $miss)
if ($DryRun) { Write-Host '目前為預覽模式。把 $DryRun 改成 $false 即會實際改名。' }
`;
    download(`命名爐-改名計畫-${stamp()}.ps1`, script.replace(/\n/g, '\r\n'), 'text/plain;charset=utf-8', true);
    toast(flat.length
      ? `已匯出 ${recs.length} 筆 · 其中 ${flat.length} 筆缺資料夾路徑，請看腳本註解`
      : `已匯出 ${recs.length} 筆改名計畫（預覽模式）`, flat.length ? 4200 : 2200);
  }

  function exportCsv() {
    const recs = adoptedRecords();
    if (!recs.length) return toast('先採用一些名字再匯出');
    const head = ['原相對路徑', '新檔名', '組', '分軌', '版本', '中文', 'English', '體裁', 'BPM', 'KEY', 'CAMELOT', '長度(秒)', '編號'];
    const rows = recs.map(r => {
      const g = state.groups.get(r.entry.groupKey);
      return [
        r.relFromRoot, r.newName, g ? g.base : '', r.entry.stem || '', r.entry.version || '',
        r.ad.zh, r.ad.en, r.ad.register,
        r.entry.bpm || '', r.entry.key || '', r.entry.cam || '',
        r.entry.duration != null ? Math.round(r.entry.duration) : '', r.ad.code || ''
      ];
    });
    const csv = [head, ...rows].map(row => row.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    download(`命名爐-名冊-${stamp()}.csv`, csv, 'text/csv;charset=utf-8', true);
    toast(`已匯出 CSV · ${recs.length} 筆`);
  }

  function exportJson() {
    const recs = adoptedRecords();
    if (!recs.length) return toast('先採用一些名字再匯出');
    const payload = {
      generator: 'NOMENCLATOR · SUB-110',
      exportedAt: new Date().toISOString(),
      root: state.root,
      format: state.format,
      settings: state.settings,
      count: recs.length,
      items: recs.map(r => ({
        path: r.entry.rel,
        relFromRoot: r.relFromRoot,
        oldName: basename(r.entry.rel),
        newName: r.newName,
        group: (state.groups.get(r.entry.groupKey) || {}).base || null,
        stem: r.entry.stem || null,
        version: r.entry.version || null,
        zh: r.ad.zh,
        en: r.ad.en,
        register: r.ad.register,
        code: r.ad.code,
        bpm: r.entry.bpm || null,
        key: r.entry.key || null,
        camelot: r.entry.cam || null,
        duration: r.entry.duration != null ? Math.round(r.entry.duration) : null,
        seed: r.ad.seed || null
      }))
    };
    download(`命名爐-名冊-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8', false);
    toast(`已匯出 JSON · ${recs.length} 筆`);
  }

  /* ───────── 拖放 / 選檔 ───────── */

  async function filesFromDataTransfer(dt) {
    const out = [];
    const items = dt.items ? Array.from(dt.items) : [];
    const entries = items.map(it => it.webkitGetAsEntry ? it.webkitGetAsEntry() : null).filter(Boolean);
    if (entries.length) {
      for (const entry of entries) await walkEntry(entry, '', out, 0);
    } else if (dt.files) {
      for (const f of Array.from(dt.files)) out.push({ file: f, rel: f.webkitRelativePath || f.name });
    }
    return out;
  }

  async function walkEntry(entry, path, out, depth) {
    if (depth > 12 || out.length > 6000) return;
    if (entry.isFile) {
      try {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, rel: path + file.name });
      } catch (e) { /* 跳過無法讀取的檔 */ }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const prefix = path + entry.name + '/';
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walkEntry(e, prefix, out, depth + 1);
      } while (batch.length);
    }
  }

  async function handleFileList(list, sourceLabel) {
    const files = [];
    const manifests = [];
    for (const item of list) {
      const file = item.file || item;
      const rel = item.rel || file.webkitRelativePath || file.name;
      const ext = extOf(rel);
      if (ext === 'json' && file.size < 12 * 1024 * 1024) { manifests.push({ file, rel }); continue; }
      if (!AUDIO_EXT.has(ext)) continue;
      files.push({ file, rel });
    }

    if (files.length) {
      stopPlayback();
      state.libraryMode = false;
      state.selId = null;
      const entries = files.slice(0, MAX_ENTRIES).map(f => makeEntry(f.rel, f.file, null));
      setEntries(entries);
      el.bayHint.textContent = `${entries.length} 檔 · ${state.groups.size} 組 · ${sourceLabel}`;
      toast(`已載入 ${entries.length} 檔 / ${state.groups.size} 組（分軌共用名字）`);
    }

    if (manifests.length) {
      for (const m of manifests) {
        try {
          const text = await m.file.text();
          const json = JSON.parse(text);
          const r = ingestManifest(json);
          if (r.hits) {
            applyFilter();
            if (current()) { buildCandidates(); renderStage(); }
            el.bayHint.textContent = `分析清單已套用 · ${r.hits} / ${r.total} 首`;
            toast(`已套用分析清單 · ${r.hits} 首`);
          } else {
            toast(`分析清單 ${r.total} 首，暫無對應曲目`);
          }
        } catch (err) {
          toast('清單解析失敗：' + (err.message || '').slice(0, 40));
        }
      }
    }

    if (!files.length && !manifests.length) toast('沒有可用的音檔或清單');
  }

  function onFilesPicked(input) {
    if (!input.files || !input.files.length) return;
    const list = Array.from(input.files).map(f => ({ file: f, rel: f.webkitRelativePath || f.name }));
    handleFileList(list, '本機檔案');
    input.value = '';
  }

  /* ───────── 佈景 / 事件 ───────── */

  function renderTicker() {
    const titles = (LIB.titles || []).slice(0, 140);
    if (!titles.length) { el.ticker.textContent = '—'; return; }
    const half = () => {
      const frag = document.createDocumentFragment();
      titles.forEach((t, i) => {
        const s = document.createElement('span');
        s.textContent = t;
        frag.append(s);
        if (i < titles.length - 1) {
          const sep = document.createElement('i');
          sep.textContent = ' · ';
          frag.append(sep);
        }
      });
      const sep = document.createElement('i');
      sep.textContent = '  ▚  ';
      frag.append(sep);
      return frag;
    };
    el.ticker.replaceChildren(half(), half());
  }

  function applyPreset(name) {
    const map = {
      gingai: { mix: 18, shake: 42 },
      hybrid: { mix: 50, shake: 52 },
      zaliva: { mix: 86, shake: 70 }
    };
    const p = map[name];
    if (!p) return;
    state.settings.mix = p.mix;
    state.settings.shake = p.shake;
    state.settings.register = 'auto';
    syncControls();
    onSettingsChanged();
    $$('.presets button').forEach(b => b.classList.toggle('on', b.dataset.preset === name));
    toast('預設 · ' + name.toUpperCase());
  }

  function syncControls() {
    el.mix.value = state.settings.mix;
    el.mixVal.textContent = state.settings.mix;
    el.shake.value = state.settings.shake;
    el.shakeVal.textContent = state.settings.shake;
    el.fmt.value = state.format;
    el.root.value = state.root;
    $$('#seg button').forEach(b => b.classList.toggle('on', b.dataset.reg === state.settings.register));
    const preset = state.settings.mix <= 28 && state.settings.shake <= 48 ? 'gingai'
      : state.settings.mix >= 72 ? 'zaliva' : 'hybrid';
    $$('.presets button').forEach(b => b.classList.toggle('on', b.dataset.preset === preset));
  }

  let settingsTimer = 0;
  function onSettingsChanged() {
    persist();
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      const e = current();
      if (!e) return;
      if (state.adopted[e.id]) { return; }
      buildCandidates();
      renderStage();
      flashScan();
    }, 80);
  }

  function bind() {
    el.btnFiles.addEventListener('click', () => el.fileInput.click());
    el.btnDir.addEventListener('click', () => el.dirInput.click());

    if (el.btnConnect) {
      el.btnConnect.addEventListener('click', async () => {
        if (!EXT) return;
        try {
          setStatus('掃描資料夾…');
          const scan = await EXT.connect();
          applyExtensionScan(scan);
        } catch (err) {
          setStatus('等待連接資料夾');
          if (err && err.name === 'AbortError') return;
          toast('連接失敗：' + ((err && err.message) || err).toString().slice(0, 60));
        }
      });
    }
    if (el.btnApply) {
      el.btnApply.addEventListener('click', async () => {
        if (!EXT) return;
        const recs = adoptedRecords().filter(r => !r.ad.applied);
        if (!recs.length) return toast('沒有待套用的改名');
        if (!confirm(`套用 ${recs.length} 個改名到本機檔案？\n（檔名會直接變更；不改音檔內容）`)) return;
        el.btnApply.disabled = true;
        try {
          const res = await EXT.apply(recs, msg => setStatus(msg));
          for (const r of recs) {
            const ad = state.adopted[r.entry.id];
            if (ad) ad.applied = true;
          }
          persist();
          renderStage();
          applyFilter();
          setStatus(`已改名 ${res.renamed} 檔${res.failed ? ` · 失敗 ${res.failed}` : ''}`);
          // 在擴充功能頁面裡直接叫背景重建本機索引，並通知開著的面板重畫；檔案模式則維持原本提示。
          if (globalThis.chrome?.runtime?.id) {
            toast(`已改名 ${res.renamed} 檔；正在重建本機索引…`, 3000);
            try {
              const ack = await chrome.runtime.sendMessage({ type: 'ACE_NAMING_APPLIED', renamed: res.renamed });
              toast(ack && ack.ok ? `已改名 ${res.renamed} 檔，索引已重建` : `已改名 ${res.renamed} 檔；回 ACE 面板按「維護 → 一鍵整理」重建索引`, 6200);
            } catch {
              toast(`已改名 ${res.renamed} 檔；回 ACE 面板按「維護 → 一鍵整理」重建索引`, 6200);
            }
          } else {
            toast(`已改名 ${res.renamed} 檔；回 ACE 面板按「維護 → 一鍵整理」重建索引`, 6200);
          }
        } catch (err) {
          toast('改名失敗：' + ((err && err.message) || err).toString().slice(0, 80), 4200);
        } finally {
          el.btnApply.disabled = false;
        }
      });
    }

    el.btnDemo.addEventListener('click', () => { loadLibrary(); toast('已載入示範曲庫'); });
    el.fileInput.addEventListener('change', () => onFilesPicked(el.fileInput));
    el.dirInput.addEventListener('change', () => onFilesPicked(el.dirInput));

    el.drop.addEventListener('click', e => {
      if (e.target.closest('.drop-actions')) return;
      el.fileInput.click();
    });
    el.drop.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });

    ['dragenter', 'dragover'].forEach(ev => {
      document.addEventListener(ev, e => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        el.drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      document.addEventListener(ev, e => {
        if (ev === 'dragleave' && e.relatedTarget) return;
        el.drop.classList.remove('over');
      });
    });
    document.addEventListener('dragover', e => {
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
    });
    document.addEventListener('drop', async e => {
      if (!e.dataTransfer) return;
      const hasFiles = Array.from(e.dataTransfer.types || []).includes('Files');
      if (!hasFiles) return;
      e.preventDefault();
      el.statMode.textContent = 'LOADING';
      try {
        const list = await filesFromDataTransfer(e.dataTransfer);
        await handleFileList(list, '拖放');
      } catch (err) {
        toast('讀取失敗：' + (err.message || '').slice(0, 50));
      } finally {
        el.statMode.textContent = 'READY';
      }
    });

    el.search.addEventListener('input', () => {
      state.search = el.search.value;
      applyFilter();
    });

    el.chips.addEventListener('click', e => {
      const b = e.target.closest('.chip');
      if (!b) return;
      state.filter = b.dataset.filter;
      $$('.chip').forEach(c => c.classList.toggle('on', c === b));
      applyFilter();
    });

    el.btnRandom.addEventListener('click', () => {
      const pool = state.filtered.length ? state.filtered : state.entries;
      if (!pool.length) return;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      select(pick.id);
    });

    el.btnReroll.addEventListener('click', reroll);
    el.btnAdopt.addEventListener('click', adoptCurrent);
    el.btnCopy.addEventListener('click', () => {
      const c = state.adopted[state.selId] || state.cands[state.candIndex];
      if (!c) return;
      const text = formatName(c);
      copyText(text).then(
        () => toast('已複製 · ' + text),
        () => toast('複製失敗，請手動選取')
      );
    });
    el.btnPlay.addEventListener('click', () => togglePlay());

    el.mix.addEventListener('input', () => {
      state.settings.mix = Number(el.mix.value);
      el.mixVal.textContent = state.settings.mix;
      markPresetByValue();
      onSettingsChanged();
    });
    el.shake.addEventListener('input', () => {
      state.settings.shake = Number(el.shake.value);
      el.shakeVal.textContent = state.settings.shake;
      markPresetByValue();
      onSettingsChanged();
    });
    el.seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-reg]');
      if (!b) return;
      state.settings.register = b.dataset.reg;
      $$('#seg button').forEach(x => x.classList.toggle('on', x === b));
      onSettingsChanged();
    });
    el.fmt.addEventListener('change', () => {
      state.format = el.fmt.value;
      persist();
      toast('檔名格式已更新');
    });
    el.root.addEventListener('change', () => {
      state.root = el.root.value.trim() || DEFAULT_ROOT;
      persist();
    });

    $$('.presets button').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
    el.btnPs1.addEventListener('click', exportPs1);
    el.btnCsv.addEventListener('click', exportCsv);
    el.btnJson.addEventListener('click', exportJson);
    el.btnBatch.addEventListener('click', adoptAllPending);
    el.btnClear.addEventListener('click', clearAdopted);

    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (tag === 'button' && (e.key === 'Enter' || e.key === ' ')) return;
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); reroll(); }
      else if (e.key === 'Enter') { e.preventDefault(); adoptCurrent(); }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); el.btnCopy.click(); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Escape') { stopPlayback(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const pool = state.filtered;
        if (!pool.length) return;
        const i = pool.findIndex(x => x.id === state.selId);
        const next = pool[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, pool.length - 1)];
        if (next) select(next.id);
      }
    });

    window.addEventListener('resize', () => {
      fitName();
      redrawSignature();
    });
  }

  function markPresetByValue() {
    const preset = state.settings.mix <= 28 && state.settings.shake <= 48 ? 'gingai'
      : state.settings.mix >= 72 ? 'zaliva' : 'hybrid';
    $$('.presets button').forEach(b => b.classList.toggle('on', b.dataset.preset === preset));
  }

  /* ───────── 啟動 ───────── */

  function applyExtensionScan(scan) {
    if (!scan || !Array.isArray(scan.tracks)) throw new Error('掃描結果為空');
    LIB.titles = scan.titles || [];
    LIB.tracks = scan.tracks;
    refreshExisting();
    state.root = scan.rootName || 'ai音樂';
    if (el.root) { el.root.value = state.root; el.root.disabled = true; }
    state.selId = null;
    state.adopted = {};
    loadLibrary(false);
    el.bayHint.textContent = `已連接 ${scan.rootName || 'ai音樂'} · ${LIB.tracks.length} 檔 / ${state.groups.size} 組`;
    const start = state.filtered.find(e => {
      const g = state.groups.get(e.groupKey);
      return g && g.stems > 0;
    }) || state.filtered[0];
    if (start) select(start.id);
    renderTicker();
    toast(scan.missing
      ? `已載入 ${LIB.tracks.length} 檔（${scan.missing} 個找不到）；${state.groups.size} 組`
      : `已載入 ${LIB.tracks.length} 檔 / ${state.groups.size} 組`, 3200);
  }

  async function bootExtension() {
    document.body.classList.add('ext-mode');
    for (const node of [el.btnDemo, el.btnPs1]) if (node) node.hidden = true;
    if (el.btnConnect) el.btnConnect.hidden = false;
    if (el.btnApply) el.btnApply.hidden = false;
    if (el.root) { el.root.disabled = true; el.root.value = '（由資料夾授權）'; }
    if (el.hint) el.hint.innerHTML = '按「連接 ai音樂」授權資料夾；套用改名後回面板按「一鍵整理」重建索引。<br>名字由音檔指紋 + 種子決定，同一組分軌／版本共用一個名字。';
    el.bayHint.textContent = '按「連接 ai音樂」授權本機資料夾';
    setStatus('等待連接資料夾');
    try {
      const scan = await EXT.restoreAndScan();
      if (scan) applyExtensionScan(scan);
      else setTimeout(() => toast('先按「連接 ai音樂」授權資料夾', 5000), 900);
    } catch (err) {
      toast('讀取資料夾失敗：' + ((err && err.message) || err).toString().slice(0, 70), 4200);
    }
  }

  async function boot() {
    restore();
    bind();
    renderTicker();
    syncControls();
    state.filter = 'reps';
    $$('.chip').forEach(c => c.classList.toggle('on', c.dataset.filter === 'reps'));
    el.statMode.textContent = 'READY';
    if (EXT) { await bootExtension(); return; }
    loadLibrary(false);
    const start = state.filtered.find(e => {
      const g = state.groups.get(e.groupKey);
      return g && g.stems > 0 && e.name.includes('幽冥');
    }) || state.filtered.find(e => {
      const g = state.groups.get(e.groupKey);
      return g && g.stems > 0;
    }) || state.filtered[Math.min(6, state.filtered.length - 1)];
    if (start) select(start.id);
    setTimeout(flashScan, 300);
    setTimeout(() => toast('R 重擲 · ↵ 採用 · 同一組分軌共用一個名字', 5000), 1100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
