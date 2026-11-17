// background.js — service worker（classic script）。
// 只做三件事：執行 chrome.downloads.download、等待下載完成並回報、更新 badge。
// 所有歌單抓取、命名、排程與進度計算都在 content script（content.js）完成，
// 這樣即使 service worker 被 Chrome 回收，也不會中斷整個批次工作。
'use strict';
importScripts('diagnostics.js', 'music-hub.js');

const DOWNLOAD_TIMEOUT_MS = 180000;
const pending = new Map(); // downloadId -> { done, filename }
let lastCompletedId = null;

// 命名爐改完檔名後通知所有分頁重新整理本機索引；沒有任何分頁在線時安靜略過。
async function broadcastToAceTabs(message) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return 0; }
  let sent = 0;
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      sent += 1;
    } catch { /* 沒有 content script 的分頁（chrome://、商店…）會丟錯，忽略 */ }
  }
  return sent;
}

// 送出下載前先登記「URL → 想要的相對路徑」，onDeterminingFilename 觸發時用它覆寫檔名。
// 這是 Chrome 擴充功能裡唯一保證能蓋過伺服器 Content-Disposition / URL 檔名的機制。
const namedQueue = new Map(); // url -> [{ filename, conflictAction }]
const namedById = new Map();
const filenameWaiters = new Map();
const FILENAME_WAIT_MS = 30000;

function queueName(url, filename, conflictAction) {
  const key = String(url || '');
  const list = namedQueue.get(key) || [];
  const entry = { filename, conflictAction, downloadId: null };
  list.push(entry);
  namedQueue.set(key, list);
  return entry;
}

function dropName(url, entry) {
  const key = String(url || '');
  const list = namedQueue.get(key);
  if (!list || !list.length) return;
  const index = list.indexOf(entry);
  if (index !== -1) list.splice(index, 1);
  if (!list.length) namedQueue.delete(key);
  if (entry && entry.downloadId != null && namedById.get(entry.downloadId) === entry) namedById.delete(entry.downloadId);
}

function resolveFilename(downloadId, entry, suggest) {
  if (entry) {
    namedById.delete(downloadId);
    // Entry identity is stable even when multiple songs share exactly the same URL.
    dropName(entry.url, entry);
    suggest({ filename: entry.filename, conflictAction: entry.conflictAction });
  } else suggest();
}

function releaseFilenameWaiter(downloadId, entry) {
  const waiter = filenameWaiters.get(downloadId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  filenameWaiters.delete(downloadId);
  resolveFilename(downloadId, entry, waiter.suggest);
}

function bindName(downloadId, entry) {
  entry.downloadId = downloadId;
  namedById.set(downloadId, entry);
  releaseFilenameWaiter(downloadId, entry);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const entry = namedById.get(item.id);
  if (entry) { resolveFilename(item.id, entry, suggest); return false; }
  if (!namedQueue.has(item.url) && !namedQueue.has(item.finalUrl)) { suggest(); return false; }
  // This event may precede downloads.download's callback. Wait for that exact ID;
  // URL ordering cannot identify a request when twins share an audio/cover URL.
  const timer = setTimeout(() => releaseFilenameWaiter(item.id, null), FILENAME_WAIT_MS);
  filenameWaiters.set(item.id, { suggest, timer });
  return true;
});

function respondLater(fn, sendResponse) {
  Promise.resolve()
    .then(fn)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
}

