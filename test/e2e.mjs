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
  'S13_no_download_marks_unavailable',
  'S14_rate_limit_stops_without_mass_failures',
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
  assertEqual(manifest.contentScripts[0].js.filter((file) => file !== 'src/testmode.js'), ['src/naming.js', 'src/planner.js', 'src/prompt-data.js', 'src/prompts.js', 'src/diagnostics.js', 'src/content.js'], 'content_scripts 載入順序');
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
  assert(String(before.count || '').startsWith('已選 3 / 顯示 5 / 共 5 首'), `已選計數文字（實際：${before.count}）`);
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

const liveSong = (id, title, tracks) => ({
  task_id: id,
  capability: 'music_generate',
  status: 'succeeded',
  model: 'acemusic-v1.1',
  local_audio: `/data/mock/${id}.mp3`,
  local_cover: null,
  created_at: new Date().toISOString(),
  meta: { title },
  result: { duration_sec: 30 },
  stems: tracks ? { '2': { status: 'done', tracks: tracks.map((t) => track(`${id}-${t}`, t)) } } : null,
});
const track = (id, type) => ({ id, type, local_audio: `/data/stems/${id}.mp3`, duration: 12.5, peaks: null });
const panelHasSong = (p, id, timeout = 8000) =>
  p.waitForFunction((sid) => !!document.getElementById('acedl-host')?.shadowRoot?.querySelector(`[data-song-id="${sid}"]`), id, { timeout, polling: 50 });

scenario('S12_live_new_song_via_sse', async () => {
  // 站點 SSE 推 ver → 面板只抓 /api/songs/changes 增量，不再全量抓歌單
  await freshPanel(page, mock.base);
  await page.waitForFunction(() => true, null, { timeout: 500 }).catch(() => {});
  const waitSse = Date.now() + 8000;
  while (mock.sseClientCount() < 1 && Date.now() < waitSse) await new Promise((r) => setTimeout(r, 50));
  assert(mock.sseClientCount() >= 1, 'S12 面板應訂閱 /api/songs/events');
  mock.clearLog();
  const started = Date.now();
  mock.addSong(liveSong('song-live1', 'Live One', ['vocal']));
  await panelHasSong(page, 'song-live1');
  const ms = Date.now() - started;
  results.liveLatencyMs = ms;
  assert(ms < 3000, `S12 新歌應在 3 秒內出現，實際 ${ms}ms`);
  const fullLists = mock.log.filter((e) => /^\/api\/songs\?/.test(e.path)).length;
  const deltas = mock.log.filter((e) => e.path.startsWith('/api/songs/changes')).length;
  assert(deltas >= 1, 'S12 應呼叫 /api/songs/changes');
  assertEqual(fullLists, 0, 'S12 SSE 連線時不應全量重抓歌單');
  mock.removeSong('song-live1');
});

scenario('S13_no_download_marks_unavailable', async () => {
  mock.setNoDownload('song-c', 'full');
  try {
    await freshPanel(page, mock.base);
    await applyOptions(page, { stems: false, midi: true, cover: false });
    await setRootFolder(page, 'na-test');
    await selectSongs(page, ['song-c']);
    await clickDownload(page);
    const first = await waitJobDone(page);
    assertEqual(first.counts, { done: 0, failed: 0, skipped: 1, total: 1 }, 'S13 no_download 應算跳過不算失敗');
    const storage = await readStorage(context);
    assert(storage.aceUnavailable && storage.aceUnavailable['song-c'] && storage.aceUnavailable['song-c'].midi, 'S13 應記下 song-c MIDI 不可用');
    // 第二次：planner 直接跳過，不再向站點請求
    mock.clearLog();
    await freshPanel(page, mock.base);
    await applyOptions(page, { stems: false, midi: true, cover: false });
    await setRootFolder(page, 'na-test');
    await selectSongs(page, ['song-c']);
    await clickDownload(page);
    const second = await waitJobDone(page);
    assertEqual(second.counts.failed, 0, 'S13 第二次不應失敗');
    const posts = mock.log.filter((e) => e.method === 'POST' && e.path.startsWith('/api/songs/song-c/download')).length;
    assertEqual(posts, 0, 'S13 第二次不應再請求 song-c 的 MIDI');
    const badge = await page.evaluate(() => {
      const row = document.getElementById('acedl-host').shadowRoot.querySelector('[data-song-id="song-c"]');
      return row ? [...row.querySelectorAll('[title]')].map((n) => n.getAttribute('title')).join(' | ') : '';
    });
    results.s13Badge = badge;
  } finally {
    mock.clearSiteErrors();
  }
});

