// 隨機提示詞引擎：模型區分、欄位上限、固定約束、權重 0、鎖軸、seed 復現、不硬截斷
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAceDlScripts } from './lib-load.mjs';

const { prompts: PR, context } = loadAceDlScripts();
const dict = () => context.AceDLPromptData.dictionaries[0];

test('resolveContext：v1.1 ready；ace-step、v1 沒有驗證過的詞典 → no_dictionary；不認得的模型／模式不自動填', () => {
  const ok = PR.resolveContext({ modelId: 'acemusic-v1.1', mode: 'custom' });
  assert.equal(ok.status, 'ready');
  assert.equal(ok.field, 'style');
  assert.equal(ok.limit, 1000);
  const idea = PR.resolveContext({ modelId: 'acemusic-v1.1', mode: 'idea' });
  assert.equal(idea.field, 'prompt');
  assert.equal(idea.limit, 2000);
  const step = PR.resolveContext({ modelId: 'ace-step-1.5-xl', mode: 'custom' });
  assert.equal(step.status, 'no_dictionary');
  assert.equal(step.limit, 512);
  assert.match(step.reason, /ACE-Step v1\.5 XL/);
  assert.equal(PR.resolveContext({ modelId: 'acemusic-v1', mode: 'idea' }).status, 'no_dictionary');
  assert.equal(PR.resolveContext({ modelId: 'mystery-model', mode: 'idea' }).status, 'unknown_model');
  assert.equal(PR.resolveContext({ modelId: 'acemusic-v1.1', mode: 'cover' }).status, 'bad_mode');
});

test('resolveContext：站點即時 limits 優先於後備值', () => {
  const site = new Map([['acemusic-v1.1', { name: 'ACE Music v1.1 Preview', limits: { prompt: 1500, style: 900, lyrics: 4000 } }]]);
  const c = PR.resolveContext({ modelId: 'acemusic-v1.1', mode: 'custom', siteModels: site });
  assert.equal(c.limit, 900);
  assert.equal(c.limitSource, 'site');
});

test('144 格全部可編譯：長度 ≤ 1000、固定約束都在、彼此不重複', () => {
  const d = dict();
  const seen = new Set();
  for (const a of d.axis_a) {
    for (const b of d.axis_b) {
      const r = PR.compile(d, a.id, b.id, 1000);
      assert.equal(r.ok, true, `${a.id}_${b.id}: ${r.reason}`);
      assert.ok(r.length <= 1000);
      seen.add(r.text);
    }
  }
  assert.equal(seen.size, 144);
});

test('放不下就回報，不硬截斷（ACE-Step 的 512 上限）', () => {
  const r = PR.compile(dict(), 'A01', 'B01', 512);
  assert.equal(r.ok, false);
  assert.match(r.reason, /不硬截斷/);
  assert.equal(r.text, undefined);
});

test('randomPrompt：同 seed 復現；含追溯欄位；不同 seed 通常不同', () => {
  const o = { modelId: 'acemusic-v1.1', mode: 'custom', seed: 12345 };
  const a = PR.randomPrompt(o);
  const b = PR.randomPrompt(o);
  assert.equal(a.ok, true);
  assert.equal(a.text, b.text);
  assert.equal(a.cell, b.cell);
  assert.equal(a.seed, 12345);
  assert.equal(a.field, 'style');
  assert.equal(a.dictionary, 'ace-v11-cover-dark-body-20261116');
  assert.equal(a.dictionaryVersion, '1.0.0');
  assert.ok(a.length <= a.limit);
  const cells = new Set(Array.from({ length: 40 }, (_, i) => PR.randomPrompt({ ...o, seed: i + 1 }).cell));
  assert.ok(cells.size > 10, '40 個 seed 應該抽到很多不同格子：' + cells.size);
});

test('權重 0 的詞永不抽中；權重高的更常被抽中', () => {
  const weightsA = Object.fromEntries(dict().axis_a.map((x) => [x.id, x.id === 'A03' ? 0 : 50]));
  for (let i = 1; i <= 300; i += 1) {
    const r = PR.randomPrompt({ modelId: 'acemusic-v1.1', mode: 'idea', seed: i, weightsA });
    assert.notEqual(r.a.id, 'A03');
  }
  const heavy = { A01: 1000 };
  let a01 = 0;
  for (let i = 1; i <= 300; i += 1) if (PR.randomPrompt({ modelId: 'acemusic-v1.1', mode: 'idea', seed: i, weightsA: { ...Object.fromEntries(dict().axis_a.map((x) => [x.id, 1])), ...heavy } }).a.id === 'A01') a01 += 1;
  assert.ok(a01 > 200, '權重 1000 vs 1 的 A01 應該佔絕大多數：' + a01);
});

test('鎖軸：lockA 固定 A、只變 B；權重全 0 → empty_pool', () => {
  const picks = new Set();
  for (let i = 1; i <= 60; i += 1) {
    const r = PR.randomPrompt({ modelId: 'acemusic-v1.1', mode: 'custom', seed: i, lockA: 'A07' });
    assert.equal(r.a.id, 'A07');
    picks.add(r.b.id);
  }
  assert.ok(picks.size > 3);
  const zero = Object.fromEntries(dict().axis_b.map((x) => [x.id, 0]));
  const r = PR.randomPrompt({ modelId: 'acemusic-v1.1', mode: 'custom', seed: 1, weightsB: zero });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'empty_pool');
});

test('非 ready 的模型：randomPrompt 不產出文字', () => {
  const r = PR.randomPrompt({ modelId: 'ace-step-1.5-xl', mode: 'custom', seed: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'no_dictionary');
  assert.equal(r.text, undefined);
});

test('randomBatch：6 組彼此不同的格子，可復現', () => {
  const a = PR.randomBatch({ modelId: 'acemusic-v1.1', mode: 'custom', seed: 99 }, 6);
  const b = PR.randomBatch({ modelId: 'acemusic-v1.1', mode: 'custom', seed: 99 }, 6);
  assert.equal(a.length, 6);
  assert.equal(new Set(a.map((x) => x.cell)).size, 6);
  assert.deepEqual(Array.from(a, (x) => x.cell), Array.from(b, (x) => x.cell));
});

test('agent：ACE.randomPrompt 沒有登入／離線時用後備上限，仍區分模型', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const ACE = await import('../../agent/lib/ace.mjs');
  const { config } = await import('../../agent/lib/config.mjs');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-rp-'));
  const cfg = { ...config(), stateDir: path.join(base, 'state'), downloadDir: path.join(base, 'dl'), sessionFile: path.join(base, 'state', 'session.json') };
  const ok = await ACE.randomPrompt(cfg, { model: 'acemusic-v1.1', mode: 'idea', count: 3, seed: 11 });
  assert.equal(ok.ok, true);
  assert.equal(ok.limitsFrom, 'fallback');
  assert.equal(ok.prompts.length, 3);
  assert.ok(ok.prompts.every((p) => p.field === 'prompt' && p.limit === 2000 && p.length <= 2000));
  const step = await ACE.randomPrompt(cfg, { model: 'ace-step-1.5-xl', mode: 'custom' });
  assert.equal(step.ok, false);
  assert.equal(step.prompts[0].status, 'no_dictionary');
  assert.equal(step.prompts[0].text, undefined);
});
