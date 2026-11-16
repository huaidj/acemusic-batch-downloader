import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJson, replaceFileAtomic } from '../../agent/lib/config.mjs';
import { hubRequest, hubJson, canFallbackHubWrite } from '../../agent/lib/hubclient.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP = process.env.ACE_TEST_TEMP || 'F:/DevData/Temp';

test('atomic replacement retries a transient Windows lock without removing the old evidence', async () => {
  const sb = sandbox(); const file = path.join(sb.state,'atomic.json'), temporary = file+'.tmp';
  await fsp.writeFile(file,'original'); await fsp.writeFile(temporary,'replacement');
  let attempts=0;
  await replaceFileAtomic(temporary,file,{rename:async(from,to)=>{
    if(attempts++<2){ assert.equal(await fsp.readFile(to,'utf8'),'original'); throw Object.assign(new Error('fixture read lock'),{code:'EPERM'}); }
    return fsp.rename(from,to);
  }});
  assert.equal(attempts,3);
  assert.equal(await fsp.readFile(file,'utf8'),'replacement');
});

function sandbox() {
  fs.mkdirSync(TEMP, { recursive: true });
  const base = fs.mkdtempSync(path.join(TEMP, 'ace-backend-safety-'));
  const state = path.join(base, 'state');
  fs.mkdirSync(state, { recursive: true });
  const song = { task_id: 'sandbox-song', model: 'acemusic-v1.1', status: 'succeeded', capability: 'music_generate', local_audio: '/data/sandbox-song.mp3', meta: { title: 'Sandbox' }, stems: { '2': { status: 'done', tracks: [] } } };
  fs.writeFileSync(path.join(state, 'page-songs.json'), JSON.stringify({ savedAt: Date.now(), songs: [song] }));
  fs.mkdirSync(path.join(state, 'cache'));
  fs.writeFileSync(path.join(state, 'cache', 'songs.json'), JSON.stringify({ cachedAt: Date.now(), songs: [song], known: [song] }));
  return { base, state, downloads: path.join(base, 'downloads') };
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function mcp(sb, hubUrl, siteUrl) {
  const child = spawn(process.execPath, [path.join(ROOT, 'agent/mcp.mjs')], {
    cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ACE_HUB_URL: hubUrl, ACE_STATE_DIR: sb.state, ACE_DOWNLOAD_DIR: sb.downloads, ACE_BASE_URL: siteUrl, TEMP, TMP: TEMP },
  });
  let buffer = '';
  let nextId = 0;
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = waiting.get(message.id);
      if (entry) { clearTimeout(entry.timer); waiting.delete(message.id); entry.resolve(message); }
    }
  });
  child.stderr.resume();
  return {
    child,
    call(name, args = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('isolated MCP response timeout')); }, 10000);
        waiting.set(id, { resolve, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
    },
    close() { child.kill(); for (const entry of waiting.values()) clearTimeout(entry.timer); },
  };
}

const text = (reply) => reply.result?.content?.map((entry) => entry.text || '').join('\n') || '';

test('writeJson：一次 I/O 失敗會回報，但不毒死已排入與後續的其他狀態寫入', async () => {
  const sb = sandbox();
  const blocker = path.join(sb.base, 'regular-file');
  await fsp.writeFile(blocker, 'preserve this file');
  const rejected = writeJson(path.join(blocker, 'cannot-write.json'), { bad: true });
  const goodFile = path.join(sb.base, 'good', 'state.json');
  const queued = writeJson(goodFile, { ok: 1 });
  await assert.rejects(rejected, (error) => ['EEXIST', 'ENOTDIR'].includes(error.code));
  await queued;
  assert.deepEqual(JSON.parse(await fsp.readFile(goodFile, 'utf8')), { ok: 1 });
  await writeJson(goodFile, { ok: 2 });
  assert.deepEqual(JSON.parse(await fsp.readFile(goodFile, 'utf8')), { ok: 2 });
  assert.equal(await fsp.readFile(blocker, 'utf8'), 'preserve this file');
});

test('hubRequest：只有明確連線前失敗可fallback；POST回應逾時、HTTP拒絕均不可重送', async () => {
  const offline = await serve((_req, res) => res.end());
  const offlineUrl = offline.url;
  await offline.close();
  await assert.rejects(hubRequest('/download', { method: 'POST', body: {}, base: offlineUrl }), (error) => error.code === 'ECONNREFUSED' && canFallbackHubWrite(error));
  let received = 0;
  const hub = await serve((req, res) => {
    req.resume(); received += 1;
    if (req.url === '/reject') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
    if (req.url === '/reset') req.on('end', () => req.socket.destroy());
  });
  try {
    await assert.rejects(hubRequest('/download', { method: 'POST', body: {}, base: hub.url, timeoutMs: 50 }), (error) => error.code === 'HUB_TIMEOUT' && error.hubPhase === 'submitted' && !canFallbackHubWrite(error));
    await assert.rejects(hubJson('/reject', { method: 'POST', body: {}, base: hub.url }), (error) => error.status === 401 && error.message === 'unauthorized' && !canFallbackHubWrite(error));
    await assert.rejects(hubRequest('/reset', { method: 'POST', body: {}, base: hub.url }), (error) => error.code === 'ECONNRESET' && !canFallbackHubWrite(error));
    assert.equal(received, 3);
  } finally { await hub.close(); }
});

