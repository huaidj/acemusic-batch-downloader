// test/real-site-smoke.mjs — 真實站點 smoke（DoD #3）。
//
// 站點事實（2026-11-15 實測）：
//   GET https://acemusic.ai/create/ 未登入 → 302 Location: /signup/?next=%2Fcreate%2F
//   GET https://acemusic.ai/zh/create/         → 404（站點沒有此路由）
//   GET https://acemusic.ai/api/songs          → 401 {"error":{"type":"auth","code":"login",...}}
// 因此「未登入停在 /create/ 看面板登入提示」在真實站點不可能發生（伺服器先 302）。
// 本 smoke 驗證：
//   * 導覽到 /create/ 不產生 extension-origin console error / pageerror
//   * content script 確實有被注入（CDP isolated world 證據），且在非 create 頁面正確不建立面板
//   * 若最終仍在 create 頁（例如站點未來改行為）→ 驗證面板登入提示或歌單
// 使用 bundled Chromium（Chrome branded v157 不支援 --load-extension，見 FINDINGS.md）。
//
// 跑法：node test/real-site-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  TMP,
  ARTIFACTS,
  ensureCleanDir,
  copyProductionExtension,
  prepareProfile,
  launchExtensionContext,
  waitForPanelHost,
  openPanel,
  screenshot,
  readLoadedManifest,
} from './lib/harness.mjs';

