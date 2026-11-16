const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.MUSIC_PREVIEW_URL || 'http://127.0.0.1:18788/music';
const out = process.env.MUSIC_UI_EVIDENCE;
if (!out || !path.isAbsolute(out) || !/^http:\/\/127\.0\.0\.1:\d+\/music$/.test(base)) throw new Error('Use an isolated loopback preview and absolute evidence directory.');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  try {
    await page.goto(base + '/api');
    await page.locator('#notice').filter({ hasText: '完整參數契約已載入' }).waitFor();
    assert.match(await page.locator('#native-request').innerText(), /\/api\/idea/);
    await page.screenshot({ path: path.join(out, 'api-desktop.png'), fullPage: false });
    await page.getByText('media · 展開欄位', { exact: true }).click();
    await page.getByText('media[].payload · 展開欄位', { exact: true }).click();
    await page.getByText('media[].payload.url', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('media[].payload.id', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('media · 展開欄位', { exact: true }).click();
    const step = { mode: 'custom', model: 'ace-step-1.5-xl', style: 'Sub-bass, micro-swing, instrumental.', lyrics: '', step: { mode: 'standard', duration_sec: 180, bpm: 120, time_signature: '4/4', key: 'D minor', negative: 'lead vocals', thinking: 70 } };
    await page.locator('#request-json').fill(JSON.stringify(step, null, 2));
    await page.locator('#validate').click();
    await page.locator('#notice').filter({ hasText: '參數通過本機契約檢查' }).waitFor();
    const native = JSON.parse(await page.locator('#native-request').innerText());
    assert.deepEqual(native.body.step, step.step);
    assert.equal(native.body.model, step.model);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => scrollTo(0, 0));
      const layout = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(e => ({ tag: e.tagName, id: e.id, class: e.className, right: e.getBoundingClientRect().right })) }));
      assert.ok(layout.document <= layout.width, JSON.stringify(layout));
      await page.screenshot({ path: path.join(out, `api-${width}.png`), fullPage: false });
    }
    await page.locator('#request-json').fill(JSON.stringify({ ...step, step: { mode: 'standard', bpm: 900 } }));
    await page.locator('#validate').click();
    await page.locator('#notice.error').waitFor();
    assert.equal(await page.locator('#copy').isDisabled(), true);
    assert.equal(requests.filter(r => !r.url.startsWith(new URL(base).origin)).length, 0);
    assert.equal(requests.some(r => /\/create-api\/(submit|preview|tasks)$/.test(r.url)), false);
    assert.deepEqual(errors, []);
    const report = { ok: true, checked_at: new Date().toISOString(), browser: await browser.version(), widths: [1440, 768, 390], flows: ['local example', 'oneOf media field visibility', 'Step full parameter preservation', 'invalid control rejection'], page_errors: errors, external_requests: 0, provider_calls: 0, generation_post: false, upload: false };
    fs.writeFileSync(path.join(out, 'api-ui-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
