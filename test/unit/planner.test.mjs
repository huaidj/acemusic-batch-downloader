// test/unit/planner.test.mjs — src/planner.js 純函式單元測試（node:vm 載入 classic script）。
// 期望值對照 CONTRACT.md 2.4；fixture 自行手寫，不依賴 mock-server。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAceDlScripts } from './lib-load.mjs';

let N;
let P;
test('載入 naming.js + planner.js', () => {
  ({ naming: N, planner: P } = loadAceDlScripts());
  assert.ok(N && P, 'globalThis.AceDLNaming / AceDLPlanner 需存在');
});

const track = (id, type, extra = {}) => ({
  id,
  type,
  local_audio: `/data/stems/${id}.mp3`,
  duration: 10,
  ...extra,
});

const songsFixture = () => [
  {
    task_id: 'song-a',
    capability: 'music_generate',
    status: 'succeeded',
    model: 'acemusic-v1.1',
    local_audio: '/data/mock/song-a.mp3',
    meta: { title: 'Neon Drive' },
    stems: {
      '2': {
        status: 'done',
        tracks: [track('a-vocal', 'vocal'), track('a-drums', 'drums'), track('a-empty', 'percussion', { empty: true, local_audio: null })],
      },
      '0': { status: 'done', tracks: [track('a0-vocal', 'vocal'), track('a0-inst', 'instrumental')] },
    },
  },
  {
    task_id: 'song-b',
    capability: 'music_transcribe',
    status: 'succeeded',
    local_audio: '/data/mock/song-b.mp3',
    meta: { title: 'Paper Sky' },
    stems: {
      '0': { status: 'done', tracks: [track('b-vocal', 'vocal'), track('b-inst', 'instrumental')] },
    },
  },
  {
    task_id: 'song-c',
    capability: 'music_generate',
    status: 'succeeded',
    local_audio: '/data/mock/song-c.mp3',
    meta: { title: 'Rain: Loop? v2' },
    stems: {},
  },
  {
    task_id: 'song-d',
    capability: 'music_generate',
    status: 'processing',
    local_audio: null,
    meta: { title: 'Still Cooking' },
    stems: {},
  },
  {
    task_id: 'song-e1',
    capability: 'stem_split',
    status: 'succeeded',
    local_audio: '/data/mock/song-e1.mp3',
    meta: { title: 'Where Am I' },
    stems: { '2': { status: 'done', tracks: [track('e1-vocal', 'vocal'), track('e1-drums', 'drums')] } },
  },
  {
    task_id: 'song-e2',
    capability: 'stem_split',
    status: 'succeeded',
    local_audio: '/data/mock/song-e2.mp3',
    meta: { title: 'Where Am I' },
    stems: { '2': { status: 'done', tracks: [track('e2-vocal', 'vocal'), track('e2-drums', 'drums')] } },
  },
];

const defaults = { stems: true, midi: true, musicxml: false, mp3: false, wav: false, force: false, typeFolders: false };

const FILE_TYPE_KEYS = ['stems', 'midi', 'musicxml', 'mp3', 'wav'];

// content.js 呼叫 planner 時 options.types 是「已勾選的 type 陣列」（契約 2.6）
const planFor = (overrides = {}, state = {}, songs = null) => {
  const opts = { ...defaults, ...overrides };
  const types = FILE_TYPE_KEYS.filter((k) => opts[k]);
  return P.buildDownloadPlan({
    songs: songs || songsFixture(),
    options: {
      types,
      root: opts.root ?? 'ai音樂',
      typeFolders: !!opts.typeFolders,
      force: !!opts.force,
      origin: 'https://acemusic.ai',
    },
    state,
    origin: 'https://acemusic.ai',
  });
};

// vm context 產生的 Array 與 host realm 不同 prototype，deepEqual 前需轉回 host array。
const namesOf = (task) => Array.from(task.files, (f) => f.filename);
const pathsOf = (task) => Array.from(task.files, (f) => f.path);

