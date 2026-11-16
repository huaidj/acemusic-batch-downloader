import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createMusicRuntime } from '../../agent/lib/music-runtime.mjs';
import { createApiController, createHttp } from '../../agent/lib/create-http.mjs';
import { hubRequest } from '../../agent/lib/hubclient.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const TEMP_ROOT = process.platform === 'win32' ? 'F:\\DevData\\Temp\\HuaiDJ-ACE-Agent-20261116-phase2-artifacts' : path.join(os.tmpdir(), 'HuaiDJ-ACE-Agent-phase2-artifacts');
fs.mkdirSync(TEMP_ROOT, { recursive: true });
const root = label => fs.mkdtempSync(path.join(TEMP_ROOT, label + '-'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const direction = { mode: 'idea', model: 'acemusic-v1.1', prompt: 'Sub bass and subtle micro swing.' };
const researchGrant = () => ({ enabled: true, api_key_env: 'DEEPSEEK_API_KEY', grant_id: 'runtime-research-fixture', budget_usd: 0.001, max_requests: 1, allowed_kinds: ['search'], expires_at: new Date(Date.now() + 60000).toISOString() });

function visitFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isSymbolicLink() ? [] : entry.isDirectory() ? visitFiles(file) : [file];
  });
}

async function withEnv(values, work) {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  try { return await work(); }
  finally { for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

test('runtime reads no credential without explicit enablement and a fixed environment name', async () => {
  const base = root('runtime-default-deny');
  let network = 0, providerReads = 0, credentialReads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { network += 1; throw new Error('network forbidden'); };
  try {
    for (const settings of [{}, { ...researchGrant(), enabled: false }, { ...researchGrant(), api_key_env: 'ARBITRARY_CREDENTIAL' }]) {
      const caseDir = path.join(base, randomUUID());
      const settingsFile = write(path.join(caseDir, 'research.json'), settings);
      const env = { ACE_RESEARCH_CONFIG_FILE: settingsFile };
      Object.defineProperty(env, 'DEEPSEEK_API_KEY', { get() { credentialReads += 1; throw new Error('disabled credential was read'); } });
      Object.defineProperty(env, 'ARBITRARY_CREDENTIAL', { get() { credentialReads += 1; throw new Error('unapproved credential was read'); } });
      const runtime = createMusicRuntime({ cfg: { stateDir: path.join(caseDir, 'state'), baseUrl: settings.enabled === undefined ? 'invalid://default-deny-fixture' : 'http://127.0.0.1:9' }, env,
        createApi: { getTransport() { providerReads += 1; throw new Error('provider must stay lazy'); } } });
      try {
        assert.equal(runtime.research.summary().execution_enabled, false);
        const prepared = runtime.research.prepare({ query: 'micro swing percussion vocabulary' });
        assert.equal(prepared.ok, true);
        const denied = await runtime.research.run(prepared.job.id);
        assert.equal(denied.status, 'auth_required');
      } finally { runtime.research.close(); }
    }
    assert.equal(credentialReads, 0);
    assert.equal(providerReads, 0);
    assert.equal(network, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('enabled research uses only the official provider and never serializes its credential into status or SQLite', async () => {
  const base = root('runtime-research');
  const settingsFile = write(path.join(base, 'research.json'), researchGrant());
  const fakeKey = 'runtime-fixture-credential-' + randomUUID();
  let network = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    network += 1;
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + fakeKey);
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    for (const [label, endpoint, expected] of [['denied-origin', 'https://unexpected.example', 'unsupported'], ['official', '"https://api.deepseek.com/v1"', 'ready']]) {
      const stateDir = path.join(base, label, 'state');
      const runtime = createMusicRuntime({ cfg: { stateDir, baseUrl: 'http://127.0.0.1:9' }, env: {
        ACE_RESEARCH_CONFIG_FILE: settingsFile, DEEPSEEK_API_KEY: ' "' + fakeKey + '" ', DEEPSEEK_BASE_URL: endpoint,
      }, createApi: { getTransport() { throw new Error('ACE transport is not used for text research'); } } });
      try {
        const summary = runtime.research.summary();
        assert.equal(summary.status, expected);
        assert.equal(JSON.stringify(summary).includes(fakeKey), false);
        const planned = runtime.research.prepare({ query: 'micro swing percussion vocabulary', idempotency_key: label });
        const result = await runtime.research.run(planned.job.id);
        assert.equal(result.ok, label === 'official');
        assert.equal(JSON.stringify([result, runtime.research.summary(), runtime.research.events({})]).includes(fakeKey), false);
        if (label === 'denied-origin') assert.equal(network, 0);
      } finally { runtime.research.close(); }
      for (const file of visitFiles(stateDir)) assert.equal(fs.readFileSync(file).includes(Buffer.from(fakeKey)), false, 'credential must not enter local state');
    }
    assert.equal(network, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('runtime rejects overflowing poll intervals instead of turning them into a one-millisecond loop', () => {
  const base = root('runtime-poll-limit');
  for (const interval of ['Infinity', 1e100, -1]) {
    const caseDir = path.join(base, randomUUID());
    const settings = write(path.join(caseDir, 'runtime.json'), { poll_interval_ms: interval });
    const runtime = createMusicRuntime({ cfg: { stateDir: path.join(caseDir, 'state'), baseUrl: 'http://127.0.0.1:9' },
      env: { ACE_MUSIC_RUNTIME_CONFIG: settings }, createApi: { getTransport() { throw new Error('unexpected provider'); } } });
    try { assert.equal(runtime.pollIntervalMs, 10000); }
    finally { runtime.research.close(); }
  }
});

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const readBody = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); };

test('shared Create controller and HTTP preserve one reservation; cancellation never releases an unknown submission', async () => {
  const base = root('runtime-controller'), stateDir = path.join(base, 'state');
  const fakeCookie = 'controller_fixture_cookie=' + randomUUID();
  const sessionFile = write(path.join(base, 'source', 'session.json'), { cookie: fakeCookie });
  let posts = 0;
  const provider = await serve((req, res) => {
    if (req.method === 'POST') posts += 1;
    assert.equal(req.headers.cookie, fakeCookie);
    json(res, 200, { models: [{ id: 'acemusic-v1.1', limits: { prompt: 2000 } }], costs: { song: 2 }, user: { credits: 50 } });
  });
  const grantFile = write(path.join(base, 'grant.json'), { grant_id: 'controller-fixture', provider: 'ace', models: ['acemusic-v1.1'], modes: ['idea'], max_credits_per_request: 2, max_credits_total: 6, max_generations: 3,
    expires_at: new Date(Date.now() + 60000).toISOString(), allow_upload: false, allow_auto_continue: false });
  const queued = [], jobs = [];
  await withEnv({ ACE_GENERATION_GRANT_FILE: grantFile }, async () => {
    const controller = createApiController({ cfg: { stateDir, sessionFile, baseUrl: provider.url, ua: 'Fixture' },
      addJob(kind) { const job = { id: 'fixture_job_' + (jobs.length + 1), kind }; jobs.push(job); return job; },
      enqueue(job, runner) { queued.push({ job, runner }); },
    });
    const handle = createHttp({ controller });
    const endpoint = await serve(async (req, res) => { try { if (!await handle(req, res, new URL(req.url, 'http://127.0.0.1'), { json, readBody })) json(res, 404, {}); } catch { json(res, 500, {}); } });
    try {
      const post = (route, value) => fetch(endpoint.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(3000) });
      const direct = await controller.call('capabilities');
      assert.deepEqual(await (await fetch(endpoint.url + '/create-api/capabilities')).json(), direct);
      const plan = await controller.call('prepare', direction);
      assert.deepEqual(await (await post('/create-api/prepare', direction)).json(), plan);
      const input = key => ({ input: direction, reviewed_request_hash: plan.request_hash, idempotency_key: key });
      const first = await controller.execute('submit', input('queued-before-stop'));
      assert.equal(first.http_status, 202);
      const replay = await post('/create-api/submit', input('queued-before-stop'));
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).reused, true);
      assert.equal(jobs.length, 1);
      assert.equal(queued.length, 1);
      assert.equal((await controller.call('submit', input('unknown-before-stop'))).status, 'queued');
      assert.equal(controller.getAuthority().recordOutcome('unknown-before-stop', { state: 'outcome_unknown' }).ok, true);
      assert.equal((await controller.call('authority')).budget.reserved, 4);
      assert.equal((await controller.call('stop', { grant_id: 'controller-fixture' })).status, 'stopped');
      assert.equal(controller.cancelPending('queued-before-stop').status, 'not_submitted');
      assert.equal(jobs[0].cancelled, true);
      const unknown = controller.cancelPending('unknown-before-stop');
      assert.equal(unknown.ok, false);
      assert.equal(unknown.status, 'outcome_unknown');
      assert.equal(unknown.remote_continues, true);
      assert.equal((await controller.call('authority')).budget.reserved, 2);
      assert.equal((await controller.call('submit', input('queued-before-stop'))).status, 'not_submitted');
      assert.equal((await controller.call('submit', input('unknown-before-stop'))).status, 'outcome_unknown');
      assert.equal(jobs.length, 2);
      assert.equal(posts, 0, 'queued test executors were never dispatched');
    } finally { await endpoint.close(); controller.getAuthority().close(); }
  });
  await provider.close();
});

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(![8777, 8788].includes(port));
  return port;
}

function wavBytes() {
  const audio = Buffer.alloc(44 + 32);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(22050, 24); audio.writeUInt32LE(44100, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(32, 40);
  return audio;
}

test('token Hub streams only exact verified asset IDs and reads the original configured session without copying its cookie', async t => {
  const base = root('runtime-audio'), stateDir = path.join(base, 'state'), artifactsDir = path.join(base, 'artifacts');
  fs.mkdirSync(artifactsDir);
  const data = wavBytes(), validFile = path.join(artifactsDir, 'seeded-test-audio.wav');
  fs.writeFileSync(validFile, data);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  const outsideFile = path.join(outside, 'outside.wav'); fs.writeFileSync(outsideFile, data);
  const link = path.join(artifactsDir, 'external-link'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const sourceCookie = 'original_fixture_cookie=' + randomUUID();
  const sessionFile = write(path.join(base, 'source-session', 'session.json'), { cookie: sourceCookie, ua: 'OriginalSessionFixture' });
  const sourceHash = hash(fs.readFileSync(sessionFile));
  const musicDir = path.join(stateDir, 'music-agent'); fs.mkdirSync(musicDir, { recursive: true });
  const db = new DatabaseSync(path.join(musicDir, 'music-agent.sqlite'));
  db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const seed = (id, file, verified = true) => db.prepare('INSERT INTO assets VALUES(?,?)').run(id, JSON.stringify({
    id, path: file, sha256: hash(data), format: 'wav', bytes: data.length, duration: 16 / 22050,
    source_job: 'seeded_route_fixture', remote_task_id: 'so_seeded_fixture', requested_model: 'acemusic-v1.1', actual_model: 'acemusic-v1.1',
    rights_snapshot: { status: 'fixture_only' }, parent_ids: [], real_or_mock: 'mock',
    technical_review: { full_decode: verified, evidence_scope: 'seeded_route_test_only' },
  }));
  seed('asset_old_verified', validFile);
  for (let n = 0; n < 105; n += 1) seed('asset_newer_' + n, validFile, false);
  seed('asset_unverified', validFile, false); seed('asset_outside', outsideFile); seed('asset_junction', path.join(link, 'outside.wav'));
  seed('asset_missing_file', path.join(artifactsDir, 'missing.wav'));
  db.close();
  const cacheDir = path.join(stateDir, 'cache'); fs.mkdirSync(cacheDir);
  write(path.join(cacheDir, 'songs.json'), { cachedAt: Date.now(), songs: [], known: [] });
  write(path.join(cacheDir, 'fs-index.json'), { cachedAt: Date.now(), files: [], rel: [], names: [] });
  write(path.join(cacheDir, 'session-status.json'), { cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: fs.statSync(sessionFile).mtimeMs, status: { authenticated: true } });
  write(path.join(stateDir, 'page-songs.json'), { savedAt: Date.now(), songs: [] });
  let previews = 0;
  const provider = await serve((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.headers.cookie, sourceCookie);
    if (req.url === '/api/status') { previews += 1; return json(res, 200, { models: [{ id: 'acemusic-v1.1', limits: { prompt: 2000 } }], costs: { song: 2 }, user: { credits: 20 } }); }
    return json(res, 200, { items: [], next: null });
  });
  const port = await freePort(), url = `http://127.0.0.1:${port}`, token = 'fixture-hub-token-' + randomUUID();
  const env = { ...process.env, TEMP: base, TMP: base, ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: path.join(base, 'downloads'), ACE_SESSION_FILE: sessionFile,
    LOCALAPPDATA: path.join(base, 'local-appdata'), ACE_BASE_URL: provider.url, ACE_HUB_HOST: '127.0.0.1', ACE_HUB_PORT: String(port), ACE_HUB_URL: url, ACE_HUB_TOKEN: token,
    ACE_GENERATION_GRANT_FILE: '', ACE_RESEARCH_CONFIG_FILE: '', ACE_MUSIC_RUNTIME_CONFIG: '', ACE_MUSIC_ARTIFACTS_DIR: artifactsDir, DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: '' };
  const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'hub.mjs')], { cwd: PROJECT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  const request = (route, init = {}) => fetch(url + route, { ...init, headers: { 'X-Hub-Token': token, ...init.headers }, signal: AbortSignal.timeout(5000) });
  t.after(async () => {
    if (child.exitCode === null) { await request('/shutdown', { method: 'POST' }).catch(() => child.kill()); await exited; }
    await provider.close();
  });
  const until = Date.now() + 10000;
  let ready = false;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('isolated Hub exited: ' + logs);
    try { if ((await request('/health')).ok) { ready = true; break; } } catch { /* startup */ }
    await sleep(40);
  }
  assert.equal(ready, true, logs);
  assert.equal((await fetch(url + '/health')).status, 401);
  await withEnv({ ACE_HUB_TOKEN: token }, async () => {
    const response = await hubRequest('/create-api/capabilities', { base: url });
    assert.equal(response.status, 200, 'Hub client forwards its configured token');
    assert.equal(response.data.ok, true);
  });
  const full = await request('/music/audio/asset_old_verified');
  assert.equal(full.status, 200, await full.clone().text());
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), data, 'an older asset is addressable beyond the latest 100 rows');
  const range = await request('/music/audio/asset_old_verified', { headers: { Range: 'bytes=4-15' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 4-15/${data.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), data.subarray(4, 16));
  const suffix = await request('/music/audio/asset_old_verified', { headers: { Range: 'bytes=-8' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), data.subarray(-8));
  const invalidRange = await request('/music/audio/asset_old_verified', { headers: { Range: 'bytes=9999-' } });
  assert.equal(invalidRange.status, 416);
  for (const id of ['asset_unverified', 'asset_unknown', 'asset_missing_file']) assert.equal((await request('/music/audio/' + id)).status, 404, id);
  assert.equal((await request('/music/audio/asset_outside')).status, 403);
  assert.equal((await request('/music/audio/asset_junction')).status, 403);
  assert.equal((await request('/music/audio?path=' + encodeURIComponent(outsideFile))).status, 404);
  const preview = await request('/create-api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(direction) });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).estimated_credits, 2);
  assert.equal(previews, 1);
  assert.equal(hash(fs.readFileSync(sessionFile)), sourceHash, 'original source session is unchanged');
  assert.equal(fs.existsSync(path.join(stateDir, 'session.json')), false, 'no copied cookie file is created');
  for (const file of visitFiles(stateDir)) assert.equal(fs.readFileSync(file).includes(Buffer.from(sourceCookie)), false, 'source cookie does not enter new state');
  fs.appendFileSync(validFile, Buffer.from([0]));
  const changed = await request('/music/audio/asset_old_verified');
  assert.equal(changed.status, 409, 'a previously streamed file is rechecked after mutation');
  assert.equal((await changed.text()).includes(validFile), false);
});
