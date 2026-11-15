// test/e2e.mjs — 完整 e2e（Playwright + bundled Chromium + 真 Chrome 下載流程 + mock 站）。
//
// 跑法：node test/e2e.mjs
// 前置：Node.js 22+；`npm i -D playwright`（或設定 PLAYWRIGHT_PATH）並安裝 Chromium。
//
// 驗收對照（CONTRACT.md 第 2.4、2.7、3 節）：期望檔名/路徑一律在此檔「手寫」，
// 不從 src/planner.js 推導，維持驗證獨立性。
import fs from 'node:fs';
import path from 'node:path';
import {
  TMP,
  ARTIFACTS,
  PROJECT_ROOT,
  chromium,
  ensureCleanDir,
  buildTestExtension,
  prepareProfile,
  launchExtensionContext,
  waitForPanelHost,
  openPanel,
  waitSongsLoaded,
  setOption,
  setRootFolder,
  selectSongs,
  clickDownload,
  clickCancel,
  waitJobDone,
  screenshot,
  listFiles,
  relPosix,
  readLoadedManifest,
  readStorage,
  swEval,
} from './lib/harness.mjs';
import { startMockServer, expectedBytes } from './mock-server.mjs';

/* ------------------------------ 期望值（手寫） ------------------------------ */
const ROOT = path.join(TMP, 'e2e', 'downloads');

const stem = (trackId) => expectedBytes('DATA-STEMS', `/data/stems/${trackId}.mp3`);
const mockData = (rel) => expectedBytes('DATA-MOCK', rel);
const audio = (kind, id) => expectedBytes(`AUDIO-${kind.toUpperCase()}`, id);

// S1：A + B + C，stems + MIDI + 封面（typeFolders off；只有 song-a 有封面）
const S1_FILES = {
  'ai音樂/Neon Drive/Neon Drive - Vocals.mp3': stem('song-a-vocal'),
  'ai音樂/Neon Drive/Neon Drive - Drums.mp3': stem('song-a-drums'),
  'ai音樂/Neon Drive/Neon Drive - Bass.mp3': stem('song-a-bass'),
  'ai音樂/Neon Drive/Neon Drive - MIDI.mid': mockData('/data/mock/song-a-full.mid'),
  'ai音樂/Neon Drive/Neon Drive - Cover.jpg': mockData('/data/mock/song-a-cover.jpg'),
  'ai音樂/Paper Sky/Paper Sky - Vocals.mp3': stem('song-b-vocal'),
  'ai音樂/Paper Sky/Paper Sky - Instrumental.mp3': stem('song-b-inst'),
  'ai音樂/Paper Sky/Paper Sky - MIDI.mid': mockData('/data/mock/song-b-full.mid'),
  'ai音樂/Rain Loop v2/Rain Loop v2 - MIDI.mid': mockData('/data/mock/song-c-full.mid'),
};

// S3：同名歌 "Where Am I"（E1 較新 → 先取得無後綴資料夾）
const S3_FILES = {
  'ai音樂/Where Am I/Where Am I - Vocals.mp3': stem('song-e1-vocal'),
  'ai音樂/Where Am I/Where Am I - Drums.mp3': stem('song-e1-drums'),
  'ai音樂/Where Am I (2)/Where Am I (2) - Vocals.mp3': stem('song-e2-vocal'),
  'ai音樂/Where Am I (2)/Where Am I (2) - Drums.mp3': stem('song-e2-drums'),
};

