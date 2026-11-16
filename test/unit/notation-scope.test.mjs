import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAceDlScripts } from './lib-load.mjs';
import { songDownloadSummary, summarizeSong } from '../../agent/lib/ace.mjs';

const { planner: P } = loadAceDlScripts();
const song = (id, extra = {}) => ({ task_id: id, status: 'succeeded', capability: 'music_generate',
  model: 'acemusic-v1.1', local_audio: `/data/${id}.mp3`, meta: { title: 'Same title' }, ...extra });
const requested = { '2': { status: 'done', tracks: [] } };
const kinds = (s, types = ['midi', 'musicxml', 'wav']) => Array.from(P.buildDownloadPlan({ songs: [s], options: { types } }).tasks.flatMap(t => t.files), f => f.kind);

test('notation scope: capability alone never requests notation; unseparated v1.1 still requires WAV', () => {
  const s = song('no-stems');
  assert.equal(P.midiAvailable(s), true, '保留站點原始 capability 語意');
  assert.equal(P.notationRequested(s), false);
  assert.deepEqual(kinds(s), ['wav']);
  const status = P.downloadStatusForTypes(s, { types: ['midi', 'musicxml', 'wav'] });
  assert.deepEqual(Array.from(status.detail, x => x.type), ['wav']);
  assert.equal(status.allDone, false);
  assert.equal(P.downloadStatusForTypes(s, { types: ['midi', 'musicxml', 'wav'], downloaded: { wav: true } }).allDone, true);
});

test('notation scope: requested split jobs qualify, empty placeholders and unfinished songs do not', () => {
  for (const stems of [requested, { '0': { status: 'running' } }, { jobs: [{ status: 'queued', job_id: 'split-job' }] }]) {
    const s = song('requested', { stems });
    assert.equal(P.notationRequested(s), true);
    assert.deepEqual(kinds(s), ['midi', 'musicxml', 'wav']);
  }
  for (const stems of [undefined, {}, { '2': {} }, { '0': { status: 'idle', tracks: [] } }, { metadata: { status: 'done' } }]) {
    assert.equal(P.notationRequested(song('not-requested', { stems })), false);
  }
  assert.equal(P.notationRequested(song('unfinished', { stems: requested, status: 'processing' })), false);
});

test('notation scope: same-title song cannot inherit the other task split job or notation history', () => {
  const a = song('take-a', { stems: requested }), b = song('take-b');
  const plan = P.buildDownloadPlan({ songs: [a, b], options: { types: ['midi', 'musicxml', 'wav'] },
    state: { history: { 'take-a': { files: { midi: { path: 'existing.mid' } } } } } });
  assert.deepEqual(Array.from(plan.tasks.find(t => t.task_id === b.task_id).files, x => x.kind), ['wav']);
  assert.deepEqual(Array.from(plan.tasks.find(t => t.task_id === a.task_id).files, x => x.kind), ['midi', 'musicxml', 'wav']);
  assert.equal(P.notationRequested(b), false);
});

test('notation scope: lossy models can have requested notation without WAV; generated WAV is default', () => {
  assert.deepEqual(kinds(song('xl', { model: 'ace-step-1.5-xl', stems: requested })), ['midi', 'musicxml']);
  const defaults = P.buildDownloadPlan({ songs: [song('default')], options: {} });
  assert.deepEqual(Array.from(defaults.tasks[0].files, x => x.kind), ['wav']);
  const upload = song('uploaded', { model: undefined, capability: 'music_transcribe', stems: requested });
  assert.deepEqual(kinds(upload), ['midi', 'musicxml']);
});

test('notation scope: Node summaries do not count unrequested notation and do count a missing WAV independently', () => {
  const s = song('summary');
  const none = songDownloadSummary(s, { names: new Set() });
  assert.deepEqual(none.detail.map(x => x.type), ['wav']);
  assert.equal(none.allDone, false);
  const complete = songDownloadSummary(s, { names: new Set(['same title.wav']) });
  assert.equal(complete.allDone, true);
  assert.equal(summarizeSong(s).midi_available, false);
  assert.equal(summarizeSong(s).wav_available, true);
  assert.equal(summarizeSong({ ...s, stems: requested }).midi_available, true);
  const noSupportedFiles = songDownloadSummary(song('xl-summary', { model: 'ace-step-1.5-xl' }), { names: new Set() });
  assert.equal(noSupportedFiles.allDone, true, '不適用的樂譜與WAV不可製造虛假缺件');
});

test('notation scope: uploaded original WAV is required without model/stems and uses its own URL', () => {
  const original = song('original-wav', { capability: 'music_transcribe', model: undefined, local_audio: '/uploads/original.WAV?key=fixture' });
  assert.equal(P.supportsWav(original), true);
  assert.equal(P.notationRequested(original), false);
  const plan = P.buildDownloadPlan({ songs: [original], options: { types: ['midi', 'musicxml', 'mp3', 'wav'] },
    state: { unavailable: { 'original-wav': { wav: { code: 'HTTP_404' } } } } });
  assert.equal(plan.tasks[0].files.length, 1);
  assert.equal(plan.tasks[0].files[0].kind, 'wav');
  assert.equal(plan.tasks[0].files[0].sourceUrl, 'https://acemusic.ai/uploads/original.WAV?key=fixture');
  assert.equal(plan.tasks[0].files[0].skip, false, '舊的 WAV 404 不可成為永久略過');
  const status = P.downloadStatusForTypes(original, { types: ['mp3', 'wav'], downloaded: { wav: true } });
  assert.equal(status.allDone, true, 'WAV 原檔不能藉改副檔名製造一個 MP3 缺件');
  assert.equal(summarizeSong(original).wav_available, true);
  assert.equal(songDownloadSummary(original, { names: new Set() }).allDone, false);
  const mp3Upload = { ...original, task_id: 'mp3-upload', local_audio: '/uploads/source.mp3?name=pretend.wav' };
  assert.equal(P.supportsWav(mp3Upload), false, 'query 裡的 .wav 不代表原檔為 WAV');
  assert.equal(P.buildDownloadPlan({ songs: [mp3Upload], options: { types: ['mp3'] } }).tasks[0].files[0].kind, 'mp3');
});
