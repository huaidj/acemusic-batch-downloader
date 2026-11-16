// content.js — ACE Music 批量下載器的頁面端：UI 面板 + 歌單抓取 + 下載排程。
// 全部狀態留在頁面內（content script），service worker 只負責真正呼叫 chrome.downloads。
'use strict';
(() => {
  const N = globalThis.AceDLNaming;
  const P = globalThis.AceDLPlanner;
  const P2 = globalThis.AceDLPrompts;
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
    musicxml: true,
    mp3: true,
    wav: true,
    cover: true,
    force: false,
    typeFolders: true,
    autoRefresh: true,
    autoFix: true,
    autoOrganize: true,
    autoNew: false, // 新歌自動下載（只處理開啟之後完成的歌）
    autoStems: true, // 已觀察到的歌曲，後來新增已購買/請求完成的分軌時自動補抓。
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
    starting: null,
    cancelled: false,
    runtimeInvalidated: false,
    stopReason: '',
    activeJob: null,
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
    fsAt: 0,
    localIndexByTask: new Map(),
    localIndexAvailable: false,
    localIndexRevision: '',
    localIndexRoot: '',
    localIndexSavedAt: 0,
    localIndexAttemptAt: 0,
    localIndexMessage: '本機核對未就緒',
    recentDownloads: new Map(),
    doneKinds: new Map(),
    unavailable: {},
    agentUnavailable: {},
    onlyUndownloaded: false,
    onlyFavorites: false,
    siteModels: null,
  };

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // e2e 測試會注入 __ACEDL_TEST_MODE__，避免真機 host 的檔案索引/去重紀錄污染測試
  const TEST_MODE = globalThis.__ACEDL_TEST_MODE__ === true;
  let diagnosticsTimer = 0;
  const diagnosticStorage = (() => { try { return sessionStorage; } catch (_) { return null; } })();
  const DL = globalThis.AceDLDiagnostics?.createLogger({ storage: diagnosticStorage, onRecord: () => scheduleDiagnosticsExport() }) || { record() {}, snapshot: () => ({ events: [] }) };
  function diagnosticProgress(extra = {}) {
    const p = S.progress;
    return { phase: p.phase, current: p.current, activePrep: p.activePrep, activeDl: p.activeDl,
      elapsedMs: S.jobStartedAt ? Date.now() - S.jobStartedAt : 0,
      counts: { done: p.done, failed: p.failed, skipped: p.skipped, total: p.total, rateLimited: p.rateLimited }, ...extra };
  }
  function scheduleDiagnosticsExport() {
    if (diagnosticsTimer || TEST_MODE) return;
    diagnosticsTimer = setTimeout(() => {
      diagnosticsTimer = 0;
      try {
        if (!chrome.runtime.id) return; // sessionStorage survives extension invalidation and page refresh.
        chrome.runtime.sendMessage({ type: 'ACE_SAVE_DIAGNOSTICS', data: DL.snapshot() }, () => { try { void chrome.runtime.lastError; } catch (_) { /* invalidated while sending */ } });
      } catch (_) { /* retry after the next record/reload; never read cookies */ }
    }, 5000);
  }
  DL.record('logger_ready');
  setInterval(() => { if (S.running) DL.record('heartbeat', diagnosticProgress()); }, 30000);

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

  const CONTEXT_INVALIDATED_MESSAGE = '擴充功能已更新或重新載入，請刷新 ACE 頁面後再下載；已完成的檔案會保留';

  function isContextInvalidated(err) {
    return !!(err && err.code === 'EXTENSION_CONTEXT_INVALIDATED') || /extension context invalidated|extension has been invalidated/i.test(String((err && err.message) || err || ''));
  }

  function contextInvalidatedError() {
    const err = new Error(CONTEXT_INVALIDATED_MESSAGE);
    err.code = 'EXTENSION_CONTEXT_INVALIDATED';
    return err;
  }

  function stopForInvalidatedContext() {
    if (S.runtimeInvalidated) return;
    DL.record('context_invalidated', diagnosticProgress({ errorCode: 'EXTENSION_CONTEXT_INVALIDATED', error: CONTEXT_INVALIDATED_MESSAGE }));
    S.runtimeInvalidated = true;
    stopLocalStateSync();
    S.cancelled = true;
    S.stopReason = CONTEXT_INVALIDATED_MESSAGE;
    S.progress.phase = S.running ? 'cancelling' : 'cancelled';
    // 這是整個頁面的連線故障，不是每個音檔各失敗一次。
    S.failedList.push({ name: '下載已停止', error: CONTEXT_INVALIDATED_MESSAGE });
    renderProgress();
    flash(CONTEXT_INVALIDATED_MESSAGE);
  }

  function assertRuntimeUsable() {
    if (S.runtimeInvalidated) throw contextInvalidatedError();
    try {
      if (!chrome.runtime.id) throw contextInvalidatedError();
    } catch (err) {
      if (isContextInvalidated(err)) {
        stopForInvalidatedContext();
        throw contextInvalidatedError();
      }
      throw err;
    }
  }

  function assertJobActive(job) {
    assertRuntimeUsable();
    // 已停止的舊 prep 不得在下一批把 cancelled 清掉後恢復送出請求。
    if (job !== S.activeJob || S.cancelled || !S.running) {
      const err = new Error('下載工作已停止');
      err.code = 'JOB_CANCELLED';
      throw err;
    }
  }

  async function waitForJob(ms, job) {
    const deadline = Date.now() + ms;
    do {
      assertJobActive(job);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await sleep(Math.min(100, remaining));
    } while (true);
  }

  function setJobWaitReason(job, key, value) {
    if (job !== S.activeJob) return;
    if (!job.waitReasons) job.waitReasons = new Map();
    if (value) job.waitReasons.set(key, value);
    else job.waitReasons.delete(key);
    S.progress.waitReason = [...job.waitReasons.values()][0] || '';
    renderProgressSoon();
  }

  function withConnectionTimeout(promise, timeoutMs, job) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('擴充功能連線逾時，請刷新 ACE 頁面再試')), timeoutMs);
      const watch = setInterval(() => {
        try {
          if (job) assertJobActive(job);
          else assertRuntimeUsable();
        } catch (err) {
          finish(reject, err);
        }
      }, 100);
      Promise.resolve(promise).then((value) => finish(resolve, value), (err) => finish(reject, err));
    });
  }

  async function checkDownloadConnection(job = null) {
    if (job) assertJobActive(job);
    else assertRuntimeUsable();
    const response = await withConnectionTimeout(sendMessage({ type: 'ACE_PING' }), 5000, job);
    if (job) assertJobActive(job);
    if (!response || !response.ok) throw new Error('無法連線擴充功能，請刷新 ACE 頁面再試');
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
      const fail = (err) => {
        if (isContextInvalidated(err)) {
          stopForInvalidatedContext();
          reject(contextInvalidatedError());
        } else reject(err);
      };
      try {
        assertRuntimeUsable();
        chrome.runtime.sendMessage(msg, (response) => {
          try {
            const lastError = chrome.runtime.lastError;
            if (lastError) fail(new Error(lastError.message));
            else if (response && !response.ok && isContextInvalidated(response.error)) fail(new Error(response.error));
            else resolve(response);
          } catch (err) {
            fail(err);
          }
        });
      } catch (err) {
        fail(err);
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
  max-width: min(280px, calc(100vw - 36px));
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
.fab .dot { flex: none; }
.fab-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.panel:has(.download-settings[open]), .panel:has(.more-tools[open]) { overflow-y: auto; }
.panel > header, .panel > .player, .panel > .rand, .panel > .footer { flex-shrink: 0; }
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

.download-settings { border-bottom: 1px solid var(--line); flex-shrink: 0; }
.download-settings > summary { display: flex; align-items: center; gap: 8px; padding: 9px 14px; color: var(--muted); cursor: pointer; list-style: none; user-select: none; }
.download-settings > summary::-webkit-details-marker, .more-tools > summary::-webkit-details-marker { display: none; }
.download-settings > summary::before, .more-tools > summary::before { content: "▸"; display: inline-block; color: var(--faint); font-size: 11px; }
.download-settings[open] > summary::before, .more-tools[open] > summary::before { content: "▾"; }
.download-settings > summary:hover { color: var(--text); background: var(--surface); }
.settings-copy { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 10px; flex: 1; min-width: 0; }
.settings-label { font-size: 12px; font-weight: 600; color: var(--text); }
.settings-summary { color: var(--faint); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.settings-cost { display: block; flex-basis: 100%; font-size: 10.5px; color: var(--warn); }
.settings-cost[hidden] { display: none; }
.opts { display: flex; flex-direction: column; gap: 10px; padding: 10px 14px 12px; border-top: 1px solid var(--line); max-height: 250px; overflow-y: auto; }
.option-group { display: flex; flex-wrap: wrap; gap: 7px 12px; align-items: center; }
.option-label { flex-basis: 100%; color: var(--faint); font-size: 10.5px; }
.chk { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); cursor: pointer; font-size: 12px; }
.chk:hover { color: var(--text); }
.chk input { accent-color: var(--accent); }
.chk select.mini {
  padding: 2px 4px; border-radius: 6px; border: 1px solid var(--line); background: var(--field);
  color: var(--text); font-size: 11.5px; outline: none;
}
.sep { width: 1px; height: 16px; background: var(--line-strong); margin: 0 2px; }
.root { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-left: auto; max-width: 100%; }
.root input {
  width: 128px; padding: 4px 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--field);
  color: var(--text); font-size: 12px; outline: none;
}
.root input:focus { border-color: var(--accent); }

.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 8px 14px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
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
.selection-toolbar .count { color: var(--faint); font-size: 10.5px; flex-basis: 100%; line-height: 1.5; }
.toolbar-label { color: var(--faint); font-size: 10.5px; margin-right: 2px; }
.library-tools { background: var(--field); }
.more-tools { margin-left: auto; max-width: 100%; }
.more-tools > summary { display: inline-flex; gap: 5px; align-items: center; padding: 5px 8px; cursor: pointer; list-style: none; border-radius: 6px; color: var(--muted); font-size: 11.5px; user-select: none; }
.more-tools > summary:hover { color: var(--text); background: var(--surface-hover); }
.more-tools[open] { flex-basis: 100%; margin-left: 0; }
.maintenance-menu { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 8px 0 2px; max-height: 170px; overflow-y: auto; }
.maintenance-menu button { text-align: left; padding: 6px 9px; }
@media (max-width: 420px) { .toolbar { gap: 6px; padding-left: 10px; padding-right: 10px; } .selection-toolbar button { padding-left: 7px; padding-right: 7px; font-size: 11px; } .option-group .root { margin-left: 0; } }

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
/* 隨機提示詞 */
.rand { border-bottom: 1px solid var(--line); }
.rand > summary { cursor: pointer; padding: 8px 14px; font-size: 12px; color: var(--muted); list-style: none; user-select: none; }
.rand > summary::-webkit-details-marker { display: none; }
.rand > summary::before { content: "▸"; display: inline-block; margin-right: 6px; transition: transform .12s; }
.rand[open] > summary::before { transform: rotate(90deg); }
.rand > summary:hover { color: var(--text); }
.randbody { padding: 2px 14px 10px; display: flex; flex-direction: column; gap: 7px; }
.randctx { font-size: 11px; color: var(--faint); }
.randnote { font-size: 11.5px; color: var(--warn); background: var(--warn-soft); border: 1px solid rgba(224, 180, 92, .25); border-radius: 8px; padding: 6px 9px; }
.randnote[hidden] { display: none; }
.randactions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
.randlocks { display: inline-flex; gap: 8px; }
.randtext { width: 100%; resize: vertical; min-height: 84px; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--line); background: var(--field); color: var(--text); font: 11.5px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace; outline: none; }
.randtext:focus { border-color: var(--accent); }
.randmeta { font-size: 10.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
.randhist { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); font-size: 10.5px; cursor: pointer; font-variant-numeric: tabular-nums; }
.chip:hover { background: var(--surface-hover); color: var(--text); }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .fab.running .dot { animation: none; } .bar i, .tidybar .track i { transition: none; } .rand > summary::before { transition: none; } }
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
    const subBox = el('div', { class: 'sub', text: 'v1.7.5 · 分軌 · MIDI · WAV' });
    const alphaInput = el('input', { type: 'range', min: '40', max: '100', step: '5', 'data-ui': 'alpha', 'aria-label': '面板不透明度' });
    const alphaBox = el('label', { class: 'alpha', title: '面板不透明度（拖曳標題列可移動面板，雙擊標題列回到預設位置）' }, ['透明', alphaInput]);
    const header = el('header', { title: '拖曳移動；雙擊回到預設位置' }, [titleBox, subBox, alphaBox, refreshBtn, closeBtn]);

    const settingsSummary = el('span', { class: 'settings-summary', 'data-settings-summary': '' });
    const settingsCost = el('span', { class: 'settings-cost', text: '含 MIDI／MusicXML：站點生成可能扣點數', hidden: true });
    const settings = el('details', { class: 'download-settings', 'data-download-settings': '' }, [
      el('summary', { 'data-settings-toggle': '' }, [el('span', { class: 'settings-copy' }, [
        el('span', { class: 'settings-label', text: '下載設定' }), settingsSummary, settingsCost,
      ])]),
    ]);
    const optRows = el('div', { class: 'opts' });
    const typeRows = el('div', { class: 'option-group' }, [el('span', { class: 'option-label', text: '檔案類型' })]);
    const behaviorRows = el('div', { class: 'option-group' }, [el('span', { class: 'option-label', text: '檔名與整理' })]);
    const automaticRows = el('div', { class: 'option-group' }, [el('span', { class: 'option-label', text: '背景行為' })]);
    const destinationRows = el('div', { class: 'option-group' }, [el('span', { class: 'option-label', text: '下載位置與並行數' })]);
    optRows.append(typeRows, behaviorRows, automaticRows, destinationRows);
    settings.append(optRows);
    const typeLabels = { stems: '分軌', midi: 'MIDI', musicxml: 'MusicXML', mp3: 'MP3', wav: 'WAV', cover: '封面' };
    for (const type of FILE_TYPES) {
      const cb = el('input', { type: 'checkbox', 'data-opt': type, checked: S.options[type] });
      cb.addEventListener('change', () => {
        S.options[type] = cb.checked;
        saveSettings();
        renderSongs();
      });
      typeRows.append(el('label', { class: 'chk' }, [cb, typeLabels[type]]));
    }
    for (const [key, label] of [['force', '強制重下'], ['typeFolders', '依類型分層']]) {
      const cb = el('input', { type: 'checkbox', 'data-opt': key, checked: S.options[key] });
      cb.addEventListener('change', () => {
        S.options[key] = cb.checked;
        saveSettings();
      });
      behaviorRows.append(el('label', { class: 'chk' }, [cb, label]));
    }
    const autoCb = el('input', { type: 'checkbox', 'data-opt': 'autoRefresh', checked: S.options.autoRefresh });
    autoCb.addEventListener('change', () => {
      S.options.autoRefresh = autoCb.checked;
      saveSettings();
      startAutoRefresh();
    });
    automaticRows.append(el('label', { class: 'chk' }, [autoCb, '自動更新']));
    const autoFixCb = el('input', { type: 'checkbox', 'data-opt': 'autoFix', checked: S.options.autoFix });
    autoFixCb.addEventListener('change', () => {
      S.options.autoFix = autoFixCb.checked;
      saveSettings();
    });
    behaviorRows.append(el('label', { class: 'chk', title: '下載後若檔名/資料夾不符（伺服器指定檔名），用本機整理工具自動改名移動' }, [autoFixCb, '自動修正檔名']));
    const autoOrganizeCb = el('input', { type: 'checkbox', 'data-opt': 'autoOrganize', checked: S.options.autoOrganize });
    autoOrganizeCb.addEventListener('change', () => {
      S.options.autoOrganize = autoOrganizeCb.checked;
      saveSettings();
    });
    behaviorRows.append(el('label', { class: 'chk', title: '下載後自動整理：成品MP3／採樣包／MIDI分類' }, [autoOrganizeCb, '下載完自動整理']));
    const autoNewCb = el('input', { type: 'checkbox', 'data-opt': 'autoNew', checked: S.options.autoNew });
    autoNewCb.addEventListener('change', () => {
      S.options.autoNew = autoNewCb.checked;
      saveSettings();
      if (S.options.autoNew) enableAutoNew();
    });
    automaticRows.append(el('label', { class: 'chk', title: '開啟之後新完成的歌，自動下載上方勾選的類型（分軌會等分離完成）；需開著這個分頁' }, [autoNewCb, '新歌自動下載']));
    const autoStemsCb = el('input', { type: 'checkbox', 'data-opt': 'autoStems', checked: S.options.autoStems });
    autoStemsCb.addEventListener('change', () => {
      S.options.autoStems = autoStemsCb.checked;
      saveSettings();
      if (!S.options.autoStems) {
        clearTimeout(AUTO_STEMS.timer);
        AUTO_STEMS.queue = [];
        AUTO_STEMS.pending = {};
        saveAutoStemsState();
      } else {
        checkAutoStems();
        startLive();
      }
    });
    automaticRows.append(el('label', { class: 'chk', title: '只補觀察到後來完成或更新的分軌；首次載入不批量抓歷史分軌。不會發起分軌生成。關閉後停止後續排程，已開始的下載會保留。' }, [autoStemsCb, '分軌完成自動下載']));
    const autoScoresCb = el('input', { type: 'checkbox', 'data-opt': 'autoNewScores', checked: S.options.autoNewScores });
    autoScoresCb.addEventListener('change', () => {
      S.options.autoNewScores = autoScoresCb.checked;
      saveSettings();
    });
    automaticRows.append(el('label', { class: 'chk', title: 'MIDI／MusicXML 由站點即時生成，可能扣 credit；預設自動下載不含' }, [autoScoresCb, '自動含 MIDI／MusicXML']));
    const concSel = el('select', { class: 'mini', 'data-opt': 'concurrency' });
    for (const n of [1, 2, 3, 4, 5, 6]) concSel.append(el('option', { value: String(n), text: String(n) }));
    concSel.value = String(S.options.concurrency);
    concSel.addEventListener('change', () => {
      S.options.concurrency = clamp(Number(concSel.value) || 4, 1, 6);
      saveSettings();
    });
    destinationRows.append(el('label', { class: 'chk' }, ['並行', concSel]));
    const rootInput = el('input', { type: 'text', 'data-root-folder': '', value: S.rootFolder, spellcheck: 'false' });
    rootInput.addEventListener('change', () => {
      S.rootFolder = N.sanitizeComponent(rootInput.value, 40) || DEFAULT_ROOT;
      rootInput.value = S.rootFolder;
      saveSettings();
      updateCounts();
      refreshDownloadIndex(true).then(() => renderSongs());
    });
    destinationRows.append(el('label', { class: 'root' }, ['根資料夾', rootInput]));

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
    const toolbar = el('div', { class: 'toolbar selection-toolbar', role: 'toolbar', 'aria-label': '選擇與篩選' }, [selectAll, selectNone, filterBtn, favFilterBtn, countLabel]);
    const tidyBtn = el('button', { type: 'button', 'data-act': 'tidy', text: '一鍵整理' });
    const extractMp3Btn = el('button', { type: 'button', 'data-act': 'extract-mp3', text: '成品MP3' });
    const watchBtn = el('button', { type: 'button', 'data-act': 'watch', text: '背景自動整理' });
    const openClassifyBtn = el('button', { type: 'button', 'data-act': 'open-classify', text: '開啟分類資料夾' });
    const dedupeCustomBtn = el('button', { type: 'button', 'data-act': 'dedupe-custom', text: '清自訂重複' });
    const maintenanceTools = el('details', { class: 'more-tools', 'data-maintenance-tools': '' }, [
      el('summary', { text: '更多維護' }),
      el('div', { class: 'maintenance-menu', role: 'group', 'aria-label': '進階維護工具' }, [organizeBtn, extractMp3Btn, watchBtn, dedupeCustomBtn, exportAgentBtn]),
    ]);
    const toolbar2 = el('div', { class: 'toolbar library-tools', role: 'toolbar', 'aria-label': '曲庫工具' }, [el('span', { class: 'toolbar-label', text: '曲庫' }), tidyBtn, openClassifyBtn, maintenanceTools]);

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
    const diagnosticsBtn = el('button', { type: 'button', 'data-act': 'copy-diagnostics', text: '複製診斷' });
    diagnosticsBtn.addEventListener('click', async () => {
      const text = JSON.stringify(DL.snapshot(), null, 2);
      if (await copyText(text)) return flash('診斷已複製（不含登入資料）');
      const box = el('textarea', { readonly: true, rows: '8', value: text });
      box.style.width = '100%';
      footer.append(box);
      box.focus(); box.select();
      flash('請按 Ctrl+C 複製已選取的診斷文字');
    });
    const footer = el('div', { class: 'footer' }, [downloadBtn, cancelBtn, diagnosticsBtn, toast, tidyBar, footHint]);

    buildPlayer(); // 保留舊偏好資料；實際播放改由獨立視窗負責。
    const openPlayerBtn = el('button', { type: 'button', 'data-act': 'open-player', text: '獨立播放器' });
    openPlayerBtn.addEventListener('click', () => openIndependentPlayer());
    toolbar.prepend(openPlayerBtn);
    const randomBox = buildRandom();
    panel.append(header, randomBox, settings, toolbar, toolbar2, organizeBox, songsBox, progress, footer);
    shadow.append(fab, panel);

    Object.assign(S.els, {
      host,
      shadow,
      fab,
      fabText: fab.querySelector('.fab-text'),
      panel,
      settingsSummary,
      settingsCost,
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
      S.selected = new Set(visibleSongs().map((song) => song.task_id));
      renderSongs();
    });
    selectNone.addEventListener('click', () => {
      S.selected.clear();
      renderSongs();
    });
    downloadBtn.addEventListener('click', () => {
      const picked = selectedVisibleSongs();
      if (!picked.length) return flash('請先勾選歌曲');
      startJob(picked);
    });
    cancelBtn.addEventListener('click', () => {
      if (!S.running) return;
      DL.record('cancel', diagnosticProgress());
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
  async function openIndependentPlayer(songId) {
    try {
      const result = await sendMessage({ type: 'ACE_OPEN_PLAYER', ...(songId ? { songId } : {}) });
      if (!result?.ok) flash('獨立播放器尚未就緒，請先啟動播放器或更新本機工具');
    } catch (_) { flash('無法開啟獨立播放器，請先啟動播放器或更新本機工具'); }
  }
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
   * 隨機提示詞：讀目前 ACE 頁面的「模式（Idea／Custom）＋模型」→ 選對應詞典 → 隨機一格 → 填進頁面的輸入框
   * 規則：
   *  - 欄位選擇來自站點自己的程式（public/app.js）：Idea 的框是 #prompt、Custom 的 Style 是 #caption；
   *    模式存在 localStorage.createMode、模型存在 localStorage.aceModel（並與模型按鈕上的名稱交叉核對）。
   *  - 只填文字（用原生 setter＋input 事件，頁面的字數計數才會更新），填完讀回核對；
   *    絕不按 Generate（會扣 credit）、不動 Lyrics。
   *  - 產生後如果模型／模式改了，套用會被拒絕並要求重新隨機（不把 v1.1 的詞塞進別的模型）。
   * ------------------------------------------------------------------ */
  const KEY_RANDOM = 'aceRandom';
  const RND = { current: null, ctx: null, history: [], lockA: false, lockB: false };
  const PAGE_FIELD_SELECTORS = { prompt: '#prompt', style: '#caption' };

  const isShown = (node) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  function pageMode() {
    const idea = document.querySelector('#ideaMode');
    const custom = document.querySelector('#customMode');
    if (isShown(idea) && !isShown(custom)) return 'idea';
    if (isShown(custom) && !isShown(idea)) return 'custom';
    let saved = '';
    try {
      saved = localStorage.getItem('createMode') || '';
    } catch (_) {
      /* ignore */
    }
    return saved === 'idea' || saved === 'custom' ? saved : '';
  }
  function pageModelId() {
    let stored = '';
    try {
      stored = localStorage.getItem('aceModel') || '';
    } catch (_) {
      /* ignore */
    }
    // 模型按鈕上顯示的名字是「眼前看到的真相」：與站點模型清單對得上就以它為準
    const label = ((document.querySelector('#modelBtn') || {}).textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (label && S.siteModels) {
      // 名稱互為子字串（「ACE Music v1」⊂「ACE Music v1.1 Preview」）：先精確相等，再取「最長」的包含者，絕不取第一個
      let best = '';
      let bestLen = 0;
      for (const [id, info] of S.siteModels) {
        const name = String((info && info.name) || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!name) continue;
        if (name === label) return id;
        if (label.includes(name) && name.length > bestLen) {
          best = id;
          bestLen = name.length;
        }
      }
      if (best) return best;
    }
    return stored;
  }
  function randomContext() {
    const ctx = P2.resolveContext({ modelId: pageModelId(), mode: pageMode(), siteModels: S.siteModels });
    const node = ctx.field && document.querySelector(PAGE_FIELD_SELECTORS[ctx.field] || '');
    const visibleLimit = node && Number(node.maxLength);
    return visibleLimit > 0 ? { ...ctx, limit: ctx.limit > 0 ? Math.min(ctx.limit, visibleLimit) : visibleLimit } : ctx;
  }

  function randomResultError(cur, ctx) {
    if (!cur?.ok || typeof cur.text !== 'string') return '尚無可套用的提示詞';
    if (ctx.status !== 'ready') return ctx.reason || '目前模型沒有可用詞典';
    if (ctx.modelId !== cur.model || ctx.mode !== cur.mode || ctx.field !== cur.field) return '模型或模式已改變，請重新隨機';
    if (cur.dictionary !== ctx.dictionaryId || cur.dictionaryVersion !== ctx.dictionaryVersion) return '詞典版本已改變，請重新隨機；原草稿已保留';
    if (!(ctx.limit > 0) || cur.text.length > ctx.limit) return `目前上限 ${ctx.limit || '?'} 字，這份草稿有 ${cur.text.length} 字；請重新隨機，原文不截斷`;
    if (Number(cur.limit) !== ctx.limit) return '欄位字數上限已改變，請重新隨機；原草稿已保留';
    const compiled = P2.compile(ctx.dictionary, cur.a?.id, cur.b?.id, ctx.limit);
    if (!compiled.ok) return compiled.reason;
    if (compiled.text !== cur.text) return '詞條內容已更新，請重新隨機；原草稿已保留';
    return '';
  }
  function setNativeValue(node, value) {
    const proto = Object.getPrototypeOf(node);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(node, value);
    else node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  /** 把文字填進頁面欄位；回傳 { ok, reason } */
  function fillPageField(field, text) {
    const node = document.querySelector(PAGE_FIELD_SELECTORS[field] || '');
    if (!node) return { ok: false, reason: `找不到頁面的輸入框（${PAGE_FIELD_SELECTORS[field]}）；站點介面可能改版，請改用「複製」` };
    if (!isShown(node)) return { ok: false, reason: '輸入框目前沒顯示（模式剛切換？）；請確認畫面上看得到輸入框再套用' };
    setNativeValue(node, text);
    if (node.value !== text) return { ok: false, reason: '填入後讀回的內容不一致，已放棄；請改用「複製」' };
    return { ok: true };
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  function loadRandomPrefs() {
    return storageGet([KEY_RANDOM]).then((got) => {
      const data = (got && got[KEY_RANDOM]) || {};
      RND.history = Array.isArray(data.history) ? data.history.slice(0, 12) : [];
      RND.lockA = !!data.lockA;
      RND.lockB = !!data.lockB;
      renderRandom();
    });
  }
  function saveRandomPrefs() {
    return storageSet({ [KEY_RANDOM]: { history: RND.history.slice(0, 12), lockA: RND.lockA, lockB: RND.lockB } });
  }

  function buildRandom() {
    const ctxLine = el('div', { class: 'randctx', 'data-rand-ctx': '' });
    const notice = el('div', { class: 'randnote', 'data-rand-note': '', hidden: true });
    const preview = el('textarea', { class: 'randtext', 'data-rand-text': '', readonly: true, rows: '5', 'aria-label': '隨機產生的提示詞', placeholder: '按「隨機一組」產生；Idea 模式填進自然語言框，Custom 模式填進 Style 框。' });
    const meta = el('div', { class: 'randmeta', 'data-rand-meta': '' });
    const rollBtn = el('button', { class: 'ghost', type: 'button', 'data-rand': 'roll', text: '隨機一組' });
    const lockA = el('input', { type: 'checkbox', 'data-rand-lock': 'a' });
    const lockB = el('input', { type: 'checkbox', 'data-rand-lock': 'b' });
    const applyBtn = el('button', { class: 'ghost', type: 'button', 'data-rand': 'apply', text: '套用到頁面' });
    const copyBtn = el('button', { class: 'ghost', type: 'button', 'data-rand': 'copy', text: '複製' });
    const history = el('div', { class: 'randhist', 'data-rand-history': '' });

    rollBtn.addEventListener('click', () => rollRandom());
    applyBtn.addEventListener('click', () => applyRandom());
    copyBtn.addEventListener('click', async () => {
      if (!RND.current || !RND.current.ok) return;
      flash((await copyText(RND.current.text)) ? '已複製提示詞' : '複製失敗，請手動選取');
    });
    lockA.addEventListener('change', () => {
      RND.lockA = lockA.checked;
      saveRandomPrefs();
    });
    lockB.addEventListener('change', () => {
      RND.lockB = lockB.checked;
      saveRandomPrefs();
    });

    const lockRow = el('div', { class: 'randlocks' }, [
      el('label', { class: 'chk', title: '固定目前這組的 A 軸（低頻／上層音色），只重抽 B 軸（手鼓／小打／空間）' }, [lockA, '鎖 A 軸']),
      el('label', { class: 'chk', title: '固定目前這組的 B 軸，只重抽 A 軸' }, [lockB, '鎖 B 軸']),
    ]);
    const actions = el('div', { class: 'randactions' }, [rollBtn, lockRow, applyBtn, copyBtn]);
    const body = el('div', { class: 'randbody' }, [ctxLine, notice, actions, preview, meta, history]);
    const box = el('details', { class: 'rand', 'data-rand-box': '' }, [el('summary', { text: '隨機提示詞' }), body]);
    box.addEventListener('toggle', () => {
      if (box.open) renderRandom();
    });
    Object.assign(S.els, { randBox: box, randCtx: ctxLine, randNote: notice, randText: preview, randMeta: meta, randHistory: history, randRoll: rollBtn, randApply: applyBtn, randCopy: copyBtn, randLockA: lockA, randLockB: lockB });
    return box;
  }

  function ctxLabel(ctx) {
    const mode = ctx.mode === 'idea' ? 'Idea' : ctx.mode === 'custom' ? 'Custom' : '未知模式';
    const model = ctx.modelName || ctx.modelId || '未知模型';
    return ctx.field ? `${model} · ${mode} → ${ctx.field === 'prompt' ? '自然語言框' : 'Style 框'}（上限 ${ctx.limit || '?'} 字）` : `${model} · ${mode}`;
  }
  function renderRandom() {
    if (!S.els.randBox) return;
    const ctx = randomContext();
    RND.ctx = ctx;
    S.els.randCtx.textContent = ctxLabel(ctx);
    S.els.randLockA.checked = RND.lockA;
    S.els.randLockB.checked = RND.lockB;
    const ready = ctx.status === 'ready';
    const note = S.els.randNote;
    if (!ready) {
      note.hidden = false;
      note.textContent = ctx.reason || '目前無法產生';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
    S.els.randRoll.disabled = !ready;
    const cur = RND.current;
    const have = !!(cur && cur.ok);
    // 目前這組是為「別的模型／模式」產生的 → 不能套用
    const staleReason = have ? randomResultError(cur, ctx) : '';
    const stale = have && !!staleReason;
    S.els.randApply.disabled = !have || !ready || stale;
    S.els.randCopy.disabled = !have;
    S.els.randText.value = have ? cur.text : '';
    S.els.randMeta.textContent = have
      ? `${cur.a.id} ${cur.a.name_zh} × ${cur.b.id} ${cur.b.name_zh} · ${cur.text.length}/${ctx.limit || cur.limit} 字 · seed ${cur.seed} · ${cur.modelName}／${cur.mode} · 詞典 v${cur.dictionaryVersion}${stale ? ' · ⚠ ' + staleReason : ''}`
      : '';
    S.els.randHistory.textContent = '';
    for (const item of RND.history) {
      const b = el('button', { class: 'chip', type: 'button', title: `${item.a.name_zh} × ${item.b.name_zh}（${item.modelName}／${item.mode}）`, text: item.cell });
      b.addEventListener('click', () => {
        RND.current = item;
        renderRandom();
      });
      S.els.randHistory.append(b);
    }
  }
  /** 使用者在頁面上切換模式或模型時，面板的隨機區要跟著更新（輕量輪詢；只在展開且面板開著時） */
  let randomSig = '';
  function refreshRandomContext() {
    if (!S.els.randBox || !S.els.randBox.open || (S.els.panel && S.els.panel.hidden)) return;
    const ctx = randomContext();
    const sig = [ctx.status, ctx.modelId, ctx.mode, ctx.limit, ctx.dictionaryId, ctx.dictionaryVersion].join('|');
    if (sig === randomSig) return;
    randomSig = sig;
    renderRandom();
  }
  setInterval(refreshRandomContext, 1200);

  function rollRandom() {
    const ctx = randomContext();
    const cur = RND.current && RND.current.ok && RND.current.model === ctx.modelId && RND.current.mode === ctx.mode ? RND.current : null;
    const result = P2.randomPrompt({
      context: ctx,
      lockA: RND.lockA && cur ? cur.a.id : null,
      lockB: RND.lockB && cur ? cur.b.id : null,
    });
    if (!result.ok) {
      renderRandom();
      flash(result.reason || '無法產生');
      return;
    }
    RND.current = result;
    RND.history = [result, ...RND.history.filter((h) => !(h.cell === result.cell && h.model === result.model && h.mode === result.mode))].slice(0, 12);
    saveRandomPrefs();
    renderRandom();
  }
  function applyRandom() {
    const cur = RND.current;
    if (!cur || !cur.ok) return;
    const ctx = randomContext();
    const invalid = randomResultError(cur, ctx);
    if (invalid) {
      renderRandom();
      return flash(invalid);
    }
    const res = fillPageField(cur.field, cur.text);
    flash(res.ok ? `已填入${cur.field === 'prompt' ? '自然語言框' : 'Style 框'}（${cur.length} 字）；確認後自行按 Generate` : res.reason);
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
  let downloadIndexPromise = null;
  async function refreshDownloadIndex(force = false) {
    if (S.runtimeInvalidated) return false;
    if (!force && S.localIndexRoot === S.rootFolder && Date.now() - S.localIndexAttemptAt < 1500) return S.localIndexAvailable;
    if (downloadIndexPromise) {
      const requestedRoot = S.rootFolder;
      const current = await downloadIndexPromise;
      return requestedRoot === S.rootFolder && S.localIndexRoot !== requestedRoot ? refreshDownloadIndex(force) : current;
    }
    const root = S.rootFolder;
    S.localIndexAttemptAt = Date.now();
    downloadIndexPromise = (async () => {
      try {
        const response = await withConnectionTimeout(sendMessage({ type: 'ACE_HOST_LOCAL_INDEX', root, refresh: !!force }), 12000, null);
        const index = response?.index || response?.data?.index || response?.data;
        if (!response?.ok || !index?.ok || index.apiVersion !== 1 || !index.byTask || typeof index.byTask !== 'object' || Array.isArray(index.byTask)) throw new Error('本機核對未就緒；請更新本機工具');
        if (root !== S.rootFolder) return false;
        if (S.localIndexRevision !== index.revision || S.localIndexRoot !== root || !S.localIndexAvailable) S.localIndexByTask = new Map(Object.entries(index.byTask));
        S.localIndexRevision = String(index.revision || '');
        S.localIndexSavedAt = Number(index.savedAt) || Date.parse(index.savedAt) || 0;
        S.localIndexRoot = root;
        S.localIndexAvailable = true;
        S.localIndexMessage = '';
        S.fsAt = Date.now();
        await refreshDoneKinds();
        return true;
      } catch (err) {
        S.localIndexAvailable = false;
        S.localIndexMessage = S.runtimeInvalidated ? CONTEXT_INVALIDATED_MESSAGE : '本機核對未就緒；請更新本機工具或稍後再試。仍可手動下載。';
        await refreshDoneKinds();
        return false;
      } finally { downloadIndexPromise = null; }
    })();
    return downloadIndexPromise;
  }

  function indexedTask(taskId) {
    return S.localIndexAvailable && S.localIndexRoot === S.rootFolder ? S.localIndexByTask.get(taskId) || null : null;
  }

  function completedKeysForTask(taskId) {
    const row = indexedTask(taskId);
    const keys = new Set(Array.isArray(row?.completedKeys) ? row.completedKeys.filter((key) => typeof key === 'string') : []);
    const recent = S.recentDownloads.get(taskId);
    for (const [key, proof] of recent || []) {
      if (Date.now() - proof.at > 60000) { recent.delete(key); continue; }
      if (proof.root === S.rootFolder && (!S.localIndexAvailable || proof.at > S.localIndexSavedAt)) keys.add(key);
    }
    return keys;
  }

  const LOCAL_SYNC = { timer: 0, debounce: 0, busy: false, pending: false, revision: null, lastHostCheck: 0, renderPending: false };

  function localStatusSignature() {
    return S.songs.map((song) => {
      const status = songDownloadStatus(song);
      return [song.task_id, status.known, status.have, status.total, status.mp3, status.wav, status.missingCount, status.uncertainCount, status.detail.map((item) => [item.type || item.label, item.have, item.total, item.na, item.uncertain])];
    }).map((value) => JSON.stringify(value)).join('\n');
  }

  function renderLocalStatusChanges() {
    const focused = document.getElementById(HOST_ID)?.shadowRoot?.activeElement;
    // 只更新歌曲清單；保留播放器、提示詞、選項和正在操作的歌曲控制項。
    if (focused && S.els.songsBox && S.els.songsBox.contains(focused)) {
      if (!LOCAL_SYNC.renderPending) {
        LOCAL_SYNC.renderPending = true;
        focused.addEventListener('blur', () => {
          LOCAL_SYNC.renderPending = false;
          if (!S.runtimeInvalidated) renderSongs();
        }, { once: true });
      }
      return;
    }
    renderSongs();
  }

  async function syncLocalState(force = false) {
    if (S.runtimeInvalidated) { stopLocalStateSync(); return; }
    if (LOCAL_SYNC.busy) { LOCAL_SYNC.pending = LOCAL_SYNC.pending || force; return; }
    LOCAL_SYNC.busy = true;
    try {
      const before = localStatusSignature();
      await refreshDownloadIndex(force);
      if (before !== localStatusSignature()) renderLocalStatusChanges();
    } finally {
      LOCAL_SYNC.busy = false;
      if (LOCAL_SYNC.pending && !S.runtimeInvalidated) {
        LOCAL_SYNC.pending = false;
        scheduleLocalStateSync();
      }
    }
  }

  function scheduleLocalStateSync() {
    if (S.runtimeInvalidated) return;
    clearTimeout(LOCAL_SYNC.debounce);
    LOCAL_SYNC.debounce = setTimeout(() => { LOCAL_SYNC.debounce = 0; syncLocalState(true); }, 250);
  }

  function stopLocalStateSync() {
    clearInterval(LOCAL_SYNC.timer);
    clearTimeout(LOCAL_SYNC.debounce);
    LOCAL_SYNC.timer = LOCAL_SYNC.debounce = 0;
    LOCAL_SYNC.pending = false;
  }

  function startLocalStateSync() {
    if (LOCAL_SYNC.timer || S.runtimeInvalidated) return;
    LOCAL_SYNC.timer = setInterval(() => syncLocalState(false), 2000);
    syncLocalState(false);
  }

  async function refreshDoneKinds() {
    const done = new Map();
    for (const id of new Set([...S.songs.map((song) => song.task_id), ...S.recentDownloads.keys(), ...S.localIndexByTask.keys()])) {
      const keys = completedKeysForTask(id);
      if (keys.size) done.set(id, keys);
    }
    S.doneKinds = done;
  }

  function historyFileExists(info, taskId, key) {
    return !!info && !!taskId && !!key && completedKeysForTask(taskId).has(key);
  }

  function existingDownloadHistory() {
    return Object.fromEntries(Object.entries(S.history || {}).map(([taskId, entry]) => [taskId, {
      ...entry,
      files: Object.fromEntries(Object.entries(entry?.files || {}).filter(([key, info]) => historyFileExists(info, taskId, key))),
    }]));
  }

  function noteOwnDownload(taskId, file) {
    const info = S.history[taskId]?.files?.[file.key];
    if (!info) return;
    if (!S.recentDownloads.has(taskId)) S.recentDownloads.set(taskId, new Map());
    S.recentDownloads.get(taskId).set(file.key, { at: Number(info.at) || Date.now(), root: String(file.path).split('/')[0] });
    if (!S.doneKinds.has(taskId)) S.doneKinds.set(taskId, new Set());
    S.doneKinds.get(taskId).add(file.key);
  }

  /** Status and skip use the same exact task/file-key proof, never a title or alias. */
  function songDownloadStatus(song) {
    const row = indexedTask(song.task_id);
    const done = completedKeysForTask(song.task_id);
    const group = P.pickStemGroup(song.stems);
    const stems = (group?.tracks || []).filter((track) => done.has('stem:' + track.id)).length;
    const downloaded = { stems };
    for (const kind of ['mp3', 'wav', 'midi', 'musicxml', 'cover']) downloaded[kind] = done.has(kind);
    const status = P.downloadStatusForTypes(song, { types: FILE_TYPES.filter((type) => S.options[type]), downloaded, unavailable: S.unavailable, lossyModels: S.lossyModels });
    const uncertainKinds = new Set(Array.isArray(row?.uncertainKinds) ? row.uncertainKinds : []);
    const known = !!row || status.have > 0;
    const detail = status.detail.map((item) => ({ ...item, uncertain: !item.done && !item.na && (!row || uncertainKinds.has(item.type)) }));
    const missingCount = detail.reduce((total, item) => total + (!item.done && !item.na && !item.uncertain ? Math.max(0, item.total - item.have) : 0), 0);
    const uncertainCount = detail.reduce((total, item) => total + (item.uncertain ? Math.max(0, item.total - item.have) : 0), 0);
    return { ...status, detail, known, missingCount, uncertainCount, allDone: status.allDone && uncertainCount === 0, mp3: downloaded.mp3, wav: downloaded.wav };
  }

  function downloadStatusLabel(status) {
    return P.downloadStatusLabel(status, S.localIndexMessage);
  }

  function updateFab() {
    const fab = S.els.fab;
    if (!fab) return;
    fab.classList.toggle('running', S.running);
    const p = S.progress;
    const remaining = Math.max(0, Number(p.total || 0) - Number(p.done || 0) - Number(p.failed || 0) - Number(p.skipped || 0));
    const labels = { stems: '分軌', midi: 'MIDI', musicxml: 'MusicXML', mp3: 'MP3', wav: 'WAV', cover: '封面' };
    const kind = labels[p.currentKind] || (/\.wav$/i.test(p.current || '') ? 'WAV' : /\.mp3$/i.test(p.current || '') ? 'MP3' : /\.midi?$/i.test(p.current || '') ? 'MIDI' : '下載');
    const title = String(p.currentTitle || String(p.current || '').split('／')[0] || '準備檔案');
    const short = title.length > 13 ? title.slice(0, 12) + '…' : title;
    if (S.running) S.els.fabText.textContent = `${p.waitReason ? 'MIDI/XML 限流' : kind} · ${short} ${p.done}/${p.total}${p.failed ? ` · 失敗 ${p.failed}` : ''}`;
    else if (S.runtimeInvalidated) S.els.fabText.textContent = '請刷新 ACE 頁面';
    else if (p.phase === 'done' && p.failed) S.els.fabText.textContent = `完成 ${p.done} · 失敗 ${p.failed}`;
    else S.els.fabText.textContent = '批量下載';
    fab.title = [S.stopReason || p.waitReason || (S.running ? `${kind} · ${p.current || '準備檔案'}` : 'ACE 批量下載'), `完成 ${p.done || 0}／${p.total || 0} · 失敗 ${p.failed || 0} · 略過 ${p.skipped || 0} · 剩餘 ${remaining} · 準備中 ${p.activePrep || 0}`].join('\n');
  }

  function progressPercent() {
    const p = S.progress;
    if (!p.total) return 0;
    return clamp(Math.round(((p.done + p.failed + (Number(p.skipped) || 0)) / p.total) * 100), 0, 100);
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
      const response = await apiFetch('/api/songs?' + params.toString(), {
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
    const res = await apiFetch('/api/songs/changes?since=' + encodeURIComponent(S.libVer), {
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
  const AUTO = { since: 0, done: {}, queue: [], timer: 0, busy: false };
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
    return readyStemsSnapshot(song).fingerprint;
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
    if (S.starting || S.running || AUTO.busy || AUTO_STEMS.busy) {
      AUTO.timer = setTimeout(runAutoQueue, 3000);
      return;
    }
    const types = autoTypes();
    const songs = AUTO.queue.splice(0, AUTO.queue.length);
    for (const song of songs) AUTO.done[song.task_id] = { at: Date.now(), stems: stemsKeyOf(song) };
    saveAutoState();
    if (!types.length) return;
    emitPageEvent({ type: 'auto_download', task_ids: songs.map((s) => s.task_id), types });
    AUTO.busy = true;
    startJob(songs, { types, auto: true }).catch(() => {}).finally(() => {
      AUTO.busy = false;
      runAutoStemsQueue();
    });
  }

  const KEY_AUTO_STEMS = 'aceAutoStemsV1';
  const AUTO_STEMS = { loaded: false, observed: {}, pending: {}, queue: [], timer: 0, busy: false, recover: true, saving: Promise.resolve() };

  function readyStemsSnapshot(song) {
    const tracks = {};
    const objects = new Map();
    const groups = [];
    for (const mode of ['0', '2']) {
      const job = song && song.stems && song.stems[mode];
      if (!job || job.status !== 'done' || !Array.isArray(job.tracks)) continue;
      const revision = String(job.version || job.job_id || job.finished_at || job.started_at || '');
      const ready = job.tracks.filter((track) => track && track.id && !track.empty && track.local_audio);
      if (!ready.length) continue;
      const ids = [];
      for (const track of ready) {
        let source = '';
        try { source = new URL(track.local_audio, location.origin).pathname; } catch { continue; }
        const id = String(track.id);
        tracks[id] = [String(track.type || ''), source, revision].join('|');
        objects.set(id, track);
        ids.push(id);
      }
      groups.push(mode + ':' + ids.sort().join(','));
    }
    return { tracks, objects, fingerprint: groups.sort().join(';') + '|' + JSON.stringify(Object.entries(tracks).sort(([a], [b]) => a.localeCompare(b))) };
  }

  async function loadAutoStemsState() {
    const got = await storageGet([KEY_AUTO_STEMS]);
    const data = got[KEY_AUTO_STEMS] || {};
    AUTO_STEMS.observed = data.observed && typeof data.observed === 'object' ? data.observed : {};
    AUTO_STEMS.pending = data.pending && typeof data.pending === 'object' ? data.pending : {};
    AUTO_STEMS.loaded = true;
  }

  function saveAutoStemsState() {
    const observed = Object.fromEntries(Object.entries(AUTO_STEMS.observed).sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0)).slice(0, 3000));
    AUTO_STEMS.observed = observed;
    const snapshot = JSON.parse(JSON.stringify({ version: 1, observed, pending: AUTO_STEMS.pending }));
    AUTO_STEMS.saving = AUTO_STEMS.saving.then(() => storageSet({ [KEY_AUTO_STEMS]: snapshot })).catch(() => {});
    return AUTO_STEMS.saving;
  }

  function queueAutoStems(taskId) {
    if (!AUTO_STEMS.queue.includes(taskId)) AUTO_STEMS.queue.push(taskId);
  }

  function checkAutoStems() {
    if (!AUTO_STEMS.loaded || S.runtimeInvalidated) return;
    let changed = false;
    for (const song of S.songs) {
      if (!song?.task_id || !P.isDone(song)) continue;
      const id = song.task_id;
      const current = readyStemsSnapshot(song);
      const previous = AUTO_STEMS.observed[id];
      if (!previous || previous.fingerprint !== current.fingerprint) {
        // 第一次看見每個 task 只建立基線；以後的 ready track 變動才是自動下載事件。
        AUTO_STEMS.observed[id] = { fingerprint: current.fingerprint, tracks: current.tracks, at: Date.now() };
        changed = true;
        if (previous && S.options.autoStems) {
          const added = Object.keys(current.tracks).filter((trackId) => previous.tracks?.[trackId] !== current.tracks[trackId]);
          if (added.length) {
            const old = AUTO_STEMS.pending[id];
            const ids = [...new Set([...(old?.trackIds || []), ...added])].filter((trackId) => current.objects.has(trackId));
            AUTO_STEMS.pending[id] = { taskId: id, fingerprint: current.fingerprint, trackIds: ids, at: Date.now(), attempted: false };
            queueAutoStems(id);
          }
        }
      }
      if (AUTO_STEMS.recover && S.options.autoStems && AUTO_STEMS.pending[id]) queueAutoStems(id);
    }
    AUTO_STEMS.recover = false;
    if (!S.options.autoStems && Object.keys(AUTO_STEMS.pending).length) { AUTO_STEMS.pending = {}; changed = true; }
    if (changed) saveAutoStemsState();
    if (S.options.autoStems) runAutoStemsQueue();
  }

  function stemRecordedAfter(taskId, trackId, at) {
    const info = S.history[taskId]?.files?.['stem:' + trackId];
    // Chrome 的成功紀錄可能比下一輪 native 索引新，不能因舊索引漏檔而立刻重抓。
    return !!info && Number(info.at || 0) >= at && (Number(info.at) > S.fsAt || historyFileExists(info, taskId, 'stem:' + trackId));
  }

  async function runAutoStemsQueue() {
    clearTimeout(AUTO_STEMS.timer);
    if (!S.options.autoStems || S.runtimeInvalidated || !AUTO_STEMS.queue.length) return;
    if (AUTO_STEMS.busy || AUTO.busy || S.starting || S.running) {
      AUTO_STEMS.timer = setTimeout(runAutoStemsQueue, 1500);
      return;
    }
    const id = AUTO_STEMS.queue.shift();
    const pending = AUTO_STEMS.pending[id];
    const latest = S.songs.find((song) => song.task_id === id);
    if (!pending || !latest) { runAutoStemsQueue(); return; }
    const current = readyStemsSnapshot(latest);
    const tracks = pending.trackIds.filter((trackId) => current.objects.has(trackId) && !stemRecordedAfter(id, trackId, pending.at)).map((trackId) => current.objects.get(trackId));
    if (!tracks.length) {
      delete AUTO_STEMS.pending[id];
      saveAutoStemsState();
      runAutoStemsQueue();
      return;
    }
    const types = ['stems'];
    // 恢復不明結果的舊工作只補 GET 檔案，避免重啟後重複付費提交樂譜。
    if (!pending.attempted && S.options.autoNewScores && P.notationRequested(latest)) {
      for (const kind of ['midi', 'musicxml']) if (S.options[kind]) types.push(kind);
    }
    AUTO_STEMS.busy = true;
    AUTO_STEMS.pending[id] = { ...pending, attempted: true };
    try {
      await saveAutoStemsState();
      if (!S.options.autoStems || S.runtimeInvalidated) return;
      const selected = { ...latest, stems: { '2': { status: 'done', tracks } } };
      emitPageEvent({ type: 'auto_download', source: 'stems_ready', task_ids: [id], types });
      await startJob([selected], { types, auto: true, autoStems: true });
      const stillCurrent = AUTO_STEMS.pending[id]?.fingerprint === pending.fingerprint;
      if (stillCurrent && pending.trackIds.every((trackId) => stemRecordedAfter(id, trackId, pending.at))) delete AUTO_STEMS.pending[id];
    } catch (err) {
      DL.record('auto_stems_error', { taskId: id, errorCode: err?.code, error: err?.message || '自動補分軌未完成，保留待補' });
    } finally {
      AUTO_STEMS.busy = false;
      await saveAutoStemsState();
      runAutoQueue();
      runAutoStemsQueue();
    }
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
        const stemsKey = stemsKeyOf(song);
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
    checkAutoStems();
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
        if (S.host.ok || S.options.autoNew || S.options.autoStems) startLive();
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
      if (S.host.ok || S.options.autoNew || S.options.autoStems) startLive();
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
    if (P.notationRequested(song)) nodes.push(el('span', { class: 'badge', text: 'MIDI 可用' }));
    if (song.result && song.result.duration_sec) {
      const sec = Math.round(song.result.duration_sec);
      nodes.push(el('span', { class: 'badge dim', text: `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` }));
    }
    return nodes;
  }

  function visibleSongs() {
    return P.filterDownloadSongs(S.songs, {
      onlyUndownloaded: S.onlyUndownloaded,
      onlyFavorites: S.onlyFavorites,
      statusForSong: songDownloadStatus,
      isFavorite: isFav,
    });
  }

  function selectedVisibleSongs(list = visibleSongs()) {
    return P.selectedDownloadSongs(list, S.selected);
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
    const list = visibleSongs();
    S.selected = new Set(selectedVisibleSongs(list).map((song) => song.task_id));
    if (!list.length) {
      box.append(el('div', { class: 'hint', text: S.onlyFavorites ? '目前篩選沒有符合的收藏歌曲。' : S.onlyUndownloaded ? '目前沒有確定待補項目；待核對與本機核對未就緒的歌曲另列，不當作缺檔。' : '找不到已完成的歌曲。' }));
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
    const playBtn = el('button', { class: 'rowicon', type: 'button', 'data-play': '', title: '在播放器開啟', 'aria-label': '在播放器開啟' });
    playBtn.append(icon('play'));
    playBtn.addEventListener('click', () => openIndependentPlayer(song.task_id));
    cover.title = '在播放器開啟';
    cover.addEventListener('click', () => openIndependentPlayer(song.task_id));
    const favBtn = el('button', { class: 'rowicon', type: 'button', 'data-fav': '', 'aria-label': '收藏' });
    favBtn.append(icon('heart'));
    paintFav(favBtn, song.task_id);
    favBtn.addEventListener('click', () => toggleFavorite(song.task_id));
    return el('div', { class: 'song', 'data-song-id': song.task_id }, [checkbox, cover, body, playBtn, favBtn, perSong]);
  }

  function updateCounts() {
    const list = visibleSongs();
    const selected = selectedVisibleSongs(list);
    const label = S.els.countLabel;
    if (label) {
      const parts = [];
      if (S.songs.length) {
        const states = S.songs.map(songDownloadStatus);
        const pending = states.filter((status) => status.missingCount > 0).length;
        const uncertain = states.filter((status) => status.uncertainCount > 0 || (!status.known && status.total > 0)).length;
        parts.push(`已選 ${selected.length} / 顯示 ${list.length} / 共 ${S.songs.length} 首`);
        parts.push(`所選類型待補 ${pending}`);
        parts.push(`待核對 ${uncertain}`);
      }
      if (S.lastUpdated) parts.push(`更新 ${S.lastUpdated}`);
      label.textContent = parts.join(' · ');
    }
    const btn = S.els.downloadBtn;
    if (btn) {
      const count = selected.length;
      btn.textContent = S.runtimeInvalidated ? '請刷新 ACE 頁面' : S.running ? '下載中…' : S.starting ? '準備下載中…' : `下載選中${count ? `（${count} 首）` : ''}`;
      btn.disabled = S.runtimeInvalidated || !!S.starting || S.running || count === 0;
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
    let currentText = S.stopReason || p.current;
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
    updateSettingsSummary();
    storageSet({ [KEY_SETTINGS]: { options: { ...S.options }, rootFolder: S.rootFolder } });
  }

  function updateSettingsSummary() {
    const types = FILE_TYPES.filter((type) => S.options[type]);
    if (S.els.settingsSummary) {
      S.els.settingsSummary.textContent = `${types.length} 種類型 · 並行 ${S.options.concurrency} · ${S.rootFolder}`;
      S.els.settingsSummary.title = types.length ? types.map((type) => P.KIND_LABELS[type]).join('、') : '尚未選擇檔案類型';
    }
    if (S.els.settingsCost) S.els.settingsCost.hidden = !(S.options.midi || S.options.musicxml);
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
    updateSettingsSummary();
  }

  async function loadDownloadState() {
    const got = await storageGet([KEY_HISTORY, KEY_FOLDERS, KEY_UNAVAILABLE]);
    S.history = got[KEY_HISTORY] && typeof got[KEY_HISTORY] === 'object' ? got[KEY_HISTORY] : {};
    const localNa = got[KEY_UNAVAILABLE] && typeof got[KEY_UNAVAILABLE] === 'object' ? got[KEY_UNAVAILABLE] : {};
    S.unavailable = P.mergeUnavailable(localNa, S.agentUnavailable);
    const folders = got[KEY_FOLDERS] && typeof got[KEY_FOLDERS] === 'object' ? got[KEY_FOLDERS] : {};
    S.folderByTask = folders.folderByTask && typeof folders.folderByTask === 'object' ? folders.folderByTask : {};
    S.ownerByFolder = folders.ownerByFolder && typeof folders.ownerByFolder === 'object' ? folders.ownerByFolder : {};
    await refreshDoneKinds();
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

  /** 站點/API 與檔案 GET 共用入口；不從網頁逐首點擊，也不自動重送寫入請求。 */
  async function apiFetch(input, options = {}) {
    const target = new URL(input, location.origin);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('API 檔案來源格式不支援');
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') assertRuntimeUsable();
    const route = target.origin === location.origin ? target.pathname.replace(/\/api\/songs\/[^/]+\//, '/api/songs/:id/') : 'audio-file';
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutMs = Number(options.apiTimeoutMs) || 45000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const { apiTimeoutMs: _timeout, ...requestOptions } = options;
    try {
      const response = await fetch(target.href, { credentials: 'same-origin', ...requestOptions, signal });
      DL.record('api_response', { kind: method + ' ' + route, phase: 'api', elapsedMs: Date.now() - startedAt, ...(response.ok ? {} : { errorCode: 'HTTP_' + response.status }) });
      return response;
    } catch (err) {
      DL.record('api_error', { kind: method + ' ' + route, phase: 'api', elapsedMs: Date.now() - startedAt, errorCode: controller.signal.aborted ? 'API_TIMEOUT' : 'API_NETWORK_ERROR', error: (err && err.message) || err });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchDownloadApi(url, options = {}, job = S.activeJob) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TEST_MODE ? 10000 : 45000);
    const cancelled = setInterval(() => {
      if (job && (S.cancelled || !S.running || S.activeJob !== job || S.runtimeInvalidated)) controller.abort();
    }, 200);
    try {
      return await apiFetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      assertJobActive(job);
      if (timedOut) {
        const timeout = new Error('站點回應逾時（45 秒）；這個檔案保留待補，沒有重新提交生成');
        timeout.code = 'API_TIMEOUT';
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      clearInterval(cancelled);
    }
  }

  async function readDownloadJson(response, job = S.activeJob) {
    try {
      return await withConnectionTimeout(response.json(), TEST_MODE ? 10000 : 45000, job);
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      assertJobActive(job);
      const timeout = new Error('站點檔案回應未完成，這個檔案保留待補；沒有重新提交生成');
      timeout.code = 'API_TIMEOUT';
      throw timeout;
    }
  }

  /** 站點 API：MIDI / MusicXML 由站點生成後回傳 URL（生成期間由呼叫端顯示進度） */
  async function createApiFile(songId, kind, job) {
    const endpoint = `/api/songs/${encodeURIComponent(songId)}/download`;
    const deadline = Date.now() + 180000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // 即使只生成 MIDI，也先確認下載端仍可用，避免失效頁面繼續消耗額度。
      await checkDownloadConnection(job);
      const latest = S.songs.find((song) => song.task_id === songId);
      if (!latest || !P.notationRequested(latest) || (job.auto && !S.options.autoNewScores)) {
        const error = new Error('這個 task 已不在已請求分軌的樂譜範圍，未提交生成');
        error.code = 'NOTATION_NOT_REQUESTED';
        DL.record('notation_blocked', { taskId: songId, kind, errorCode: error.code });
        throw error;
      }
      DL.record('notation_submit', { taskId: songId, kind, phase: 'api' });
      let response = await fetchDownloadApi(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      while (response.status === 202) {
        assertJobActive(job);
        if (Date.now() > deadline) throw new Error(`${kind} 生成逾時`);
        await waitForJob(1500, job);
        await checkDownloadConnection(job);
        response = await fetchDownloadApi(`${endpoint}?kind=${encodeURIComponent(kind)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
      }
      const data = await readDownloadJson(response, job);
      assertJobActive(job);
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
          const waitKey = songId + '|' + kind;
          setJobWaitReason(job, waitKey, `${kind === 'full' || kind === 'midi' ? 'MIDI' : 'MusicXML'} 站點限流，等待 60 秒後重試`);
          try { await waitForJob(TEST_MODE ? 200 : 60000, job); }
          finally { setJobWaitReason(job, waitKey, ''); }
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
      response = await fetchDownloadApi(`${direct}&as=parts`, { credentials: 'same-origin', cache: 'no-store' });
    } catch (err) {
      if (isContextInvalidated(err) || (err && (err.code === 'JOB_CANCELLED' || err.code === 'API_TIMEOUT'))) throw err;
      throw new Error('無法取得檔案網址，請稍後補下載：' + ((err && err.message) || err));
    }
    if (!response.ok) {
      if (response.status === 402) throw new Error('目前方案不含此下載（HTTP 402）');
      if (response.status === 401) throw new Error('登入已過期，請重新整理頁面再試');
      if (response.status === 403) throw new Error('站點拒絕下載（HTTP 403）');
      // 已由模型能力篩掉 lossy 歌；400/404 不證明這首永遠沒有 WAV。
      if (kind === 'wav' && (response.status === 404 || response.status === 400)) {
        const err = new Error('站點暫時找不到此歌曲的 WAV（HTTP ' + response.status + '），保留待補');
        err.code = 'FILE_NOT_READY';
        throw err;
      }
      return direct;
    }
    const data = await readDownloadJson(response);
    if (!data || typeof data !== 'object') return direct;
    if (data.server) return direct;
    if (typeof data.audio === 'string' && data.audio) return new URL(data.audio, location.origin).href;
    if (typeof data.url === 'string' && data.url) return new URL(data.url, location.origin).href;
    return direct;
  }

  /* ------------------------------------------------------------------ *
   * 下載
   * ------------------------------------------------------------------ */
  async function attemptDownload(url, filename, timeoutMs = 200000, job = S.activeJob) {
    const conflictAction = job?.preserveFiles ? 'uniquify' : S.options.force ? 'overwrite' : 'uniquify';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        assertJobActive(job);
        const response = await withConnectionTimeout(
          sendMessage({
            type: 'ACE_DOWNLOAD_FILE',
            url,
            filename,
            conflictAction,
          }),
          timeoutMs,
          job,
        );
        if (response && typeof response.ok === 'boolean') return response;
        return { ok: false, error: 'service worker 無回應' };
      } catch (err) {
        if (isContextInvalidated(err) || (err && err.code === 'JOB_CANCELLED')) throw err;
        if (attempt === 0) {
          await waitForJob(400, job);
          continue;
        }
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    return { ok: false, error: 'service worker 無回應' };
  }

  /** 備援：由頁面（帶 Cookie）把檔案抓成 blob URL，再交給 service worker 下載 */
  async function fetchAsBlobUrl(url) {
    const response = await apiFetch(url, { credentials: 'include', cache: 'no-store', apiTimeoutMs: 180000 });
    if (!response.ok) throw new Error('備援抓檔失敗 HTTP ' + response.status);
    const blob = await response.blob();
    if (!blob.size) throw new Error('備援抓檔為空');
    return URL.createObjectURL(blob);
  }

  /** 站點模型資訊（/api/status）：哪些模型只有 lossy 音檔（沒有 WAV）。每頁載入問一次，失敗用 planner 後備規則 */
  let siteModelsPromise = null;
  function ensureSiteModels() {
    if (!siteModelsPromise) {
      siteModelsPromise = apiFetch('/api/status', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const models = data && Array.isArray(data.models) ? data.models : [];
          if (models.length) {
            S.lossyModels = new Set(models.filter((m) => m && m.lossy).map((m) => m.id));
            // 模型清單（名稱、各欄位字數上限…）：隨機提示詞用它區分模型、決定欄位上限
            S.siteModels = new Map(models.filter((m) => m && m.id).map((m) => [m.id, { name: m.name, limits: m.limits, reads: !!m.reads, free: !!m.free, lossy: !!m.lossy, hidden: !!m.hidden }]));
            renderRandom();
          }
        })
        .catch(() => {
          siteModelsPromise = null; // 下次再試
        });
    }
    return siteModelsPromise;
  }

  async function startJob(songs, jobOpts = {}) {
    // 同步取得頁面寫入租約：preflight / storage / native 的首個 await 之前即拒絕重入。
    if (S.starting || S.running) {
      flash('已有下載進行中');
      return;
    }
    const lease = {};
    S.starting = lease;
    updateCounts();
    try {
      return await startOwnedJob(songs, jobOpts, lease);
    } finally {
      if (S.activeJob?.lease === lease && !S.running) S.activeJob = null;
      if (S.starting === lease) {
        S.starting = null;
        updateCounts();
      }
    }
  }

  async function startOwnedJob(songs, jobOpts, lease) {
    const types = jobOpts.types || FILE_TYPES.filter((type) => S.options[type]);
    DL.record('job_start', { kind: types.join(','), counts: { songs: songs.length } });
    S.jobAuto = !!jobOpts.auto;
    if (!types.length) {
      flash('請至少勾選一種檔案類型');
      return;
    }
    try {
      await checkDownloadConnection();
    } catch (err) {
      S.stopReason = isContextInvalidated(err) ? CONTEXT_INVALIDATED_MESSAGE : String((err && err.message) || err);
      DL.record('preflight_fail', diagnosticProgress({ errorCode: err && err.code, error: S.stopReason }));
      S.progress = { done: 0, skipped: 0, failed: 0, total: 0, current: '', phase: 'cancelled', activeDl: 0, activePrep: 0, elapsedMs: 0 };
      renderProgress();
      flash(S.stopReason);
      return;
    }
    S.stopReason = '';
    await Promise.all([loadDownloadState(), ensureSiteModels()]);
    if (!S.options.force || jobOpts.autoStems) await refreshDownloadIndex(true).catch(() => {});
    const plan = P.buildDownloadPlan({
      songs,
      options: {
        types,
        root: S.rootFolder,
        typeFolders: S.options.typeFolders,
        force: jobOpts.autoStems ? false : S.options.force,
        origin: location.origin,
        lossyModels: S.lossyModels,
      },
      state: { folderByTask: S.folderByTask, ownerByFolder: S.ownerByFolder, history: existingDownloadHistory(), unavailable: S.unavailable },
      origin: location.origin,
    });
    S.folderByTask = plan.folderByTask;
    S.ownerByFolder = plan.ownerByFolder;
    await saveFolders();
    if (jobOpts.autoStems) {
      // 這些是新增 track ID／新來源版本，舊同名檔或舊 history 不能代替它們。
      for (const task of plan.tasks) {
        for (const file of task.files) {
          if (file.kind !== 'stems' || !file.skip) continue;
          file.skip = false;
          plan.skipped = Math.max(0, plan.skipped - 1);
          plan.toDownload += 1;
        }
      }
    }

    // 用實際檔案系統再跳過一次，避免重新下載之前（擴充功能／CLI／站點）已經抓過的檔案
    if (!S.options.force || jobOpts.autoStems) {
      let fsSkipped = 0;
      for (const task of plan.tasks) {
        for (const file of task.files) {
          if (file.skip) continue;
          if (jobOpts.autoStems && file.kind === 'stems') continue;
          const skip = completedKeysForTask(task.task_id).has(file.key);
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
      DL.record('job_done', { phase: 'done', counts: { done: 0, skipped: plan.skipped, total: plan.total } });
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

    if (S.runtimeInvalidated) return;
    // 每批有獨立身分；停止後仍在返回的網路請求不能加入下一批。
    const job = { auto: !!jobOpts.auto, preserveFiles: !!jobOpts.autoStems, lease };
    S.activeJob = job;
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
          if (S.cancelled || !S.running || job !== S.activeJob) return;
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
          DL.record('prep_start', diagnosticProgress({ taskId: entry.task.task_id, kind: entry.file.kind, filename: entry.file.filename }));
          renderProgressSoon();
          try {
            // 站點對 MIDI 生成有速率限制：MIDI 間隔 2.5 秒、MusicXML 0.6 秒
            if (entry.file.source === 'api') await waitForJob(entry.file.apiKind === 'full' || entry.file.apiKind === 'midi' ? 2500 : 600, job);
            assertJobActive(job);
            const planned = String(entry.file.sourceUrl || '');
            // MP3 若 planner 已給 local_audio（上傳型歌曲）就直接用，不要再問 /file?kind=mp3（會回 JSON）
            const genericFileUrl = !planned || /\/api\/songs\/[^/]+\/file\?kind=(mp3|wav)\b/i.test(planned);
            entry.url =
              entry.file.source === 'api'
                ? await createApiFile(entry.task.task_id, entry.file.apiKind, job)
                : genericFileUrl
                  ? await resolveFileUrl(entry.task.task_id, entry.file.kind)
                  : planned;
          } catch (err) {
            DL.record('prep_error', diagnosticProgress({ taskId: entry.task.task_id, kind: entry.file.kind, filename: entry.file.filename, errorCode: err && err.code, error: (err && err.message) || err }));
            if (isContextInvalidated(err) || (err && err.code === 'JOB_CANCELLED')) return;
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
              continue;
            }
            if (err && (err.code === 'WAV_UNSUPPORTED' || err.code === 'NOT_AVAILABLE' || err.code === 'NOTATION_NOT_REQUESTED')) {
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
            if (job === S.activeJob) {
              S.progress.activePrep = S.running ? countActivePrep() : 0;
              if (S.running) {
                renderProgressSoon();
                sendBadge(progressPercent() + '%');
              }
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, () => prepWorker()));
      };
      await Promise.all([runQueue(fileEntries, 3), runQueue(genEntries, 1)]);
    })();
    prepPromise.catch(() => {});

    let dlCursor = 0;
    const downloadWorker = async () => {
      while (true) {
        if (S.cancelled || job !== S.activeJob) return;
        const index = dlCursor++;
        if (index >= entries.length) return;
        const entry = entries[index];
        const { task, file } = entry;
        if (S.cancelled) return;
        activeNames.add(file.filename);
        S.progress.activeDl = activeNames.size;
        S.progress.current = `${task.folder}／${file.filename}`;
        S.progress.currentKind = file.kind;
        S.progress.currentTitle = task.folder;
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
          assertJobActive(job);
          DL.record('download_start', diagnosticProgress({ taskId: task.task_id, kind: file.kind, filename: file.filename }));
          let result = await attemptDownload(url, file.path, 200000, job);
          if (!result.ok && S.cancelled) return;
          if (!result.ok) {
            assertJobActive(job);
            const firstError = result.error || '下載失敗';
            let blobUrl = '';
            try {
              blobUrl = await fetchAsBlobUrl(url);
            } catch (fallbackError) {
              throw new Error(`${firstError}；備援抓檔失敗：${(fallbackError && fallbackError.message) || fallbackError}`);
            }
            try {
              assertJobActive(job);
              result = await attemptDownload(blobUrl, file.path, 200000, job);
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
          if (result.mismatch && !job.preserveFiles && S.options.autoFix && S.host.ok && S.host.downloadsRoot && result.actualPath) {
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
          noteOwnDownload(task.task_id, file);
          S.progress.done = done;
          saveHistorySoon();
        } catch (err) {
          DL.record('download_error', diagnosticProgress({ taskId: task.task_id, kind: file.kind, filename: file.filename, errorCode: err && err.code, error: (err && err.message) || (err && err.error && err.error.message) || err }));
          if (isContextInvalidated(err) || (err && err.code === 'JOB_CANCELLED')) return;
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
      if (S.activeJob !== job || S.starting !== lease) return;
      clearTimeout(S.renderTimer);
      S.renderTimer = 0;
      if (!S.cancelled) await prepPromise;
      if (S.activeJob !== job || S.starting !== lease) return;
      S.running = false;
      S.progress.phase = S.cancelled ? 'cancelled' : 'done';
      S.progress.current = '';
      S.progress.activeDl = 0;
      S.progress.activePrep = 0;
      S.progress.elapsedMs = Date.now() - S.jobStartedAt;
      DL.record('job_finalizing', diagnosticProgress());
      await flushHistory();
      if (S.activeJob !== job || S.starting !== lease) return;
      DL.record('job_done', diagnosticProgress());
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
      if (S.stopReason) flash(S.stopReason);
      else if (S.cancelled) flash(`已停止（已完成的檔案保留，花了 ${secs} 秒）`);
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
      return Promise.all([loadDownloadState(), loadAutoState(), loadAutoStemsState(), loadRadio(), loadRandomPrefs(), ensureSiteModels()]);
    })
    .then(() => refreshHostStatus())
    .then(() => {
      // 有本機中樞或開了新歌自動下載：面板沒打開也要在背景同步歌單（給 agent／自動下載用）
      checkAutoStems();
      if (S.options.autoNew) enableAutoNew();
      if (S.host.ok || S.options.autoNew || S.options.autoStems) {
        startLive();
        if (!S.loaded) refreshSongsQuiet();
      }
      return refreshDownloadIndex(true);
    })
    .then(() => {
      if (S.songs.length) renderSongs();
    })
    .catch(() => {})
    .finally(startLocalStateSync);
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'ACE_LOCAL_FILES_CHANGED' || !Number.isFinite(message.at)) return;
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    scheduleLocalStateSync();
  });
  window.addEventListener('pagehide', stopLocalStateSync, { once: true });
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