scenario('S14_rate_limit_stops_without_mass_failures', async () => {
  mock.setRateLimited('song-a', 'full');
  mock.setRateLimited('song-b', 'full');
  try {
    await freshPanel(page, mock.base);
    // 限流只停 MIDI／MusicXML 生成；同一個工作裡的 WAV 必須照常下載（之前會整個停掉）
    await applyOptions(page, { stems: false, midi: true, musicxml: true, wav: true, cover: false });
    await setRootFolder(page, 'rl-test');
    await selectSongs(page, ['song-a', 'song-b']);
    await clickDownload(page);
    const progress = await waitJobDone(page, 60000);
    assertEqual(progress.counts.failed, 0, 'S14 限流不應記成失敗');
    assert(!/^已停止/.test(progress.phaseLine || ''), `S14 限流不應停掉整個工作：${progress.phaseLine}`);
    assertFileMap(ROOT, { 'rl-test/Neon Drive/Neon Drive.wav': expectedBytes('AUDIO-WAV', 'song-a') }, 'S14 WAV 應照常下載');
    const statsText = await page.evaluate(() => document.getElementById('acedl-host').shadowRoot.querySelector('[data-stats]').textContent);
    assert(/限流略過\s*4/.test(statsText), `S14 剩餘四個生成項都必須結束為限流略過：${statsText}`);
    assertEqual(progress.counts, { done: 1, failed: 0, skipped: 4, total: 5 }, 'S14 不能留下無 prep worker 處理的等待項目');
  } finally {
    mock.clearSiteErrors();
  }
});

scenario('S15_auto_download_new_song', async () => {
  // 開「新歌自動下載」→ 站點新完成一首 → 自動下載勾選類型（預設不含 MIDI/MusicXML）
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, cover: false });
  await setRootFolder(page, 'auto-test');
  await setOption(page, 'autoNewScores', false);
  await setOption(page, 'autoNew', true);
  const waitSse = Date.now() + 8000;
  while (mock.sseClientCount() < 1 && Date.now() < waitSse) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  mock.clearLog();
  mock.addSong(liveSong('song-live2', 'Live Two', ['vocal', 'drums']));
  const expected = {
    'auto-test/Live Two/Live Two - Vocals.mp3': stem('song-live2-vocal'),
    'auto-test/Live Two/Live Two - Drums.mp3': stem('song-live2-drums'),
  };
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && checkFileMap(ROOT, expected, 'S15').length) await new Promise((r) => setTimeout(r, 200));
  assertFileMap(ROOT, expected, 'S15');
  await waitJobDone(page, 30000);
  const midiPosts = mock.log.filter((e) => e.method === 'POST' && e.path.startsWith('/api/songs/song-live2/download')).length;
  assertEqual(midiPosts, 0, 'S15 自動下載預設不應生成 MIDI（可能扣 credit）');
  // 舊歌不應被自動下載
  assertEqual(relFiles(ROOT, 'auto-test').filter((r) => !r.startsWith('Live Two/')), [], 'S15 只自動下載新歌');
  await setOption(page, 'autoNew', false);
  mock.removeSong('song-live2');
});

