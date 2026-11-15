// naming.js — 檔名／資料夾命名的純函式。
// 這個檔案同時被三種環境載入：
//   1. content script（manifest content_scripts 先載入本檔）
//   2. service worker（background.js 用 importScripts 載入）
//   3. Node 單元測試（用 vm 載入後讀 globalThis.AceDLNaming）
// 因此使用 classic script，掛在 globalThis 上，不可使用 import/export。
(() => {
  'use strict';

  // ACE Music 站點的分軌 type → 顯示名稱（取自站點 public/app.js 的 STEM_NAME）
  const STEM_TYPE_NAMES = Object.freeze({
    vocal: 'Vocals',
    vocals: 'Vocals',
    instrumental: 'Instrumental',
    backing_vocals: 'Backing vocals',
    drums: 'Drums',
    percussion: 'Percussion',
    bass: 'Bass',
    guitar: 'Guitar',
    keyboard: 'Keys',
    strings: 'Strings',
    brass: 'Brass',
    woodwinds: 'Woodwinds',
    synth: 'Synth',
    fx: 'FX',
  });

  // Windows 磁碟上不能用的保留名稱
  const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  /** 清掉 Windows 不允許的檔名字元、控制字元，收斂空白，去尾端空白與句點 */
  function sanitizeComponent(value, maxLen = 60) {
    let s = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ');
    s = s.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/[. ]+$/g, '').trim();
    if (maxLen > 0 && s.length > maxLen) {
      s = s.slice(0, maxLen).replace(/[. ]+$/g, '').trim();
    }
    if (!s) return '';
    if (RESERVED_NAMES.test(s)) s = '_' + s;
    return s;
  }

  /** 歌曲資料夾名（同時作為檔名前綴 songLabel） */
  function songFolderLabel(title) {
    return sanitizeComponent(title, 55) || 'Untitled';
  }

  /** 分軌顯示名 */
  function stemLabel(type) {
    const key = String(type == null ? '' : type).toLowerCase();
    return sanitizeComponent(STEM_TYPE_NAMES[key] || type || 'Stem', 24) || 'Stem';
  }

  /**
   * 指派歌曲資料夾名：同名但不同 task_id 時依序加 " (2)"、" (3)"……
   * ownerByFolder 的 key 一律是小寫（Windows 不分大小寫）。
   */
  function assignFolderName(desiredLabel, taskId, ownerByFolder) {
    const base = sanitizeComponent(desiredLabel, 55) || 'Untitled';
    const owners = ownerByFolder || {};
    let candidate = base;
    let n = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const owner = owners[candidate.toLowerCase()];
      if (!owner || owner === taskId) return candidate;
      if (n > 999) return `${base} (${String(taskId).slice(-6)})`;
      candidate = `${base} (${n++})`;
    }
  }

  /** 保留副檔名，把檔名主體截到 maxLen 以內 */
  function truncateFileName(name, maxLen = 150) {
    const s = String(name == null ? '' : name);
    if (s.length <= maxLen) return s;
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    const stem = ext ? s.slice(0, dot) : s;
    const keep = Math.max(1, maxLen - ext.length);
    return stem.slice(0, keep).trim() + ext;
  }

  // 開啟「依類型分子資料夾」時的類型目錄
  const TYPE_DIRS = Object.freeze({ stems: 'Stems', midi: 'MIDI', musicxml: 'MIDI', mp3: 'Audio', wav: 'Audio', cover: 'Cover' });

  /** 產生相對於 Chrome 下載目錄的路徑（Chrome 會自動建子資料夾） */
  function buildRelativePath({ root, folder, typeDir, filename, typeFolders }) {
    const rootPart = sanitizeComponent(root, 40) || 'aiMusic';
    const parts = [rootPart, folder];
    if (typeFolders && typeDir) parts.push(typeDir);
    const dir = parts.join('/') + '/';
    let rel = dir + truncateFileName(filename, 150);
    if (rel.length > 180) {
      // 保險：把檔名主體再縮短（保留目錄與副檔名）
      rel = dir + truncateFileName(filename, Math.max(20, 180 - dir.length));
    }
    return rel;
  }

  /** 各類型檔名產生器 */
  function fileNamesFor(folder) {
    return {
      stems: (label) => `${folder} - ${label}.mp3`,
      midi: () => `${folder} - MIDI.mid`,
      musicxml: () => `${folder} - MusicXML.musicxml`,
      mp3: () => `${folder}.mp3`,
      wav: () => `${folder}.wav`,
      cover: (ext) => `${folder} - Cover${ext || '.jpg'}`,
    };
  }

  /** 同一首歌內避免檔名重複（例如 vocal 與 vocals 都被命名為 Vocals） */
  function uniqueFileName(base, usedLowerSet) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let name = base;
    let n = 2;
    while (usedLowerSet.has(name.toLowerCase())) {
      name = `${stem} (${n++})${ext}`;
    }
    usedLowerSet.add(name.toLowerCase());
    return name;
  }

  const api = {
    STEM_TYPE_NAMES,
    RESERVED_NAMES,
    sanitizeComponent,
    songFolderLabel,
    stemLabel,
    assignFolderName,
    truncateFileName,
    buildRelativePath,
    fileNamesFor,
    uniqueFileName,
    TYPE_DIRS,
  };
  globalThis.AceDLNaming = api;
})();
