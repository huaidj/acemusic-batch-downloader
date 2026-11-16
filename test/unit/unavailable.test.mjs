// 站點不提供（no_download）的檔案：plan 跳過、狀態標 N/A、紀錄合併／持久化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAceDlScripts } from './lib-load.mjs';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-na-'));
process.env.ACE_DOWNLOAD_DIR = path.join(tmpBase, 'downloads');
process.env.ACE_STATE_DIR = path.join(tmpBase, 'state');

const ACE = await import('../../agent/lib/ace.mjs');
const { planner: P } = loadAceDlScripts();

const song = (id, title) => ({
  task_id: id,
  capability: 'music_generate',
  status: 'succeeded',
  model: 'acemusic-v1.1',
  local_audio: `/data/${id}.mp3`,
  local_cover: `/data/${id}.jpg`,
  meta: { title },
  // 站點 capability 與產品資格分開：此 fixture 有主動分軌 job。
  stems: { '2': { status: 'done', tracks: [] } },
});

test('markUnavailable／isUnavailable：不改傳入物件', () => {
  const before = {};
  const next = P.markUnavailable(before, 's1', 'midi', 'no_download');
  assert.deepEqual(before, {});
  assert.equal(P.isUnavailable(next, 's1', 'midi'), true);
  assert.equal(P.isUnavailable(next, 's1', 'musicxml'), false);
  assert.equal(P.isUnavailable(next, 's2', 'midi'), false);
  assert.equal(next.s1.midi.code, 'no_download');
});

test('mergeUnavailable：合併多來源，同項取較新的', () => {
  const a = { s1: { midi: { code: 'no_download', at: 10 } } };
  const b = { s1: { midi: { code: 'x', at: 20 }, musicxml: { code: 'no_download', at: 5 } }, s2: { midi: { at: 1 } } };
  const merged = P.mergeUnavailable(a, b, null);
  assert.equal(merged.s1.midi.code, 'x');
  assert.ok(merged.s1.musicxml);
  assert.ok(merged.s2.midi);
});

test('statusItem：不可用且沒檔 → na、不計入 total；有檔照常算已下載', () => {
  // planner 在 vm context 載入，物件原型不同 → 展開成本 context 物件再比對
  const item = (...args) => ({ ...P.statusItem(...args) });
  assert.deepEqual(item('midi', 'MIDI', false, true), { type: 'midi', label: 'MIDI', have: 0, total: 0, done: true, na: true });
  assert.deepEqual(item('midi', 'MIDI', true, true), { type: 'midi', label: 'MIDI', have: 1, total: 1, done: true });
  assert.deepEqual(item('midi', 'MIDI', false, false), { type: 'midi', label: 'MIDI', have: 0, total: 1, done: false });
});

test('buildDownloadPlan：不可用的 MIDI 跳過（file.unavailable），force 會重試', () => {
  const songs = [song('s1', 'Sine Phase Ritual')];
  assert.ok(P.midiAvailable(songs[0]), 'fixture 需要 MIDI capability');
  const state = { unavailable: P.markUnavailable({}, 's1', 'midi') };
  const plan = P.buildDownloadPlan({ songs, options: { types: ['midi', 'musicxml'], origin: 'https://acemusic.ai' }, state });
  const files = plan.tasks[0].files;
  const midi = files.find((f) => f.kind === 'midi');
  const xml = files.find((f) => f.kind === 'musicxml');
  assert.equal(midi.skip, true);
  assert.equal(midi.unavailable, true);
  assert.equal(xml.skip, false);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.toDownload, 1);

  const forced = P.buildDownloadPlan({ songs, options: { types: ['midi'], force: true, origin: 'https://acemusic.ai' }, state });
  assert.equal(forced.tasks[0].files[0].skip, false);
  assert.equal(forced.tasks[0].files[0].unavailable, undefined);
});

test('songDownloadSummary：MIDI 不可用 → 已下載（不再是「部分 2/3」）', () => {
  const s = song('s1', 'Sine Phase Ritual');
  const index = { rel: new Set(), names: new Set(['sine phase ritual - musicxml.musicxml', 'sine phase ritual - cover.jpg', 'sine phase ritual.wav']) };
  const before = ACE.songDownloadSummary(s, index, {});
  assert.equal(before.allDone, false);
  assert.equal(before.have, 3);
  assert.equal(before.total, 4);

  const after = ACE.songDownloadSummary(s, index, P.markUnavailable({}, 's1', 'midi'));
  assert.equal(after.allDone, true);
  assert.equal(after.have, 3);
  assert.equal(after.total, 3);
  assert.deepEqual(after.unavailable, ['midi']);
  assert.equal(after.detail.find((d) => d.type === 'midi').na, true);
});

test('loadState／saveState 保留 unavailable（其他寫入者不會把它洗掉）', async () => {
  const stateFile = path.join(process.env.ACE_STATE_DIR, 'agent-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ history: {}, unavailable: { s1: { midi: { code: 'no_download', at: 1 } } } }));
  const state = await ACE.loadState();
  assert.ok(state.unavailable.s1.midi);
});