// S5：typeFolders on + mp3 on（只選 A；WAV 已在 v1.2.1 移除）
const S5_FILES = {
  'ai音樂/Neon Drive/Stems/Neon Drive - Vocals.mp3': stem('song-a-vocal'),
  'ai音樂/Neon Drive/Stems/Neon Drive - Drums.mp3': stem('song-a-drums'),
  'ai音樂/Neon Drive/Stems/Neon Drive - Bass.mp3': stem('song-a-bass'),
  'ai音樂/Neon Drive/MIDI/Neon Drive - MIDI.mid': mockData('/data/mock/song-a-full.mid'),
  'ai音樂/Neon Drive/Audio/Neon Drive.mp3': mockData('/data/mock/song-a.mp3'),
  'ai音樂/Neon Drive/Audio/Neon Drive.wav': expectedBytes('AUDIO-WAV', 'song-a'),
  'ai音樂/Neon Drive/Cover/Neon Drive - Cover.jpg': mockData('/data/mock/song-a-cover.jpg'),
};

// S6：取消（新 root，A+B 共 7 檔）
const CANCEL_ROOT = 'cancel-test';
const S6_FILES = {
  [`${CANCEL_ROOT}/Neon Drive/Neon Drive - Vocals.mp3`]: stem('song-a-vocal'),
  [`${CANCEL_ROOT}/Neon Drive/Neon Drive - Drums.mp3`]: stem('song-a-drums'),
  [`${CANCEL_ROOT}/Neon Drive/Neon Drive - Bass.mp3`]: stem('song-a-bass'),
  [`${CANCEL_ROOT}/Neon Drive/Neon Drive - MIDI.mid`]: mockData('/data/mock/song-a-full.mid'),
  [`${CANCEL_ROOT}/Paper Sky/Paper Sky - Vocals.mp3`]: stem('song-b-vocal'),
  [`${CANCEL_ROOT}/Paper Sky/Paper Sky - Instrumental.mp3`]: stem('song-b-inst'),
  [`${CANCEL_ROOT}/Paper Sky/Paper Sky - MIDI.mid`]: mockData('/data/mock/song-b-full.mid'),
};

const ALL_OPTION_KEYS = ['stems', 'midi', 'musicxml', 'mp3', 'wav', 'cover', 'force', 'typeFolders'];  // WAV 需模型支援（v1.6.0 恢復），不支援時自動跳過

