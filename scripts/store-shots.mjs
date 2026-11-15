// 產生 Chrome Web Store 截圖（1280×800）：mock 站 + 生產版擴充功能
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_ROOT,
  TMP,
  ensureCleanDir,
  buildTestExtension,
  prepareProfile,
  launchExtensionContext,
  waitForPanelHost,
  openPanel,
  waitSongsLoaded,
  setOption,
  clickDownload,
  waitJobDone,
  screenshot,
} from '../test/lib/harness.mjs';
import { startMockServer } from '../test/mock-server.mjs';

const outDir = path.join(PROJECT_ROOT, 'store-assets');
fs.mkdirSync(outDir, { recursive: true });
const base = path.join(TMP, 'store-shots');
ensureCleanDir(base);
const downloadsDir = path.join(base, 'downloads');
const mock = await startMockServer({ pageSize: 4, pollsBeforeReady: 1 });
const { extDir } = buildTestExtension({ tmpRoot: base, port: mock.port });
const profileDir = path.join(base, 'profile');
prepareProfile({ profileDir, downloadDir: downloadsDir });
const { context } = await launchExtensionContext({ profileDir, extDir, downloadsDir });
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });

await page.goto(mock.base + '/create/', { waitUntil: 'domcontentloaded' });
await waitForPanelHost(page);
await openPanel(page);
await waitSongsLoaded(page, 5);
for (const key of ['stems', 'midi', 'musicxml', 'mp3', 'cover', 'force', 'typeFolders']) {
  await setOption(page, key, key === 'stems' || key === 'midi' || key === 'cover');
}
await page.evaluate(() => {
  const root = document.getElementById('acedl-host').shadowRoot;
  for (const id of ['song-a', 'song-b']) root.querySelector(`[data-song-id="${id}"] [data-song-pick]`).click();
});
await page.waitForTimeout(400);
// 把 mock 頁面換成中性示範背景（商店截圖不應出現 "Mock" 字樣）
await page.evaluate(() => {
  document.title = 'ACE Music — Create';
  const h1 = document.querySelector('h1');
  if (h1) h1.textContent = 'ACE Music';
  const status = document.getElementById('status');
  if (status) status.textContent = 'Create';
  document.documentElement.style.background = '#0b0d14';
  document.body.style.background = '#0b0d14';
  document.body.style.color = '#e7e9f3';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;left:48px;bottom:56px;color:#4a5068;font-size:13px;letter-spacing:.08em';
  tag.textContent = 'acemusic.ai / create';
  document.body.appendChild(tag);
});
await page.screenshot({ path: path.join(outDir, 'screenshot-1.png') });

await clickDownload(page);
await waitJobDone(page, 60000);
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(outDir, 'screenshot-2.png') });

await screenshot(page, 'store-shots-panel');
console.log(JSON.stringify({
  screenshot1: path.join(outDir, 'screenshot-1.png'),
  screenshot2: path.join(outDir, 'screenshot-2.png'),
  size1: fs.statSync(path.join(outDir, 'screenshot-1.png')).size,
  size2: fs.statSync(path.join(outDir, 'screenshot-2.png')).size,
}, null, 2));
await context.close();
await mock.close?.();
process.exit(0);

