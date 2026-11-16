import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sameFileContent, moveFileSafely, copyFileSafely, recordRelocations, archiveLibraryFile } from '../../agent/lib/file-ops.mjs';
import { collectFullWavs, collectSamples, classifyByAttributes } from '../../agent/lib/ace.mjs';
import { fileIdForPath, legacyPathFileId } from '../../agent/lib/file-id.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-file-ops-'));
  const stateDir = path.join(base, 'state'), downloadDir = path.join(base, 'downloads'), root = path.join(downloadDir, 'ai音樂');
  fs.mkdirSync(stateDir, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  const cfg = { stateDir, downloadDir, stateFile: path.join(stateDir, 'agent-state.json'), historyFile: path.join(stateDir, 'history.json'), logFile: path.join(stateDir, 'agent.log'), baseUrl: 'https://example.test' };
  const put = (relative, body) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
  const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  return { base, root, cfg, put, json };
}

test('file ops: same size is only a precheck; unique transfer preserves both different audio bodies', async () => {
  const f = fixture(), from = f.put('Song/input.wav', 'source'), target = f.put('成品WAV/input.wav', 'target');
  assert.equal(await sameFileContent(from, target), false);
  const moved = await moveFileSafely(f.cfg, from, target);
  assert.equal(moved.moved, true);
  assert.equal(moved.deduped, false);
  assert.equal(path.basename(moved.to), 'input (2).wav');
  assert.equal(fs.readFileSync(target, 'utf8'), 'target');
  assert.equal(fs.readFileSync(moved.to, 'utf8'), 'source');
  assert.equal(fs.existsSync(from), false);
});

test('file ops: identical same-format source is archived for rollback; cross-format never merges', async () => {
  const f = fixture(), from = f.put('Song/copy.wav', 'identical'), target = f.put('成品WAV/copy.wav', 'identical');
  const result = await moveFileSafely(f.cfg, from, target, { reason: 'fixture-dedupe' });
  assert.equal(result.deduped, true);
  assert.equal(result.moved, false);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), 'identical');
  const archiveRoot = path.join(f.cfg.stateDir, 'organize-backups');
  const metadataDir = path.join(archiveRoot, fs.readdirSync(archiveRoot)[0]);
  const metadata = JSON.parse(fs.readFileSync(path.join(metadataDir, '_operation.json'), 'utf8'));
  assert.equal(metadata.sha256, crypto.createHash('sha256').update('identical').digest('hex'));
  assert.ok(metadata.owner.tool);
  assert.ok(metadata.retention);
  assert.equal(fs.existsSync(from), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'identical');
  const cross = f.put('Song/cross.wav', 'identical'), mp3 = f.put('成品MP3/cross.mp3', 'identical');
  await assert.rejects(moveFileSafely(f.cfg, cross, mp3), { code: 'FILE_FORMAT_MISMATCH' });
  assert.equal(fs.existsSync(cross), true);
  assert.equal(fs.readFileSync(mp3, 'utf8'), 'identical');
});

test('file ops: overwrite archives the original target; copying never removes the source', async () => {
  const f = fixture(), from = f.put('new.mid', 'new-body'), target = f.put('MIDI/old.mid', 'old-body');
  const moved = await moveFileSafely(f.cfg, from, target, { conflict: 'overwrite' });
  assert.equal(fs.readFileSync(moved.backup, 'utf8'), 'old-body');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new-body');
  const source = f.put('Song/sample.mp3', 'same-size-a');
  const other = f.put('採樣包/Drums/sample.mp3', 'same-size-b');
  const copied = await copyFileSafely(f.cfg, source, other);
  assert.equal(copied.copied, true);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.readFileSync(copied.to, 'utf8'), 'same-size-a');
  assert.equal(fs.readFileSync(other, 'utf8'), 'same-size-b');
});

