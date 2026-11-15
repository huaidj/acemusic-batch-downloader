// test/unit/naming.test.mjs — src/naming.js 純函式單元測試（node:vm 載入 classic script）。
// 期望值對照 CONTRACT.md 2.4 命名規則；不從實作反推。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAceDlScripts } from './lib-load.mjs';

let N;
test('載入 naming.js', () => {
  ({ naming: N } = loadAceDlScripts(['naming.js']));
  assert.ok(N, 'globalThis.AceDLNaming 需存在');
  assert.equal(typeof N.sanitizeComponent, 'function');
});

test('sanitizeComponent：移除 Windows 非法字元並收斂空白', () => {
  assert.equal(N.sanitizeComponent('a<b>c:d"e/f\\g|h?i*j'), 'a b c d e f g h i j');
  assert.equal(N.sanitizeComponent('  hello   world  '), 'hello world');
  assert.equal(N.sanitizeComponent('tabs\tand\nnewlines'), 'tabs and newlines');
  assert.equal(N.sanitizeComponent('trailing...   '), 'trailing');
  assert.equal(N.sanitizeComponent('中文歌名 測試'), '中文歌名 測試');
});

test('sanitizeComponent：空值與長度上限', () => {
  assert.equal(N.sanitizeComponent(''), '');
  assert.equal(N.sanitizeComponent(null), '');
  assert.equal(N.sanitizeComponent('...'), '');
  assert.equal(N.sanitizeComponent('x'.repeat(100)).length, 60);
  assert.equal(N.sanitizeComponent('x'.repeat(100), 10).length, 10);
});

test('sanitizeComponent：Windows 保留名稱加底線前綴', () => {
  for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.equal(N.sanitizeComponent(reserved), '_' + reserved, `保留名 ${reserved}`);
  }
  assert.equal(N.sanitizeComponent('CON.txt'), '_CON.txt');
  assert.equal(N.sanitizeComponent('CONSOLE'), 'CONSOLE', '非保留名不應加底線');
});

test('songFolderLabel：清理 + Untitled 後備', () => {
  assert.equal(N.songFolderLabel('Neon Drive'), 'Neon Drive');
  assert.equal(N.songFolderLabel('Rain: Loop? v2'), 'Rain Loop v2');
  assert.equal(N.songFolderLabel(''), 'Untitled');
  assert.equal(N.songFolderLabel(null), 'Untitled');
  assert.equal(N.songFolderLabel('Where Am I').length <= 55, true);
});

test('stemLabel：站點 type → 顯示名稱（未知 type 保留原字串）', () => {
  assert.equal(N.stemLabel('vocal'), 'Vocals');
  assert.equal(N.stemLabel('vocals'), 'Vocals');
  assert.equal(N.stemLabel('instrumental'), 'Instrumental');
  assert.equal(N.stemLabel('backing_vocals'), 'Backing vocals');
  assert.equal(N.stemLabel('drums'), 'Drums');
  assert.equal(N.stemLabel('percussion'), 'Percussion');
  assert.equal(N.stemLabel('bass'), 'Bass');
  assert.equal(N.stemLabel('guitar'), 'Guitar');
  assert.equal(N.stemLabel('keyboard'), 'Keys');
  assert.equal(N.stemLabel('strings'), 'Strings');
  assert.equal(N.stemLabel('brass'), 'Brass');
  assert.equal(N.stemLabel('woodwinds'), 'Woodwinds');
  assert.equal(N.stemLabel('synth'), 'Synth');
  assert.equal(N.stemLabel('fx'), 'FX');
  assert.equal(N.stemLabel('unknown_type'), 'unknown_type');
  assert.equal(N.stemLabel(null), 'Stem');
});

