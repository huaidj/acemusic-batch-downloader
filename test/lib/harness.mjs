// test/lib/harness.mjs — e2e 共用工具：
//   * 把生產 src/ + manifest.json + icons 複製到臨時目錄，並在測試版 manifest 加入 mock origin
//   * 準備乾淨 profile（Default/Preferences 指定測試下載目錄）
//   * 以 Playwright persistent context + bundled Chromium 載入 unpacked extension
//   * 關閉 Playwright 的下載劫持（CDP Browser.setDownloadBehavior behavior:"default"）
//   * 檔案系統斷言工具
//
// 重要事實（spike 已驗證，test/spike/RESULT.json）：
//   - Chrome branded v157 忽略 --load-extension，必須用 Playwright bundled Chromium 149。
//   - Playwright 預設把「所有」下載劫持到 playwright-artifacts/UUID 並改成隨機檔名，
//     必須在 launch 後用 CDP 重設為 "default"，Chrome 才會依 profile Preferences + 相對子資料夾落地。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// 可用 PLAYWRIGHT_PATH 指定既有安裝；否則用本專案 node_modules 的 playwright
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try next */ }
  }
  throw new Error('找不到 playwright：請在專案根目錄執行 `npm i -D playwright`，或設定 PLAYWRIGHT_PATH');
}
export const { chromium } = loadPlaywright();

