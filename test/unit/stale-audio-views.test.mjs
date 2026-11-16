import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneStaleAudioViews } from '../../agent/lib/ace.mjs';

function sandbox(t) {
  const base = process.platform === 'win32' && fs.existsSync('F:\DevData\Temp') ? 'F:\DevData\Temp' : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'stale-views-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'downloads', 'ai音樂'), outDir = path.join(root, '音頻分類'), stateDir = path.join(dir, 'state'), archived = path.join(dir, 'archive');
  for (const d of [root, outDir, stateDir, archived]) fs.mkdirSync(d, { recursive: true });
  const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const link = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.linkSync(from, to); return to; };
  return { cfg: { stateDir, downloadDir: path.join(dir, 'downloads') }, root, outDir, archived, put, link };
}

test('stale classification links: identical live source → moved to backup; live views untouched; unique orphans kept', async (t) => {
  const s = sandbox(t);
  const live = s.put(path.join(s.root, '採樣包', 'Guitar', '蠻荒靈咒 - Guitar.mp3'), Buffer.from('guitar-audio-bytes'));
  const liveView = s.link(live, path.join(s.outDir, '採樣包', 'Guitar', '蠻荒靈咒 - Guitar.mp3'));
  // 去重時被歸檔的同內容原件（不同實體），它的檢視連結留在音頻分類
  const archivedCopy = s.put(path.join(s.archived, '532be79afe8e4700a3b6019395191c35.mp3'), Buffer.from('guitar-audio-bytes'));
  const staleView = s.link(archivedCopy, path.join(s.outDir, '其他音檔', 'BPM', '135-140', '532be79afe8e4700a3b6019395191c35.mp3'));
  // 沒有任何相同來源的唯一音訊
  const uniqueArchived = s.put(path.join(s.archived, 'unique.mp3'), Buffer.from('only-copy-of-this-audio'));
  const uniqueView = s.link(uniqueArchived, path.join(s.outDir, '其他音檔', 'Key', '4B', '0d577ebc5b7443f28d4e7565db0101c0.mp3'));

  const preview = await pruneStaleAudioViews({ cfg: s.cfg, outDir: s.outDir, liveFiles: [live], commit: false });
  assert.equal(preview.stale, 2); assert.equal(preview.moved, 0); assert.equal(preview.keptUnique, 1);
  assert.ok(fs.existsSync(staleView), 'preview never moves');

  const result = await pruneStaleAudioViews({ cfg: s.cfg, outDir: s.outDir, liveFiles: [live], commit: true });
  assert.equal(result.moved, 1);
  assert.equal(result.keptUnique, 1);
  assert.ok(fs.existsSync(liveView), 'a view of a live source is never touched');
  assert.ok(!fs.existsSync(staleView), 'stale view leaves 音頻分類');
  assert.ok(fs.existsSync(uniqueView), 'unique audio stays visible');
  const moved = path.join(result.archive, '其他音檔', 'BPM', '135-140', '532be79afe8e4700a3b6019395191c35.mp3');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'guitar-audio-bytes', 'moved link keeps its data');
  assert.ok(result.archive.startsWith(path.join(s.cfg.stateDir, 'organize-backups')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.archive, '_stale-views.json'), 'utf8')).items.length, 1);
  const again = await pruneStaleAudioViews({ cfg: s.cfg, outDir: s.outDir, liveFiles: [live], commit: true });
  assert.equal(again.moved, 0, 'idempotent');
});

test('stale classification links: standalone copies (link count 1) are never moved', async (t) => {
  const s = sandbox(t);
  const live = s.put(path.join(s.root, 'A', 'Audio', 'Song.mp3'), Buffer.from('same-bytes'));
  const standalone = s.put(path.join(s.outDir, '完整歌曲', 'BPM', '110-115', 'Song.mp3'), Buffer.from('same-bytes'));
  const result = await pruneStaleAudioViews({ cfg: s.cfg, outDir: s.outDir, liveFiles: [live], commit: true });
  assert.equal(result.moved, 0);
  assert.ok(fs.existsSync(standalone));
});
