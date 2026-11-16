// 付費生成入口：隔離 mock 站、持久化防重、舊 Hub 與模糊失敗不回落送出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMP_ROOT = path.resolve(process.env.ACE_TEST_TMP || os.tmpdir());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serve(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sandbox(siteUrl) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const base = fs.mkdtempSync(path.join(TEMP_ROOT, 'acedl-generation-integration-'));
  const stateDir = path.join(base, 'state');
  const downloadDir = path.join(base, 'downloads');
  fs.mkdirSync(path.join(stateDir, 'cache'), { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'session.json'), JSON.stringify({ cookie: 'mock-session=local-only', savedAt: Date.now() }));
  fs.writeFileSync(path.join(stateDir, 'cache', 'songs.json'), JSON.stringify({ cachedAt: Date.now(), songs: [], known: [] }));
  fs.writeFileSync(path.join(stateDir, 'cache', 'fs-index.json'), JSON.stringify({ cachedAt: Date.now(), files: [], names: [], rel: [] }));
  return { base, stateDir, env: { ...process.env, ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: downloadDir, ACE_BASE_URL: siteUrl } };
}

function cleanSandbox(sb) {
  const target = path.resolve(sb.base);
  assert.equal(path.dirname(target), TEMP_ROOT);
  assert.ok(path.basename(target).startsWith('acedl-generation-integration-'));
  fs.rmSync(target, { recursive: true, force: true });
}

async function mockSite({ disconnect = false, delayMs = 0 } = {}) {
  const writes = [];
  const reads = [];
  const state = { credits: 100, statusReads: 0 };
  const site = await serve(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/status') {
      state.statusReads += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, costs: { song: 4 }, models: [{ id: 'acemusic-v1.1', limits: { prompt: 2000, style: 1000, lyrics: 5000 } }], user: { credits: state.credits, plan: 'artist' } }));
    }
    if (url.pathname === '/api/custom' || url.pathname === '/api/idea') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      writes.push({ path: url.pathname, body: JSON.parse(raw) });
      if (disconnect) return req.socket.destroy();
      if (delayMs) await sleep(delayMs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ song: { task_id: 'so_first', model: 'acemusic-v1.1', status: 'queued' }, songs: [{ task_id: 'so_second', status: 'planning' }] }));
    }
    if (url.pathname === '/api/songs') {
      reads.push(url.searchParams.get('ids'));
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ items: ids.map((task_id) => ({ task_id, status: 'succeeded', model: 'acemusic-v1.1', local_audio: '/data/' + task_id + '.mp3' })) }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown mock endpoint' }));
  });
  return { ...site, writes, reads, state };
}