export const TEST_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PROJECT_ROOT = path.dirname(TEST_DIR);
export const TMP = path.join(TEST_DIR, '.tmp');
export const ARTIFACTS = path.join(TEST_DIR, 'artifacts');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dst, name));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/** 複製生產擴充功能到 <tmp>/ext 並改寫 manifest（只加 mock origin，不動生產檔）。 */
export function buildTestExtension({ tmpRoot, port, extraOrigins = [] }) {
  const extDir = path.join(tmpRoot, 'ext');
  ensureCleanDir(extDir);
  const srcDir = path.join(PROJECT_ROOT, 'src');
  const iconsDir = path.join(PROJECT_ROOT, 'icons');
  fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    copyRecursive(path.join(srcDir, name), path.join(extDir, 'src', name));
  }
  if (fs.existsSync(iconsDir)) {
    fs.mkdirSync(path.join(extDir, 'icons'), { recursive: true });
    for (const name of fs.readdirSync(iconsDir)) {
      copyRecursive(path.join(iconsDir, name), path.join(extDir, 'icons', name));
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8'));
  // 隔離背景副本也禁止 native 實寫；Chrome 下載 API 仍是真實流程。
  const testBackground = path.join(extDir, 'src', 'background.js');
  fs.writeFileSync(testBackground, "chrome.runtime.connectNative = () => { throw new Error('Native host disabled in isolated e2e'); };\n" + fs.readFileSync(testBackground, 'utf8'));
  // A fresh browser profile still discovers system native-host registration.
  // Deny that permission in this test copy too, so nothing can reach the user's real host.
  manifest.permissions = (manifest.permissions || []).filter(permission => permission !== 'nativeMessaging');
  // 測試隔離：content.js 看到 __ACEDL_TEST_MODE__ 就不採用真機 host 的 fs/agent-state 跳過邏輯
  fs.writeFileSync(path.join(extDir, 'src', 'testmode.js'), `
globalThis.__ACEDL_TEST_MODE__ = true;
// 只在隔離測試副本注入失效的 content runtime；不影響真實擴充功能或使用者 profile。
(() => {
  const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  const nativeFixture = new URLSearchParams(location.search).has('native-fixture');
  if (nativeFixture) document.documentElement.dataset.acedlTestNative = JSON.stringify({ root: ${JSON.stringify(path.join(tmpRoot, 'downloads'))}, files: [], verified: { savedAt: 'initial', files: [] }, agentState: { history: {} } });
  chrome.runtime.sendMessage = (msg, ...args) => {
    const flags = document.documentElement.dataset;
    if (msg && msg.type === 'ACE_DOWNLOAD_FILE') {
      const sent = Number(flags.acedlTestDownloads || 0);
      flags.acedlTestDownloads = String(sent + 1);
      if (String(msg.url || '').startsWith('blob:')) flags.acedlTestBlobDownloads = String(Number(flags.acedlTestBlobDownloads || 0) + 1);
      if (flags.acedlTestInvalidateAfter !== undefined && sent >= Number(flags.acedlTestInvalidateAfter)) flags.acedlTestInvalidated = '1';
    }
    if (flags.acedlTestInvalidated === '1') throw new Error('Extension context invalidated.');
    if (msg.type === 'ACE_OPEN_PLAYER') {
      const calls = JSON.parse(flags.acedlTestPlayerCalls || '[]');
      calls.push(msg.songId || null);
      flags.acedlTestPlayerCalls = JSON.stringify(calls);
      const callback = args.find((value) => typeof value === 'function');
      queueMicrotask(() => callback && callback({ ok: true }));
      return;
    }
    if (msg.type === 'ACE_HOST_LOCAL_INDEX') {
      flags.acedlTestIndexReads = String(Number(flags.acedlTestIndexReads || 0) + 1);
      const fixture = nativeFixture ? JSON.parse(flags.acedlTestNative || '{}') : {};
      const callback = args.find((value) => typeof value === 'function');
      if (fixture.offline || fixture.unsupportedIndex) {
        queueMicrotask(() => callback && callback({ ok: false, error: 'unknown cmd local-index' }));
        return;
      }
      chrome.storage.local.get(['aceHistory'], (got) => {
        let index = fixture.compact;
        if (!index) {
          const byTask = {};
          const blank = () => ({ downloaded: { mp3: false, wav: false, midi: false, musicxml: false, stems: 0, cover: false }, completedKeys: [], uncertainKinds: [], notationRequested: true, wavSupported: true, problemCodes: [] });
          for (const id of ['song-a', 'song-b', 'song-c', 'song-e1', 'song-e2']) byTask[id] = blank();
          const prefix = String(msg.root || 'ai音樂') + '/';
          for (const [id, entry] of Object.entries(got.aceHistory || {})) {
            for (const [key, info] of Object.entries(entry.files || {})) {
              if (!String(info.path || '').split(String.fromCharCode(92)).join('/').startsWith(prefix)) continue;
              if (!byTask[id]) byTask[id] = blank();
              byTask[id].completedKeys.push(key);
            }
          }
          for (const proof of fixture.verified?.files || []) {
            const physical = (fixture.files || []).find((file) => String(file.path).toLowerCase() === String(proof.absolute).toLowerCase() && Number(file.size) === Number(proof.bytes));
            if (!physical || !proof.sha256 || !proof.verifiedAt) continue;
            if (!byTask[proof.task_id]) byTask[proof.task_id] = blank();
            byTask[proof.task_id].completedKeys.push(proof.kind);
          }
          for (const row of Object.values(byTask)) {
            row.completedKeys = [...new Set(row.completedKeys)];
            for (const kind of ['mp3', 'wav', 'midi', 'musicxml', 'cover']) row.downloaded[kind] = row.completedKeys.includes(kind);
            row.downloaded.stems = row.completedKeys.filter((key) => key.startsWith('stem:')).length;
          }
          const revision = JSON.stringify([msg.root, byTask, fixture.verified?.savedAt || '']);
          index = { ok: true, apiVersion: 1, revision, savedAt: new Date().toISOString(), byTask, summary: {} };
        }
        const prior = JSON.parse(flags.acedlTestIndexSnapshot || 'null');
        if (prior && prior.revision === index.revision && prior.root === msg.root) index.savedAt = prior.savedAt;
        else flags.acedlTestIndexBuilds = String(Number(flags.acedlTestIndexBuilds || 0) + 1);
        flags.acedlTestIndexSnapshot = JSON.stringify({ revision: index.revision, savedAt: index.savedAt, root: msg.root });
        callback && callback({ ok: true, index });
      });
      return;
    }
    if (msg.type === 'ACE_PING' && Number(flags.acedlTestPingDelayMs) > 0) {
      setTimeout(() => realSend(msg, ...args), Math.min(2000, Number(flags.acedlTestPingDelayMs)));
      return;
    }
    if (nativeFixture && (msg.type === 'ACE_AGENT_STATUS' || msg.type.startsWith('ACE_HOST_'))) {
      const fixture = JSON.parse(flags.acedlTestNative || '{}');
      let reply = { ok: !fixture.offline };
      if (msg.type === 'ACE_HOST_TIDY') flags.acedlTestTidyCalls = String(Number(flags.acedlTestTidyCalls || 0) + 1);
      if (msg.type === 'ACE_HOST_MOVE') flags.acedlTestMoveCalls = String(Number(flags.acedlTestMoveCalls || 0) + 1);
      if (msg.type === 'ACE_AGENT_STATUS') reply = { ok: true, host: { ok: !fixture.offline, downloadsRoot: fixture.root || '' } };
      else if (msg.type === 'ACE_HOST_LIST') {
        flags.acedlTestNativeLists = String(Number(flags.acedlTestNativeLists || 0) + 1);
        reply = { ok: !fixture.offline, root: fixture.root, files: fixture.files || [] };
      } else if (msg.type === 'ACE_HOST_READ') {
        flags.acedlTestNativeReads = String(Number(flags.acedlTestNativeReads || 0) + 1);
        reply = { ok: !fixture.offline, data: msg.name === 'verified-audio' ? fixture.verified || {} : msg.name === 'agent-state' ? fixture.agentState || {} : msg.name === 'tidy-status' ? { phase: 'done', ok: true, steps: [] } : { items: [] } };
      }
      const callback = args.find((value) => typeof value === 'function');
      queueMicrotask(() => callback && callback(reply));
      return;
    }
    return realSend(msg, ...args);
  };
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (url, options) => {
    if (options && options.credentials === 'include') {
      const flags = document.documentElement.dataset;
      flags.acedlTestFallbackFetches = String(Number(flags.acedlTestFallbackFetches || 0) + 1);
    }
    return realFetch(url, options);
  };
})();
`);
  for (const cs of manifest.content_scripts || []) {
    if (!cs.js.includes('src/testmode.js')) cs.js.unshift('src/testmode.js');
  }
  const origins = [`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`, ...extraOrigins];
  for (const origin of origins) {
    if (!manifest.host_permissions.includes(origin)) manifest.host_permissions.push(origin);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const origin of origins) if (!cs.matches.includes(origin)) cs.matches.push(origin);
  }
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { extDir, manifest };
}

