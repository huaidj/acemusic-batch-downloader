import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildPlanForSongs, applyLocalSkips, buildLibrarySnapshot, getLibrarySnapshot } from '../../agent/lib/ace.mjs';
import { moveFileSafely, recordRelocations } from '../../agent/lib/file-ops.mjs';

function mp3() { const b = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0]).copy(b); return b; }
function wav() {
  const b = Buffer.alloc(60); b.write('RIFF'); b.writeUInt32LE(52, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(16, 40); return b;
}
const song = (id, extra = {}) => ({ task_id: id, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/data/' + id + '.mp3', meta: { title: 'Same Title' }, ...extra });
function fixture(songs) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-exact-runtime-')), stateDir = path.join(base, 'state'), downloadDir = path.join(base, 'downloads'), root = path.join(downloadDir, 'ai音樂');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.join(stateDir, 'cache'), { recursive: true });
  const cfg = { stateDir, downloadDir, stateFile: path.join(stateDir, 'agent-state.json'), historyFile: path.join(stateDir, 'history.json'), logFile: path.join(stateDir, 'agent.log'), sessionFile: path.join(stateDir, 'session.json'), baseUrl: 'http://127.0.0.1:1' };
  const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const put = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  json(path.join(stateDir, 'page-songs.json'), { savedAt: Date.now(), songs });
  json(path.join(stateDir, 'cache', 'songs.json'), { cachedAt: Date.now(), songs, known: songs });
  json(path.join(stateDir, 'cache', 'site-models.json'), { cachedAt: Date.now(), models: [{ id: 'acemusic-v1.1', lossy: false }, { id: 'ace-step-1.5-xl', lossy: true }] });
  return { cfg, root, put, json };
}

test('exact runtime: before/after relocation uses task+key, and force cannot be overridden by local skip', async () => {
  const s = song('so_move'), f = fixture([s]);
  const from = f.put('Same Title/Audio/Same Title.mp3', mp3());
  f.json(f.cfg.stateFile, { history: { [s.task_id]: { files: { mp3: { absolute: from, path: 'ai音樂/Same Title/Audio/Same Title.mp3' } } } } });
  const before = await buildPlanForSongs(f.cfg, [s], { types: ['mp3'], typeFolders: true });
  assert.equal(before.plan.skipped, 1);
  assert.equal(before.plan.toDownload, 0);
  assert.equal(await applyLocalSkips(f.cfg, before.plan, before.state), 0, 'dry-run and run repeat the same decision without double counting');
  const moved = await moveFileSafely(f.cfg, from, path.join(f.root, '成品MP3', 'Different actual filename.mp3'));
  await recordRelocations(f.cfg, [moved]);
  const after = await buildPlanForSongs(f.cfg, [s], { types: ['mp3'], typeFolders: true });
  assert.equal(after.plan.skipped, 1);
  assert.equal(after.plan.toDownload, 0);
  const forced = await buildPlanForSongs(f.cfg, [s], { types: ['mp3'], force: true });
  assert.equal(forced.plan.skipped, 0);
  assert.equal(forced.plan.toDownload, 1);
  assert.equal(await applyLocalSkips(f.cfg, forced.plan, forced.state), 0);
  assert.equal(forced.plan.tasks[0].files[0].skip, false);
});

test('exact runtime: same-title stems and MIDI never complete another task', async () => {
  const a = song('so_a', { stems: { '2': { status: 'done', tracks: [{ id: 'st_a', type: 'vocal', local_audio: '/stems/a.mp3' }] } } });
  const b = song('so_b', { stems: { '2': { status: 'done', tracks: [{ id: 'st_b', type: 'vocal', local_audio: '/stems/b.mp3' }] } } }), f = fixture([a, b]);
  const stem = f.put('採樣包/Vocals/Same Title - Vocals.mp3', mp3()), midi = f.put('MIDI/Same Title - MIDI.mid', 'MThd-fixture');
  f.json(f.cfg.stateFile, { aliases: { [b.task_id]: a.task_id }, history: { [a.task_id]: { files: { 'stem:st_a': { absolute: stem }, midi: { absolute: midi } } } } });
  const { plan } = await buildPlanForSongs(f.cfg, [a, b], { types: ['stems', 'midi'] });
  assert.equal(plan.total, 4);
  assert.equal(plan.skipped, 2);
  assert.equal(plan.toDownload, 2);
  assert.equal(plan.tasks.find(t => t.task_id === a.task_id).files.every(x => x.skip), true);
  assert.equal(plan.tasks.find(t => t.task_id === b.task_id).files.every(x => !x.skip), true);
  const justB = await buildPlanForSongs(f.cfg, [b], { types: ['stems', 'midi'] });
  assert.equal(justB.plan.skipped, 0);
});

test('exact runtime: raw history at the planned path cannot hide conflicting source evidence from an unselected task', async () => {
  const a = song('so_a'), b = song('so_b'), f = fixture([a, b]);
  const actual = f.put('Same Title/Same Title.mp3', mp3());
  f.json(f.cfg.stateFile, { history: { [a.task_id]: { files: { mp3: { absolute: actual, path: 'ai音樂/Same Title/Same Title.mp3' } } } } });
  f.json(f.cfg.historyFile, { items: [{ id: 1, state: 'complete', filename: actual, url: f.cfg.baseUrl + b.local_audio, fileSize: 417 }] });
  const { plan } = await buildPlanForSongs(f.cfg, [a], { types: ['mp3'] });
  assert.equal(plan.skipped, 0);
  assert.equal(plan.toDownload, 1);
  assert.equal(plan.tasks[0].files[0].skip, false);
});

test('exact runtime: snapshot uses verified/exact evidence, not same title or song alias; old snapshot schema is rejected', async () => {
  const a = song('so_a'), b = song('so_b'), f = fixture([a, b]), bytes = wav();
  const actual = f.put('成品WAV/Same Title.wav', bytes);
  f.json(path.join(f.cfg.stateDir, 'verified-audio.json'), { files: [{ task_id: a.task_id, kind: 'wav', absolute: actual, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), verifiedAt: new Date().toISOString() }] });
  const actualMp3 = f.put('成品MP3/Same Title.mp3', mp3());
  f.json(f.cfg.stateFile, { aliases: { [b.task_id]: a.task_id }, history: { [a.task_id]: { files: { mp3: { absolute: actualMp3 } } } } });
  f.json(path.join(f.cfg.stateDir, 'cache', 'library-snapshot.json'), { cachedAt: Date.now(), songs: [{ task_id: b.task_id, downloaded: { allDone: true } }], counts: { downloaded: 2 } });
  const snapshot = await getLibrarySnapshot(f.cfg);
  assert.equal(snapshot.cached, false);
  assert.equal(snapshot.schema, 'ace-library-snapshot-v2-exact-task-index');
  const first = snapshot.songs.find(s => s.task_id === a.task_id), second = snapshot.songs.find(s => s.task_id === b.task_id);
  assert.equal(first.downloaded.wav, true);
  assert.equal(first.downloaded.wavVerified, true);
  assert.equal(second.downloaded.wav, false);
  assert.equal(second.downloaded.wavVerified, false);
  assert.equal(second.downloaded.missingCount, 2);
  assert.equal(snapshot.counts.downloaded, 1);
  assert.equal(snapshot.counts.undownloaded, 1);
  assert.equal((await getLibrarySnapshot(f.cfg)).cached, true);
});

test('exact runtime: a real but unproven stem stays uncertain in snapshot rather than completed', async () => {
  const s = song('so_stem', { stems: { '2': { status: 'done', tracks: [{ id: 'st_one', type: 'drums', local_audio: '/tracks/one.mp3' }] } } }), f = fixture([s]);
  const file = f.put('採樣包/Drums/Same Title - Drums.mp3', mp3());
  f.json(f.cfg.stateFile, { history: { [s.task_id]: { files: { 'stem:st_one': { absolute: file, bytes: 500 } } } } });
  const snapshot = await buildLibrarySnapshot(f.cfg);
  const row = snapshot.songs[0];
  assert.equal(row.downloaded.allDone, false);
  const stems = row.downloaded.detail.find(x => x.type === 'stems');
  assert.equal(stems.have, 0);
  assert.equal(stems.uncertain, true);
  assert.ok(row.downloaded.uncertainCount > 0);
});
