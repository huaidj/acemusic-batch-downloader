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
      settingsClosed: !shadow.querySelector('[data-download-settings]')?.open,
      options: optionKeys.map((k) => ({ key: k, present: present(`[data-opt="${k}"]`), checked: shadow.querySelector(`[data-opt="${k}"]`)?.checked })),
      root: shadow.querySelector('[data-root-folder]')?.value,
      acts: ['select-all', 'select-none', 'refresh', 'download', 'cancel', 'show-folder'].map((a) => ({ a, present: present(`[data-act="${a}"]`) })),
      progress: present('[data-progress]'),
      selectedCountLabels: shadow.querySelectorAll('.count').length,
      hubStatusLabels: shadow.querySelectorAll('.music-hub-status[role="status"]').length,
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
  assertEqual(hooks.selectedCountLabels, 1, '歌曲已選計數 .count 必須保持唯一');
  assertEqual(hooks.hubStatusLabels, 1, '中樞狀態需使用獨立 class 與 status role');
  assertEqual(hooks.songRows, 5, '面板歌曲列數（song-d 未完成須忽略）');
  const titles = sortedUnique(hooks.titles);
  assertEqual(titles, sortedUnique(['Neon Drive', 'Paper Sky', 'Rain: Loop? v2', 'Where Am I', 'Where Am I']), '歌曲標題');
  assert(!hooks.titles.includes('Still Cooking'), '未完成歌 song-d 不應出現在面板');
  // 選項預設值（2.3）
  const optMap = Object.fromEntries(hooks.options.map((o) => [o.key, o.checked]));
  assertEqual(
    optMap,
    { stems: true, midi: true, musicxml: true, mp3: true, wav: true, cover: true, force: false, typeFolders: true },
    '選項預設勾選狀態',
  );
  assert(hooks.settingsClosed, '下載選項預設收合，不占用歌曲與播放器空間');
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
  await page.waitForFunction(() => {
    const fab = document.getElementById('acedl-host')?.shadowRoot?.querySelector('#acedl-fab');
    return fab && /(?:分軌|MIDI|MusicXML|MP3|WAV|封面) · .+ \d+\/\d+/.test(fab.textContent) && /剩餘/.test(fab.title);
  }, null, { timeout: 5000 });
  const fabProgress = await page.locator('#acedl-fab').textContent();
  const fabDetail = await page.locator('#acedl-fab').getAttribute('title');
  assert(!/%/.test(fabProgress) && /完成.*失敗.*略過.*剩餘.*準備中/.test(fabDetail), `浮鈕應顯示檔案類型／曲名與真實計數：${fabProgress} ${fabDetail}`);
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
  // 既有 exact-ID 檔案現在會跨分類位置重用；用空白測試根目錄驗證新下載的分層。
  await setRootFolder(page, 'type-folder-test');
  await selectSongs(page, ['song-a']);
  await clickDownload(page);
  const progress = await waitJobDone(page);
  assertEqual(progress.counts, { done: 7, failed: 0, skipped: 0, total: 7 }, 'S5 typeFolders 進度統計');
  assertFileMap(ROOT, Object.fromEntries(Object.entries(S5_FILES).map(([name, bytes]) => [name.replace(/^ai音樂\//, 'type-folder-test/'), bytes])), 'S5');
  const stemsDir = relFiles(ROOT, 'type-folder-test/Neon Drive/Stems');
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
  const originalStems = structuredClone(mock.songs.find((song) => song.task_id === 'song-a').stems);
  const scopedStems = structuredClone(originalStems);
  for (const job of Object.values(scopedStems)) for (const track of job.tracks || []) if (track.local_audio) track.local_audio += '?e2e_scenario=S11';
  mock.updateSong('song-a', { stems: scopedStems });
  try {
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
  const vocalReqs = mock.log.filter((e) => e.path === '/data/stems/song-a-vocal.mp3?e2e_scenario=S11');
  assertEqual(vocalReqs.length, 2, 'S11 vocal 應被請求 2 次（直連失敗 + 備援 fetch）');
  assertEqual(
    vocalReqs.map((r) => r.status),
    [500, 200],
    'S11 第一次請求 500、第二次 200',
  );
  const drumReqs = mock.log.filter((e) => e.path === '/data/stems/song-a-drums.mp3?e2e_scenario=S11');
  results.fallbackTrace = {
    requests: mock.log.filter((entry) => entry.path.startsWith('/data/stems/')).map(({ at, path, status, range, destination, mode, hasReferer }) => ({ at, path, status, range, destination, mode, hasReferer })),
    page: await page.evaluate(() => ({ downloads: Number(document.documentElement.dataset.acedlTestDownloads || 0), blobs: Number(document.documentElement.dataset.acedlTestBlobDownloads || 0), fallbackFetches: Number(document.documentElement.dataset.acedlTestFallbackFetches || 0), events: JSON.parse(sessionStorage.getItem('aceDownloadDiagnosticsV1') || '{}').events?.slice(-60) || [] })),
  };
  assertEqual(drumReqs.length, 1, 'S11 drums 應直連成功只請求一次');
  } finally { mock.updateSong('song-a', { stems: originalStems }); }
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
  await setOption(page, 'autoNew', false);
  await setOption(page, 'autoRefresh', true);
  try {
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
  assertEqual(mock.log.filter(e => e.method === 'POST').length, 0, 'S12 自動更新不得觸發下載或生成 POST');
  // 分軌完成自動下載也需要即時歌單；只關自動更新時連線必須保留。
  await setOption(page, 'autoRefresh', false);
  await new Promise(r => setTimeout(r, 300));
  assertEqual(mock.sseClientCount(), 1, 'S12 分軌自動下載仍開啟時應保留 SSE');
  await setOption(page, 'autoStems', false);
  const closeDeadline = Date.now() + 3000;
  while (mock.sseClientCount() && Date.now() < closeDeadline) await new Promise(r => setTimeout(r, 25));
  assertEqual(mock.sseClientCount(), 0, 'S12 關閉自動更新、新歌及分軌自動下載後必須中止 SSE');
  mock.clearLog();
  mock.addSong(liveSong('song-live-paused', 'Paused Live', ['vocal']));
  await new Promise(r => setTimeout(r, 250));
  const pushedWhileOff = await page.evaluate(() => !!document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-song-id="song-live-paused"]'));
  assertEqual(pushedWhileOff, false, 'S12 關閉後不得持續推入歌曲');
  assertEqual(mock.log.filter(e => /\/api\/songs\/(events|changes)/.test(e.path)).length, 0, 'S12 關閉後不得重連或拉增量');
  assertEqual(mock.log.filter(e => e.method === 'POST').length, 0, 'S12 關閉時不得產生自動下載');
  await setOption(page, 'autoRefresh', true);
  await panelHasSong(page, 'song-live-paused');
  } finally {
    mock.removeSong('song-live1');
    mock.removeSong('song-live-paused');
    await setOption(page, 'autoRefresh', true);
  }
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

scenario('S17_independent_player_launcher_and_favorites', async () => {
  await freshPanel(page, mock.base);
  const q = (selector) => page.locator(selector);
  const radioBefore = (await readStorage(context)).aceRadio || null;
  assertEqual(await q('[data-radio-player]').count(), 0, 'S17 下載面板不再嵌入播放器');
  assertEqual(await q('[data-act="open-player"]').count(), 1, 'S17 有可見獨立播放器入口');
  assertEqual(await page.evaluate(() => JSON.parse(document.documentElement.dataset.acedlTestPlayerCalls || '[]')), [], 'S17 初載不自動開窗');
  mock.clearLog();
  await q('[data-act="open-player"]').click();
  await q('[data-song-id="song-b"] [data-play]').click();
  await q('[data-song-id="song-a"] .cover').click();
  assertEqual(await page.evaluate(() => JSON.parse(document.documentElement.dataset.acedlTestPlayerCalls || '[]')), [null, 'song-b', 'song-a'], 'S17 主入口與可見封面／逐首入口傳 exact songId 給獨立視窗');
  assertEqual(mock.log.filter((entry) => /\.(?:mp3|wav)(?:\?|$)/i.test(entry.path)).length, 0, 'S17 開視窗 RPC 不在隱藏音訊上播放或下載（封面 JPG 可正常載入）');
  assertEqual((await readStorage(context)).aceRadio || null, radioBefore, 'S17 保留既有電臺偏好');
  for (const id of ['song-a', 'song-b']) await q(`[data-song-id="${id}"] [data-fav]`).click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assertEqual(Object.keys((await readStorage(context)).aceFavorites || {}).sort(), ['song-a', 'song-b'], 'S17 收藏資料保留');
  await q('[data-act="filter-favorites"]').click();
  assertEqual(await q('[data-song-id]').count(), 2, 'S17 收藏篩選正常');
  await q('[data-act="filter-favorites"]').click();
  for (const id of ['song-a', 'song-b']) await q(`[data-song-id="${id}"] [data-fav]`).click();
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
    await page.waitForFunction(() => /缺 WAV/.test(document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-song-id="song-a"] [data-download-status]')?.textContent || ''), null, { timeout: 3000 });
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

scenario('S22_local_verified_wav_updates_without_reload_or_site_refresh', async () => {
  const before = await readStorage(context);
  try {
    await swEval(context, async () => chrome.storage.local.set({ aceHistory: {} }));
    await page.goto(mock.base + '/create/?native-fixture', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await waitSongsLoaded(page, 5);
    await applyOptions(page, { wav: true });
    await setOption(page, 'autoRefresh', false);
    await setOption(page, 'autoNew', false);
    await page.locator('[data-song-id="song-a"] [data-play]').click();
    await page.locator('[data-act="filter-undownloaded"]').click();
    assertEqual(await page.locator('[data-song-id]').count(), 1, 'S22 起初只有 v1.1 song-a 缺 WAV');
    await page.locator('#prompt').fill('Keep this unfinished input');
    await page.evaluate(() => {
      document.documentElement.dataset.acedlLocalPageSentinel = 'same-page';
      document.getElementById('acedl-host').shadowRoot.querySelector('[data-song-id="song-a"]').dataset.acedlRowSentinel = 'unchanged';
    });
    await new Promise((resolve) => setTimeout(resolve, 2400));
    const unchanged = await page.locator('[data-song-id="song-a"]').getAttribute('data-acedl-row-sentinel');
    assertEqual(unchanged, 'unchanged', 'S22 未變更的本機版本不可反覆重建歌曲列');
    const nativeListsBefore = await page.evaluate(() => Number(document.documentElement.dataset.acedlTestIndexBuilds || 0));
    mock.clearLog();
    // 模擬腳本完成一個已驗證本機 WAV：native 檔案清單與 manifest 同時更新。
    await page.evaluate((root) => {
      const flags = document.documentElement.dataset;
      const fixture = JSON.parse(flags.acedlTestNative);
      const absolute = root + '\\local-repair-fixture\\Neon Drive.wav';
      fixture.files = [{ path: absolute, size: 60 }];
      fixture.verified = { savedAt: 'repair-revision-2', files: [{ task_id: 'song-a', kind: 'wav', absolute, bytes: 60, sha256: 'a'.repeat(64), verifiedAt: '2026-11-16T00:00:00Z' }] };
      flags.acedlTestNative = JSON.stringify(fixture);
    }, ROOT);
    await page.waitForFunction(() => !document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-song-id="song-a"]'), null, { timeout: 6500 });
    assertEqual(await page.locator('[data-song-id]').count(), 0, 'S22 修復完成後自動離開待補清單');
    assertEqual(await page.locator('#prompt').inputValue(), 'Keep this unfinished input', 'S22 本機刷新不改輸入內容');
    assertEqual(await page.evaluate(() => document.documentElement.dataset.acedlLocalPageSentinel), 'same-page', 'S22 不重新載入頁面');
    assertEqual(await page.locator('[data-radio-player]').count(), 0, 'S22 本機刷新不重建隱藏的內嵌電臺');
    assertEqual(await page.evaluate(() => JSON.parse(document.documentElement.dataset.acedlTestPlayerCalls || '[]')), ['song-a'], 'S22 本機刷新不重開播放器或觸發新播放');
    assertEqual(mock.log.filter((entry) => /^\/api\/(?:songs|status)/.test(entry.path)).length, 0, 'S22 本機版本輪詢不能打站點 API');
    const nativeListsAfter = await page.evaluate(() => Number(document.documentElement.dataset.acedlTestIndexBuilds || 0));
    assertEqual(nativeListsAfter - nativeListsBefore, 1, 'S22 一次本機版本改動只重掃一次');
    await page.locator('[data-act="filter-undownloaded"]').click();
    assertEqual((await page.locator('[data-song-id="song-a"] [data-download-status]').textContent()).trim(), '已下載', 'S22 該 task 顯示 WAV 已下載');
  } finally {
    await swEval(context, async (saved) => chrome.storage.local.set({ aceHistory: saved.aceHistory || {}, aceSettings: saved.aceSettings || {}, aceRadio: saved.aceRadio || {} }), before);
  }
});

scenario('S23_wav_independent_from_requested_notation_scope', async () => {
  await freshPanel(page, mock.base);
  await applyOptions(page, { midi: true, musicxml: true, wav: true });
  await setOption(page, 'autoNew', false);
  await setRootFolder(page, 'no-notation-request');
  mock.addSong({ task_id: 'song-no-notation', status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', created_at: '2026-11-16T12:00:00Z', local_audio: '/data/mock/no-notation.mp3', meta: { title: 'No Requested Stems' }, stems: {} });
  try {
    await panelHasSong(page, 'song-no-notation');
    await page.locator('[data-act="select-none"]').click();
    await selectSongs(page, ['song-no-notation']);
    mock.clearLog();
    await clickDownload(page);
    const progress = await waitJobDone(page, 10000);
    assertEqual(progress.counts, { done: 1, failed: 0, skipped: 0, total: 1 }, 'S23 未請求分軌的歌仍可獨立下載 WAV');
    assertEqual(mock.log.filter((entry) => entry.method === 'POST').length, 0, 'S23 未請求分軌不送 MIDI／MusicXML 生成');
    assertFileMap(ROOT, { 'no-notation-request/No Requested Stems/No Requested Stems.wav': expectedBytes('AUDIO-WAV', 'song-no-notation') }, 'S23 WAV 獨立');
  } finally { mock.removeSong('song-no-notation'); }
});

scenario('S24_existing_song_ready_stems_auto_download_persist_and_preserve_versions', async () => {
  const before = await readStorage(context);
  const original = structuredClone(mock.songs.find((song) => song.task_id === 'song-c').stems);
  const group = (prefix) => ({ '2': { status: 'done', tracks: ['drums', 'bass'].map((type) => ({ id: `${prefix}-${type}`, type, local_audio: `/data/stems/${prefix}-${type}.mp3` })) } });
  mock.addSong({ ...liveSong('song-c-same-title', 'Rain: Loop? v2', ['vocal']), created_at: '2025-01-01T00:00:00Z' });
  try {
    await swEval(context, async () => chrome.storage.local.remove(['aceAutoStemsV1']));
    await page.goto(mock.base + '/create/?native-fixture', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await waitSongsLoaded(page, 6);
    // 老歌完成分軌獨立於「新歌自動下載」與手動檔案勾選；自動樂譜仍關閉。
    await applyOptions(page, { midi: true, musicxml: true });
    await setOption(page, 'autoNew', false);
    await setOption(page, 'autoNewScores', false);
    await setOption(page, 'autoStems', true);
    await setOption(page, 'autoOrganize', true);
    await setRootFolder(page, 'auto-existing-stems');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const baseline = await readStorage(context);
    assert(baseline.aceAutoStemsV1?.observed?.['song-c'], 'S24 首次載入必須持久化老歌基線');
    mock.clearLog();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assertEqual(mock.log.filter((entry) => entry.path.startsWith('/data/stems/')).length, 0, 'S24 首次不批量抓舊有已完成分軌');
    assertEqual(mock.log.filter((entry) => entry.method === 'POST').length, 0, 'S24 基線不提交生成');
    mock.updateSong('song-c', { stems: group('song-c-auto-v1') });
    const firstFiles = {
      'auto-existing-stems/Rain Loop v2/Rain Loop v2 - Drums.mp3': stem('song-c-auto-v1-drums'),
      'auto-existing-stems/Rain Loop v2/Rain Loop v2 - Bass.mp3': stem('song-c-auto-v1-bass'),
    };
    let deadline = Date.now() + 15000;
    while (Date.now() < deadline && checkFileMap(ROOT, firstFiles, 'S24').length) await new Promise((resolve) => setTimeout(resolve, 100));
    assertFileMap(ROOT, firstFiles, 'S24 老歌新分軌');
    await waitJobDone(page, 10000);
    await page.waitForFunction(() => Number(document.documentElement.dataset.acedlTestTidyCalls || 0) === 1, null, { timeout: 6000 });
    assertEqual(mock.log.filter((entry) => entry.method === 'POST').length, 0, 'S24 autoNewScores 關閉，只抓已購買分軌不提交 MIDI/XML');
    assertEqual(mock.log.filter((entry) => entry.path.startsWith('/data/stems/')).map((entry) => entry.path).sort(), ['/data/stems/song-c-auto-v1-bass.mp3', '/data/stems/song-c-auto-v1-drums.mp3'], 'S24 只下載這個 exact task 新完成的軌道');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const recorded = await readStorage(context);
    assertEqual(Object.keys(recorded.aceAutoStemsV1.pending || {}), [], 'S24 成功工作不留下重複排程');
    mock.clearLog();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await waitSongsLoaded(page, 6);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assertEqual(mock.log.filter((entry) => entry.path.startsWith('/data/stems/')).length, 0, 'S24 重啟不重抓已處理分軌');
    assertEqual(Number(await page.evaluate(() => document.documentElement.dataset.acedlTestTidyCalls || 0)), 0, 'S24 重啟不再次分類');
    // 軌道數仍為 2，但 ID／來源換新版本；舊 count-only fingerprint 曾漏掉它。
    mock.clearLog();
    mock.updateSong('song-c', { stems: group('song-c-auto-v2') });
    deadline = Date.now() + 15000;
    const expectedNew = [stem('song-c-auto-v2-drums'), stem('song-c-auto-v2-bass')];
    const hasNew = () => expectedNew.every((bytes) => listFiles(path.join(ROOT, 'auto-existing-stems')).some((entry) => fs.readFileSync(entry.abs).equals(bytes)));
    while (Date.now() < deadline && !hasNew()) await new Promise((resolve) => setTimeout(resolve, 100));
    assert(hasNew(), 'S24 相同軌道數的新分軌版本仍要下載');
    await waitJobDone(page, 10000);
    assertFileMap(ROOT, firstFiles, 'S24 舊版本原件保留');
    assertEqual(relFiles(ROOT, 'auto-existing-stems').length, 4, 'S24 新舊版本各兩檔並存');
    assertEqual(Number(await page.evaluate(() => document.documentElement.dataset.acedlTestMoveCalls || 0)), 0, 'S24 新版本不交給 size-only native move 去重');
    await page.waitForFunction(() => Number(document.documentElement.dataset.acedlTestTidyCalls || 0) === 1, null, { timeout: 6000 });
  } finally {
    mock.removeSong('song-c-same-title');
    mock.updateSong('song-c', { stems: original });
    await swEval(context, async (saved) => chrome.storage.local.set({ aceSettings: saved.aceSettings || {}, aceAutoNew: saved.aceAutoNew || {}, aceAutoStemsV1: saved.aceAutoStemsV1 || {}, aceHistory: saved.aceHistory || {} }), before);
  }
});

scenario('S25_auto_stems_disabled_does_not_download_existing_song_changes', async () => {
  const before = await readStorage(context);
  const original = structuredClone(mock.songs.find((song) => song.task_id === 'song-c').stems);
  try {
    await freshPanel(page, mock.base);
    await setOption(page, 'autoNew', false);
    await setOption(page, 'autoStems', false);
    mock.clearLog();
    mock.updateSong('song-c', { stems: { '2': { status: 'done', tracks: [{ id: 'song-c-disabled-drum', type: 'drums', local_audio: '/data/stems/song-c-disabled-drum.mp3' }] } } });
    await page.waitForFunction(() => /分軌 1/.test(document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-song-id="song-c"]')?.textContent || ''), null, { timeout: 6000 });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assertEqual(mock.log.filter((entry) => entry.path.startsWith('/data/stems/') || entry.method === 'POST').length, 0, 'S25 關閉後只同步 metadata，不下載或提交生成');
  } finally {
    mock.updateSong('song-c', { stems: original });
    await swEval(context, async (saved) => chrome.storage.local.set({ aceSettings: saved.aceSettings || {}, aceAutoStemsV1: saved.aceAutoStemsV1 || {} }), before);
  }
});

scenario('S26_notation_eligibility_rechecked_immediately_before_post', async () => {
  const original = structuredClone(mock.songs.find((song) => song.task_id === 'song-c').stems);
  try {
    await freshPanel(page, mock.base);
    await applyOptions(page, { midi: true, musicxml: true, force: true });
    await setOption(page, 'autoNew', false);
    await setOption(page, 'autoStems', false);
    await page.locator('[data-act="select-none"]').click();
    await selectSongs(page, ['song-c']);
    mock.clearLog();
    await clickDownload(page);
    // 計畫已含 MIDI/XML，但準備等待期間該 task 已不再有分軌請求證據。
    mock.updateSong('song-c', { stems: {} });
    const result = await waitJobDone(page, 12000);
    assertEqual(mock.log.filter((entry) => entry.method === 'POST').length, 0, 'S26 不能沿用舊計畫授權 POST');
    assertEqual(result.counts, { done: 0, failed: 0, skipped: 2, total: 2 }, 'S26 過期資格略過，不能當作成功或失敗');
  } finally { mock.updateSong('song-c', { stems: original }); }
});

scenario('S27_start_lease_blocks_double_click_and_auto_manual_reentry', async () => {
  const starts = (after) => page.evaluate((since) => JSON.parse(sessionStorage.getItem('aceDownloadDiagnosticsV1') || '{}').events?.filter((entry) => entry.event === 'job_start' && Date.parse(entry.at) >= since).length || 0, after);
  await freshPanel(page, mock.base);
  await applyOptions(page, { midi: true });
  await setOption(page, 'autoNew', false);
  await setOption(page, 'autoNewScores', false);
  await setRootFolder(page, 'lease-manual');
  await page.locator('[data-act="select-none"]').click();
  await selectSongs(page, ['song-a']);
  const manualStartedAt = Date.now();
  mock.clearLog();
  const disabledImmediately = await page.evaluate(() => {
    document.documentElement.dataset.acedlTestPingDelayMs = '450';
    const shadow = document.getElementById('acedl-host').shadowRoot;
    const button = shadow.querySelector('[data-act="download"]');
    button.click();
    const disabled = button.disabled && /準備下載/.test(button.textContent);
    // per-song 入口仍可送事件，用它驗證不只靠 disabled 屬性防重入。
    shadow.querySelector('[data-song-id="song-a"] [data-song-download]').click();
    button.click();
    return disabled;
  });
  assert(disabledImmediately, 'S27 第一個 await 前就要顯示準備中並禁用下載');
  const manual = await waitJobDone(page, 15000);
  assertEqual(manual.counts, { done: 1, failed: 0, skipped: 0, total: 1 }, 'S27 快速重入仍只有一個手動工作');
  assertEqual(await starts(manualStartedAt), 1, 'S27 只建立一次手動 plan/job');
  assertEqual(mock.log.filter((entry) => entry.method === 'POST' && entry.path === '/api/songs/song-a/download').length, 1, 'S27 同一 MIDI 只提交一次');
  assertFileMap(ROOT, { 'lease-manual/Neon Drive/Neon Drive - MIDI.mid': mockData('/data/mock/song-a-full.mid') }, 'S27 手動完成');

  await freshPanel(page, mock.base);
  await applyOptions(page, { midi: true });
  await setOption(page, 'autoNew', true);
  await setOption(page, 'autoNewScores', true); // 僅 mock 站明確選擇，用來核對付費型 POST 次數。
  await setRootFolder(page, 'lease-auto');
  await page.evaluate(() => { document.documentElement.dataset.acedlTestPingDelayMs = '650'; });
  const automaticStartedAt = Date.now();
  mock.clearLog();
  mock.addSong(liveSong('song-lease-automatic', 'Lease Automatic', ['drums']));
  try {
    await panelHasSong(page, 'song-lease-automatic');
    await page.waitForFunction(() => /準備下載/.test(document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-act="download"]')?.textContent || ''), null, { timeout: 5000 });
    await page.locator('[data-song-id="song-lease-automatic"] [data-song-download]').click();
    const automatic = await waitJobDone(page, 16000);
    assertEqual(automatic.counts, { done: 1, failed: 0, skipped: 0, total: 1 }, 'S27 AUTO 準備期間手動入口不能建立第二個工作');
    assertEqual(await starts(automaticStartedAt), 1, 'S27 AUTO＋手動仍只有一個 plan/job');
    assertEqual(mock.log.filter((entry) => entry.method === 'POST' && entry.path === '/api/songs/song-lease-automatic/download').length, 1, 'S27 AUTO＋手動不重複提交 notation');
    assertFileMap(ROOT, { 'lease-auto/Lease Automatic/Lease Automatic - MIDI.mid': mockData('/data/mock/song-lease-automatic-full.mid') }, 'S27 AUTO 完成');
  } finally {
    await setOption(page, 'autoNew', false);
    await setOption(page, 'autoNewScores', false);
    mock.removeSong('song-lease-automatic');
  }
});

scenario('S28_prompt_apply_revalidates_current_limits_and_dictionary_revision', async () => {
  const before = await readStorage(context);
  const customPage = () => page.evaluate(() => {
    localStorage.setItem('aceModel', 'acemusic-v1.1');
    localStorage.setItem('createMode', 'custom');
    document.getElementById('modelBtn').textContent = 'ACE Music v1.1 Preview';
    document.getElementById('ideaMode').style.display = 'none';
    document.getElementById('customMode').style.display = 'block';
    document.getElementById('caption').value = 'Keep the existing page draft';
  });
  const showRandom = async () => {
    await customPage();
    await page.locator('[data-rand-box] summary').click();
    await page.waitForFunction(() => /Custom/.test(document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-rand-ctx]')?.textContent || ''), null, { timeout: 3000 });
  };
  const assertRetained = async (text, label) => {
    assertEqual(await page.locator('[data-rand="apply"]').isDisabled(), true, label + ' 應禁用套用');
    await page.locator('[data-rand="apply"]').dispatchEvent('click');
    assertEqual(await page.locator('#caption').inputValue(), 'Keep the existing page draft', label + ' 不能改頁面原文');
    assertEqual(await page.locator('[data-rand-text]').inputValue(), text, label + ' 保留完整舊草稿');
  };
  try {
    await freshPanel(page, mock.base);
    await showRandom();
    await page.locator('[data-rand="roll"]').click();
    const text = await page.locator('[data-rand-text]').inputValue();
    assert(text.length > 512 && text.length < 1000, 'S28 初始草稿適合舊上限 1000');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const generated = (await readStorage(context)).aceRandom.history.find((item) => item.text === text);
    assert(generated, 'S28 保存可追溯的原始草稿');
    await page.evaluate(() => { document.getElementById('caption').maxLength = 512; });
    await page.waitForFunction(() => /512/.test(document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-rand-ctx]')?.textContent || ''), null, { timeout: 3000 });
    await assertRetained(text, 'S28 可見欄位上限降低');
    await page.locator('[data-rand="roll"]').click();
    assertEqual(await page.locator('[data-rand-text]').inputValue(), text, 'S28 新編譯放不下時也不清空或截短原草稿');

    const historyDraft = async (patch) => {
      await swEval(context, async (item) => chrome.storage.local.set({ aceRandom: { history: [item], lockA: false, lockB: false } }), { ...generated, ...patch });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openPanel(page);
      await waitSongsLoaded(page, 5);
      await showRandom();
      await page.locator('[data-rand-history] button').click();
    };
    mock.setV11StyleLimit(512);
    await historyDraft({});
    assert(/512/.test(await page.locator('[data-rand-ctx]').textContent()), 'S28 讀取站點新模型上限 512');
    await assertRetained(text, 'S28 同模型的現行 API 上限降低');
    mock.setV11StyleLimit(1000);
    await historyDraft({ dictionaryVersion: '0.0.0-old' });
    await assertRetained(text, 'S28 舊詞典版本');
    await historyDraft({ dictionary: 'old-dictionary-id' });
    await assertRetained(text, 'S28 舊詞典 ID');
    assertEqual(await page.evaluate(() => window.__gen), 0, 'S28 全程不按 Generate');
  } finally {
    mock.setV11StyleLimit(1000);
    await swEval(context, async (saved) => chrome.storage.local.set({ aceRandom: saved.aceRandom || {} }), before);
  }
});

scenario('S29_exact_local_index_handles_classified_files_uncertainty_and_old_hosts', async () => {
  const before = await readStorage(context);
  const original = Object.fromEntries(['song-e1', 'song-e2'].map((id) => {
    const song = mock.songs.find((item) => item.task_id === id);
    return [id, { model: song.model, capability: song.capability }];
  }));
  const row = (keys, uncertainKinds = []) => ({ downloaded: { mp3: keys.includes('mp3'), wav: keys.includes('wav'), midi: false, musicxml: false, stems: 2, cover: false }, completedKeys: keys, uncertainKinds, notationRequested: true, wavSupported: true, problemCodes: [] });
  const byTask = { 'song-a': row(['mp3', 'wav']), 'song-b': row([], ['mp3']), 'song-c': row(['mp3']), 'song-e1': row(['mp3', 'wav']), 'song-e2': row([]) };
  const setIndex = (revision, rows, unsupported = false) => page.evaluate(({ rev, tasks, oldHost }) => {
    const flags = document.documentElement.dataset;
    const fixture = JSON.parse(flags.acedlTestNative);
    fixture.compact = { ok: true, apiVersion: 1, revision: rev, savedAt: new Date().toISOString(), summary: {}, byTask: tasks };
    fixture.unsupportedIndex = oldHost;
    flags.acedlTestNative = JSON.stringify(fixture);
  }, { rev: revision, tasks: rows, oldHost: unsupported });
  const waitStatus = (id, expected) => page.waitForFunction(({ task, text }) => (document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-song-id="' + task + '"] [data-download-status]')?.textContent || '').trim() === text, { task: id, text: expected }, { timeout: 6500 });
  try {
    for (const id of ['song-e1', 'song-e2']) mock.updateSong(id, { model: 'acemusic-v1.1', capability: 'music_generate' });
    await swEval(context, async () => chrome.storage.local.set({ aceHistory: { 'song-e2': { folder: 'Where Am I (2)', files: { mp3: { path: 'indexed-classified/Where Am I (2)/Where Am I (2).mp3', absolute: 'F:/fixture-missing-old-path.mp3', at: 1 } } } } }));
    await page.goto(mock.base + '/create/?native-fixture', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await waitSongsLoaded(page, 5);
    await applyOptions(page, { mp3: true, wav: true });
    await setRootFolder(page, 'indexed-classified');
    // 沒有可供 filename 猜測的 fs-list；只有 compact exact ID 的正向證據。
    await setIndex('classified-1', byTask);
    await waitStatus('song-e1', '已下載');
    await waitStatus('song-b', '待核對 MP3');
    const second = await page.locator('[data-song-id="song-e2"] [data-download-status]').textContent();
    assert(/缺 MP3／WAV/.test(second), `S29 同名另 task 不繼承已分類檔案或舊失效 history：${second}`);
    const counts = await page.locator('[data-count]').textContent();
    assert(/所選類型待補 1/.test(counts) && /待核對 1/.test(counts), `S29 確定待補與來源待核對分開計數：${counts}`);
    await page.locator('[data-act="filter-undownloaded"]').click();
    assertEqual(await page.locator('[data-song-id]').getAttribute('data-song-id'), 'song-e2', 'S29 不確定來源不混進確定待補列表');
    await page.locator('[data-act="select-all"]').click();
    assertEqual((await page.locator('[data-count]').textContent()).includes('已選 1 / 顯示 1'), true, 'S29 全選只針對確定缺失');
    await page.locator('[data-act="filter-undownloaded"]').click();
    await page.locator('[data-act="select-none"]').click();
    await selectSongs(page, ['song-e1']);
    mock.clearLog();
    await clickDownload(page);
    const skipped = await waitJobDone(page, 10000);
    assertEqual(skipped.counts, { done: 0, failed: 0, skipped: 2, total: 2 }, 'S29 分類搬移後仍按 exact completedKeys 跳過 MP3/WAV');
    assertEqual(mock.log.filter((entry) => /\/api\/songs\/song-e1\/file|\/download/.test(entry.path)).length, 0, 'S29 已核對檔案不重抓，不觸發生成');

    const missingRow = { ...byTask }; delete missingRow['song-e2'];
    await setIndex('classified-2', missingRow);
    await waitStatus('song-e2', '本機核對未就緒');
    await page.locator('[data-act="filter-undownloaded"]').click();
    assertEqual(await page.locator('[data-song-id]').count(), 0, 'S29 index 沒有該 task 時不能假定整首缺檔');
    await page.locator('[data-act="filter-undownloaded"]').click();

    await setIndex('classified-3', byTask);
    await waitStatus('song-e1', '已下載');
    await applyOptions(page, { stems: true });
    await page.locator('[data-act="select-none"]').click();
    await selectSongs(page, ['song-e1']);
    mock.clearLog();
    await clickDownload(page);
    const stems = await waitJobDone(page, 10000);
    assertEqual(stems.counts, { done: 2, failed: 0, skipped: 0, total: 2 }, 'S29 generic stems count 不能代替 stem:trackId 完成證據');
    assertEqual(mock.log.filter((entry) => entry.path.startsWith('/data/stems/song-e1-')).length, 2, 'S29 只取得缺乏 exact key 的兩個分軌');

    await applyOptions(page, { mp3: true, wav: true });
    await setIndex('unsupported-host', byTask, true);
    await waitStatus('song-e1', '本機核對未就緒');
    assert(/所選類型待補 0/.test(await page.locator('[data-count]').textContent()), 'S29 舊 host 不支持 index 不能把整庫標成待補');
    await page.locator('[data-act="filter-undownloaded"]').click();
    assertEqual(await page.locator('[data-song-id]').count(), 0, 'S29 未就緒不是確定缺檔');
    await page.locator('[data-act="filter-undownloaded"]').click();
    await page.locator('[data-act="select-none"]').click();
    await selectSongs(page, ['song-e2']);
    assertEqual(await page.locator('[data-act="download"]').isEnabled(), true, 'S29 核對服務未就緒仍保留手動 API 下載入口');
  } finally {
    for (const [id, patch] of Object.entries(original)) mock.updateSong(id, patch);
    await swEval(context, async (saved) => chrome.storage.local.set({ aceHistory: saved.aceHistory || {}, aceSettings: saved.aceSettings || {} }), before);
  }
});

scenario('S30_prompt_fill_reads_back_and_keeps_draft_when_form_is_missing', async () => {
  // 驗收 #11：填入後讀回；頁面改寫內容時放棄；找不到或看不到輸入框時保留草稿並可改用複製；全程不按 Generate
  await freshPanel(page, mock.base);
  const q = (sel) => page.locator(sel);
  const toast = () => q('[data-toast]').textContent();
  await page.evaluate(() => {
    localStorage.setItem('aceModel', 'acemusic-v1.1');
    localStorage.setItem('createMode', 'idea');
    document.getElementById('ideaMode').style.display = 'block';
    document.getElementById('customMode').style.display = 'none';
    document.getElementById('modelBtn').textContent = 'ACE Music v1.1 Preview';
    document.getElementById('prompt').value = '';
  });
  await q('[data-rand-box] summary').click();
  await page.waitForFunction(() => /Idea/.test(document.getElementById('acedl-host')?.shadowRoot?.querySelector('[data-rand-ctx]')?.textContent || ''), null, { timeout: 3000 });
  await q('[data-rand="roll"]').click();
  const draft = await q('[data-rand-text]').inputValue();
  assert(/^Song title: "[^"]+"\. /.test(draft), 'S30 Idea 草稿應以歌名開頭');

  // 1) 正常填入：頁面上的值與草稿逐字相同
  await q('[data-rand="apply"]').click();
  assertEqual(await page.locator('#prompt').inputValue(), draft, 'S30 填入後讀回應與草稿相同');
  assert(/已填入/.test(await toast()), 'S30 應提示已填入');

  // 2) 站點改寫輸入內容（例如截短）：讀回不一致 → 放棄並提示改用複製，草稿不變
  // 擴充功能在隔離環境執行，看不到頁面 JS 的屬性覆寫；真實站點是在 input 事件裡改寫實際值（例如受控元件截短）。
  await page.evaluate(() => {
    const node = document.getElementById('prompt');
    node.value = '';
    window.__truncate = () => { if (node.value.length > 40) node.value = node.value.slice(0, 40); };
    node.addEventListener('input', window.__truncate);
  });
  await q('[data-rand="apply"]').click();
  assert(/讀回的內容不一致/.test(await toast()), 'S30 讀回不一致時應明確放棄');
  assertEqual(await q('[data-rand-text]').inputValue(), draft, 'S30 讀回失敗不改動草稿');

  // 3) 輸入框被隱藏：不填入，說明原因
  await page.evaluate(() => {
    const node = document.getElementById('prompt');
    node.removeEventListener('input', window.__truncate);
    node.value = 'page draft stays';
    document.getElementById('ideaMode').style.display = 'none';
  });
  await q('[data-rand="apply"]').click();
  assert(/沒顯示/.test(await toast()), 'S30 輸入框看不到時應說明');
  assertEqual(await page.evaluate(() => document.getElementById('prompt').value), 'page draft stays', 'S30 看不到的輸入框不被改寫');

  // 4) 站點改版找不到輸入框：保留草稿，複製仍可用
  await page.evaluate(() => { document.getElementById('ideaMode').style.display = 'block'; document.getElementById('prompt').remove(); });
  await q('[data-rand="apply"]').click();
  assert(/找不到頁面的輸入框/.test(await toast()), 'S30 找不到輸入框時應建議改用複製');
  assertEqual(await q('[data-rand-text]').inputValue(), draft, 'S30 找不到表單仍保留完整草稿');
  assertEqual(await q('[data-rand="copy"]').isDisabled(), false, 'S30 複製仍可用');
  assertEqual(await page.evaluate(() => window.__gen), 0, 'S30 絕不能按 Generate');
  await page.reload({ waitUntil: 'domcontentloaded' });
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
    nativeIsolation: await launched.sw.evaluate(() => String(chrome.runtime.connectNative).includes('Native host disabled in isolated e2e')),
  };
  assert(results.browser.nativeIsolation, '隔離測試副本必須拒絕所有真 native host 連線');

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

  const requestedScenario = process.env.ACE_E2E_SCENARIO || '';
  const selectedScenarios = requestedScenario ? scenarios.filter((item) => item.name.startsWith(requestedScenario)) : scenarios;
  if (!selectedScenarios.length) throw new Error('No matching isolated e2e scenario');
  results.scope = requestedScenario || 'full';
  for (const s of selectedScenarios) {
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

  const outFile = path.join(TMP, requestedScenario ? 'e2e-result-' + requestedScenario.replace(/[^A-Za-z0-9_-]/g, '_') + '.json' : 'e2e-result.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  const summary = {
    ok: results.ok,
    scope: results.scope,
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