scenario('S16_drag_and_opacity', async () => {
  // 面板拖標題列、浮動按鈕拖曳不觸發開關、透明度滑桿、位置與透明度存入 aceUi
  await freshPanel(page, mock.base);
  const box = (sel) =>
    page.evaluate((s) => {
      const r = document.getElementById('acedl-host').shadowRoot.querySelector(s).getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top) };
    }, sel);
  const before = await box('.panel');
  const hdr = await box('.panel header');
  await page.mouse.move(hdr.left + 40, hdr.top + 14);
  await page.mouse.down();
  await page.mouse.move(hdr.left - 160, hdr.top - 6, { steps: 6 });
  await page.mouse.up();
  const after = await box('.panel');
  assertEqual([after.left - before.left, after.top - before.top], [-200, -20], 'S16 面板應跟著拖曳移動');
  await page.evaluate(() => {
    const input = document.getElementById('acedl-host').shadowRoot.querySelector('[data-ui="alpha"]');
    input.value = '60';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  });
  const bg = await page.evaluate(() => getComputedStyle(document.getElementById('acedl-host').shadowRoot.querySelector('.panel')).backgroundColor);
  assert(/0\.6\)$/.test(bg), `S16 透明度應套用到面板背景：${bg}`);
  await page.evaluate(() => document.getElementById('acedl-host').shadowRoot.querySelector('[data-act="close"]').click());
  const fab = await box('.fab');
  await page.mouse.move(fab.left + 15, fab.top + 12);
  await page.mouse.down();
  await page.mouse.move(fab.left - 220, fab.top - 140, { steps: 6 });
  await page.mouse.up();
  const opened = await page.evaluate(() => !document.getElementById('acedl-host').shadowRoot.querySelector('.panel').hidden);
  assertEqual(opened, false, 'S16 拖曳浮動按鈕不應打開面板');
  await new Promise((r) => setTimeout(r, 200));
  const storage = await readStorage(context);
  assert(storage.aceUi && storage.aceUi.alpha === 60 && storage.aceUi.panelPos && storage.aceUi.fabPos, `S16 aceUi 應保存透明度與位置：${JSON.stringify(storage.aceUi)}`);
  // 還原，避免影響後續情境
  await page.evaluate(() => chrome.storage && 0);
  await openPanel(page);
  const h2 = await box('.panel header');
  await page.mouse.dblclick(h2.left + 40, h2.top + 14);
});

scenario('S17_radio_player_favorites', async () => {
  // 電臺：播放請求站點音檔、收藏（愛心）存 aceFavorites、只看收藏過濾、隨機／來源設定持久化
  await freshPanel(page, mock.base);
  const q = (sel) => page.locator(sel);
  assertEqual(await q('[data-radio-player]').count(), 1, 'S17 應有播放器');
  // 收藏 song-a、song-b
  for (const id of ['song-a', 'song-b']) await q(`[data-song-id="${id}"] [data-fav]`).click();
  await new Promise((r) => setTimeout(r, 250));
  let storage = await readStorage(context);
  assertEqual(Object.keys(storage.aceFavorites || {}).sort(), ['song-a', 'song-b'], 'S17 收藏應存入 aceFavorites');
  // 只看收藏
  await q('[data-act="filter-favorites"]').click();
  assertEqual(await q('[data-song-id]').count(), 2, 'S17 只看收藏應只剩 2 首');
  await q('[data-act="filter-favorites"]').click();
  assertEqual(await q('[data-song-id]').count(), 5, 'S17 取消過濾應回到 5 首');
  // 隨機、來源
  await q('[data-radio="shuffle"]').click();
  await q('[data-radio-source]').selectOption('fav');
  // 播放：按 song-a 的播放鍵 → 站點應收到該音檔請求，標題顯示歌名
  mock.clearLog();
  await q('[data-song-id="song-a"] [data-play]').click();
  await new Promise((r) => setTimeout(r, 600));
  assert(mock.log.some((e) => e.path.startsWith('/data/mock/song-a.mp3')), 'S17 播放應請求 song-a 的音檔');
  const title = await q('[data-radio-title]').textContent();
  assertEqual(title.trim(), 'Neon Drive', 'S17 播放器標題');
  await new Promise((r) => setTimeout(r, 250));
  storage = await readStorage(context);
  assert(storage.aceRadio && storage.aceRadio.shuffle === true && storage.aceRadio.source === 'fav' && storage.aceRadio.lastId === 'song-a', `S17 aceRadio 應保存設定：${JSON.stringify(storage.aceRadio)}`);
  // 取消收藏
  await q('[data-song-id="song-a"] [data-fav]').click();
  await new Promise((r) => setTimeout(r, 250));
  storage = await readStorage(context);
  assertEqual(Object.keys(storage.aceFavorites || {}), ['song-b'], 'S17 取消收藏');
  // 還原設定，避免影響後續情境
  await q('[data-radio="shuffle"]').click();
  await q('[data-radio-source]').selectOption('all');
  await q('[data-song-id="song-b"] [data-fav]').click();
});

