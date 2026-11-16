import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fillMissing, FILL_TYPES } from '../../agent/lib/ace.mjs';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(process.env.ACE_TEST_TEMP || os.tmpdir(), 'fill-missing-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cfg = { stateDir: path.join(base, 'state'), downloadDir: path.join(base, 'downloads'), baseUrl: 'http://127.0.0.1:9', ua: 'fixture' };
  cfg.stateFile = path.join(cfg.stateDir, 'agent-state.json');
  cfg.historyFile = path.join(cfg.stateDir, 'history.json');
  cfg.sessionFile = path.join(cfg.stateDir, 'session.json');
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.mkdirSync(path.join(cfg.downloadDir, 'ai音樂'), { recursive: true });
  return cfg;
}
const song = (id, extra = {}) => ({ task_id: id, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', created_at: 1, local_audio: '/data/' + id + '.mp3', local_cover: '/data/' + id + '.jpg', meta: { title: 'Song ' + id }, ...extra });
const row = (downloaded, extra = {}) => ({ downloaded: { mp3: false, wav: false, cover: false, midi: false, musicxml: false, stems: 0, ...downloaded }, wavSupported: true, notationRequested: false, ...extra });

test('fill-missing only ever handles free types; MIDI and MusicXML are refused before any work', async (t) => {
  const cfg = sandbox(t);
  assert.deepEqual([...FILL_TYPES], ['mp3', 'wav', 'cover']);
  for (const types of [['midi'], ['musicxml'], ['stems'], ['mp3', 'midi'], []]) {
    await assert.rejects(fillMissing(cfg, { types, indexImpl: async () => { throw new Error('index must not be built'); }, songsImpl: async () => [] }), { code: 'FILL_TYPE_REFUSED' }, JSON.stringify(types));
  }
});

test('fill-missing finds gaps from the index, previews by default and never downloads in dry run', async (t) => {
  const cfg = sandbox(t);
  const songs = [song('so_gap'), song('so_full'), song('so_lossy', { model: 'ace-step-1.5-xl' }), song('so_running', { status: 'running' })];
  const index = { byTask: {
    so_gap: row({ mp3: true }),
    so_full: row({ mp3: true, wav: true, cover: true }),
    so_lossy: row({ mp3: true, cover: true }, { wavSupported: false }),
  } };
  const report = await fillMissing(cfg, { indexImpl: async () => index, songsImpl: async () => songs });
  assert.equal(report.dryRun, true);
  assert.equal(report.songsScanned, 4);
  assert.deepEqual(report.gaps.map((g) => [g.task_id, g.missing]), [['so_gap', ['wav', 'cover']]], 'complete, WAV-less models and unfinished songs are not gaps');
  assert.ok(report.files.every((file) => /so_gap|Song so_gap/.test(file.path) || file.task_id === 'so_gap'));
  assert.ok(report.files.some((file) => /\.wav$/i.test(file.path)) && report.files.some((file) => /Cover\.jpg$/i.test(file.path)), JSON.stringify(report.files));
  assert.ok(!report.files.some((file) => /\.mp3$/i.test(file.path)), 'an MP3 the index already proves is not planned');
  assert.equal(report.done, undefined, 'dry run reports no download result');
  assert.equal(fs.existsSync(path.join(cfg.downloadDir, 'ai音樂', 'Song so_gap')), false, 'nothing is written in dry run');
});

test('fill-missing narrows to the requested types and reports songs whose site source is absent', async (t) => {
  const cfg = sandbox(t);
  const upload = song('so_upload', { model: null, capability: 'music_transcribe', local_audio: '/data/so_upload.wav', local_cover: null });
  const report = await fillMissing(cfg, { types: ['cover'], indexImpl: async () => ({ byTask: { so_upload: row({ wav: true }) } }), songsImpl: async () => [upload] });
  assert.deepEqual(report.types, ['cover']);
  assert.equal(report.songsWithGaps, 1);
  assert.equal(report.toDownload, 0);
  assert.deepEqual(report.noSource, ['so_upload'], 'no cover on the site is reported, not treated as a failure');
});
