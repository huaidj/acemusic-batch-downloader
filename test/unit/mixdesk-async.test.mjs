import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { analyzeFiles } from '../../mixdesk/lib/analyzer.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeSource = `
import fs from 'node:fs';
const files = process.argv.slice(2);
const mode = process.env.TEST_ANALYZER_MODE;
if (mode === 'exit') { console.error('fixture analysis failure'); process.exit(2); }
if (mode === 'invalid') { process.stdout.write('{'); process.exit(0); }
if (mode === 'overflow') { process.stdout.write('x'.repeat(8192)); process.exit(0); }
if (mode === 'missing') { process.stdout.write('[]'); process.exit(0); }
if (process.env.TEST_ANALYZER_STARTED) fs.appendFileSync(process.env.TEST_ANALYZER_STARTED, 'start\\n');
setTimeout(() => {
  if (process.env.TEST_ANALYZER_FINISHED) fs.writeFileSync(process.env.TEST_ANALYZER_FINISHED, 'done');
  process.stdout.write(JSON.stringify(files.map(path => ({path, ok:true, duration:8, bpm:124, key:'C', camelot:'8B', energy:0.12}))));
}, Number(process.env.TEST_ANALYZER_DELAY || 0));
`;

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-mix-async-'));
  const analyzer = path.join(base, 'analyzer.mjs');
  fs.writeFileSync(analyzer, fakeSource);
  const library = path.join(base, 'library');
  fs.mkdirSync(library);
  // Bytes are intentionally a fixture, never claimed to be a decoded audio artifact.
  const audio = path.join(library, 'fixture.wav');
  fs.writeFileSync(audio, 'analysis fixture only');
  return { base, analyzer, library, audio };
}

async function waitUntil(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  throw new Error('fixture condition timed out');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startMixdesk(fix, extraEnv = {}) {
  const port = await freePort();
  const stateDir = path.join(fix.base, 'state');
  const started = path.join(fix.base, 'started.txt');
  const finished = path.join(fix.base, 'finished.txt');
  const child = spawn(process.execPath, [path.join(PROJECT, 'mixdesk', 'server.mjs')], {
    cwd: PROJECT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ACE_MIX_PORT: String(port),
      ACE_MIX_HOST: '127.0.0.1',
      ACE_MIX_LIBRARY: fix.library,
      ACE_MIX_STATE_DIR: stateDir,
      ACE_MIX_MOCK_DIR: path.join(fix.base, 'mock'),
      ACE_STATE_DIR: path.join(fix.base, 'agent-state'),
      ACE_DOWNLOAD_DIR: path.join(fix.base, 'downloads'),
      ACE_BASE_URL: 'http://127.0.0.1:9',
      ACE_PYTHON: process.execPath,
      ACE_ANALYZER: fix.analyzer,
      ACE_MIX_ANALYSIS_TIMEOUT_MS: '5000',
      TEST_ANALYZER_DELAY: '1000',
      TEST_ANALYZER_STARTED: started,
      TEST_ANALYZER_FINISHED: finished,
      ...extraEnv,
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const request = (route, init = {}) => fetch(`http://127.0.0.1:${port}${route}`, { ...init, signal: AbortSignal.timeout(6000) });
  try {
    await waitUntil(async () => {
      if (child.exitCode != null) throw new Error('mixdesk exited: ' + output);
      try { return (await request('/api/state')).ok; } catch { return false; }
    });
  } catch (err) {
    child.kill();
    throw err;
  }
  return {
    child, request, stateDir, started, finished,
    async stop() {
      if (child.exitCode != null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    },
  };
}

test('mixdesk analysis keeps state API responsive, including first-run indexing; concurrent indexes serialize', async () => {
  const fix = fixture();
  const server = await startMixdesk(fix);
  try {
    await waitUntil(() => fs.existsSync(server.started));
    assert.equal(fs.existsSync(server.finished), false, 'analyzer must still be working');
    const startedAt = performance.now();
    const state = await (await server.request('/api/state')).json();
    assert.equal(state.indexing.status, 'running');
    assert.equal(state.indexing.processed, 0);
    assert.ok(performance.now() - startedAt < 500, 'state responds during analysis');
    assert.equal(fs.existsSync(server.finished), false, 'state response precedes analyzer completion');
    const results = await Promise.all([1, 2].map(async () => (await server.request('/api/index', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 0 }),
    })).json()));
    assert.ok(results.every((result) => result.ok && result.total === 1 && result.analyzed === 0));
    assert.equal(fs.readFileSync(server.started, 'utf8').trim().split('\n').length, 1, 'cached serial requests do not duplicate analysis');
    const saved = JSON.parse(fs.readFileSync(path.join(server.stateDir, 'state.json'), 'utf8'));
    assert.equal(saved.tracks.length, 1, 'concurrent requests do not duplicate tracks');
    assert.equal(saved.tracks[0].analysisStatus, 'done');
  } finally { await server.stop(); }
});

test('mixdesk persists analysis failures and does not report a successful index', async () => {
  const fix = fixture();
  const server = await startMixdesk(fix, { TEST_ANALYZER_MODE: 'exit', TEST_ANALYZER_DELAY: '0' });
  try {
    await waitUntil(async () => (await (await server.request('/api/state')).json()).indexing.status === 'partial');
    const result = await (await server.request('/api/index', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 0 }),
    })).json();
    assert.equal(result.ok, false);
    assert.equal(result.failed, 1);
    assert.equal(result.errors[0].error.code, 'ANALYZER_EXIT_FAILED');
    const saved = JSON.parse(fs.readFileSync(path.join(server.stateDir, 'state.json'), 'utf8'));
    assert.equal(saved.tracks[0].analyzedAt, null);
    assert.equal(saved.tracks[0].analysisError.code, 'ANALYZER_EXIT_FAILED');
  } finally { await server.stop(); }
});

test('analyzer timeout, invalid/missing JSON, process failure, and output limits are explicit per-file failures', async () => {
  const fix = fixture();
  const scenarios = [
    { mode: 'invalid', code: 'ANALYZER_INVALID_JSON' },
    { mode: 'missing', code: 'ANALYZER_MISSING_RESULT' },
    { mode: 'exit', code: 'ANALYZER_EXIT_FAILED' },
    { mode: 'overflow', code: 'ANALYZER_OUTPUT_LIMIT', maxOutputBytes: 1024 },
    { mode: 'delay', code: 'ANALYZER_TIMEOUT', timeoutMs: 150, delay: 1000 },
  ];
  for (const scenario of scenarios) {
    const result = await analyzeFiles([fix.audio], {
      executable: process.execPath, analyzer: fix.analyzer,
      timeoutMs: scenario.timeoutMs || 3000,
      maxOutputBytes: scenario.maxOutputBytes,
      env: { ...process.env, TEST_ANALYZER_MODE: scenario.mode, TEST_ANALYZER_DELAY: String(scenario.delay || 0) },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].ok, false, scenario.mode);
    assert.equal(result[0].error.code, scenario.code, scenario.mode);
  }
});
