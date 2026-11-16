import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAceDlScripts } from './lib-load.mjs';

const { planner: P } = loadAceDlScripts();
const song = (id, model = 'acemusic-v1.1') => ({
  task_id: id,
  status: 'succeeded',
  capability: 'music_generate',
  model,
  local_audio: `/data/${id}.mp3`,
  local_cover: `/data/${id}.jpg`,
  meta: { title: 'Same title' },
});

test('所選 MP3／WAV 計入缺失；其他已完成類型不能掩蓋缺 WAV', () => {
  const status = P.downloadStatusForTypes(song('a'), {
    types: ['mp3', 'wav'],
    downloaded: { mp3: true, midi: true, musicxml: true, cover: true },
  });
  assert.equal(status.have, 1);
  assert.equal(status.total, 2);
  assert.equal(status.allDone, false);
  assert.deepEqual(Array.from(status.detail.filter((item) => !item.done), (item) => item.type), ['wav']);
});

test('只檢查 MP3 時，缺 MIDI 不會把歌曲標為未下載', () => {
  const status = P.downloadStatusForTypes(song('a'), { types: ['mp3'], downloaded: { mp3: true } });
  assert.equal(status.allDone, true);
  assert.equal(status.total, 1);
  assert.deepEqual(Array.from(status.detail, (item) => item.type), ['mp3']);
});

test('lossy 模型的 WAV 明示不提供，不算成可下載缺失', () => {
  const status = P.downloadStatusForTypes(song('xl', 'ace-step-1.5-xl'), {
    types: ['mp3', 'wav'],
    downloaded: { mp3: true },
  });
  assert.equal(status.have, 1);
  assert.equal(status.total, 1);
  assert.equal(status.allDone, true);
  const wav = status.detail.find((item) => item.type === 'wav');
  assert.equal(wav.na, true);
  assert.equal(wav.total, 0);
  assert.equal(wav.reason, '此模型不提供 WAV');
});

test('站點不提供 MIDI 的紀錄不能掩蓋可用 WAV 的缺失；不改輸入', () => {
  const options = {
    types: ['midi', 'wav'],
    downloaded: {},
    unavailable: { a: { midi: { code: 'no_download', at: 1 } } },
  };
  const before = JSON.stringify(options);
  const status = P.downloadStatusForTypes(song('a'), options);
  assert.equal(status.allDone, false);
  assert.equal(status.total, 1);
  assert.equal(status.detail[0].na, true);
  assert.equal(status.detail[1].type, 'wav');
  assert.equal(status.detail[1].done, false);
  assert.equal(JSON.stringify(options), before);
});

test('篩選後全選與提交共用可見範圍，忽略隱藏歌曲的舊選擇', () => {
  const songs = [song('complete'), song('missing-wav'), song('lossy', 'ace-step-1.5-xl')];
  const downloaded = {
    complete: { mp3: true, wav: true },
    'missing-wav': { mp3: true },
    lossy: { mp3: true },
  };
  const visible = P.filterDownloadSongs(songs, {
    onlyUndownloaded: true,
    statusForSong: (item) => P.downloadStatusForTypes(item, { types: ['mp3', 'wav'], downloaded: downloaded[item.task_id] }),
  });
  assert.deepEqual(Array.from(visible, (item) => item.task_id), ['missing-wav']);
  const staleSelection = new Set(songs.map((item) => item.task_id));
  assert.deepEqual(Array.from(P.selectedDownloadSongs(visible, staleSelection), (item) => item.task_id), ['missing-wav']);
  assert.equal(staleSelection.size, 3, '純函式不修改呼叫者的選擇集合');
});

test('收藏與待補篩選取交集；零選定類型不會把整個曲庫列為缺檔', () => {
  const songs = [song('a'), song('b')];
  const visible = P.filterDownloadSongs(songs, {
    onlyUndownloaded: true,
    onlyFavorites: true,
    statusForSong: () => ({ allDone: false }),
    isFavorite: (id) => id === 'b',
  });
  assert.deepEqual(Array.from(visible, (item) => item.task_id), ['b']);
  const none = P.filterDownloadSongs(songs, {
    onlyUndownloaded: true,
    statusForSong: (item) => P.downloadStatusForTypes(item, { types: [] }),
  });
  assert.equal(none.length, 0);
});