/** 預先寫好 profile Preferences，指定測試下載目錄（第 4 節要求）。 */
export function prepareProfile({ profileDir, downloadDir }) {
  ensureCleanDir(downloadDir);
  ensureCleanDir(profileDir);
  const prefsDir = path.join(profileDir, 'Default');
  fs.mkdirSync(prefsDir, { recursive: true });
  fs.writeFileSync(
    path.join(prefsDir, 'Preferences'),
    JSON.stringify({
      download: {
        default_directory: downloadDir,
        prompt_for_download: false,
        directory_upgrade: true,
      },
      savefile: { default_directory: downloadDir },
      profile: { exit_type: 'Normal', exited_cleanly: true },
    }),
  );
}

/** 複製「未改寫」的生產擴充功能（真實站點 smoke 用）。 */
export function copyProductionExtension({ tmpRoot }) {
  const extDir = path.join(tmpRoot, 'ext-production');
  ensureCleanDir(extDir);
  copyRecursive(path.join(PROJECT_ROOT, 'src'), path.join(extDir, 'src'));
  if (fs.existsSync(path.join(PROJECT_ROOT, 'icons'))) {
    copyRecursive(path.join(PROJECT_ROOT, 'icons'), path.join(extDir, 'icons'));
  }
  fs.copyFileSync(path.join(PROJECT_ROOT, 'manifest.json'), path.join(extDir, 'manifest.json'));
  return extDir;
}

/** 啟動載入擴充功能的非 headless persistent context（bundled Chromium）。 */
export async function launchExtensionContext({ profileDir, extDir, downloadsDir }) {
  const args = [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--disable-search-engine-choice-screen',
    '--mute-audio',
  ];
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--disable-extensions'],
    args,
  });
  const browser = context.browser();
  // 解除 Playwright 對所有下載的劫持，讓 Chrome 依 profile Preferences 落地（含中文子資料夾）。
  let cdp;
  try {
    cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  } catch (err) {
    throw new Error('CDP 重設下載行為失敗：' + ((err && err.message) || err));
  }
  const sw = await getServiceWorker(context);
  return { context, browser, cdp, sw };
}

