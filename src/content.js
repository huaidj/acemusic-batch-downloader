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
    autoNew: false, // 新歌自動下載（只處理開啟之後完成的歌）
    autoNewScores: false, // 自動下載是否含 MIDI／MusicXML（站點生成，可能扣 credit）
    concurrency: 4,
  });
  const DEFAULT_ROOT = 'ai音樂';
  const PAGE_LIMIT = 50;
  const MAX_PAGES = 40; // 50×40 = 2000 首（舊值 8 會在 400 首默默截斷）
  const AUTO_REFRESH_MS = 8000;
  const KEY_SETTINGS = 'aceSettings';
  const KEY_HISTORY = 'aceHistory';
  const KEY_FOLDERS = 'aceFolders';
const KEY_UNAVAILABLE = 'aceUnavailable';

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
    unavailable: {},
    agentUnavailable: {},
    onlyUndownloaded: false,
    onlyFavorites: false,
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

  /** 站點 API 的 error 可能是物件 { code, message }，字串化前先取 message，避免 [object Object] */
  function siteErrorDetail(data, status) {
    const error = data && (data.error || data.message);
    if (!error) return `HTTP ${status}`;
    if (typeof error === 'string') return error;
    return error.message || error.code || JSON.stringify(error);
  }

  function isAuthError(err) {
    const message = String((err && err.message) || err || '');
    return /登入已過期|Please log in|HTTP 401/i.test(message);
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
    sendMessage({ type: 'ACE_BADGE', text: text || '', color: '#a8792c' }).catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * 樣式（用 constructed stylesheet，避開頁面 CSP 對 inline style 的限制）
   * ------------------------------------------------------------------ */
  // 視覺：暖石墨底＋單一低彩度琥珀強調色；不用藍紫漸層與發光（避免「AI 產品味」）。
  // 透明度由 --alpha 控制（面板標題列的滑桿，存在 aceUi）。
  const CSS = `
:host {
  all: initial;
  --alpha: .92;
  --bg-rgb: 24, 23, 21;
  --text: #ece8e1; --muted: #a8a299; --faint: #7a756d;
  --line: rgba(255, 248, 235, .08); --line-strong: rgba(255, 248, 235, .14);
  --surface: rgba(255, 248, 235, .04); --surface-hover: rgba(255, 248, 235, .08);
  --field: rgba(0, 0, 0, .28);
  --accent: #d2a24c; --accent-hover: #ddb062; --accent-ink: #1c1913; --accent-soft: rgba(210, 162, 76, .14);
  --ok: #9fc49b; --ok-soft: rgba(159, 196, 155, .12);
  --warn: #e0b45c; --warn-soft: rgba(224, 180, 92, .12);
  --err: #e3907f;
  --font: system-ui, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif;
}
* { box-sizing: border-box; }

/* 浮動按鈕：實色膠囊、可拖曳 */
.fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 15px 9px 13px; border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: rgba(var(--bg-rgb), .94); color: var(--text); cursor: pointer;
  font: 600 13px/1.2 var(--font); letter-spacing: .2px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .35);
  backdrop-filter: blur(10px);
  user-select: none; touch-action: none;
}
.fab:hover { border-color: rgba(210, 162, 76, .5); }
.fab.dragging { cursor: grabbing; box-shadow: 0 10px 26px rgba(0, 0, 0, .45); }
.fab .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.fab.running .dot { background: var(--ok); animation: acedl-pulse 1.2s ease-in-out infinite; }
@keyframes acedl-pulse { 50% { opacity: .3; } }

/* 面板：半透明＋背景模糊 */
.panel {
  position: fixed; right: 18px; bottom: 70px; z-index: 2147483647;
  width: 470px; max-width: 94vw; max-height: min(80vh, 860px);
  display: flex; flex-direction: column;
  background: rgba(var(--bg-rgb), var(--alpha));
  backdrop-filter: blur(16px) saturate(115%);
  color: var(--text); border: 1px solid var(--line-strong); border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, .45);
  font: 13px/1.45 var(--font);
  overflow: hidden;
}
.panel[hidden] { display: none; }
.panel header {
  display: flex; align-items: center; gap: 8px; padding: 11px 12px 10px 14px;
  border-bottom: 1px solid var(--line); cursor: grab; user-select: none; touch-action: none;
}
.panel.dragging header { cursor: grabbing; }
.panel header .title { font-weight: 700; font-size: 14px; letter-spacing: .2px; }
.panel header .sub { color: var(--faint); font-size: 11px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.alpha { display: inline-flex; align-items: center; gap: 5px; color: var(--faint); font-size: 10.5px; cursor: default; }
.alpha input { width: 64px; accent-color: var(--accent); cursor: pointer; }
.iconbtn {
  width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface);
  color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1;
}
.iconbtn:hover { background: var(--surface-hover); color: var(--text); }

.opts { display: flex; flex-wrap: wrap; gap: 6px 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); align-items: center; }
.chk { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); cursor: pointer; font-size: 12px; }
.chk:hover { color: var(--text); }
.chk input { accent-color: var(--accent); }
.chk select.mini {
  padding: 2px 4px; border-radius: 6px; border: 1px solid var(--line); background: var(--field);
  color: var(--text); font-size: 11.5px; outline: none;
}
.sep { width: 1px; height: 16px; background: var(--line-strong); margin: 0 2px; }
.root { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-left: auto; }
.root input {
  width: 128px; padding: 4px 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--field);
  color: var(--text); font-size: 12px; outline: none;
}
.root input:focus { border-color: var(--accent); }

.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
.toolbar button, .footer button, .rowbtn {
  border: 1px solid var(--line); background: var(--surface); color: var(--text); border-radius: 8px;
  padding: 5px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.toolbar button:hover, .footer button:hover, .rowbtn:hover { background: var(--surface-hover); border-color: var(--line-strong); }
.toolbar button.on { border-color: rgba(210, 162, 76, .55); color: var(--accent); background: var(--accent-soft); }
.organize {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start;
  padding: 8px 14px; border-bottom: 1px solid var(--line); background: rgba(0, 0, 0, .12);
  font-size: 11.5px; color: var(--text);
}
.organize[hidden] { display: none; }
.organize .grow { flex: 1; min-width: 180px; }
.organize .hint { padding: 0; text-align: left; font-size: 10.5px; color: var(--faint); }
.toolbar .count { color: var(--muted); font-size: 12px; margin-left: auto; }

.songs { flex: 1; overflow-y: auto; min-height: 120px; padding: 6px 8px; }
.songs::-webkit-scrollbar { width: 8px; }
.songs::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 8px; }
.song { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 9px; }
.song:hover { background: var(--surface); }
.song input[type=checkbox] { accent-color: var(--accent); flex: none; }
.song .cover { width: 30px; height: 30px; border-radius: 6px; object-fit: cover; background: var(--surface-hover); flex: none; }
.song .body { flex: 1; min-width: 0; }
.song .name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song .meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.badge { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.badge.ok { color: var(--ok); border-color: rgba(159, 196, 155, .3); background: var(--ok-soft); }
.badge.warn { color: var(--warn); border-color: rgba(224, 180, 92, .3); background: var(--warn-soft); }
.badge.dim { opacity: .7; }
.rowbtn { flex: none; padding: 4px 9px; font-size: 11.5px; }
.hint { color: var(--faint); font-size: 12px; padding: 16px 12px; text-align: center; }
.hint.err { color: var(--err); }
.hint a { color: var(--accent); }

.progress { border-top: 1px solid var(--line); padding: 10px 14px 8px; }
.progress[hidden] { display: none; }
.bar { height: 4px; border-radius: 999px; background: var(--surface-hover); overflow: hidden; }
.bar i { display: block; height: 100%; width: 0%; background: var(--accent); transition: width .2s ease; }
.stats { display: flex; gap: 10px; margin-top: 7px; color: var(--muted); font-size: 11.5px; flex-wrap: wrap; }
.stats b { color: var(--text); font-weight: 600; }
.current { margin-top: 5px; color: var(--faint); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.failed { margin-top: 6px; font-size: 11px; color: var(--muted); }
.failed summary { cursor: pointer; color: var(--err); }
.failed ul { margin: 4px 0 0; padding-left: 18px; max-height: 110px; overflow: auto; }
.failed li { color: var(--err); word-break: break-all; }
.showfolder { margin-top: 8px; }

.footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--line); background: rgba(0, 0, 0, .14); }
.primary {
  flex: 1 1 150px; white-space: nowrap; padding: 9px 12px; border-radius: 9px; cursor: pointer;
  border: 1px solid transparent; background: var(--accent); color: var(--accent-ink); font-weight: 700; font-size: 13px;
}
.primary:disabled { background: var(--surface-hover); color: var(--faint); border-color: var(--line); cursor: not-allowed; }
.primary:not(:disabled):hover { background: var(--accent-hover); }
.ghost { padding: 9px 12px; border-radius: 9px; white-space: nowrap; cursor: pointer; border: 1px solid var(--line-strong); background: var(--surface); color: var(--text); font-size: 12.5px; }
.ghost:hover { background: var(--surface-hover); }
.ghost[hidden] { display: none; }
.foothint { color: var(--faint); font-size: 10.5px; flex-basis: 100%; margin-top: 2px; }
.tidybar { flex-basis: 100%; margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.tidybar[hidden] { display: none; }
.tidybar .track { height: 4px; border-radius: 999px; background: var(--surface-hover); overflow: hidden; }
.tidybar .track i { display: block; height: 100%; width: 0%; background: var(--ok); transition: width .4s ease; }
.tidybar .label { color: var(--muted); font-size: 10.5px; }
.toast:empty { display: none; }
.toast { color: var(--accent); font-size: 11px; margin-left: 6px; }
/* 電臺播放器 */
.player { display: grid; grid-template-columns: 38px 1fr; grid-template-areas: "cover info" "ctrl ctrl" "extra extra"; gap: 6px 10px; padding: 9px 14px 10px; border-bottom: 1px solid var(--line); background: rgba(0, 0, 0, .1); }
.pcover { grid-area: cover; width: 38px; height: 38px; border-radius: 7px; object-fit: cover; background: var(--surface-hover); }
.pinfo { grid-area: info; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 3px; }
.ptitle { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pline { display: flex; align-items: center; gap: 8px; }
.pseek { flex: 1; min-width: 0; accent-color: var(--accent); height: 14px; cursor: pointer; }
.ptime { font-size: 10.5px; color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pctrl { grid-area: ctrl; display: flex; align-items: center; justify-content: center; gap: 6px; }
.pextra { grid-area: extra; display: flex; align-items: center; gap: 8px; }
.pextra select { padding: 2px 4px; border-radius: 6px; border: 1px solid var(--line); background: var(--field); color: var(--text); font-size: 11.5px; outline: none; }
.pvol { width: 90px; accent-color: var(--accent); cursor: pointer; }
.pvolicon { display: inline-flex; color: var(--faint); margin-left: auto; }
.pbtn { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; padding: 0; }
.pbtn:hover { background: var(--surface-hover); color: var(--text); }
.pbtn.on { color: var(--accent); }
.pbtn:disabled { opacity: .35; cursor: default; }
.pbtn.main { width: 38px; height: 38px; background: var(--accent); color: var(--accent-ink); }
.pbtn.main:hover { background: var(--accent-hover); color: var(--accent-ink); }
.pbtn[data-mode="one"]::after { content: "1"; position: absolute; font-size: 8px; font-weight: 700; margin: 12px 0 0 12px; }
.pbtn { position: relative; }
.pbtn[data-radio="fav"].on { color: var(--err); }
.ico { width: 17px; height: 17px; }
.pbtn.main .ico { width: 19px; height: 19px; }
.song.nowplaying { background: var(--accent-soft); }
.rowicon { flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; border: 1px solid transparent; background: transparent; color: var(--faint); cursor: pointer; padding: 0; }
.rowicon:hover { background: var(--surface-hover); color: var(--text); }
.rowicon.on { color: var(--err); }
.rowicon .ico { width: 15px; height: 15px; }
.song .cover { cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .fab.running .dot { animation: none; } .bar i, .tidybar .track i { transition: none; } }
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
    const alphaInput = el('input', { type: 'range', min: '40', max: '100', step: '5', 'data-ui': 'alpha', 'aria-label': '面板不透明度' });
    const alphaBox = el('label', { class: 'alpha', title: '面板不透明度（拖曳標題列可移動面板，雙擊標題列回到預設位置）' }, ['透明', alphaInput]);
    const header = el('header', { title: '拖曳移動；雙擊回到預設位置' }, [titleBox, subBox, alphaBox, refreshBtn, closeBtn]);

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
    const autoNewCb = el('input', { type: 'checkbox', 'data-opt': 'autoNew', checked: S.options.autoNew });
    autoNewCb.addEventListener('change', () => {
      S.options.autoNew = autoNewCb.checked;
      saveSettings();
      if (S.options.autoNew) enableAutoNew();
    });
    optRows.append(el('label', { class: 'chk', title: '開啟之後新完成的歌，自動下載上方勾選的類型（分軌會等分離完成）；需開著這個分頁' }, [autoNewCb, '新歌自動下載']));
    const autoScoresCb = el('input', { type: 'checkbox', 'data-opt': 'autoNewScores', checked: S.options.autoNewScores });
    autoScoresCb.addEventListener('change', () => {
      S.options.autoNewScores = autoScoresCb.checked;
      saveSettings();
    });
    optRows.append(el('label', { class: 'chk', title: 'MIDI／MusicXML 由站點即時生成，可能扣 credit；預設自動下載不含' }, [autoScoresCb, '自動含 MIDI／MusicXML']));
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
    const favFilterBtn = el('button', { type: 'button', 'data-act': 'filter-favorites', text: '只看收藏' });
    favFilterBtn.addEventListener('click', () => {
      S.onlyFavorites = !S.onlyFavorites;
      favFilterBtn.classList.toggle('on', S.onlyFavorites);
      renderSongs();
    });
    const toolbar = el('div', { class: 'toolbar' }, [selectAll, selectNone, filterBtn, favFilterBtn, organizeBtn, exportAgentBtn, countLabel]);
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

    const playerBar = buildPlayer();
    panel.append(header, playerBar, optRows, toolbar, toolbar2, organizeBox, songsBox, progress, footer);
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

    // 拖曳後的 click 不算開關（拖動浮動按鈕不應順便打開面板）
    fab.addEventListener('click', () => {
      if (UI.suppressClick) {
        UI.suppressClick = false;
        return;
      }
      togglePanel(true);
    });
    setupDragAndAlpha({ fab, panel, header, alphaInput });
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

  /* ------------------------------------------------------------------ *
   * 電臺播放器：播放／暫停、上下首、隨機、循環、收藏、只聽收藏、音量、進度、系統媒體鍵
   * 播的是站點歌曲音檔（local_audio，同源、帶登入），不另外下載；狀態存在 aceRadio／aceFavorites，
   * 收藏另外經頁面通道交給本機（page-favorites.json），給 agent／之後的 Studio 用。
   * ------------------------------------------------------------------ */
  const KEY_RADIO = 'aceRadio';
  const KEY_FAVORITES = 'aceFavorites';
  const R = {
    audio: null,
    currentId: '',
    playing: false,
    shuffle: false,
    repeat: 'all', // off | all | one
    source: 'all', // all | fav
    volume: 0.8,
    favorites: {}, // task_id → { at, title }
    order: [], // 目前播放序（隨機時是洗牌後的 id）
    history: [],
    errors: 0,
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    play: 'M8 5.5v13l11-6.5z',
    pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
    prev: 'M6 5h2v14H6zM9.5 12 19 5v14z',
    next: 'M16 5h2v14h-2zM5 5l9.5 7L5 19z',
    shuffle: 'M4 7h3.2c1.6 0 3 .8 3.9 2.1l2.8 4.3c.9 1.3 2.3 2.1 3.9 2.1H20m0 0-2.5-2.5M20 15.5 17.5 18M4 17h3.2c1 0 1.9-.3 2.6-.9M20 8.5h-2.2c-1 0-1.9.3-2.6.9M20 8.5 17.5 6M20 8.5 17.5 11',
    repeat: 'M5 10V9a3 3 0 0 1 3-3h10m0 0-2.5-2.5M18 6l-2.5 2.5M19 14v1a3 3 0 0 1-3 3H6m0 0 2.5 2.5M6 18l2.5-2.5',
    heart: 'M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z',
    volume: 'M5 9.5h3l4-3.5v12l-4-3.5H5zM15.5 9a4 4 0 0 1 0 6M17.5 7a7 7 0 0 1 0 10',
  };
  const STROKE_ICONS = new Set(['shuffle', 'repeat', 'heart', 'volume']);
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ico');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    if (STROKE_ICONS.has(name)) {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.7');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    } else {
      path.setAttribute('fill', 'currentColor');
    }
    svg.append(path);
    return svg;
  }
  function setIcon(btn, name) {
    btn.textContent = '';
    btn.append(icon(name));
  }
  // 注意：本檔有一個 const CSS（面板樣式字串）遮蔽了瀏覽器的全域 CSS，這裡必須走 window.CSS
  const cssEsc = (value) => (window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
  const isFav = (id) => !!R.favorites[id];
  const songById = (id) => S.songs.find((song) => song.task_id === id) || null;
  const songTitle = (song) => (song && song.meta && song.meta.title) || 'Untitled';
  const fmtTime = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  async function loadRadio() {
    const got = await storageGet([KEY_RADIO, KEY_FAVORITES]);
    const prefs = (got && got[KEY_RADIO]) || {};
    if (typeof prefs.shuffle === 'boolean') R.shuffle = prefs.shuffle;
    if (['off', 'all', 'one'].includes(prefs.repeat)) R.repeat = prefs.repeat;
    if (['all', 'fav'].includes(prefs.source)) R.source = prefs.source;
    if (Number.isFinite(prefs.volume)) R.volume = clamp(prefs.volume, 0, 1);
    if (typeof prefs.lastId === 'string') R.currentId = prefs.lastId;
    const fav = got && got[KEY_FAVORITES];
    R.favorites = fav && typeof fav === 'object' ? fav : {};
    renderPlayer();
  }
  function saveRadio() {
    return storageSet({ [KEY_RADIO]: { shuffle: R.shuffle, repeat: R.repeat, source: R.source, volume: R.volume, lastId: R.currentId } });
  }
  function saveFavorites() {
    storageSet({ [KEY_FAVORITES]: R.favorites });
    if (TEST_MODE || !S.host || !S.host.ok) return;
    const favorites = Object.entries(R.favorites)
      .map(([task_id, info]) => ({ task_id, title: (info && info.title) || '', at: (info && info.at) || 0 }))
      .sort((a, b) => b.at - a.at);
    sendMessage({ type: 'ACE_HOST_EXPORT_PAGE', name: 'page-favorites', data: { savedAt: Date.now(), favorites } }).catch(() => {});
  }
  function toggleFavorite(id) {
    if (!id) return;
    if (isFav(id)) delete R.favorites[id];
    else R.favorites[id] = { at: Date.now(), title: songTitle(songById(id)) };
    saveFavorites();
    R.order = [];
    renderPlayer();
    for (const btn of S.els.songsBox ? S.els.songsBox.querySelectorAll(`[data-song-id="${cssEsc(id)}"] [data-fav]`) : []) paintFav(btn, id);
    if (S.onlyFavorites) renderSongs();
  }
  function paintFav(btn, id) {
    const on = isFav(id);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? '取消收藏' : '收藏';
  }

  /** 播放佇列：來源（全部／收藏）裡可播放的歌；順序依歌單（新 → 舊） */
  function playableQueue() {
    return S.songs.filter((song) => song.local_audio && (R.source === 'all' || isFav(song.task_id))).map((song) => song.task_id);
  }
  function rebuildOrder() {
    const queue = playableQueue();
    if (!R.shuffle) {
      R.order = queue;
      return;
    }
    const rest = queue.filter((id) => id !== R.currentId);
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    R.order = R.currentId && queue.includes(R.currentId) ? [R.currentId, ...rest] : rest;
  }
  function neighbor(step) {
    if (!R.order.length || R.order.some((id) => !songById(id))) rebuildOrder();
    if (!R.order.length) return '';
    const i = R.order.indexOf(R.currentId);
    let j = i + step;
    if (i < 0) j = step > 0 ? 0 : R.order.length - 1;
    if (j >= R.order.length || j < 0) {
      if (R.repeat === 'off' && i >= 0) return '';
      if (R.shuffle && step > 0) {
        R.currentId = '';
        rebuildOrder();
        return R.order[0] || '';
      }
      j = (j + R.order.length) % R.order.length;
    }
    return R.order[j] || '';
  }

  function ensureAudio() {
    if (R.audio) return R.audio;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = R.volume;
    audio.addEventListener('play', () => {
      R.playing = true;
      renderPlayer();
    });
    audio.addEventListener('pause', () => {
      R.playing = false;
      renderPlayer();
    });
    audio.addEventListener('timeupdate', paintProgress);
    audio.addEventListener('loadedmetadata', paintProgress);
    audio.addEventListener('playing', () => {
      R.errors = 0;
    });
    audio.addEventListener('ended', () => {
      if (R.repeat === 'one') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      const next = neighbor(1);
      if (next) playSong(next);
      else {
        R.playing = false;
        renderPlayer();
      }
    });
    audio.addEventListener('error', () => {
      // 單首播放失敗（音檔失效／未登入）：跳下一首；整個佇列都失敗就停，避免無限跳
      R.errors += 1;
      const total = Math.max(1, playableQueue().length);
      if (R.errors >= Math.min(total, 5)) {
        R.playing = false;
        renderPlayer();
        flash('無法播放（音檔無法載入，可能需要重新登入）');
        return;
      }
      const next = neighbor(1);
      if (next && next !== R.currentId) playSong(next);
    });
    R.audio = audio;
    return audio;
  }

  function playSong(id) {
    const song = songById(id);
    if (!song || !song.local_audio) return;
    const audio = ensureAudio();
    if (R.currentId && R.currentId !== id) R.history.push(R.currentId);
    if (R.history.length > 50) R.history.shift();
    R.currentId = id;
    if (!R.order.includes(id)) rebuildOrder();
    audio.src = new URL(song.local_audio, location.origin).href;
    audio.play().catch(() => {
      /* 自動播放被擋或格式錯誤：error 事件會處理 */
    });
    saveRadio();
    updateMediaSession(song);
    renderPlayer();
    highlightPlayingRow();
  }
  function togglePlay() {
    const audio = ensureAudio();
    if (!audio.src) {
      const first = (R.currentId && songById(R.currentId) && R.currentId) || neighbor(1);
      if (first) playSong(first);
      else flash(R.source === 'fav' ? '還沒有收藏的歌' : '沒有可播放的歌曲');
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
  function playNext() {
    const next = neighbor(1) || (R.repeat === 'off' ? '' : R.order[0]);
    if (next) playSong(next);
  }
  function playPrev() {
    const audio = R.audio;
    // 播超過 3 秒按上一首 = 回到開頭（一般播放器慣例）
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const prev = R.shuffle ? R.history.pop() : neighbor(-1);
    if (prev) playSong(prev);
  }
  function updateMediaSession(song) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.metadata = new MediaMetadata({
        title: songTitle(song),
        artist: 'ACE Music',
        album: R.source === 'fav' ? '收藏' : '我的歌曲',
        artwork: song.local_cover ? [{ src: new URL(song.local_cover, location.origin).href, sizes: '512x512' }] : [],
      });
      ms.setActionHandler('play', () => togglePlay());
      ms.setActionHandler('pause', () => R.audio && R.audio.pause());
      ms.setActionHandler('nexttrack', () => playNext());
      ms.setActionHandler('previoustrack', () => playPrev());
      ms.setActionHandler('seekto', (d) => {
        if (R.audio && Number.isFinite(d.seekTime)) R.audio.currentTime = d.seekTime;
      });
    } catch (_) {
      /* 舊瀏覽器 */
    }
  }

  function buildPlayer() {
    const btn = (act, name, title) => {
      const b = el('button', { class: 'pbtn', type: 'button', 'data-radio': act, title, 'aria-label': title });
      b.append(icon(name));
      return b;
    };
    const cover = el('img', { class: 'pcover', alt: '' });
    const title = el('div', { class: 'ptitle', 'data-radio-title': '', text: '電臺：選一首歌開始，或按播放' });
    const time = el('div', { class: 'ptime', 'data-radio-time': '', text: '0:00 / 0:00' });
    const seek = el('input', { class: 'pseek', type: 'range', min: '0', max: '1000', value: '0', step: '1', 'data-radio-seek': '', 'aria-label': '播放進度' });
    const prev = btn('prev', 'prev', '上一首');
    const play = btn('play', 'play', '播放');
    play.classList.add('main');
    const next = btn('next', 'next', '下一首');
    const shuffle = btn('shuffle', 'shuffle', '隨機');
    const repeat = btn('repeat', 'repeat', '循環');
    const fav = btn('fav', 'heart', '收藏目前歌曲');
    const source = el('select', { class: 'psource', 'data-radio-source': '', title: '播放來源' }, [
      el('option', { value: 'all', text: '全部歌曲' }),
      el('option', { value: 'fav', text: '只聽收藏' }),
    ]);
    const vol = el('input', { class: 'pvol', type: 'range', min: '0', max: '100', step: '1', 'data-radio-volume': '', 'aria-label': '音量' });
    const volIcon = el('span', { class: 'pvolicon' });
    volIcon.append(icon('volume'));

    play.addEventListener('click', () => togglePlay());
    prev.addEventListener('click', () => playPrev());
    next.addEventListener('click', () => playNext());
    shuffle.addEventListener('click', () => {
      R.shuffle = !R.shuffle;
      rebuildOrder();
      saveRadio();
      renderPlayer();
    });
    repeat.addEventListener('click', () => {
      R.repeat = R.repeat === 'all' ? 'one' : R.repeat === 'one' ? 'off' : 'all';
      saveRadio();
      renderPlayer();
    });
    fav.addEventListener('click', () => toggleFavorite(R.currentId));
    source.addEventListener('change', () => {
      R.source = source.value;
      R.order = [];
      saveRadio();
      renderPlayer();
    });
    vol.addEventListener('input', () => {
      R.volume = clamp(Number(vol.value) / 100, 0, 1);
      if (R.audio) R.audio.volume = R.volume;
    });
    vol.addEventListener('change', () => saveRadio());
    let seeking = false;
    seek.addEventListener('input', () => {
      seeking = true;
      const a = R.audio;
      if (a && Number.isFinite(a.duration)) time.textContent = `${fmtTime((Number(seek.value) / 1000) * a.duration)} / ${fmtTime(a.duration)}`;
    });
    seek.addEventListener('change', () => {
      const a = R.audio;
      if (a && Number.isFinite(a.duration)) a.currentTime = (Number(seek.value) / 1000) * a.duration;
      seeking = false;
    });
    R.isSeeking = () => seeking;

    const info = el('div', { class: 'pinfo' }, [title, el('div', { class: 'pline' }, [seek, time])]);
    const controls = el('div', { class: 'pctrl' }, [shuffle, prev, play, next, repeat, fav]);
    const extras = el('div', { class: 'pextra' }, [source, volIcon, vol]);
    const bar = el('div', { class: 'player', 'data-radio-player': '' }, [cover, info, controls, extras]);
    Object.assign(S.els, { player: bar, pCover: cover, pTitle: title, pTime: time, pSeek: seek, pPlay: play, pShuffle: shuffle, pRepeat: repeat, pFav: fav, pSource: source, pVol: vol });
    return bar;
  }

  function paintProgress() {
    const a = R.audio;
    if (!a || !S.els.pTime) return;
    const dur = Number.isFinite(a.duration) ? a.duration : 0;
    if (!(R.isSeeking && R.isSeeking())) {
      S.els.pTime.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(dur)}`;
      S.els.pSeek.value = dur ? String(Math.round((a.currentTime / dur) * 1000)) : '0';
    }
  }
  function renderPlayer() {
    if (!S.els.player) return;
    const song = songById(R.currentId);
    setIcon(S.els.pPlay, R.playing ? 'pause' : 'play');
    S.els.pPlay.title = R.playing ? '暫停' : '播放';
    S.els.pPlay.setAttribute('aria-label', S.els.pPlay.title);
    S.els.pShuffle.classList.toggle('on', R.shuffle);
    S.els.pShuffle.setAttribute('aria-pressed', String(R.shuffle));
    S.els.pRepeat.classList.toggle('on', R.repeat !== 'off');
    S.els.pRepeat.dataset.mode = R.repeat;
    S.els.pRepeat.title = R.repeat === 'one' ? '單曲循環' : R.repeat === 'all' ? '清單循環' : '不循環';
    S.els.pFav.disabled = !song;
    paintFav(S.els.pFav, R.currentId);
    S.els.pSource.value = R.source;
    S.els.pVol.value = String(Math.round(R.volume * 100));
    S.els.pTitle.textContent = song ? songTitle(song) : '電臺：選一首歌開始，或按播放';
    S.els.pTitle.title = S.els.pTitle.textContent;
    if (song && song.local_cover) {
      S.els.pCover.src = song.local_cover;
      S.els.pCover.style.visibility = '';
    } else {
      S.els.pCover.removeAttribute('src');
      S.els.pCover.style.visibility = 'hidden';
    }
    S.els.player.classList.toggle('playing', R.playing);
    paintProgress();
    updateFab();
  }
  function highlightPlayingRow() {
    const box = S.els.songsBox;
    if (!box) return;
    for (const row of box.querySelectorAll('.song.nowplaying')) row.classList.remove('nowplaying');
    if (R.currentId) {
      const row = box.querySelector(`[data-song-id="${cssEsc(R.currentId)}"]`);
      if (row) row.classList.add('nowplaying');
    }
  }

  /* ------------------------------------------------------------------ *
   * 介面偏好：面板不透明度、面板／浮動按鈕位置（chrome.storage aceUi）
   * 拖曳：面板拖標題列、浮動按鈕直接拖；移動 >4px 才算拖曳（點一下照常開關）；
   *       位置夾在視窗內，視窗縮放時重新夾；雙擊標題列回到預設位置。
   * ------------------------------------------------------------------ */
  const KEY_UI = 'aceUi';
  const UI = { alpha: 92, panelPos: null, fabPos: null, suppressClick: false };
  const EDGE = 8;

  function clampPos(el, left, top) {
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const maxLeft = Math.max(EDGE, window.innerWidth - w - EDGE);
    const maxTop = Math.max(EDGE, window.innerHeight - h - EDGE);
    return { left: Math.round(clamp(left, EDGE, maxLeft)), top: Math.round(clamp(top, EDGE, maxTop)) };
  }
  function placeAt(el, pos) {
    if (!pos) {
      el.style.left = el.style.top = el.style.right = el.style.bottom = '';
      return;
    }
    const p = clampPos(el, pos.left, pos.top);
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function applyAlpha(value) {
    const pct = clamp(Math.round(Number(value) || 92), 40, 100);
    UI.alpha = pct;
    if (S.els.host) S.els.host.style.setProperty('--alpha', String(pct / 100));
    const input = S.els.alphaInput;
    if (input && Number(input.value) !== pct) input.value = String(pct);
  }
  function saveUi() {
    return storageSet({ [KEY_UI]: { alpha: UI.alpha, panelPos: UI.panelPos, fabPos: UI.fabPos } });
  }
  async function loadUi() {
    const got = await storageGet([KEY_UI]);
    const data = (got && got[KEY_UI]) || {};
    const okPos = (p) => (p && Number.isFinite(p.left) && Number.isFinite(p.top) ? { left: p.left, top: p.top } : null);
    UI.panelPos = okPos(data.panelPos);
    UI.fabPos = okPos(data.fabPos);
    applyAlpha(data.alpha != null ? data.alpha : UI.alpha);
    placeAt(S.els.fab, UI.fabPos);
    if (!S.els.panel.hidden) placePanel();
  }
  /** 面板位置：使用者拖過就用記住的；否則若浮動按鈕被移過，貼在按鈕旁邊；都沒有用 CSS 預設 */
  function placePanel() {
    const panel = S.els.panel;
    if (UI.panelPos) return placeAt(panel, UI.panelPos);
    if (!UI.fabPos) return placeAt(panel, null);
    const fab = S.els.fab.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const above = fab.top - h - 10;
    const top = above >= EDGE ? above : fab.bottom + 10;
    placeAt(panel, { left: fab.right - w, top });
  }

  function makeDraggable(handle, target, { onStart, onEnd, ignore } = {}) {
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (ignore && ignore(event)) return;
      const rect = target.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        target.classList.add('dragging');
        if (onStart) onStart();
      }
      placeAt(target, { left: drag.left + dx, top: drag.top + dy });
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      target.classList.remove('dragging');
      if (moved && onEnd) {
        const rect = target.getBoundingClientRect();
        onEnd({ left: Math.round(rect.left), top: Math.round(rect.top) });
      }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function setupDragAndAlpha({ fab, panel, header, alphaInput }) {
    S.els.alphaInput = alphaInput;
    alphaInput.value = String(UI.alpha);
    alphaInput.addEventListener('input', () => applyAlpha(alphaInput.value));
    alphaInput.addEventListener('change', () => saveUi());

    makeDraggable(header, panel, {
      // 標題列上的按鈕、滑桿照常操作，不觸發拖曳
      ignore: (event) => !!event.target.closest('button, input, select, label'),
      onEnd: (pos) => {
        UI.panelPos = pos;
        saveUi();
      },
    });
    makeDraggable(fab, fab, {
      onStart: () => {
        UI.suppressClick = true;
      },
      onEnd: (pos) => {
        UI.fabPos = pos;
        saveUi();
        // 面板沒被單獨拖過 → 跟著按鈕走
        if (!panel.hidden && !UI.panelPos) placePanel();
      },
    });
    header.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, input, select, label')) return;
      UI.panelPos = null;
      UI.fabPos = null;
      placeAt(fab, null);
      placeAt(panel, null);
      saveUi();
    });
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (UI.fabPos) placeAt(fab, UI.fabPos);
        if (!panel.hidden) placePanel();
      }, 100);
    });
    loadUi().catch(() => {});
  }

  function togglePanel(open) {
    const panel = S.els.panel;
    const shouldOpen = typeof open === 'boolean' ? open : panel.hidden;
    panel.hidden = !shouldOpen;
    if (shouldOpen) placePanel();
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
      S.agentUnavailable = TEST_MODE ? {} : data.unavailable || {};
      S.unavailable = P.mergeUnavailable(S.unavailable, S.agentUnavailable);
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

  /** 檔名索引（S.fsNames 換新集合才重建；每首歌查詢 O(1)，不再逐檔跑 regex） */
  let nameIndexFor = null;
  let nameIndexSize = -1;
  let nameIndex = new Map();
  function fsNameIndex() {
    if (nameIndexFor !== S.fsNames || nameIndexSize !== S.fsNames.size) {
      nameIndex = P.buildNameIndex(S.fsNames);
      nameIndexFor = S.fsNames;
      nameIndexSize = S.fsNames.size;
    }
    return nameIndex;
  }

  /** 每首歌目前的下載進度：{have,total,allDone,any,known,detail,mp3} */
  function songDownloadStatus(song) {
    const rawTitle = (song.meta && song.meta.title) || '';
    const title = N.songFolderLabel(rawTitle);
    // 分軌檔名用「這首歌的資料夾名」開頭（同名多 take 也能精確歸屬）
    const folderLabel = (S.folderByTask && S.folderByTask[song.task_id]) || title;
    // 檔名可能用完整標題（songFolderLabel 會在 '[' 截斷），兩種都比對
    const titleCandidates = [...new Set([title, N.sanitizeComponent(rawTitle, 120)].filter(Boolean))];
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
      for (const { name, suffix, ext } of P.lookupNames(fsNameIndex(), titleCandidates)) {
        if (suffix === 'cover') cover = true;
        else if (suffix === 'midi') midi = true;
        else if (suffix === 'musicxml') musicxml = true;
        else if (!suffix) {
          if (ext === 'mp3') mp3 = true;
          else if (ext === 'wav') wav = true;
          else if (ext === 'mid' || ext === 'midi') midi = true;
          else if (ext === 'musicxml') musicxml = true;
        } else if (labels.has(suffix)) {
          const prefix = name.replace(/\.[^.]+$/, '').split(' - ')[0].trim().toLowerCase();
          if (!folderLabel || prefix === String(folderLabel).toLowerCase()) stemsFound.add(labels.get(suffix));
        }
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
    // 同名歌曲（多個 take）：檔名無法區分 task，MP3/WAV 只信這首歌自己的下載紀錄
    const ambiguous = Array.isArray(S.songs)
      && S.songs.filter((other) => N.songFolderLabel((other.meta && other.meta.title) || '') === title).length > 1;
    if (ambiguous) {
      mp3 = done.has('mp3');
      wav = done.has('wav');
    }
    const stemsTotal = group ? group.tracks.length : 0;
    const stemsHave = stemsTotal ? Math.min(stemsTotal, stemsFound.size) : 0;
    const detail = [];
    if (stemsTotal) detail.push({ label: '分軌', have: stemsHave, total: stemsTotal, done: stemsHave >= stemsTotal });
    const na = (kind) => P.isUnavailable(S.unavailable, song.task_id, kind);
    if (P.midiAvailable(song)) detail.push(P.statusItem('midi', 'MIDI', midi, na('midi')));
    if (P.midiAvailable(song)) detail.push(P.statusItem('musicxml', 'MusicXML', musicxml, na('musicxml')));
    if (song.local_cover) detail.push({ label: '封面', have: cover ? 1 : 0, total: 1, done: cover });
    const have = detail.reduce((sum, item) => sum + item.have, 0);
    const total = detail.reduce((sum, item) => sum + item.total, 0);
    const anyNa = detail.some((item) => item.na);
    return {
      have,
      total,
      allDone: have >= total && (total > 0 || anyNa),
      any: have > 0,
      mp3,
      wav,
      detail,
      known: !!S.fsAt || S.doneKinds.size > 0,
    };
  }

  function downloadStatusLabel(status) {
    const detail = status.detail
      .map((item) => (item.na ? `${item.label} 不可用（站點不提供）` : item.total > 1 ? `${item.label} ${item.have}/${item.total}` : `${item.label}${item.done ? '✓' : '✗'}`))
      .join('、');
    if (!status.known) return { text: '狀態未知', cls: 'dim', title: '本機整理工具未安裝，無法檢查已下載檔案' };
    if (status.allDone) return { text: '已下載', cls: 'ok', title: '已下載：' + detail };
    if (status.any) {
      // 直接說缺什麼（「部分 2/3」看不出缺哪項）
      const lack = status.detail.filter((item) => !item.done && !item.na).map((item) => item.label);
      const brief = lack.length && lack.length <= 3 ? ' · 缺 ' + lack.join('／') : '';
      return { text: `部分 ${status.have}/${status.total}${brief}`, cls: 'warn', title: '已下載：' + detail };
    }
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
    let ver = 0;
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
      // 第一頁的 ver = 歌單版本；之後用 /api/songs/changes?since=ver 只抓增量
      if (page === 0 && data && data.ver != null) ver = Number(data.ver) || 0;
      collected.push(...items);
      after = (data && data.next) || '';
      if (!after || !items.length) break;
    }
    return { songs: collected.filter((song) => song && song.task_id && P.isDone(song)), error: '', ver };
  }

  /* ------------------------------------------------------------------ *
   * 即時同步：訂閱站點 /api/songs/events（SSE），版本變了才抓增量
   * 取代每 8 秒全量抓歌單；SSE 斷線時自動退回輪詢
   * ------------------------------------------------------------------ */
  const LIVE = { es: null, refused: 0, pulling: null, again: false, lastSafety: 0, progress: {} };
  function liveOpen() {
    return !!(LIVE.es && typeof EventSource === 'function' && LIVE.es.readyState === EventSource.OPEN);
  }
  function startLive() {
    // 只在歌單成功載入（＝已登入、拿到 ver）之後訂閱；未登入時訂閱只會一直 401 重連
    if (LIVE.es || typeof EventSource !== 'function' || !S.libVer) return;
    let es;
    try {
      es = LIVE.es = new EventSource('/api/songs/events');
    } catch (_) {
      LIVE.es = null;
      return;
    }
    es.onmessage = (event) => {
      LIVE.refused = 0;
      let msg = {};
      try {
        msg = JSON.parse(event.data) || {};
      } catch (_) {
        /* ignore */
      }
      if (msg.live && typeof msg.live === 'object') {
        // 生成中歌曲的進度（目前只記著；完成後會有 ver 變動）
        Object.assign(LIVE.progress, msg.live);
        return;
      }
      const ver = Number(msg.ver) || 0;
      if (ver > (S.libVer || 0)) pullChanges();
    };
    es.onerror = () => {
      if (LIVE.es !== es) return;
      // 瀏覽器會自己重連；被拒（CLOSED）才由我們退避後重開（5s×2^n，上限 60s）
      if (es.readyState === EventSource.CLOSED) {
        LIVE.es = null;
        setTimeout(startLive, Math.min(60000, 5000 * 2 ** LIVE.refused++));
      }
    };
  }
  function pullChanges() {
    if (LIVE.pulling) {
      LIVE.again = true;
      return LIVE.pulling;
    }
    LIVE.pulling = (async () => {
      do {
        LIVE.again = false;
        await pullChangesOnce();
      } while (LIVE.again);
    })().finally(() => {
      LIVE.pulling = null;
    });
    return LIVE.pulling;
  }
  async function pullChangesOnce() {
    if (!S.libVer || !S.loaded) return refreshSongsQuiet();
    const res = await fetch('/api/songs/changes?since=' + encodeURIComponent(S.libVer), {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    if (!data) return;
    if (data.reset) return refreshSongsQuiet();
    const byId = new Map(S.songs.map((song) => [song.task_id, song]));
    for (const id of data.gone || []) byId.delete(id);
    for (const item of data.items || []) {
      // 生成中的歌先不列（完成後會再收到一次變動）
      if (item && item.task_id && P.isDone(item)) byId.set(item.task_id, item);
    }
    S.libVer = Math.max(S.libVer || 0, Number(data.ver) || 0);
    applySongs([...byId.values()].sort((a, b) => songMs(b.created_at) - songMs(a.created_at)));
  }

  /** 站點時間是毫秒數字；也容許 ISO 字串 */
  function songMs(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /* ------------------------------------------------------------------ *
   * 新歌自動下載：只處理「開啟之後」完成的歌；分軌等分離完成；同一首同一組分軌只自動一次
   * ------------------------------------------------------------------ */
  const KEY_AUTO = 'aceAutoNew';
  const AUTO = { since: 0, done: {}, queue: [], timer: 0 };
  async function loadAutoState() {
    const got = await storageGet([KEY_AUTO]);
    const data = (got && got[KEY_AUTO]) || {};
    AUTO.since = Number(data.since) || 0;
    AUTO.done = data.done && typeof data.done === 'object' ? data.done : {};
  }
  function saveAutoState() {
    // 只留最近 500 首的紀錄
    const entries = Object.entries(AUTO.done).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 500);
    AUTO.done = Object.fromEntries(entries);
    return storageSet({ [KEY_AUTO]: { since: AUTO.since, done: AUTO.done } });
  }
  async function enableAutoNew() {
    await loadAutoState();
    if (!AUTO.since) {
      AUTO.since = Date.now();
      await saveAutoState();
      flash('已開啟新歌自動下載：之後完成的新歌會自動下載');
    }
    startLive();
  }
  function stemsKeyOf(song) {
    const group = P.pickStemGroup(song.stems);
    return group ? group.mode + ':' + group.tracks.length : 'none';
  }
  function stemsRunning(song) {
    return Object.values(song.stems || {}).some((job) => job && (job.status === 'running' || job.status === 'pending' || job.status === 'queued'));
  }
  function autoTypes() {
    return FILE_TYPES.filter((type) => S.options[type] && (S.options.autoNewScores || (type !== 'midi' && type !== 'musicxml')));
  }
  function checkAutoNew() {
    if (!S.options.autoNew || !AUTO.since) return;
    const due = [];
    for (const song of S.songs) {
      const created = songMs(song.finished_at) || songMs(song.created_at);
      if (created < AUTO.since || !P.isDone(song) || stemsRunning(song)) continue;
      const key = stemsKeyOf(song);
      const prev = AUTO.done[song.task_id];
      if (prev && prev.stems === key) continue;
      due.push(song);
    }
    if (!due.length) return;
    for (const song of due) {
      if (!AUTO.queue.some((s) => s.task_id === song.task_id)) AUTO.queue.push(song);
      if (!AUTO.done[song.task_id]) emitPageEvent({ type: 'song_new', task_id: song.task_id, title: (song.meta && song.meta.title) || '' });
    }
    runAutoQueue();
  }
  function runAutoQueue() {
    clearTimeout(AUTO.timer);
    if (!AUTO.queue.length) return;
    if (S.running) {
      AUTO.timer = setTimeout(runAutoQueue, 3000);
      return;
    }
    const types = autoTypes();
    const songs = AUTO.queue.splice(0, AUTO.queue.length);
    for (const song of songs) AUTO.done[song.task_id] = { at: Date.now(), stems: stemsKeyOf(song) };
    saveAutoState();
    if (!types.length) return;
    emitPageEvent({ type: 'auto_download', task_ids: songs.map((s) => s.task_id), types });
    startJob(songs, { types, auto: true }).catch(() => {});
  }

  /* 頁面事件 → 本機（page-events.json，Hub 監看後經 SSE 推給 agent） */
  const PAGE_EVENTS = [];
  let pageEventsTimer = 0;
  function emitPageEvent(evt) {
    PAGE_EVENTS.push({ ...evt, at: Date.now() });
    if (PAGE_EVENTS.length > 100) PAGE_EVENTS.splice(0, PAGE_EVENTS.length - 100);
    if (TEST_MODE || !S.host || !S.host.ok) return;
    clearTimeout(pageEventsTimer);
    pageEventsTimer = setTimeout(() => {
      sendMessage({ type: 'ACE_HOST_EXPORT_PAGE', name: 'page-events', data: { savedAt: Date.now(), events: PAGE_EVENTS.slice() } }).catch(() => {});
    }, 150);
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

  /**
   * 頁面 → agent 快速通道：歌單變了就把精簡快照交給本機（page-songs.json），
   * agent 不必再打站點 API（也不受 session 過期影響）。背景執行、不阻塞 UI。
   */
  const PAGE_SONG_FIELDS = ['task_id', 'model', 'capability', 'status', 'created_at', 'finished_at', 'local_audio', 'local_cover', 'stems'];
  function pageSongSnapshot(songs) {
    return songs.map((song) => {
      const out = {};
      for (const key of PAGE_SONG_FIELDS) if (song[key] != null) out[key] = song[key];
      out.meta = { title: (song.meta && song.meta.title) || '' };
      const result = song.result || {};
      if (result.duration_sec != null || result.duration != null) out.result = { duration_sec: result.duration_sec != null ? result.duration_sec : result.duration };
      return out;
    });
  }
  let pageExportSig = '';
  let pageExportAt = 0;
  const PAGE_EXPORT_HEARTBEAT_MS = 5 * 60 * 1000; // 沒變化也定期刷新 savedAt，讓 agent 知道快照仍新鮮
  function exportPageSongs(songs, sig) {
    if (TEST_MODE || !S.host || !S.host.ok || !songs.length) return;
    if (sig === pageExportSig && Date.now() - pageExportAt < PAGE_EXPORT_HEARTBEAT_MS) return;
    pageExportSig = sig;
    pageExportAt = Date.now();
    sendMessage({
      type: 'ACE_HOST_EXPORT_PAGE',
      name: 'page-songs',
      data: { savedAt: Date.now(), origin: location.origin, count: songs.length, songs: pageSongSnapshot(songs) },
    })
      .then((res) => {
        if (!res || !res.ok) pageExportSig = '';
      })
      .catch(() => {
        pageExportSig = '';
      });
  }
  function exportPageUnavailable() {
    if (TEST_MODE || !S.host || !S.host.ok) return;
    sendMessage({ type: 'ACE_HOST_EXPORT_PAGE', name: 'page-unavailable', data: { savedAt: Date.now(), unavailable: S.unavailable } }).catch(() => {});
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
    exportPageSongs(songs, sig);
    if (changed) R.order = [];
    checkAutoNew();
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
        S.libVer = result.ver || S.libVer || 0;
        applySongs(result.songs);
        if (S.host.ok || S.options.autoNew) startLive();
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
        .then(() => {
          // 首次載入時 host 狀態可能還沒確認，確認後補送一次快照
          exportPageSongs(S.songs, S.lastSig);
          if (S.unavailable && Object.keys(S.unavailable).length) exportPageUnavailable();
          return refreshDownloadIndex(true);
        })
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
      S.libVer = result.ver || S.libVer || 0;
      S.loaded = true;
      applySongs(result.songs);
      if (S.host.ok || S.options.autoNew) startLive();
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
      // SSE 連著：站點會推版本變動，這裡只做 60 秒一次的增量保險；斷線才回到全量輪詢
      if (liveOpen()) {
        if (Date.now() - LIVE.lastSafety > 60000) {
          LIVE.lastSafety = Date.now();
          pullChanges();
        }
      } else {
        refreshSongsQuiet();
      }
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
    let list = S.onlyUndownloaded ? S.songs.filter((song) => !songDownloadStatus(song).allDone) : S.songs;
    if (S.onlyFavorites) list = list.filter((song) => isFav(song.task_id));
    if (!list.length) {
      box.append(el('div', { class: 'hint', text: S.onlyFavorites ? '還沒有收藏的歌：點歌曲右側的愛心。' : S.onlyUndownloaded ? '太棒了，所有歌曲都下載完成了（或有檔案無法辨識）。' : '找不到已完成的歌曲。' }));
      updateCounts();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const song of list) frag.append(songRow(song));
    box.append(frag);
    highlightPlayingRow();
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
    const playBtn = el('button', { class: 'rowicon', type: 'button', 'data-play': '', title: '播放', 'aria-label': '播放' });
    playBtn.append(icon('play'));
    playBtn.disabled = !song.local_audio;
    playBtn.addEventListener('click', () => (R.currentId === song.task_id && R.playing ? R.audio.pause() : R.currentId === song.task_id && R.audio && R.audio.src ? togglePlay() : playSong(song.task_id)));
    cover.addEventListener('click', () => song.local_audio && playSong(song.task_id));
    const favBtn = el('button', { class: 'rowicon', type: 'button', 'data-fav': '', 'aria-label': '收藏' });
    favBtn.append(icon('heart'));
    paintFav(favBtn, song.task_id);
    favBtn.addEventListener('click', () => toggleFavorite(song.task_id));
    return el('div', { class: 'song', 'data-song-id': song.task_id }, [checkbox, cover, body, playBtn, favBtn, perSong]);
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
    if (p.rateLimited > 0) S.els.stats.append(chip('限流略過', p.rateLimited, true));
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
    const got = await storageGet([KEY_HISTORY, KEY_FOLDERS, KEY_UNAVAILABLE]);
    S.history = got[KEY_HISTORY] && typeof got[KEY_HISTORY] === 'object' ? got[KEY_HISTORY] : {};
    const localNa = got[KEY_UNAVAILABLE] && typeof got[KEY_UNAVAILABLE] === 'object' ? got[KEY_UNAVAILABLE] : {};
    S.unavailable = P.mergeUnavailable(localNa, S.agentUnavailable);
    const folders = got[KEY_FOLDERS] && typeof got[KEY_FOLDERS] === 'object' ? got[KEY_FOLDERS] : {};
    S.folderByTask = folders.folderByTask && typeof folders.folderByTask === 'object' ? folders.folderByTask : {};
    S.ownerByFolder = folders.ownerByFolder && typeof folders.ownerByFolder === 'object' ? folders.ownerByFolder : {};
  }

  /** 寫入「站點不提供」紀錄；prep worker 會並行，用 promise 鏈序列化避免互相覆蓋 */
  let unavailableChain = Promise.resolve();
  function recordUnavailable(taskId, kind) {
    unavailableChain = unavailableChain
      .then(async () => {
        const got = await storageGet([KEY_UNAVAILABLE]);
        const prev = (got && got[KEY_UNAVAILABLE]) || {};
        const next = P.markUnavailable(prev, taskId, kind, 'no_download');
        S.unavailable = P.mergeUnavailable(S.unavailable, next);
        await storageSet({ [KEY_UNAVAILABLE]: next });
        exportPageUnavailable();
      })
      .catch(() => {});
    return unavailableChain;
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
      if (response.ok && data && data.url) return new URL(data.url, location.origin).href;
      const detail = siteErrorDetail(data, response.status);
      const code = data && data.error && data.error.code;
      if (response.status === 401 || /log ?in|login/i.test(detail)) throw new Error('登入已過期，請重新整理頁面並按「同步 Agent」');
      // 站點對某些歌曲不提供 MIDI／MusicXML（no_download）：跳過，不算失敗
      if (response.status === 404 && code === 'no_download') {
        const err = new Error('站點不提供此檔案（no_download）');
        err.code = 'NOT_AVAILABLE';
        throw err;
      }
      // 站點限流：等一分鐘再試，最多三次；仍失敗才中止整個 job
      if (response.status === 429 || code === 'rate_limited' || /too often|too many/i.test(detail)) {
        // 限流：這條「站點生成」佇列等 60 秒再試（最多 2 次）；其他檔案不受影響。仍限流才放棄剩下的生成
        if (attempt < 2) {
          flash(`站點限流，等待 60 秒後重試（${kind}）`);
          await sleep(TEST_MODE ? 200 : 60000);
          continue;
        }
        const err = new Error('站點限流（429）：' + detail);
        err.code = 'RATE_LIMIT';
        throw err;
      }
      if (response.status === 402) throw new Error('目前方案不含此下載：' + detail);
      throw new Error(detail);
    }
    throw new Error('站點限流，請稍後再試');
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
      if (response.status === 401) throw new Error('登入已過期，請重新整理頁面再試');
      if (response.status === 403) throw new Error('站點拒絕下載（HTTP 403）');
      // WAV 只有部分模型支援；400/404 都視為「這首沒有 WAV」→ 跳過，不算失敗
      if (kind === 'wav' && (response.status === 404 || response.status === 400)) {
        const err = new Error('此歌曲的模型不提供 WAV（站點 ' + response.status + '）');
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

  /** 站點模型資訊（/api/status）：哪些模型只有 lossy 音檔（沒有 WAV）。每頁載入問一次，失敗用 planner 後備規則 */
  let siteModelsPromise = null;
  function ensureSiteModels() {
    if (!siteModelsPromise) {
      siteModelsPromise = fetch('/api/status', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const models = data && Array.isArray(data.models) ? data.models : [];
          if (models.length) S.lossyModels = new Set(models.filter((m) => m && m.lossy).map((m) => m.id));
        })
        .catch(() => {
          siteModelsPromise = null; // 下次再試
        });
    }
    return siteModelsPromise;
  }

  async function startJob(songs, jobOpts = {}) {    if (S.running) {
      flash('已有下載進行中');
      return;
    }
    const types = jobOpts.types || FILE_TYPES.filter((type) => S.options[type]);
    S.jobAuto = !!jobOpts.auto;
    if (!types.length) {
      flash('請至少勾選一種檔案類型');
      return;
    }
    await Promise.all([loadDownloadState(), ensureSiteModels()]);
    const plan = P.buildDownloadPlan({
      songs,
      options: {
        types,
        root: S.rootFolder,
        typeFolders: S.options.typeFolders,
        force: S.options.force,
        origin: location.origin,
        lossyModels: S.lossyModels,
      },
      state: { folderByTask: S.folderByTask, ownerByFolder: S.ownerByFolder, history: S.history, unavailable: S.unavailable },
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
          // alias 只跳過 MP3（完整音檔重複）；分軌等同名檔案可能來自不同 take
          let skip = (aliased && file.kind === 'mp3') || S.fsRel.has(rel);
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
    // 順序：直接連結（分軌／封面／MP3）→ 需要問網址的檔案（WAV／MP3）→ 站點生成（MIDI／MusicXML）最後。
    // 生成很慢又會被限流，放最後才不會讓 WAV 等在它後面。
    const rank = (entry) => (entry.file.source === 'url' ? 0 : entry.file.source === 'api' ? 2 : 1);
    entries.sort((a, b) => rank(a) - rank(b));

    const concurrency = clamp(Math.round(Number(S.options.concurrency) || 4), 1, 6);
    // 兩條獨立的準備佇列：檔案網址（快，3 並行）與站點生成（慢、限流，2 並行），互不阻塞
    const fileEntries = entries.filter((entry) => entry.file.source === 'file');
    const genEntries = entries.filter((entry) => entry.file.source === 'api');
    const apiEntries = [...fileEntries, ...genEntries];
    let generationHalted = false; // 站點限流後：剩下的 MIDI／MusicXML 不再請求（記為略過），其他檔案照常下載
    let rateLimited = 0;

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

    // 準備階段：背景取得檔案 URL（WAV／MP3）與站點生成（MIDI／MusicXML），兩條佇列分開跑
    const prepPromise = (async () => {
      const runQueue = async (queue, width) => {
      let prepCursor = 0;
      const prepWorker = async () => {
        while (true) {
          if (S.cancelled || !S.running) return;
          const index = prepCursor++;
          if (index >= queue.length) return;
          const entry = queue[index];
          if (entry.file.source === 'api' && generationHalted) {
            entry.rateLimited = true;
            entry.prepDone = true;
            continue;
          }
          entry.preparing = true;
          S.progress.activePrep = countActivePrep();
          renderProgressSoon();
          try {
            // 站點對 MIDI 生成有速率限制：MIDI 間隔 2.5 秒、MusicXML 0.6 秒
            if (entry.file.source === 'api') await sleep(entry.file.apiKind === 'midi' ? 2500 : 600);
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
            if (isAuthError(err)) {
              if (!S.cancelled) {
                S.cancelled = true;
                flash('登入已過期，請重新整理 acemusic.ai 頁面再試');
              }
              return;
            }
            if (err && err.code === 'RATE_LIMIT') {
              // 只停「站點生成」：這個與剩下的 MIDI／MusicXML 記為略過，WAV／MP3／分軌／封面繼續下載
              if (!generationHalted) {
                generationHalted = true;
                flash('站點限流：MIDI／MusicXML 先略過，其他檔案繼續下載；稍後再按一次下載即可補齊');
              }
              entry.rateLimited = true;
              return;
            }
            if (err && (err.code === 'WAV_UNSUPPORTED' || err.code === 'NOT_AVAILABLE')) {
              entry.unsupported = true;
              if (err.code === 'NOT_AVAILABLE') {
                // 記住「站點不提供」：下次不再請求，狀態顯示「不可用」而不是「部分」
                await recordUnavailable(entry.task.task_id, entry.file.kind);
              }
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
      await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, () => prepWorker()));
      };
      await Promise.all([runQueue(fileEntries, 3), runQueue(genEntries, 2)]);
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
            if (entry.rateLimited) {
              rateLimited += 1;
              S.progress.skipped = (Number(S.progress.skipped) || 0) + 1;
              S.progress.rateLimited = rateLimited;
              continue;
            }
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
          if (isAuthError(err)) {
            if (!S.cancelled) {
              S.cancelled = true;
              flash('登入已過期，請重新整理 acemusic.ai 頁面再試');
            }
            return;
          }
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
      emitPageEvent({
        type: 'download_done',
        auto: !!S.jobAuto,
        task_ids: plan.tasks.map((task) => task.task_id),
        done,
        failed,
        skipped,
        cancelled: !!S.cancelled,
        rateLimited,
        bytes,
      });
      if (S.cancelled) flash(`已停止（已完成的檔案保留，花了 ${secs} 秒）`);
      else if (failed) flash(`完成 ${done} 個，失敗 ${failed} 個（${secs} 秒），詳見失敗清單`);
      else if (rateLimited) flash(`完成 ${done} 個；MIDI／MusicXML 因站點限流略過 ${rateLimited} 個，稍後再按一次下載即可補齊（已下載的會自動跳過）`);
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
  loadSettings()
    .then(() => {
      syncOptionsToUi();
      startAutoRefresh();
      return Promise.all([loadDownloadState(), loadAutoState(), loadRadio()]);
    })
    .then(() => refreshHostStatus())
    .then(() => {
      // 有本機中樞或開了新歌自動下載：面板沒打開也要在背景同步歌單（給 agent／自動下載用）
      if (S.options.autoNew) enableAutoNew();
      if (S.host.ok || S.options.autoNew) {
        startLive();
        if (!S.loaded) refreshSongsQuiet();
      }
      return refreshDownloadIndex(true);
    })
    .then(() => {
      if (S.songs.length) renderSongs();
    })
    .catch(() => {});
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






