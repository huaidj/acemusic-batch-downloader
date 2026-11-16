import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { applyLocalSkips, buildPlanForSongs, runDownload } from '../../agent/lib/ace.mjs';

function tinyWav({ truncated = false } = {}) {
  const data = Buffer.alloc(60);
  data.write('RIFF', 0); data.writeUInt32LE(truncated ? 1052 : 52, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(44100, 24); data.writeUInt32LE(88200, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(truncated ? 1016 : 16, 40);
  return data;
}

async function sandbox(t) {
  const base = process.platform === 'win32' ? 'F:\\DevData\\Temp' : os.tmpdir();
  const directory = await fs.mkdtemp(path.join(base, 'ace-integrity-test-'));
  const stateDir = path.join(directory, 'state');
  const downloadDir = path.join(directory, 'downloads');
  await Promise.all([fs.mkdir(stateDir), fs.mkdir(downloadDir)]);
  t.after(async () => {
    const relative = path.relative(await fs.realpath(base), await fs.realpath(directory));
    assert(relative.startsWith('ace-integrity-test-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { stateDir, downloadDir, baseUrl: 'http://127.0.0.1:1', ua: 'Isolated-integrity-fixture', sessionFile: path.join(stateDir, 'session.json'), historyFile: path.join(stateDir, 'history.json'), stateFile: path.join(stateDir, 'agent-state.json'), logFile: path.join(stateDir, 'agent.log') };
}

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const file = (kind, relative) => ({ key: kind, kind, path: relative, filename: path.basename(relative), skip: false });
const plan = (tasks) => ({ tasks, skipped: 0, total: tasks.reduce((n, task) => n + task.files.length, 0), toDownload: tasks.reduce((n, task) => n + task.files.length, 0) });
const song = (taskId, title = 'Same Title') => ({ task_id: taskId, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/source.mp3', meta: { title } });

test('applyLocalSkips does not substitute an alias or another folder with the same MP3 filename', async (t) => {
  const cfg = await sandbox(t);
  const other = path.join(cfg.downloadDir, 'ai音樂', '成品MP3', 'Same Title.mp3');
  await fs.mkdir(path.dirname(other), { recursive: true });
  await fs.writeFile(other, 'other-take-original');
  const pending = plan([{ task_id: 'task-new', files: [file('mp3', 'ai音樂/New Take/Same Title.mp3')] }]);
  const skipped = await applyLocalSkips(cfg, pending, { aliases: { 'task-new': 'task-old' } });
  assert.equal(skipped, 0);
  assert.equal(pending.tasks[0].files[0].skip, false);
  assert.equal(pending.toDownload, 1);
  assert.equal(await fs.readFile(other, 'utf8'), 'other-take-original');
});

test('applyLocalSkips keeps an exact-path truncated WAV pending and preserves its bytes', async (t) => {
  const cfg = await sandbox(t);
  const relative = 'ai音樂/Same Title/Same Title.wav';
  const absolute = path.join(cfg.downloadDir, ...relative.split('/'));
  const original = tinyWav({ truncated: true });
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, original);
  const before = digest(await fs.readFile(absolute));
  const pending = plan([{ task_id: 'task-one', files: [file('wav', relative)] }]);
  assert.equal(await applyLocalSkips(cfg, pending), 0);
  assert.equal(pending.tasks[0].files[0].skip, false);
  assert.equal(digest(await fs.readFile(absolute)), before);
});

test('verified audio is proof for its task only, so an equal-title second take remains pending', async (t) => {
  const cfg = await sandbox(t);
  const absolute = path.join(cfg.downloadDir, 'ai音樂', '成品WAV', 'Same Title [task-one].wav');
  const bytes = tinyWav();
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, bytes);
  await fs.writeFile(path.join(cfg.stateDir, 'verified-audio.json'), JSON.stringify({ schema: 'ace_verified_audio_v1', files: [{ task_id: 'task-one', kind: 'wav', absolute, bytes: bytes.length, sha256: digest(bytes), sourceExpectedBytes: bytes.length, verification: 'download_and_riff' }] }));
  const pending = plan([
    { task_id: 'task-one', files: [file('wav', 'ai音樂/Same Title/Same Title.wav')] },
    { task_id: 'task-two', files: [file('wav', 'ai音樂/Same Title (2)/Same Title (2).wav')] },
  ]);
  assert.equal(await applyLocalSkips(cfg, pending), 1);
  assert.equal(pending.tasks[0].files[0].skip, true);
  assert.equal(pending.tasks[1].files[0].skip, false);
  assert.equal(pending.toDownload, 1);
  assert.equal(pending.skipped, 1);
});

test('buildPlanForSongs ignores stale MP3 history whose absolute or relative file is missing', async (t) => {
  const cfg = await sandbox(t);
  await fs.writeFile(cfg.stateFile, JSON.stringify({ history: {
    'missing-absolute': { folder: 'Absolute', files: { mp3: { absolute: path.join(cfg.downloadDir, 'does-not-exist.mp3') } } },
    'missing-relative': { folder: 'Relative', files: { mp3: { path: 'ai音樂/missing.mp3' } } },
  } }));
  const { plan: planned } = await buildPlanForSongs(cfg, [song('missing-absolute', 'Absolute'), song('missing-relative', 'Relative')], { types: ['mp3'] });
  assert.equal(planned.total, 2);
  assert.equal(planned.toDownload, 2);
  assert.equal(planned.skipped, 0);
  assert(planned.tasks.every((task) => task.files.every((entry) => entry.skip === false)));
});

test('runDownload rejects a truncated source WAV without publishing it or recording completed history', async (t) => {
  const cfg = await sandbox(t);
  const requests = [];
  const body = tinyWav({ truncated: true });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, path: url.pathname });
    let data;
    if (url.pathname === '/api/status') data = { models: [{ id: 'acemusic-v1.1' }] };
    else if (url.pathname === '/api/songs/fixture-song/file' && url.searchParams.get('as') === 'parts') data = { server: true };
    if (data) {
      const json = Buffer.from(JSON.stringify(data));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': json.length });
      return res.end(json);
    }
    if (url.pathname === '/api/songs/fixture-song/file') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length });
      return res.end(body);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  cfg.baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(cfg.sessionFile, JSON.stringify({ cookie: 'fixture=1' }));
  const result = await runDownload({ cfg, songs: [song('fixture-song', 'Truncated Fixture')], options: { types: ['wav'] }, concurrency: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.done, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(requests.every((request) => request.method === 'GET'), true);
  const state = JSON.parse(await fs.readFile(cfg.stateFile, 'utf8'));
  assert.equal(state.history?.['fixture-song']?.files?.wav, undefined);
  const target = path.join(cfg.downloadDir, 'ai音樂', 'Truncated Fixture', 'Truncated Fixture.wav');
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await assert.rejects(fs.stat(target + '.part'), { code: 'ENOENT' });
});
