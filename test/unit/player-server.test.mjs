import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createPlayerServer } from '../../player/server.mjs';
import { buildAudioLibrary } from '../../agent/lib/audio-library.mjs';

function tinyWav() {
  const data = Buffer.alloc(76);
  data.write('RIFF'); data.writeUInt32LE(68, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(32, 40);
  for (let index = 44; index < data.length; index += 1) data[index] = index;
  return data;
}

async function fixture(t) {
  const base = process.platform === 'win32' ? 'F:\\DevData\\Temp' : os.tmpdir();
  const directory = await fs.mkdtemp(path.join(base, 'ace-player-contract-'));
  const cfg = { stateDir: path.join(directory, 'state'), downloadDir: path.join(directory, 'downloads') };
  const libraryRoot = path.join(cfg.downloadDir, 'ai音樂');
  const stateDir = path.join(directory, 'player-state');
  await fs.mkdir(cfg.stateDir); await fs.mkdir(libraryRoot, { recursive: true });
  const bytes = tinyWav();
  const audioPath = path.join(libraryRoot, 'audio.wav');
  const outsidePath = path.join(directory, 'outside-private.txt');
  await fs.writeFile(audioPath, bytes); await fs.writeFile(outsidePath, 'private-fixture-outside-library');
  const good = { id: 'opaque:track-1', name: 'audio.wav', title: 'Fixture', format: 'wav', bytes: bytes.length, validity: 'valid', relativePath: 'audio.wav', folder: 'ai音樂', kind: 'full', songId: 'song-fixture' };
  const filesById = new Map([
    [good.id, { ...good, absolutePath: audioPath }],
    ['uncertain', { ...good, id: 'uncertain', validity: 'unknown', absolutePath: audioPath }],
    ['damaged', { ...good, id: 'damaged', validity: 'damaged', absolutePath: audioPath }],
    ['outside-map-entry', { ...good, id: 'outside-map-entry', absolutePath: outsidePath }],
  ]);
  let builds = 0;
  const library = { scannedAt: '2026-11-16T00:00:00Z', root: 'ai音樂', revision: 'fixture-index', tracks: [{ id: 'song-fixture', title: 'Fixture', preferredFileId: good.id, files: [good] }], files: [good], folders: ['ai音樂'], summary: { songs: 1, files: 1 } };
  const options = { cfg, stateDir, disableReveal: true, probeHub: async () => false, buildLibrary: async () => { builds += 1; return { library, filesById }; } };
  const servers = new Set();
  const start = async (overrides = {}) => {
    const server = createPlayerServer({ ...options, ...overrides });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.add(server);
    return { server, port: server.address().port };
  };
  const close = async (server) => {
    if (!servers.delete(server)) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => {
    for (const server of [...servers]) await close(server);
    const relative = path.relative(await fs.realpath(base), await fs.realpath(directory));
    assert(relative.startsWith('ace-player-contract-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { cfg, directory, stateDir, bytes, audioPath, good, library, start, close, builds: () => builds };
}

function request(port, pathname, { method = 'GET', headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? Buffer.from(rawBody) : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, agent: false, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buffer.toString('utf8')); } catch { /* media/HEAD */ }
        resolve({ status: res.statusCode, headers: res.headers, buffer, json });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('isolated player request timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

test('player media returns exact bytes for GET, HEAD and seek ranges, including suffix/open-ended/416', async (t) => {
  const f = await fixture(t), { port } = await f.start();
  const route = '/media/' + encodeURIComponent(f.good.id);
  const full = await request(port, route);
  assert.equal(full.status, 200); assert.deepEqual(full.buffer, f.bytes);
  assert.equal(full.headers['accept-ranges'], 'bytes'); assert.equal(full.headers['content-type'], 'audio/wav');
  const head = await request(port, route, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.buffer.length, 0); assert.equal(Number(head.headers['content-length']), f.bytes.length);
  for (const [range, start, end] of [['bytes=4-11', 4, 11], ['bytes=60-', 60, 75], ['bytes=-7', 69, 75], ['bytes=70-9999', 70, 75]]) {
    const response = await request(port, route, { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${f.bytes.length}`);
    assert.deepEqual(response.buffer, f.bytes.subarray(start, end + 1));
    assert.equal(Number(response.headers['content-length']), end - start + 1);
  }
  const seekHead = await request(port, route, { method: 'HEAD', headers: { Range: 'bytes=4-11' } });
  assert.equal(seekHead.status, 206); assert.equal(seekHead.buffer.length, 0); assert.equal(Number(seekHead.headers['content-length']), 8);
  for (const range of ['bytes=999-', 'bytes=10-2', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-3']) {
    const response = await request(port, route, { headers: { Range: range } });
    assert.equal(response.status, 416, range); assert.equal(response.headers['content-range'], 'bytes */76');
  }
  assert.equal((await request(port, route, { headers: { 'If-None-Match': full.headers.etag } })).status, 304);
  assert.equal((await request(port, route, { headers: { Range: 'bytes=4-11', 'If-Range': 'outdated-etag' } })).status, 200);
});

test('player restricts Host/Origin and opaque file IDs without exposing arbitrary filesystem paths', async (t) => {
  const f = await fixture(t), { port } = await f.start();
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `http://127.0.0.1:${port}.evil.example` }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request(port, '/api/health', { headers })).status, 403);
  assert.equal((await request(port, '/api/health', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  for (const pathname of ['/media/unknown', '/media/%2e%2e%2foutside-private.txt', '/%2e%2e%2fserver.mjs', '/api/file?path=outside-private.txt', '/server.mjs']) assert.equal((await request(port, pathname)).status, 404, pathname);
  assert.equal((await request(port, '/media/%zz')).status, 400);
  assert.equal((await request(port, '/media/' + encodeURIComponent(f.good.id) + '?filePath=outside-private.txt')).status, 400);
  assert.equal((await request(port, '/media/outside-map-entry')).status, 403, 'even an invalid cached map entry cannot escape the real library root');
  const reveal = await request(port, '/api/reveal', { method: 'POST', body: { fileId: f.good.id } });
  assert.equal(reveal.status, 200, 'test-only reveal is a no-op, no Explorer process starts');
  assert.equal((await request(port, '/api/reveal', { method: 'POST', body: { fileId: f.good.id, path: f.audioPath } })).status, 400);
  assert.equal((await request(port, '/media/damaged')).status, 422);
  assert.equal((await request(port, '/media/uncertain')).status, 200, 'uncertain but readable files remain available for user listening');
});

test('player CAS serializes competing edits and persists queue/history/preferences across a server restart', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cfg.stateDir, 'page-favorites.json'), JSON.stringify({ favorites: [{ task_id: 'legacy-favorite' }] }));
  let live = await f.start();
  const initial = (await request(live.port, '/api/state')).json;
  assert.equal(initial.revision, 0); assert.deepEqual(initial.favorites, ['legacy-favorite']);
  const saved = await request(live.port, '/api/state', { method: 'PUT', body: { expectedRevision: 0, queue: [f.good.id], favorites: ['song-fixture'], history: [{ fileId: f.good.id, at: 123 }], playlists: [{ id: 'mix-1', name: 'Fixture Mix', fileIds: [f.good.id] }], currentFileId: f.good.id, currentTime: 1.25, volume: 0.4, repeat: 'one', shuffle: true } });
  assert.equal(saved.status, 200); assert.equal(saved.json.revision, 1);
  const edits = await Promise.all([request(live.port, '/api/state', { method: 'PUT', body: { expectedRevision: 1, volume: 0.2 } }), request(live.port, '/api/state', { method: 'PUT', body: { expectedRevision: 1, volume: 0.7 } })]);
  assert.deepEqual(edits.map((response) => response.status).sort(), [200, 409]);
  const winner = edits.find((response) => response.status === 200).json;
  assert.equal(winner.revision, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(live.server.playerStateFile, 'utf8')), winner);
  await f.close(live.server); live = await f.start();
  assert.deepEqual((await request(live.port, '/api/state')).json, winner);
  assert.deepEqual((await fs.readdir(f.stateDir)).filter((name) => name.endsWith('.tmp')), []);
});

test('player rejects invalid/oversized state edits without poisoning later valid writes', async (t) => {
  const f = await fixture(t), { port } = await f.start();
  const initial = (await request(port, '/api/state')).json;
  for (const patch of [{ volume: 2 }, { currentTime: -1 }, { repeat: 'forever' }, { queue: ['bad\u0000id'] }, { favorites: Array(10001).fill('x') }, { unexpected: true }, { playlists: [{ id: 'same', name: 'A', fileIds: [] }, { id: 'same', name: 'B', fileIds: [] }] }]) {
    assert.equal((await request(port, '/api/state', { method: 'PUT', body: { expectedRevision: initial.revision, ...patch } })).status, 400);
  }
  assert.equal((await request(port, '/api/state', { method: 'PUT', body: { volume: 0.1 } })).status, 400);
  assert.equal((await request(port, '/api/state', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, rawBody: '{}' })).status, 415);
  assert.equal((await request(port, '/api/state', { method: 'PUT', rawBody: '{not-json' })).status, 400);
  assert.equal((await request(port, '/api/state', { method: 'PUT', rawBody: JSON.stringify({ expectedRevision: 0, queue: ['x'.repeat(262144)] }) })).status, 413);
  assert.deepEqual((await request(port, '/api/state')).json, initial);
  assert.equal((await request(port, '/api/state', { method: 'PUT', body: { expectedRevision: 0, volume: 0.1 } })).json.revision, 1);
});

test('player selection only focuses a song and never changes saved playback state or starts media reads', async (t) => {
  const f = await fixture(t), { port } = await f.start();
  const before = (await request(port, '/api/state')).json;
  assert.deepEqual((await request(port, '/api/selection')).json, { serial: 0, songId: null });
  const selected = await request(port, '/api/select', { method: 'POST', body: { songId: 'song-fixture' } });
  assert.equal(selected.status, 200); assert.equal(selected.json.songId, 'song-fixture'); assert.equal(selected.json.serial, 1);
  assert.deepEqual((await request(port, '/api/state')).json, before);
  assert.equal(f.builds(), 0, 'selection neither indexes nor reads a media file');
  assert.equal((await request(port, '/api/select', { method: 'POST', body: { songId: 'song-fixture', autoplay: true } })).status, 400);
  assert.equal((await request(port, '/api/select', { method: 'POST', body: { songId: '' } })).status, 400);
});

test('player library cache shares a snapshot and explicit reindex refreshes it; corrupt state is preserved', async (t) => {
  const f = await fixture(t), { port } = await f.start();
  const [a, b] = await Promise.all([request(port, '/api/library'), request(port, '/api/library')]);
  assert.equal(a.status, 200); assert.deepEqual(a.json, b.json); assert.equal(f.builds(), 1);
  assert.equal((await request(port, '/api/reindex', { method: 'POST', body: {} })).status, 200); assert.equal(f.builds(), 2);
  assert.equal((await request(port, '/api/library?refresh=1')).status, 200); assert.equal(f.builds(), 3);
  assert.equal((await request(port, '/api/reindex', { method: 'POST', body: { path: f.audioPath } })).status, 400);
  await fs.mkdir(f.stateDir, { recursive: true });
  const original = '{broken-player-state';
  await fs.writeFile(path.join(f.stateDir, 'state.json'), original);
  assert.equal((await request(port, '/api/state')).status, 422);
  assert.equal(await fs.readFile(path.join(f.stateDir, 'state.json'), 'utf8'), original);
});

test('player revision endpoint observes completed background files and metadata before the cache TTL expires', async (t) => {
  const f = await fixture(t);
  f.cfg.baseUrl = 'https://fixture.invalid';
  const song = (id, title) => ({ task_id: id, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/audio/' + id + '.mp3', meta: { title } });
  const record = (id, filename, number) => ({ id: number, state: 'complete', filename, fileSize: f.bytes.length, url: f.cfg.baseUrl + '/api/songs/' + id + '/file?kind=wav' });
  await fs.writeFile(path.join(f.cfg.stateDir, 'page-songs.json'), JSON.stringify({ songs: [song('watch-one', 'Fixture One')] }));
  await fs.writeFile(path.join(f.cfg.stateDir, 'history.json'), JSON.stringify({ items: [record('watch-one', f.audioPath, 1)] }));
  const { port } = await f.start({ buildLibrary: buildAudioLibrary });
  const initial = (await request(port, '/api/library')).json;
  const playback = (await request(port, '/api/state')).json;
  assert.equal(initial.files.length, 1);
  assert.equal((await request(port, '/api/library/revision')).json.revision, initial.revision);
  const second = path.join(path.dirname(f.audioPath), 'second.wav');
  await fs.writeFile(second, f.bytes);
  await fs.writeFile(path.join(f.cfg.stateDir, 'page-songs.json'), JSON.stringify({ songs: [song('watch-one', 'Fixture One'), song('watch-two', 'Fixture Two')] }));
  await fs.writeFile(path.join(f.cfg.stateDir, 'history.json'), JSON.stringify({ items: [record('watch-one', f.audioPath, 1), record('watch-two', second, 2)] }));
  let head;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    head = await request(port, '/api/library/revision');
    if (head.json.revision !== initial.revision) break;
  }
  assert.notEqual(head.json.revision, initial.revision);
  assert(head.buffer.length < 128, 'revision polling does not transmit the full library');
  assert.equal((await request(port, '/api/library')).json.files.length, 2);
  assert.deepEqual((await request(port, '/api/state')).json, playback, 'background indexing does not alter playback state');
});

test('site likes are a separate read-only source: sync never touches local favorites or the CAS state', async (t) => {
  const f = await fixture(t);
  let likes = { ok: true, synced: false, complete: false, revision: '', count: 0, likes: [], fetchedAt: null, lastAttempt: null };
  let syncs = 0;
  const { port } = await f.start({
    readSiteLikes: async () => likes,
    syncSiteLikes: async () => {
      syncs += 1;
      likes = { ok: true, synced: true, complete: true, revision: 'rev-1', count: 2, fetchedAt: '2026-11-17T00:00:00Z', lastAttempt: { at: '2026-11-17T00:00:00Z', ok: true },
        likes: [{ task_id: 'song-fixture', title: 'Fixture', model: 'm', created_at: 2 }, { task_id: 'not-downloaded', title: 'Remote only', model: 'm', created_at: 1 }] };
      return likes;
    },
  });
  const saved = await request(port, '/api/state', { method: 'PUT', body: { expectedRevision: 0, favorites: ['song-fixture'] } });
  assert.equal(saved.status, 200);
  const before = await request(port, '/api/site-likes');
  assert.equal(before.status, 200); assert.equal(before.json.synced, false); assert.equal(before.json.syncing, false);
  const head0 = await request(port, '/api/library/revision');
  assert.equal(head0.json.siteLikesRevision, '');
  const synced = await request(port, '/api/site-likes/sync', { method: 'POST' });
  assert.equal(synced.status, 200); assert.equal(syncs, 1);
  assert.deepEqual(synced.json.likes.map((item) => item.task_id), ['song-fixture', 'not-downloaded']);
  const head1 = await request(port, '/api/library/revision');
  assert.equal(head1.json.siteLikesRevision, 'rev-1|2026-11-17T00:00:00Z');
  assert.equal(head1.json.revision, 'fixture-index');
  const state = await request(port, '/api/state');
  assert.deepEqual(state.json.favorites, ['song-fixture']);
  assert.equal(state.json.revision, 1);
  assert.equal((await request(port, '/api/site-likes/sync', { method: 'POST', body: { unlike: 'song-fixture' } })).status, 400);
  assert.equal((await request(port, '/api/site-likes?x=1')).status, 400);
  assert.equal((await request(port, '/api/site-likes', { method: 'POST', body: {} })).status, 404);
});

test('concurrent site-like sync requests share one in-flight read', async (t) => {
  const f = await fixture(t);
  let syncs = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = { ok: true, synced: true, complete: true, revision: 'r', count: 0, likes: [], fetchedAt: 'x', lastAttempt: null };
  const { port } = await f.start({ readSiteLikes: async () => view, syncSiteLikes: async () => { syncs += 1; await gate; return view; } });
  const pending = [request(port, '/api/site-likes/sync', { method: 'POST' }), request(port, '/api/site-likes/sync', { method: 'POST' })];
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await request(port, '/api/site-likes')).json.syncing, true);
  release();
  const results = await Promise.all(pending);
  assert.ok(results.every((item) => item.status === 200));
  assert.equal(syncs, 1);
});

test('site-like auto sync is off unless explicitly enabled', async (t) => {
  const f = await fixture(t);
  let syncs = 0;
  await f.start({ readSiteLikes: async () => ({ likes: [] }), syncSiteLikes: async () => { syncs += 1; return {}; } });
  await f.start({ autoSyncSiteLikes: true, siteLikesIntervalMs: 0, readSiteLikes: async () => ({ likes: [] }), syncSiteLikes: async () => { syncs += 1; return {}; } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(syncs, 1);
});
