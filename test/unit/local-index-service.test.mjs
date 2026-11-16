import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compactLocalIndex, nativeIndexPayload, localDownloadIndex, invalidateLocalIndex, disposeLocalIndex } from '../../agent/lib/local-index-service.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const background = await fs.readFile(path.join(PROJECT, 'src', 'background.js'), 'utf8');
const codecStart = background.indexOf('async function decodeNativeIndexPayload(');
const codecEnd = background.indexOf('// End native index codec.', codecStart);
assert(codecStart >= 0 && codecEnd > codecStart, 'contract tests execute the actual background decoder');
const codec = vm.createContext({ Blob, DecompressionStream, TextDecoder, Uint8Array, atob, JSON, Object, Array, Error });
vm.runInContext(background.slice(codecStart, codecEnd), codec);
const decode = (value) => codec.decodeNativeIndexPayload(value);
const plain = (value) => JSON.parse(JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wav() {
  const data = Buffer.alloc(60);
  data.write('RIFF'); data.writeUInt32LE(52, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16, 40);
  return data;
}

async function fixture(t, { createRoot = true } = {}) {
  const base = process.platform === 'win32' ? 'F:\\DevData\\Temp' : os.tmpdir();
  const directory = await fs.mkdtemp(path.join(base, 'ace-index-service-'));
  const cfg = { stateDir: path.join(directory, 'state'), downloadDir: path.join(directory, 'downloads'), baseUrl: 'https://fixture.invalid' };
  cfg.stateFile = path.join(cfg.stateDir, 'agent-state.json'); cfg.historyFile = path.join(cfg.stateDir, 'history.json');
  const root = path.join(cfg.downloadDir, 'ai音樂');
  await fs.mkdir(cfg.stateDir); await fs.mkdir(cfg.downloadDir);
  if (createRoot) await fs.mkdir(root);
  const song = { task_id: 'service-song', status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/audio/service.mp3', meta: { title: 'Fixture' }, stems: { '2': { status: 'done', tracks: [] } } };
  await fs.writeFile(path.join(cfg.stateDir, 'page-songs.json'), JSON.stringify({ savedAt: 1, songs: [song] }));
  t.after(async () => {
    disposeLocalIndex(cfg);
    const relative = path.relative(await fs.realpath(base), await fs.realpath(directory));
    assert(relative.startsWith('ace-index-service-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { cfg, directory, root, song };
}

test('compact/native payload retains non-audio completion evidence and round-trips all 2000 tasks below the host frame limit', async () => {
  const byTask = {};
  for (let index = 0; index < 2000; index += 1) {
    const id = 'so_' + String(index).padStart(24, '0');
    const files = ['mp3', 'wav', 'midi', 'musicxml', 'cover'].map((kind) => ({ key: kind, kind, confidence: 'recorded', validity: ['midi', 'musicxml', 'cover'].includes(kind) ? 'unknown' : 'valid' }));
    files.push(...Array.from({ length: 10 }, (_, track) => ({ key: 'stem:st_' + String(index * 10 + track).padStart(24, '0'), kind: 'stems', confidence: 'recorded', validity: 'valid' })));
    byTask[id] = { downloaded: { mp3: true, wav: true, midi: true, musicxml: true, cover: true, stems: 10 }, notationRequested: true, wavSupported: true, files, problems: [] };
  }
  const compact = compactLocalIndex({ revision: 'large-fixture', savedAt: '2026-11-16T00:00:00Z', summary: { songs: 2000, note: '完整保留中英資料' }, byTask });
  assert.equal(Object.keys(compact.byTask).length, 2000);
  assert.deepEqual(compact.byTask[Object.keys(byTask)[0]].completedKeys.slice(0, 5), ['mp3', 'wav', 'midi', 'musicxml', 'cover']);
  assert(Buffer.byteLength(JSON.stringify(compact)) > 1024 * 1024, 'fixture actually exercises the original unsafe frame size');
  const payload = nativeIndexPayload(compact);
  assert.equal(payload.encoding, 'gzip-base64');
  const hostFrame = JSON.stringify({ id: 99, ok: true, exitCode: 0, data: payload, stderr: 'fixture'.repeat(500) });
  assert(Buffer.byteLength(hostFrame, 'utf8') < 1000000, 'native wrapper stays within its stricter safety limit');
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(payload.data, 'base64')).toString('utf8')), compact);
  assert.deepEqual(plain(await decode(payload)), compact, 'actual browser decoder restores every task/key without truncation');
  assert.deepEqual(plain(await decode(compact)), compact, 'the original compact protocol remains compatible');
});

test('native codec rejects oversized envelopes, gzip expansion bombs, malformed bytes and wrong index shapes', { timeout: 20000 }, async () => {
  const basic = { ok: true, apiVersion: 1, revision: 'fixture', savedAt: 1, byTask: {} };
  assert.throws(() => nativeIndexPayload({ ...basic, entropy: crypto.randomBytes(1100000).toString('base64') }), { code: 'NATIVE_FRAME_TOO_LARGE' });
  await assert.rejects(decode({ ok: true, encoding: 'gzip-base64', data: 'A'.repeat(900 * 1024 + 4) }), /上限/);
  await assert.rejects(decode({ ok: true, encoding: 'gzip-base64', data: '%%%=' }), /格式/);
  await assert.rejects(decode({ ok: true, encoding: 'gzip-base64', data: Buffer.from('not gzip').toString('base64') }), /解壓/);
  await assert.rejects(decode({ ok: true, encoding: 'brotli-base64', data: '' }), /格式/);
  await assert.rejects(decode(nativeIndexPayload({ ...basic, apiVersion: 2 })), /版本或資料格式/);
  await assert.rejects(decode(nativeIndexPayload({ ...basic, byTask: [] })), /版本或資料格式/);
  await assert.rejects(decode(nativeIndexPayload({ ...basic, byTask: { bad: { downloaded: {}, completedKeys: 'mp3', uncertainKinds: [] } } })), /歌曲資料格式/);
  const bomb = { ok: true, encoding: 'gzip-base64', data: gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1, 65)).toString('base64') };
  await assert.rejects(decode(bomb), /解壓大小超過上限/);
});

test('compact keeps uncertain stems separate even when another stem is already complete', () => {
  const compact = compactLocalIndex({ revision: 'partial', savedAt: 1, summary: {}, byTask: { task: { downloaded: { mp3: false, wav: false, stems: 1 }, files: [{ kind: 'stems', key: 'stem:good', confidence: 'recorded', validity: 'valid' }, { kind: 'stems', key: 'stem:pending-review', confidence: 'uncertain', validity: 'valid' }], notationRequested: true, wavSupported: true, problems: [] } } });
  assert.deepEqual(compact.byTask.task.completedKeys, ['stem:good']);
  assert.deepEqual(compact.byTask.task.uncertainKinds, ['stems']);
});

test('index service reuses snapshots, ignores incomplete/irrelevant writes, and invalidates on real metadata/media changes', async (t) => {
  const f = await fixture(t);
  const audio = path.join(f.root, 'fixture.wav');
  await fs.writeFile(audio, wav());
  await fs.writeFile(f.cfg.historyFile, JSON.stringify({ savedAt: 1, items: [{ id: 1, state: 'complete', filename: audio, fileSize: 60, url: f.cfg.baseUrl + '/api/songs/service-song/file?kind=wav' }] }));
  const first = await localDownloadIndex(f.cfg, { refresh: true });
  assert.equal(first.byTask['service-song'].downloaded.wav, true);
  const copies = await Promise.all(Array.from({ length: 4 }, () => localDownloadIndex(f.cfg)));
  assert(copies.every((index) => index.revision === first.revision && index.savedAt === first.savedAt));
  await fs.writeFile(path.join(f.cfg.stateDir, 'irrelevant-status.json'), '{}');
  await fs.writeFile(path.join(f.root, 'in-progress.wav.crdownload'), wav());
  await sleep(30);
  assert.equal((await localDownloadIndex(f.cfg)).savedAt, first.savedAt, 'non-source status and incomplete media do not rebuild the cache');
  const history = JSON.parse(await fs.readFile(f.cfg.historyFile, 'utf8'));
  history.savedAt = 99999999;
  await fs.writeFile(f.cfg.historyFile, JSON.stringify(history));
  const heartbeat = await localDownloadIndex(f.cfg, { refresh: true });
  assert.equal(heartbeat.revision, first.revision, 'export savedAt alone cannot change the semantic revision');
  await sleep(5);
  await fs.writeFile(path.join(f.cfg.stateDir, 'page-songs.json'), JSON.stringify({ songs: [{ ...f.song, meta: { title: 'Changed metadata' } }] }));
  invalidateLocalIndex(f.cfg);
  const changed = await localDownloadIndex(f.cfg);
  assert.notEqual(changed.revision, first.revision);
  const bytes = wav(); bytes[59] = 25;
  await fs.writeFile(audio, bytes);
  let physical;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(20);
    physical = await localDownloadIndex(f.cfg);
    if (physical.revision !== changed.revision) break;
  }
  assert.notEqual(physical.revision, changed.revision, 'completed media changes are picked up through the watcher without forced refresh');
});

test('ordinary CLI returns compact JSON while --native returns the complete gzip envelope', async (t) => {
  const f = await fixture(t);
  const run = (native) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROJECT, 'agent', 'cli.mjs'), 'local-index', '--json', ...(native ? ['--native'] : [])], { cwd: PROJECT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ACE_STATE_DIR: f.cfg.stateDir, ACE_DOWNLOAD_DIR: f.cfg.downloadDir, ACE_BASE_URL: 'http://127.0.0.1:1', ACE_HUB_URL: 'http://127.0.0.1:1', ACE_HUB_TOKEN: '', TEMP: path.dirname(f.directory), TMP: path.dirname(f.directory) } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('isolated CLI timeout')); }, 8000);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('isolated CLI exited ' + code + ': ' + stderr.slice(0, 120)));
      try { resolve(JSON.parse(stdout)); } catch (err) { reject(err); }
    });
  });
  const compact = await run(false);
  assert.equal(compact.apiVersion, 1); assert.equal(compact.encoding, undefined);
  const payload = await run(true);
  assert.equal(payload.encoding, 'gzip-base64');
  const restored = plain(await decode(payload));
  assert.deepEqual(restored.byTask, compact.byTask);
  assert.equal(restored.revision, compact.revision);
});
