import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MUSIC_TOOLS } from '../../agent/lib/music-contract.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const direction = { natural_language: 'sub bass, micro swing, spatial depth, instrumental', model: 'acemusic-v1.1', mode: 'idea', seed: 51 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(![8777, 8788].includes(port));
  return port;
}

function spawnNode(args, env) {
  const child = spawn(process.execPath, args, { cwd: PROJECT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, ended, output: () => ({ stdout, stderr }) };
}

async function boundedExit(proc, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([proc.ended, new Promise((_, reject) => {
      timer = setTimeout(() => { proc.child.kill(); reject(new Error('fixture process did not finish: ' + JSON.stringify(proc.output()))); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function rpcClient(proc) {
  let serial = 0;
  let buffer = '';
  const pending = new Map();
  proc.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(response.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(response.id); waiter.resolve(response); }
    }
  });
  return {
    notify(method, params = {}) { proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    call(method, params = {}) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP fixture timed out: ' + JSON.stringify(proc.output()))); }, 7000);
        pending.set(id, { resolve, timer });
        proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
  };
}

const toolValue = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result.content[0].type, 'text');
  return JSON.parse(response.result.content[0].text);
};

test('music HTTP, MCP and CLI share the isolated Hub writer and refuse fallback or real provider submission', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-music-hub-'));
  const stateDir = path.join(base, 'hub-state');
  const clientState = path.join(base, 'client-state');
  const cacheDir = path.join(stateDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'songs.json'), JSON.stringify({ cachedAt: Date.now(), songs: [], known: [] }));
  fs.writeFileSync(path.join(cacheDir, 'fs-index.json'), JSON.stringify({ cachedAt: Date.now(), files: [], rel: [], names: [] }));
  fs.writeFileSync(path.join(cacheDir, 'session-status.json'), JSON.stringify({ cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: 0, status: { authenticated: false } }));
  fs.writeFileSync(path.join(stateDir, 'page-songs.json'), JSON.stringify({ savedAt: Date.now(), songs: [] }));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, TEMP: base, TMP: base,
    ACE_HUB_PORT: String(port), ACE_HUB_HOST: '127.0.0.1', ACE_HUB_URL: url, ACE_HUB_TOKEN: '', ACE_HUB_EXTENSIONS: '',
    ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: path.join(base, 'downloads'), LOCALAPPDATA: path.join(base, 'local-appdata'),
    ACE_BASE_URL: 'http://127.0.0.1:9',
  };
  const clientEnv = { ...env, ACE_STATE_DIR: clientState };
  const hub = spawnNode([path.join(PROJECT, 'agent', 'hub.mjs')], env);
  let mcp;
  const req = (route, init = {}) => fetch(url + route, { ...init, signal: AbortSignal.timeout(6000) });
  const post = (route, value, headers = {}) => req(route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  try {
    const deadline = Date.now() + 12000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (hub.child.exitCode !== null) throw new Error('fixture Hub exited: ' + JSON.stringify(hub.output()));
      try { if ((await req('/health')).ok) { healthy = true; break; } } catch { /* isolated startup */ }
      await sleep(50);
    }
    assert.ok(healthy, JSON.stringify(hub.output()));
    const lock = JSON.parse(fs.readFileSync(path.join(stateDir, 'hub.lock'), 'utf8'));
    assert.equal(lock.pid, hub.child.pid);
    const duplicate = spawnNode([path.join(PROJECT, 'agent', 'hub.mjs')], env);
    assert.equal((await boundedExit(duplicate)).code, 2, 'same state refuses another Hub writer');

    const page = await req('/music');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const policy = page.headers.get('content-security-policy');
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /connect-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const html = await page.text();
    assert.match(html, /HuaiDJ/);
    for (const asset of ['/music/app.js', '/music/app.css', '/music/tokens.css']) {
      assert.ok(html.includes(asset));
      const response = await req(asset);
      assert.equal(response.status, 200, asset);
      assert.ok((await response.text()).length > 50, asset);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)=["']https?:/i, 'workbench assets stay local');
    const capabilities = await (await req('/music/capabilities')).json();
    assert.equal(capabilities.ok, true);
    assert.equal(capabilities.capabilities.live_submission_enabled, false);
    assert.equal(capabilities.capabilities.models.length, 3);
    const compiled = await (await post('/music/prompts/compile', direction)).json();
    assert.equal(compiled.ok, true, JSON.stringify(compiled));
    const session = await (await post('/music/sessions', { max_generations: 2, max_depth: 1 })).json();
    assert.equal(session.ok, true);
    const preparation = { plan_id: compiled.plan.id, session_id: session.session.id, idempotency_key: 'transport-idem', reviewed: true };
    const first = await (await post('/music/generations/prepare', preparation)).json();
    const second = await (await post('/music/generations/prepare', preparation)).json();
    assert.equal(first.status, 'awaiting_authorization');
    assert.equal(second.reused, true);
    assert.equal(first.job.id, second.job.id);
    const submitResponse = await post('/music/generations/submit', { job_id: first.job.id });
    assert.equal(submitResponse.status, 422);
    assert.equal((await submitResponse.json()).status, 'unsupported');
    assert.equal((await post('/music/prompts/compile', direction, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await req('/music/capabilities', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    for (const input of [{ ...direction, natural_language: 42 }, { ...direction, authorized: true }]) {
      const bad = await post('/music/prompts/compile', input);
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).status, 'invalid');
    }
    const invalidJson = await req('/music/prompts/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalidJson.status, 400);

    mcp = spawnNode([path.join(PROJECT, 'agent', 'mcp.mjs')], clientEnv);
    const rpc = rpcClient(mcp);
    const initialize = await rpc.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'isolated-test', version: '1' } });
    assert.equal(initialize.result.serverInfo.name, 'ace-music-downloader');
    rpc.notify('notifications/initialized');
    const listed = await rpc.call('tools/list');
    const names = listed.result.tools.map((tool) => tool.name);
    for (const tool of MUSIC_TOOLS) assert.ok(names.includes(tool.name), tool.name);
    assert.ok(names.includes('ace_overview'), 'existing tools stay available');
    const mcpResult = await rpc.call('tools/call', { name: 'music_prompt_compile', arguments: { ...direction, seed: 52 } });
    assert.equal(mcpResult.result.isError, false);
    const mcpPlan = toolValue(mcpResult);
    assert.equal(mcpPlan.ok, true);
    assert.equal(mcpPlan.persisted, true);
    assert.notEqual(mcpPlan.plan.id, compiled.plan.id);
    const shared = await (await req('/music/state')).json();
    assert.ok(shared.plans.some((plan) => plan.id === mcpPlan.plan.id), 'MCP persisted through the Hub');
    assert.equal(shared.jobs.length, 1);
    assert.equal(shared.provider_calls, 0);
    const cli = await boundedExit(spawnNode([path.join(PROJECT, 'agent', 'cli.mjs'), 'music', 'capabilities'], clientEnv));
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), capabilities);
    assert.equal(fs.existsSync(path.join(clientState, 'music-agent', 'music-agent.sqlite')), false, 'clients did not create a second ledger');

    await post('/shutdown', {});
    assert.equal((await boundedExit(hub)).code, 0);
    const offline = await rpc.call('tools/call', { name: 'music_prompt_compile', arguments: { ...direction, seed: 53 } });
    assert.equal(offline.result.isError, true);
    assert.equal(toolValue(offline).status, 'hub_required');
    const inputFile = path.join(base, 'offline-plan.json');
    fs.writeFileSync(inputFile, JSON.stringify({ ...direction, seed: 54 }));
    const offlineCli = await boundedExit(spawnNode([path.join(PROJECT, 'agent', 'cli.mjs'), 'music', 'prompt_compile', '--input', inputFile], clientEnv));
    assert.equal(offlineCli.code, 1);
    assert.equal(offlineCli.stdout.trim(), '');
    assert.equal(fs.existsSync(path.join(clientState, 'music-agent', 'music-agent.sqlite')), false, 'unavailable Hub does not trigger a local writer');
  } finally {
    if (mcp && mcp.child.exitCode === null) { mcp.child.stdin.end(); await boundedExit(mcp); }
    if (hub.child.exitCode === null) { hub.child.kill(); await boundedExit(hub); }
  }
});
