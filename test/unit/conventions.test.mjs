// 規範把關（docs/CONVENTIONS.md 標 🔒 的規則）：單一清單一致、文件涵蓋、整合契約、來源限制、選歌器
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ACE = await import('../../agent/lib/ace.mjs');
const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const read = (rel) => fs.readFileSync(path.join(PROJECT, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arrayLiteral = (src, name) => {
  const m = new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`).exec(src);
  assert.ok(m, `找不到 ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

test('🔒 FILE_TYPES：面板與 agent 同一份清單', () => {
  assert.deepEqual(arrayLiteral(read('src/content.js'), 'FILE_TYPES'), [...ACE.FILE_TYPES]);
});

test('🔒 每個 MCP 工具都寫在 agent/README-AGENT.md', () => {
  const tools = [...read('agent/mcp.mjs').matchAll(/^\s+name: '(ace_\w+)'/gm)].map((m) => m[1]);
  assert.ok(tools.length >= 16);
  const doc = read('agent/README-AGENT.md');
  const missing = tools.filter((t) => !doc.includes('`' + t + '`'));
  assert.deepEqual(missing, [], 'README-AGENT.md 缺少工具說明');
});

test('選歌器：條件疊加、latest 取最新、無條件不選、all 才全選', () => {
  const songs = [
    { task_id: 'a', created_at: 1000, meta: { title: 'Echo One' } },
    { task_id: 'b', created_at: 3000, meta: { title: 'Echo Two' } },
    { task_id: 'c', created_at: 2000, meta: { title: 'Other' } },
  ];
  assert.deepEqual(ACE.selectSongs(songs, {}), []);
  assert.equal(ACE.selectSongs(songs, { all: true }).length, 3);
  assert.deepEqual(ACE.selectSongs(songs, { latest: 1 }).map((s) => s.task_id), ['b']);
  assert.deepEqual(ACE.selectSongs(songs, { latest: 2 }).map((s) => s.task_id), ['b', 'c']);
  assert.deepEqual(ACE.selectSongs(songs, { query: 'echo', latest: 1 }).map((s) => s.task_id), ['b']);
  assert.deepEqual(ACE.selectSongs(songs, { song_ids: ['a', 'c'] }).map((s) => s.task_id), ['a', 'c']);
  assert.deepEqual(ACE.selectSongs(songs, { songId: 'c' }).map((s) => s.task_id), ['c']);
  assert.deepEqual(ACE.selectSongs([{ task_id: 'iso', created_at: '2026-01-02T00:00:00Z' }, { task_id: 'old', created_at: '2025-01-01T00:00:00Z' }], { latest: 1 }).map((s) => s.task_id), ['iso']);
});

test('normalizeTypes：all 展開、字串逗號、預設值、未知類型丟錯', () => {
  assert.deepEqual(ACE.normalizeTypes(['all']), [...ACE.FILE_TYPES]);
  assert.deepEqual(ACE.normalizeTypes('mp3, wav'), ['mp3', 'wav']);
  assert.deepEqual(ACE.normalizeTypes(undefined), ['stems', 'midi', 'cover']);
  assert.throws(() => ACE.normalizeTypes(['flac']), /未知的檔案類型/);
});

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startHub(extraEnv = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-conv-'));
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(path.join(stateDir, 'cache'), { recursive: true });
  const songs = [1, 2, 3].map((n) => ({ task_id: 's' + n, status: 'succeeded', capability: 'music_generate', local_audio: `/data/s${n}.mp3`, created_at: n * 1000, meta: { title: 'Song ' + n } }));
  fs.writeFileSync(path.join(stateDir, 'page-songs.json'), JSON.stringify({ savedAt: Date.now(), songs }));
  fs.writeFileSync(path.join(stateDir, 'cache', 'session-status.json'), JSON.stringify({ cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: 0, status: { authenticated: false } }));
  const port = await freePort();
  const env = { ...process.env, ACE_HUB_PORT: String(port), ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: path.join(base, 'downloads'), ACE_BASE_URL: 'http://127.0.0.1:9', ...extraEnv };
  const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'hub.mjs')], { env, cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] });
  const req = (p, init = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...init, signal: AbortSignal.timeout(5000) });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      if ((await req('/health')).ok) break;
    } catch { /* retry */ }
    await sleep(150);
  }
  return { child, req };
}

async function waitJob(req, id) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const job = (await (await req('/jobs/' + id)).json()).job || {};
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await sleep(100);
  }
  throw new Error('job timeout');
}

test('🔒 整合契約：/capabilities 完整、端點都寫在 HUB.md、頁面檔白名單都被 Hub 監看；來源限制；選歌器走 Hub', async () => {
  const hub = await startHub();
  try {
    const caps = await (await hub.req('/capabilities')).json();
    assert.equal(caps.apiVersion, 1);
    assert.ok(caps.endpoints.length >= 15);
    assert.ok(caps.fileTypes.includes('all'));
    const health = await (await hub.req('/health')).json();
    assert.equal(health.apiVersion, caps.apiVersion);

    const hubDoc = read('agent/HUB.md');
    const undocumented = caps.endpoints.filter((e) => !hubDoc.includes('`' + e.path));
    assert.deepEqual(undocumented.map((e) => e.path), [], 'agent/HUB.md 缺少端點');

    const exportNames = arrayLiteral(read('src/background.js'), 'PAGE_EXPORT_NAMES');
    for (const name of exportNames) assert.ok(caps.pageFiles.includes(name + '.json'), `Hub 未監看 ${name}.json`);

    // 來源限制
    const web = await hub.req('/overview', { headers: { Origin: 'https://evil.example' } });
    assert.equal(web.status, 403, '一般網站 Origin 應被拒');
    const csrf = await hub.req('/download', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{"all":true}' });
    assert.equal(csrf.status, 403, '跨站 text/plain POST 應被拒');
    const ext = await hub.req('/health', { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
    assert.equal(ext.status, 200);
    assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    const pre = await hub.req('/download', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
    const local = await hub.req('/health');
    assert.equal(local.status, 200, '沒有 Origin（CLI／MCP）應放行');

    // 選歌器：無條件不下載；latest=2 只選 2 首
    const none = await (await hub.req('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dry_run: true, types: ['mp3'] }) })).json();
    const noneJob = await waitJob(hub.req, none.jobId);
    assert.equal(noneJob.status, 'failed');
    assert.match(noneJob.error || '', /沒有選到歌/);
    const latest = await (await hub.req('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dry_run: true, latest: 2, types: ['mp3'] }) })).json();
    const latestJob = await waitJob(hub.req, latest.jobId);
    assert.equal(latestJob.status, 'done');
    assert.equal(latestJob.result.songs, 2);
    assert.equal(latestJob.result.total, 2);
  } finally {
    hub.child.kill();
  }
});

test('來源限制：ACE_HUB_EXTENSIONS 只允許清單內擴充功能', async () => {
  const hub = await startHub({ ACE_HUB_EXTENSIONS: 'allowedextidallowedextidallowedx' });
  try {
    assert.equal((await hub.req('/health', { headers: { Origin: 'chrome-extension://allowedextidallowedextidallowedx' } })).status, 200);
    assert.equal((await hub.req('/health', { headers: { Origin: 'chrome-extension://otherextotherextotherextotherext' } })).status, 403);
  } finally {
    hub.child.kill();
  }
});
