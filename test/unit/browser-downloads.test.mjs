import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
const PLAYER = fs.readFileSync(path.join(ROOT, 'player/public/app.js'), 'utf8');
const ALIAS_HELPERS = PLAYER.slice(PLAYER.indexOf('  function resolveFileAlias('), PLAYER.indexOf('  function applyLibraryFileAliases('));

function harness() {
  const listeners = {};
  const callbacks = [];
  const timers = new Map();
  const records = new Map();
  const cancelled = [];
  let timerId = 0;
  const event = (key) => ({ addListener: (fn) => { listeners[key] = fn; } });
  const chrome = {
    runtime: { id: 'isolated-test-extension', lastError: null, onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), getManifest: () => ({ version: 'test' }) },
    downloads: {
      onDeterminingFilename: event('filename'), onChanged: event('changed'),
      download: (options, callback) => callbacks.push({ options, callback }),
      cancel: (id) => cancelled.push(id),
      search: ({ id }, callback) => callback([records.get(id) || { filename: 'F:\\isolated\\unknown.mp3', fileSize: 100 }]),
    },
    alarms: { onAlarm: event('alarm') }, cookies: { onChanged: event('cookies') },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    action: {}, tabs: { query: (_args, callback) => callback([]) },
  };
  const context = vm.createContext({ chrome, console, Map, Set, String, Promise, Date, JSON, navigator: { userAgent: 'isolated-test' }, importScripts() {}, setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(SOURCE, context, { filename: 'src/background.js' });
  const start = (filename, url = 'https://example.invalid/shared.jpg') => vm.runInContext('startDownload', context)({ url, filename });
  const determine = (id, url = 'https://example.invalid/shared.jpg') => {
    const output = { calls: [], async: false };
    output.async = listeners.filename({ id, url }, (suggestion) => output.calls.push(suggestion));
    return output;
  };
  const complete = (id, filename) => { records.set(id, { filename: 'F:\\isolated\\' + filename.replaceAll('/', '\\'), fileSize: 100 }); listeners.changed({ id, state: { current: 'complete' } }); };
  const pendingCounts = () => JSON.parse(vm.runInContext('JSON.stringify({ pending: pending.size, names: namedQueue.size, ids: namedById.size, waiters: filenameWaiters.size })', context));
  return { chrome, callbacks, start, determine, complete, cancelled, pendingCounts, timers };
}

test('同 URL：較早請求啟動失敗，只刪自己的命名 entry，不誤用另一首歌名稱', async () => {
  const h = harness();
  const first = h.start('music/A.jpg');
  const second = h.start('music/B.jpg');
  h.chrome.runtime.lastError = { message: 'first request failed to start' };
  h.callbacks[0].callback(undefined);
  h.chrome.runtime.lastError = null;
  assert.equal((await first).ok, false);
  const name = h.determine(22);
  assert.equal(name.async, true);
  h.callbacks[1].callback(22);
  assert.equal(name.calls[0].filename, 'music/B.jpg');
  h.complete(22, 'music/B.jpg');
  assert.equal((await second).ok, true);
  assert.deepEqual(h.pendingCounts(), { pending: 0, names: 0, ids: 0, waiters: 0 });
});

test('同 URL：filename事件與API callback都亂序，仍以downloadId精確配對', async () => {
  const h = harness();
  const a = h.start('music/A.jpg');
  const b = h.start('music/B.jpg');
  const bName = h.determine(202);
  const aName = h.determine(101);
  assert.equal(aName.calls.length, 0);
  assert.equal(bName.calls.length, 0);
  h.callbacks[1].callback(202);
  h.callbacks[0].callback(101);
  assert.equal(aName.calls[0].filename, 'music/A.jpg');
  assert.equal(bName.calls[0].filename, 'music/B.jpg');
  h.complete(101, 'music/A.jpg'); h.complete(202, 'music/B.jpg');
  assert((await a).ok && (await b).ok);
  assert.deepEqual(h.pendingCounts(), { pending: 0, names: 0, ids: 0, waiters: 0 });
});

test('API callback先到：filename事件不用猜URL佇列順序', async () => {
  const h = harness();
  const a = h.start('music/A.jpg');
  const b = h.start('music/B.jpg');
  h.callbacks[1].callback(20); h.callbacks[0].callback(10);
  assert.equal(h.determine(20).calls[0].filename, 'music/B.jpg');
  assert.equal(h.determine(10).calls[0].filename, 'music/A.jpg');
  h.complete(10, 'music/A.jpg'); h.complete(20, 'music/B.jpg');
  await Promise.all([a, b]);
});

test('啟動同步throw和逾時後遲到callback都清理命名、不復活下載', async () => {
  const h = harness();
  h.chrome.downloads.download = () => { throw new Error('sync start failure'); };
  assert.equal((await h.start('music/sync.jpg')).ok, false);
  assert.equal(h.pendingCounts().names, 0);
  h.chrome.downloads.download = (options, callback) => h.callbacks.push({ options, callback });
  const delayed = h.start('music/late.jpg');
  const name = h.determine(40);
  const timeout = [...h.timers].find(([, item]) => item.delay === 180000);
  timeout[1].fn();
  assert.equal((await delayed).ok, false);
  h.callbacks[0].callback(40);
  assert.deepEqual(h.cancelled, [40]);
  assert.equal(name.calls.length, 1);
  assert.equal(name.calls[0], undefined, 'late callback releases the suggestion without claiming another request');
  assert.deepEqual(h.pendingCounts(), { pending: 0, names: 0, ids: 0, waiters: 0 });
});

test('合法A..B檔名可下載；絕對路徑、反斜線與真正 traversal segment拒絕', async () => {
  const h = harness();
  const good = h.start('music/A..B/A..B.mp3');
  assert.equal(h.callbacks.length, 1, 'internal periods are legal');
  h.callbacks[0].callback(1);
  assert.equal(h.determine(1).calls[0].filename, 'music/A..B/A..B.mp3');
  h.complete(1, 'music/A..B/A..B.mp3');
  assert.equal((await good).ok, true);
  for (const filename of ['/absolute.mp3', 'C:/absolute.mp3', 'music\\song.mp3', 'music/../song.mp3', 'music/./song.mp3']) {
    const result = await h.start(filename);
    assert.equal(result.ok, false, filename);
    assert.match(result.error, /檔名不合法/);
  }
  assert.equal(h.callbacks.length, 1);
});

function shuffleHarness(state, stored = new Map()) {
  const source = PLAYER.slice(PLAYER.indexOf('  function shuffled('), PLAYER.indexOf('  async function playFile('));
  const context = vm.createContext({
    state, library: { fileAliases: {} }, files: new Map(['a', 'b', 'c'].map((id) => [id, {}])), playable: Boolean, failedFiles: new Set(),
    SHUFFLE_KEY: 'test-cycle', shuffleCycle: { order: [], cursor: -1, signature: '' }, followingShuffleCycle: null,
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
  });
  vm.runInContext(ALIAS_HELPERS + source, context);
  return { stored, context, reset: () => vm.runInContext('resetShuffleCycle()', context), next: () => vm.runInContext('shuffleNeighbor(1)', context), advance(plan) { context.plan = plan; vm.runInContext('advanceShuffle(plan)', context); state.currentFileId = plan.id; vm.runInContext('saveShuffleCycle()', context); }, load: () => vm.runInContext('loadShuffleCycle()', context) };
}

test('播放器shuffle：repeat off固定一輪耗盡停止，只有all才建下一輪', () => {
  const state = { queue: ['a', 'b', 'c'], currentFileId: 'a', repeat: 'off', shuffle: true };
  const h = shuffleHarness(state); h.reset();
  const visited = ['a'];
  for (let n = 0; n < 2; n += 1) { const plan = h.next(); assert(plan); visited.push(plan.id); h.advance(plan); }
  assert.equal(new Set(visited).size, 3);
  assert.equal(h.next(), null);
  state.repeat = 'all';
  const restarted = h.next();
  assert(restarted.restart);
  assert.notEqual(restarted.id, state.currentFileId, 'new round avoids repeating its boundary song when alternatives exist');
});

test('播放器shuffle：刪除目前曲後不重播已消耗前綴，新增曲只進未播區', () => {
  const state = { queue: ['a', 'b'], currentFileId: 'a', repeat: 'off', shuffle: true };
  const h = shuffleHarness(state); h.reset();
  state.queue = ['b'];
  assert.equal(h.next().id, 'b');
  state.queue.push('c');
  const visited = [];
  for (let n = 0; n < 2; n += 1) { const plan = h.next(); visited.push(plan.id); h.advance(plan); }
  assert.deepEqual(visited.slice().sort(), ['b', 'c']);
  assert.equal(h.next(), null);
});

test('播放器shuffle：固定順序與cursor重載後仍然耗盡，不因恢復而從頭循環', () => {
  const state = { queue: ['a', 'b'], currentFileId: 'a', repeat: 'off', shuffle: true };
  const h = shuffleHarness(state); h.reset(); h.advance(h.next());
  const restored = shuffleHarness(state, h.stored); restored.load();
  assert.equal(restored.next(), null);
});

test('播放器pending journal：在途PUT未回時仍同步保留最後queue/favorite/playlist，安全重基只認精確前次提交', () => {
  const stored = new Map();
  const state = { revision: 7, queue: ['a'], playlists: [{ id: 'one', name: '第一張', fileIds: ['a'] }], favorites: ['track-a'], history: [], volume: .8, repeat: 'off', shuffle: false, currentFileId: 'a', currentTime: 0 };
  const old = JSON.parse(JSON.stringify(state));
  state.queue.push('b'); state.favorites.push('track-b'); state.playlists.push({ id: 'late', name: '關窗前最後編輯', fileIds: ['b'] });
  const context = vm.createContext({
    state, library: { fileAliases: {} }, files: new Map(), aliasResolutionIssues: [], initialized: true, saving: true, JOURNAL_KEY: 'draft:active', JOURNAL_PREFIX: 'draft:', lastSavedSnapshot: '',
    inFlightSnapshot: { baseRevision: 7, pending: old },
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
  });
  const helpers = PLAYER.slice(PLAYER.indexOf('  function normalizedState('), PLAYER.indexOf('  function changed('));
  vm.runInContext(helpers + ALIAS_HELPERS, context);
  vm.runInContext('persistPendingJournal()', context);
  const draft = JSON.parse(stored.get('draft:active'));
  assert.deepEqual(draft.pending.queue, ['a', 'b']);
  assert.deepEqual(draft.pending.favorites, ['track-a', 'track-b']);
  assert.equal(draft.pending.playlists[1].name, '關窗前最後編輯');
  assert.equal(draft.inFlight.pending.playlists.length, 1, 'in-flight snapshot cannot mutate with later edits');
  context.saving = false;
  context.draft = draft;
  context.server = { ...old, revision: 8 };
  assert.equal(vm.runInContext('draftCanApply(draft,server)', context), true);
  context.server = { ...old, volume: .3, revision: 8 };
  assert.equal(vm.runInContext('draftCanApply(draft,server)', context), false);
  context.server = { ...old, revision: 9 };
  assert.equal(vm.runInContext('draftCanApply(draft,server)', context), false);
  assert(stored.has('draft:active'), 'unsafe recovery never discards the pending original');
});

test('播放器alias：最多32 hops只映到actual檔，cycle/過長/不存在target保留原ID', () => {
  const aliases = { old: 'middle', middle: 'actual', cycleA: 'cycleB', cycleB: 'cycleA', lost: 'missing' };
  for (let index = 0; index < 32; index += 1) aliases['x' + index] = 'x' + (index + 1);
  const context = vm.createContext({ library: { fileAliases: aliases }, files: new Map([['actual', {}], ['x32', {}], ['x33', {}]]) });
  vm.runInContext(ALIAS_HELPERS, context);
  assert.equal(vm.runInContext("resolveFileAlias('old')", context), 'actual');
  assert.equal(vm.runInContext("resolveFileAlias('x0')", context), 'x32');
  assert.equal(vm.runInContext("resolveFileAlias('cycleA')", context), 'cycleA');
  assert.equal(vm.runInContext("resolveFileAlias('lost')", context), 'lost');
  aliases.x32 = 'x33';
  assert.equal(vm.runInContext("resolveFileAlias('x0')", context), 'x0');
});

test('播放器順序cursor：alias收斂後兩個相同fileId位置仍各播一次，repeat off不循環', () => {
  const state = { queue: ['a', 'a'], currentFileId: 'a', repeat: 'off', shuffle: false };
  const context = vm.createContext({ state, library: { fileAliases: {} }, files: new Map([['a', {}]]), playable: Boolean, failedFiles: new Set(), LINEAR_KEY: 'linear', linearCycle: { order: [], cursor: -1, signature: '' }, localStorage: { getItem: () => null, setItem() {} } });
  const source = PLAYER.slice(PLAYER.indexOf('  function saveLinearCycle('), PLAYER.indexOf('  async function playFile('));
  vm.runInContext(ALIAS_HELPERS + source, context);
  vm.runInContext('resetLinearCycle()', context);
  const plan = vm.runInContext('linearNeighbor(1)', context);
  assert.equal(plan.id, 'a'); assert.equal(plan.index, 1);
  context.plan = plan;
  vm.runInContext('advanceLinear(plan)', context);
  assert.equal(vm.runInContext('linearNeighbor(1)', context), null);
});

test('播放器待核對篩選不把已有來源紀錄的正常下載混成未確認', () => {
  const sample = ['verified','recorded','uncertain'].map(status=>({id:status,title:status,status,files:[]}));
  const context=vm.createContext({library:{tracks:sample,files:sample},view:'library',query:'',statusFilter:'uncertain',formatFilter:'all',bpmFilter:'all',keyFilter:'all',sort:{key:'order'},isPlaylistView:()=>false,favorite:()=>false,formatStatus:(track,kind)=>({status:kind==='mp3'?track.status:'unsupported'}),validityOf:file=>file.status,formatOf:()=> 'mp3',files:new Map(),state:{history:[]},analysisOfTrack:()=>null,analysisOfFile:()=>null,bpmMatches:()=>true,keyMatches:()=>true});
  vm.runInContext(PLAYER.slice(PLAYER.indexOf('  function rowsForView('),PLAYER.indexOf('  function sortValue(')),context);
  assert.deepEqual(Array.from(vm.runInContext('rowsForView().map(row=>row.id)',context)),['uncertain']);
  context.view='local';
  assert.deepEqual(Array.from(vm.runInContext('rowsForView().map(row=>row.id)',context)),['uncertain']);
});