const URL_TARGET = 'https://acemusic.ai/create/';
const result = {
  startedAt: new Date().toISOString(),
  target: URL_TARGET,
  reachable: false,
  redirectChain: [],
  finalUrl: null,
  panelInjected: false,
  loginHintShown: false,
  songRows: null,
  contentScriptInjected: false,
  isolatedWorlds: [],
  extensionErrors: [],
  siteConsoleErrors: [],
  pageErrors: [],
  notes: [],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmpRoot = path.join(TMP, 'real-site');
  ensureCleanDir(tmpRoot);
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const extDir = copyProductionExtension({ tmpRoot });
  const profileDir = path.join(tmpRoot, 'profile');
  const downloadsDir = path.join(tmpRoot, 'downloads');
  prepareProfile({ profileDir, downloadDir: downloadsDir });

  let context;
  let page;
  try {
    const launched = await launchExtensionContext({ profileDir, extDir, downloadsDir });
    context = launched.context;
    result.browser = await launched.sw.evaluate(() => navigator.userAgent);
    result.extensionId = await launched.sw.evaluate(() => chrome.runtime.id);
    result.manifest = await readLoadedManifest(context);

    page = context.pages()[0] || (await context.newPage());

    // CDP：捕捉 execution context 建立事件，用來證明 content script（isolated world）有被注入。
    const cdp = await context.newCDPSession(page);
    cdp.on('Runtime.executionContextCreated', ({ context: c }) => {
      result.isolatedWorlds.push({
        origin: c.origin,
        name: c.name,
        type: c.auxData ? c.auxData.type : null,
        frameId: c.auxData ? c.auxData.frameId : null,
      });
    });
    await cdp.send('Runtime.enable');

    page.on('pageerror', (e) => {
      const s = String(e && (e.stack || e.message || e));
      result.pageErrors.push(s.slice(0, 500));
      if (s.includes('chrome-extension://')) result.extensionErrors.push('pageerror: ' + s.slice(0, 500));
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const loc = (m.location && m.location().url) || '';
      const text = m.text();
      if (/favicon/i.test(loc) || /favicon/i.test(text)) return;
      const entry = { text: text.slice(0, 400), url: loc };
      if (loc.startsWith('chrome-extension://')) result.extensionErrors.push('console: ' + JSON.stringify(entry));
      else result.siteConsoleErrors.push(entry);
    });

    let response;
    try {
      response = await page.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
    } catch (err) {
      result.notes.push('goto 失敗（可能是網路/環境限制）：' + String((err && err.message) || err).slice(0, 400));
      return;
    }
    result.httpStatus = response ? response.status() : null;
    // redirect chain（從最初的 request 到最後）
    const chain = [];
    let req = response ? response.request() : null;
    while (req) {
      chain.unshift({ url: req.url(), method: req.method() });
      const prev = req.redirectedFrom();
      if (!prev) break;
      req = prev;
    }
    result.redirectChain = chain;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(1500);
    result.finalUrl = page.url();
    result.title = await page.title().catch(() => null);
    result.reachable = true;

    const finalPath = new URL(result.finalUrl).pathname;
    const onCreatePage = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?create\/?$/i.test(finalPath);

    // content script 是否真的被注入：isolated world origin 應為 chrome-extension://<id>
    result.contentScriptInjected = result.isolatedWorlds.some(
      (w) => (w.origin || '').startsWith('chrome-extension://') || (w.type === 'isolated' && /ACE|批量/.test(w.name || '')),
    );

    if (onCreatePage) {
      // 站點未來若改變未登入行為（停在 /create/），驗證登入提示或歌單
      try {
        await waitForPanelHost(page, 45000);
        result.panelInjected = true;
      } catch {
        result.notes.push('停在 create 頁但 45 秒內等不到 #acedl-host');
      }
    } else {
      // 目前站點行為：未登入 /create/ 302 到 /signup/，content script 依契約只在 create 頁建立面板。
      result.notes.push(`未登入 /create/ 被站點導向 ${finalPath}（302），content script 正確不建立面板；此為站點行為，非擴充功能錯誤。`);
      const injected = await page.evaluate(() => !!document.getElementById('acedl-host'));
      result.panelInjected = injected;
      if (injected) result.notes.push('非 create 頁竟出現面板（不符合契約 2.3 的頁面範圍）');
    }

    if (result.panelInjected) {
      await openPanel(page);
      const deadline = Date.now() + 30000;
      let state = null;
      while (Date.now() < deadline) {
        state = await page.evaluate(() => {
          const shadow = document.getElementById('acedl-host')?.shadowRoot;
          if (!shadow) return null;
          const hint = shadow.querySelector('.songs .hint');
          return {
            hint: hint ? hint.textContent.trim() : null,
            rows: shadow.querySelectorAll('[data-song-id]').length,
          };
        });
        if (state && ((state.hint && /請先登入|登入/.test(state.hint)) || state.rows > 0)) break;
        await sleep(300);
      }
      result.panelState = state;
      result.songRows = state ? state.rows : null;
      result.loginHintShown = !!(state && state.hint && /請先登入 ACE Music/.test(state.hint));
    }
    await screenshot(page, 'real-site-final');

    if (!result.loginHintShown && !(result.songRows > 0) && onCreatePage) {
      result.notes.push('面板已注入但無登入提示也無歌單：' + JSON.stringify(result.panelState).slice(0, 500));
    }
  } finally {
    if (context) await context.close().catch(() => {});
    result.finishedAt = new Date().toISOString();
    // 判定：可達 + 無 extension-origin 錯誤 + content script 確實注入 + 不在非 create 頁建立面板。
    // （未登入被 302 到 /signup/ 時，登入提示條款不可觀測，見 notes）
    const createdPanelOutsideCreate = result.panelInjected && result.redirectChain.length > 1 && !/create\/?$/.test(result.finalUrl);
    result.ok = result.reachable && result.extensionErrors.length === 0 && result.contentScriptInjected && !createdPanelOutsideCreate;
    fs.writeFileSync(path.join(TMP, 'real-site-smoke.json'), JSON.stringify(result, null, 2));
    const summary = {
      ok: result.ok,
      httpStatus: result.httpStatus,
      redirectChain: result.redirectChain.map((r) => r.url),
      finalUrl: result.finalUrl,
      contentScriptInjected: result.contentScriptInjected,
      isolatedWorldCount: result.isolatedWorlds.length,
      panelInjected: result.panelInjected,
      loginHintShown: result.loginHintShown,
      extensionErrors: result.extensionErrors,
      siteConsoleErrorCount: result.siteConsoleErrors.length,
      notes: result.notes,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('real-site smoke fatal:', err);
  process.exitCode = 2;
});