test('file ops: transfers do not silently write state; batch relocation preserves unknown fields and exact task ownership', async () => {
  const f = fixture(), from = f.put('Song/Audio/Song.wav', 'audio'), target = path.join(f.root, '成品WAV', 'Song.wav');
  const input = { unknown: { retained: true }, aliases: { wrong: 'another' }, history: { task_a: { files: { wav: { absolute: from, path: 'ai音樂/Song/Audio/Song.wav', extra: 'keep' } } }, task_b: { files: { mp3: { absolute: path.join(f.root, 'other.mp3'), extra: 'unrelated' } } } } };
  f.json(f.cfg.stateFile, input);
  const original = fs.readFileSync(f.cfg.stateFile, 'utf8');
  const moved = await moveFileSafely(f.cfg, from, target);
  assert.equal(fs.readFileSync(f.cfg.stateFile, 'utf8'), original);
  const recorded = await recordRelocations(f.cfg, [moved]);
  assert.equal(recorded.historyUpdated, 1);
  const saved = JSON.parse(fs.readFileSync(f.cfg.stateFile, 'utf8'));
  assert.equal(saved.removedPaths[from.toLowerCase()], target);
  assert.equal(saved.history.task_a.files.wav.absolute, target);
  assert.equal(saved.history.task_a.files.wav.path, 'ai音樂/成品WAV/Song.wav');
  assert.equal(saved.history.task_a.files.wav.extra, 'keep');
  assert.equal(saved.history.task_b.files.mp3.extra, 'unrelated');
  assert.deepEqual(saved.unknown, input.unknown);
  assert.deepEqual(saved.aliases, input.aliases);
});

test('file ops: content comparisons do not report same after source metadata changes during the read', async (t) => {
  const f = fixture(), a = f.put('a.bin', Buffer.alloc(1024)), b = f.put('b.bin', Buffer.alloc(1024));
  const realLstat = fsp.lstat.bind(fsp);
  let aReads = 0;
  t.mock.method(fsp, 'lstat', async (...args) => {
    const stat = await realLstat(...args);
    if (args[0] === a && ++aReads >= 2) {
      stat.mtimeMs += typeof stat.mtimeMs === 'bigint' ? 1000n : 1000;
      if (typeof stat.mtimeNs === 'bigint') stat.mtimeNs += 1000000000n;
    }
    return stat;
  });
  assert.equal(await sameFileContent(a, b), false);
});

test('file ops: traversal and symlink destinations are refused', async () => {
  const f = fixture(), source = f.put('input.wav', 'audio');
  await assert.rejects(moveFileSafely(f.cfg, source, path.join(f.base, 'outside.wav')), { code: 'FILE_OUTSIDE_ROOT' });
  const outside = path.join(f.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(moveFileSafely(f.cfg, source, path.join(f.root, 'link', 'escaped.wav')), { code: 'FILE_SYMLINK' });
  assert.equal(fs.existsSync(source), true);
});

test('collectFullWavs: Artist - Title is a whole song while explicit Stems/role files stay separate', async () => {
  const f = fixture();
  const full = f.put('Artist - Title/Audio/Artist - Title.wav', 'full-audio');
  const roleTitle = f.put('Artist - Drums/Artist - Drums.wav', 'full-role-title');
  const stem = f.put('Artist - Title/Stems/Artist - Title - Drums.wav', 'stem-audio');
  const master = f.put('俱樂部版/Artist - Title.wav', 'protected-master');
  const report = await collectFullWavs({ cfg: f.cfg });
  assert.equal(report.failed.length, 0);
  assert.equal(report.moved, 2);
  assert.equal(fs.existsSync(full), false);
  assert.equal(fs.existsSync(roleTitle), false);
  assert.equal(fs.readFileSync(path.join(f.root, '成品WAV', 'Artist - Title.wav'), 'utf8'), 'full-audio');
  assert.equal(fs.existsSync(stem), true);
  assert.equal(fs.readFileSync(master, 'utf8'), 'protected-master');
  const state = JSON.parse(fs.readFileSync(f.cfg.stateFile, 'utf8'));
  assert.equal(state.removedPaths[full.toLowerCase()], path.join(f.root, '成品WAV', 'Artist - Title.wav'));
});

test('collectSamples: same stem basename with different content preserves both versions and actual manifest names', async () => {
  const f = fixture();
  const a = f.put('Song A/Stems/Artist - Title - Drums.mp3', 'version-a');
  const b = f.put('Song B/Stems/Artist - Title - Drums.mp3', 'version-b');
  f.put('Artist - Title/Artist - Title.mp3', 'full-song');
  const report = await collectSamples({ cfg: f.cfg });
  assert.equal(report.failed.length, 0);
  assert.equal(report.copied, 2);
  assert.equal(fs.existsSync(a), true);
  assert.equal(fs.existsSync(b), true);
  const dir = path.join(f.root, '採樣包', 'Drums');
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ['Artist - Title - Drums (2).mp3', 'Artist - Title - Drums.mp3']);
  assert.deepEqual(names.map(name => fs.readFileSync(path.join(dir, name), 'utf8')).sort(), ['version-a', 'version-b']);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, '採樣包', '_manifest.json'), 'utf8'));
  assert.deepEqual(manifest.items.map(x => x.file).sort(), names);
  assert.equal(manifest.items.every(x => x.type === 'Drums'), true);
  const again = await collectSamples({ cfg: f.cfg });
  assert.equal(again.copied, 0);
  assert.equal(again.skipped, 2);
});

