// Agent Hub：health/overview、dry-run job、idempotency、單一寫入者鎖
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const HUB = path.join(PROJECT, 'agent', 'hub.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function seedState(base) {
  const stateDir = path.join(base, 'state');
  const cacheDir = path.join(stateDir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const song = {
    task_id: 'so_hub_test',
    status: 'succeeded',
    capability: 'music_generate',
    local_audio: '/data/mock/hub.mp3',
    created_at: 1,
    meta: { title: 'Hub Test' },
    result: { duration_sec: 100 },
    stems: null,
  };
  fs.writeFileSync(path.join(cacheDir, 'songs.json'), JSON.stringify({ cachedAt: Date.now(), songs: [song], known: [song] }));
  fs.writeFileSync(path.join(cacheDir, 'fs-index.json'), JSON.stringify({ cachedAt: Date.now(), files: [], rel: [], names: [] }));
  fs.writeFileSync(path.join(cacheDir, 'session-status.json'), JSON.stringify({ cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: 0, status: { authenticated: true } }));
  return { stateDir, downloadsDir: path.join(base, 'downloads') };
}

async function waitHealth(port, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('hub exited early: ' + child.exitCode);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return await response.json();
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('hub not ready');
}

async function waitJob(port, jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`, { signal: AbortSignal.timeout(1000) });
    const data = await response.json();
    const job = data.job || {};
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await sleep(120);
  }
  throw new Error('job timeout');
}

test('hub：health、overview、dry-run job、idempotency、單一寫入者', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-hub-'));
  const { stateDir, downloadsDir } = seedState(base);
  const [port, port2] = await Promise.all([freePort(), freePort()]);
  const env = { ...process.env, ACE_HUB_PORT: String(port), ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: downloadsDir };
  const child = spawn(process.execPath, [HUB], { env, cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const health = await waitHealth(port, child);
    assert.equal(health.ok, true);
    assert.ok(typeof health.version === 'string');

    const overview = await (await fetch(`http://127.0.0.1:${port}/overview`)).json();
    assert.equal(overview.ok, true);
    assert.equal(overview.counts.songs, 1);

    const songs = await (await fetch(`http://127.0.0.1:${port}/songs?compact=1`)).json();
    assert.equal(songs.total, 1);
    assert.equal(songs.songs[0].title, 'Hub Test');

    const dry = await (await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, dry_run: true, types: ['mp3'], idempotency_key: 'hub-test-dry' }),
    })).json();
    assert.equal(dry.ok, true);
    const job = await waitJob(port, dry.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.result.dryRun, true);
    assert.equal(job.result.total, 1);

    const same = await (await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, dry_run: true, types: ['mp3'], idempotency_key: 'hub-test-dry' }),
    })).json();
    assert.equal(same.jobId, dry.jobId, '同 idempotency_key 應回同一個 job');
    assert.equal(same.idempotent, true);

    // SSE：連上 /events 後觸發 warm job，應收到 hello 與 job 事件
    const sseChunks = [];
    const sseReq = http.get({ host: '127.0.0.1', port, path: '/events' }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => sseChunks.push(chunk));
    });
    await sleep(250);
    const warm = await (await fetch(`http://127.0.0.1:${port}/warm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).json();
    await waitJob(port, warm.jobId, 15000);
    await sleep(250);
    sseReq.destroy();
    const sseText = sseChunks.join('');
    assert.match(sseText, /event: hello/, 'SSE 應有 hello 事件');
    assert.match(sseText, /event: (job|progress|snapshot)/, 'SSE 應有 job/progress/snapshot 事件');

    // 同 state dir 的第二個 hub 必須拒絕啟動（exit 2）
    const second = spawn(process.execPath, [HUB], {
      env: { ...env, ACE_HUB_PORT: String(port2) },
      cwd: PROJECT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let secondErr = '';
    second.stderr.on('data', (chunk) => { secondErr += String(chunk); });
    const [code] = await Promise.race([once(second, 'exit'), sleep(10000).then(() => ['timeout'])]);
    if (code === 'timeout') second.kill();
    assert.equal(code, 2, '第二個 hub 應 exit 2，stderr=' + secondErr.slice(0, 200));
  } finally {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => {});
    await Promise.race([once(child, 'exit'), sleep(3000)]);
    if (child.exitCode == null) child.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
