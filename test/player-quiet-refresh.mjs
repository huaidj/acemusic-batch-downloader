// One isolated real-server/browser acceptance case; no user library or account access.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createPlayerServer } from '../player/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = (process.env.ACE_TEST_TEMP || os.tmpdir());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };

function silentWav() {
  const data = Buffer.alloc(44 + 8000 * 60, 128);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(8000, 28); data.writeUInt16LE(1, 32); data.writeUInt16LE(8, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}

let server, browser, temporary;
const result = { case: 'background-library-refresh-retains-audio-and-input', ok: false, startedAt: new Date().toISOString() };
try {
  temporary = await fs.mkdtemp(path.join(TEMP, 'ace-player-quiet-ui-'));
  const cfg = { stateDir: path.join(temporary, 'state'), downloadDir: path.join(temporary, 'downloads'), baseUrl: 'https://fixture.invalid' };
  const root = path.join(cfg.downloadDir, 'ai音樂');
  await fs.mkdir(cfg.stateDir); await fs.mkdir(root, { recursive: true });
  const bytes = silentWav(), first = path.join(root, 'Fixture One.wav'), second = path.join(root, 'Fixture Two.wav');
  const song = (id, title) => ({ task_id: id, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/data/' + id + '.mp3', meta: { title } });
  const record = (id, filename, number) => ({ id: number, state: 'complete', filename, fileSize: bytes.length, url: cfg.baseUrl + '/api/songs/' + id + '/file?kind=wav' });
  const writeMetadata = async (two = false) => {
    await fs.writeFile(path.join(cfg.stateDir, 'page-songs.json'), JSON.stringify({ songs: [song('quiet-one', 'Fixture One'), ...(two ? [song('quiet-two', 'Fixture Two')] : [])] }));
    await fs.writeFile(path.join(cfg.stateDir, 'history.json'), JSON.stringify({ items: [record('quiet-one', first, 1), ...(two ? [record('quiet-two', second, 2)] : [])] }));
  };
  await fs.writeFile(first, bytes); await writeMetadata();
  server = createPlayerServer({ cfg, stateDir: path.join(temporary, 'player-state'), disableReveal: true, probeHub: async () => false });
  const requests = { full: 0, revision: 0 };
  server.prependListener('request', (req) => {
    const route = new URL(req.url, 'http://fixture').pathname;
    if (route === '/api/library') requests.full += 1;
    if (route === '/api/library/revision') requests.revision += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (route, body) => new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port, path: route, method: payload ? 'PUT' : 'GET', agent: false, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (err) { reject(err); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('fixture HTTP timeout'))); req.on('error', reject); req.end(payload);
  });
  const initialLibrary = await call('/api/library');
  const firstId = initialLibrary.tracks.find((track) => track.id === 'quiet-one').preferredFileId;
  const initialState = await call('/api/state');
  await call('/api/state', { expectedRevision: initialState.revision, queue: [firstId], currentFileId: firstId, repeat: 'one', volume: 0, favorites: ['quiet-one'], playlists: [{ id: 'keep-list', name: 'Keep My Draft', fileIds: [firstId] }] });
  requests.full = requests.revision = 0;
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.locator('[data-row="track:quiet-one"] [data-action="row-play"]').click();
  await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > .1, null, { timeout: 6000 });
  const playing = await page.locator('#audio').evaluate((audio) => ({ src: audio.currentSrc, time: audio.currentTime }));
  await page.locator('#search').fill('Fixture');
  const fullBefore = requests.full;
  await fs.writeFile(second, bytes); await writeMetadata(true);
  const headBefore = requests.revision;
  let deadline = Date.now() + 8000;
  while (requests.revision <= headBefore && Date.now() < deadline) await sleep(50);
  await sleep(100);
  assert(requests.revision > headBefore, 'background revision polling did not run');
  assert(requests.full === fullBefore, 'editing input must defer a changed full-library fetch');
  assert(await page.locator('#search').inputValue() === 'Fixture', 'quiet refresh changed search input');
  assert(await page.locator('#table-body tr').count() === 1, 'editing draft was consumed before blur');
  await page.locator('#search').blur();
  await page.locator('[data-row="track:quiet-two"]').waitFor({ state: 'visible', timeout: 9000 });
  const after = await page.locator('#audio').evaluate((audio) => ({ src: audio.currentSrc, time: audio.currentTime, paused: audio.paused }));
  assert(after.src === playing.src && after.time > playing.time && !after.paused, 'background library update reset or stopped the current audio');
  assert(await page.locator('#search').inputValue() === 'Fixture', 'applied quiet refresh changed the typed query');
  const state = await call('/api/state');
  assert(state.playlists[0]?.name === 'Keep My Draft' && state.queue.includes(firstId) && state.favorites.includes('quiet-one'), 'quiet refresh overwrote playback preferences or playlist draft');
  await page.locator('[data-row="track:quiet-one"]').evaluate((row) => { row.dataset.quietSentinel = 'unchanged'; });
  const fullAfter = requests.full, nextHead = requests.revision;
  deadline = Date.now() + 7000;
  while (requests.revision <= nextHead && Date.now() < deadline) await sleep(50);
  await sleep(100);
  assert(requests.full === fullAfter, 'unchanged revision fetched the full library again');
  assert(await page.locator('[data-row="track:quiet-one"]').getAttribute('data-quiet-sentinel') === 'unchanged', 'unchanged revision rerendered the table');
  assert(errors.length === 0, 'page emitted a runtime error: ' + errors.join('; '));
  const artifactDir = path.join(PROJECT, 'test', '.tmp');
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, 'player-quiet-refresh.png') });
  Object.assign(result, { ok: true, requests, rows: await page.locator('#table-body tr').count(), audioSourcePreserved: true, audioTimeAdvanced: true, inputPreserved: true, preferencesPreserved: true, errors, finishedAt: new Date().toISOString() });
  await fs.writeFile(path.join(artifactDir, 'player-quiet-refresh-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.error = error.message; console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await sleep(100);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (temporary) {
    const relative = path.relative(await fs.realpath(TEMP), await fs.realpath(temporary));
    assert(relative.startsWith('ace-player-quiet-ui-') && !relative.includes(path.sep), 'fixture cleanup escaped its owner directory');
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
