// buildNameIndex／lookupNames 必須與舊的逐檔 regex 完全等價（面板與 agent 狀態都靠它）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAceDlScripts } from './lib-load.mjs';

const { planner: P } = loadAceDlScripts();
const escRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function legacy(names, candidates) {
  const reges = candidates.map((c) => new RegExp('^' + escRe(c) + '(?: \\(\\d+\\))?(?: - (.+))?\\.([a-z0-9]+)$', 'i'));
  const out = [];
  for (const name of names) {
    let match = null;
    for (const re of reges) {
      match = re.exec(name);
      if (match) break;
    }
    if (!match) continue;
    out.push({ name, suffix: match[1] ? match[1].trim().toLowerCase() : '', ext: match[2].toLowerCase() });
  }
  return out;
}

// planner 在 vm context 載入：Array.from 轉成本 context 陣列再比對（原型不同 deepEqual 會失敗）
const norm = (list) => Array.from(list, (e) => `${e.name}|${e.suffix}|${e.ext}`).sort();

test('lookupNames：邊界案例與舊 regex 等價', () => {
  const names = [
    'echo.mp3', 'Echo.WAV', 'echo (2).mp3', 'echo (2) - vocals.mp3', 'echo - midi.mid', 'echo - a - b.mp3',
    'echo - .mp3', 'echoes.mp3', 'echo (x).mp3', 'echo.tar.gz', 'echo - cover.jpg', 'Song - Remix.mp3',
    'song - remix - vocals.mp3', 'song - remix (3) - drums.mp3', '荒原墓地 (zalivad style instrumental) - midi.mid',
    'a.b.mp3', 'a.b - c.mp3', 'noext', '.mp3', 'echo (2) (3).mp3', 'echo  - x.mp3',
  ];
  const candidateSets = [['echo'], ['Echo'], ['song'], ['song - remix'], ['荒原墓地 (Zalivad Style Instrumental)'], ['a.b'], ['a'], ['echo (2)'], ['echo', 'echo (2)'], ['missing']];
  const index = P.buildNameIndex(names);
  for (const candidates of candidateSets) {
    assert.deepEqual(norm(P.lookupNames(index, candidates)), norm(legacy(names, candidates)), 'candidates=' + JSON.stringify(candidates));
  }
});

test('lookupNames：隨機檔名 2000 筆與舊 regex 等價', () => {
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const words = ['echo', 'Echo', 'song', 'a', 'b', 'remix', '幽相', 'x.y'];
  const pick = () => words[rand(words.length)];
  const names = [];
  for (let i = 0; i < 2000; i += 1) {
    let base = pick();
    if (rand(3) === 0) base += ' ' + pick();
    if (rand(4) === 0) base += ` (${rand(4)})`;
    for (let k = rand(3); k > 0; k -= 1) base += ' - ' + pick();
    names.push(base + ['.mp3', '.wav', '.mid', '.MusicXML', '.jpg', ''][rand(6)]);
  }
  const index = P.buildNameIndex(names);
  for (const w of [...words, 'echo song', 'song - remix', 'a b', 'echo (2)']) {
    assert.deepEqual(norm(P.lookupNames(index, [w])), norm(legacy([...new Set(names)], [w])), 'candidate=' + w);
  }
});
