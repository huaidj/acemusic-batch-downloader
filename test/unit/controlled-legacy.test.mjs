import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../../agent/lib/config.mjs';
import { runDownload, probeSite } from '../../agent/lib/ace.mjs';

test('controlled workflow cannot trigger legacy score generation outside its finite grant', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-legacy-'));
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir);
  const cfg = { ...config(), stateDir, stateFile: path.join(stateDir, 'agent-state.json'), sessionFile: path.join(stateDir, 'session.json'), historyFile: path.join(stateDir, 'history.json'), downloadDir: path.join(root, 'downloads'), baseUrl: 'https://acemusic.ai', controlledRun: true };
  fs.writeFileSync(cfg.sessionFile, JSON.stringify({ cookie: 'isolated-fixture=session' }));
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, method: options?.method || 'GET' }); return new Response(JSON.stringify({ ok: true, models: [], user: { plan: 'fixture' } })); };
  t.after(() => { globalThis.fetch = original; });
  const song = { task_id: 'so_controlled', status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/data/controlled.mp3', meta: { title: 'Isolated fixture' } };
  const result = await runDownload({ songs: [song], options: { types: ['musicxml'], force: true }, cfg });
  assert.equal(result.failed, 1, JSON.stringify(result));
  assert.ok(result.failedList.some(row => /未批准|授權/.test(row.error)));
  assert.equal(calls.length, 0, 'score generation is stopped at the execution boundary before any HTTP request');
  await probeSite(cfg);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.method === 'GET'), 'read-only account probing remains available');
});