test('classifyByAttributes: copy mode keeps same-size different contents and move mode records exact destinations', async () => {
  const f = fixture();
  const a = f.put('A/Shared - MusicXML.musicxml', 'version-a'), b = f.put('B/Shared - MusicXML.musicxml', 'version-b');
  const copied = await classifyByAttributes({ cfg: f.cfg, move: false });
  assert.equal(copied.failed.length, 0);
  assert.equal(copied.copied, 2);
  assert.equal(fs.existsSync(a), true);
  assert.equal(fs.existsSync(b), true);
  const moved = await classifyByAttributes({ cfg: f.cfg, move: true });
  assert.equal(moved.failed.length, 0);
  assert.equal(moved.deduped, 2);
  const state = JSON.parse(fs.readFileSync(f.cfg.stateFile, 'utf8'));
  assert.notEqual(state.removedPaths[a.toLowerCase()], state.removedPaths[b.toLowerCase()]);
  assert.equal(fs.readFileSync(state.removedPaths[a.toLowerCase()], 'utf8'), 'version-a');
  assert.equal(fs.readFileSync(state.removedPaths[b.toLowerCase()], 'utf8'), 'version-b');
});

test('file ops: explicit damaged archive keeps content, source identity and retention until user acceptance', async () => {
  const f = fixture(), source = f.put('成品WAV/damaged.wav', 'truncated-fixture');
  const result = await archiveLibraryFile(f.cfg, source);
  assert.equal(result.archived, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), 'truncated-fixture');
  const archiveRoot = path.join(f.cfg.stateDir, 'organize-backups');
  const batch = fs.readdirSync(archiveRoot)[0];
  assert.ok(batch.startsWith('audit-damaged-'));
  const metadata = JSON.parse(fs.readFileSync(path.join(archiveRoot, batch, '_operation.json'), 'utf8'));
  assert.equal(metadata.from, source);
  assert.equal(metadata.sha256, crypto.createHash('sha256').update('truncated-fixture').digest('hex'));
  assert.match(metadata.retention, /explicit user acceptance/);
});

test('file ops: safe physical move retains identity and records only verified file aliases, never song aliases', async () => {
  const f = fixture(), from = f.put('Song/Audio/Song.wav', 'stable-audio');
  const beforeId = await fileIdForPath(from), legacyId = legacyPathFileId(from);
  const result = await moveFileSafely(f.cfg, from, path.join(f.root, '成品WAV', 'Song.wav'));
  assert.equal(result.fromFileId, beforeId);
  assert.equal(result.toFileId, beforeId, 'normal link/unlink move keeps dev/ino identity');
  assert.equal(result.contentVerified, true);
  await recordRelocations(f.cfg, [result]);
  const state = JSON.parse(fs.readFileSync(f.cfg.stateFile, 'utf8'));
  assert.equal(state.fileIdAliases[legacyId], beforeId);
  assert.equal(state.aliases, undefined);
  const unverifiedFrom = path.join(f.root, 'never-moved.wav');
  await recordRelocations(f.cfg, [{ from: unverifiedFrom, to: result.to, moved: true, fromFileId: 'unverified_old', toFileId: beforeId, contentVerified: false }]);
  assert.equal(JSON.parse(fs.readFileSync(f.cfg.stateFile, 'utf8')).fileIdAliases.unverified_old, undefined);
});
