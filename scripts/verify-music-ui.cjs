// Render and exercise only the isolated local preview. Uses the existing test dependency.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const url = process.env.MUSIC_PREVIEW_URL || 'http://127.0.0.1:18788/music';
const out = process.env.MUSIC_UI_EVIDENCE;
if (!out || !path.isAbsolute(out)) throw new Error('Set MUSIC_UI_EVIDENCE to an absolute evidence directory.');
if (!/^http:\/\/127\.0\.0\.1:\d+\/music$/.test(url)) throw new Error('Only an isolated loopback preview is accepted.');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  const errors = [], outside = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(url).origin) outside.push(request.url()); });
  try {
    await page.goto(url);
    await page.getByText('本機準備可用。ACE 與 DeepSeek 尚未送出任何請求。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '產生方向預覽', exact: true }).click();
    await page.locator('#notice').filter({ hasText: '預覽已保存' }).waitFor();
    assert.equal(await page.locator('#translation-warning').isVisible(), false);
    const originalText = await page.locator('#prompt-fields').innerText();
    assert.match(originalText, /sub-bass/);
    await page.locator('#reviewed').check();
    await page.locator('#prepare').click();
    await page.locator('#notice').filter({ hasText: '已保存待授權任務' }).waitFor();
    await page.locator('#prepare').click();
    await page.locator('#notice').filter({ hasText: '已保存待授權任務' }).waitFor();
    const state = await page.evaluate(async () => (await fetch('/music/state')).json());
    assert.equal(state.jobs.filter(j => j.plan_id === state.plans[0].id && j.status === 'awaiting_authorization').length, 1);
    assert.equal(state.provider_calls, 0);
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    const layouts = [];
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      layouts.push(await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, textVisible: !!document.querySelector('h1')?.getBoundingClientRect().width })));
      await page.screenshot({ path: path.join(out, `layout-${width}.png`), fullPage: true });
    }
    assert.ok(layouts.every(l => l.documentWidth <= l.width), JSON.stringify(layouts));
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.locator('#model').selectOption('ace-step-v1.5-xl');
    assert.equal(await page.locator('#prepare').isDisabled(), true, 'model changes invalidate the previous review');
    await page.locator('#mode').selectOption('custom');
    await page.getByRole('button', { name: '產生方向預覽', exact: true }).click();
    await page.locator('#notice').filter({ hasText: '預覽已保存' }).waitFor();
    assert.match(await page.locator('#prompt-fields').innerText(), /style[\s\S]*lyrics/);
    await page.locator('.reference-area summary').click();
    await page.locator('#reference-url').fill('https://open.spotify.com/track/offline-reference');
    await page.locator('#register-reference').click();
    await page.locator('#references').filter({ hasText: 'AI 路徑關閉' }).waitFor();
    await page.locator('#intent').fill('銀色月光裡的斷裂玻璃');
    await page.getByRole('button', { name: '產生方向預覽', exact: true }).click();
    await page.locator('#translation-warning').waitFor();
    assert.equal(await page.locator('#prepare').isDisabled(), true);
    await page.getByRole('button', { name: '停止批次', exact: true }).first().click();
    await page.locator('#notice').filter({ hasText: '已停止本機後續任務' }).waitFor();
    await page.reload();
    await page.locator('#notice').filter({ hasText: '本機準備可用' }).waitFor();
    assert.match(await page.locator('#jobs').innerText(), /已取消/);
    const finalState = await page.evaluate(async () => (await fetch('/music/state')).json());
    assert.equal(finalState.provider_calls, 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(outside.length, 0, outside.join('\n'));
    const report = { ok: true, checked_at: new Date().toISOString(), url, browser: await browser.version(), layouts, page_errors: errors, external_requests: outside, flows: ['compile idea', 'review', 'idempotent prepare', 'model invalidation', 'custom fields', 'spotify navigation gate', 'untranslated text gate', 'stop', 'reload persistence'], real_generation: 'not_run', listening: 'not_run', provider_calls: 0 };
    fs.writeFileSync(path.join(out, 'ui-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