export async function getServiceWorker(context, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workers = context.serviceWorkers();
    for (const w of workers) {
      try {
        await w.evaluate(() => typeof chrome !== 'undefined' && !!chrome.runtime);
        return w;
      } catch {
        /* stale worker */
      }
    }
    await sleep(150);
  }
  throw new Error('等不到擴充功能 service worker（extension 未載入）');
}

export async function swEval(context, fn, arg) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sw = await getServiceWorker(context);
    try {
      return await sw.evaluate(fn, arg);
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw lastErr;
}

/* ------------------------------- 檔案工具 ------------------------------- */

export function listFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const st = fs.statSync(abs);
        out.push({ rel: path.relative(root, abs), abs, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function relPosix(absPath) {
  return absPath.split(path.sep).join('/');
}

export function readFileBuf(absPath) {
  try {
    return fs.readFileSync(absPath);
  } catch {
    return null;
  }
}

export function fileContains(absPath, needle) {
  const buf = readFileBuf(absPath);
  if (!buf) return false;
  return buf.includes(Buffer.from(needle, 'utf8'));
}

/* --------------------------- 面板（shadow DOM）工具 --------------------------- */

const HOST = '#acedl-host';

export function panelHandleReady() {
  return (() => {
    const host = document.getElementById('acedl-host');
    return !!(host && host.shadowRoot && host.shadowRoot.getElementById('acedl-fab'));
  })();
}

export async function waitForPanelHost(page, timeout = 30000) {
  await page.waitForFunction(
    () => {
      const host = document.getElementById('acedl-host');
      return !!(host && host.shadowRoot && host.shadowRoot.getElementById('acedl-fab'));
    },
    null,
    { timeout, polling: 100 },
  );
}

export async function openPanel(page) {
  await waitForPanelHost(page);
  const panel = page.locator('#acedl-host').locator('section.panel');
  if (!(await panel.count())) throw new Error('找不到面板 section');
  if (await panel.first().isHidden()) await page.locator('#acedl-fab').click();
  await page.waitForFunction(
    () => {
      const host = document.getElementById('acedl-host');
      const p = host && host.shadowRoot && host.shadowRoot.querySelector('section.panel');
      return !!p && !p.hidden;
    },
    null,
    { timeout: 10000, polling: 100 },
  );
}

export async function shadowText(page, selector) {
  return page.evaluate((sel) => {
    const host = document.getElementById('acedl-host');
    const node = host && host.shadowRoot && host.shadowRoot.querySelector(sel);
    return node ? node.textContent.trim() : null;
  }, selector);
}

async function openDownloadSettings(page) {
  const settings = page.locator('[data-download-settings]');
  if (await settings.count() && !(await settings.evaluate((node) => node.open))) {
    await settings.locator('summary').first().click();
  }
}

export async function setOption(page, key, checked) {
  const loc = page.locator(`[data-opt="${key}"]`);
  await loc.waitFor({ state: 'attached', timeout: 10000 });
  await openDownloadSettings(page);
  if ((await loc.isChecked()) !== checked) await loc.click();
  const now = await loc.isChecked();
  if (now !== checked) throw new Error(`無法設定選項 ${key}=${checked}`);
}

export async function setRootFolder(page, value) {
  const loc = page.locator('[data-root-folder]');
  await loc.waitFor({ state: 'attached', timeout: 10000 });
  await openDownloadSettings(page);
  await loc.fill(value);
  // trigger input/change so content 的 change listener 更新 S.rootFolder
  await loc.dispatchEvent('input');
  await loc.dispatchEvent('change');
  await loc.blur();
}

/** 等待歌單載入完成（歌曲列數或指定的 hint 出現）。 */
export async function waitSongsLoaded(page, expectedCount, timeout = 30000) {
  await page.waitForFunction(
    (count) => {
      const host = document.getElementById('acedl-host');
      const shadow = host && host.shadowRoot;
      if (!shadow) return false;
      const rows = shadow.querySelectorAll('[data-song-id]');
      if (count >= 0) return rows.length === count;
      return rows.length > 0;
    },
    expectedCount,
    { timeout, polling: 100 },
  );
}

export async function selectSongs(page, taskIds) {
  await page.evaluate((ids) => {
    const wanted = new Set(ids);
    const shadow = document.getElementById('acedl-host').shadowRoot;
    for (const row of shadow.querySelectorAll('[data-song-id]')) {
      const id = row.getAttribute('data-song-id');
      if (!wanted.has(id)) continue;
      const cb = row.querySelector('[data-song-pick]');
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      }
    }
    return true;
  }, taskIds);
}

export async function selectAll(page) {
  await page.locator('[data-act="select-all"]').click();
}

export async function clickDownload(page) {
  await page.locator('[data-act="download"]').click();
}

export async function clickCancel(page) {
  await page.locator('[data-act="cancel"]').click();
}

export async function reloadPanel(page, { expectedSongs } = {}) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openPanel(page);
  await waitSongsLoaded(page, expectedSongs ?? -1);
}