function startDownload(msg) {
  return new Promise((resolve) => {
    const url = String(msg.url || '');
    if (!/^(https?:|data:|blob:)/i.test(url)) {
      resolve({ ok: false, error: '不支援的 URL 類型' });
      return;
    }
    let filename = String(msg.filename || '').trim();
    if (!filename || filename.startsWith('/') || /^[a-zA-Z]:/.test(filename) || filename.includes('\\') || filename.split('/').some((part) => part === '.' || part === '..' || part === '')) {
      resolve({ ok: false, error: '檔名不合法' });
      return;
    }
    const conflictAction = msg.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify';

    let settled = false;
    let id = null;
    let nameEntry = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (id != null) pending.delete(id);
      if (nameEntry) dropName(url, nameEntry);
      if (id != null) releaseFilenameWaiter(id, null);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      if (id != null) {
        try {
          chrome.downloads.cancel(id);
        } catch (_) {
          /* ignore */
        }
      }
      finish({ ok: false, error: '下載逾時（' + Math.round(DOWNLOAD_TIMEOUT_MS / 1000) + ' 秒）' });
    }, DOWNLOAD_TIMEOUT_MS);

    nameEntry = queueName(url, filename, conflictAction);
    nameEntry.url = url;
    try {
      chrome.downloads.download({ url, filename, conflictAction, saveAs: false }, (downloadId) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || downloadId == null || downloadId < 0) {
          dropName(url, nameEntry);
          finish({ ok: false, error: lastError ? lastError.message : '無法開始下載' });
          return;
        }
        if (settled) {
          releaseFilenameWaiter(downloadId, null);
          try { chrome.downloads.cancel(downloadId); } catch (_) { /* timed-out request must not revive */ }
          return;
        }
        id = downloadId;
        pending.set(id, { done: finish, filename });
        bindName(id, nameEntry);
      });
    } catch (err) {
      finish({ ok: false, error: String((err && err.message) || err) });
    }
  });
}

let localFilesChangedTimer = 0;
let historyExportPromise = null;
let lastIndexHistoryExport = 0;
let lastBrowserStateContent = '';
function exportHistoryForIndex() {
  if (historyExportPromise) return historyExportPromise;
  if (Date.now() - lastIndexHistoryExport < 1000) return Promise.resolve();
  historyExportPromise = (async () => {
    await exportHistoryToHost();
    const stored = await chrome.storage.local.get('aceHistory');
    const content = JSON.stringify(stored.aceHistory || {});
    if (stored.aceHistory && typeof stored.aceHistory === 'object' && content !== lastBrowserStateContent) {
      await hostRequest({ cmd: 'export', name: 'browser-download-state', data: { savedAt: Date.now(), history: stored.aceHistory } }, 15000);
      lastBrowserStateContent = content;
    }
    lastIndexHistoryExport = Date.now();
  })().finally(() => { historyExportPromise = null; });
  return historyExportPromise;
}
function notifyLocalFilesChanged() {
  clearTimeout(localFilesChangedTimer);
  localFilesChangedTimer = setTimeout(async () => {
    localFilesChangedTimer = 0;
    await exportHistoryForIndex().catch(() => {});
    chrome.tabs.query({ url: ['https://acemusic.ai/*', 'https://www.acemusic.ai/*'] }, (tabs) => {
      if (chrome.runtime.lastError) return;
      const message = { type: 'ACE_LOCAL_FILES_CHANGED', at: Date.now() };
      for (const tab of tabs || []) {
        if (tab.id == null) continue;
        chrome.tabs.sendMessage(tab.id, message, () => { void chrome.runtime.lastError; });
      }
    });
  }, 200);
}

chrome.downloads.onChanged.addListener((delta) => {
  const item = pending.get(delta.id);
  if (!item) return;
  const state = delta.state && delta.state.current;
  if (state === 'complete') {
    lastCompletedId = delta.id;
    chrome.downloads.search({ id: delta.id }, (results) => {
      const record = Array.isArray(results) && results[0] ? results[0] : null;
      const actual = (record && record.filename) || '';
      const wanted = item.filename.split('/').join('\\');
      const mismatch = actual ? !actual.toLowerCase().endsWith('\\' + wanted.toLowerCase()) : false;
      item.done({
        ok: true,
        absolute: actual,
        bytes: (record && record.fileSize) || 0,
        mismatch,
        actualPath: actual,
        desiredPath: item.filename,
      });
      notifyLocalFilesChanged();
    });
  } else if (state === 'interrupted') {
    item.done({ ok: false, error: (delta.error && delta.error.current) || '下載中斷' });
  } else if (delta.error && delta.error.current) {
    item.done({ ok: false, error: delta.error.current });
  }
});


/* ------------------------------------------------------------------ *
 * Native messaging：本機整理工具（檔案移動/改名）與 Agent 狀態匯出
 * ------------------------------------------------------------------ */