/* ------------------------------ 斷言工具 ------------------------------ */
class AssertionError extends Error {}
function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${label}: 期望 ${e}，實際 ${a}`);
}
function sortedUnique(arr) {
  return [...new Set(arr)].sort();
}

const results = {
  startedAt: new Date().toISOString(),
  browser: {},
  manifest: {},
  iconChecks: {},
  scenarios: [],
  downloadItems: [],
  finalFiles: [],
  finalStorage: {},
  pageErrors: [],
  consoleErrors: [],
};
// 這些情境會刻意觸發網路錯誤（未登入 401 / 注入 500），browser console 的
// "Failed to load resource" 屬預期，不算擴充功能失敗；其他情境一律算。
const CONSOLE_ERROR_ALLOWED_SCENARIOS = new Set([
  'S7_logged_out_shows_login_hint',
  'S9_failure_shows_readable_message',
  'S11_fallback_blob_success',
]);
let currentScenario = null;

let mock;
let context;
let page;

function relFiles(dir, sub = '') {
  const base = sub ? path.join(dir, sub) : dir;
  return listFiles(base).map((f) => relPosix(f.rel));
}

function checkFileMap(downloadDir, fileMap, label) {
  const problems = [];
  for (const [rel, expected] of Object.entries(fileMap)) {
    const abs = path.join(downloadDir, ...rel.split('/'));
    const buf = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    if (!buf) problems.push(`${label}: 缺檔 ${rel}`);
    else if (!buf.equals(expected)) problems.push(`${label}: 內容不符 ${rel}（got ${buf.toString('utf8').slice(0, 60)}）`);
  }
  return problems;
}

function assertFileMap(downloadDir, fileMap, label) {
  const problems = checkFileMap(downloadDir, fileMap, label);
  if (problems.length) throw new AssertionError(problems.join('\n'));
}

function snapshotFiles(downloadDir) {
  const map = new Map();
  for (const f of listFiles(downloadDir)) map.set(relPosix(f.rel), { size: f.size, mtimeMs: f.mtimeMs });
  return map;
}

async function applyOptions(p, options) {
  for (const key of ALL_OPTION_KEYS) {
    await setOption(p, key, !!options[key]);
  }
}

async function freshPanel(p, base, expectedSongs = 5) {
  await p.goto(base + '/create/', { waitUntil: 'domcontentloaded' });
  await waitForPanelHost(p);
  await openPanel(p);
  await waitSongsLoaded(p, expectedSongs);
}

/* ------------------------------ 情境 ------------------------------ */
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('S0_manifest_hooks_and_songlist', async () => {
  // 圖示必須是真 PNG 且尺寸正確（契約 2.2）
  const iconDims = {};
  for (const [expected] of [[16], [48], [128]]) {
    const rel = `icons/icon-${expected}.png`;
    const abs = path.join(PROJECT_ROOT, rel);
    assert(fs.existsSync(abs), `${rel} 不存在`);
    const buf = fs.readFileSync(abs);
    assert(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${rel} 不是 PNG`);
    const dims = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    iconDims[rel] = dims;
    assertEqual(dims, { width: expected, height: expected }, `${rel} 尺寸`);
  }
  results.iconDims = iconDims;

  // 不得使用 eval / new Function（契約 2.2）
  const evalOffenders = [];
  for (const file of ['src/naming.js', 'src/planner.js', 'src/content.js', 'src/background.js']) {
    const code = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
    if (/\beval\s*\(/.test(code) || /\bnew\s+Function\s*\(/.test(code)) evalOffenders.push(file);
  }
  assertEqual(evalOffenders, [], '不得使用 eval / new Function');
  const manifestRaw = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8'));
  assert(!manifestRaw.content_security_policy, 'manifest 不應自訂 CSP（避免 inline/eval 需求）');

  // manifest 真的被瀏覽器載入（DoD #4 的機器可驗證證據）
  const manifest = await readLoadedManifest(context);
  results.manifest = manifest;
  assertEqual(manifest.mv, 3, 'manifest_version');
  assertEqual(manifest.background && manifest.background.service_worker, 'src/background.js', 'background.service_worker');
  assert(manifest.background.type === undefined, 'background 不應有 "type":"module"（classic SW）');
  assert(manifest.permissions.includes('downloads') && manifest.permissions.includes('storage'), 'permissions 需含 downloads/storage');
  assert(manifest.hostPermissions.includes('https://acemusic.ai/*'), 'host_permissions 需含 acemusic.ai');
  assertEqual(manifest.contentScripts[0].js.filter((file) => file !== 'src/testmode.js'), ['src/naming.js', 'src/planner.js', 'src/content.js'], 'content_scripts 載入順序');
  assertEqual(manifest.contentScripts[0].run_at, 'document_idle', 'run_at');
  assertEqual(manifest.contentScripts[0].all_frames, false, 'all_frames');

  // icons 可被擴充功能載入（PNG 不存在/manifest 錯誤時瀏覽器不會起 SW）
  const iconChecks = await swEval(context, async () => {
    const out = {};
    for (const rel of ['icons/icon-16.png', 'icons/icon-48.png', 'icons/icon-128.png']) {
      try {
        const r = await fetch(chrome.runtime.getURL(rel));
        const b = await r.arrayBuffer();
        out[rel] = { status: r.status, bytes: b.byteLength, type: r.headers.get('content-type') };
      } catch (e) {
        out[rel] = { error: String(e) };
      }
    }
    return out;
  });
  results.iconChecks = iconChecks;
  for (const [rel, info] of Object.entries(iconChecks)) {
    assert(!info.error && info.status === 200 && info.bytes > 0, `${rel} 無法載入：${JSON.stringify(info)}`);
  }

  await freshPanel(page, mock.base);
  const hooks = await page.evaluate((optionKeys) => {
    const host = document.getElementById('acedl-host');
    const shadow = host && host.shadowRoot;
    if (!shadow) return { host: false };
    const present = (sel) => !!shadow.querySelector(sel);
    return {
      host: !!host,
      fab: present('#acedl-fab'),
      options: optionKeys.map((k) => ({ key: k, present: present(`[data-opt="${k}"]`), checked: shadow.querySelector(`[data-opt="${k}"]`)?.checked })),
      root: shadow.querySelector('[data-root-folder]')?.value,
      acts: ['select-all', 'select-none', 'refresh', 'download', 'cancel', 'show-folder'].map((a) => ({ a, present: present(`[data-act="${a}"]`) })),
      progress: present('[data-progress]'),
      songRows: shadow.querySelectorAll('[data-song-id]').length,
      titles: [...shadow.querySelectorAll('[data-song-id] .name')].map((n) => n.textContent.trim()),
    };
  }, ALL_OPTION_KEYS);
  results.hooks = hooks;
  assert(hooks.host, 'document 內需有 #acedl-host');
  assert(hooks.fab, '#acedl-fab 需存在');
  for (const opt of hooks.options) assert(opt.present, `選項 [data-opt="${opt.key}"] 需存在`);
  assertEqual(hooks.root, 'ai音樂', '根資料夾預設值');
  for (const act of hooks.acts) assert(act.present, `[data-act="${act.a}"] 需存在`);
  assert(hooks.progress, '[data-progress] 需存在');
  assertEqual(hooks.songRows, 5, '面板歌曲列數（song-d 未完成須忽略）');
  const titles = sortedUnique(hooks.titles);
  assertEqual(titles, sortedUnique(['Neon Drive', 'Paper Sky', 'Rain: Loop? v2', 'Where Am I', 'Where Am I']), '歌曲標題');
  assert(!hooks.titles.includes('Still Cooking'), '未完成歌 song-d 不應出現在面板');
  // 選項預設值（2.3）
  const optMap = Object.fromEntries(hooks.options.map((o) => [o.key, o.checked]));
  assertEqual(
    optMap,
    { stems: true, midi: true, musicxml: false, mp3: false, wav: false, cover: true, force: false, typeFolders: false },
    '選項預設勾選狀態',
  );
  await screenshot(page, 's0-panel-ready');

  // 語言前綴路徑也要注入（/zh/create/）
  await page.goto(mock.base + '/zh/create/', { waitUntil: 'domcontentloaded' });
  await waitForPanelHost(page);
  const zhHost = await page.evaluate(() => !!document.getElementById('acedl-host'));
  assert(zhHost, '/zh/create/ 也要注入面板');
});