test('isDone / midiAvailable 判定', () => {
  assert.equal(P.isDone({ status: 'succeeded', local_audio: '/x.mp3' }), true);
  assert.equal(P.isDone({ status: 'succeeded', local_audio: null }), false);
  assert.equal(P.isDone({ status: 'processing', local_audio: '/x.mp3' }), false);
  assert.equal(P.midiAvailable({ status: 'succeeded', local_audio: '/x.mp3', capability: 'music_generate' }), true);
  assert.equal(P.midiAvailable({ status: 'succeeded', local_audio: '/x.mp3', capability: 'music_transcribe' }), true);
  assert.equal(P.midiAvailable({ status: 'succeeded', local_audio: '/x.mp3', capability: 'stem_split' }), false);
  assert.equal(P.midiAvailable({ status: 'processing', local_audio: '/x.mp3', capability: 'music_generate' }), false);
});

test('pickStemGroup：優先 mode 2、否則 mode 0', () => {
  const a = songsFixture()[0];
  assert.equal(P.pickStemGroup(a.stems).mode, '2');
  const b = songsFixture()[1];
  assert.equal(P.pickStemGroup(b.stems).mode, '0');
  // mode 2 未完成 → 退回 mode 0
  const fallback = { '2': { status: 'running', tracks: [] }, '0': { status: 'done', tracks: [track('x', 'vocal')] } };
  assert.equal(P.pickStemGroup(fallback).mode, '0');
  // 全部無效 → null
  assert.equal(P.pickStemGroup({ '2': { status: 'done', tracks: [] } }), null);
  assert.equal(P.pickStemGroup({}), null);
  assert.equal(P.pickStemGroup(null), null);
});

test('pickStemGroup：empty 軌與沒有 local_audio 的軌要跳過', () => {
  const stems = {
    '2': {
      status: 'done',
      tracks: [track('ok', 'vocal'), { id: 'e', type: 'drums', empty: true, local_audio: '/x.mp3' }, { id: 'n', type: 'bass' }],
    },
  };
  const group = P.pickStemGroup(stems);
  assert.equal(group.tracks.length, 1);
  assert.equal(group.tracks[0].id, 'ok');
});

test('normalizeOptions：預設值與型別過濾', () => {
  const o = P.normalizeOptions({});
  assert.equal(o.root, 'ai音樂');
  assert.deepEqual([...o.types], ['stems', 'midi']);
  assert.equal(o.typeFolders, false);
  assert.equal(o.force, false);
  assert.equal(o.origin, 'https://acemusic.ai');
  // 非法 type 被過濾
  const o2 = P.normalizeOptions({ types: ['stems', 'bogus', 'wav'] });
  assert.deepEqual([...o2.types], ['stems', 'wav']);
  // object 形式
  const o3 = P.normalizeOptions({ types: { stems: 1, mp3: true, wav: false } });
  assert.deepEqual([...o3.types].sort(), ['mp3', 'stems']);
});

test('absolutize：相對 URL 補站點 origin', () => {
  assert.equal(P.absolutize('/data/a.mp3', 'https://acemusic.ai'), 'https://acemusic.ai/data/a.mp3');
  assert.equal(P.absolutize('data:abc', 'https://acemusic.ai'), 'data:abc');
  assert.equal(P.absolutize('blob:https://x/y', 'https://acemusic.ai'), 'blob:https://x/y');
  assert.equal(P.absolutize('//cdn.example/x.mp3', 'https://acemusic.ai'), 'https://cdn.example/x.mp3');
  assert.equal(P.absolutize('relative/x.mp3', 'https://acemusic.ai'), 'https://acemusic.ai/relative/x.mp3');
  assert.equal(P.absolutize('/x', 'https://acemusic.ai/'), 'https://acemusic.ai/x');
});

