// dedupeFolders：空資料夾＋分類庫已有相同內容的副本（含 backup/commit 行為）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-dedupe-'));
process.env.ACE_DOWNLOAD_DIR = path.join(tmpBase, 'downloads');
process.env.ACE_STATE_DIR = path.join(tmpBase, 'state');

const ACE = await import('../../agent/lib/ace.mjs');

function makeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('dedupeFolders：預設只預覽，commit 才搬移並清空資料夾', async () => {
  const root = path.join(process.env.ACE_DOWNLOAD_DIR, 'ai音樂');
  const classified = path.join(root, '成品MP3', 'Song A.mp3');
  const duplicate = path.join(root, 'Song A', 'Song A.mp3');
  const unique = path.join(root, 'Song A', 'Song A - MIDI.mid');
  makeFile(classified, 'same-bytes');
  makeFile(duplicate, 'same-bytes');
  makeFile(unique, 'midi-bytes');
  fs.mkdirSync(path.join(root, 'Empty Song'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Empty Song', 'Audio'), { recursive: true });

  const dry = await ACE.dedupeFolders({ commit: false });
  assert.equal(dry.ok, true);
  assert.equal(dry.duplicateCount, 1, '應找到 1 個同內容副本');
  assert.equal(dry.duplicateFiles[0].file, duplicate);
  assert.equal(dry.duplicateFiles[0].keep, classified);
  assert.ok(dry.emptyFolders.includes(path.join(root, 'Empty Song')), '應列出空資料夾');
  assert.equal(fs.existsSync(duplicate), true, '預覽不得刪檔');
  assert.equal(fs.existsSync(path.join(root, 'Empty Song')), true, '預覽不得刪資料夾');

  const committed = await ACE.dedupeFolders({ commit: true });
  assert.equal(committed.ok, true);
  assert.equal(committed.moved, 1);
  assert.equal(fs.existsSync(duplicate), false, 'commit 後副本應搬走');
  assert.equal(fs.existsSync(classified), true, '分類庫保留檔不可動');
  assert.equal(fs.existsSync(unique), true, '非重複檔不可動');
  assert.equal(fs.existsSync(path.join(root, 'Empty Song')), false, '空資料夾應移除');

  const backupRoot = path.join(process.env.ACE_STATE_DIR, 'organize-backups');
  const backupDirs = fs.readdirSync(backupRoot);
  assert.equal(backupDirs.length, 1, '應留下 backup 目錄');
  const operation = JSON.parse(fs.readFileSync(path.join(backupRoot,backupDirs[0],'_operation.json'),'utf8'));
  assert.equal(operation.from,duplicate);
  const backedUp = operation.backup;
  assert.equal(fs.existsSync(backedUp), true, '副本應保留在 backup，可回溯');
});

test('dedupeFolders：同名不同內容（不同歌）不得被當成重複', async () => {
  const root = path.join(process.env.ACE_DOWNLOAD_DIR, 'ai音樂');
  const first = path.join(root, '同名歌', '同名歌.mp3');
  const second = path.join(root, '同名歌 (2)', '同名歌 (2).mp3');
  makeFile(first, 'version-one');
  makeFile(second, 'version-two');

  const report = await ACE.dedupeFolders({ commit: true });
  assert.equal(report.duplicateCount, 0, '內容不同不可判定重複');
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
});

test('collectDownloadIndex：檔案數超過舊上限（4000）也不會截斷', async () => {
  const downloads = process.env.ACE_DOWNLOAD_DIR;
  const bulk = path.join(downloads, 'ai音樂', 'Bulk');
  fs.mkdirSync(bulk, { recursive: true });
  for (let i = 0; i < 4200; i += 1) fs.writeFileSync(path.join(bulk, `f${i}.mp3`), 'x');
  const index = await ACE.collectDownloadIndex(undefined, { refresh: true });
  assert.ok(index.names.size >= 4200, `索引需完整（實際 ${index.names.size}）`);
});

function withTempBase(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const prev = { download: process.env.ACE_DOWNLOAD_DIR, state: process.env.ACE_STATE_DIR };
  process.env.ACE_DOWNLOAD_DIR = path.join(base, 'downloads');
  process.env.ACE_STATE_DIR = path.join(base, 'state');
  return {
    base,
    restore() {
      if (prev.download === undefined) delete process.env.ACE_DOWNLOAD_DIR; else process.env.ACE_DOWNLOAD_DIR = prev.download;
      if (prev.state === undefined) delete process.env.ACE_STATE_DIR; else process.env.ACE_STATE_DIR = prev.state;
    },
  };
}

test('dedupeContent：跨分類相同內容只留一份，keeper 優先 成品MP3，並記 alias', async () => {
  const ctx = withTempBase('acedl-content-');
  try {
    const root = path.join(process.env.ACE_DOWNLOAD_DIR, 'ai音樂');
    makeFile(path.join(root, '成品MP3', 'X.mp3'), 'bytes-x');
    makeFile(path.join(root, '採樣包', 'Other', 'X.mp3'), 'bytes-x');
    makeFile(path.join(root, 'X 歌', 'X 歌.mp3'), 'bytes-x');
    makeFile(path.join(root, '成品MP3', 'Y.mp3'), 'bytes-y');
    fs.mkdirSync(path.join(process.env.ACE_STATE_DIR), { recursive: true });
    fs.writeFileSync(path.join(process.env.ACE_STATE_DIR, 'agent-state.json'), JSON.stringify({
      folderByTask: {},
      ownerByFolder: {},
      history: {
        taskKeep: { folder: 'X 歌', files: { mp3: { path: path.join(root, '成品MP3', 'X.mp3'), filename: 'X.mp3', at: 1 } } },
        taskDup: { folder: 'X 歌', files: { mp3: { path: path.join(root, 'X 歌', 'X 歌.mp3'), filename: 'X 歌.mp3', at: 1 } } },
      },
    }));

    const dry = await ACE.dedupeContent({ commit: false });
    assert.equal(dry.duplicateCount, 2, '兩個副本應被找出');
    assert.equal(dry.groups[0].keeper, path.join('成品MP3', 'X.mp3'), 'keeper 應在成品MP3');
    assert.equal(fs.existsSync(path.join(root, '採樣包', 'Other', 'X.mp3')), true, '預覽不得搬檔');

    const done = await ACE.dedupeContent({ commit: true });
    assert.equal(done.moved, 2);
    assert.equal(fs.existsSync(path.join(root, '成品MP3', 'X.mp3')), true, 'keeper 不可被搬走');
    assert.equal(fs.existsSync(path.join(root, '採樣包', 'Other', 'X.mp3')), false);
    assert.equal(fs.existsSync(path.join(root, 'X 歌', 'X 歌.mp3')), false);
    assert.equal(fs.existsSync(path.join(root, '成品MP3', 'Y.mp3')), true, '不同內容不可動');
    assert.deepEqual(done.aliases, { taskDup: 'taskKeep' }, '被移除的 task 需 alias 到保留 task');
    const state = JSON.parse(fs.readFileSync(path.join(process.env.ACE_STATE_DIR, 'agent-state.json'), 'utf8'));
    assert.equal(state.aliases.taskDup, 'taskKeep', 'alias 需持久化');

    const backupRoot = path.join(process.env.ACE_STATE_DIR, 'organize-backups');
    const dirs = fs.readdirSync(backupRoot);
    assert.equal(dirs.length, 2);
    const operations = dirs.map(dir=>JSON.parse(fs.readFileSync(path.join(backupRoot,dir,'_operation.json'),'utf8')));
    assert.equal(operations.every(op=>fs.existsSync(op.backup)&&op.sha256&&op.retention),true,'每份原件有可回溯備份和SHA');
    assert.equal(done.bytesReclaimed,0,'原件仍保留，不能聲稱已釋放磁碟空間');
    assert.equal(state.history.taskDup.files.mp3.absolute,path.join(root,'成品MP3','X.mp3'),'搬移後exact task history回寫keeper');
  } finally {
    ctx.restore();
  }
});

test('applyAliases：歷史 alias 不得把別的歌曲狀態當成已下載', async () => {
  const rows = [
    { task_id: 'a', downloaded: { have: 3, total: 3, allDone: true } },
    { task_id: 'b', downloaded: { have: 0, total: 1, allDone: false } },
  ];
  ACE.applyAliases(rows, { aliases: { b: 'a' } });
  assert.equal(rows[1].aliasOf, 'a');
  assert.equal(rows[1].downloaded.allDone, false);
  assert.equal(rows[1].downloaded.have, 0);
});

test('getLibrarySnapshot：命中本地快照快取，不重建', async () => {
  const ctx = withTempBase('acedl-snap-');
  try {
    const cacheDir = path.join(process.env.ACE_STATE_DIR, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'library-snapshot.json'), JSON.stringify({
      cachedAt: Date.now(),
      schema: 'ace-library-snapshot-v2-exact-task-index',
      builtAt: '2026-01-01T00:00:00.000Z',
      counts: { songs: 1, downloaded: 1, partial: 0, undownloaded: 0, midiAvailable: 0 },
      songs: [{ task_id: 't1', title: 'cached', downloaded: { have: 1, total: 1, allDone: true } }],
    }));
    const snapshot = await ACE.getLibrarySnapshot();
    assert.equal(snapshot.cached, true, '新鮮快照應命中');
    assert.equal(snapshot.songs.length, 1);
    assert.equal(snapshot.songs[0].title, 'cached');
    assert.equal(snapshot.counts.songs, 1);
  } finally {
    ctx.restore();
  }
});
