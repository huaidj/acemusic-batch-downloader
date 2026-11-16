import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { repairWavs } from '../../scripts/repair-wavs.mjs';

function wav(fill = 1, dataLength = 140000, truncated = false) {
  const data = Buffer.alloc(44 + dataLength, fill);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8 + (truncated ? 10000 : 0), 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(44100, 24); data.writeUInt32LE(88200, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(dataLength, 40);
  return data;
}

async function fixture(t, { broken = false } = {}) {
  const base = process.env.ACE_TEST_TEMP || os.tmpdir();
  const temporary = await fs.mkdtemp(path.join(base, 'ace-wav-repair-test-'));
  const cfg = { stateDir: path.join(temporary, 'state'), downloadDir: path.join(temporary, 'downloads'), ua: 'Repair-fixture' };
  cfg.sessionFile = path.join(cfg.stateDir, 'session.json');
  await fs.mkdir(cfg.stateDir, { recursive: true });
  await fs.mkdir(cfg.downloadDir, { recursive: true });
  await fs.writeFile(cfg.sessionFile, JSON.stringify({ cookie: 'sess=fixture-only', ua: 'Repair-fixture' }));
  const requests = [];
  const sourceData = new Map([['song-one00001', wav(1)], ['song-two00002', wav(2)], ['song-broken03', wav(3, 100, true)]]);
  const fullFailures = new Map();
  const fullDownloads = [];
  const cdn = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ target: 'cdn', method: req.method, cookie: req.headers.cookie, range: req.headers.range });
    const id = url.pathname.split('/').pop();
    const body = sourceData.get(id);
    if (!body) { res.writeHead(404); return res.end(); }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), body.length - 1);
      res.writeHead(206, { 'content-type': 'audio/wav', 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
      return res.end(body.subarray(start, end + 1));
    }
    if (fullFailures.get(id) > 0) { fullFailures.set(id, fullFailures.get(id) - 1); res.writeHead(503); return res.end(); }
    fullDownloads.push(id);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve));
  const cdnBase = `http://127.0.0.1:${cdn.address().port}`;
  const songs = (broken ? ['song-broken03'] : ['song-one00001', 'song-two00002', 'song-lossy004']).map((id) => ({ task_id: id, status: 'succeeded', capability: 'music_generate', model: id.includes('lossy') ? 'ace-step-xl' : 'acemusic-v1.1', local_audio: '/unused.mp3', meta: { title: 'Same Title' } }));
  const api = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ target: 'api', method: req.method, cookie: req.headers.cookie });
    let value;
    if (url.pathname === '/api/songs') value = { items: songs, next: null };
    else if (url.pathname === '/api/status') value = { models: [{ id: 'acemusic-v1.1' }, { id: 'ace-step-xl', lossy: true }] };
    else if (/\/file$/.test(url.pathname)) value = { audio: `/redirect/${url.pathname.split('/')[3]}` };
    else if (url.pathname.startsWith('/redirect/')) {
      res.writeHead(302, { location: `${cdnBase}/audio/${url.pathname.split('/').pop()}?signature=fixture-signed-value` });
      return res.end();
    } else { res.writeHead(404); return res.end(); }
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length }); res.end(body);
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  cfg.baseUrl = `http://127.0.0.1:${api.address().port}`;
  t.after(async () => {
    await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => cdn.close(resolve))]);
    const resolved = await fs.realpath(temporary);
    assert(path.relative(await fs.realpath(base), resolved).startsWith('ace-wav-repair-test-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { cfg, temporary, workDir: path.join(temporary, 'work'), requests, fullFailures, fullDownloads, sourceData };
}

test('WAV repair downloads exact source, preserves same-name originals, strips cross-origin Cookie, and reuses verified files', async (t) => {
  const f = await fixture(t);
  const oldDirectory = path.join(f.cfg.downloadDir, 'ai音樂', '成品WAV');
  await fs.mkdir(oldDirectory, { recursive: true });
  const originalPath = path.join(oldDirectory, 'Same Title [one00001].wav');
  const original = wav(9, 100);
  await fs.writeFile(originalPath, original);
  f.fullFailures.set('song-two00002', 1);
  const events = [];
  const result = await repairWavs({ cfg: f.cfg, workDir: f.workDir, concurrency: 2, useRayburst: false, dryRun: false, onProgress: (event) => events.push(event) });
  assert.equal(result.done, 2); assert.equal(result.downloaded, 2); assert.equal(result.failed, 0); assert.equal(result.modelUnavailable, 1);
  assert.deepEqual(await fs.readFile(originalPath), original);
  const manifest = JSON.parse(await fs.readFile(path.join(f.cfg.stateDir, 'verified-audio.json'), 'utf8'));
  assert.equal(manifest.schema, 'ace_verified_audio_v1'); assert.equal(manifest.files.length, 2);
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(entry.absolute);
    assert.deepEqual(bytes, f.sourceData.get(entry.task_id));
    assert.equal(entry.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(entry.bytes, entry.sourceExpectedBytes);
  }
  assert.equal(f.requests.every((request) => request.method === 'GET'), true);
  assert.equal(f.requests.filter((request) => request.target === 'cdn').every((request) => !request.cookie), true);
  assert.equal(f.requests.filter((request) => request.target === 'api').every((request) => request.cookie === 'sess=fixture-only'), true);
  assert.equal(/fixture-signed-value|sess=fixture-only|https?:/.test(JSON.stringify(result) + JSON.stringify(events)), false);
  const previousDownloads = f.fullDownloads.length;
  const again = await repairWavs({ cfg: f.cfg, workDir: f.workDir, useRayburst: false, dryRun: false });
  assert.equal(again.reused, 2); assert.equal(again.downloaded, 0); assert.equal(again.failed, 0);
  assert.equal(f.fullDownloads.length, previousDownloads);
  await assert.rejects(fs.stat(path.join(f.cfg.stateDir, 'verified-audio.lock')), { code: 'ENOENT' });
});

test('WAV repair rejects a truncated RIFF and never records it as downloaded', async (t) => {
  const f = await fixture(t, { broken: true });
  const result = await repairWavs({ cfg: f.cfg, workDir: f.workDir, useRayburst: false, dryRun: false });
  assert.equal(result.done, 0); assert.equal(result.failed, 1); assert.equal(result.items[0].code, 'AUDIO_INVALID');
  await assert.rejects(fs.stat(path.join(f.cfg.downloadDir, 'ai音樂', '成品WAV')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.cfg.stateDir, 'verified-audio.json')), { code: 'ENOENT' });
  const report = JSON.parse(await fs.readFile(path.join(f.workDir, 'repair-result.json'), 'utf8'));
  assert.equal(report.failed, 1);
});