test('buildDownloadPlan：完整清單、命名與資料夾（stems+MIDI）', () => {
  const plan = planFor();
  assert.equal(plan.tasks.length, 5, 'song-d 未完成應跳過');
  assert.deepEqual([...plan.warnings.map((w) => w.task_id)], ['song-d']);
  assert.equal(plan.warnings[0].reason, 'not_ready');

  const byId = Object.fromEntries(plan.tasks.map((t) => [t.task_id, t]));
  // A：mode 2 三軌（empty percussion 跳過）+ MIDI
  assert.equal(byId['song-a'].folder, 'Neon Drive');
  assert.deepEqual(namesOf(byId['song-a']), [
    'Neon Drive - Vocals.mp3',
    'Neon Drive - Drums.mp3',
    'Neon Drive - MIDI.mid',
  ]);
  assert.deepEqual(pathsOf(byId['song-a']), [
    'ai音樂/Neon Drive/Neon Drive - Vocals.mp3',
    'ai音樂/Neon Drive/Neon Drive - Drums.mp3',
    'ai音樂/Neon Drive/Neon Drive - MIDI.mid',
  ]);
  assert.equal(byId['song-a'].stemsMode, '2');
  // B：mode 0 兩軌 + MIDI
  assert.deepEqual(namesOf(byId['song-b']), ['Paper Sky - Vocals.mp3', 'Paper Sky - Instrumental.mp3', 'Paper Sky - MIDI.mid']);
  // C：無分軌，只剩 MIDI；資料夾名清理非法字元
  assert.equal(byId['song-c'].folder, 'Rain Loop v2');
  assert.deepEqual(namesOf(byId['song-c']), ['Rain Loop v2 - MIDI.mid']);
  // E1/E2 同名 → (2) 後綴
  assert.equal(byId['song-e1'].folder, 'Where Am I');
  assert.equal(byId['song-e2'].folder, 'Where Am I (2)');
  assert.deepEqual(namesOf(byId['song-e2']), ['Where Am I (2) - Vocals.mp3', 'Where Am I (2) - Drums.mp3']);
  assert.equal(plan.total, 3 + 3 + 1 + 2 + 2);
  assert.equal(plan.skipped, 0);
});

test('buildDownloadPlan：未選 stems 時沒有分軌檔', () => {
  const plan = planFor({ stems: false, midi: true });
  for (const task of plan.tasks) {
    assert.ok(task.files.every((f) => f.kind === 'midi'), `${task.task_id} 只應有 MIDI`);
  }
});

test('buildDownloadPlan：typeFolders 分層路徑', () => {
  const plan = planFor({ typeFolders: true, mp3: true, wav: true }, {}, [songsFixture()[0]]);
  const task = plan.tasks[0];
  assert.deepEqual(pathsOf(task), [
    'ai音樂/Neon Drive/Stems/Neon Drive - Vocals.mp3',
    'ai音樂/Neon Drive/Stems/Neon Drive - Drums.mp3',
    'ai音樂/Neon Drive/MIDI/Neon Drive - MIDI.mid',
    'ai音樂/Neon Drive/Audio/Neon Drive.mp3',
    'ai音樂/Neon Drive/Audio/Neon Drive.wav',
  ]);
});

test('buildDownloadPlan：history 跳過邏輯（force 可覆寫）', () => {
  const base = planFor();
  const taskA = base.tasks.find((t) => t.task_id === 'song-a');
  const stemFile = taskA.files.find((f) => f.filename === 'Neon Drive - Vocals.mp3');
  const history = {
    'song-a': { folder: 'Neon Drive', files: { [stemFile.key]: { path: stemFile.path, filename: stemFile.filename, at: 1 } } },
  };
  const plan2 = planFor({}, { history });
  const taskA2 = plan2.tasks.find((t) => t.task_id === 'song-a');
  const file2 = taskA2.files.find((f) => f.key === stemFile.key);
  assert.equal(file2.skip, true, '相同 path 的歷史檔應跳過');
  assert.equal(plan2.skipped, 1);
  assert.equal(plan2.toDownload, plan2.total - 1);
  // 其他檔案不受影響
  assert.equal(taskA2.files.filter((f) => f.skip).length, 1);
  // force=true → 不跳過
  const plan3 = planFor({ force: true }, { history });
  assert.equal(plan3.skipped, 0);
  // path 不同的歷史（例如改 root）→ 不跳過
  const plan4 = planFor({ root: '另一根' }, { history });
  assert.equal(plan4.skipped, 0);
});

test('buildDownloadPlan：資料夾指派持久化與重複 task_id 去重', () => {
  const state = {
    folderByTask: { 'song-e2': 'Where Am I' },
    ownerByFolder: { 'where am i': 'song-e2' },
  };
  const plan = planFor({}, state);
  const byId = Object.fromEntries(plan.tasks.map((t) => [t.task_id, t]));
  // e2 已指派過 → 沿用；e1 後到 → 必須避開 (2)
  assert.equal(byId['song-e2'].folder, 'Where Am I');
  assert.equal(byId['song-e1'].folder, 'Where Am I (2)');
  // 同一首歌重複出現只處理一次
  const songs = songsFixture();
  const plan2 = P.buildDownloadPlan({
    songs: [...songs, songs[0]],
    options: defaults,
    state: {},
    origin: 'https://acemusic.ai',
  });
  assert.equal(plan2.tasks.filter((t) => t.task_id === 'song-a').length, 1);
});

