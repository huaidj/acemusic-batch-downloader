// 真站面板驗證：已被內容去重 alias 的歌曲，下載時應全部跳過（不再重抓）
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
  clickDownload,
  waitJobDone,
  listFiles,
} from './lib/harness.mjs';

const TARGET = process.env.TARGET_ID || 'so_cc7e11445fd24de0a56a5fdd';
const STATE_DIR = path.join(process.env.LOCALAPPDATA, 'AceMusicDL');
const session = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'session.json'), 'utf8'));
const cookies = String(session.cookie || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf('=');
  return { name: p.slice(0, i), value: p.slice(i + 1), domain: '.acemusic.ai', path: '/' };
});

const base = path.join(TMP, 'manual-alias');
ensureCleanDir(base);
const downloadsDir = path.join(base, 'downloads');
const extDir = copyProductionExtension({ tmpRoot: base });
const profileDir = path.join(base, 'profile');
prepareProfile({ profileDir, downloadDir: downloadsDir });
const { context } = await launchExtensionContext({ profileDir, extDir, downloadsDir });
await context.addCookies(cookies);
const page = await context.newPage();
const report = {};
try {
  await page.goto('https://acemusic.ai/create/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForPanelHost(page, 30000);
  await openPanel(page);
  await page.waitForFunction(() => {
    const root = document.getElementById('acedl-host')?.shadowRoot;
    return root && root.querySelectorAll('[data-song-id]').length > 0;
  }, null, { timeout: 60000, polling: 200 });
  report.hasTarget = await page.evaluate((id) => !!document.getElementById('acedl-host').shadowRoot.querySelector(`[data-song-id="${id}"]`), TARGET);
  report.target = TARGET;
  await page.evaluate((id) => {
    const root = document.getElementById('acedl-host').shadowRoot;
    root.querySelector(`[data-song-id="${id}"]`)?.querySelector('[data-song-pick]')?.click();
  }, TARGET);
  await clickDownload(page);
  report.progress = (await waitJobDone(page, 120000)).counts;
  report.stats = await page.evaluate(() => document.getElementById('acedl-host').shadowRoot.querySelector('[data-stats]')?.textContent || '');
  report.files = listFiles(downloadsDir).map((f) => path.relative(downloadsDir, f.rel));
} catch (err) {
  report.error = String((err && err.message) || err);
} finally {
  await context.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.error || report.progress?.done || report.progress?.failed || (report.files || []).length ? 1 : 0);
}