const HOST_NAME = 'com.acemusic.batchdownloader';
let nativePort = null;
let nativeSeq = 0;
const nativePending = new Map();

function getNativePort() {
    if (nativePort) return nativePort;
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    nativePort.onMessage.addListener((message) => {
        const entry = message && message.reqId != null ? nativePending.get(message.reqId) : null;
        if (entry) {
            nativePending.delete(message.reqId);
            clearTimeout(entry.timer);
            entry.resolve(message);
        }
    });
    nativePort.onDisconnect.addListener(() => {
        const lastError = chrome.runtime.lastError;
        const message = lastError ? lastError.message : '本機工具連線中斷';
        for (const [, entry] of nativePending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(message));
        }
        nativePending.clear();
        nativePort = null;
    });
    return nativePort;
}

function hostRequest(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let port;
        try {
            port = getNativePort();
        } catch (err) {
            reject(new Error('本機工具未安裝或無法啟動：' + err.message));
            return;
        }
        const reqId = ++nativeSeq;
        const timer = setTimeout(() => {
            nativePending.delete(reqId);
            reject(new Error('本機工具逾時'));
        }, timeoutMs);
        nativePending.set(reqId, { resolve, reject, timer });
        try {
            port.postMessage({ reqId, ...payload });
        } catch (err) {
            clearTimeout(timer);
            nativePending.delete(reqId);
            reject(err);
        }
    });
}

const PAGE_EXPORT_NAMES = new Set(['page-songs', 'page-unavailable', 'page-events', 'page-favorites']);

async function exportSessionToHost() {
    const cookies = await chrome.cookies.getAll({ domain: 'acemusic.ai' });
    if (!cookies || !cookies.length) throw new Error('找不到 acemusic.ai 的 Cookie（請先登入）');
    const cookie = cookies.map((item) => item.name + '=' + item.value).join('; ');
    const now = Date.now();
    return hostRequest({
        cmd: 'export',
        name: 'session',
        data: {
            cookie,
            savedAt: now,
            ua: navigator.userAgent,
            cookieNames: cookies.map((item) => item.name),
            expiresAt: cookies.map((item) => item.expirationDate || null),
        },
    });
}

let lastHistoryContent = '';
async function exportHistoryToHost() {
    const items = await new Promise((resolve) => chrome.downloads.search({ limit: 2000, orderBy: ['-startTime'] }, resolve));
    // Chrome 下載紀錄被清空（或搜尋暫時回空）時不要覆寫：否則本機 history.json 會被洗成 0 筆（曾發生）
    if (!items || !items.length) return { ok: true, skipped: 'empty-history' };
    const dataItems = items.map((item) => ({ id: item.id, filename: item.filename, url: item.url, finalUrl: item.finalUrl,
      state: item.state, mime: item.mime, fileSize: item.fileSize, startTime: item.startTime, byExtId: item.byExtensionId || '' }));
    const content = JSON.stringify(dataItems);
    if (content === lastHistoryContent) return { ok: true, skipped: 'unchanged-history' };
    const result = await hostRequest({ cmd: 'export', name: 'history', data: { savedAt: Date.now(), items: dataItems } });
    lastHistoryContent = content;
    return result;
}

async function exportAgentState() {
    const result = { ok: false };
    try {
        const session = await exportSessionToHost();
        result.session = session;
        result.ok = true;
    } catch (err) {
        result.sessionError = String((err && err.message) || err);
    }
    try {
        const history = await exportHistoryToHost();
        result.history = history;
        result.ok = true;
    } catch (err) {
        result.historyError = String((err && err.message) || err);
    }
    result.exportedAt = Date.now();
    if (result.ok) {
        try {
            await chrome.storage.local.set({ aceAgentExportAt: result.exportedAt });
        } catch (_) {
            /* ignore */
        }
    }
    return result;
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: String(text || '').slice(0, 6) });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {
    /* ignore */
  }
}