scenario('S18_random_prompt_models_and_modes', async () => {
  // 隨機提示詞：依「模式＋模型」選詞典與欄位；v1.1 的 Idea→#prompt、Custom→#caption；ACE-Step 不自動填；
  // 模型／模式改變後舊結果不能套用；全程不按 Generate
  await freshPanel(page, mock.base);
  const setPage = (model, mode, label) =>
    page.evaluate(
      ([m, md, lb]) => {
        localStorage.setItem('aceModel', m);
        localStorage.setItem('createMode', md);
        document.getElementById('ideaMode').style.display = md === 'idea' ? 'block' : 'none';
        document.getElementById('customMode').style.display = md === 'custom' ? 'block' : 'none';
        document.getElementById('modelBtn').textContent = lb;
      },
      [model, mode, label],
    );
  const q = (sel) => page.locator(sel);
  const val = (sel) => page.evaluate((s) => document.querySelector(s).value, sel);
  const settle = () => new Promise((r) => setTimeout(r, 1500));

  await setPage('acemusic-v1.1', 'idea', 'ACE Music v1.1 Preview');
  await q('[data-rand-box] summary').click();
  await settle();
  assert(/ACE Music v1\.1 Preview · Idea/.test(await q('[data-rand-ctx]').textContent()), 'S18 應顯示目前模型與模式');
  await q('[data-rand="roll"]').click();
  const text1 = await q('[data-rand-text]').inputValue();
  assert(/No vocals/.test(text1) && text1.length <= 2000, 'S18 Idea 提示詞應含固定約束且 ≤ 2000');
  await q('[data-rand="apply"]').click();
  assertEqual(await val('#prompt'), text1, 'S18 Idea 應填進 #prompt');
  assert((await page.evaluate(() => window.__inputEvents)) >= 1, 'S18 應觸發頁面的 input 事件（字數計數才會更新）');
  assertEqual(await val('#caption'), '', 'S18 Idea 模式不應動到 #caption');

  // 切到 Custom：舊結果是為 Idea 產生的 → 不能套用；重新隨機後填進 #caption（≤1000）
  await setPage('acemusic-v1.1', 'custom', 'ACE Music v1.1 Preview');
  await settle();
  assertEqual(await q('[data-rand="apply"]').isDisabled(), true, 'S18 模式改變後舊結果不得套用');
  await q('[data-rand="roll"]').click();
  const text2 = await q('[data-rand-text]').inputValue();
  assert(text2.length <= 1000, `S18 Custom 提示詞應 ≤ 1000：${text2.length}`);
  await q('[data-rand="apply"]').click();
  assertEqual(await val('#caption'), text2, 'S18 Custom 應填進 #caption');
  assertEqual(await val('#lyrics'), '', 'S18 不應動 Lyrics');

  // 切到 ACE-Step XL：沒有驗證過的詞典 → 不產生、不填入、說明原因
  await setPage('ace-step-1.5-xl', 'custom', 'ACE-Step v1.5 XL');
  await settle();
  assert(/ACE-Step v1\.5 XL/.test(await q('[data-rand-note]').textContent()), 'S18 ACE-Step 應說明沒有詞典');
  assert(/512/.test(await q('[data-rand-ctx]').textContent()), 'S18 應顯示 ACE-Step 的 512 字上限');
  assertEqual(await q('[data-rand="roll"]').isDisabled(), true, 'S18 ACE-Step 不應能隨機');
  assertEqual(await q('[data-rand="apply"]').isDisabled(), true, 'S18 ACE-Step 不應能套用');
  assertEqual(await val('#caption'), text2, 'S18 ACE-Step 下 #caption 不應被改動');

  assertEqual(await page.evaluate(() => window.__gen), 0, 'S18 絕不能按 Generate');
  await setPage('acemusic-v1.1', 'idea', 'ACE Music v1.1 Preview');
});