test('assignFolderName：同名不同 task 依序加 (2)/(3)，同 task 重用', () => {
  const owners = {};
  const f1 = N.assignFolderName('Where Am I', 'song-e1', owners);
  owners[f1.toLowerCase()] = 'song-e1';
  const f2 = N.assignFolderName('Where Am I', 'song-e2', owners);
  owners[f2.toLowerCase()] = 'song-e2';
  const f3 = N.assignFolderName('Where Am I', 'song-e3', owners);
  assert.equal(f1, 'Where Am I');
  assert.equal(f2, 'Where Am I (2)');
  assert.equal(f3, 'Where Am I (3)');
  // 同一 task 重跑必須得到相同資料夾
  assert.equal(N.assignFolderName('Where Am I', 'song-e1', owners), 'Where Am I');
  // Windows 不分大小寫：大小寫不同也算衝突
  const owners2 = { 'where am i': 'song-x' };
  assert.equal(N.assignFolderName('Where Am I', 'song-y', owners2), 'Where Am I (2)');
});

test('truncateFileName：保留副檔名並限制長度', () => {
  assert.equal(N.truncateFileName('short.mp3', 150), 'short.mp3');
  const long = 'a'.repeat(200) + '.mp3';
  const t = N.truncateFileName(long, 150);
  assert.equal(t.length, 150);
  assert.ok(t.endsWith('.mp3'));
  const noExt = N.truncateFileName('b'.repeat(200), 20);
  assert.equal(noExt.length, 20);
});

test('fileNamesFor：檔名格式精確符合契約 2.4', () => {
  const names = N.fileNamesFor('Neon Drive');
  assert.equal(names.stems('Vocals'), 'Neon Drive - Vocals.mp3');
  assert.equal(names.stems('Backing vocals'), 'Neon Drive - Backing vocals.mp3');
  assert.equal(names.midi(), 'Neon Drive - MIDI.mid');
  assert.equal(names.musicxml(), 'Neon Drive - MusicXML.musicxml');
  assert.equal(names.mp3(), 'Neon Drive.mp3');
  assert.equal(names.wav(), 'Neon Drive.wav');
});

test('buildRelativePath：根目錄/歌名資料夾/型別子資料夾', () => {
  assert.equal(
    N.buildRelativePath({ root: 'ai音樂', folder: 'Neon Drive', filename: 'Neon Drive - Vocals.mp3', typeFolders: false }),
    'ai音樂/Neon Drive/Neon Drive - Vocals.mp3',
  );
  for (const [kind, dir] of [
    ['stems', 'Stems'],
    ['midi', 'MIDI'],
    ['musicxml', 'MIDI'],
    ['mp3', 'Audio'],
    ['wav', 'Audio'],
  ]) {
    const rel = N.buildRelativePath({
      root: 'ai音樂',
      folder: 'Song',
      typeDir: N.TYPE_DIRS[kind],
      filename: 'Song - X.mp3',
      typeFolders: true,
    });
    assert.equal(rel, `ai音樂/Song/${dir}/Song - X.mp3`, `typeFolders ${kind}`);
  }
  // 空根目錄 → aiMusic
  assert.equal(
    N.buildRelativePath({ root: '', folder: 'Song', filename: 'a.mp3', typeFolders: false }),
    'aiMusic/Song/a.mp3',
  );
});

test('buildRelativePath：整體路徑長度上限 180', () => {
  const longFolder = '長'.repeat(55);
  const longFile = 'f'.repeat(200) + '.mp3';
  const rel = N.buildRelativePath({ root: 'ai音樂', folder: longFolder, filename: longFile, typeFolders: false });
  assert.ok(rel.length <= 180, `路徑長度 ${rel.length} 應 <= 180`);
  assert.ok(rel.endsWith('.mp3'), '截斷後仍需保留副檔名');
});

test('uniqueFileName：同歌內重複檔名加 (2)', () => {
  const used = new Set();
  assert.equal(N.uniqueFileName('Song - Vocals.mp3', used), 'Song - Vocals.mp3');
  assert.equal(N.uniqueFileName('Song - Vocals.mp3', used), 'Song - Vocals (2).mp3');
  assert.equal(N.uniqueFileName('song - vocals.MP3', used), 'song - vocals (3).MP3');
});
