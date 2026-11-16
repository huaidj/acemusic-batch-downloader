// background.js — service worker（classic script）。
// 只做三件事：執行 chrome.downloads.download、等待下載完成並回報、更新 badge。
// 所有歌單抓取、命名、排程與進度計算都在 content script（content.js）完成，
// 這樣即使 service worker 被 Chrome 回收，也不會中斷整個批次工作。
'use strict';
importScripts('music-hub.js');

const DOWNLOAD_TIMEOUT_MS = 180000;
const pending = new Map(); // downloadId -> { done, filename }
let lastCompletedId = null;

// 送出下載前先登記「URL → 想要的相對路徑」，onDeterminingFilename 觸發時用它覆寫檔名。
// 這是 Chrome 擴充功能裡唯一保證能蓋過伺服器 Content-Disposition / URL 檔名的機制。
const namedQueue = new Map(); // url -> [{ filename, conflictAction }]

function queueName(url, filename, conflictAction) {
  const key = String(url || '');
  const list = namedQueue.get(key) || [];
  list.push({ filename, conflictAction });
  namedQueue.set(key, list);
}

function dropName(url) {
  const key = String(url || '');
  const list = namedQueue.get(key);
  if (!list || !list.length) return;
  list.pop();
  if (!list.length) namedQueue.delete(key);
}

function takeName(url) {
  const key = String(url || '');
  const list = namedQueue.get(key);
  if (!list || !list.length) return null;
  const entry = list.shift();
  if (!list.length) namedQueue.delete(key);
  return entry;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const entry = takeName(item.url) || takeName(item.finalUrl);
  if (entry) suggest({ filename: entry.filename, conflictAction: entry.conflictAction });
  else suggest();
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
    filename = filename.replace(/^[/\\]+/, '');
    if (!filename || filename.includes('..') || /^[a-zA-Z]:/.test(filename) || filename.includes('\\')) {
      resolve({ ok: false, error: '檔名不合法' });
      return;
    }
    const conflictAction = msg.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify';

    let settled = false;
    let id = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (id != null) pending.delete(id);
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

    queueName(url, filename, conflictAction);
    try {
      chrome.downloads.download({ url, filename, conflictAction, saveAs: false }, (downloadId) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || downloadId == null || downloadId < 0) {
          dropName(url);
          finish({ ok: false, error: lastError ? lastError.message : '無法開始下載' });
          return;
        }
        id = downloadId;
        pending.set(id, { done: finish, filename });
      });
    } catch (err) {
      finish({ ok: false, error: String((err && err.message) || err) });
    }
  });
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

async function exportHistoryToHost() {
    const items = await new Promise((resolve) => chrome.downloads.search({ limit: 2000, orderBy: ['-startTime'] }, resolve));
    // Chrome 下載紀錄被清空（或搜尋暫時回空）時不要覆寫：否則本機 history.json 會被洗成 0 筆（曾發生）
    if (!items || !items.length) return { ok: true, skipped: 'empty-history' };
    return hostRequest({
        cmd: 'export',
        name: 'history',
        data: {
            savedAt: Date.now(),
            items: (items || []).map((item) => ({
                id: item.id,
                filename: item.filename,
                url: item.url,
                finalUrl: item.finalUrl,
                state: item.state,
                mime: item.mime,
                fileSize: item.fileSize,
                startTime: item.startTime,
                byExtId: item.byExtensionId || '',
            })),
        },
    });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (['ACE_MUSIC_HUB_GET_CONFIG', 'ACE_MUSIC_HUB_CONFIG', 'ACE_MUSIC_HUB_STATUS', 'ACE_MUSIC_HUB_OPEN', 'ACE_MUSIC_HUB_PROMPT'].includes(msg && msg.type)) {
    return respondLater(async () => await AceMusicHub.create({ chromeApi: chrome, fetchImpl: fetch }).dispatch(msg), sendResponse);
  }
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
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
