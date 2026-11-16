// WAV 規則＝站點規則（app.js hasWav = !model.lossy，且只有生成歌曲）；404／「部分」問題的回歸測試
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadAceDlScripts } from './lib-load.mjs';

const ACE = await import('../../agent/lib/ace.mjs');
const { config } = await import('../../agent/lib/config.mjs');
const { planner: P } = loadAceDlScripts();

const song = (id, model, capability = 'music_generate') => ({ task_id: id, status: 'succeeded', capability, model, local_audio: `/data/${id}.mp3`, meta: { title: id } });

test('supportsWav：lossy 集合優先；沒有集合時 ace-step* 視為 lossy；新模型預設有 WAV；上傳歌沒有', () => {
  const lossy = new Set(['ace-step-1.5-xl', 'future-lossy']);
  assert.equal(P.supportsWav(song('a', 'acemusic-v1.1'), lossy), true);
  assert.equal(P.supportsWav(song('b', 'ace-step-1.5-xl'), lossy), false);
  assert.equal(P.supportsWav(song('c', 'future-lossy'), lossy), false);
  assert.equal(P.supportsWav(song('d', 'acemusic-v2-brand-new'), lossy), true, '新的非 lossy 模型不需要改程式');
  assert.equal(P.supportsWav(song('e', 'acemusic-v1.1', 'music_transcribe'), lossy), false, '非生成歌曲沒有 WAV');
  assert.equal(P.supportsWav(song('f', ''), lossy), false, '沒有模型（上傳）沒有 WAV');
  // 後備規則（沒登入、讀不到 /api/status）
  assert.equal(P.supportsWav(song('g', 'acemusic-v1.1')), true);
  assert.equal(P.supportsWav(song('h', 'ace-step-1.5-turbo')), false);
});

test('buildDownloadPlan：只為支援 WAV 的模型排 WAV（lossyModels 由呼叫端傳入）', () => {
  const songs = [song('v11', 'acemusic-v1.1'), song('xl', 'ace-step-1.5-xl'), song('v2', 'acemusic-v2')];
  const plan = P.buildDownloadPlan({ songs, options: { types: ['wav'], origin: 'https://x', lossyModels: new Set(['ace-step-1.5-xl']) }, state: {} });
  assert.deepEqual(Array.from(plan.tasks, (t) => t.task_id).sort(), ['v11', 'v2']);
});

test('getLossyModels：讀 /api/status 的 lossy 旗標並快取；讀不到回 null', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ id: 'acemusic-v1.1' }, { id: 'ace-step-1.5-xl', lossy: true }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-lossy-'));
    const stateDir = path.join(base, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'session.json'), JSON.stringify({ cookie: 'a=b' }));
    const cfg = { ...config(), stateDir, downloadDir: path.join(base, 'dl'), baseUrl: `http://127.0.0.1:${server.address().port}`, sessionFile: path.join(stateDir, 'session.json') };
    const first = await ACE.getLossyModels(cfg);
    assert.deepEqual([...first], ['ace-step-1.5-xl']);
    await ACE.getLossyModels(cfg);
    assert.equal(hits, 1, '第二次走快取');
    const none = await ACE.getLossyModels({ ...cfg, stateDir: path.join(base, 'empty'), sessionFile: path.join(base, 'empty', 'session.json') });
    assert.equal(none, null, '沒有 session → null（用後備規則）');
  } finally {
    server.close();
  }
});

test('appendLog：帶 cfg 時寫沙盒日誌，不污染真正的 agent.log', async () => {
  const { appendLog } = await import('../../agent/lib/config.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-log-'));
  const cfg = { ...config(), stateDir: base, logFile: path.join(base, 'agent.log') };
  await appendLog('hello-sandbox', cfg);
  assert.match(fs.readFileSync(cfg.logFile, 'utf8'), /hello-sandbox/);
  const real = path.join(process.env.LOCALAPPDATA || os.homedir(), 'AceMusicDL', 'agent.log');
  if (fs.existsSync(real)) assert.ok(!/hello-sandbox/.test(fs.readFileSync(real, 'utf8')));
});

test('下載狀態標籤：確定缺檔、待核對與未知分開說明', () => {
  const base = { known: true, allDone: false, any: true, have: 1, total: 3, detail: [
    { label: 'MP3', have: 1, total: 1, done: true }, { label: 'MIDI', have: 0, total: 1, done: false }, { label: 'WAV', have: 0, total: 1, done: false },
  ] };
  assert.match(P.downloadStatusLabel(base).text, /缺 MIDI／WAV/);
  const uncertain = { ...base, detail: base.detail.map((item) => item.label === 'MIDI' ? { ...item, uncertain: true } : item) };
  const label = P.downloadStatusLabel(uncertain).text;
  assert.match(label, /待核對 MIDI/); assert.match(label, /缺 WAV/); assert.doesNotMatch(label, /缺 MIDI/);
  assert.equal(P.downloadStatusLabel({ ...base, known: false }, 'host pending').text, '本機核對未就緒');
});
