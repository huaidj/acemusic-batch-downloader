// 防止一鍵整理 churn：① 去重過的成品 MP3 不得重下 ② 採樣包不得收完整歌曲
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-churn-'));
process.env.ACE_DOWNLOAD_DIR = path.join(base, 'downloads');
process.env.ACE_STATE_DIR = path.join(base, 'state');
fs.mkdirSync(process.env.ACE_STATE_DIR, { recursive: true });

const ACE = await import('../../agent/lib/ace.mjs');

function makeFile(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const song = {
  task_id: 'so_test_1',
  status: 'succeeded',
  capability: 'music_generate',
  local_audio: '/data/mock/test.mp3',
  created_at: 1,
  meta: { title: 'Churn Test' },
  result: { duration_sec: 100 },
  stems: {},
};

test('extractFullMp3s：removedPaths 指向仍存在的 keeper 時，不重新下載', async () => {
  const root = path.join(process.env.ACE_DOWNLOAD_DIR, 'ai音樂');
  const outDir = path.join(root, '成品MP3');
  const keeper = path.join(outDir, 'Churn Test.mp3');
  const target = path.join(outDir, 'Churn Test (2).mp3');
  makeFile(keeper, 'same-bytes');
  // 模擬 dedupeContent 留下的紀錄：第二首同名歌的副本已被搬走，keeper 還在
  fs.writeFileSync(path.join(process.env.ACE_STATE_DIR, 'agent-state.json'), JSON.stringify({
    folderByTask: {},
    ownerByFolder: {},
    history: {},
    aliases: {},
    removedPaths: { [target.toLowerCase()]: keeper },
  }));
  // session.json 只需能通過 loadSession；不會真的連網（有 keeper 就跳過）
  fs.writeFileSync(path.join(process.env.ACE_STATE_DIR, 'session.json'), JSON.stringify({ cookie: 'sess=1', savedAt: Date.now(), ua: 'test' }));

  const second = { ...song, task_id: 'so_test_2', created_at: 2 };
  const report = await ACE.extractFullMp3s({ songs: [song, second], force: false });
  assert.equal(report.downloaded, 0, '不得重新下載');
  assert.equal(report.skipped >= 1, true, '應計入跳過');
  assert.equal(report.deduped, 1, '第二首應標記為去重跳過');
  assert.equal(fs.existsSync(target), false, '不可在成品MP3重建副本');
  assert.equal(fs.existsSync(keeper), true, 'keeper 不可被動');
});

test('collectSamples：完整歌曲（含 " - " 的標題）不得被收進採樣包', async () => {
  const root = path.join(process.env.ACE_DOWNLOAD_DIR, 'ai音樂');
  const fullSong = path.join(root, '成品MP3', 'Artist Name - Song Title.mp3');
  const stem = path.join(root, 'Song Title', 'Song Title - Vocals.mp3');
  makeFile(fullSong, 'full-song');
  makeFile(stem, 'vocal-stem');

  const report = await ACE.collectSamples({});
  assert.equal(report.copied, 1, '只應收分軌');
  const sampleDir = path.join(root, '採樣包');
  const copied = fs.readdirSync(sampleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(sampleDir, entry.name)));
  assert.equal(copied.includes('Artist Name - Song Title.mp3'), false, '完整歌曲不可進採樣包');
  assert.equal(copied.includes('Song Title - Vocals.mp3'), true, '分軌應進採樣包');
});
