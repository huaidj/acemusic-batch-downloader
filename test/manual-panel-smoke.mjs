// 真站面板 smoke：確認 v1.4.0 的「清自訂重複」按鈕與面板正常
import fs from 'node:fs';
import path from 'node:path';
import {
  TMP,
  ensureCleanDir,
  copyProductionExtension,
  prepareProfile,
  launchExtensionContext,
  waitForPanelHost,
  openPanel,
  swEval,
  screenshot,
} from './lib/harness.mjs';

const STATE_DIR = path.join(process.env.LOCALAPPDATA, 'AceMusicDL');
const session = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'session.json'), 'utf8'));
const cookies = String(session.cookie || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf('=');
  return { name: p.slice(0, i), value: p.slice(i + 1), domain: '.acemusic.ai', path: '/' };
});

const base = path.join(TMP, 'smoke-140');
ensureCleanDir(base);
const downloadsDir = path.join(base, 'downloads');
const extDir = copyProductionExtension({ tmpRoot: base });
const profileDir = path.join(base, 'profile');
prepareProfile({ profileDir, downloadDir: downloadsDir });
const { context } = await launchExtensionContext({ profileDir, extDir, downloadsDir });
await context.addCookies(cookies);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
const report = {};
try {
  const version = await swEval(context, () => chrome.runtime.getManifest().version);
  await page.goto('https://acemusic.ai/create/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPanelHost(page, 30000);
  await openPanel(page);
  await page.waitForFunction(() => {
    const root = document.getElementById('acedl-host')?.shadowRoot;
    return root && root.querySelectorAll('[data-song-id]').length > 0;
  }, null, { timeout: 60000, polling: 200 });
  const panel = await page.evaluate(() => {
    const root = document.getElementById('acedl-host').shadowRoot;
    const btn = root.querySelector('[data-act="dedupe-custom"]');
    return {
      button: btn ? btn.textContent.trim() : null,
      buttons: Array.from(root.querySelectorAll('[data-act]')).map((b) => b.getAttribute('data-act')),
      rows: root.querySelectorAll('[data-song-id]').length,
      stats: root.querySelector('[data-stats]')?.textContent || '',
    };
  });
  report.version = version;
  report.panel = panel;
  report.errors = errors;
  await screenshot(page, 'v140-panel');
} catch (err) {
  report.error = String((err && err.message) || err);
} finally {
  await context.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.error || errors.length ? 1 : 0);
}