test('WAV repair dry run does not download files or acquire a lock; another process lock is preserved', async (t) => {
  const f = await fixture(t);
  const planned = await repairWavs({ cfg: f.cfg, workDir: f.workDir });
  assert.equal(planned.dryRun, true); assert.equal(planned.eligible, 2); assert.equal(f.fullDownloads.length, 0);
  await assert.rejects(fs.stat(f.workDir), { code: 'ENOENT' });
  const lock = path.join(f.cfg.stateDir, 'verified-audio.lock');
  await fs.writeFile(lock, 'another-process-lock');
  await assert.rejects(repairWavs({ cfg: f.cfg, workDir: f.workDir, useRayburst: false, dryRun: false }), { code: 'LOCKED' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'another-process-lock');
});

test('WAV repair reuses a verified WAV whose fingerprints were stripped in place, but still replaces an unexplained change', async (t) => {
  const f = await fixture(t);
  const first = await repairWavs({ cfg: f.cfg, workDir: f.workDir, useRayburst: false, dryRun: false });
  assert.equal(first.downloaded, 2);
  const proofFile = path.join(f.cfg.stateDir, 'verified-audio.json');
  const manifest = JSON.parse(await fs.readFile(proofFile, 'utf8'));
  // 模擬 1.8.3 指紋清除：同長度改寫檔首 metadata，proof 更新 sha256 並標記 fingerprintStripAt
  for (const [index, entry] of manifest.files.entries()) {
    const bytes = await fs.readFile(entry.absolute);
    bytes[60] ^= 0xff;
    await fs.writeFile(entry.absolute, bytes);
    if (index === 0) {
      entry.sourceSha256 = entry.sha256;
      entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      entry.fingerprintStripAt = new Date().toISOString();
    }
  }
  await fs.writeFile(proofFile, JSON.stringify(manifest));
  const before = f.fullDownloads.length;
  const again = await repairWavs({ cfg: f.cfg, workDir: f.workDir, useRayburst: false, dryRun: false });
  assert.equal(again.failed, 0);
  assert.equal(again.reused, 1, 'the stripped, re-proven WAV is reused');
  assert.equal(again.downloaded, 1, 'the WAV changed without a strip record is replaced from the source');
  assert.equal(f.fullDownloads.length, before + 1);
  const after = JSON.parse(await fs.readFile(proofFile, 'utf8'));
  const kept = after.files.find((entry) => entry.task_id === manifest.files[0].task_id);
  assert.equal(kept.absolute, manifest.files[0].absolute, 'the stripped file stays the proven copy');
});

test('WAV repair work folder must be absolute and outside the download folder, on any drive', async (t) => {
  const f = await fixture(t);
  await assert.rejects(repairWavs({ cfg: f.cfg, workDir: 'relative/work', useRayburst: false, dryRun: false }), { code: 'WORK_DIR_REQUIRED' });
  await assert.rejects(repairWavs({ cfg: f.cfg, workDir: path.join(f.cfg.downloadDir, 'ai音樂', 'work'), useRayburst: false, dryRun: false }), { code: 'WORK_DIR_REQUIRED' });
  const ok = await repairWavs({ cfg: f.cfg, workDir: f.workDir, useRayburst: false, dryRun: false });
  assert.equal(ok.failed, 0);
});
