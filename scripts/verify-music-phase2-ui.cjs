// Self-contained fixture only. No real provider, credential, session or live port.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'F:/code/mavelpoint-cn/node_modules/playwright');
const project = path.resolve(__dirname, '..');
const tempRoot = 'F:\\DevData\\Temp\\HuaiDJ-ACE-Agent-20261116-phase2-ui';
const base = path.join(tempRoot, randomUUID());
const out = path.join(base, 'evidence');
fs.mkdirSync(out, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); assert.ok(![8777, 8788, 18788, 18789, 18791].includes(port)); return port; }
function wav(frequency) { const sr = 16000, samples = sr * 20, buffer = Buffer.alloc(44 + samples * 2); buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sr, 24); buffer.writeUInt32LE(sr * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40); for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / sr) * 3000), 44 + i * 2); return buffer; }
async function server(handler) { const instance = http.createServer(handler); await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve)); return { instance, url: 'http://127.0.0.1:' + instance.address().port }; }
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

(async () => {
  const { createMusicService } = await import(pathToFileURL(path.join(project, 'agent/lib/music-service.mjs')).href);
  const stateDir = path.join(base, 'state'), musicDir = path.join(stateDir, 'music-agent'), artifactsDir = path.join(base, 'artifacts'); fs.mkdirSync(artifactsDir);
  const service = createMusicService({ stateDir: musicDir });
  const dictionary = service.call('dictionary');
  const compiled = service.call('prompt_compile', { natural_language: 'sub bass, micro swing, spatial depth, instrumental', model: 'ace-step-v1.5-xl', mode: 'custom', lyrics: '', seed: 11 });
  assert.equal(compiled.ok, true);
  const session = service.call('session_create', { goal: 'Isolated UI fixture', max_generations: 10, max_depth: 2 }).session;
  const prepared = service.call('generation_prepare', { plan_id: compiled.plan.id, session_id: session.id, idempotency_key: 'fixture-origin', reviewed: true, api_parameters: { step: { mode: 'standard', duration_sec: 20 } } });
  assert.equal(prepared.ok, true); service.close();
  const db = new DatabaseSync(path.join(musicDir, 'music-agent.sqlite'));
  const assetIds = ['artifact_ui_a', 'artifact_ui_b'];
  for (const [index, id] of assetIds.entries()) {
    const bytes = wav(index ? 130 : 90), file = path.join(artifactsDir, id + '.wav'); fs.writeFileSync(file, bytes);
    const accepted = index === 1;
    const asset = { id, title: '低頻候選 ' + (index ? 'B' : 'A') + ' · 測試素材', path: file, sha256: sha(bytes), bytes: bytes.length, format: 'wav', duration: 20, codec: 'pcm_s16le', sample_rate: 16000, channels: 1,
      source_job: prepared.job.id, remote_task_id: 'so_seed_' + index, requested_model: 'ace-step-1.5-xl', actual_model: 'ace-step-1.5-xl', real_or_mock: 'mock', versions: compiled.plan.versions,
      generation_depth: 0, parent_ids: [], rights_snapshot: { status: 'fixture_only', commercial_use: 'unknown' }, human_listen: { status: accepted ? 'accepted' : 'awaiting_listen', accepted },
      technical_review: { full_decode: true, status: 'technical_pass', evidence_scope: 'seeded_ui_fixture_only', measurements: { peak_dbfs: -20, integrated_lufs: null }, heuristics: { likely_silent: false, possible_clipping: false } } };
    db.prepare('INSERT INTO assets VALUES(?,?)').run(id, JSON.stringify(asset));
  }
  const job = { ...prepared.job, status: 'awaiting_listen', artifacts: assetIds };
  db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id); db.close();
  const generatedAudio = wav(190), providerRequests = [], externalRequests = [];
  let postCount = 0, statusCount = 0;
  const provider = await server(async (req, res) => {
    providerRequests.push({ method: req.method, path: req.url });
    if (req.url === '/api/status') return json(res, { models: ['acemusic-v1', 'acemusic-v1.1', 'ace-step-1.5-xl'].map(id => ({ id, free: true, limits: { prompt: 2000, style: id.includes('step') ? 512 : 1000, lyrics: id.includes('step') ? 2000 : 5000 } })), costs: { song: 0 }, user: { credits: 0, plan: 'mock_fixture' } });
    if (req.method === 'POST' && req.url === '/api/custom') { postCount++; const chunks = []; for await (const chunk of req) chunks.push(chunk); assert.equal(JSON.parse(Buffer.concat(chunks)).model, 'ace-step-1.5-xl'); return json(res, { songs: [{ task_id: 'so_ui_generated', status: 'queued', model: 'ace-step-1.5-xl' }] }); }
    if (req.url.startsWith('/api/songs?ids=')) { statusCount++; return json(res, { items: [{ task_id: 'so_ui_generated', status: statusCount > 1 ? 'succeeded' : 'running', model: 'ace-step-1.5-xl', ...(statusCount > 1 ? { local_audio: '/data/generated.wav' } : {}) }] }); }
    if (req.url === '/data/generated.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': generatedAudio.length }); return res.end(generatedAudio); }
    if (req.url.startsWith('/api/songs')) return json(res, { items: [], next: null });
    res.writeHead(404); res.end('{}');
  });
  const mixcore = await server((req, res) => { externalRequests.push({ method: req.method, path: req.url }); assert.equal(req.method, 'GET'); json(res, { schema: 'baddj.status.v1', service: 'baddj.mixcore', server: 'baddj-mixcore', api_version: 1, version: '0.4.1', capabilities: {}, counts: {} }); });
  const sessionFile = write(path.join(base, 'fake-session.json'), { cookie: 'ui_fixture=local_only', ua: 'UIFixture' });
  const cache = path.join(stateDir, 'cache'); write(path.join(cache, 'songs.json'), { cachedAt: Date.now(), songs: [], known: [] }); write(path.join(cache, 'fs-index.json'), { cachedAt: Date.now(), files: [], rel: [], names: [] }); write(path.join(cache, 'session-status.json'), { cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: fs.statSync(sessionFile).mtimeMs, status: { authenticated: true } }); write(path.join(stateDir, 'page-songs.json'), { savedAt: Date.now(), songs: [] });
  const grantFile = write(path.join(base, 'fixture-grant.json'), { grant_id: 'ui-fixture-only', provider: 'ace', models: ['ace-step-1.5-xl'], modes: ['custom'], max_credits_per_request: 0, max_credits_total: 0, max_generations: 1, expires_at: new Date(Date.now() + 180000).toISOString(), allow_upload: false, allow_auto_continue: false });
  const runtimeFile = write(path.join(base, 'runtime.json'), { artifacts_dir: artifactsDir, poll_interval_ms: 1000, mixcore_url: mixcore.url });
  const port = await freePort(), url = 'http://127.0.0.1:' + port + '/music';
  const env = { ...process.env, TEMP: base, TMP: base, ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: path.join(base, 'downloads'), ACE_SESSION_FILE: sessionFile, LOCALAPPDATA: path.join(base, 'local-appdata'), ACE_BASE_URL: provider.url,
    ACE_HUB_HOST: '127.0.0.1', ACE_HUB_PORT: String(port), ACE_HUB_URL: new URL(url).origin, ACE_HUB_TOKEN: '', ACE_HUB_EXTENSIONS: '', ACE_GENERATION_GRANT_FILE: grantFile,
    ACE_MUSIC_RUNTIME_CONFIG: runtimeFile, ACE_MUSIC_ARTIFACTS_DIR: artifactsDir, ACE_RESEARCH_CONFIG_FILE: '', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: '' };
  const hub = spawn(process.execPath, [path.join(project, 'agent/hub.mjs')], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let hubLogs = ''; hub.stdout.on('data', chunk => { hubLogs += chunk; }); hub.stderr.on('data', chunk => { hubLogs += chunk; }); const hubExit = new Promise(resolve => hub.on('exit', resolve));
  const errors = [], consoleErrors = [], outside = [], researchCalls = [], researchJobs = [], evidence = [], candidates = [], snapshots = []; let activated = false;
  let browser;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (hub.exitCode !== null) throw new Error(hubLogs); try { if ((await fetch(new URL('/health', url))).ok) break; } catch {} await delay(60); }
    await new Promise((resolve, reject) => {
      const legacy = spawn(process.execPath, [path.join(project, 'scripts/verify-music-ui.cjs')], { cwd: project, env: { ...env, MUSIC_PREVIEW_URL: url, MUSIC_UI_EVIDENCE: path.join(out, 'preparation-regression') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const timer = setTimeout(() => { legacy.kill(); reject(new Error('preparation UI regression timed out')); }, 45000);
      legacy.stdout.on('data', chunk => { output += chunk; }); legacy.stderr.on('data', chunk => { output += chunk; });
      legacy.on('error', error => { clearTimeout(timer); reject(error); }); legacy.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(output)); });
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('request', req => { if (new URL(req.url()).origin !== new URL(url).origin) outside.push(req.url()); });
    await page.route('**/music/research**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname, body = req.method() === 'POST' ? req.postDataJSON() || {} : {};
      if (req.method() === 'POST') researchCalls.push({ pathname, body });
      let result;
      if (pathname === '/music/research') result = { ok: true, status: 'ready', execution_enabled: true, budget: { max_usd: 1, reserved_usd: 0, estimated_spent_usd: evidence.length ? 0.00075 : 0, actual_spent_usd: null } };
      else if (pathname.endsWith('/library')) result = { ok: true, jobs: researchJobs, evidence, candidates, snapshots };
      else if (pathname.endsWith('/prepare')) { const value = { id: 'research_ui_fixture', status: 'prepared', request: { body: { query: body.query } }, estimated_cost_usd: 0.00075, actual_cost_usd: null }; researchJobs.push(value); result = { ok: true, job: value }; }
      else if (pathname.endsWith('/run')) { researchJobs[0].status = 'completed'; evidence.push({ id: 'evidence_ui_fixture', title: '測試來源 · 非真實研究', source_url: 'https://example.org/fixture-not-a-real-source', source: 'mock_fixture', rights_status: 'licensed', ai_ingestion_allowed: true, summary: '這是介面驗證使用的公開文字範例。', facts: ['測試事實：介面會分開顯示資料與推測。'], inferences: ['測試推測：這些用詞可能適合律動描述。'] }); result = { ok: true, status: 'queued', job_id: body.job_id }; }
      else if (pathname.endsWith('/terms/review')) { assert.equal(body.reviewed_by, 'user'); Object.assign(candidates[0], { status: body.approved ? 'approved_candidate' : 'rejected', dictionary_snapshot_id: body.approved ? 'snapshot_ui_fixture' : null }); snapshots.push({ id: 'snapshot_ui_fixture' }); result = { ok: true, candidate: candidates[0] }; }
      else if (pathname.endsWith('/terms')) { candidates.push({ id: 'candidate_ui_fixture', status: 'awaiting_review', terms: body.terms }); result = { ok: true, candidate: candidates[0] }; }
      else if (pathname.endsWith('/stop')) result = { ok: true, status: 'stopped' };
      else result = { ok: false, status: 'unsupported' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    });
    await page.route('**/music/dictionary/activate', async route => { assert.equal(route.request().postDataJSON().snapshot_id, 'snapshot_ui_fixture'); activated = true; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
    await page.goto(url); await page.locator('#notice').filter({ hasText: '本機工作台已連線' }).waitFor();
    const a = page.locator('[data-key="artifact_ui_a"]'), b = page.locator('[data-key="artifact_ui_b"]');
    assert.equal(await a.getByRole('button', { name: '加入主佇列', exact: true }).isDisabled(), true);
    assert.equal(await a.locator('audio').getAttribute('preload'), 'none');
    assert.equal(await a.locator('audio').getAttribute('autoplay'), null);
    await a.getByRole('textbox', { name: '試聽短評' }).fill('尚未送出的節奏評語');
    await a.locator('audio').evaluate(async audio => { audio.muted = true; audio.loop = true; window.fixtureAudio = audio; await audio.play(); });
    const before = await a.locator('audio').evaluate(audio => audio.currentTime);
    for (let n = 0; n < 3; n++) await page.locator('#refresh').click();
    await page.waitForTimeout(5500);
    assert.equal(await a.locator('audio').evaluate(audio => audio === window.fixtureAudio && !audio.paused), true);
    assert.ok(await a.locator('audio').evaluate(audio => audio.currentTime) > before);
    assert.equal(await a.getByRole('textbox', { name: '試聽短評' }).inputValue(), '尚未送出的節奏評語');
    await a.getByRole('combobox', { name: '試聽評分', exact: true }).selectOption('0');
    await a.locator('details').filter({ hasText: '分維度評語' }).locator('summary').click();
    await a.getByRole('combobox', { name: '律動評語', exact: true }).selectOption('1');
    await a.getByRole('button', { name: '接受並保存評語' }).click();
    await a.locator('.asset-status').filter({ hasText: '人工已接受' }).waitFor();
    const feedback = await page.evaluate(async () => (await fetch('/music/state')).json());
    assert.equal(feedback.feedback.find(value => value.artifact_id === 'artifact_ui_a').explicit_rating, 0);
    assert.equal(feedback.feedback.find(value => value.artifact_id === 'artifact_ui_a').dimensions.rhythm, 1);
    await a.getByRole('button', { name: '加入主佇列' }).click(); await b.getByRole('button', { name: '加入離線備用' }).click();
    await page.locator('#main-queue').filter({ hasText: '候選 A' }).waitFor(); await page.locator('#backup-queue').filter({ hasText: '候選 B' }).waitFor();
    await page.locator('#buffer-form button').click(); assert.match(await page.locator('#buffer-result').innerText(), /未知/);
    await page.locator('#target-minutes').fill('1'); await page.locator('#generation-p95').fill('30'); await page.locator('#buffer-form button').click();
    await page.locator('#engine-probe').click(); await page.locator('#engine-info').filter({ hasText: '0.4.1' }).waitFor();
    for (const action of ['takeover', 'pause', 'resume']) await page.locator('[data-performance="' + action + '"]').click();
    await page.locator('#manifest').click(); await page.locator('#manifest-detail').waitFor({ state: 'visible' });
    await a.getByRole('button', { name: '準備下一輪預覽' }).click(); await page.locator('#notice').filter({ hasText: '下一輪預覽已保存' }).waitFor();
    assert.equal(postCount, 0, 'iteration creates a preview only');
    await page.locator('#advanced-controls summary').click(); await page.locator('#step-duration').fill('1');
    await page.locator('#model').selectOption('acemusic-v1'); assert.equal(await page.locator('#step-duration').isDisabled(), true, 'inapplicable invalid controls never block another model');
    await page.locator('#model').selectOption('ace-step-v1.5-xl'); await page.locator('#step-duration').fill('20');
    await page.route('**/music/prompts/compile', async route => { await delay(200); await route.continue(); }, { times: 1 });
    await page.getByRole('button', { name: '產生方向預覽', exact: true }).click(); await page.locator('#intent').fill('sub bass, micro swing, spatial depth, instrumental');
    await page.locator('#notice').filter({ hasText: '輸入已變更，請重新預覽' }).waitFor(); assert.equal(await page.locator('#prepare').isDisabled(), true, 'late compile responses never reauthorize edited input');
    await page.getByRole('button', { name: '產生方向預覽', exact: true }).click(); await page.locator('#notice').filter({ hasText: '預覽已保存' }).waitFor();
    await page.locator('#reviewed').check(); await page.locator('#prepare').click(); await page.locator('#notice').filter({ hasText: '已保存待授權任務' }).waitFor();
    const pendingRow = page.locator('#jobs .job-row').filter({ hasText: '待授權 · 未提交' }).first();
    await pendingRow.locator('summary').click(); assert.match(await pendingRow.innerText(), /預留：未知/, 'a local draft does not invent a zero-credit provider reservation');
    await page.locator('#jobs button:enabled').filter({ hasText: '交給已授權執行器' }).first().click();
    const collectDeadline = Date.now() + 20000;
    let collected = false;
    while (Date.now() < collectDeadline) {
      const latest = await (await fetch(new URL('/music/state', url))).json();
      if (latest.jobs.some(job => job.remote_task_ids?.includes('so_ui_generated') && job.status === 'awaiting_listen')) { collected = true; break; }
      await delay(150);
    }
    assert.equal(collected, true, JSON.stringify(providerRequests));
    await page.locator('#refresh').click(); assert.equal(postCount, 1);
    assert.equal(await a.locator('audio').evaluate(audio => audio === window.fixtureAudio && !audio.paused), true, 'new candidate insertion leaves the original player intact');
    await page.locator('#research-query').fill('public percussion vocabulary'); await page.locator('#research-form button').click();
    assert.equal(await page.locator('#research-query').inputValue(), 'public percussion vocabulary');
    await page.getByRole('button', { name: '執行這項已授權研究', exact: true }).click(); await page.locator('#evidence').filter({ hasText: '測試來源' }).waitFor();
    await page.locator('#research > details > summary').click(); await page.locator('#term-source').selectOption('evidence_ui_fixture'); await page.locator('#term-zh').fill('緩慢脈衝'); await page.locator('#term-en').fill('slowly evolving pulse'); await page.locator('#term-definition').fill('測試詞條的用途與前提'); await page.locator('#term-form button').click();
    const candidate = page.locator('[data-key="candidate_ui_fixture"]'); assert.equal(await candidate.getByRole('button', { name: '啟用這版詞典' }).isDisabled(), true);
    await candidate.getByRole('textbox', { name: '詞條審閱理由' }).fill('已檢查測試來源與用法'); await candidate.getByRole('button', { name: '同意這組詞條' }).click(); await candidate.getByRole('button', { name: '啟用這版詞典' }).click(); await page.locator('#notice').filter({ hasText: '已啟用已審詞典' }).waitFor(); assert.equal(activated, true);
    assert.equal(researchCalls.find(call => call.pathname.endsWith('/prepare')).body.query, 'public percussion vocabulary');
    assert.equal(researchCalls.some(call => JSON.stringify(call.body).includes('sub bass')), false, 'private creative direction is not copied to research');
    const layouts = [];
    for (const width of [1440, 768, 390]) { await page.setViewportSize({ width, height: 1080 }); layouts.push(await page.evaluate(() => ({ width: innerWidth, document_width: document.documentElement.scrollWidth }))); await page.screenshot({ path: path.join(out, 'phase2-' + width + '.png'), fullPage: true }); }
    assert.ok(layouts.every(value => value.document_width <= value.width), JSON.stringify(layouts));
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(outside, []); assert.ok(externalRequests.every(value => value.method === 'GET'));
    const report = { ok: true, checked_at: new Date().toISOString(), url, evidence_dir: out, browser: await browser.version(), layouts, page_errors: errors, console_errors: consoleErrors, external_browser_requests: outside, preparation_ui_regression: 'passed', fixture_generation_posts: postCount, real_generation: 'not_run_by_this_verifier', research: 'browser_mock_routes_only', listening: 'synthetic_muted_fixture_only', playback_survived_refresh: true, feedback_zero_preserved: true, explicit_term_review: true, external_engine: 'isolated_mock_read_only', auto_play: false };
    fs.writeFileSync(path.join(out, 'phase2-ui-verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    if (hub.exitCode === null) { await fetch(new URL('/shutdown', url), { method: 'POST' }).catch(() => hub.kill()); await hubExit; }
    await new Promise(resolve => provider.instance.close(resolve)); await new Promise(resolve => mixcore.instance.close(resolve));
    fs.writeFileSync(path.join(out, 'hub-fixture.log'), hubLogs);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