// Native index codec: accept the original compact shape and bounded gzip envelopes.
async function decodeNativeIndexPayload(value) {
  let index = value;
  if (value?.encoding) {
    if (value.ok !== true || value.encoding !== 'gzip-base64' || typeof value.data !== 'string' || value.data.length > 900 * 1024 || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('本機索引壓縮格式不正確或超過傳輸上限');
    let reader;
    try {
      const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0));
      reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > 32 * 1024 * 1024) throw new Error('本機索引解壓大小超過上限');
        chunks.push(chunk);
      }
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
    } catch (err) {
      if (err.message === '本機索引解壓大小超過上限') throw err;
      throw new Error('本機索引解壓或 JSON 解析失敗，請更新本機工具後重試');
    } finally { if (reader) await reader.cancel().catch(() => {}); }
  }
  if (!index?.ok || index.apiVersion !== 1 || typeof index.revision !== 'string' || !index.byTask || typeof index.byTask !== 'object' || Array.isArray(index.byTask)) throw new Error('本機索引版本或資料格式不正確，請更新本機工具');
  for (const row of Object.values(index.byTask)) {
    if (!row || typeof row !== 'object' || !row.downloaded || typeof row.downloaded !== 'object' || Array.isArray(row.downloaded) || !Array.isArray(row.completedKeys) || row.completedKeys.some((key) => typeof key !== 'string') || !Array.isArray(row.uncertainKinds) || row.uncertainKinds.some((kind) => typeof kind !== 'string')) throw new Error('本機索引歌曲資料格式不正確，請更新本機工具');
  }
  return index;
}
// End native index codec.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (['ACE_MUSIC_HUB_GET_CONFIG', 'ACE_MUSIC_HUB_CONFIG', 'ACE_MUSIC_HUB_STATUS', 'ACE_MUSIC_HUB_OPEN', 'ACE_MUSIC_HUB_PROMPT'].includes(msg && msg.type)) {
    return respondLater(async () => await AceMusicHub.create({ chromeApi: chrome, fetchImpl: fetch }).dispatch(msg), sendResponse);
  }
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'ACE_HOST_LOCAL_INDEX':
      return respondLater(async () => {
        await exportHistoryForIndex().catch(() => {});
        const result = await hostRequest({ cmd: 'local-index', root: String(msg.root || 'ai音樂') }, 120000);
        if (!result.ok || result.exitCode !== 0 || !result.data?.ok) return { ok: false, error: result.error || result.data?.error || '本機索引未就緒，請更新本機工具' };
        return { ok: true, index: await decodeNativeIndexPayload(result.data) };
      }, sendResponse);
    case 'ACE_OPEN_NAMING':
      return respondLater(async () => {
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('naming/index.html') });
        return { ok: true, tabId: tab.id };
      }, sendResponse);
    case 'ACE_NAMING_APPLIED':
      return respondLater(async () => {
        // 命名爐套用改名後：重建本機索引（journal 已記錄搬移鏈），再叫面板重畫。
        let rebuilt = false;
        try {
          const result = await hostRequest({ cmd: 'local-index', root: String(msg.root || 'ai音樂') }, 120000);
          rebuilt = !!(result && result.ok && result.data && result.data.ok);
        } catch { /* 索引重建失敗仍要通知面板，讓它自己重試 */ }
        const tabs = await broadcastToAceTabs({ type: 'ACE_LIBRARY_CHANGED', at: Date.now() });
        return { ok: rebuilt, rebuilt, tabs, renamed: Number(msg.renamed) || 0 };
      }, sendResponse);
    case 'ACE_HOST_STRIP_FINGERPRINTS':
      return respondLater(async () => {
        const result = await hostRequest({ cmd: 'strip-fingerprints' }, 180000);
        if (!result || !result.ok || result.exitCode !== 0) return { ok: false, error: (result && result.error) || '本機工具沒有回應' };
        return { ok: true, data: result.data };
      }, sendResponse);
    // 重新命名這批（背景）：CLI named-copy，只回摘要
    case 'ACE_HOST_NAMED_COPY':
      return respondLater(async () => {
        const result = await hostRequest({ cmd: 'named-copy' }, 600000);
        if (!result || !result.ok || result.exitCode !== 0) return { ok: false, error: (result && result.error) || (result && result.stderr) || '本機工具沒有回應' };
        return { ok: true, data: result.data, stderr: result.stderr };
      }, sendResponse);
    // 讀最近幾輪整理摘要（人看得懂的 Markdown）
    case 'ACE_HOST_ACTIVITY':
      return respondLater(async () => {
        const result = await hostRequest({ cmd: 'activity' }, 60000);
        if (!result || !result.ok || result.exitCode !== 0) return { ok: false, error: (result && result.error) || '本機工具沒有回應' };
        return { ok: true, data: result.data };
      }, sendResponse);
    // 用預設程式打開摘要檔（只允許 .md／.json／.txt，且必須在曲庫或 Downloads 內）
    case 'ACE_HOST_OPEN_FILE':
      return respondLater(async () => {
        const result = await hostRequest({ cmd: 'open-file', path: String(msg.path || '') }, 20000);
        if (!result || !result.ok) return { ok: false, error: (result && result.error) || '本機工具沒有回應' };
        return { ok: true, data: result.data };
      }, sendResponse);
    case 'ACE_OPEN_PLAYER':
      return respondLater(async () => {
        const songId = typeof msg.songId === 'string' && msg.songId.length <= 256 ? msg.songId : '';
        const result = await hostRequest({ cmd: 'player-start', songId }, 30000);
        const data = result.data;
        if (!result.ok || result.exitCode !== 0 || !data?.ok || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(data.url || '')) throw new Error(result.error || data?.error || '播放器尚未就緒，請更新完整套件');
        const windowStore = chrome.storage.session;
        const existingId = windowStore ? (await windowStore.get('acePlayerWindow')).acePlayerWindow : null;
        if (existingId) {
          try { await chrome.windows.update(existingId, { focused: true }); return { ok: true, windowId: existingId }; } catch (_) { /* Closed windows are recreated. */ }
        }
        const url = new URL(data.url);
        if (songId) url.searchParams.set('song', songId);
        const window = await chrome.windows.create({ url: url.href, type: 'popup', width: 1100, height: 780, focused: true });
        if (windowStore) await windowStore.set({ acePlayerWindow: window.id });
        return { ok: true, windowId: window.id };
      }, sendResponse);
    case 'ACE_DOWNLOAD_FILE':
      return respondLater(() => startDownload(msg), sendResponse);
    case 'ACE_CANCEL_DOWNLOAD':
      // 並行下載時要取消所有進行中的下載
      for (const downloadId of Array.from(pending.keys())) {
        try {
          chrome.downloads.cancel(downloadId);
        } catch (_) {
          /* ignore */
        }
      }
      sendResponse({ ok: true });
      return false;
    case 'ACE_BADGE':
      setBadge(msg.text || '', msg.color);
      sendResponse({ ok: true });
      return false;
    case 'ACE_HOST_PING':
      return respondLater(() => hostRequest({ cmd: 'ping' }, 8000), sendResponse);
    case 'ACE_HOST_MOVE':
      return respondLater(() => hostRequest({ cmd: 'move', moves: msg.moves || [] }, 90000), sendResponse);
    case 'ACE_HOST_LIST':
      return respondLater(() => hostRequest({ cmd: 'list', maxDepth: msg.maxDepth || 2, extensions: msg.extensions || [], limit: msg.limit || 5000 }, 30000), sendResponse);
    case 'ACE_HOST_READ':
      return respondLater(() => hostRequest({ cmd: 'read', name: msg.name }, 15000), sendResponse);
    case 'ACE_HOST_ORGANIZE':
      return respondLater(() => hostRequest({ cmd: 'organize', commit: !!msg.commit }, 200000), sendResponse);
    case 'ACE_HOST_TIDY':
      return respondLater(() => hostRequest({ cmd: 'tidy' }, 30000), sendResponse);
    case 'ACE_HOST_DEDUPE_CUSTOM':
      return respondLater(() => hostRequest({ cmd: 'dedupe-custom' }, 130000), sendResponse);
    case 'ACE_HOST_EXTRACT_MP3':
      return respondLater(() => hostRequest({ cmd: 'extract-mp3' }, 30000), sendResponse);
    case 'ACE_HOST_WATCH':
      return respondLater(() => hostRequest({ cmd: 'watch' }, 30000), sendResponse);
    case 'ACE_HOST_OPEN_FOLDER':
      return respondLater(() => hostRequest({ cmd: 'open', folder: msg.folder || '' }, 15000), sendResponse);
    case 'ACE_EXPORT_AGENT':
      return respondLater(() => exportAgentState(), sendResponse);
    case 'ACE_HOST_EXPORT_PAGE':
      // 頁面 → agent 的快速通道：只允許頁面快照檔名，不能覆寫 session／history／agent-state
      if (!PAGE_EXPORT_NAMES.has(msg.name)) {
        sendResponse({ ok: false, error: 'invalid export name' });
        return false;
      }
      return respondLater(() => hostRequest({ cmd: 'export', name: msg.name, data: msg.data || {} }, 15000), sendResponse);
    case 'ACE_SAVE_DIAGNOSTICS': {
      // Fixed destination, strict field allowlist, and no account/session data.
      if (!msg.data || !Array.isArray(msg.data.events) || msg.data.events.length > 200 || JSON.stringify(msg.data).length > 262144) {
        sendResponse({ ok: false, error: 'invalid diagnostics snapshot' });
        return false;
      }
      const snapshot = globalThis.AceDLDiagnostics.sanitizeSnapshot(msg.data);
      return respondLater(() => hostRequest({ cmd: 'export', name: 'download-log', data: snapshot }, 15000), sendResponse);
    }
    case 'ACE_AGENT_STATUS':
      return respondLater(async () => {
        const stored = await chrome.storage.local.get(['aceAgentExportAt']);
        let host = { ok: false };
        try {
          host = await hostRequest({ cmd: 'ping' }, 8000);
        } catch (err) {
          host = { ok: false, error: String((err && err.message) || err) };
        }
        return { ok: true, host, exportedAt: stored.aceAgentExportAt || null };
      }, sendResponse);
    case 'ACE_SHOW_FOLDER':
      try {
        if (lastCompletedId != null) chrome.downloads.show(lastCompletedId);
        else chrome.downloads.showDefaultFolder();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return false;
    case 'ACE_PING':
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    default:
      return false;
  }
});

