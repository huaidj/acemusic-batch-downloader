// 網頁 → agent 快速通道：page-songs 優先順序／新鮮度、連不到站點時的 fallback、
// known 保留、page-unavailable 合併、locate（真實目錄、同名 take 分離、排除 hardlink 檢視）、Hub /locate 與即時失效
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ACE = await import('../../agent/lib/ace.mjs');
const { config } = await import('../../agent/lib/config.mjs');

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const HUB = path.join(PROJECT, 'agent', 'hub.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const song = (id, title, createdAt, extra = {}) => ({
  task_id: id,
  status: 'succeeded',
  capability: 'music_generate',
  model: 'acemusic-v1.1',
  local_audio: `/data/${id}.mp3`,
  local_cover: `/data/${id}.jpg`,
  created_at: createdAt,
  meta: { title },
  ...extra,
});

/** 每個測試一個獨立 state/downloads；回傳 cfg（不靠全域 env，避免測試互相干擾） */
function sandbox(name, baseUrl = 'http://127.0.0.1:9') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `acedl-${name}-`));
  const stateDir = path.join(base, 'state');
  const downloadDir = path.join(base, 'downloads');
  fs.mkdirSync(path.join(stateDir, 'cache'), { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const cfg = { ...config(), stateDir, downloadDir, baseUrl, sessionFile: path.join(stateDir, 'session.json'), historyFile: path.join(stateDir, 'history.json'), stateFile: path.join(stateDir, 'agent-state.json'), officialAuthFile: path.join(stateDir, 'official-auth.json') };
  const write = (rel, data) => {
    const file = path.join(stateDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  const touch = (rel) => {
    const file = path.join(downloadDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    return file;
  };
  return { base, cfg, stateDir, downloadDir, write, touch };
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('listSongs：頁面快照比 API 快取新且新鮮 → 直接用（不打網路）', async () => {
  const sb = sandbox('page-fresh');
  sb.write('cache/songs.json', { cachedAt: Date.now() - 60000, songs: [song('old', 'Old', 1)], known: [song('old', 'Old', 1)] });
  sb.write('page-songs.json', { savedAt: Date.now(), songs: [song('new', 'New', 2), song('old', 'Old', 1)] });
  const songs = await ACE.listSongs(sb.cfg);
  assert.deepEqual(songs.map((s) => s.task_id), ['new', 'old']);
  const known = await ACE.listSongs(sb.cfg, { includeKnown: true });
  assert.ok(known.some((s) => s.task_id === 'new'));
});

test('listSongs：頁面快照過舊（>10 分）→ 用新鮮的 API 快取', async () => {
  const sb = sandbox('page-old');
  sb.write('cache/songs.json', { cachedAt: Date.now(), songs: [song('api', 'Api', 1)], known: [] });
  sb.write('page-songs.json', { savedAt: Date.now() - 11 * 60 * 1000, songs: [song('page', 'Page', 2)] });
  const songs = await ACE.listSongs(sb.cfg);
  assert.deepEqual(songs.map((s) => s.task_id), ['api']);
});

test('listSongs：沒有 session → 用頁面快照（即使已過舊），不丟錯', async () => {
  const sb = sandbox('no-session');
  sb.write('page-songs.json', { savedAt: Date.now() - 60 * 60 * 1000, songs: [song('p', 'P', 1)] });
  const songs = await ACE.listSongs(sb.cfg);
  assert.deepEqual(songs.map((s) => s.task_id), ['p']);
});

test('listSongs：登入過期（401）→ 取頁面快照／舊快取中較新的一份；兩者都沒有才丟 AUTH_EXPIRED', async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Please log in' } }));
  });
  try {
    const sb = sandbox('auth-401', url);
    sb.write('session.json', { cookie: 'a=b', savedAt: Date.now() });
    sb.write('cache/songs.json', { cachedAt: Date.now() - 30 * 60 * 1000, songs: [song('cache', 'C', 1)], known: [] });
    sb.write('page-songs.json', { savedAt: Date.now() - 20 * 60 * 1000, songs: [song('page', 'P', 2)] });
    assert.deepEqual((await ACE.listSongs(sb.cfg)).map((s) => s.task_id), ['page']);

    const sb2 = sandbox('auth-401b', url);
    sb2.write('session.json', { cookie: 'a=b', savedAt: Date.now() });
    sb2.write('cache/songs.json', { cachedAt: Date.now() - 30 * 60 * 1000, songs: [song('cache', 'C', 1)], known: [] });
    assert.deepEqual((await ACE.listSongs(sb2.cfg)).map((s) => s.task_id), ['cache']);

    const sb3 = sandbox('auth-401c', url);
    sb3.write('session.json', { cookie: 'a=b', savedAt: Date.now() });
    await assert.rejects(() => ACE.listSongs(sb3.cfg), (err) => err.code === 'AUTH_EXPIRED');
  } finally {
    server.close();
  }
});

test('listSongs：API 快取過期後重抓，known 保留舊歌（不被清空）', async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [song('b', 'B', 2)], next: '' }));
  });
  try {
    const sb = sandbox('known', url);
    sb.write('session.json', { cookie: 'a=b', savedAt: Date.now() });
    sb.write('cache/songs.json', { cachedAt: Date.now() - 60 * 60 * 1000, songs: [song('a', 'A', 1)], known: [song('a', 'A', 1)] });
    const known = await ACE.listSongs(sb.cfg, { includeKnown: true });
    assert.deepEqual(known.map((s) => s.task_id).sort(), ['a', 'b']);
  } finally {
    server.close();
  }
});