for (const tool of ['ace_download', 'ace_tidy']) {
  test(`MCP ${tool}：Hub已收POST但回應逾時，只送一次，不改走本機執行`, async () => {
    const sb = sandbox();
    let siteCalls = 0;
    const site = await serve((req, res) => { siteCalls += 1; req.resume(); res.writeHead(500); res.end(); });
    const posts = [];
    const hub = await serve((req, _res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => posts.push({ method: req.method, path: req.url, body: JSON.parse(body || '{}') }));
      // The job has been accepted; deliberately lose its response.
    });
    const client = mcp(sb, hub.url, site.url);
    try {
      const args = tool === 'ace_download' ? { all: true, types: ['midi'], idempotency_key: 'sandbox-durable-key' } : {};
      const reply = await client.call(tool, args);
      assert.equal(reply.result.isError, true);
      assert.match(text(reply), /提交狀態待查/);
      assert.match(text(reply), /禁止自動重送/);
      assert.equal(posts.length, 1);
      assert.equal(siteCalls, 0, 'direct download/tidy must not contact even the isolated site');
      if (tool === 'ace_download') {
        assert.equal(posts[0].body.idempotency_key, 'sandbox-durable-key');
        assert.match(text(reply), /idempotency_key=sandbox-durable-key/);
      }
    } finally { client.close(); await hub.close(); await site.close(); }
  });
}

test('MCP：Hub 401拒絕寫入不fallback，讀取工具保留本機fallback', async () => {
  const sb = sandbox();
  let siteCalls = 0;
  const site = await serve((req, res) => { siteCalls += 1; req.resume(); res.writeHead(500); res.end(); });
  let posts = 0;
  const hub = await serve((req, res) => { req.resume(); if (req.method === 'POST') posts += 1; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); });
  const client = mcp(sb, hub.url, site.url);
  try {
    const rejected = await client.call('ace_download', { all: true, types: ['midi'], idempotency_key: 'rejected-key' });
    assert.equal(rejected.result.isError, true);
    assert.match(text(rejected), /unauthorized/);
    assert.match(text(rejected), /submission_status=rejected/);
    assert.equal(posts, 1);
    assert.equal(siteCalls, 0);
    const read = await client.call('ace_favorites');
    assert.equal(read.result.isError, false, 'ordinary read fallback remains available');
  } finally { client.close(); await hub.close(); await site.close(); }
});

test('MCP：Hub明確offline可沿用本機dry-run', async () => {
  const sb = sandbox();
  const offline = await serve((_req, res) => res.end());
  const url = offline.url;
  await offline.close();
  const client = mcp(sb, url, 'http://127.0.0.1:1');
  try {
    const reply = await client.call('ace_download', { all: true, types: ['mp3'], dry_run: true });
    assert.equal(reply.result.isError, false);
    const data = JSON.parse(text(reply));
    assert.equal(data.dryRun, true);
    assert.equal(data.songs, 1);
  } finally { client.close(); }
});

test('MCP tidy：已接受的Hub job可用ace_job_status查詢，不誤當成本機job', async () => {
  const sb = sandbox();
  const hub = await serve((req, res) => {
    req.resume(); res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { res.writeHead(202); res.end(JSON.stringify({ ok: true, jobId: 'accepted-tidy-job' })); }
    else res.end(JSON.stringify({ ok: true, job: { id: 'accepted-tidy-job', status: 'done', result: { ok: true } } }));
  });
  const client = mcp(sb, hub.url, 'http://127.0.0.1:1');
  try {
    const started = await client.call('ace_tidy');
    assert.equal(started.result.isError, false);
    assert.equal(JSON.parse(text(started)).jobId, 'accepted-tidy-job');
    const queried = await client.call('ace_job_status', { job_id: 'accepted-tidy-job' });
    assert.equal(queried.result.isError, false);
    const job = JSON.parse(text(queried));
    assert.equal(job.hub, true);
    assert.equal(job.status, 'done');
  } finally { client.close(); await hub.close(); }
});

test('MCP warm：已知Hub job查詢失敗不重跑本機，錯誤保留可查的job_id', async () => {
  const sb = sandbox();
  let siteCalls = 0;
  const site = await serve((req, res) => { siteCalls += 1; req.resume(); res.writeHead(500); res.end(); });
  let posts = 0;
  const hub = await serve((req, res) => {
    req.resume(); res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { posts += 1; res.writeHead(202); res.end(JSON.stringify({ ok: true, jobId: 'accepted-warm-job' })); }
    else { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'temporarily unavailable' })); }
  });
  const client = mcp(sb, hub.url, site.url);
  try {
    const reply = await client.call('ace_warm');
    assert.equal(reply.result.isError, true);
    assert.match(text(reply), /job_id=accepted-warm-job/);
    assert.match(text(reply), /submission_status=accepted/);
    assert.equal(posts, 1);
    assert.equal(siteCalls, 0);
  } finally { client.close(); await hub.close(); await site.close(); }
});
