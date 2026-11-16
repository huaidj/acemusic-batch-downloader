import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dedupeSongCopies } from '../../agent/lib/ace.mjs';

test('dedupeSongCopies: commit:false previews without moving or locking; commit archives the song-folder copy', async (t) => {
  const base = fs.mkdtempSync(path.join(process.platform === 'win32' && fs.existsSync('F:\DevData\Temp') ? 'F:\DevData\Temp' : os.tmpdir(), 'dedupe-songs-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cfg = { stateDir: path.join(base, 'state'), downloadDir: path.join(base, 'downloads'), stateFile: path.join(base, 'state', 'agent-state.json') };
  const root = path.join(cfg.downloadDir, 'ai音樂');
  const put = (rel, data) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const keeper = put('成品MP3/九黎祭.mp3', 'same-bytes');
  const copy = put('九黎祭/九黎祭.mp3', 'same-bytes');
  const different = put('九黎祭 (2)/九黎祭 (2).mp3', 'other-bytes');
  const preview = await dedupeSongCopies({ cfg, commit: false });
  assert.equal(preview.commit, false);
  assert.equal(preview.candidateCount, 1);
  assert.equal(preview.candidates[0].keep, path.join('成品MP3', '九黎祭.mp3'));
  assert.ok(fs.existsSync(copy) && fs.existsSync(different));
  assert.ok(!fs.existsSync(path.join(cfg.stateDir, 'library-write.lock')));
  const done = await dedupeSongCopies({ cfg });
  assert.equal(done.archived, 1);
  assert.ok(!fs.existsSync(copy), 'identical copy is archived');
  assert.ok(fs.existsSync(keeper) && fs.existsSync(different), 'keeper and different content stay');
});