test('loadState：合併面板的 page-unavailable', async () => {
  const sb = sandbox('na-merge');
  sb.write('agent-state.json', { unavailable: { s1: { midi: { code: 'no_download', at: 1 } } } });
  sb.write('page-unavailable.json', { savedAt: Date.now(), unavailable: { s2: { midi: { code: 'no_download', at: 2 } } } });
  const state = await ACE.loadState(sb.cfg);
  assert.ok(state.unavailable.s1.midi);
  assert.ok(state.unavailable.s2.midi);
  const status = await ACE.pageChannelStatus(sb.cfg);
  assert.equal(status.unavailable, 1);
  assert.equal(status.songs, 0);
});

test('matchSongFiles：指派資料夾精確比對；未指派放寬但排除別的 take；預設排除 音頻分類', () => {
  const s = song('t1', 'Echo', 1);
  const root = path.join('C:', 'dl', 'ai音樂');
  const files = [
    path.join(root, '成品MP3', 'Echo.mp3'),
    path.join(root, '成品MP3', 'Echo (2).mp3'),
    path.join(root, 'MIDI', 'Echo - MIDI.mid'),
    path.join(root, '採樣包', 'Vocals', 'Echo - Vocals.mp3'),
    path.join(root, '音頻分類', '分軌', 'BPM', 'Echo - Vocals.mp3'),
    path.join(root, '成品MP3', 'Echoes.mp3'),
  ];
  const assigned = ACE.matchSongFiles(s, files, { folder: 'Echo' });
  assert.deepEqual(assigned.map((f) => path.basename(f.path)).sort(), ['Echo - MIDI.mid', 'Echo - Vocals.mp3', 'Echo.mp3']);
  assert.deepEqual(assigned.map((f) => f.kind).sort(), ['midi', 'mp3', 'stem:Vocals']);

  const take2 = ACE.matchSongFiles(song('t2', 'Echo', 2), files, { takenFolders: new Set(['echo']) });
  assert.deepEqual(take2.map((f) => path.basename(f.path)), ['Echo (2).mp3']);

  const views = ACE.matchSongFiles(s, files, { folder: 'Echo', includeViews: true });
  assert.equal(views.length, 4);
});

