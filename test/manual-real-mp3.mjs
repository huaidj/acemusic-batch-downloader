// 真站手動驗證：用同步的登入 cookie + 生產版擴充功能，下載一首上傳型歌曲的 MP3
// 驗證重點：不再走 /file?kind=mp3（會回 JSON），且進度「共」= 完成+失敗+跳過
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
  setOption,
  clickDownload,
  waitJobDone,
  screenshot,
  listFiles,
  swEval,
} from './lib/harness.mjs';

const STATE_DIR = path.join(process.env.LOCALAPPDATA, 'AceMusicDL');
const session = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'session.json'), 'utf8'));
const cookies = String(session.cookie || '')
  .split(';')
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const index = part.indexOf('=');
    return { name: part.slice(0, index), value: part.slice(index + 1), domain: '.acemusic.ai', path: '/' };
  });

const base = path.join(TMP, 'manual-real');
ensureCleanDir(base);
const extDir = copyProductionExtension({ tmpRoot: base });
const profileDir = path.join(base, 'profile');
const downloadsDir = path.join(base, 'downloads');
prepareProfile({ profileDir, downloadDir: downloadsDir });

const { context } = await launchExtensionContext({ profileDir, extDir, downloadsDir });
await context.addCookies(cookies);

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err)));
await context.route('**/*', (route) => route.continue());

const report = { steps: [], pageErrors };
try {
  await page.goto('https://acemusic.ai/create/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  report.url = page.url();
  report.signup = /signup|\/login/i.test(report.url);
  await waitForPanelHost(page, 30000);
  await openPanel(page);
  await page.waitForFunction(() => {
    const shadow = document.getElementById('acedl-host')?.shadowRoot;
    return shadow && shadow.querySelectorAll('[data-song-id]').length > 0;
  }, null, { timeout: 60000, polling: 200 });
  const rows = await page.evaluate(() => Array.from(document.getElementById('acedl-host').shadowRoot.querySelectorAll('[data-song-id]')).map((node) => node.getAttribute('data-song-id')));
  report.songRows = rows.length;

  // 上傳型（music_transcribe）歌曲：優先取先前失敗清單中的 id，否則取有「MP3 已下載」以外的第一首
  const preferred = ['so_b76d24bdbb4148b29a689514', 'so_40dfdc426d754790b8e1ca39', 'so_f59a8a63eae0474da2293543'];
  const target = preferred.find((id) => rows.includes(id)) || rows[0];
  report.target = target;

  for (const key of ['stems', 'midi', 'musicxml', 'cover', 'typeFolders']) await setOption(page, key, false);
  await setOption(page, 'mp3', true);
  await setOption(page, 'force', true);
  await setOption(page, 'autoFix', false).catch(() => {});

  await page.evaluate((id) => {
    const root = document.getElementById('acedl-host').shadowRoot;
    root.querySelector(`[data-song-id="${id}"]`)?.querySelector('[data-song-pick]')?.click();
  }, target);
  await clickDownload(page);
  const progress = await waitJobDone(page, 240000);
  report.progress = progress;
  const panelState = await page.evaluate(() => {
    const root = document.getElementById('acedl-host').shadowRoot;
    return {
      stats: root.querySelector('[data-stats]')?.textContent || '',
      failedSummary: root.querySelector('[data-failed-summary]')?.textContent || '',
      failedItems: Array.from(root.querySelectorAll('[data-failed-summary] ~ ul li')).map((node) => node.textContent),
    };
  });
  report.statsText = panelState.stats;
  report.failedText = panelState.failedSummary;
  report.failedItems = panelState.failedItems;
  report.files = listFiles(downloadsDir).map((f) => ({ rel: path.relative(downloadsDir, f.rel), size: f.size }));
  report.downloads = await swEval(context, async () => {
    const items = await chrome.downloads.search({ limit: 50 });
    return items.map((it) => ({ state: it.state, error: it.error || null, filename: it.filename, url: it.url, mime: it.mime }));
  });
  await screenshot(page, 'manual-real-mp3');
} catch (err) {
  report.error = String((err && err.message) || err);
  try { await screenshot(page, 'manual-real-mp3-FAIL'); } catch { /* ignore */ }
} finally {
  report.jsonFiles = (report.files || []).filter((f) => /\.json$/i.test(f.rel));
  report.interrupted = (report.downloads || []).filter((d) => d.state === 'interrupted');
  await context.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.error || report.jsonFiles.length || report.interrupted.length ? 1 : 0);
}