/** 等待下載 job 結束（完成 / 已停止），回傳進度快照。 */
export async function waitJobDone(page, timeout = 180000) {
  await page.waitForFunction(
    () => {
      const host = document.getElementById('acedl-host');
      const shadow = host && host.shadowRoot;
      if (!shadow) return false;
      const current = shadow.querySelector('[data-current]');
      const text = current ? current.textContent.trim() : '';
      return /^(完成|已停止)/.test(text);
    },
    null,
    { timeout, polling: 100 },
  );
  return readProgress(page);
}

export async function readProgress(page) {
  return page.evaluate(() => {
    const host = document.getElementById('acedl-host');
    const shadow = host && host.shadowRoot;
    if (!shadow) return null;
    const grab = (sel) => {
      const node = shadow.querySelector(sel);
      return node ? node.textContent.trim() : null;
    };
    const stats = grab('[data-stats]') || '';
    // 實作把 chips 直接串起來（可能有也可能沒有分隔符），用寬鬆 regex 抓四個數字。
    const m = stats.match(/完成\s*(\d+)[\s\S]*?失敗\s*(\d+)[\s\S]*?跳過\s*(\d+)[\s\S]*?共\s*(\d+)/);
    const showFolder = shadow.querySelector('[data-act="show-folder"]');
    return {
      statsText: stats,
      current: grab('[data-current]'),
      phaseLine: grab('[data-current]'),
      fabText: grab('#acedl-fab') || null,
      downloadBtnText: grab('[data-act="download"]'),
      cancelVisible: (() => {
        const c = shadow.querySelector('[data-act="cancel"]');
        return !!c && !c.hidden;
      })(),
      showFolderVisible: !!showFolder && !showFolder.hidden,
      counts: m ? { done: +m[1], failed: +m[2], skipped: +m[3], total: +m[4] } : null,
      failedItems: [...shadow.querySelectorAll('[data-failed] li')].map((li) => li.textContent.trim()),
      songRowCount: shadow.querySelectorAll('[data-song-id]').length,
      songTitles: [...shadow.querySelectorAll('[data-song-id] .name')].map((n) => n.textContent.trim()),
    };
  });
}

/** 截圖到 test/artifacts/。 */
export async function screenshot(page, name) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const file = path.join(ARTIFACTS, `${name}-${Date.now()}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
  } catch {
    /* ignore */
  }
  return file;
}

/** 檢查擴充功能 manifest 是否真的被瀏覽器載入（SW 存在 + manifest 可讀）。 */
export async function readLoadedManifest(context) {
  return swEval(context, () => ({
    id: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    mv: chrome.runtime.getManifest().manifest_version,
    permissions: chrome.runtime.getManifest().permissions,
    hostPermissions: chrome.runtime.getManifest().host_permissions,
    contentScripts: chrome.runtime.getManifest().content_scripts,
    background: chrome.runtime.getManifest().background,
  }));
}

/** 讀取 chrome.storage.local 全部內容（真實歷史/資料夾狀態）。 */
export async function readStorage(context) {
  return swEval(context, () => chrome.storage.local.get(null));
}
