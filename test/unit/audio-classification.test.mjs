import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { classifyByAudio } from '../../agent/lib/ace.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-audio-classification-')), stateDir = path.join(base, 'state'), downloadDir = path.join(base, 'downloads'), root = path.join(downloadDir, 'ai音樂');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.join(stateDir, 'cache'), { recursive: true });
  const cfg = { stateDir, downloadDir, stateFile: path.join(stateDir, 'agent-state.json'), historyFile: path.join(stateDir, 'history.json'), logFile: path.join(stateDir, 'agent.log') };
  const put = (relative, content) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const seed = (files) => {
    const items = Object.fromEntries(files.map(file => {
      const stat = fs.statSync(file);
      return [file, { file, relative: path.relative(downloadDir, file), size: stat.size, mtime: stat.mtimeMs, ok: true, algorithmVersion: 'huaidj-audio-v2-pitch-class-c', duration: 10, bpm: 110, camelot: '8A', energy: 0.15 }];
    }));
    fs.writeFileSync(path.join(stateDir, 'cache', 'audio-analysis.json'), JSON.stringify({ cachedAt: Date.now(), items, thresholds: { low: 0.1, high: 0.2 } }));
  };
  const previous = process.env.ACE_PYTHON;
  process.env.ACE_PYTHON = 'NO_PYTHON_SHOULD_RUN_FOR_CACHED_FIXTURES';
  t.after(() => { if (previous === undefined) delete process.env.ACE_PYTHON; else process.env.ACE_PYTHON = previous; });
  const manifest = () => JSON.parse(fs.readFileSync(path.join(root, '音頻分類', '_manifest.json'), 'utf8'));
  return { base, root, cfg, put, seed, manifest };
}

test('audio classification: Artist - Song stays full; explicit stems use the final role label', async (t) => {
  const f = fixture(t), full = f.put('成品MP3/Artist - Song.mp3', 'full-audio'), roleTitle = f.put('Artist - Drums/Audio/Artist - Drums.mp3', 'another-full'), stem = f.put('採樣包/Drums/Artist - Title - Drums.mp3', 'stem-audio');
  f.seed([full, roleTitle, stem]);
  const result = await classifyByAudio({ cfg: f.cfg });
  assert.equal(result.analyzed, 0);
  assert.equal(result.failed.length, 0);
  const rows = f.manifest().items;
  for (const file of [full, roleTitle]) assert.equal(rows.find(x => x.file === file).links.every(x => x.startsWith('完整歌曲/')), true);
  const stemRow = rows.find(x => x.file === stem);
  assert.equal(stemRow.links.every(x => x.startsWith('分軌/')), true);
  assert.ok(stemRow.links.includes('分軌/類型/Drums/Artist - Title - Drums.mp3'));
  assert.equal(fs.readFileSync(full, 'utf8'), 'full-audio');
});

test('audio classification: same basename and size with different content keeps both hardlinks and actual manifest paths', async (t) => {
  const f = fixture(t), a = f.put('A/Audio/Shared - Song.mp3', 'aaaa'), b = f.put('B/Audio/Shared - Song.mp3', 'bbbb');
  const oldView = f.put('音頻分類/完整歌曲/BPM/110-115/Shared - Song.mp3', 'aaaa');
  f.seed([a, b]);
  const result = await classifyByAudio({ cfg: f.cfg });
  assert.equal(result.analyzed, 0);
  assert.equal(result.failed.length, 0);
  const rowB = f.manifest().items.find(x => x.file === b);
  assert.ok(rowB.links.every(x => path.basename(x) === 'Shared - Song (2).mp3'));
  for (const view of rowB.links) {
    const actual = path.join(f.root, '音頻分類', view);
    assert.equal(fs.readFileSync(actual, 'utf8'), 'bbbb');
    assert.equal(fs.statSync(actual, { bigint: true }).ino, fs.statSync(b, { bigint: true }).ino);
  }
  assert.equal(fs.readFileSync(oldView, 'utf8'), 'aaaa');
  const again = await classifyByAudio({ cfg: f.cfg });
  assert.equal(again.analyzed, 0);
  assert.equal(again.linked, 0);
  assert.equal(again.skipped, 6);
});

test('audio classification: copy mode verifies content and records unique destination without overwriting an old view', async (t) => {
  const f = fixture(t), source = f.put('Song/Audio/Source.mp3', 'abcdefgh'), old = f.put('音頻分類/完整歌曲/BPM/110-115/Source.mp3', 'ijklmnop');
  f.seed([source]);
  const result = await classifyByAudio({ cfg: f.cfg, linkMode: 'copy' });
  assert.equal(result.analyzed, 0);
  assert.equal(result.failed.length, 0);
  const view = f.manifest().items[0].links.find(x => x.startsWith('完整歌曲/BPM/'));
  assert.equal(path.basename(view), 'Source (2).mp3');
  const actual = path.join(f.root, '音頻分類', view);
  assert.equal(fs.readFileSync(actual, 'utf8'), 'abcdefgh');
  assert.notEqual(fs.statSync(actual, { bigint: true }).ino, fs.statSync(source, { bigint: true }).ino);
  assert.equal(fs.readFileSync(old, 'utf8'), 'ijklmnop');
});

test('audio classification: a symlink destination cannot redirect a new view outside the library', async (t) => {
  const f = fixture(t), source = f.put('Song/Audio/Source.mp3', 'audio');
  f.seed([source]);
  const outside = path.join(f.base, 'outside'), bpm = path.join(f.root, '音頻分類', '完整歌曲', 'BPM');
  fs.mkdirSync(outside); fs.mkdirSync(bpm, { recursive: true });
  fs.symlinkSync(outside, path.join(bpm, '110-115'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await classifyByAudio({ cfg: f.cfg });
  assert.equal(result.analyzed, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, 'FILE_SYMLINK');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(source, 'utf8'), 'audio');
});

test('audio classification: old pitch-class cache is preserved but not reused as corrected output', async (t) => {
  const f = fixture(t), source = f.put('Song/Audio/Source.mp3', 'audio');
  f.seed([source]);
  const cacheFile = path.join(f.cfg.stateDir, 'cache', 'audio-analysis.json'), oldCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  delete oldCache.items[source].algorithmVersion;
  oldCache.items[source].key = 'incorrect-old-key';
  fs.writeFileSync(cacheFile, JSON.stringify(oldCache));
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', () => {
    calls++;
    return { status: 0, stderr: '', stdout: JSON.stringify([{ path: source, ok: true, algorithmVersion: 'huaidj-audio-v2-pitch-class-c', duration: 10, bpm: 110, camelot: '5A', key: 'C:minor', energy: 0.15 }]) };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await classifyByAudio({ cfg: f.cfg });
  assert.equal(result.analyzed, 1);
  assert.equal(result.cached, 0);
  assert.equal(calls, 1, 'mock analyzer supplies the corrected result; no Python process runs');
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.items[source].algorithmVersion, 'huaidj-audio-v2-pitch-class-c');
  assert.equal(saved.items[source].key, 'C:minor');
  assert.equal(saved.previousAlgorithmItems.unversioned[source].key, 'incorrect-old-key');
  assert.equal(f.manifest().items[0].algorithmVersion, 'huaidj-audio-v2-pitch-class-c');
  assert.ok(f.manifest().items[0].links.some(x => x.includes('/Key/5A/')));
});
