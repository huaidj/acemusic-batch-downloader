// content.js — ACE Music 批量下載器的頁面端：UI 面板 + 歌單抓取 + 下載排程。
// 全部狀態留在頁面內（content script），service worker 只負責真正呼叫 chrome.downloads。
'use strict';
(() => {
  const N = globalThis.AceDLNaming;
  const P = globalThis.AceDLPlanner;
  if (!N || !P) {
    console.warn('[ACE 批量下載] naming.js / planner.js 未載入，擴充功能未啟動');
    return;
  }

  // 只在 Create（歌曲庫）頁面運作：/create/、/zh/create/、/pt-br/create/ …
  const normalizedPath = location.pathname.replace(/\/+$/, '') || '/';
  if (!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?create$/i.test(normalizedPath)) return;
  if (document.getElementById('acedl-host')) return;

  const HOST_ID = 'acedl-host';
  const FILE_TYPES = ['stems', 'midi', 'musicxml', 'mp3', 'wav', 'cover'];
  const DEFAULT_OPTIONS = Object.freeze({
    stems: true,
    midi: true,
    musicxml: false,
    mp3: false,
    wav: false,
    cover: true,
    force: false,
    typeFolders: false,
    autoRefresh: true,
    autoFix: true,
    autoOrganize: true,
    concurrency: 4,
  });
  const DEFAULT_ROOT = 'ai音樂';
  const PAGE_LIMIT = 50;
  const MAX_PAGES = 8;
  const AUTO_REFRESH_MS = 8000;
  const KEY_SETTINGS = 'aceSettings';
  const KEY_HISTORY = 'aceHistory';
  const KEY_FOLDERS = 'aceFolders';

  const S = {
    options: { ...DEFAULT_OPTIONS },
    rootFolder: DEFAULT_ROOT,
    songs: [],
    loading: false,
    quietLoading: false,
    loaded: false,
    loadError: '',
    selected: new Set(),
    folderByTask: {},
    ownerByFolder: {},
    history: {},
    running: false,
    cancelled: false,
    progress: { done: 0, skipped: 0, failed: 0, total: 0, current: '', phase: 'idle', activeDl: 0, activePrep: 0, elapsedMs: 0 },
    failedList: [],
    els: {},
    toastTimer: 0,
    historyTimer: 0,
    autoTimer: 0,
    renderTimer: 0,
    lastSig: '',
    lastUpdated: '',
    jobStartedAt: 0,
    host: { ok: false, downloadsRoot: '' },
    fsAbs: new Set(),
    fsRel: new Set(),
    fsNames: new Set(),
    fsAt: 0,
    doneKinds: new Map(),
    agentAliases: {},
    removedPaths: {},
    removedRel: new Map(),
    onlyUndownloaded: false,
  };

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // e2e 測試會注入 __ACEDL_TEST_MODE__，避免真機 host 的檔案索引/去重紀錄污染測試
  const TEST_MODE = globalThis.__ACEDL_TEST_MODE__ === true;

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'value') node.value = value;
        else if (key === 'checked') node.checked = !!value;
        else if (key === 'disabled') node.disabled = !!value;
        else if (key === 'hidden') node.hidden = !!value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, String(value));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  const FAILED = {
    SERVER_UNAUTHORIZED: '站點拒絕下載（需要登入或方案不足）',
    SERVER_403: '站點拒絕下載（方案不足）',
    SERVER_401: '站點拒絕下載（需要登入）',
    SERVER_402: '站點拒絕下載（方案不足）',
    SERVER_404: '站點找不到檔案',
    SERVER_500: '站點伺服器錯誤',
    NETWORK_FAILED: '網路中斷',
    NETWORK_TIMEOUT: '網路逾時',
    USER_CANCELED: '已取消',
  };

  function friendlyError(message) {
    const s = String(message == null ? '' : message);
    for (const [code, text] of Object.entries(FAILED)) {
      if (s.includes(code)) return `${text}（${code}）`;
    }
    if (/HTTP 40[123]/.test(s)) return '站點拒絕下載（可能未登入或方案不足）';
    return s;
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (value) => resolve(value || {}));
      } catch (err) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (err) {
        resolve();
      }
    });
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) reject(new Error(lastError.message));
          else resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function sendBadge(text) {
    sendMessage({ type: 'ACE_BADGE', text: text || '', color: '#5b8def' }).catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * 樣式（用 constructed stylesheet，避開頁面 CSP 對 inline style 的限制）
   * ------------------------------------------------------------------ */
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
  background: linear-gradient(135deg, #2563eb, #7c3aed); color: #fff; cursor: pointer;
  font: 600 13px/1.2 system-ui, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif;
  box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06) inset;
  user-select: none;
}
.fab:hover { filter: brightness(1.08); }
.fab.running { background: linear-gradient(135deg, #0f766e, #2563eb); }
.fab .dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 8px #34d399; }
.fab.running .dot { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; animation: acedl-pulse 1s infinite; }
@keyframes acedl-pulse { 50% { opacity: .35; } }

.panel {
  position: fixed; right: 18px; bottom: 74px; z-index: 2147483647;
  width: 470px; max-width: 94vw; max-height: min(80vh, 860px);
  display: flex; flex-direction: column;
  background: #141417; color: #e8e8ea; border: 1px solid #2e2e35; border-radius: 16px;
  box-shadow: 0 24px 70px rgba(0,0,0,.6);
  font: 13px/1.45 system-ui, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif;
  overflow: hidden;
}
.panel[hidden] { display: none; }
.panel header { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; border-bottom: 1px solid #26262c; }
.panel header .title { font-weight: 700; font-size: 14px; letter-spacing: .2px; }
.panel header .sub { color: #8b8b95; font-size: 11px; flex: 1; }
.iconbtn {
  width: 28px; height: 28px; border-radius: 8px; border: 1px solid #33333a; background: #1c1c21;
  color: #cfcfd6; cursor: pointer; font-size: 14px; line-height: 1;
}
.iconbtn:hover { background: #26262d; }

.opts { display: flex; flex-wrap: wrap; gap: 6px 10px; padding: 10px 14px; border-bottom: 1px solid #232329; align-items: center; }
.chk { display: inline-flex; align-items: center; gap: 5px; color: #cfcfd6; cursor: pointer; font-size: 12px; }
.chk input { accent-color: #5b8def; }
.chk select.mini {
  padding: 2px 4px; border-radius: 6px; border: 1px solid #33333a; background: #0f0f12;
  color: #e8e8ea; font-size: 11.5px; outline: none;
}
.sep { width: 1px; height: 16px; background: #2e2e35; margin: 0 2px; }
.root { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #9a9aa4; margin-left: auto; }
.root input {
  width: 128px; padding: 4px 8px; border-radius: 7px; border: 1px solid #33333a;
  background: #0f0f12; color: #e8e8ea; font-size: 12px; outline: none;
}
.root input:focus { border-color: #5b8def; }

.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid #232329; }
.toolbar button, .footer button, .rowbtn {
  border: 1px solid #33333a; background: #1c1c21; color: #d8d8de; border-radius: 8px;
  padding: 5px 10px; font-size: 12px; cursor: pointer;
}
.toolbar button:hover, .footer button:hover, .rowbtn:hover { background: #26262d; }
.toolbar button.on { border-color: #5b8def; color: #93c5fd; background: #14203a; }
.organize {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start;
  padding: 8px 14px; border-bottom: 1px solid #232329; background: #12141a;
  font-size: 11.5px; color: #d8d8de;
}
.organize[hidden] { display: none; }
.organize .grow { flex: 1; min-width: 180px; }
.organize .hint { padding: 0; text-align: left; font-size: 10.5px; color: #8b8b95; }
.toolbar .count { color: #9a9aa4; font-size: 12px; margin-left: auto; }

.songs { flex: 1; overflow-y: auto; min-height: 120px; padding: 6px 8px; }
.songs::-webkit-scrollbar { width: 8px; }
.songs::-webkit-scrollbar-thumb { background: #33333a; border-radius: 8px; }
.song { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 9px; }
.song:hover { background: #1b1b20; }
.song input[type=checkbox] { accent-color: #5b8def; flex: none; }
.song .cover { width: 30px; height: 30px; border-radius: 6px; object-fit: cover; background: #232329; flex: none; }
.song .body { flex: 1; min-width: 0; }
.song .name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song .meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.badge { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid #33333a; color: #9a9aa4; }
.badge.ok { color: #86efac; border-color: #1f5136; background: #10231a; }
.badge.warn { color: #fbbf24; border-color: #4d3a12; background: #241c0d; }
.badge.dim { opacity: .7; }
.rowbtn { flex: none; padding: 4px 9px; font-size: 11.5px; }
.hint { color: #8b8b95; font-size: 12px; padding: 16px 12px; text-align: center; }
.hint.err { color: #fca5a5; }
.hint a { color: #7aa7ff; }

.progress { border-top: 1px solid #26262c; padding: 10px 14px 8px; }
.progress[hidden] { display: none; }
.bar { height: 5px; border-radius: 999px; background: #26262c; overflow: hidden; }
.bar i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #2563eb, #8b5cf6); transition: width .2s ease; }
.stats { display: flex; gap: 10px; margin-top: 7px; color: #b9b9c2; font-size: 11.5px; flex-wrap: wrap; }
.stats b { color: #fff; font-weight: 600; }
.current { margin-top: 5px; color: #8b8b95; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.failed { margin-top: 6px; font-size: 11px; color: #cfcfd6; }
.failed summary { cursor: pointer; color: #fca5a5; }
.failed ul { margin: 4px 0 0; padding-left: 18px; max-height: 110px; overflow: auto; }
.failed li { color: #f3b3b3; word-break: break-all; }
.showfolder { margin-top: 8px; }

.footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid #26262c; background: #101013; }
.primary {
  flex: 1 1 150px; white-space: nowrap; padding: 9px 12px; border-radius: 10px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.10);
  background: linear-gradient(135deg, #2563eb, #7c3aed); color: #fff; font-weight: 700; font-size: 13px;
}
.primary:disabled { opacity: .45; cursor: not-allowed; }
.primary:not(:disabled):hover { filter: brightness(1.08); }
.ghost { padding: 9px 12px; border-radius: 10px; white-space: nowrap; cursor: pointer; border: 1px solid #44444d; background: #1c1c21; color: #e8e8ea; font-size: 12.5px; }
.ghost[hidden] { display: none; }
.foothint { color: #6f6f7a; font-size: 10.5px; flex-basis: 100%; margin-top: 2px; }
.tidybar { flex-basis: 100%; margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.tidybar[hidden] { display: none; }
.tidybar .track { height: 6px; border-radius: 999px; background: #232329; overflow: hidden; }
.tidybar .track i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #5b8def, #7ee2a8); transition: width .4s ease; }
.tidybar .label { color: #9aa0b5; font-size: 10.5px; }
.toast:empty { display: none; }
.toast { color: #93c5fd; font-size: 11px; margin-left: 6px; }
`;

  function applyStyles(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (err) {
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  function buildUi() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    applyStyles(shadow);

    const fab = el('button', { id: 'acedl-fab', class: 'fab', type: 'button', title: 'ACE 批量下載（分軌／MIDI）' }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'fab-text', text: '批量下載' }),
    ]);

    const panel = el('section', { class: 'panel', hidden: true, 'aria-label': 'ACE Music 批量下載器' });
    const closeBtn = el('button', { class: 'iconbtn', type: 'button', 'data-act': 'close', title: '收起' }, ['✕']);
    const refreshBtn = el('button', { class: 'iconbtn', type: 'button', 'data-act': 'refresh', title: '重新整理歌單' }, ['↻']);
    const titleBox = el('div', { class: 'title', text: 'ACE 批量下載' });
    const subBox = el('div', { class: 'sub', text: '分軌 · MIDI · WAV · 自動改名' });
    const header = el('header', null, [titleBox, subBox, refreshBtn, closeBtn]);

    const optRows = el('div', { class: 'opts' });
    const typeLabels = { stems: '分軌', midi: 'MIDI', musicxml: 'MusicXML', mp3: 'MP3', wav: 'WAV', cover: '封面' };
    for (const type of FILE_TYPES) {
      const cb = el('input', { type: 'checkbox', 'data-opt': type, checked: S.options[type] });
      cb.addEventListener('change', () => {
        S.options[type] = cb.checked;
        saveSettings();
        updateCounts();
      });
      optRows.append(el('label', { class: 'chk' }, [cb, typeLabels[type]]));
    }
    optRows.append(el('span', { class: 'sep' }));
    for (const [key, label] of [['force', '強制重下'], ['typeFolders', '依類型分層']]) {
      const cb = el('input', { type: 'checkbox', 'data-opt': key, checked: S.options[key] });
      cb.addEventListener('change', () => {
        S.options[key] = cb.checked;
        saveSettings();
      });
    optRows.append(el('label', { class: 'chk' }, [cb, label]));
    }
    const autoCb = el('input', { type: 'checkbox', 'data-opt': 'autoRefresh', checked: S.options.autoRefresh });
    autoCb.addEventListener('change', () => {
      S.options.autoRefresh = autoCb.checked;
      saveSettings();
      startAutoRefresh();
    });
    optRows.append(el('label', { class: 'chk' }, [autoCb, '自動更新']));
    const autoFixCb = el('input', { type: 'checkbox', 'data-opt': 'autoFix', checked: S.options.autoFix });
    autoFixCb.addEventListener('change', () => {
      S.options.autoFix = autoFixCb.checked;
      saveSettings();
    });
    optRows.append(el('label', { class: 'chk', title: '下載後若檔名/資料夾不符（伺服器指定檔名），用本機整理工具自動改名移動' }, [autoFixCb, '自動修正檔名']));
    const autoOrganizeCb = el('input', { type: 'checkbox', 'data-opt': 'autoOrganize', checked: S.options.autoOrganize });
    autoOrganizeCb.addEventListener('change', () => {
      S.options.autoOrganize = autoOrganizeCb.checked;
      saveSettings();
    });
    optRows.append(el('label', { class: 'chk', title: '下載後自動整理：成品MP3／採樣包／MIDI分類' }, [autoOrganizeCb, '下載完自動整理']));
    const concSel = el('select', { class: 'mini', 'data-opt': 'concurrency' });
    for (const n of [1, 2, 3, 4, 5, 6]) concSel.append(el('option', { value: String(n), text: String(n) }));
    concSel.value = String(S.options.concurrency);
    concSel.addEventListener('change', () => {
      S.options.concurrency = clamp(Number(concSel.value) || 4, 1, 6);
      saveSettings();
    });
    optRows.append(el('label', { class: 'chk' }, ['並行', concSel]));
    const rootInput = el('input', { type: 'text', 'data-root-folder': '', value: S.rootFolder, spellcheck: 'false' });
    rootInput.addEventListener('change', () => {
      S.rootFolder = N.sanitizeComponent(rootInput.value, 40) || DEFAULT_ROOT;
      rootInput.value = S.rootFolder;
      saveSettings();
    });
    optRows.append(el('label', { class: 'root' }, ['根資料夾', rootInput]));

    const countLabel = el('span', { class: 'count', 'data-count': '', text: '' });
    const selectAll = el('button', { type: 'button', 'data-act': 'select-all', text: '全選' });
    const selectNone = el('button', { type: 'button', 'data-act': 'select-none', text: '取消全選' });
    const exportAgentBtn = el('button', { type: 'button', 'data-act': 'export-agent', text: '同步 Agent' });
    const filterBtn = el('button', { type: 'button', 'data-act': 'filter-undownloaded', text: '只看未下載' });
    const organizeBtn = el('button', { type: 'button', 'data-act': 'organize', text: '整理舊檔' });
    const toolbar = el('div', { class: 'toolbar' }, [selectAll, selectNone, filterBtn, organizeBtn, exportAgentBtn, countLabel]);
    const tidyBtn = el('button', { type: 'button', 'data-act': 'tidy', text: '一鍵整理' });
    const extractMp3Btn = el('button', { type: 'button', 'data-act': 'extract-mp3', text: '成品MP3' });
    const watchBtn = el('button', { type: 'button', 'data-act': 'watch', text: '背景自動整理' });
    const openClassifyBtn = el('button', { type: 'button', 'data-act': 'open-classify', text: '開啟分類資料夾' });
    const dedupeCustomBtn = el('button', { type: 'button', 'data-act': 'dedupe-custom', text: '清自訂重複' });
    const toolbar2 = el('div', { class: 'toolbar' }, [tidyBtn, extractMp3Btn, watchBtn, dedupeCustomBtn, openClassifyBtn]);

    const songsBox = el('div', { class: 'songs', 'data-songs': '' });
    const organizeBox = el('div', { class: 'organize', 'data-organize': '', hidden: true });

    const barFill = el('i');
    const bar = el('div', { class: 'bar' }, [barFill]);
    const stats = el('div', { class: 'stats', 'data-stats': '' });
    const current = el('div', { class: 'current', 'data-current': '' });
    const failedList = el('ul');
    const failedDetails = el('details', { class: 'failed', 'data-failed': '', hidden: true }, [
      el('summary', { 'data-failed-summary': '', text: '失敗清單' }),
      failedList,
    ]);
    const showFolderBtn = el('button', {
      class: 'rowbtn showfolder',
      type: 'button',
      'data-act': 'show-folder',
      text: '開啟下載資料夾',
      hidden: true,
    });
    const progress = el('div', { class: 'progress', 'data-progress': '', hidden: true }, [
      bar,
      stats,
      current,
      failedDetails,
      showFolderBtn,
    ]);

    const downloadBtn = el('button', { class: 'primary', type: 'button', 'data-act': 'download', text: '下載選中' });
    const cancelBtn = el('button', { class: 'ghost', type: 'button', 'data-act': 'cancel', text: '停止', hidden: true });
    const toast = el('span', { class: 'toast', 'data-toast': '' });
    const footHint = el('div', { class: 'foothint', 'data-hint': '', text: '檔案存到「下載」資料夾下的根資料夾／歌名子資料夾。' });
    const tidyBarFill = el('i');
    const tidyBarText = el('div', { class: 'label', 'data-tidy-label': '', text: '' });
    const tidyBar = el('div', { class: 'tidybar', 'data-tidybar': '', hidden: true }, [
      el('div', { class: 'track' }, [tidyBarFill]),
      tidyBarText,
    ]);
    const footer = el('div', { class: 'footer' }, [downloadBtn, cancelBtn, toast, tidyBar, footHint]);

    panel.append(header, optRows, toolbar, toolbar2, organizeBox, songsBox, progress, footer);
    shadow.append(fab, panel);

    Object.assign(S.els, {
      host,
      shadow,
      fab,
      fabText: fab.querySelector('.fab-text'),
      panel,
      songsBox,
      organizeBox,
      tidyBtn,
      extractMp3Btn,
      watchBtn,
      dedupeCustomBtn,
      tidyBar,
      tidyBarFill,
      tidyBarText,
      countLabel,
      downloadBtn,
      cancelBtn,
      progress,
      barFill,
      stats,
      current,
      failedDetails,
      failedList,
      showFolderBtn,
      toast,
      footHint,
      rootInput,
    });

    fab.addEventListener('click', () => togglePanel(true));
    closeBtn.addEventListener('click', () => togglePanel(false));
    refreshBtn.addEventListener('click', () => {
      if (S.running) return flash('下載進行中，完成後再重新整理');
      S.loaded = false;
      fetchSongs();
    });
    selectAll.addEventListener('click', () => {
      for (const song of S.songs) S.selected.add(song.task_id);
      renderSongs();
    });
    selectNone.addEventListener('click', () => {
      S.selected.clear();
      renderSongs();
    });
    downloadBtn.addEventListener('click', () => {
      const picked = S.songs.filter((song) => S.selected.has(song.task_id));
      if (!picked.length) return flash('請先勾選歌曲');
      startJob(picked);
    });
    cancelBtn.addEventListener('click', () => {
      if (!S.running) return;
      S.cancelled = true;
      S.progress.phase = 'cancelling';
      renderProgress();
      sendMessage({ type: 'ACE_CANCEL_DOWNLOAD' }).catch(() => {});
    });
    showFolderBtn.addEventListener('click', () => {
      sendMessage({ type: 'ACE_SHOW_FOLDER' })
        .then((res) => {
          if (!res || !res.ok) flash('無法開啟資料夾，請自行到「下載」資料夾查看');
        })
        .catch(() => flash('無法開啟資料夾，請自行到「下載」資料夾查看'));
    });
    exportAgentBtn.addEventListener('click', () => exportAgent(true));
    organizeBtn.addEventListener('click', () => organizeDryRun());
    tidyBtn.addEventListener('click', () => runTidy());
    dedupeCustomBtn.addEventListener('click', () => runDedupeCustom());
    extractMp3Btn.addEventListener('click', () => runExtractMp3());
    watchBtn.addEventListener('click', () => runWatch());
    openClassifyBtn.addEventListener('click', () => openClassifyFolder());
    filterBtn.addEventListener('click', () => {
      S.onlyUndownloaded = !S.onlyUndownloaded;
      filterBtn.classList.toggle('on', S.onlyUndownloaded);
      renderSongs();
    });

    // 不讓面板內的操作傳到站點（站點有全域點擊／快捷鍵）
    for (const evt of ['click', 'mousedown', 'pointerdown', 'keydown', 'keyup', 'input', 'focusin']) {
      host.addEventListener(evt, (event) => event.stopPropagation());
    }
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !S.els.panel.hidden) togglePanel(false);
    });

    renderSongs();
    renderProgress();
    updateFab();
    updateCounts();
  }

  function togglePanel(open) {
    const panel = S.els.panel;
    const shouldOpen = typeof open === 'boolean' ? open : panel.hidden;
    panel.hidden = !shouldOpen;
    if (shouldOpen) {
      loadSettings().then(() => {
        if (!S.loaded && !S.loading) fetchSongs();
        else refreshSongsQuiet();
        maybeAutoExportAgent();
        refreshHostStatus()
          .then(() => refreshDownloadIndex(true))
          .then(() => {
            if (S.songs.length) renderSongs();
          });
      });
      renderProgress();
      updateCounts();
    }
  }

  function flash(text) {
    const node = S.els.toast;
    node.textContent = text;
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => {
      node.textContent = '';
    }, 4000);
  }

  /** 把登入 Cookie 與下載紀錄匯出到本機（給 CLI / MCP 使用） */
  async function exportAgent(manual) {
    if (manual) flash('正在同步登入狀態給 Agent…');
    try {
      const res = await sendMessage({ type: 'ACE_EXPORT_AGENT' });
      if (res && res.ok) {
        const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        flash('已同步給 Agent（' + time + '）：CLI／MCP 現在可以直接下載');
      } else if (manual) {
        const detail = (res && (res.sessionError || res.historyError)) || '本機整理工具未安裝或尚未登入';
        flash('同步失敗：' + detail);
      }
    } catch (err) {
      if (manual) flash('同步失敗：' + ((err && err.message) || err));
    }
  }

  async function maybeAutoExportAgent() {
    try {
      const got = await storageGet(['aceAgentExportAt']);
      const last = Number(got.aceAgentExportAt) || 0;
      if (Date.now() - last < 20 * 60 * 1000) return;
      await exportAgent(false);
    } catch (err) {
      /* ignore */
    }
  }

  /** 查詢本機整理工具（native host）是否可用；可用時下載後可自動修正檔名/移動 */
  async function refreshHostStatus() {
    try {
      const res = await sendMessage({ type: 'ACE_AGENT_STATUS' });
      if (res && res.host && res.host.ok) {
        S.host = { ok: true, downloadsRoot: res.host.downloadsRoot || '' };
      } else {
        S.host = { ok: false, downloadsRoot: '' };
      }
    } catch (err) {
      S.host = { ok: false, downloadsRoot: '' };
    }
  }

  /* ------------------------------------------------------------------ *
   * 整理舊檔（面板按鈕 → native host 執行 agent CLI 的 organize）
   * ------------------------------------------------------------------ */
  function extractOrganizeData(res) {
    if (!res || !res.ok) return null;
    const data = res.data && res.data.data ? res.data.data : res.data;
    return data || null;
  }

  async function organizeDryRun() {
    if (S.running) return flash('下載中，等完成後再整理');
    if (!S.host.ok) return flash('需要本機整理工具：請執行 native\\install-host.ps1');
    const btn = S.els.panel && S.els.panel.querySelector('[data-act="organize"]');
    if (btn) btn.classList.add('on');
    flash('正在檢查可整理檔案…');
    try {
      const res = await sendMessage({ type: 'ACE_HOST_ORGANIZE', commit: false });
      const plan = extractOrganizeData(res);
      if (!plan) {
        const why =
          (res && res.error) ||
          (res && res.data && res.data.error) ||
          (res && res.data && res.data.stderr) ||
          '本機工具沒有回應';
        flash('整理檢查失敗：' + String(why).slice(0, 200));
        return;
      }
      if (!plan.ok) {
        flash('整理檢查失敗：' + String(plan.error || '未知錯誤').slice(0, 160));
        return;
      }
      if (!plan.movesFound) return flash('沒有找到需要整理的檔案');
      S.organizePreview = plan;
      renderOrganizeBox(plan);
    } catch (err) {
      flash('整理檢查失敗：' + ((err && err.message) || err));
    } finally {
      if (btn) btn.classList.remove('on');
    }
  }

  function renderOrganizeBox(plan) {
    const box = S.els.organizeBox;
    if (!box) return;
    box.textContent = '';
    const summary = `可整理 ${plan.movesFound} 個檔案（自訂資料夾不動 ${plan.skippedCustomCount || 0}、無法對應 ${plan.unmatchedCount || 0}）`;
    const sample = (plan.moves || [])
      .slice(0, 3)
      .map((move) => `${String(move.from).split('\\').pop()} → ${String(move.to).split('\\').slice(-2).join('\\')}`);
    const body = el('div', { class: 'grow' }, [
      el('div', { text: summary }),
      ...sample.map((line) => el('div', { class: 'hint', text: line })),
    ]);
    const commitBtn = el('button', { class: 'rowbtn', type: 'button', 'data-act': 'organize-commit', text: '執行整理' });
    const cancelBtn = el('button', { class: 'rowbtn', type: 'button', 'data-act': 'organize-cancel', text: '取消' });
    commitBtn.addEventListener('click', () => organizeCommit());
    cancelBtn.addEventListener('click', () => {
      box.hidden = true;
      box.textContent = '';
      S.organizePreview = null;
    });
    box.append(body, commitBtn, cancelBtn);
    box.hidden = false;
  }

  async function organizeCommit() {
    const box = S.els.organizeBox;
    flash('正在整理檔案…');
    try {
      const res = await sendMessage({ type: 'ACE_HOST_ORGANIZE', commit: true });
      const plan = extractOrganizeData(res);
      if (!plan) {
        flash('整理失敗：本機工具沒有回應');
        return;
      }
      if (!plan.ok) {
        flash('整理失敗：' + String(plan.error || '未知錯誤').slice(0, 160));
        return;
      }
      if (box) {
        box.hidden = true;
        box.textContent = '';
      }
      S.organizePreview = null;
      await refreshDownloadIndex(true).catch(() => {});
      renderSongs();
      flash(
        `整理完成：移動 ${plan.movedCount || 0}、重複刪除 ${plan.dedupedCount || 0}、同名跳過 ${plan.conflictCount || 0}、失敗 ${plan.failedCount || 0}`,
      );
    } catch (err) {
      flash('整理失敗：' + ((err && err.message) || err));
    }
  }

  /* ------------------------------------------------------------------ *
   * 一鍵整理 / 成品 MP3（背景執行 + 狀態輪詢）
   * ------------------------------------------------------------------ */
  let tidyPollTimer = 0;

  async function readHostStatus(name) {
    try {
      const res = await sendMessage({ type: 'ACE_HOST_READ', name });
      return res && res.ok && res.data ? res.data : null;
    } catch (err) {
      return null;
    }
  }

  const TIDY_WEIGHTS = { organize: 4, mp3: 26, samples: 8, classify: 8, dedupe: 6, content: 14, folders: 5, audio: 29 };
  const TIDY_LABELS = {
    organize: '整理舊檔',
    mp3: '補齊成品MP3',
    samples: '採樣包分類',
    classify: '檔案分類',
    dedupe: '去重',
    content: '內容去重',
    folders: '重複清理',
    audio: '音頻屬性分類',
    running: '補齊成品MP3',
    done: '完成',
  };

  function tidyPercent(data) {
    if (!data) return 0;
    if (data.phase === 'done') return 100;
    const steps = Array.isArray(data.steps) ? data.steps : [];
    let pct = 0;
    for (const step of steps) pct += TIDY_WEIGHTS[step.name] || 0;
    const weight = TIDY_WEIGHTS[data.phase] || 0;
    if (weight) {
      let fraction = 0.3;
      if (data.total) fraction = Math.min(1, (Number(data.done) || 0) / data.total);
      else if (steps.some((step) => step.name === data.phase)) fraction = 0.6;
      pct += weight * fraction;
    }
    if (data.phase === 'running' && data.total) {
      return Math.min(99, Math.round(((Number(data.done) || 0) / data.total) * 100));
    }
    return Math.min(99, Math.round(pct));
  }

  function renderTidyProgress(data) {
    const bar = S.els.tidyBar;
    if (!bar) return;
    if (!data) {
      bar.hidden = true;
      return;
    }
    const pct = tidyPercent(data);
    bar.hidden = false;
    if (S.els.tidyBarFill) S.els.tidyBarFill.style.width = pct + '%';
    if (S.els.tidyBarText) {
      const label = TIDY_LABELS[data.phase] || '背景整理';
      const detail = data.total ? ` ${Number(data.done) || 0}/${data.total}` : '';
      S.els.tidyBarText.textContent = `${label} ${pct}%${detail}`;
    }
  }

  function startStatusPoll({ name, button, idleText, onDone }) {
    clearInterval(tidyPollTimer);
    if (S.els.tidyBar) S.els.tidyBar.hidden = false;
    tidyPollTimer = setInterval(async () => {
      const data = await readHostStatus(name);
      if (!data) return;
      renderTidyProgress(data);
      if (data.phase === 'done') {
        clearInterval(tidyPollTimer);
        tidyPollTimer = 0;
        if (button) {
          button.classList.remove('on');
          button.textContent = idleText;
        }
        if (S.els.tidyBarFill) S.els.tidyBarFill.style.width = '100%';
        setTimeout(() => {
          if (S.els.tidyBar) S.els.tidyBar.hidden = true;
        }, 3500);
        onDone(data);
      } else if (button) {
        const done = data.done != null && data.total ? ` ${data.done}/${data.total}` : '';
        button.textContent = `${idleText} ${String(data.phase || '')}${done}`;
      }
    }, 2500);
  }

  async function runTidy({ silent = false } = {}) {
    if (!S.host.ok) {
      if (!silent) flash('需要本機整理工具：請重跑 native\\install-host.ps1');
      return;
    }
    if (S.running && !silent) return flash('下載中，等完成後再整理');
    try {
      const res = await sendMessage({ type: 'ACE_HOST_TIDY' });
      if (!res || !res.ok) {
        if (!silent) flash('啟動整理失敗：' + ((res && res.error) || '本機工具沒有回應'));
        return;
      }
      const btn = S.els.tidyBtn;
      if (btn) btn.classList.add('on');
      if (silent) {
        if (S.els.footHint) S.els.footHint.textContent = '已下載完成，背景自動整理中（成品MP3／採樣包／分類／音頻屬性）…';
      } else {
        flash('已開始一鍵整理（背景執行）：舊檔 → 成品MP3 → 採樣包 → 分類 → 音頻屬性分類');
      }
      startStatusPoll({
        name: 'tidy-status',
        button: btn,
        idleText: '一鍵整理',
        onDone: (data) => {
          const steps = (data.steps || [])
            .map((step) => {
              const count = step.downloaded ?? step.copied ?? step.moved ?? step.removed ?? step.linked ?? 0;
              return `${step.name}:${count}`;
            })
            .join('、');
          const audio = (data.steps || []).find((step) => step.name === 'audio') || {};
          const skipped = Number(audio.unanalyzable) || 0;
          const failed = (data.steps || []).reduce((sum, step) => sum + (Number(step.failed) || 0), 0);
          const notes = [
            skipped ? `${skipped} 檔無法分析，已略過` : '',
            failed ? `${failed} 個步驟有失敗` : '',
            data.ok === false && !failed && !skipped ? '部分步驟回報失敗' : '',
          ].filter(Boolean);
          flash('一鍵整理完成' + (steps ? '（' + steps + '）' : '') + (notes.length ? '；' + notes.join('；') : ''));
          refreshDownloadIndex(true)
            .then(() => renderSongs())
            .catch(() => {});
        },
      });
    } catch (err) {
      if (!silent) flash('啟動整理失敗：' + ((err && err.message) || err));
    }
  }

  async function runExtractMp3() {
    if (!S.host.ok) return flash('需要本機整理工具：請重跑 native\\install-host.ps1');
    if (S.running) return flash('下載中，等完成後再補齊');
    try {
      const res = await sendMessage({ type: 'ACE_HOST_EXTRACT_MP3' });
      if (!res || !res.ok) return flash('啟動失敗：' + ((res && res.error) || '本機工具沒有回應'));
      const btn = S.els.extractMp3Btn;
      if (btn) btn.classList.add('on');
      flash('已開始補齊成品 MP3（背景執行，完成會提示）');
      startStatusPoll({
        name: 'extract-status',
        button: btn,
        idleText: '成品MP3',
        onDone: (data) => {
          const failed = (data.failed || []).length;
          flash(`成品 MP3 完成：共 ${data.total || 0} 首（補下載 ${data.downloaded || 0}、複製 ${data.copied || 0}${failed ? `、失敗 ${failed}` : ''}）`);
          refreshDownloadIndex(true).then(() => renderSongs()).catch(() => {});
        },
      });
    } catch (err) {
      flash('啟動失敗：' + ((err && err.message) || err));
    }
  }

  function hostCliData(res) {
    if (!res || !res.ok) return null;
    return res.data && res.data.data ? res.data.data : res.data;
  }

  async function runDedupeCustom() {
    if (!S.host.ok) return flash('需要本機整理工具：請重跑 native\\install-host.ps1');
    if (S.running) return flash('下載中，等完成後再清理');
    const btn = S.els.dedupeCustomBtn;
    if (btn) btn.classList.add('on');
    try {
      const res = await sendMessage({ type: 'ACE_HOST_DEDUPE_CUSTOM' });
      const data = hostCliData(res);
      if (!data || !data.ok) return flash('清理失敗：' + ((res && res.error) || '本機工具沒有回應'));
      const payload = data.data || {};
      flash(`自訂資料夾去重完成：搬移 ${payload.moved || 0} 檔、回收 ${Math.round((payload.bytesReclaimed || 0) / 1048576)} MB（備份在 organize-backups）`);
      await refreshDownloadIndex(true).catch(() => {});
      renderSongs();
    } catch (err) {
      flash('清理失敗：' + ((err && err.message) || err));
    } finally {
      if (btn) btn.classList.remove('on');
    }
  }

  async function runWatch() {
    if (!S.host.ok) return flash('需要本機整理工具：請重跑 native\\install-host.ps1');
    try {
      const res = await sendMessage({ type: 'ACE_HOST_WATCH' });
      const data = hostCliData(res);
      if (!data || !data.ok) return flash('啟動背景整理失敗：' + ((res && res.error) || '本機工具沒有回應'));
      flash(
        data.alreadyRunning
          ? '背景自動整理已在執行中'
          : data.replacedStale
            ? '背景自動整理已重新啟動（上次中斷留下的紀錄已取代）'
            : '已啟動背景自動整理：之後新下載會自動分類（成品MP3／採樣包／音頻屬性）',
      );
    } catch (err) {
      flash('啟動背景整理失敗：' + ((err && err.message) || err));
    }
  }

  async function openClassifyFolder() {
    try {
      const res = await sendMessage({ type: 'ACE_HOST_OPEN_FOLDER', folder: 'ai音樂/音頻分類' });
      if (res && res.ok) flash('已開啟分類資料夾：' + (res.path || 'ai音樂\\音頻分類'));
      else flash('開啟失敗：' + ((res && res.error) || '本機工具沒有回應'));
    } catch (err) {
      flash('開啟失敗：' + ((err && err.message) || err));
    }
  }

  /* ------------------------------------------------------------------ *
   * 已下載狀態（檔案系統 + 下載紀錄）與防重複下載
   * ------------------------------------------------------------------ */
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  async function refreshDownloadIndex(force) {
    if (!S.host.ok) return false;
    if (!force && Date.now() - S.fsAt < 20000) return true;
    let res = null;
    try {
      res = await sendMessage({
        type: 'ACE_HOST_LIST',
        maxDepth: 3,
        extensions: ['mp3', 'wav', 'mid', 'midi', 'musicxml', 'pdf', 'jpg', 'jpeg', 'png', 'webp'],
        limit: 8000,
      });
    } catch (err) {
      return false;
    }
    if (!res || !res.ok || !Array.isArray(res.files)) return false;
    const root = String(res.root || S.host.downloadsRoot || '').replace(/[\\/]+$/, '');
    const rootPrefix = root ? root.toLowerCase() + '\\' : '';
    const abs = new Set();
    const rel = new Set();
    const names = new Set();
    for (const file of res.files) {
      const absLow = String((file && file.path) || '').toLowerCase();
      if (!absLow) continue;
      abs.add(absLow);
      names.add(absLow.slice(absLow.lastIndexOf('\\') + 1));
      if (rootPrefix && absLow.startsWith(rootPrefix)) rel.add(absLow.slice(rootPrefix.length).split('\\').join('/'));
    }
    S.fsAbs = abs;
    S.fsRel = rel;
    S.fsNames = names;
    S.fsAt = Date.now();
    await refreshDoneKinds();
    return true;
  }

  function songForUrl(url) {
    if (!url) return null;
    return (
      S.songs.find(
        (song) =>
          song &&
          (url.includes(song.task_id) ||
            (song.local_cover && (song.local_cover === url || url.endsWith(String(song.local_cover).split('?')[0])))),
      ) || null
    );
  }

  async function refreshDoneKinds() {
    const done = new Map();
    const add = (taskId, key) => {
      if (!taskId) return;
      if (!done.has(taskId)) done.set(taskId, new Set());
      done.get(taskId).add(key);
    };
    const addKey = (taskId, key) => {
      if (key === 'midi' || key === 'musicxml' || key === 'mp3' || key === 'cover' || key === 'wav') add(taskId, key);
      else if (String(key).startsWith('stem:')) add(taskId, 'stem:' + String(key).slice(5));
    };
    for (const [taskId, entry] of Object.entries(S.history || {})) {
      for (const key of Object.keys((entry && entry.files) || {})) addKey(taskId, key);
    }
    try {
      const res = await sendMessage({ type: 'ACE_HOST_READ', name: 'history' });
      const items = res && res.ok && res.data && Array.isArray(res.data.items) ? res.data.items : [];
      for (const record of items) {
        if (!record || record.state !== 'complete' || !record.filename) continue;
        if (!S.fsAbs.has(String(record.filename).toLowerCase())) continue;
        const url = String(record.finalUrl || record.url || '');
        const song = songForUrl(url);
        if (!song) continue;
        if (song.local_cover && (song.local_cover === url || url.endsWith(String(song.local_cover).split('?')[0]))) {
          add(song.task_id, 'cover');
          continue;
        }
        const stem = url.match(/-stem\d+-([a-z_]+)\.mp3/i);
        if (stem) add(song.task_id, 'stem:' + stem[1].toLowerCase());
        else if (/-parts-dl\.mid/i.test(url)) add(song.task_id, 'midi');
        else if (/score\.musicxml/i.test(url)) add(song.task_id, 'musicxml');
        else if (/[?&]kind=mp3\b/i.test(url)) add(song.task_id, 'mp3');
        else if (/[?&]kind=wav\b/i.test(url)) add(song.task_id, 'wav');
      }
    } catch (err) {
      /* ignore */
    }
    try {
      const res = await sendMessage({ type: 'ACE_HOST_READ', name: 'agent-state' });
      const data = (res && res.ok && res.data) || {};
      const hist = data.history || {};
      for (const [taskId, entry] of Object.entries(hist)) {
        for (const [key, info] of Object.entries((entry && entry.files) || {})) {
          const absPath = String((info && info.absolute) || '').toLowerCase();
          if (absPath && !S.fsAbs.has(absPath)) continue;
          addKey(taskId, key);
        }
      }
      // 去重紀錄：removedPaths/aliases 讓面板知道「這個檔案/歌曲已由 keeper 代替」，不再重下
      S.agentAliases = TEST_MODE ? {} : data.aliases || {};
      S.removedPaths = TEST_MODE ? {} : data.removedPaths || {};
      const downloadsRoot = String((S.host && S.host.downloadsRoot) || '').replace(/[\\/]+$/, '');
      const toRel = (abs) => {
        const value = String(abs || '');
        if (!downloadsRoot || !value) return '';
        if (!value.toLowerCase().startsWith(downloadsRoot.toLowerCase())) return '';
        return value.slice(downloadsRoot.length).replace(/^[\\/]+/, '').split('\\').join('/').toLowerCase();
      };
      S.removedRel = new Map();
      for (const [abs, keeper] of Object.entries(S.removedPaths)) {
        const rel = toRel(abs);
        const keeperRel = toRel(keeper);
        if (rel && keeperRel) S.removedRel.set(rel, keeperRel);
      }
    } catch (err) {
      /* ignore */
    }
    // alias：被去重的歌曲沿用 keeper 的下載狀態（顯示「已下載」而不是「未下載」）
    for (const [taskId, keeperId] of Object.entries(S.agentAliases || {})) {
      const kinds = done.get(keeperId);
      if (kinds) done.set(taskId, new Set(kinds));
    }
    S.doneKinds = done;
  }

  /** 每首歌目前的下載進度：{have,total,allDone,any,known,detail,mp3} */
  function songDownloadStatus(song) {
    const title = N.songFolderLabel((song.meta && song.meta.title) || '');
    const group = P.pickStemGroup(song.stems);
    const labels = new Map();
    if (group) {
      for (const track of group.tracks) labels.set(N.stemLabel(track.type).toLowerCase(), N.stemLabel(track.type));
    }
    const stemsFound = new Set();
    let midi = false;
    let musicxml = false;
    let mp3 = false;
    let wav = false;
    let cover = false;
    if (S.fsAt) {
      const re = new RegExp('^' + escRe(title) + '(?: \\(\\d+\\))?(?: - (.+))?\\.([a-z0-9]+)$', 'i');
      for (const name of S.fsNames) {
        const match = re.exec(name);
        if (!match) continue;
        const suffix = match[1] ? match[1].trim().toLowerCase() : '';
        const ext = match[2].toLowerCase();
        if (suffix === 'cover') cover = true;
        else if (suffix === 'midi') midi = true;
        else if (suffix === 'musicxml') musicxml = true;
        else if (!suffix) {
          if (ext === 'mp3') mp3 = true;
          else if (ext === 'wav') wav = true;
          else if (ext === 'mid' || ext === 'midi') midi = true;
          else if (ext === 'musicxml') musicxml = true;
        } else if (labels.has(suffix)) stemsFound.add(labels.get(suffix));
      }
    }
    const done = S.doneKinds.get(song.task_id) || new Set();
    for (const key of done) {
      if (String(key).startsWith('stem:')) stemsFound.add(String(key).slice(5));
      else if (key === 'midi') midi = true;
      else if (key === 'musicxml') musicxml = true;
      else if (key === 'mp3') mp3 = true;
      else if (key === 'wav') wav = true;
      else if (key === 'cover') cover = true;
    }
    const stemsTotal = group ? group.tracks.length : 0;
    const stemsHave = stemsTotal ? Math.min(stemsTotal, stemsFound.size) : 0;
    const detail = [];
    if (stemsTotal) detail.push({ label: '分軌', have: stemsHave, total: stemsTotal, done: stemsHave >= stemsTotal });
    if (P.midiAvailable(song)) detail.push({ label: 'MIDI', have: midi ? 1 : 0, total: 1, done: midi });
    if (P.midiAvailable(song)) detail.push({ label: 'MusicXML', have: musicxml ? 1 : 0, total: 1, done: musicxml });
    if (song.local_cover) detail.push({ label: '封面', have: cover ? 1 : 0, total: 1, done: cover });
    const have = detail.reduce((sum, item) => sum + item.have, 0);
    const total = detail.reduce((sum, item) => sum + item.total, 0);
    return {
      have,
      total,
      allDone: total > 0 && have >= total,
      any: have > 0,
      mp3,
      wav,
      detail,
      known: !!S.fsAt || S.doneKinds.size > 0,
    };
  }

  function downloadStatusLabel(status) {
    const detail = status.detail
      .map((item) => (item.total > 1 ? `${item.label} ${item.have}/${item.total}` : `${item.label}${item.done ? '✓' : '✗'}`))
      .join('、');
    if (!status.known) return { text: '狀態未知', cls: 'dim', title: '本機整理工具未安裝，無法檢查已下載檔案' };
    if (status.allDone) return { text: '已下載', cls: 'ok', title: '已下載：' + detail };
    if (status.any) return { text: `部分 ${status.have}/${status.total}`, cls: 'warn', title: '已下載：' + detail };
    return { text: '未下載', cls: 'dim', title: '尚未下載：' + detail };
  }

  function updateFab() {
    const fab = S.els.fab;
    if (!fab) return;
    fab.classList.toggle('running', S.running);
    S.els.fabText.textContent = S.running ? '下載中 ' + progressPercent() + '%' : '批量下載';
  }

  function progressPercent() {
    const p = S.progress;
    if (!p.total) return 0;
    return clamp(Math.round(((p.done + p.failed) / p.total) * 100), 0, 100);
  }

  /* ------------------------------------------------------------------ *
   * 歌單
   * ------------------------------------------------------------------ */
  /** 抓一次完整歌單（含分頁）；回傳 { songs, error }，不碰 UI 狀態 */
  async function loadSongsFromApi() {
    const collected = [];
    let after = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT), sort: 'new' });
      if (after) params.set('after', after);
      const response = await fetch('/api/songs?' + params.toString(), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (response.status === 401 || response.status === 403) {
        return { songs: [], error: '請先登入 ACE Music 帳號，登入後按 ↻ 重新整理歌單。' };
      }
      if (!response.ok) throw new Error('伺服器回應 HTTP ' + response.status);
      const data = await response.json().catch(() => null);
      const items = data && Array.isArray(data.items) ? data.items : [];
      collected.push(...items);
      after = (data && data.next) || '';
      if (!after || !items.length) break;
    }
    return { songs: collected.filter((song) => song && song.task_id && P.isDone(song)), error: '' };
  }

  /** 歌單是否實質改變（用來避免自動更新時無謂重繪） */
  function songsSignature(songs) {
    return songs
      .map((song) => {
        const group = P.pickStemGroup(song.stems);
        const stemsKey = group ? group.mode + ':' + group.tracks.length : 'none';
        return [song.task_id, song.status, (song.meta && song.meta.title) || '', stemsKey, song.local_audio ? 1 : 0].join('~');
      })
      .join('|');
  }

  function applySongs(songs) {
    const sig = songsSignature(songs);
    const changed = sig !== S.lastSig;
    S.songs = songs;
    S.lastSig = sig;
    S.selected = new Set([...S.selected].filter((id) => S.songs.some((song) => song.task_id === id)));
    const time = new Date();
    S.lastUpdated = time.toLocaleTimeString('zh-TW', { hour12: false });
    if (changed) renderSongs();
    else updateCounts();
  }

  async function fetchSongs() {
    if (S.loading) return;
    S.loading = true;
    S.loadError = '';
    renderSongs();
    try {
      const result = await loadSongsFromApi();
      if (result.error) {
        S.loadError = result.error;
        S.songs = [];
        S.lastSig = '';
      } else {
        applySongs(result.songs);
      }
    } catch (err) {
      S.loadError = '歌單載入失敗：' + ((err && err.message) || err);
      S.songs = [];
      S.lastSig = '';
    } finally {
      S.loading = false;
      S.loaded = true;
      renderSongs();
      refreshHostStatus()
        .then(() => refreshDownloadIndex(true))
        .then(() => {
          if (S.songs.length) renderSongs();
        });
    }
  }

  /** 安靜刷新：背景每 8 秒抓一次，讓「分軌處理中 → 分軌 N」自動出現，不必手動重整頁面 */
  async function refreshSongsQuiet() {
    if (S.loading || S.quietLoading) return;
    S.quietLoading = true;
    try {
      const result = await loadSongsFromApi();
      if (result.error) {
        if (!S.songs.length && result.error !== S.loadError) {
          S.loadError = result.error;
          renderSongs();
        }
        return;
      }
      if (S.loadError) S.loadError = '';
      applySongs(result.songs);
    } catch (err) {
      /* 背景刷新失敗不吵使用者，等下一次 */
    } finally {
      S.quietLoading = false;
    }
  }

  function startAutoRefresh() {
    clearInterval(S.autoTimer);
    S.autoTimer = 0;
    if (!S.options.autoRefresh) return;
    S.autoTimer = setInterval(() => {
      if (S.els.panel && S.els.panel.hidden) return;
      if (document.hidden) return;
      refreshSongsQuiet();
      if (S.host.ok) {
        refreshDownloadIndex(false).then(() => {
          if (S.songs.length) renderSongs();
        });
      }
    }, AUTO_REFRESH_MS);
  }

  function songBadges(song) {
    const nodes = [];
    const group = P.pickStemGroup(song.stems);
    if (group) {
      nodes.push(el('span', { class: 'badge ok', text: `分軌 ${group.tracks.length}` }));
    } else if (song.stems && (song.stems['0'] || song.stems['2'])) {
      nodes.push(el('span', { class: 'badge warn', text: '分軌處理中' }));
    } else {
      nodes.push(el('span', { class: 'badge dim', text: '未分軌' }));
    }
    if (P.midiAvailable(song)) nodes.push(el('span', { class: 'badge', text: 'MIDI 可用' }));
    if (song.result && song.result.duration_sec) {
      const sec = Math.round(song.result.duration_sec);
      nodes.push(el('span', { class: 'badge dim', text: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` }));
    }
    return nodes;
  }

  function renderSongs() {
    const box = S.els.songsBox;
    if (!box) return;
    box.textContent = '';
    if (S.loading && !S.songs.length) {
      box.append(el('div', { class: 'hint', text: '載入歌單中…' }));
      updateCounts();
      return;
    }
    if (S.loadError) {
      box.append(el('div', { class: 'hint err', text: S.loadError }));
      updateCounts();
      return;
    }
    if (!S.loaded) {
      box.append(el('div', { class: 'hint', text: '按右上角 ↻ 載入你的歌曲。' }));
      updateCounts();
      return;
    }
    if (!S.songs.length) {
      box.append(el('div', { class: 'hint', text: '找不到已完成的歌曲（只有狀態為完成的歌才能下載）。' }));
      updateCounts();
      return;
    }
    const list = S.onlyUndownloaded ? S.songs.filter((song) => !songDownloadStatus(song).allDone) : S.songs;
    if (!list.length) {
      box.append(el('div', { class: 'hint', text: S.onlyUndownloaded ? '太棒了，所有歌曲都下載完成了（或有檔案無法辨識）。' : '找不到已完成的歌曲。' }));
      updateCounts();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const song of list) frag.append(songRow(song));
    box.append(frag);
    updateCounts();
  }

  function songRow(song) {
    const title = (song.meta && song.meta.title) || 'Untitled';
    const checkbox = el('input', { type: 'checkbox', 'data-song-pick': '' });
    checkbox.checked = S.selected.has(song.task_id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) S.selected.add(song.task_id);
      else S.selected.delete(song.task_id);
      updateCounts();
    });
    const cover = el('img', { class: 'cover', alt: '', loading: 'lazy' });
    if (song.local_cover) cover.src = song.local_cover;
    else cover.style.visibility = 'hidden';
    const status = songDownloadStatus(song);
    const statusLabel = downloadStatusLabel(status);
    const statusBadge = el('span', {
      class: 'badge ' + statusLabel.cls,
      'data-download-status': statusLabel.text,
      title: statusLabel.title,
      text: statusLabel.text,
    });
    const meta = el('div', { class: 'meta' }, songBadges(song));
    meta.append(statusBadge);
    if (status.mp3) meta.append(el('span', { class: 'badge dim', text: 'MP3 已下載' }));
    if (status.wav) meta.append(el('span', { class: 'badge dim', text: 'WAV 已下載' }));
    const body = el('div', { class: 'body' }, [el('div', { class: 'name', text: title, title }), meta]);
    const perSong = el('button', { class: 'rowbtn', type: 'button', 'data-song-download': '', text: '下載' });
    perSong.addEventListener('click', () => {
      if (S.running) return flash('已有下載進行中');
      startJob([song]);
    });
    return el('div', { class: 'song', 'data-song-id': song.task_id }, [checkbox, cover, body, perSong]);
  }

  function updateCounts() {
    const label = S.els.countLabel;
    if (label) {
      const parts = [];
      if (S.songs.length) {
        const pending = S.songs.filter((song) => !songDownloadStatus(song).allDone).length;
        parts.push(`已選 ${S.selected.size} / 共 ${S.songs.length} 首`);
        parts.push(`未下載 ${pending}`);
      }
      if (S.lastUpdated) parts.push(`更新 ${S.lastUpdated}`);
      label.textContent = parts.join(' · ');
    }
    const btn = S.els.downloadBtn;
    if (btn) {
      const count = S.selected.size;
      btn.textContent = S.running ? '下載中…' : `下載選中${count ? `（${count} 首）` : ''}`;
      btn.disabled = S.running || count === 0;
    }
    const cancel = S.els.cancelBtn;
    if (cancel) cancel.hidden = !S.running;
  }

  /* ------------------------------------------------------------------ *
   * 進度
   * ------------------------------------------------------------------ */
  const PHASE_TEXT = {
    idle: '',
    running: '下載中',
    generating: '生成檔案中',
    cancelling: '停止中…',
    done: '完成',
    cancelled: '已停止',
  };

  function renderProgress() {
    if (!S.els.progress) return;
    const p = S.progress;
    const show = p.phase !== 'idle';
    S.els.progress.hidden = !show;
    if (!show) return;
    S.els.barFill.style.width = progressPercent() + '%';
    S.els.stats.textContent = '';
    const chip = (label, value, strong) => {
      const node = el('span', null, [label + ' ', strong ? el('b', { text: String(value) }) : String(value)]);
      return node;
    };
    const elapsedSec = p.elapsedMs ? Math.round(p.elapsedMs / 1000) : S.running && S.jobStartedAt ? Math.round((Date.now() - S.jobStartedAt) / 1000) : 0;
    S.els.stats.append(
      chip('完成', p.done, true),
      chip('失敗', p.failed, true),
      chip('跳過', p.skipped, true),
      chip('共', p.total, true),
    );
    if (p.activePrep > 0) S.els.stats.append(chip('生成中', p.activePrep, true));
    if (elapsedSec > 0) S.els.stats.append(chip('時間', elapsedSec + 's', false));
    const phase = PHASE_TEXT[p.phase] || '';
    let currentText = p.current;
    if (p.activeDl > 1) currentText += `（${p.activeDl} 個並行）`;
    if (!currentText && p.activePrep > 0) currentText = `站點生成 MIDI/MusicXML 中（${p.activePrep} 個）…`;
    S.els.current.textContent = [phase, currentText].filter(Boolean).join('：');
    S.els.current.title = currentText || '';
    const failedShown = S.failedList.length;
    S.els.failedDetails.hidden = failedShown === 0;
    S.els.failedList.textContent = '';
    for (const item of S.failedList.slice(-200)) {
      S.els.failedList.append(el('li', { text: `${item.name} — ${item.error}` }));
    }
    const summary = S.els.failedDetails.querySelector('summary');
    if (summary) summary.textContent = `失敗清單（${failedShown}）`;
    const showFolder = S.els.showFolderBtn;
    if (showFolder) showFolder.hidden = !(p.phase === 'done' || p.phase === 'cancelled');
    updateFab();
    updateCounts();
  }

  /** 進度重繪節流：並行下載時避免每個事件都重排 DOM */
  function renderProgressSoon() {
    if (S.renderTimer) return;
    S.renderTimer = setTimeout(() => {
      S.renderTimer = 0;
      renderProgress();
    }, 80);
  }

  /* ------------------------------------------------------------------ *
   * 儲存設定 / 歷史 / 資料夾指派
   * ------------------------------------------------------------------ */
  function saveSettings() {
    storageSet({ [KEY_SETTINGS]: { options: { ...S.options }, rootFolder: S.rootFolder } });
  }

  async function loadSettings() {
    const got = await storageGet([KEY_SETTINGS]);
    const saved = got[KEY_SETTINGS];
    if (saved && typeof saved === 'object') {
      if (saved.options && typeof saved.options === 'object') {
        for (const key of Object.keys(DEFAULT_OPTIONS)) {
          const value = saved.options[key];
          if (typeof DEFAULT_OPTIONS[key] === 'number') {
            const num = Number(value);
            if (Number.isFinite(num)) S.options[key] = clamp(Math.round(num), 1, 6);
          } else if (typeof value === 'boolean') {
            S.options[key] = value;
          }
        }
      }
      if (typeof saved.rootFolder === 'string' && N.sanitizeComponent(saved.rootFolder, 40)) {
        S.rootFolder = N.sanitizeComponent(saved.rootFolder, 40);
      }
    }
    syncOptionsToUi();
    startAutoRefresh();
  }

  function syncOptionsToUi() {
    const panel = S.els.panel;
    if (!panel) return;
    for (const [key, value] of Object.entries(S.options)) {
      const node = panel.querySelector(`[data-opt="${key}"]`);
      if (!node) continue;
      if (node.tagName === 'SELECT') node.value = String(value);
      else if (node.type === 'checkbox') node.checked = !!value;
    }
    const rootInput = panel.querySelector('[data-root-folder]');
    if (rootInput) rootInput.value = S.rootFolder;
  }

  async function loadDownloadState() {
    const got = await storageGet([KEY_HISTORY, KEY_FOLDERS]);
    S.history = got[KEY_HISTORY] && typeof got[KEY_HISTORY] === 'object' ? got[KEY_HISTORY] : {};
    const folders = got[KEY_FOLDERS] && typeof got[KEY_FOLDERS] === 'object' ? got[KEY_FOLDERS] : {};
    S.folderByTask = folders.folderByTask && typeof folders.folderByTask === 'object' ? folders.folderByTask : {};
    S.ownerByFolder = folders.ownerByFolder && typeof folders.ownerByFolder === 'object' ? folders.ownerByFolder : {};
  }

  function saveFolders() {
    return storageSet({ [KEY_FOLDERS]: { folderByTask: S.folderByTask, ownerByFolder: S.ownerByFolder } });
  }

  function saveHistorySoon() {
    clearTimeout(S.historyTimer);
    S.historyTimer = setTimeout(() => {
      S.historyTimer = 0;
      storageSet({ [KEY_HISTORY]: S.history });
    }, 400);
  }

  async function flushHistory() {
    clearTimeout(S.historyTimer);
    S.historyTimer = 0;
    await storageSet({ [KEY_HISTORY]: S.history });
  }

  /** 站點 API：MIDI / MusicXML 由站點生成後回傳 URL（生成期間由呼叫端顯示進度） */
  async function createApiFile(songId, kind) {
    const endpoint = `/api/songs/${encodeURIComponent(songId)}/download`;
    const deadline = Date.now() + 180000;
    let response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    while (response.status === 202) {
      if (Date.now() > deadline) throw new Error(`${kind} 生成逾時`);
      await sleep(1500);
      response = await fetch(`${endpoint}?kind=${encodeURIComponent(kind)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.url) {
      const detail = (data && (data.error || data.message)) || `HTTP ${response.status}`;
      if (response.status === 402) throw new Error('目前方案不含此下載：' + detail);
      throw new Error(String(detail));
    }
    return new URL(data.url, location.origin).href;
  }

  /** MP3 / WAV：先問站點（?as=parts）拿正確的檔案 URL；伺服器要自己產檔時用原連結 */
  async function resolveFileUrl(songId, kind) {
    const direct = `${location.origin}/api/songs/${encodeURIComponent(songId)}/file?kind=${encodeURIComponent(kind)}`;
    let response;
    try {
      response = await fetch(`${direct}&as=parts`, { credentials: 'same-origin', cache: 'no-store' });
    } catch (_) {
      return direct;
    }
    if (!response.ok) {
      if (response.status === 402) throw new Error('目前方案不含此下載（HTTP 402）');
      if (response.status === 401 || response.status === 403) throw new Error('站點拒絕下載（HTTP ' + response.status + '）');
      // WAV 只有部分模型（例如 amusic-v1.1）支援；不支援時跳過，不算失敗
      if (kind === 'wav' && response.status === 404) {
        const err = new Error('此歌曲的模型不提供 WAV（站點 404）');
        err.code = 'WAV_UNSUPPORTED';
        throw err;
      }
      return direct;
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return direct;
    if (data.server) return direct;
    if (typeof data.audio === 'string' && data.audio) return new URL(data.audio, location.origin).href;
    if (typeof data.url === 'string' && data.url) return new URL(data.url, location.origin).href;
    return direct;
  }

  /* ------------------------------------------------------------------ *
   * 下載
   * ------------------------------------------------------------------ */
  async function attemptDownload(url, filename, timeoutMs = 200000) {
    const conflictAction = S.options.force ? 'overwrite' : 'uniquify';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await Promise.race([
          sendMessage({
            type: 'ACE_DOWNLOAD_FILE',
            url,
            filename,
            conflictAction,
          }),
          sleep(timeoutMs).then(() => ({ ok: false, error: '下載逾時（' + Math.round(timeoutMs / 1000) + ' 秒）' })),
        ]);
        if (response && typeof response.ok === 'boolean') return response;
        return { ok: false, error: 'service worker 無回應' };
      } catch (err) {
        if (attempt === 0) {
          await sleep(400);
          continue;
        }
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    return { ok: false, error: 'service worker 無回應' };
  }

  /** 備援：由頁面（帶 Cookie）把檔案抓成 blob URL，再交給 service worker 下載 */
  async function fetchAsBlobUrl(url) {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error('備援抓檔失敗 HTTP ' + response.status);
    const blob = await response.blob();
    if (!blob.size) throw new Error('備援抓檔為空');
    return URL.createObjectURL(blob);
  }

  async function startJob(songs) {
    if (S.running) {
      flash('已有下載進行中');
      return;
    }
    const types = FILE_TYPES.filter((type) => S.options[type]);
    if (!types.length) {
      flash('請至少勾選一種檔案類型');
      return;
    }
    await loadDownloadState();
    const plan = P.buildDownloadPlan({
      songs,
      options: {
        types,
        root: S.rootFolder,
        typeFolders: S.options.typeFolders,
        force: S.options.force,
        origin: location.origin,
      },
      state: { folderByTask: S.folderByTask, ownerByFolder: S.ownerByFolder, history: S.history },
      origin: location.origin,
    });
    S.folderByTask = plan.folderByTask;
    S.ownerByFolder = plan.ownerByFolder;
    await saveFolders();

    // 用實際檔案系統再跳過一次，避免重新下載之前（擴充功能／CLI／站點）已經抓過的檔案
    if (S.host.ok && !S.options.force && !TEST_MODE) {
      await refreshDownloadIndex(true).catch(() => {});
      let fsSkipped = 0;
      const aliases = S.agentAliases || {};
      const removedRel = S.removedRel || new Map();
      for (const task of plan.tasks) {
        const aliased = !!aliases[task.task_id];
        for (const file of task.files) {
          if (file.skip) continue;
          const rel = String(file.path).toLowerCase();
          let skip = aliased || S.fsRel.has(rel);
          if (!skip && removedRel.has(rel)) skip = S.fsRel.has(removedRel.get(rel));
          if (!skip) skip = S.fsNames.has(String(file.filename || '').toLowerCase());
          if (skip) {
            file.skip = true;
            fsSkipped += 1;
          }
        }
      }
      if (fsSkipped) {
        plan.skipped += fsSkipped;
        plan.toDownload = Math.max(0, plan.toDownload - fsSkipped);
      }
    }

    if (!plan.toDownload) {
      S.progress = { done: 0, skipped: plan.skipped, failed: 0, total: plan.total, current: '', phase: 'done', activeDl: 0, activePrep: 0, elapsedMs: 0 };
      renderProgress();
      flash(`沒有需要下載的檔案（${plan.total} 個都已存在，可勾「強制重下」）`);
      return;
    }

    // 工作清單：可以直接抓的（分軌 / MP3 / WAV）先跑；MIDI、MusicXML 排後面，
    // 但它們的「站點生成」會在背景同時開始，跟分軌下載重疊，不用一個一個等。
    const entries = [];
    for (const task of plan.tasks) {
      for (const file of task.files) {
        if (file.skip) continue;
        entries.push({ task, file, prepDone: file.source === 'url', url: '', prepError: null, preparing: false });
      }
    }
    entries.sort((a, b) => (a.file.source === 'url' ? 0 : 1) - (b.file.source === 'url' ? 0 : 1));

    const concurrency = clamp(Math.round(Number(S.options.concurrency) || 4), 1, 6);
    const apiEntries = entries.filter((entry) => entry.file.source !== 'url');
    const apiConcurrency = clamp(Math.min(3, apiEntries.length), 1, 3);

    S.running = true;
    S.cancelled = false;
    S.failedList = [];
    S.jobStartedAt = Date.now();
    S.progress = {
      done: 0,
      skipped: plan.skipped,
      failed: 0,
      total: plan.total,
      current: '',
      phase: 'running',
      activeDl: 0,
      activePrep: 0,
      elapsedMs: 0,
    };
    renderProgress();
    updateCounts();
    sendBadge('0%');

    let done = 0;
    let failed = 0;
    let bytes = 0;
    const activeNames = new Set();

    const countActivePrep = () => apiEntries.filter((entry) => entry.preparing && !entry.prepDone).length;

    // 生成階段：背景向站點要 MIDI / MusicXML 的檔案 URL（最多 3 個並行）
    const prepPromise = (async () => {
      let prepCursor = 0;
      const prepWorker = async () => {
        while (true) {
          if (S.cancelled || !S.running) return;
          const index = prepCursor++;
          if (index >= apiEntries.length) return;
          const entry = apiEntries[index];
          entry.preparing = true;
          S.progress.activePrep = countActivePrep();
          renderProgressSoon();
          try {
            const planned = String(entry.file.sourceUrl || '');
            // MP3 若 planner 已給 local_audio（上傳型歌曲）就直接用，不要再問 /file?kind=mp3（會回 JSON）
            const genericFileUrl = !planned || /\/api\/songs\/[^/]+\/file\?kind=(mp3|wav)\b/i.test(planned);
            entry.url =
              entry.file.source === 'api'
                ? await createApiFile(entry.task.task_id, entry.file.apiKind)
                : genericFileUrl
                  ? await resolveFileUrl(entry.task.task_id, entry.file.kind)
                  : planned;
          } catch (err) {
            if (err && err.code === 'WAV_UNSUPPORTED') {
              entry.unsupported = true;
              if (!S.cancelled && S.running) {
                S.progress.skipped = (Number(S.progress.skipped) || 0) + 1;
                renderProgressSoon();
              }
            } else {
              entry.prepError = err;
              if (!S.cancelled && S.running) {
                failed += 1;
                S.progress.failed = failed;
                S.failedList.push({
                  name: `${entry.task.folder}／${entry.file.filename}`,
                  error: friendlyError((err && err.message) || err),
                });
              }
            }
          } finally {
            entry.preparing = false;
            entry.prepDone = true;
            S.progress.activePrep = S.running ? countActivePrep() : 0;
            if (S.running) {
              renderProgressSoon();
              sendBadge(progressPercent() + '%');
            }
          }
        }
      };
      await Promise.all(Array.from({ length: apiConcurrency }, () => prepWorker()));
    })();
    prepPromise.catch(() => {});

    let dlCursor = 0;
    const downloadWorker = async () => {
      while (true) {
        if (S.cancelled) return;
        const index = dlCursor++;
        if (index >= entries.length) return;
        const entry = entries[index];
        const { task, file } = entry;
        if (S.cancelled) return;
        activeNames.add(file.filename);
        S.progress.activeDl = activeNames.size;
        S.progress.current = `${task.folder}／${file.filename}`;
        renderProgressSoon();
        try {
          let url = file.sourceUrl || '';
          if (file.source !== 'url') {
            while (!entry.prepDone && !S.cancelled) await sleep(80);
            if (S.cancelled) return;
            if (entry.unsupported) continue;
            if (entry.prepError) throw { counted: true, error: entry.prepError };
            url = entry.url;
          }
          let result = await attemptDownload(url, file.path);
          if (!result.ok && S.cancelled) return;
          if (!result.ok) {
            const firstError = result.error || '下載失敗';
            let blobUrl = '';
            try {
              blobUrl = await fetchAsBlobUrl(url);
            } catch (fallbackError) {
              throw new Error(`${firstError}；備援抓檔失敗：${(fallbackError && fallbackError.message) || fallbackError}`);
            }
            try {
              result = await attemptDownload(blobUrl, file.path);
              if (!result.ok) throw new Error(`${firstError}；備援下載失敗：${result.error || '未知錯誤'}`);
            } finally {
              setTimeout(() => {
                try {
                  URL.revokeObjectURL(blobUrl);
                } catch (_) {
                  /* ignore */
                }
              }, 120000);
            }
          }
          done += 1;
          bytes += Number(result.bytes) || 0;
          // 若 Chrome 沒有採用我們指定的檔名（伺服器 Content-Disposition 蓋掉），用本機整理工具自動改名/搬到正確位置
          if (result.mismatch && S.options.autoFix && S.host.ok && S.host.downloadsRoot && result.actualPath) {
            try {
              const target = S.host.downloadsRoot.replace(/[\\/]+$/, '') + '\\' + file.path.split('/').join('\\');
              const fix = await sendMessage({ type: 'ACE_HOST_MOVE', moves: [{ from: result.actualPath, to: target }] });
              if (fix && fix.ok && (fix.movedCount > 0 || fix.dedupedCount > 0)) {
                result.absolute = fix.movedCount > 0 && fix.moved && fix.moved[0] ? fix.moved[0].to : target;
                S.progress.fixedNames = (S.progress.fixedNames || 0) + 1;
              }
            } catch (_) {
              /* 修正失敗不影響下載成功的判定 */
            }
          }
          S.history = P.mergeHistory(S.history, task.task_id, task.folder, file, result.absolute);
          S.progress.done = done;
          saveHistorySoon();
        } catch (err) {
          if (S.cancelled) return;
          if (!(err && err.counted)) {
            failed += 1;
            S.progress.failed = failed;
            S.failedList.push({
              name: `${task.folder}／${file.filename}`,
              error: friendlyError((err && err.message) || err),
            });
          }
        } finally {
          activeNames.delete(file.filename);
          S.progress.activeDl = activeNames.size;
          renderProgressSoon();
        }
        sendBadge(progressPercent() + '%');
        await sleep(40);
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => downloadWorker()));
    } finally {
      clearTimeout(S.renderTimer);
      S.renderTimer = 0;
      if (!S.cancelled) await prepPromise;
      S.running = false;
      S.progress.phase = S.cancelled ? 'cancelled' : 'done';
      S.progress.current = '';
      S.progress.activeDl = 0;
      S.progress.activePrep = 0;
      S.progress.elapsedMs = Date.now() - S.jobStartedAt;
      await flushHistory();
      renderProgress();
      updateCounts();
      sendBadge('');
      const skipped = plan.skipped;
      const secs = Math.round(S.progress.elapsedMs / 1000);
      if (S.cancelled) flash(`已停止（已完成的檔案保留，花了 ${secs} 秒）`);
      else if (failed) flash(`完成 ${done} 個，失敗 ${failed} 個（${secs} 秒），詳見失敗清單`);
      else flash(`完成：下載 ${done} 個${skipped ? `，跳過 ${skipped} 個已存在` : ''}（${secs} 秒）`);
      if (bytes > 0) {
        S.els.footHint.textContent = `本次下載約 ${(bytes / 1048576).toFixed(1)} MB、耗時 ${secs} 秒。檔案在「下載」資料夾的「${S.rootFolder}」內。`;
      }
      // 下載完成後自動整理（成品MP3／採樣包／檔案分類／音頻屬性分類），並顯示背景進度條
      if (S.options.autoOrganize && S.host.ok && !S.cancelled) {
        setTimeout(() => {
          runTidy({ silent: true }).catch(() => {});
        }, 1200);
      }
      // 完成後安靜刷新一次歌單（新的分軌／MIDI 狀態可能已經好了），並更新每首歌的下載狀態
      setTimeout(() => {
        refreshSongsQuiet();
        refreshDownloadIndex(true)
          .then(() => {
            if (S.songs.length) renderSongs();
          })
          .catch(() => {});
      }, 600);
    }
  }

  /* ------------------------------------------------------------------ *
   * 啟動
   * ------------------------------------------------------------------ */
  buildUi();
  loadSettings().then(() => {
    syncOptionsToUi();
    startAutoRefresh();
    return loadDownloadState();
  });
  refreshHostStatus()
    .then(() => refreshDownloadIndex(true))
    .then(() => {
      if (S.songs.length) renderSongs();
    });
  // 切回分頁時立刻更新一次歌單（分軌完成後不必手動重整頁面）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.els.panel && !S.els.panel.hidden && S.loaded) {
      refreshSongsQuiet();
      refreshDownloadIndex(false).then(() => {
        if (S.songs.length) renderSongs();
      });
    }
  });
  console.info('[ACE 批量下載] v' + (chrome.runtime.getManifest?.().version || '') + ' 已載入');
})();





