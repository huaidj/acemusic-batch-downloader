import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const MODELS = ['acemusic-v1', 'acemusic-v1.1', 'ace-step-1.5-xl'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idea = { mode: 'idea', model: 'acemusic-v1.1', prompt: 'Weighty sub bass, subtle micro swing, instrumental.' };
const customStep = { mode: 'custom', model: 'ace-step-1.5-xl', style: 'Sub bass, micro swing, instrumental.', lyrics: '', step: { mode: 'standard', duration_sec: 30, bpm: 120, time_signature: '4/4', key: 'C minor', thinking: 70 } };
const grant = () => ({ grant_id: 'isolated-create-grant', provider: 'ace', models: MODELS, modes: ['idea', 'custom'], max_credits_per_request: 2, max_credits_total: 6, max_generations: 3,
  expires_at: new Date(Date.now() + 60000).toISOString(), allow_upload: false, allow_auto_continue: false });

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(![8777, 8788].includes(port));
  return port;
}

function spawnNode(args, env) {
  const child = spawn(process.execPath, args, { cwd: PROJECT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, ended, output: () => ({ stdout, stderr }) };
}

async function exitWithin(proc) {
  let timer;
  try { return await Promise.race([proc.ended, new Promise((_, reject) => { timer = setTimeout(() => { proc.child.kill(); reject(new Error(JSON.stringify(proc.output()))); }, 8000); })]); }
  finally { clearTimeout(timer); }
}

function rpcClient(proc) {
  let id = 0, buffer = '';
  const pending = new Map();
  proc.child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line), request = pending.get(message.id);
      if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
    }
  });
  return {
    async call(method, params = {}) {
      const serial = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(serial); reject(new Error('MCP response timeout')); }, 7000);
        pending.set(serial, { resolve, timer });
        proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: serial, method, params }) + '\n');
      });
    },
  };
}

async function startFixture(t, { allowed = false, dropSubmission = false, baseUrlOverride, taskStatusDelayMs = 0 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-create-hub-'));
  const stateDir = path.join(base, 'hub-state'), cacheDir = path.join(stateDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const sessionFile = path.join(stateDir, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ cookie: 'fixture_session=local_only', ua: 'IsolatedCreateFixture', savedAt: Date.now() }));
  fs.writeFileSync(path.join(cacheDir, 'songs.json'), JSON.stringify({ cachedAt: Date.now(), songs: [], known: [] }));
  fs.writeFileSync(path.join(cacheDir, 'fs-index.json'), JSON.stringify({ cachedAt: Date.now(), files: [], rel: [], names: [] }));
  fs.writeFileSync(path.join(cacheDir, 'session-status.json'), JSON.stringify({ cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: fs.statSync(sessionFile).mtimeMs, status: { authenticated: true } }));
  fs.writeFileSync(path.join(stateDir, 'page-songs.json'), JSON.stringify({ savedAt: Date.now(), songs: [] }));
  const requests = [], submissions = [];
  const provider = http.createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/api/status') {
      assert.equal(req.headers.cookie, 'fixture_session=local_only');
      return json({ models: MODELS.map(id => ({ id, limits: { prompt: 2000, style: id === 'ace-step-1.5-xl' ? 512 : 1000, lyrics: id === 'ace-step-1.5-xl' ? 2000 : 5000 } })), costs: { song: 2 }, user: { credits: 100, plan: 'fixture' } });
    }
    if (req.method === 'POST' && ['/api/idea', '/api/custom'].includes(req.url)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      submissions.push({ endpoint: req.url, body });
      if (dropSubmission) { req.socket.destroy(); return; }
      return json({ songs: [{ task_id: 'so_fixture_' + submissions.length, model: body.model, status: 'queued' }] });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/songs')) {
      const ids = new URL(req.url, 'http://127.0.0.1').searchParams.get('ids');
      if (ids) {
        if (taskStatusDelayMs) await sleep(taskStatusDelayMs);
        return json({ items: ids.split(',').map(task_id => ({ task_id, status: 'succeeded', model: 'acemusic-v1.1', local_audio: '/data/fixture.mp3' })), next: null, ver: 1 });
      }
      return json({ items: [], next: null, ver: 1 });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const grantFile = path.join(base, 'grant.json');
  if (allowed) fs.writeFileSync(grantFile, JSON.stringify(grant()));
  let proc, url, currentEnv;
  async function launch(withGrant = allowed) {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    currentEnv = { ...process.env, TEMP: base, TMP: base, ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: path.join(base, 'downloads'),
      LOCALAPPDATA: path.join(base, 'local-appdata'), ACE_BASE_URL: baseUrlOverride ?? providerUrl,
      ACE_HUB_HOST: '127.0.0.1', ACE_HUB_PORT: String(port), ACE_HUB_URL: url, ACE_HUB_TOKEN: '', ACE_HUB_EXTENSIONS: '',
      ACE_GENERATION_GRANT_FILE: withGrant ? grantFile : '' };
    proc = spawnNode([path.join(PROJECT, 'agent', 'hub.mjs')], currentEnv);
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (proc.child.exitCode !== null) throw new Error('fixture Hub exited: ' + JSON.stringify(proc.output()));
      try { if ((await fetch(url + '/health', { signal: AbortSignal.timeout(600) })).ok) return; } catch { /* startup */ }
      await sleep(35);
    }
    throw new Error('fixture Hub did not start: ' + JSON.stringify(proc.output()));
  }
  async function stop() {
    if (!proc || proc.child.exitCode !== null) return;
    try { await fetch(url + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(1000) }); }
    catch { proc.child.kill(); }
    await exitWithin(proc);
  }
  t.after(async () => { await stop(); await new Promise(resolve => provider.close(resolve)); });
  await launch();
  const request = (route, init = {}) => fetch(url + route, { ...init, signal: AbortSignal.timeout(6000) });
  const post = (route, input) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return { base, stateDir, requests, submissions, request, post,
    get env() { return currentEnv; },
    async restartWithoutGrant() { await stop(); await launch(false); },
    async prepare(input) { const response = await post('/create-api/prepare', input); assert.equal(response.status, 200); return response.json(); },
    async receipt(key) { return (await post('/create-api/receipt', { idempotency_key: key })).json(); },
    async waitJob(id) {
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const job = (await (await request('/jobs/' + id)).json()).job;
        if (job && ['done', 'failed', 'unresolved', 'cancelled', 'interrupted'].includes(job.status)) return job;
        await sleep(25);
      }
      throw new Error('fixture job did not finish');
    },
  };
}