scenario('S19_invalidated_context_blocks_job_before_generation', async () => {
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, musicxml: true, mp3: true, wav: true, force: true });
  await setRootFolder(page, 'invalid-context-start');
  await page.locator('[data-act="select-none"]').click();
  await selectSongs(page, ['song-a', 'song-b']);
  mock.clearLog();
  // 在同一次頁面操作中斷線並開始，讓 preflight 本身面對失效 runtime。
  await page.evaluate(() => {
    document.documentElement.dataset.acedlTestInvalidated = '1';
    document.getElementById('acedl-host').shadowRoot.querySelector('[data-act="download"]').click();
  });
  const progress = await waitJobDone(page, 5000);
  assert(/刷新 ACE 頁面/.test(progress.phaseLine || ''), `S19 應持續顯示刷新頁面指引：${progress.phaseLine}`);
  assertEqual(progress.counts.done, 0, 'S19 失效頁面不開始下載');
  assert(progress.counts.failed <= 1 && progress.failedItems.length <= 1, 'S19 整體連線故障不能逐檔累積失敗');
  await new Promise((r) => setTimeout(r, 2800));
  assertEqual(mock.log.filter((e) => e.method === 'POST' && /\/download$/.test(e.path)).length, 0, 'S19 失效頁面不能送 MIDI／MusicXML 生成');
  const flags = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  assertEqual(Number(flags.acedlTestDownloads || 0), 0, 'S19 preflight 應擋下所有下載');
  assertEqual(Number(flags.acedlTestFallbackFetches || 0), 0, 'S19 不啟動 blob 備援');
  assertEqual(relFiles(ROOT, 'invalid-context-start').length, 0, 'S19 不產生下載檔');
});

scenario('S20_invalidated_context_stops_inflight_job_once', async () => {
  await freshPanel(page, mock.base);
  await applyOptions(page, { stems: true, midi: true, musicxml: true, mp3: true, wav: true, force: true });
  await setRootFolder(page, 'invalid-context-mid');
  await page.locator('[data-opt="concurrency"]').selectOption('1');
  await page.locator('[data-act="select-none"]').click();
  await selectSongs(page, ['song-a', 'song-b']);
  const before = await readStorage(context);
  mock.clearLog();
  await page.evaluate(() => {
    document.documentElement.dataset.acedlTestInvalidateAfter = '1';
    document.getElementById('acedl-host').shadowRoot.querySelector('[data-act="download"]').click();
  });
  const progress = await waitJobDone(page, 5000);
  assert(/刷新 ACE 頁面/.test(progress.phaseLine || ''), `S20 應顯示斷線原因：${progress.phaseLine}`);
  assertEqual(progress.counts.done, 1, 'S20 已完成的第一檔仍計為成功');
  assert(progress.counts.failed <= 1 && progress.failedItems.length === 1, 'S20 只顯示一次整體連線故障');
  assertEqual(progress.cancelVisible, false, 'S20 失效後工作應能結束');
  await new Promise((r) => setTimeout(r, 2800));
  assertEqual(mock.log.filter((e) => e.method === 'POST' && /\/download$/.test(e.path)).length, 0, 'S20 等待中的生成佇列不可在失效後繼續 POST');
  const flags = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  assertEqual(Number(flags.acedlTestDownloads || 0), 2, 'S20 第一個失效送信後不重試也不再下載下一檔');
  assertEqual(Number(flags.acedlTestBlobDownloads || 0), 0, 'S20 永久斷線不走 blob 下載備援');
  assertEqual(Number(flags.acedlTestFallbackFetches || 0), 0, 'S20 永久斷線不抓備援 blob');
  assertEqual(relFiles(ROOT, 'invalid-context-mid').length, 1, 'S20 保留完成的檔案');
  const after = await readStorage(context);
  for (const key of Object.keys(before.aceHistory || {})) assert(!!after.aceHistory[key], `S20 原有歷史不得丟失：${key}`);
});

