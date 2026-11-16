import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildLocalDownloadIndex, buildAudioLibrary, namingJournalMoves } from '../../agent/lib/local-index.mjs';
import { fileIdFromStat, fileIdForPath, physicalFileKey, legacyPathFileId } from '../../agent/lib/file-id.mjs';
import { moveFileSafely, recordRelocations } from '../../agent/lib/file-ops.mjs';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function mp3() { const data = Buffer.alloc(417); Buffer.from([0xff, 0xfb, 0x90, 0]).copy(data); return data; }
function wav(length = 19200) {
  const b = Buffer.alloc(44 + length);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(length, 40); return b;
}
function fixture(songs) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-local-index-'));
  const stateDir = path.join(base, 'state'), downloadDir = path.join(base, 'downloads'), root = path.join(downloadDir, 'ai音樂');
  fs.mkdirSync(stateDir, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  const cfg = { stateDir, downloadDir, stateFile: path.join(stateDir, 'agent-state.json'), historyFile: path.join(stateDir, 'history.json'), baseUrl: 'https://example.test' };
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  const json = (file, value) => write(file, JSON.stringify(value));
  json(path.join(stateDir, 'page-songs.json'), { songs });
  return { base, cfg, root, write, json };
}
const song = (id, extra = {}) => ({ task_id: id, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/data/' + id + '.mp3', meta: { title: 'Twin' }, ...extra });
const complete = (id, file, url, bytes) => ({ id, state: 'complete', filename: file, url, fileSize: bytes });

test('local index: same-title songs require their own source; no filename or aliases inheritance', async () => {
  const a = song('so_a'), b = song('so_b'), f = fixture([a, b]);
  const file = f.write(path.join(f.root, 'Twin', 'Audio', 'Twin.mp3'), mp3());
  f.json(f.cfg.historyFile, { items: [complete(1, file, f.cfg.baseUrl + a.local_audio, 417)] });
  f.json(f.cfg.stateFile, { aliases: { so_b: 'so_a' } });
  const index = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(index.byTask.so_a.downloaded.mp3, true);
  assert.equal(index.byTask.so_b.downloaded.mp3, false);
  assert.equal(index.byTask.so_b.files.length, 0);
  assert.equal(index.byTask.so_a.files[0].confidence, 'recorded');
  assert.doesNotThrow(() => JSON.stringify(index), 'index must be serializable for the native/plugin bridge');
});

test('local index: copied manifest from another task remains uncertain even at a real, healthy file', async () => {
  const a = song('so_a'), b = song('so_b'), f = fixture([a, b]);
  const source = f.write(path.join(f.root, 'Twin', 'Audio', 'Twin.mp3'), mp3());
  const wrong = f.write(path.join(f.root, '成品MP3', 'Twin (2).mp3'), mp3());
  f.json(f.cfg.historyFile, { items: [complete(1, source, f.cfg.baseUrl + a.local_audio, 417)] });
  f.json(path.join(f.root, '成品MP3', '_manifest.json'), { items: [{ task_id: b.task_id, file: path.basename(wrong), source, size: 417, mode: 'copied' }] });
  const index = await buildLocalDownloadIndex({ cfg: f.cfg });
  const record = index.byTask.so_b.files[0];
  assert.equal(record.validity, 'valid');
  assert.equal(record.confidence, 'uncertain');
  assert.equal(index.byTask.so_b.downloaded.mp3, false);
  assert.ok(index.byTask.so_b.problems.some(x => x.code === 'COPIED_FROM_OTHER_TASK'));
  const { library } = await buildAudioLibrary({ cfg: f.cfg });
  assert.equal(library.tracks.find(x => x.id === b.task_id).formats.mp3.status, 'uncertain');
});

test('local index: relocated proof checks SHA; readonly mode leaves all metadata untouched; explicit repair backs up atomically', async () => {
  const s = song('so_proof'), f = fixture([s]), data = wav();
  const old = path.join(f.root, '成品WAV', 'Twin [proof].wav');
  const current = f.write(path.join(f.root, '成品WAV', 'Twin.wav'), data);
  f.json(f.cfg.stateFile, { removedPaths: { [old.toLowerCase()]: current } });
  const proofFile = path.join(f.cfg.stateDir, 'verified-audio.json');
  f.json(proofFile, { schema: 'fixture', files: [{ task_id: s.task_id, kind: 'wav', absolute: old, path: 'ai音樂/成品WAV/Twin [proof].wav', bytes: data.length, sha256: sha(data), verifiedAt: new Date().toISOString() }] });
  const original = fs.readFileSync(proofFile, 'utf8'), filesBefore = fs.readdirSync(f.cfg.stateDir).sort();
  const index = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(index.byTask.so_proof.downloaded.wav, true);
  assert.equal(index.byTask.so_proof.files[0].confidence, 'verified');
  assert.equal(index.byTask.so_proof.files[0].evidence.relocated, true);
  assert.equal(fs.readFileSync(proofFile, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(f.cfg.stateDir).sort(), filesBefore);
  const repaired = await buildLocalDownloadIndex({ cfg: f.cfg, repairProofs: true });
  assert.equal(repaired.summary.metadataRepair.repaired, 1);
  const saved = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  assert.equal(saved.files[0].absolute, current);
  assert.equal(saved.files[0].previousAbsolute, old);
  const backups = fs.readdirSync(path.join(f.cfg.stateDir, 'metadata-backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.cfg.stateDir, 'metadata-backups', backups[0]), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(f.cfg.stateDir, 'verified-audio.lock')), false);
});

test('local index: wrong relocation hash does not become verified and never repairs a proof', async () => {
  const s = song('so_bad'), f = fixture([s]), actual = wav(), old = path.join(f.root, 'gone.wav');
  const target = f.write(path.join(f.root, 'retained.wav'), actual);
  f.json(f.cfg.stateFile, { removedPaths: { [old.toLowerCase()]: target } });
  const proofFile = path.join(f.cfg.stateDir, 'verified-audio.json');
  f.json(proofFile, { files: [{ task_id: s.task_id, kind: 'wav', absolute: old, bytes: actual.length, sha256: '0'.repeat(64), verifiedAt: new Date().toISOString() }] });
  const before = fs.readFileSync(proofFile, 'utf8');
  const index = await buildLocalDownloadIndex({ cfg: f.cfg, repairProofs: true });
  assert.equal(index.byTask.so_bad.downloaded.wav, false);
  assert.equal(index.byTask.so_bad.files[0].confidence, 'uncertain');
  assert.equal(fs.readFileSync(proofFile, 'utf8'), before);
});

test('local index: WAV content under mp3 name is not a completed MP3 or canonical WAV', async () => {
  const s = song('so_fake'), f = fixture([s]), bytes = wav();
  const file = f.write(path.join(f.root, '成品MP3', 'Twin.mp3'), bytes);
  f.json(f.cfg.historyFile, { items: [complete(1, file, f.cfg.baseUrl + s.local_audio, bytes.length)] });
  const index = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(index.byTask.so_fake.downloaded.mp3, false);
  assert.equal(index.byTask.so_fake.downloaded.wav, false);
  assert.equal(index.byTask.so_fake.files[0].validity, 'damaged');
  const { library, filesById } = await buildAudioLibrary({ cfg: f.cfg });
  assert.equal(library.files[0].format, 'wav');
  assert.equal(library.files[0].validity, 'damaged');
  assert.equal(library.tracks[0].preferredFileId, null);
  assert.equal(filesById.get(library.files[0].id).absolutePath, file);
});

test('local index: MIDI/XML eligibility is per task and stems require the exact metadata track URL', async () => {
  const a = song('so_a'), b = song('so_b', { stems: { '2': { status: 'done', tracks: [{ id: 'st_b', type: 'drums', local_audio: '/tracks/b.mp3' }] } } }), f = fixture([a, b]);
  const aMidi = f.write(path.join(f.root, 'a.mid'), Buffer.from('MThd-fixture'));
  const bMidi = f.write(path.join(f.root, 'b.mid'), Buffer.from('MThd-fixture'));
  const stem = f.write(path.join(f.root, '採樣包', 'Drums', 'Twin - Drums.mp3'), mp3());
  f.json(f.cfg.stateFile, { history: { so_a: { files: { midi: { absolute: aMidi } } }, so_b: { files: { midi: { absolute: bMidi } } } } });
  f.json(f.cfg.historyFile, { items: [complete(1, stem, f.cfg.baseUrl + '/tracks/b.mp3', 417)] });
  const index = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(index.byTask.so_a.downloaded.midi, false);
  assert.equal(index.byTask.so_b.downloaded.midi, true);
  assert.equal(index.byTask.so_a.downloaded.stems, 0);
  assert.equal(index.byTask.so_b.downloaded.stems, 1);
});

test('local index: hardlinks collapse, classification-only audio remains browsable, and symlinks cannot escape', async () => {
  const f = fixture([]);
  const main = f.write(path.join(f.root, '成品WAV', 'main.wav'), wav());
  const view = path.join(f.root, '音頻分類', '完整歌曲', 'BPM', 'main.wav');
  fs.mkdirSync(path.dirname(view), { recursive: true }); fs.linkSync(main, view);
  f.write(path.join(f.root, '音頻分類', '完整歌曲', 'orphan.mp3'), mp3());
  const outside = path.join(f.base, 'outside');
  f.write(path.join(outside, 'private.mp3'), mp3());
  fs.symlinkSync(outside, path.join(f.root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const { library, filesById } = await buildAudioLibrary({ cfg: f.cfg });
  assert.equal(library.files.length, 2);
  assert.ok(library.files.some(x => x.relativePath.startsWith('音頻分類/') && x.name === 'orphan.mp3'));
  assert.ok(library.files.some(x => x.relativePath === '成品WAV/main.wav'));
  assert.ok(!library.files.some(x => x.name === 'private.mp3'));
  for (const file of library.files) {
    assert.ok(file.id.startsWith('audio_'));
    assert.ok(path.isAbsolute(filesById.get(file.id).absolutePath));
    assert.equal(filesById.get(file.id).bytes, file.bytes);
  }
  assert.equal(JSON.stringify(library).includes(f.base.replaceAll('\\', '\\\\')), false);
});

test('local index: repair respects the same lock as the WAV downloader', async () => {
  const s = song('so_lock'), f = fixture([s]), data = wav(), old = path.join(f.root, 'old.wav');
  const target = f.write(path.join(f.root, 'target.wav'), data);
  f.json(f.cfg.stateFile, { removedPaths: { [old.toLowerCase()]: target } });
  const proofFile = path.join(f.cfg.stateDir, 'verified-audio.json');
  f.json(proofFile, { files: [{ task_id: s.task_id, kind: 'wav', absolute: old, bytes: data.length, sha256: sha(data), verifiedAt: new Date().toISOString() }] });
  const before = fs.readFileSync(proofFile, 'utf8'), lockFile = path.join(f.cfg.stateDir, 'verified-audio.lock');
  f.json(lockFile, { nonce: 'other-writer' });
  const index = await buildLocalDownloadIndex({ cfg: f.cfg, repairProofs: true });
  assert.ok(index.problems.some(x => x.code === 'PROOF_REPAIR_LOCKED'));
  assert.equal(fs.readFileSync(proofFile, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'other-writer');
  assert.equal(fs.existsSync(path.join(f.cfg.stateDir, 'metadata-backups')), false);
});

test('local index: browser-owned task history matches a real post-native-move path without title inheritance', async () => {
  const a = song('so_native_a'), b = song('so_native_b'), f = fixture([a, b]);
  const actual = f.write(path.join(f.root, '成品MP3', 'Native fixed name.mp3'), mp3());
  f.json(path.join(f.cfg.stateDir, 'browser-download-state.json'), { savedAt: 1, history: {
    [a.task_id]: { files: { mp3: { absolute: actual, path: 'ai音樂/成品MP3/Native fixed name.mp3', at: 1 } } },
  } });
  const index = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(index.byTask[a.task_id].downloaded.mp3, true);
  assert.equal(index.byTask[b.task_id].downloaded.mp3, false);
  assert.equal(index.byTask[a.task_id].files[0].confidence, 'recorded');
  assert.equal(index.byTask[a.task_id].files[0].evidence.source, 'browser-download-state');
});

test('local index: export timestamps do not change revision, while stems, sources, exact history and NA changes do', async () => {
  const s = song('so_revision', { stems: { '2': { status: 'running', tracks: [] } } }), f = fixture([s]);
  const actual = f.write(path.join(f.root, '成品MP3', 'revision.mp3'), mp3());
  const chrome = { savedAt: 1, items: [complete(1, actual, f.cfg.baseUrl + s.local_audio, 417)] };
  const own = { savedAt: 1, history: { [s.task_id]: { files: { mp3: { absolute: actual, path: 'ai音樂/成品MP3/revision.mp3', at: 1 } } } } };
  const ownPath = path.join(f.cfg.stateDir, 'browser-download-state.json'), pagePath = path.join(f.cfg.stateDir, 'page-songs.json');
  f.json(f.cfg.historyFile, chrome); f.json(ownPath, own);
  const first = await buildLocalDownloadIndex({ cfg: f.cfg });
  chrome.savedAt = 99999; own.savedAt = 99999;
  f.json(f.cfg.historyFile, chrome); f.json(ownPath, own); f.json(pagePath, { savedAt: 99999, songs: [s] });
  const unchanged = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(unchanged.revision, first.revision);
  s.stems['2'] = { status: 'done', tracks: [{ id: 'new_stem', type: 'drums', local_audio: '/tracks/new-version.mp3' }] };
  f.json(pagePath, { savedAt: 99999, songs: [s] });
  const stemsChanged = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.notEqual(stemsChanged.revision, first.revision);
  chrome.items[0].url = f.cfg.baseUrl + '/data/different-source.mp3';
  f.json(f.cfg.historyFile, chrome);
  const sourceChanged = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.notEqual(sourceChanged.revision, stemsChanged.revision);
  own.history[s.task_id].files.mp3.at = 2;
  f.json(ownPath, own);
  const ownChanged = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.notEqual(ownChanged.revision, sourceChanged.revision);
  f.json(f.cfg.stateFile, { unavailable: { [s.task_id]: { midi: { code: 'no_download', at: 1 } } } });
  assert.notEqual((await buildLocalDownloadIndex({ cfg: f.cfg })).revision, ownChanged.revision);
});

test('local index: BigInt physical identity distinguishes large NTFS inodes and survives rename/hardlinks', async () => {
  const large = 2n ** 60n;
  const a = { dev: 7n, ino: large + 1n }, b = { dev: 7n, ino: large + 2n };
  assert.notEqual(fileIdFromStat(a, 'a.wav'), fileIdFromStat(b, 'a.wav'));
  assert.notEqual(physicalFileKey(a, 'a.wav'), physicalFileKey(b, 'a.wav'));
  assert.equal(fileIdFromStat({ dev: 0n, ino: 0n }, 'a.wav'), legacyPathFileId('a.wav'));
  const f = fixture([]), original = f.write(path.join(f.root, 'original.wav'), wav());
  const first = await fileIdForPath(original), renamed = path.join(f.root, 'renamed.wav');
  fs.renameSync(original, renamed);
  assert.equal(await fileIdForPath(renamed), first);
  const link = path.join(f.root, 'linked.wav'); fs.linkSync(renamed, link);
  assert.equal(await fileIdForPath(link), first);
  const { library } = await buildAudioLibrary({ cfg: f.cfg });
  assert.equal(library.files.length, 1);
  assert.equal(library.files[0].id, first);
});

test('local index: SHA-confirmed dedupe preserves old physical/path IDs for Range and keeps source proof verified', async () => {
  const s = song('so_alias'), f = fixture([s]), data = wav();
  const source = f.write(path.join(f.root, 'Song', 'Audio', 'Twin.wav'), data);
  const keeper = f.write(path.join(f.root, '成品WAV', 'Twin.wav'), data);
  const oldId = await fileIdForPath(source), newId = await fileIdForPath(keeper), legacyId = legacyPathFileId(source);
  assert.notEqual(oldId, newId);
  f.json(path.join(f.cfg.stateDir, 'verified-audio.json'), { files: [{ task_id: s.task_id, kind: 'wav', absolute: source, bytes: data.length, sha256: sha(data), verifiedAt: new Date().toISOString() }] });
  const move = await moveFileSafely(f.cfg, source, keeper);
  assert.equal(move.deduped, true);
  assert.equal(move.fromFileId, oldId);
  assert.equal(move.toFileId, newId);
  await recordRelocations(f.cfg, [move]);
  const state = JSON.parse(fs.readFileSync(f.cfg.stateFile, 'utf8'));
  assert.equal(state.fileIdAliases[oldId], newId);
  const { library, filesById } = await buildAudioLibrary({ cfg: f.cfg });
  assert.equal(library.fileAliases[oldId], newId);
  assert.equal(library.fileAliases[legacyId], newId);
  assert.equal(filesById.get(oldId).absolutePath, keeper);
  assert.equal(filesById.get(oldId).id, newId);
  assert.equal(filesById.get(legacyId).absolutePath, keeper);
  assert.equal(library.tracks[0].formats.wav.status, 'verified');
});

test('local index: alias cycles and missing targets never create a readable Range mapping', async () => {
  const f = fixture([]);
  f.write(path.join(f.root, 'safe.mp3'), mp3());
  f.json(f.cfg.stateFile, { fileIdAliases: { cycle_a: 'cycle_b', cycle_b: 'cycle_a', absent_old: 'absent_new' } });
  const { library, filesById } = await buildAudioLibrary({ cfg: f.cfg });
  assert.equal(library.fileAliases.cycle_a, undefined);
  assert.equal(library.fileAliases.absent_old, undefined);
  assert.equal(filesById.has('cycle_a'), false);
  assert.equal(filesById.has('absent_old'), false);
  assert.equal(library.files.length, 1);
});

test('local index: exact legacy classification sources restore cover, notation and stems without using song/title labels', async () => {
  const a = song('so_class_a', { local_cover: '/covers/a.jpg', stems: { '2': { status: 'done', tracks: [{ id: 'st_class_a', type: 'vocal', local_audio: '/tracks/a.mp3' }] } } });
  const b = song('so_class_b', { local_cover: '/covers/b.jpg', stems: { '2': { status: 'done', tracks: [{ id: 'st_class_b', type: 'vocal', local_audio: '/tracks/b.mp3' }] } } }), f = fixture([a, b]);
  const oldCover = path.join(f.root, 'A', 'Cover', 'old.jpg'), oldMidi = path.join(f.root, 'A', 'MIDI', 'old.mid'), oldXml = path.join(f.root, 'A', 'MIDI', 'old.musicxml'), oldStem = path.join(f.root, 'A', 'Stems', 'old.mp3');
  const cover = f.write(path.join(f.root, '封面', 'Different cover.jpg'), 'jpeg-fixture');
  const midi = f.write(path.join(f.root, 'MIDI', 'Different notation.mid'), 'MThd-fixture'), xml = f.write(path.join(f.root, 'MusicXML', 'Different score.musicxml'), '<score/>');
  const stem = f.write(path.join(f.root, '採樣包', 'Vocals', 'Different stem.mp3'), mp3());
  f.json(f.cfg.historyFile, { items: [
    complete(1, oldCover, f.cfg.baseUrl + a.local_cover, fs.statSync(cover).size),
    complete(2, oldMidi, f.cfg.baseUrl + '/api/songs/' + a.task_id + '/download?kind=full', fs.statSync(midi).size),
    complete(3, oldStem, f.cfg.baseUrl + '/tracks/a.mp3', 417),
  ] });
  f.json(f.cfg.stateFile, { unknown: 'keep', history: { [a.task_id]: { files: { musicxml: { absolute: oldXml } } } } });
  for (const [folder, source, target] of [['封面', oldCover, cover], ['MIDI', oldMidi, midi], ['MusicXML', oldXml, xml]]) {
    f.json(path.join(f.root, folder, '_manifest.json'), { schema: 'ace_file_category_v1', items: [{ source, file: path.basename(target), size: fs.statSync(target).size, song: 'wrong title must be ignored' }] });
  }
  f.json(path.join(f.root, '採樣包', '_manifest.json'), { schema: 'ace_samples_manifest_v1', items: [{ source: oldStem, file: path.basename(stem), type: 'Vocals', size: 417, song: 'so_class_b' }] });
  const before = fs.readFileSync(f.cfg.stateFile, 'utf8'), index = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(index.byTask[a.task_id].downloaded.cover, true);
  assert.equal(index.byTask[a.task_id].downloaded.midi, true);
  assert.equal(index.byTask[a.task_id].downloaded.musicxml, true);
  assert.equal(index.byTask[a.task_id].downloaded.stems, 1);
  for (const kind of ['cover', 'midi', 'musicxml']) assert.equal(index.byTask[b.task_id].downloaded[kind], false);
  assert.equal(index.byTask[b.task_id].downloaded.stems, 0);
  assert.equal(index.byTask[a.task_id].files.filter(x => x.evidence.source === 'classification_manifest').every(x => x.confidence === 'recorded'), true);
  assert.equal(fs.readFileSync(f.cfg.stateFile, 'utf8'), before, 'manifest recovery is a read-only index derivation');
});

test('local index: ambiguous classification source or destination ownership stays uncertain', async () => {
  for (const sharedSource of [true, false]) {
    const a = song('so_cover_a', { local_cover: '/covers/a.jpg' }), b = song('so_cover_b', { local_cover: '/covers/b.jpg' }), f = fixture([a, b]);
    const oldA = path.join(f.root, 'A', 'old.jpg'), oldB = sharedSource ? oldA : path.join(f.root, 'B', 'old.jpg');
    const target = f.write(path.join(f.root, '封面', 'same.jpg'), 'same-size');
    f.json(f.cfg.historyFile, { items: [complete(1, oldA, f.cfg.baseUrl + a.local_cover, 9), complete(2, oldB, f.cfg.baseUrl + b.local_cover, 9)] });
    f.json(path.join(f.root, '封面', '_manifest.json'), { schema: 'ace_file_category_v1', items: [
      { source: oldA, file: path.basename(target), size: 9 }, ...(!sharedSource ? [{ source: oldB, file: path.basename(target), size: 9 }] : []),
    ] });
    const index = await buildLocalDownloadIndex({ cfg: f.cfg });
    for (const s of [a, b]) {
      assert.equal(index.byTask[s.task_id].downloaded.cover, false);
      assert.equal(index.byTask[s.task_id].files[0].confidence, 'uncertain');
      assert.ok(index.byTask[s.task_id].problems.some(x => /CLASSIFICATION_(SOURCE_CONFLICT|TARGET_SHARED)/.test(x.code)));
    }
  }
});

test('local index: traversal/type escapes and unclaimed lookalike sources cannot restore a classification', async () => {
  const s = song('so_escape', { local_cover: '/cover.jpg', stems: { '2': { status: 'done', tracks: [{ id: 'st_escape', type: 'drums', local_audio: '/stem.mp3' }] } } }), f = fixture([s]);
  const coverSource = path.join(f.root, 'old-cover.jpg'), midiSource = path.join(f.root, 'old-midi.mid'), stemSource = path.join(f.root, 'old-stem.mp3');
  f.write(path.join(f.root, 'loose.jpg'), 'jpeg');
  f.write(path.join(f.root, 'MIDI', 'existing.mid'), 'MThd-fixture');
  f.write(path.join(f.root, 'escape', 'existing.mp3'), mp3());
  f.json(f.cfg.historyFile, { items: [complete(1, coverSource, f.cfg.baseUrl + s.local_cover, 4), complete(2, stemSource, f.cfg.baseUrl + '/stem.mp3', 417)] });
  f.json(f.cfg.stateFile, { history: { [s.task_id]: { files: { midi: { absolute: midiSource } } } } });
  f.json(path.join(f.root, '封面', '_manifest.json'), { schema: 'ace_file_category_v1', items: [{ source: coverSource, file: '../loose.jpg', size: 4 }] });
  f.json(path.join(f.root, 'MIDI', '_manifest.json'), { schema: 'ace_file_category_v1', items: [{ source: path.join(f.root, 'lookalike-midi.mid'), file: 'existing.mid', size: 12, song: s.meta.title }] });
  f.json(path.join(f.root, '採樣包', '_manifest.json'), { schema: 'ace_samples_manifest_v1', items: [{ source: stemSource, file: 'existing.mp3', type: '../escape', size: 417 }] });
  const index = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(index.byTask[s.task_id].downloaded.cover, false);
  assert.equal(index.byTask[s.task_id].downloaded.midi, false);
  assert.equal(index.byTask[s.task_id].downloaded.stems, 0);
  assert.ok(index.problems.filter(x => x.code === 'CLASSIFICATION_TARGET_REJECTED').length >= 2);
});

test('local index: 命名爐 rename journal keeps download evidence on the renamed file; without it the file is missing', async () => {
  const a = song('so_named'), f = fixture([a]);
  const oldPath = path.join(f.root, 'Twin', 'Audio', 'Twin.mp3');
  const renamed = f.write(path.join(f.root, 'Twin', 'Audio', '玄武錯步.mp3'), mp3());
  f.json(f.cfg.historyFile, { items: [complete(1, oldPath, f.cfg.baseUrl + a.local_audio, 417)] });
  const without = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(without.byTask.so_named.downloaded.mp3, false);
  assert.ok(without.byTask.so_named.problems.some((x) => x.code === 'RECORDED_PATH_MISSING'));
  f.json(path.join(f.root, '_命名爐改名紀錄.json'), { schema: 'ace_naming_journal_v1', entries: [{ batch: 'b1', at: 'x', from: 'Twin/Audio/Twin.mp3', to: 'Twin/Audio/玄武錯步.mp3', bytes: 417 }] });
  const withJournal = await buildLocalDownloadIndex({ cfg: f.cfg });
  assert.equal(withJournal.byTask.so_named.downloaded.mp3, true);
  assert.equal(withJournal.byTask.so_named.files[0].absolute, renamed);
});

test('naming journal: only in-library relative moves are accepted; tool relocations win over the journal', () => {
  const root = path.resolve(os.tmpdir(), 'ai音樂');
  const moves = namingJournalMoves({ schema: 'ace_naming_journal_v1', entries: [
    { from: 'A/x.mp3', to: 'A/y.mp3' },
    { from: '../escape.mp3', to: 'A/z.mp3' },
    { from: 'A/q.mp3', to: '' },
    { from: 'A/same.mp3', to: 'A/same.mp3' },
    null,
  ] }, root);
  assert.deepEqual(Object.keys(moves), [path.resolve(root, 'A', 'x.mp3').toLowerCase()]);
  assert.deepEqual(namingJournalMoves({ schema: 'other', entries: [{ from: 'a', to: 'b' }] }, root), {});
  assert.deepEqual(namingJournalMoves(null, root), {});
});

test('audio library: MP3 duration comes from the analysis cache only when path and size match', async () => {
  const a = song('so_dur'), f = fixture([a]);
  const file = f.write(path.join(f.root, '成品MP3', 'Twin.mp3'), mp3());
  const other = f.write(path.join(f.root, '採樣包', 'Drums', 'Loose - Drums.mp3'), mp3());
  f.json(path.join(f.cfg.stateDir, 'cache', 'audio-analysis.json'), { items: {
    [path.resolve(file)]: { file, size: 417, ok: true, duration: 183.5 },
    [path.resolve(other)]: { file: other, size: 999, ok: true, duration: 50 },
  } });
  const { library } = await buildAudioLibrary({ cfg: f.cfg });
  assert.equal(library.files.find((x) => x.name === 'Twin.mp3').duration, 183.5);
  assert.equal(library.files.find((x) => x.name === 'Loose - Drums.mp3').duration, null, 'size mismatch means a stale cache entry is ignored');
});