const wrapper = (input, prepared, key) => ({ input, reviewed_request_hash: prepared.request_hash, idempotency_key: key });

test('Create prepare is local across all standard models; missing grants deny before status reads; CLI and MCP share its contract', async t => {
  const fix = await startFixture(t);
  const capabilities = await (await fix.request('/create-api/capabilities')).json();
  assert.equal(capabilities.ok, true);
  assert.deepEqual(capabilities.models.map(model => model.id), MODELS);
  for (const key of ['mode', 'custom_mode', 'prompt', 'style', 'lyrics', 'references', 'media', 'covers', 'step', 'step_reference', 'hd', 'surface', 'payload', 'created_at', 'analytics']) assert.ok(key in capabilities.input_schema.properties, key);
  for (const model of MODELS) {
    const ideaPrepared = await fix.prepare({ ...idea, model });
    assert.equal(ideaPrepared.request.endpoint, '/api/idea');
    assert.equal(ideaPrepared.request.body.model, model);
    const custom = model === 'ace-step-1.5-xl' ? customStep : { mode: 'custom', model, style: 'Sub bass and micro swing', lyrics: '' };
    const customPrepared = await fix.prepare(custom);
    assert.equal(customPrepared.request.endpoint, '/api/custom');
    assert.equal(customPrepared.request.body.model, model);
  }
  assert.equal(fix.requests.filter(item => item.path === '/api/status').length, 0);
  const prepared = await fix.prepare(idea);
  const before = fix.requests.length;
  const blocked = await fix.post('/create-api/submit', wrapper(idea, prepared, 'missing-grant'));
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).status, 'awaiting_authorization');
  assert.equal(fix.requests.length, before, 'authorization denied before reading provider or credentials');
  const fakeAuthority = await fix.post('/create-api/submit', { ...wrapper(idea, prepared, 'fake-grant'), grant: grant(), authorized: true });
  assert.equal(fakeAuthority.status, 400);
  assert.equal(fix.requests.length, before);
  const preview = await fix.post('/create-api/preview', idea);
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).estimated_credits, 2);
  assert.ok(fix.requests.slice(before).every(item => item.method === 'GET' && item.path === '/api/status'));
  assert.equal(fix.submissions.length, 0);

  const inputFile = path.join(fix.base, 'create-input.json');
  fs.writeFileSync(inputFile, JSON.stringify(idea));
  const cli = await exitWithin(spawnNode([path.join(PROJECT, 'agent', 'cli.mjs'), 'create', 'prepare', '--input', inputFile], fix.env));
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).request_hash, prepared.request_hash);
  const mcp = spawnNode([path.join(PROJECT, 'agent', 'mcp.mjs')], fix.env);
  try {
    const rpc = rpcClient(mcp);
    assert.ok((await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'create-fixture', version: '1' } })).result.serverInfo);
    const listed = await rpc.call('tools/list');
    for (const name of ['ace_create_capabilities', 'ace_create_prepare', 'ace_create_preview', 'ace_create_submit', 'ace_create_authority', 'ace_create_receipt', 'ace_create_stop']) assert.ok(listed.result.tools.some(tool => tool.name === name));
    const caps = await rpc.call('tools/call', { name: 'ace_create_capabilities', arguments: {} });
    assert.deepEqual(JSON.parse(caps.result.content[0].text), capabilities);
    const plan = await rpc.call('tools/call', { name: 'ace_create_prepare', arguments: idea });
    assert.equal(plan.result.isError, false);
    assert.equal(JSON.parse(plan.result.content[0].text).request_hash, prepared.request_hash);
  } finally { mcp.child.stdin.end(); await exitWithin(mcp); }
  assert.equal(fix.submissions.length, 0);
});