async function startHub(sb) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'hub.mjs')], { cwd: PROJECT, env: { ...sb.env, ACE_HUB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  for (const _ of Array.from({ length: 80 })) {
    if (child.exitCode != null) throw new Error('Hub exited: ' + stderr);
    try {
      if ((await fetch(url + '/health', { signal: AbortSignal.timeout(300) })).ok) break;
    } catch { /* startup */ }
    await sleep(100);
  }
  assert.equal((await fetch(url + '/health')).status, 200, stderr);
  const req = async (endpoint, body) => {
    const response = await fetch(url + endpoint, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { child, url, req, env: { ...sb.env, ACE_HUB_URL: url } };
}

async function stopHub(hub) {
  if (hub.child.exitCode != null) return;
  const exited = once(hub.child, 'exit');
  await hub.req('/shutdown', {}).catch(() => {});
  await Promise.race([exited, sleep(3000)]);
  if (hub.child.exitCode == null) hub.child.kill();
}

async function waitJob(hub, jobId) {
  for (let i = 0; i < 100; i += 1) {
    const { data } = await hub.req('/jobs/' + jobId);
    if (['done', 'failed', 'interrupted', 'unresolved', 'cancelled'].includes(data.job && data.job.status)) return data.job;
    await sleep(50);
  }
  throw new Error('generation Hub job timeout');
}

function startMcp(env) {
  const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'mcp.mjs')], { cwd: PROJECT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')); }, 20000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, call };
}

const paid = (key = 'test-fixed-key') => ({ style: 'Instrumental tribal house', dry_run: false, confirm_credit_spend: true, max_credits: 4, idempotency_key: key });

test('生成 Hub：預覽不扣額度、精確狀態、持久化防重與 restart', async () => {
  const site = await mockSite();
  site.state.credits = 4;
  const sb = sandbox(site.url);
  let hub = await startHub(sb);
  try {
    const preview = await hub.req('/generate', { style: 'Instrumental tribal house' });
    assert.equal(preview.data.dry_run, true);
    assert.equal(preview.data.estimated_credits, 4);
    assert.equal(site.writes.length, 0);
    const denied = await hub.req('/generate', { style: 'Instrumental tribal house', dry_run: false });
    assert.equal(denied.status, 400);
    assert.equal(site.writes.length, 0);

    const first = await hub.req('/generate', paid());
    assert.equal(first.status, 202);
    const job = await waitJob(hub, first.data.jobId);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.result.task_ids, ['so_first', 'so_second']);
    assert.equal(site.writes.length, 1);
    assert.equal(site.writes[0].body.model, 'acemusic-v1.1');
    assert.equal(site.writes[0].body.created_at, first.data.request_created_at);
    site.state.credits = 0;
    const beforeRepeatReads = site.state.statusReads;
    const same = await hub.req('/generate', paid());
    assert.equal(same.data.idempotent, true);
    assert.equal(same.data.jobId, first.data.jobId);
    assert.equal(site.state.statusReads, beforeRepeatReads, '額度用盡後查原收據不需再探測站點');
    const clash = await hub.req('/generate', { ...paid(), style: 'Different content' });
    assert.equal(clash.status, 409);
    assert.equal(site.writes.length, 1);

    const status = await hub.req('/generation-status?task_ids=so_first,so_second');
    assert.deepEqual(status.data.task_ids, ['so_first', 'so_second']);
    assert.equal(status.data.complete, true);
    assert.equal(site.reads.at(-1), 'so_first,so_second');
    const receipts = fs.readFileSync(path.join(sb.stateDir, 'generation-receipts.json'), 'utf8');
    assert.ok(!receipts.includes('Instrumental tribal house'), '收據不保存提示詞正文');
    assert.ok(!receipts.includes('mock-session'), '收據不保存 Cookie');
    fs.unlinkSync(path.join(sb.stateDir, 'session.json'));
    const offlineRepeat = await hub.req('/generate', paid());
    assert.equal(offlineRepeat.data.jobId, first.data.jobId, '登入資料失效後仍能查原收據');
    assert.equal(site.state.statusReads, beforeRepeatReads);

    await stopHub(hub);
    hub = await startHub(sb);
    const restored = await hub.req('/generate', paid());
    assert.equal(restored.data.jobId, first.data.jobId);
    assert.equal(restored.data.job.status, 'done');
    assert.equal(site.writes.length, 1, '重啟後仍不可重送');
  } finally {
    await stopHub(hub); await closeServer(site.server); cleanSandbox(sb);
  }
});

test('生成 Hub：回應中斷不重送、未完成收據重啟後保持未確認', async () => {
  const site = await mockSite({ disconnect: true });
  const sb = sandbox(site.url);
  let hub = await startHub(sb);
  try {
    const first = await hub.req('/generate', paid('ambiguous-key'));
    const job = await waitJob(hub, first.data.jobId);
    assert.equal(job.status, 'unresolved');
    assert.equal(job.error_code, 'GENERATION_SUBMISSION_UNKNOWN');
    assert.equal(job.submission_unknown, true);
    assert.equal(job.submission_state, 'unknown');
    assert.equal(job.request_created_at, first.data.request_created_at);
    assert.equal(site.writes.length, 1);
    assert.match(job.error, /未取得明確回應|未確認|勿重新提交|unknown/i);
    const same = await hub.req('/generate', paid('ambiguous-key'));
    assert.equal(same.data.idempotent, true);
    assert.equal(site.writes.length, 1);
    await stopHub(hub);
    // 模擬提交中崩潰留下的 receipt；不能把 running 當成可重新送出。
    const file = path.join(sb.stateDir, 'generation-receipts.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.receipts[0].job.status = 'running';
    fs.writeFileSync(file, JSON.stringify(saved));
    hub = await startHub(sb);
    const restored = await hub.req('/generate', paid('ambiguous-key'));
    assert.equal(restored.data.job.status, 'interrupted');
    assert.equal(restored.data.job.submission_unknown, true);
    assert.equal(restored.data.job.submission_state, 'unknown');
    assert.equal(restored.data.job.error_code, 'GENERATION_HUB_INTERRUPTED');
    assert.equal(restored.data.request_created_at, first.data.request_created_at);
    assert.equal(site.writes.length, 1);
  } finally {
    await stopHub(hub); await closeServer(site.server); cleanSandbox(sb);
  }
});

test('生成 MCP：工具發現、舊 Hub 僅允許預覽回落', async () => {
  const site = await mockSite();
  const sb = sandbox(site.url);
  const oldHub = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, endpoints: [] })); });
  const mcp = startMcp({ ...sb.env, ACE_HUB_URL: oldHub.url });
  try {
    const initialized = await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'isolated-generation-test', version: '1' } });
    assert.ok(initialized.result.serverInfo);
    const list = await mcp.call('tools/list');
    const names = list.result.tools.map((entry) => entry.name);
    assert.ok(names.includes('ace_generate'));
    assert.ok(names.includes('ace_generation_status'));
    assert.equal(list.result.tools.find((entry) => entry.name === 'ace_generation_status').annotations.readOnlyHint, true);
    const preview = await mcp.call('tools/call', { name: 'ace_generate', arguments: { prompt: 'An instrumental house groove' } });
    assert.equal(preview.result.isError, false);
    assert.equal(JSON.parse(preview.result.content[0].text).dry_run, true);
    const denied = await mcp.call('tools/call', { name: 'ace_generate', arguments: paid() });
    assert.equal(denied.result.isError, true);
    assert.equal(site.writes.length, 0);
  } finally {
    mcp.child.kill(); await closeServer(oldHub.server); await closeServer(site.server); cleanSandbox(sb);
  }
});

