import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sandbox(t) {
  const base = process.platform === 'win32' ? 'F:\\DevData\\Temp' : os.tmpdir();
  const directory = await fs.mkdtemp(path.join(base, 'ace-event-cursor-'));
  const state = path.join(directory, 'state');
  const downloads = path.join(directory, 'downloads');
  await fs.mkdir(state); await fs.mkdir(downloads);
  t.after(async () => {
    const relative = path.relative(await fs.realpath(base), await fs.realpath(directory));
    assert(relative.startsWith('ace-event-cursor-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, state, downloads, env: { ...process.env, ACE_STATE_DIR: state, ACE_DOWNLOAD_DIR: downloads, ACE_BASE_URL: 'http://127.0.0.1:1', ACE_HUB_TOKEN: '', TEMP: base, TMP: base } };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin?.end();
  const timer = setTimeout(() => child.kill('SIGTERM'), 1200);
  await exited;
  clearTimeout(timer);
}

function mcp(t, fixture, hubUrl) {
  const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'mcp.mjs')], { cwd: PROJECT, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...fixture.env, ACE_HUB_URL: hubUrl } });
  t.after(() => stop(child));
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(response.id);
      if (resolve) { pending.delete(response.id); resolve(response); }
    }
  });
  return (args) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('isolated MCP response timeout')); }, 6000);
    pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ace_events', arguments: args } }) + '\n');
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    });
    request.setTimeout(2000, () => request.destroy(new Error('isolated HTTP timeout')));
    request.on('error', reject);
  });
}

test('Hub /wait accepts an explicit zero sequence cursor and returns the first already-arrived event', async (t) => {
  const fixture = await sandbox(t);
  await fs.writeFile(path.join(fixture.state, 'page-events.json'), JSON.stringify({ events: [{ type: 'song_new', task_id: 'fixture-first-song', at: Date.now() }] }));
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'hub.mjs')], { cwd: PROJECT, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...fixture.env, ACE_HUB_PORT: String(port) } });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stop(child); });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await get(port, '/health');
      assert.equal(health.pid, child.pid, 'fixture must own the chosen port');
      if ((await get(port, '/page/events')).lastSeq === 1) { ready = true; break; }
    } catch { /* wait for this isolated child only */ }
    await sleep(25);
  }
  assert(ready, 'isolated Hub ingests the first fixture event');
  const result = await get(port, '/wait?type=song_new&since=0&timeout=100');
  assert.equal(result.timedOut, false);
  assert.equal(result.event.seq, 1);
  assert.equal(result.event.task_id, 'fixture-first-song');
  const future = await get(port, '/wait?type=song_new&timeout=100');
  assert.equal(future.timedOut, true, 'omitting the cursor retains wait-for-future behavior');
});

test('MCP offline events keep type filters and explicitly reject Hub sequence cursors instead of treating them as timestamps', async (t) => {
  const fixture = await sandbox(t);
  await fs.writeFile(path.join(fixture.state, 'page-events.json'), JSON.stringify({ events: [{ type: 'song_new', task_id: 'wanted', at: 10 }, { type: 'download_done', task_id: 'other', at: 20 }] }));
  const call = mcp(t, fixture, 'http://127.0.0.1:1');
  const response = await call({ type: 'song_new', limit: 1 });
  assert.equal(response.result.isError, false);
  const value = JSON.parse(response.result.content[0].text);
  assert.deepEqual(value.events.map((event) => event.type), ['song_new']);
  assert.deepEqual(value.cursor, { kind: 'timestamp', field: 'at', lastAt: 10 });
  for (const since of [0, 99999999]) {
    const rejected = await call({ type: 'song_new', since, limit: 1 });
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /seq.*不能轉成本機 at/);
    assert.doesNotMatch(rejected.result.content[0].text, /"events"/);
  }
});

test('MCP forwards sequence zero to an available Hub as a sequence cursor', async (t) => {
  const fixture = await sandbox(t);
  let seen;
  const server = http.createServer((req, res) => {
    seen = new URL(req.url, 'http://fixture').searchParams.get('since');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lastSeq: 1, events: [{ seq: 1, type: 'song_new' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const call = mcp(t, fixture, `http://127.0.0.1:${server.address().port}`);
  const response = await call({ since: 0 });
  assert.equal(seen, '0');
  assert.equal(response.result.isError, false);
  assert.equal(JSON.parse(response.result.content[0].text).hub, true);
});