test('server grant admits one standard task, persists its receipt, rejects changed replays and stops new submissions', async t => {
  const fix = await startFixture(t, { allowed: true });
  const prepared = await fix.prepare(customStep);
  const submit = await fix.post('/create-api/submit', wrapper(customStep, prepared, 'accepted-once'));
  assert.equal(submit.status, 202, await submit.clone().text());
  const queued = await submit.json();
  const completed = await fix.waitJob(queued.jobId);
  assert.equal(completed.status, 'done', JSON.stringify(completed));
  assert.equal(completed.result.status, 'submitted');
  assert.equal(completed.result.model_verified, true);
  assert.equal(completed.result.artifact_verified, false);
  assert.equal(fix.submissions.length, 1);
  assert.equal(fix.submissions[0].body.model, 'ace-step-1.5-xl');
  assert.equal(fix.submissions[0].body.created_at, Date.parse(queued.reservation.created_at));
  const receipt = await fix.receipt('accepted-once');
  assert.equal(receipt.status, 'submitted');
  assert.deepEqual(receipt.reservation.remote_task_ids, ['so_fixture_1']);
  const retry = await fix.post('/create-api/submit', wrapper(customStep, prepared, 'accepted-once'));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).reused, true);
  assert.equal(fix.submissions.length, 1);
  const changedInput = { ...customStep, style: 'Different rhythmic direction' }, changed = await fix.prepare(changedInput);
  const conflict = await fix.post('/create-api/submit', wrapper(changedInput, changed, 'accepted-once'));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).status, 'idempotency_conflict');
  assert.equal(fix.submissions.length, 1);
  const stop = await fix.post('/create-api/stop', { grant_id: 'isolated-create-grant' });
  assert.equal(stop.status, 200);
  const reads = fix.requests.length;
  assert.equal((await fix.post('/create-api/submit', wrapper(customStep, prepared, 'after-stop'))).status, 403);
  assert.equal(fix.requests.length, reads, 'stopped grant blocks even provider preview');
  assert.equal((await (await fix.request('/create-api/authority')).json()).budget.reserved, 2);
  const core = await fix.post('/music/generations/submit', { job_id: 'no-core-permission' });
  assert.equal(core.status, 404);
  assert.equal((await core.json()).status, 'not_found', 'API grant cannot submit an unknown workflow job');
  await fix.restartWithoutGrant();
  const restored = await fix.receipt('accepted-once');
  assert.deepEqual(restored.reservation, receipt.reservation);
  assert.equal((await fix.post('/create-api/submit', wrapper(customStep, prepared, 'accepted-once'))).status, 200);
  assert.equal((await fix.post('/create-api/submit', wrapper(customStep, prepared, 'new-after-restart'))).status, 403);
  assert.equal(fix.submissions.length, 1);
});