scenario('S1_download_3_songs_stems_midi', async () => {
  ensureCleanDir(ROOT);
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, cover: true });
  await selectSongs(page, ['song-a', 'song-b', 'song-c']);
  const before = await page.evaluate(() => {
    const shadow = document.getElementById('acedl-host').shadowRoot;
    return {
      count: shadow.querySelector('.count')?.textContent.trim(),
      downloadBtn: shadow.querySelector('[data-act="download"]').textContent.trim(),
    };
  });
  assert(String(before.count || '').startsWith('已選 3 / 共 5 首'), `已選計數文字（實際：${before.count}）`);
  await clickDownload(page);
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 9, failed: 0, skipped: 0, total: 9 }, 'S1 進度統計');
  assert(progress.statsText.includes('完成') && progress.statsText.includes('跳過') && progress.statsText.includes('失敗'), '進度文字需含完成/失敗/跳過');
  assertEqual(progress.cancelVisible, false, 'job 完成後停止按鈕應隱藏');
  assertEqual(progress.showFolderVisible, true, 'job 完成後應顯示「開啟下載資料夾」〔data-act="show-folder"〕');

  assertEqual(relFiles(ROOT), Object.keys(S1_FILES).sort(), 'S1 下載目錄檔案清單');
  assertFileMap(ROOT, S1_FILES, 'S1');

  // 下載歷史持久化（chrome.storage.local）
  const storage = await readStorage(context);
  results.finalStorage = storage;
  assert(!!storage.aceHistory, 'chrome.storage.local 需有 aceHistory');
  assert(!!storage.aceHistory['song-a'] && Object.keys(storage.aceHistory['song-a'].files).length === 5, 'song-a 歷史需有 5 個檔案（3 stems + MIDI + 封面）');
  assert(!!storage.aceHistory['song-b'] && Object.keys(storage.aceHistory['song-b'].files).length === 3, 'song-b 歷史需有 3 個檔案');
  assert(!!storage.aceHistory['song-c'] && Object.keys(storage.aceHistory['song-c'].files).length === 1, 'song-c 歷史需有 1 個檔案');
  assert(!!storage.aceFolders && storage.aceFolders.folderByTask['song-a'] === 'Neon Drive', 'aceFolders 需記錄歌名資料夾');
  await screenshot(page, 's1-job-done');
});

