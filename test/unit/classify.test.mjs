// classifyByAttributes：PDF → 其他；同名不同內容用唯一檔名，不再留在歌名資料夾
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-classify-'));
process.env.ACE_DOWNLOAD_DIR = path.join(base, 'downloads');
process.env.ACE_STATE_DIR = path.join(base, 'state');

const ACE = await import('../../agent/lib/ace.mjs');

function makeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('classifyByAttributes：PDF 會被分到「其他」', async () => {
  const root = path.join(process.env.ACE_DOWNLOAD_DIR, 'ai音樂');
  const pdf = path.join(root, 'Song A', 'Song A.pdf');
  makeFile(pdf, 'pdf-bytes');
  const report = await ACE.classifyByAttributes({});
  assert.equal(report.failed.length, 0);
  assert.equal(fs.existsSync(pdf), false, '原檔應被移走');
  assert.equal(fs.existsSync(path.join(root, '其他', 'Song A.pdf')), true, 'PDF 應在「其他」');
});

test('classifyByAttributes：同名不同內容的 MusicXML 用唯一檔名分類', async () => {
  const root = path.join(process.env.ACE_DOWNLOAD_DIR, 'ai音樂');
  makeFile(path.join(root, 'Alpha', 'Alpha - MusicXML.musicxml'), 'version-one');
  makeFile(path.join(root, 'Beta', 'Alpha - MusicXML.musicxml'), 'version-two');
  const report = await ACE.classifyByAttributes({});
  assert.equal(report.failed.length, 0);
  const outDir = path.join(root, 'MusicXML');
  const names = fs.readdirSync(outDir).filter((name) => !name.startsWith('_manifest')).sort();
  assert.deepEqual(names, ['Alpha - MusicXML (2).musicxml', 'Alpha - MusicXML.musicxml'], '同名不同內容需唯一檔名');
  const contents = names.map((name) => fs.readFileSync(path.join(outDir, name), 'utf8')).sort();
  assert.deepEqual(contents, ['version-one', 'version-two'], '兩份內容都要保留');
});