test('locateSongs：預設最新一首；回真實目錄（依數量排序）與檔案', async () => {
  const sb = sandbox('locate');
  sb.write('page-songs.json', { savedAt: Date.now(), songs: [song('older', 'Older', 1000), song('newest', 'Newest', 2000)] });
  const mp3 = sb.touch('ai音樂/成品MP3/Newest.mp3');
  sb.touch('ai音樂/採樣包/Vocals/Newest - Vocals.mp3');
  sb.touch('ai音樂/採樣包/Drums/Newest - Drums.mp3');
  sb.touch('ai音樂/成品MP3/Older.mp3');
  const result = await ACE.locateSongs(sb.cfg);
  assert.equal(result.total, 1);
  const hit = result.songs[0];
  assert.equal(hit.task_id, 'newest');
  assert.equal(hit.fileCount, 3);
  assert.ok(hit.files.some((f) => f.path === mp3));
  assert.deepEqual(hit.dirs.map((d) => path.basename(d.dir)).sort(), ['Drums', 'Vocals', '成品MP3']);

  const two = await ACE.locateSongs(sb.cfg, { latest: 2 });
  assert.deepEqual(two.songs.map((s) => s.task_id), ['newest', 'older']);
  const q = await ACE.locateSongs(sb.cfg, { query: 'old' });
  assert.deepEqual(q.songs.map((s) => s.task_id), ['older']);
  const byId = await ACE.locateSongs(sb.cfg, { songId: 'older' });
  assert.equal(byId.songs[0].fileCount, 1);
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

async function startHub(sb) {
  const port = await freePort();
  const env = { ...process.env, ACE_HUB_PORT: String(port), ACE_STATE_DIR: sb.stateDir, ACE_DOWNLOAD_DIR: sb.downloadDir, ACE_BASE_URL: 'http://127.0.0.1:9' };
  const child = spawn(process.execPath, [HUB], { env, cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] });
  const get = async (p, timeout = 3000) => (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(timeout) })).json();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const o = await get('/overview');
      if (o.ok) break;
    } catch { /* retry */ }
    await sleep(150);
  }
  return { child, get, port };
}

test('hub 中樞：歌單差異 → song_new 事件；頁面事件 → /page/events；/wait 長輪詢；/library', async () => {
  const sb = sandbox('hub-events');
  sb.write('page-songs.json', { savedAt: Date.now(), songs: [song('e1', 'Event One', 1000)] });
  sb.write('cache/session-status.json', { cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: 0, status: { authenticated: false } });
  sb.touch('ai音樂/成品MP3/Event One.mp3');
  sb.touch('ai音樂/採樣包/Vocals/Event One - Vocals.mp3');
  sb.touch('ai音樂/採樣包/Drums/Event One - Drums.mp3');
  sb.touch('ai音樂/MIDI/Event One - MIDI.mid');
  const hub = await startHub(sb);
  try {
    const head = await hub.get('/page/events?limit=1');
    // 開始等，然後模擬面板送來新歌單
    const waiting = hub.get(`/wait?type=song_new&since=${head.lastSeq}&timeout=5000`, 8000);
    await sleep(100);
    sb.write('page-songs.json', { savedAt: Date.now(), songs: [song('e2', 'Event Two', 2000), song('e1', 'Event One', 1000)] });
    const got = await waiting;
    assert.equal(got.timedOut, false, '/wait 應在新歌出現時回應');
    assert.equal(got.event.type, 'song_new');
    assert.equal(got.event.task_id, 'e2');

    // 面板事件檔 → 事件環
    sb.write('page-events.json', { savedAt: Date.now(), events: [{ type: 'download_done', task_ids: ['e2'], done: 3, failed: 0, at: Date.now() }] });
    let events = null;
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      events = await hub.get('/page/events?type=download_done');
      if (events.total) break;
      await sleep(80);
    }
    assert.equal(events.total, 1, 'download_done 應進入事件環');
    assert.equal(events.events[0].source, 'page');

    // since 之後已發生的事件：/wait 立即回
    const immediate = await hub.get(`/wait?type=download_done&task_id=e2&since=${got.event.seq}&timeout=3000`);
    assert.equal(immediate.timedOut, false);

    const timed = await hub.get('/wait?type=song_new&timeout=300');
    assert.equal(timed.timedOut, true);

    const lib = await hub.get('/library');
    const by = Object.fromEntries(lib.categories.map((c) => [c.sub ? `${c.category}/${c.sub}` : c.category, c.files]));
    assert.equal(by['成品MP3'], 1);
    assert.equal(by['採樣包/Vocals'], 1);
    assert.equal(by['採樣包/Drums'], 1);
    assert.equal(by['MIDI'], 1);
  } finally {
    hub.child.kill();
  }
});