scenario('S2_rerun_skips_existing', async () => {
  const before = snapshotFiles(ROOT);
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, cover: true });
  await selectSongs(page, ['song-a', 'song-b', 'song-c']);
  await clickDownload(page);
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 0, failed: 0, skipped: 9, total: 9 }, 'S2 重跑應全數跳過');
  const after = snapshotFiles(ROOT);
  assertEqual([...after.keys()].sort(), [...before.keys()].sort(), 'S2 不應產生新檔案');
  for (const [rel, info] of after) {
    assert(before.has(rel) && before.get(rel).mtimeMs === info.mtimeMs, `S2 已存在檔案不應被重寫：${rel}`);
  }
});

scenario('S3_same_title_folder_suffix', async () => {
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true });
  await selectSongs(page, ['song-e1', 'song-e2']);
  await clickDownload(page);
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 4, failed: 0, skipped: 0, total: 4 }, 'S3 進度統計');
  assertFileMap(ROOT, S3_FILES, 'S3');
  const storage = await readStorage(context);
  assertEqual(storage.aceFolders.folderByTask['song-e1'], 'Where Am I', 'song-e1 資料夾');
  assertEqual(storage.aceFolders.folderByTask['song-e2'], 'Where Am I (2)', 'song-e2 同名資料夾需加 (2)');
});

scenario('S4_force_redownload', async () => {
  const before = snapshotFiles(ROOT);
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, cover: true, force: true });
  await selectSongs(page, ['song-a']);
  await clickDownload(page);
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 5, failed: 0, skipped: 0, total: 5 }, 'S4 force 應重新下載 5 檔');
  const after = snapshotFiles(ROOT);
  const aFolder = [...after.keys()].filter((rel) => rel.startsWith('ai音樂/Neon Drive/'));
  assertEqual(aFolder.sort(), Object.keys(S1_FILES).filter((r) => r.startsWith('ai音樂/Neon Drive/')).sort(), 'S4 不應產生 uniquify 重複檔');
  let mtimeChanged = 0;
  for (const rel of aFolder) {
    const prev = before.get(rel);
    if (prev && after.get(rel).mtimeMs !== prev.mtimeMs) mtimeChanged += 1;
  }
  assert(mtimeChanged >= 1, 'S4 force 重下需實際覆寫檔案（mtime 應改變）');
  assertFileMap(ROOT, Object.fromEntries(Object.entries(S1_FILES).filter(([r]) => r.startsWith('ai音樂/Neon Drive/'))), 'S4');
});

scenario('S5_type_folders_and_audio', async () => {
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, mp3: true, wav: true, cover: true, typeFolders: true, force: false });
  await selectSongs(page, ['song-a']);
  await clickDownload(page);
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 7, failed: 0, skipped: 0, total: 7 }, 'S5 typeFolders 進度統計');
  assertFileMap(ROOT, S5_FILES, 'S5');
  const stemsDir = relFiles(ROOT, 'ai音樂/Neon Drive/Stems');
  assertEqual(stemsDir.sort(), ['Neon Drive - Bass.mp3', 'Neon Drive - Drums.mp3', 'Neon Drive - Vocals.mp3'], 'S5 Stems 子資料夾');
});