test('生成 MCP：Hub POST 斷線後不回落、不重試', async () => {
  const site = await mockSite();
  const sb = sandbox(site.url);
  let hubPosts = 0;
  const fakeHub = await serve((req, res) => {
    if (req.url === '/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, endpoints: [{ method: 'POST', path: '/generate' }] }));
    }
    hubPosts += 1;
    req.socket.destroy();
  });
  const mcp = startMcp({ ...sb.env, ACE_HUB_URL: fakeHub.url });
  try {
    const result = await mcp.call('tools/call', { name: 'ace_generate', arguments: paid() });
    assert.equal(result.result.isError, true);
    assert.equal(hubPosts, 1);
    assert.equal(site.writes.length, 0, '不能在 Hub 回應未明時本機再送一次');
  } finally {
    mcp.child.kill(); await closeServer(fakeHub.server); await closeServer(site.server); cleanSandbox(sb);
  }
});

test('生成 Hub：拒絕外部 Origin 與內部欄位注入', async () => {
  const site = await mockSite();
  const sb = sandbox(site.url);
  const hub = await startHub(sb);
  try {
    const external = await fetch(hub.url + '/generate', { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(paid()) });
    assert.equal(external.status, 403);
    const internal = await hub.req('/generate', { ...paid(), request_created_at: 1 });
    assert.equal(internal.status, 400);
    assert.equal(site.writes.length, 0);
  } finally {
    await stopHub(hub); await closeServer(site.server); cleanSandbox(sb);
  }
});

test('生成 Hub：僅可取消未送出的排隊任務', async () => {
  const site = await mockSite({ delayMs: 400 });
  const sb = sandbox(site.url);
  const hub = await startHub(sb);
  try {
    const first = await hub.req('/generate', paid('first-running'));
    for (let i = 0; i < 50 && !site.writes.length; i += 1) await sleep(10);
    assert.equal(site.writes.length, 1);
    const second = await hub.req('/generate', paid('second-queued'));
    assert.notEqual(second.data.jobId, first.data.jobId);
    const rejected = await hub.req('/jobs/' + first.data.jobId + '/cancel', {});
    assert.equal(rejected.status, 409);
    const cancelled = await hub.req('/jobs/' + second.data.jobId + '/cancel', {});
    assert.equal(cancelled.status, 200);
    assert.equal((await waitJob(hub, first.data.jobId)).status, 'done');
    assert.equal((await waitJob(hub, second.data.jobId)).status, 'cancelled');
    assert.equal(site.writes.length, 1);
    const receipt = await hub.req('/generate', paid('second-queued'));
    assert.equal(receipt.data.job.status, 'cancelled');
    assert.equal(site.writes.length, 1);
  } finally {
    await stopHub(hub); await closeServer(site.server); cleanSandbox(sb);
  }
});

test('生成 CLI：預設預覽、明確 commit 後走 Hub', async () => {
  const site = await mockSite();
  const sb = sandbox(site.url);
  const hub = await startHub(sb);
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'cli.mjs'), ...args], { cwd: PROJECT, env: hub.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  try {
    const file = path.join(sb.base, 'request.json');
    fs.writeFileSync(file, JSON.stringify({ style: 'Instrumental tribal house' }));
    const preview = await run(['generate', '--request', file, '--json']);
    assert.equal(preview.code, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).dry_run, true);
    assert.equal(site.writes.length, 0);
    const committed = await run(['generate', '--request', file, '--commit', '--confirm-credit-spend', '--max-credits', '4', '--idempotency-key', 'cli-fixed-key', '--json']);
    assert.equal(committed.code, 0, committed.stderr);
    const data = JSON.parse(committed.stdout);
    assert.equal(data.hub, true);
    assert.equal((await waitJob(hub, data.jobId)).status, 'done');
    assert.equal(site.writes.length, 1);
    const status = await run(['generation-status', '--task-ids', 'so_first,so_second', '--json']);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).task_ids, ['so_first', 'so_second']);
  } finally {
    await stopHub(hub); await closeServer(site.server); cleanSandbox(sb);
  }
});