test('buildDownloadPlan：超長標題路徑 <= 180 且根目錄清理', () => {
  const longSong = {
    task_id: 'long-1',
    capability: 'music_generate',
    status: 'succeeded',
    local_audio: '/data/mock/long.mp3',
    meta: { title: '很長的歌名'.repeat(20) },
    stems: { '2': { status: 'done', tracks: [track('l1', 'vocal')] } },
  };
  const plan = P.buildDownloadPlan({
    songs: [longSong],
    options: { ...defaults, root: 'bad/root?name' },
    state: {},
    origin: 'https://acemusic.ai',
  });
  const task = plan.tasks[0];
  for (const f of task.files) assert.ok(f.path.length <= 180, `路徑過長：${f.path.length}`);
  assert.ok(task.folder.length <= 55);
  assert.equal(plan.options.root, 'bad/root?name', 'normalizeOptions 不清 root（由 naming 清理）');
  assert.ok(filesPlanPaths(plan).every((p) => !p.includes('?') && !p.includes('\\')));
});

function filesPlanPaths(plan) {
  return plan.tasks.flatMap((t) => t.files.map((f) => f.path));
}

test('mergeHistory：記錄檔案、保留其他檔案、不改傳入物件', () => {
  const plan = planFor();
  const taskA = plan.tasks.find((t) => t.task_id === 'song-a');
  const file = taskA.files[0];
  const input = { 'song-b': { folder: 'Paper Sky', files: { midi: { path: 'x', filename: 'x', at: 1 } } } };
  const inputSnapshot = JSON.stringify(input);
  const h1 = P.mergeHistory(input, 'song-a', taskA.folder, file, 'C:\\dl\\ai音樂\\Neon Drive\\Neon Drive - Vocals.mp3');
  assert.equal(JSON.stringify(input), inputSnapshot, '不得修改傳入的 history');
  assert.equal(h1['song-a'].folder, 'Neon Drive');
  assert.ok(h1['song-a'].files[file.key]);
  assert.equal(h1['song-a'].files[file.key].path, file.path);
  assert.equal(h1['song-b'].files.midi.path, 'x', '其他歌曲歷史需保留');
  // 第二次 merge 保留第一次的檔案
  const file2 = taskA.files[1];
  const h2 = P.mergeHistory(h1, 'song-a', taskA.folder, file2, 'C:\\dl\\x');
  assert.equal(Object.keys(h2['song-a'].files).length, 2);
});

test('buildDownloadPlan：mp3 優先抓 local_audio、wav 走站點 file API（origin 正確）', () => {
  const plan = planFor({ stems: false, midi: false, mp3: true, wav: true }, {}, [songsFixture()[0]]);
  const task = plan.tasks[0];
  const urls = Array.from(task.files, (f) => f.sourceUrl);
  // v1.2.1：上傳類歌曲的 /file?kind=mp3 會 404，因此 MP3 改抓 com.local_audio；WAV 仍走 file API
  assert.deepEqual(urls, [
    'https://acemusic.ai/data/mock/song-a.mp3',
    'https://acemusic.ai/api/songs/song-a/file?kind=wav',
  ]);
  assert.ok(task.files.every((f) => f.source === 'file'));
});


test('buildDownloadPlan：WAV 只排支援的模型（ace-step 不排，避免 404）', () => {
  const v11 = { ...songsFixture()[0], model: 'acemusic-v1.1' };
  const step = { ...songsFixture()[0], model: 'ace-step-1.5-xl' };
  const a = planFor({ stems: false, midi: false, wav: true }, {}, [v11]);
  const b = planFor({ stems: false, midi: false, wav: true }, {}, [step]);
  assert.deepEqual(Array.from(a.tasks[0].files, (f) => f.kind), ['wav']);
  assert.equal(b.tasks.reduce((sum, task) => sum + task.files.length, 0), 0);
});