scenario('S6_cancel_keeps_completed', async () => {
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, force: false, typeFolders: false });
  await setRootFolder(page, CANCEL_ROOT);
  const rootValue = await page.evaluate(() => document.getElementById('acedl-host').shadowRoot.querySelector('[data-root-folder]').value);
  assertEqual(rootValue, CANCEL_ROOT, 'S6 根資料夾輸入');
  await selectSongs(page, ['song-a', 'song-b']);
  await clickDownload(page);
  // 等第一個檔案完成就按停止
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('acedl-host').shadowRoot;
      const stats = shadow.querySelector('[data-stats]')?.textContent || '';
      const m = stats.match(/完成\s+(\d+)/);
      return !!(m && Number(m[1]) >= 1);
    },
    null,
    { timeout: 60000, polling: 50 },
  );
  await clickCancel(page);
  const progress = await waitJobDone(page);
  assert(/^已停止/.test(progress.phaseLine || ''), `S6 應顯示已停止，實際：${progress.phaseLine}`);
  assert(progress.counts.done >= 1, 'S6 停止前至少應完成 1 檔');
  assert(progress.counts.done < 7, 'S6 停止應中止後續下載');
  assertEqual(progress.cancelVisible, false, 'S6 停止後取消按鈕應隱藏');
  assertEqual(progress.showFolderVisible, true, 'S6 停止後也應顯示「開啟下載資料夾」');
  const cancelFiles = relFiles(ROOT, CANCEL_ROOT);
  assertEqual(cancelFiles.length, progress.counts.done, 'S6 已完成的檔案保留數應等於進度完成數');
  const expectedDoneMap = Object.fromEntries(
    Object.entries(S6_FILES).filter(([rel]) => cancelFiles.includes(rel.replace(`${CANCEL_ROOT}/`, ''))),
  );
  assertFileMap(ROOT, expectedDoneMap, 'S6 已保留檔案內容');
  assert(cancelFiles.length < 7, 'S6 不應下載全部 7 檔');
});

scenario('S9_failure_shows_readable_message', async () => {
  // 故障注入：song-b 全曲音檔回 500 → 面板需記失敗、訊息可判讀、不得留下檔案
  mock.failPath('/data/mock/song-b.mp3');
  try {
    await freshPanel(page, mock.base);
    await applyOptions(page, { stems: false, midi: false, mp3: true });
    await setRootFolder(page, 'fail-test');
    await selectSongs(page, ['song-b']);
    await clickDownload(page);
    const progress = await waitJobDone(page);
    assertEqual(progress.counts, { done: 0, failed: 1, skipped: 0, total: 1 }, 'S9 失敗統計');
    assertEqual(progress.failedItems.length, 1, 'S9 失敗清單需有 1 筆');
    assert(/500|失敗/.test(progress.failedItems[0] || ''), `S9 失敗訊息需可判讀：${progress.failedItems[0]}`);
    assertEqual(relFiles(ROOT, 'fail-test').length, 0, 'S9 失敗不應留下檔案');
  } finally {
    mock.clearFailures();
  }
});

scenario('S10_per_song_download_button', async () => {
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: false, mp3: false, musicxml: false, force: false, typeFolders: false });
  await setRootFolder(page, 'single-test');
  const row = page.locator('[data-song-id="song-a"]');
  assertEqual(await row.count(), 1, 'S10 應有 song-a 歌曲列');
  await row.locator('[data-song-download]').click();
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 3, failed: 0, skipped: 0, total: 3 }, 'S10 單曲下載進度');
  assertFileMap(
    ROOT,
    {
      'single-test/Neon Drive/Neon Drive - Vocals.mp3': stem('song-a-vocal'),
      'single-test/Neon Drive/Neon Drive - Drums.mp3': stem('song-a-drums'),
      'single-test/Neon Drive/Neon Drive - Bass.mp3': stem('song-a-bass'),
    },
    'S10',
  );
});