test('a disconnected submission retains an unknown reservation across restart and never retries its POST', async t => {
  const fix = await startFixture(t, { allowed: true, dropSubmission: true });
  const prepared = await fix.prepare(idea), input = wrapper(idea, prepared, 'unknown-once');
  const response = await fix.post('/create-api/submit', input);
  assert.equal(response.status, 202);
  const job = await fix.waitJob((await response.json()).jobId);
  assert.equal(job.status, 'unresolved', JSON.stringify(job));
  assert.equal(job.submission_unknown, true);
  assert.equal(fix.submissions.length, 1);
  assert.equal((await fix.receipt('unknown-once')).status, 'outcome_unknown');
  const summary = await (await fix.request('/create-api/authority')).json();
  assert.equal(summary.budget.reserved, 2);
  assert.equal(summary.budget.spent, 0);
  const reused = await fix.post('/create-api/submit', input);
  assert.equal(reused.status, 200);
  assert.equal((await reused.json()).status, 'outcome_unknown');
  assert.equal(fix.submissions.length, 1);
  await fix.restartWithoutGrant();
  assert.equal((await fix.receipt('unknown-once')).status, 'outcome_unknown');
  assert.equal((await fix.post('/create-api/submit', input)).status, 200);
  assert.equal(fix.submissions.length, 1);
  const missing = await (await fix.request('/create-api/authority')).json();
  assert.equal(missing.status, 'authorization_required');
  assert.equal(missing.ledger[0].budget.reserved, 2);
  assert.equal(missing.ledger[0].slots.outcome_unknown, 1);
});

test('invalid provider configuration leaves pure preparation and local authority recovery available', async t => {
  // The unsupported protocol cannot make an external network request, even if
  // unrelated startup snapshot work tries to use this intentionally bad config.
  const fix = await startFixture(t, { baseUrlOverride: 'invalid://local-fixture' });
  const capabilities = await fix.request('/create-api/capabilities');
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).ok, true);
  const prepared = await fix.prepare(idea);
  assert.equal(prepared.status, 'prepared');
  assert.match(prepared.request_hash, /^[a-f0-9]{64}$/);
  const authority = await fix.request('/create-api/authority');
  assert.equal(authority.status, 200);
  assert.equal((await authority.json()).status, 'authorization_required');
  const receipt = await fix.post('/create-api/receipt', { idempotency_key: 'no-receipt' });
  assert.equal(receipt.status, 422);
  assert.equal((await receipt.json()).status, 'not_found');
  const stop = await fix.post('/create-api/stop', { grant_id: 'no-grant' });
  assert.equal(stop.status, 422);
  assert.equal((await stop.json()).status, 'not_found');
  assert.equal(fix.requests.length, 0, 'local recovery routes never instantiate or call the provider');
  assert.equal((await fix.request('/health')).status, 200);
});

test('CLI and MCP task reads tolerate a provider response slower than the old five-second Hub timeout', async t => {
  const fix = await startFixture(t, { taskStatusDelayMs: 5200 });
  const input = { task_ids: ['so_slow_status'], requested_model: 'acemusic-v1.1' };
  const inputFile = path.join(fix.base, 'task-status.json');
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const mcp = spawnNode([path.join(PROJECT, 'agent', 'mcp.mjs')], fix.env);
  try {
    const rpc = rpcClient(mcp);
    await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'slow-status-fixture', version: '1' } });
    const start = performance.now();
    const cli = spawnNode([path.join(PROJECT, 'agent', 'cli.mjs'), 'create', 'tasks', '--input', inputFile], fix.env);
    const [cliResult, mcpResult] = await Promise.all([
      exitWithin(cli),
      rpc.call('tools/call', { name: 'ace_create_task_status', arguments: input }),
    ]);
    assert.ok(performance.now() - start >= 5000, 'both clients waited for the delayed provider result');
    assert.equal(cliResult.code, 0, cliResult.stderr);
    assert.equal(mcpResult.result.isError, false, JSON.stringify(mcpResult));
    const values = [JSON.parse(cliResult.stdout), JSON.parse(mcpResult.result.content[0].text)];
    for (const value of values) {
      assert.equal(value.ok, true);
      assert.notEqual(value.status, 'hub_required');
      assert.equal(value.complete, true);
      assert.equal(value.model_verified, true);
      assert.equal(value.real_success, false, 'a remote status response does not establish an accepted music artifact');
      assert.deepEqual(value.succeeded_task_ids, ['so_slow_status']);
    }
    assert.equal(fix.requests.filter(item => item.path.startsWith('/api/songs?ids=')).length, 2);
    assert.ok(fix.requests.every(item => item.method === 'GET'));
    assert.equal(fix.submissions.length, 0);
  } finally { mcp.child.stdin.end(); await exitWithin(mcp); }
});
