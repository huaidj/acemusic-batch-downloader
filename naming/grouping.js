/* ============================================================
   命名爐 — 曲目分組（同一首歌的分軌／版本共用一個名字）
   可獨立用於瀏覽器與 Node。
   ============================================================ */
(function (global) {
  'use strict';

  // 只認這些「分軌」尾綴；避免把 "Zaliva-D - Larva" 的藝人名當成樂器
  const STEM_LABELS = new Set([
    'bass', 'drums', 'fx', 'synth', 'vocals', 'guitar', 'woodwinds', 'keys',
    'brass', 'backing vocals', 'backing-vocals', 'strings', 'instrumental',
    'percussion', 'piano', 'pad', 'lead', 'arp', 'choir', 'flute', 'sax',
    'trumpet', 'horns', 'noise', 'texture', 'atmos', 'atmosphere', 'sub',
    'kick', 'snare', 'hats', 'hihats', 'loop', 'top', 'perc', 'vox',
    'melody', 'chords', 'pluck', 'bell', 'bells', 'mallets', 'reed',
    'ethnic', 'world', 'rhodes', 'wurli', 'organ', 'harp', 'cello',
    'viola', 'violin', 'drum', 'bassline', 'acapella', 'acappella'
  ]);

  function normGroup(s) {
    return String(s || '').toLowerCase()
      .replace(/[\s\u3000·・_\-—–]+/g, '')
      .replace(/[（）()\[\]【】「」『』,，、。.．:：;；!！?？'"“”\/\\|]/g, '');
  }

  function parseTrackName(name) {
    let s = String(name || '').trim();
    let version = '';
    let stem = '';

    const takeVersion = () => {
      const m = s.match(/^(.*?)\s*[（(]\s*(\d+)\s*[)）]\s*$/);
      if (m && m[1]) { s = m[1].trim(); version = m[2]; return true; }
      return false;
    };

    takeVersion();

    const m = s.match(/^(.*?)\s+-\s+(.+)$/);
    if (m && STEM_LABELS.has(m[2].trim().toLowerCase())) {
      s = m[1].trim();
      stem = m[2].trim();
      takeVersion();
    }

    // [81c52a34] 這種複本雜湊只用於分組；新檔名不再保留，重複時自動加 (2)
    const hashless = s.replace(/\s*\[[0-9a-f]{6,}\]\s*$/i, '').trim();
    const base = hashless || s;
    // 版本 (2)(3) 留在分組裡：不同版本各自成組，但同一版本的分軌共用名字
    const display = version ? `${base} (${version})` : base;
    const key = normGroup(base) + (version ? '#' + version : '');
    return { base, display, stem, version, key };
  }

  function groupEntries(entries) {
    const groups = new Map();
    const groupOf = new Map();

    for (const e of entries) {
      const p = parseTrackName(e.name);
      e.groupKey = p.key;
      e.stem = p.stem;
      e.version = p.version;
      if (!e.trackKind) e.trackKind = p.stem ? 'stem' : 'full';
      let g = groups.get(p.key);
      if (!g) {
        g = { key: p.key, base: p.display, members: [], stems: 0, count: 0, rep: null };
        groups.set(p.key, g);
      }
      g.members.push(e);
    }

    for (const g of groups.values()) {
      g.members.sort((a, b) => {
        const af = a.trackKind === 'full' ? 0 : 1;
        const bf = b.trackKind === 'full' ? 0 : 1;
        if (af !== bf) return af - bf;
        const av = a.version ? Number(a.version) : 1;
        const bv = b.version ? Number(b.version) : 1;
        if (av !== bv) return av - bv;
        return String(a.rel).localeCompare(String(b.rel), 'zh-Hant');
      });
      g.rep = g.members[0];
      g.count = g.members.length;
      g.stems = g.members.filter(m => m.stem).length;
      for (const m of g.members) groupOf.set(m.id, g.key);
    }

    return { groups, groupOf };
  }

  const API = { STEM_LABELS, normGroup, parseTrackName, groupEntries };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.NOMEN_GROUP = API;
})(typeof window !== 'undefined' ? window : globalThis);