scenario('S11_fallback_blob_success', async () => {
  // 驗證 Lead 的備援成功路徑：直連下載第一次被站點 500 拒絕 → content 用 fetch（帶 cookie）
  // 再抓一次成功 → blob URL 交給 SW 下載。mock 只讓「前 1 次請求」失敗。
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: false, mp3: false, musicxml: false, force: false, typeFolders: false });
  await setRootFolder(page, 'fallback-test');
  mock.failFirstRequests('/data/stems/song-a-vocal.mp3', 1);
  mock.clearLog();
  await selectSongs(page, ['song-a']);
  await clickDownload(page);
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 3, failed: 0, skipped: 0, total: 3 }, 'S11 備援後應全部完成');
  assertFileMap(
    ROOT,
    {
      'fallback-test/Neon Drive/Neon Drive - Vocals.mp3': stem('song-a-vocal'),
      'fallback-test/Neon Drive/Neon Drive - Drums.mp3': stem('song-a-drums'),
      'fallback-test/Neon Drive/Neon Drive - Bass.mp3': stem('song-a-bass'),
    },
    'S11',
  );
  const vocalReqs = mock.log.filter((e) => e.path === '/data/stems/song-a-vocal.mp3');
  assertEqual(vocalReqs.length, 2, 'S11 vocal 應被請求 2 次（直連失敗 + 備援 fetch）');
  assertEqual(
    vocalReqs.map((r) => r.status),
    [500, 200],
    'S11 第一次請求 500、第二次 200',
  );
  const drumReqs = mock.log.filter((e) => e.path === '/data/stems/song-a-drums.mp3');
  assertEqual(drumReqs.length, 1, 'S11 drums 應直連成功只請求一次');
});

scenario('S7_logged_out_shows_login_hint', async () => {
  await context.clearCookies();
  await page.goto(mock.base + '/create/?auth-off', { waitUntil: 'domcontentloaded' });
  await waitForPanelHost(page);
  await openPanel(page);
  await page.waitForFunction(
    () => {
      const shadow = document.getElementById('acedl-host')?.shadowRoot;
      const hint = shadow?.querySelector('.songs .hint');
      return !!hint && /請先登入/.test(hint.textContent || '');
    },
    null,
    { timeout: 20000, polling: 100 },
  );
  const state = await page.evaluate(() => {
    const shadow = document.getElementById('acedl-host').shadowRoot;
    return {
      hint: shadow.querySelector('.songs .hint')?.textContent.trim(),
      songRows: shadow.querySelectorAll('[data-song-id]').length,
    };
  });
  assert(/請先登入 ACE Music/.test(state.hint || ''), `未登入提示文字異常：${state.hint}`);
  assertEqual(state.songRows, 0, '未登入時不應有歌曲列');
  await screenshot(page, 's7-login-hint');
});

