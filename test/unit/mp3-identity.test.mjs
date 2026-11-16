import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFullMp3s } from '../../agent/lib/ace.mjs';
import { config } from '../../agent/lib/config.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-mp3-identity-'));
  const stateDir = path.join(base, 'state');
  const cfg = {
    ...config(), stateDir, downloadDir: path.join(base, 'downloads'), baseUrl: 'https://example.test',
    sessionFile: path.join(stateDir, 'session.json'), historyFile: path.join(stateDir, 'history.json'),
    stateFile: path.join(stateDir, 'agent-state.json'), logFile: path.join(stateDir, 'agent.log'),
  };
  const outDir = path.join(cfg.downloadDir, 'ai音樂', '成品MP3');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(cfg.sessionFile, JSON.stringify({ cookie: 'fixture-only' }));
  const makeFile = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const writeJson = (file, value) => makeFile(file, JSON.stringify(value));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    const id = new URL(url).pathname.match(/\/data\/(so_[^/]+)\.mp3$/)?.[1];
    assert.ok(id, '應直接取得該 task 的 local_audio');
    return new Response('audio:' + id, { headers: { 'content-type': 'audio/mpeg' } });
  });
  return { cfg, outDir, makeFile, writeJson, requests };
}

function song(id) {
  return { task_id: id, status: 'succeeded', capability: 'music_generate', created_at: 1,
    local_audio: '/data/' + id + '.mp3', meta: { title: 'Twin' }, result: { duration_sec: 100 } };
}

function manifest(outDir) {
  return JSON.parse(fs.readFileSync(path.join(outDir, '_manifest.json'), 'utf8'));
}

test('extractFullMp3s: same title uses only the exact task history; aliases do not replace the other take', async (t) => {
  const f = fixture(t), a = song('so_take_a'), b = song('so_take_b');
  const original = path.join(f.cfg.downloadDir, 'ai音樂', 'Twin', 'Audio', 'Twin.mp3');
  f.makeFile(original, 'audio:so_take_a');
  f.makeFile(path.join(f.outDir, 'Twin.mp3'), 'preserve-unowned-original');
  f.writeJson(f.cfg.historyFile, { items: [{ state: 'complete', filename: original, fileSize: 15, url: f.cfg.baseUrl + a.local_audio }] });
  f.writeJson(f.cfg.stateFile, { aliases: { [a.task_id]: b.task_id }, removedPaths: { [path.join(f.outDir, 'Twin (2).mp3').toLowerCase()]: path.join(f.outDir, 'Twin.mp3') } });
  const r = await extractFullMp3s({ songs: [b, a], cfg: f.cfg });
  assert.equal(r.ok, true);
  assert.equal(r.copied, 1);
  assert.equal(r.downloaded, 1);
  assert.deepEqual(f.requests, ['https://example.test/data/so_take_b.mp3']);
  const rows = manifest(f.outDir).items;
  assert.equal(rows.find(x => x.task_id === a.task_id).file, 'Twin (2).mp3', '同時間同名以 task_id 穩定排序');
  assert.equal(fs.readFileSync(path.join(f.outDir, rows.find(x => x.task_id === b.task_id).file), 'utf8'), 'audio:so_take_b');
  assert.equal(fs.readFileSync(path.join(f.outDir, 'Twin.mp3'), 'utf8'), 'preserve-unowned-original');
  assert.equal(fs.readFileSync(original, 'utf8'), 'audio:so_take_a');
});

test('extractFullMp3s: previous task ownership keeps filenames when input order changes', async (t) => {
  const f = fixture(t), a = song('so_take_a'), b = song('so_take_b');
  f.makeFile(path.join(f.outDir, 'Twin.mp3'), 'audio:so_take_b');
  f.makeFile(path.join(f.outDir, 'Twin (2).mp3'), 'audio:so_take_a');
  f.writeJson(path.join(f.outDir, '_manifest.json'), { items: [
    { task_id: b.task_id, file: 'Twin.mp3', size: 15, source: f.cfg.baseUrl + b.local_audio },
    { task_id: a.task_id, file: 'Twin (2).mp3', size: 15, source: f.cfg.baseUrl + a.local_audio },
  ] });
  for (const songs of [[b, a], [a, b]]) {
    const r = await extractFullMp3s({ songs, cfg: f.cfg });
    assert.equal(r.skipped, 2);
    assert.equal(r.downloaded, 0);
    assert.equal(manifest(f.outDir).items.find(x => x.task_id === b.task_id).file, 'Twin.mp3');
    assert.equal(manifest(f.outDir).items.find(x => x.task_id === a.task_id).file, 'Twin (2).mp3');
  }
  assert.equal(f.requests.length, 0);
  assert.equal(fs.readFileSync(path.join(f.outDir, 'Twin.mp3'), 'utf8'), 'audio:so_take_b');
});

test('extractFullMp3s: a copied manifest for the other task is repaired without overwriting either old file', async (t) => {
  const f = fixture(t), a = song('so_take_a'), b = song('so_take_b');
  const source = path.join(f.cfg.downloadDir, 'ai音樂', 'Twin', 'Audio', 'Twin.mp3');
  f.makeFile(source, 'audio:so_take_a');
  f.makeFile(path.join(f.outDir, 'Twin.mp3'), 'audio:so_take_a');
  f.makeFile(path.join(f.outDir, 'Twin (2).mp3'), 'audio:so_take_a');
  f.writeJson(f.cfg.historyFile, { items: [{ state: 'complete', filename: source, fileSize: 15, url: f.cfg.baseUrl + a.local_audio }] });
  f.writeJson(f.cfg.stateFile, { aliases: { [b.task_id]: a.task_id } });
  f.writeJson(path.join(f.outDir, '_manifest.json'), { items: [
    { task_id: a.task_id, file: 'Twin.mp3', size: 15, source, mode: 'copied' },
    { task_id: b.task_id, file: 'Twin (2).mp3', size: 15, source, mode: 'copied' },
  ] });
  const r = await extractFullMp3s({ songs: [a, b], cfg: f.cfg });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 1);
  assert.equal(r.downloaded, 1);
  assert.deepEqual(f.requests, ['https://example.test/data/so_take_b.mp3']);
  assert.equal(fs.readFileSync(path.join(f.outDir, 'Twin.mp3'), 'utf8'), 'audio:so_take_a');
  assert.equal(fs.readFileSync(path.join(f.outDir, 'Twin (2).mp3'), 'utf8'), 'audio:so_take_a');
  assert.equal(fs.readFileSync(path.join(f.outDir, 'Twin (3).mp3'), 'utf8'), 'audio:so_take_b');
  const again = await extractFullMp3s({ songs: [b, a], cfg: f.cfg });
  assert.equal(again.skipped, 2);
  assert.equal(f.requests.length, 1, '已修復的 task 檔名保持穩定，不重下載');
});