scenario('S21_missing_wav_filter_excludes_hidden_selection', async () => {
  const before = await readStorage(context);
  const history = {};
  // 獨立手寫 fixture：只有 song-a 缺 WAV；b/c 的 lossy 模型本來就無 WAV。
  for (const [id, folder] of [['song-a', 'Neon Drive'], ['song-b', 'Paper Sky'], ['song-c', 'Rain Loop v2'], ['song-e1', 'Where Am I'], ['song-e2', 'Where Am I (2)']]) {
    history[id] = { folder, files: { mp3: { path: `selected-missing/${folder}/${folder}.mp3`, filename: `${folder}.mp3`, at: 1, absolute: '' } } };
    if (id === 'song-e1' || id === 'song-e2') history[id].files.wav = { path: `selected-missing/${folder}/${folder}.wav`, filename: `${folder}.wav`, at: 1, absolute: '' };
  }
  try {
    await swEval(context, async (seed) => chrome.storage.local.set({ aceHistory: seed }), history);
    await freshPanel(page, mock.base);
    await applyOptions(page, { mp3: true, wav: true });
    await setRootFolder(page, 'selected-missing');
    const status = await page.locator('[data-song-id="song-a"] [data-download-status]').textContent();
    assert(/缺 WAV/.test(status), `S21 MP3 已有但 WAV 缺失必須列出 WAV：${status}`);
    const lossyStatus = await page.locator('[data-song-id="song-b"] [data-download-status]').getAttribute('title');
    assert(/此模型不提供 WAV/.test(lossyStatus), `S21 lossy 模型應說明 WAV 不適用：${lossyStatus}`);
    // 先選整個曲庫，再開過濾；隱藏的舊勾選也不能跟著出站。
    await page.locator('[data-act="select-all"]').click();
    await page.locator('[data-act="filter-undownloaded"]').click();
    assertEqual(await page.locator('[data-song-id]').count(), 1, 'S21 只留下真正缺 WAV 的 song-a');
    assertEqual(await page.locator('[data-song-id]').getAttribute('data-song-id'), 'song-a', 'S21 缺 WAV 的曲目身分');
    await page.locator('[data-act="select-all"]').click();
    const count = await page.locator('.count').textContent();
    assert(/已選 1 \/ 顯示 1 \/ 共 5 首/.test(count), `S21 全選只應包含可見結果：${count}`);
    mock.clearLog();
    await clickDownload(page);
    const progress = await waitJobDone(page, 10000);
    assertEqual(progress.counts, { done: 1, failed: 0, skipped: 1, total: 2 }, 'S21 只補一個 WAV、跳過已下載 MP3');
    const fileRequests = mock.log.filter((e) => /^\/api\/songs\/[^/]+\/(?:file|download)/.test(e.path));
    assert(fileRequests.length > 0 && fileRequests.every((e) => e.path.startsWith('/api/songs/song-a/file?kind=wav')), `S21 隱藏歌曲不可送出下載：${JSON.stringify(fileRequests.map((e) => e.path))}`);
    assertFileMap(ROOT, { 'selected-missing/Neon Drive/Neon Drive.wav': expectedBytes('AUDIO-WAV', 'song-a') }, 'S21 補 WAV');
  } finally {
    await swEval(context, async (saved) => chrome.storage.local.set({ aceHistory: saved.aceHistory || {}, aceSettings: saved.aceSettings || {} }), before);
  }
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