scenario('S8_no_injection_on_non_create_pages', async () => {
  await page.goto(mock.base + '/library/', { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  const injected = await page.evaluate(() => !!document.getElementById('acedl-host'));
  assertEqual(injected, false, '/library/ 不應注入面板');
  // /create（無尾斜線）應注入
  await page.goto(mock.base + '/create', { waitUntil: 'domcontentloaded' });
  await waitForPanelHost(page);
});

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  const e2eTmp = path.join(TMP, 'e2e');
  ensureCleanDir(e2eTmp);
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  mock = await startMockServer({ pageSize: 4, pollsBeforeReady: 1 });
  const { extDir } = buildTestExtension({ tmpRoot: e2eTmp, port: mock.port });
  const profileDir = path.join(e2eTmp, 'profile');
  const downloadsDir = path.join(e2eTmp, 'downloads');
  prepareProfile({ profileDir, downloadDir: downloadsDir });

  const launched = await launchExtensionContext({ profileDir, extDir, downloadsDir });
  context = launched.context;
  results.browser = {
    mode: 'bundled-chromium',
    executable: chromium.executablePath(),
    version: await launched.sw.evaluate(() => navigator.userAgent),
    extensionId: await launched.sw.evaluate(() => chrome.runtime.id),
    mockBase: mock.base,
    downloadDir: downloadsDir,
  };

  page = context.pages()[0] || (await context.newPage());
  page.on('pageerror', (e) => results.pageErrors.push({ scenario: currentScenario, error: String(e) }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location && m.location().url) || '';
    const text = m.text();
    // mock 站沒有 favicon 資源時 Chrome 會噴 404 console error，與擴充功能無關（Lead 要求濾掉）。
    if (/favicon/i.test(url) || /favicon/i.test(text)) return;
    results.consoleErrors.push({ scenario: currentScenario, text, url });
  });

  for (const s of scenarios) {
    const started = Date.now();
    currentScenario = s.name;
    try {
      await s.fn();
      results.scenarios.push({ name: s.name, ok: true, ms: Date.now() - started });
      console.log(`[PASS] ${s.name} (${Date.now() - started}ms)`);
    } catch (err) {
      const shot = await screenshot(page, `${s.name}-FAIL`);
      results.scenarios.push({
        name: s.name,
        ok: false,
        ms: Date.now() - started,
        error: String((err && err.message) || err),
        screenshot: shot,
      });
      console.log(`[FAIL] ${s.name}: ${(err && err.message) || err}`);
      if (err && err.message) console.log(String(err.message).split('\n').slice(0, 6).join('\n'));
    }
  }

  // 最終狀態蒐集
  results.finalFiles = listFiles(ROOT).map((f) => ({ rel: relPosix(f.rel), size: f.size }));
  results.downloadItems = await swEval(context, async () => {
    const items = await chrome.downloads.search({ limit: 300 });
    return items.map((it) => ({
      id: it.id,
      state: it.state,
      error: it.error || null,
      filename: it.filename,
      url: it.url,
      fileSize: it.fileSize,
    }));
  });
  results.finalStorage = await readStorage(context);
  results.pageErrors = results.pageErrors;
  results.consoleErrors = results.consoleErrors;

  // 所有下載都應落在測試下載目錄（Chrome 採用 profile Preferences，未被 Playwright 劫持）
  const outside = results.downloadItems.filter((it) => it.filename && !it.filename.startsWith(downloadsDir));
  results.outsideDownloadDir = outside;
  const failedScenarios = results.scenarios.filter((s) => !s.ok);
  if (outside.length) {
    failedScenarios.push({ name: 'downloads_dir_check', ok: false, error: `${outside.length} 個下載不在測試目錄` });
  }
  if (results.pageErrors.length) {
    failedScenarios.push({ name: 'page_errors', ok: false, error: JSON.stringify(results.pageErrors) });
  }
  const unallowedConsoleErrors = results.consoleErrors.filter((e) => !CONSOLE_ERROR_ALLOWED_SCENARIOS.has(e.scenario));
  if (unallowedConsoleErrors.length) {
    failedScenarios.push({ name: 'console_errors', ok: false, error: JSON.stringify(unallowedConsoleErrors) });
  }
  results.ok = failedScenarios.length === 0;
  results.finishedAt = new Date().toISOString();

  await context.close().catch(() => {});
  await mock.close();

  const outFile = path.join(TMP, 'e2e-result.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  const summary = {
    ok: results.ok,
    scenarios: results.scenarios.map((s) => ({ name: s.name, ok: s.ok, error: s.error || undefined })),
    downloadDir: downloadsDir,
    finalFileCount: results.finalFiles.length,
    downloadItemCount: results.downloadItems.length,
    resultFile: outFile,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!results.ok) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('e2e fatal:', err);
  try {
    if (context) await context.close();
    if (mock) await mock.close();
  } catch {
    /* ignore */
  }
  process.exitCode = 2;
});