async function exportAgentQuiet() {
    try {
        const result = await exportAgentState();
        if (result.ok) console.info('[ACE 批量下載] 已同步 Agent 登入狀態');
    } catch (err) {
        /* 本機工具未安裝或未登入：安靜略過 */
    }
}

chrome.runtime.onInstalled.addListener(() => {
    setBadge('');
    try {
        chrome.alarms.create('ace-agent-export', { periodInMinutes: 30, delayInMinutes: 1 });
    } catch (_) {
        /* ignore */
    }
    exportAgentQuiet();
});

chrome.runtime.onStartup.addListener(() => {
    try {
        chrome.alarms.create('ace-agent-export', { periodInMinutes: 30, delayInMinutes: 1 });
    } catch (_) {
        /* ignore */
    }
    exportAgentQuiet();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'ace-agent-export') exportAgentQuiet();
});

// 站點輪換登入 Cookie 時立刻重新匯出給 agent（否則 agent 手上的 Cookie 會過期，要等 30 分鐘的 alarm）。
// 只匯出 session（不重掃下載紀錄）；2 秒 debounce，同一批 Cookie 變動只寫一次。
let cookieExportTimer = 0;
try {
    chrome.cookies.onChanged.addListener((info) => {
        const domain = String((info && info.cookie && info.cookie.domain) || '').replace(/^\./, '');
        if (domain !== 'acemusic.ai' && !domain.endsWith('.acemusic.ai')) return;
        if (info.removed && info.cause === 'overwrite') return; // 覆寫會再觸發一次「新增」，等那次
        clearTimeout(cookieExportTimer);
        cookieExportTimer = setTimeout(() => {
            exportSessionToHost()
                .then(() => chrome.storage.local.set({ aceAgentExportAt: Date.now() }))
                .catch(() => {
                    /* 本機工具未安裝或已登出：安靜略過 */
                });
        }, 2000);
    });
} catch (_) {
    /* 沒有 cookies 權限的環境（測試） */
}