test('mcp：tools/list 含中樞工具', async () => {
  const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'mcp.mjs')], { cwd: PROJECT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ACE_HUB_URL: 'http://127.0.0.1:1' } });
  let buf = '';
  const replies = new Map();
  child.stdout.on('data', (chunk) => {
    buf += String(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) replies.set(msg.id, msg);
      } catch { /* ignore */ }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const reply = async (id) => {
    const until = Date.now() + 8000;
    while (!replies.has(id) && Date.now() < until) await sleep(20);
    return replies.get(id);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await reply(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await reply(2);
    const names = list.result.tools.map((t) => t.name);
    for (const name of ['ace_locate', 'ace_wait_new_song', 'ace_events', 'ace_library', 'ace_probe', 'ace_overview', 'ace_download']) {
      assert.ok(names.includes(name), 'MCP 應提供 ' + name);
    }
  } finally {
    child.kill();
  }
});

test('hub：/locate、/page；寫入 page-songs.json 後快照立即更新（不等 TTL）', async () => {
  const sb = sandbox('hub-page');
  sb.write('page-songs.json', { savedAt: Date.now(), songs: [song('h1', 'Hub One', 1000)] });
  sb.write('cache/session-status.json', { cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: 0, status: { authenticated: false } });
  sb.touch('ai音樂/成品MP3/Hub One.mp3');
  const port = await freePort();
  const env = { ...process.env, ACE_HUB_PORT: String(port), ACE_STATE_DIR: sb.stateDir, ACE_DOWNLOAD_DIR: sb.downloadDir, ACE_BASE_URL: 'http://127.0.0.1:9' };
  const child = spawn(process.execPath, [HUB], { env, cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] });
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) })).json();
  try {
    const deadline = Date.now() + 15000;
    let overview = null;
    while (Date.now() < deadline) {
      try {
        overview = await get('/overview');
        if (overview.ok) break;
      } catch { /* retry */ }
      await sleep(150);
    }
    assert.equal(overview.counts.songs, 1);

    const t0 = Date.now();
    const loc = await get('/locate');
    const ms = Date.now() - t0;
    assert.equal(loc.songs[0].task_id, 'h1');
    assert.equal(loc.songs[0].fileCount, 1);
    assert.ok(ms < 500, 'locate 應為 ms 級，實際 ' + ms + 'ms');

    const page = await get('/page');
    assert.equal(page.songs, 1);
    assert.equal(page.fresh, true);

    // 面板送來新歌單 → hub 自動失效快照
    await sleep(50);
    sb.write('page-songs.json', { savedAt: Date.now(), songs: [song('h2', 'Hub Two', 2000), song('h1', 'Hub One', 1000)] });
    let updated = 0;
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const o = await get('/overview');
      if (o.counts && o.counts.songs === 2) {
        updated = o.counts.songs;
        break;
      }
      await sleep(100);
    }
    assert.equal(updated, 2, '寫入 page-songs.json 後 5 秒內 overview 應反映新歌');
    const latest = await get('/locate');
    assert.equal(latest.songs[0].task_id, 'h2');
  } finally {
    child.kill();
  }
});
