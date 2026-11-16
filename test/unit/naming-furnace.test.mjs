import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const N = require('../../naming/engine.js');
const G = require('../../naming/grouping.js');

const track = { bpm: 110, energy: .4, key: 'F:minor', duration: 240, rel: 'x', name: 'x' };

test('同一版本的分軌同一組，版本各自成組', () => {
  const entries = [
    { id: 'a', rel: 'ai音樂/成品MP3/九黎祭.mp3', name: '九黎祭', trackKind: 'full' },
    { id: 'b', rel: 'ai音樂/採樣包/Bass/九黎祭 - Bass.mp3', name: '九黎祭 - Bass', trackKind: 'stem' },
    { id: 'c', rel: 'ai音樂/採樣包/Drums/九黎祭 - Drums.mp3', name: '九黎祭 - Drums', trackKind: 'stem' },
    { id: 'd', rel: 'ai音樂/成品MP3/九黎祭 (2).mp3', name: '九黎祭 (2)', trackKind: 'full' },
    { id: 'e', rel: 'ai音樂/採樣包/Bass/九黎祭 (2) - Bass.mp3', name: '九黎祭 (2) - Bass', trackKind: 'stem' },
  ];
  const { groups, groupOf } = G.groupEntries(entries);
  assert.equal(groups.size, 2);
  const g1 = groups.get(groupOf.get('a'));
  assert.equal(g1.count, 3);
  assert.equal(g1.stems, 2);
  assert.equal(g1.rep.id, 'a');
  const g2 = groups.get(groupOf.get('d'));
  assert.equal(g2.count, 2);
  assert.equal(g2.rep.id, 'd');
});

test('抽象體裁產生「X的Y / The Y of X」', () => {
  const c = N.generate('abstract-seed', track, { mix: 50, shake: 52, register: 'abstract' }, {});
  assert.ok(c, '應該產生名字');
  assert.match(c.zh, /的/);
  assert.match(c.en, /^The /);
  assert.equal(c.register, 'abstract');
});

test('同一個種子可重現，且抽象名字不重複', () => {
  const a = N.generate('same-seed', track, { mix: 50, shake: 52, register: 'abstract' }, {});
  const b = N.generate('same-seed', track, { mix: 50, shake: 52, register: 'abstract' }, {});
  assert.equal(a.zh, b.zh);
  assert.equal(a.en, b.en);

  const used = new Set();
  const names = new Set();
  for (let i = 0; i < 24; i++) {
    const c = N.generate('abs-' + i, track, { mix: 50, shake: 52, register: 'abstract' }, { used });
    if (c) names.add(c.zh + '|' + c.en);
  }
  assert.ok(names.size >= 20, `抽象名字多樣性不足：${names.size}`);
});
