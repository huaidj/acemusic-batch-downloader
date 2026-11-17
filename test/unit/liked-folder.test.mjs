import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLikedSongs, nameWithDeepSeek, assignBases, LIKED_MAP_FILE, UNLIKED_DIR } from '../../agent/lib/liked-folder.mjs';
import { isCopyFolderName, COPY_FOLDERS } from '../../agent/lib/copy-folders.mjs';

function sandbox(t, likedIds, { complete = true } = {}) {
  const base = fs.mkdtempSync(path.join(process.env.ACE_TEST_TEMP || os.tmpdir(), 'liked-folder-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cfg = { stateDir: path.join(base, 'state'), downloadDir: path.join(base, 'downloads') };
  const root = path.join(cfg.downloadDir, 'ai音樂');
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.mkdirSync(path.join(root, '成品MP3'), { recursive: true });
  fs.mkdirSync(path.join(root, '成品WAV'), { recursive: true });
  const writeLikes = (ids, ok = complete) => fs.writeFileSync(path.join(cfg.stateDir, 'site-likes.json'), JSON.stringify({ schema: 'ace_site_likes_v1', complete: ok, fetchedAt: ok ? new Date().toISOString() : null, revision: 'r', likes: ids.map((id) => ({ task_id: id, title: 'Title ' + id })) }));
  writeLikes(likedIds);
  const files = {};
  const audio = (id, kind, marker) => { const file = path.join(root, kind === 'mp3' ? '成品MP3' : '成品WAV', `Title ${id}.${kind}`); fs.writeFileSync(file, Buffer.from(`${kind}-${id}-${marker}`)); (files[id] ||= []).push({ kind, absolute: file, confidence: 'verified', validity: 'valid' }); return file; };
  const index = () => ({ byTask: Object.fromEntries(Object.entries(files).map(([id, list]) => [id, { files: list }])) });
  const songs = (ids) => ids.map((id, i) => ({ task_id: id, created_at: i + 1, meta: { title: 'Title ' + id, prompt: 'dark ritual techno ' + id } }));
  return { cfg, root, outDir: path.join(root, '已點讚'), audio, index, songs, writeLikes };
}

const deepseek = ({ fail = false, lose = false } = {}) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, auth: options.headers.Authorization });
    if (lose) throw new Error('socket hang up');
    if (fail) return new Response(JSON.stringify({ error: 'no' }), { status: 500 });
    const songs = JSON.parse(body.messages[1].content).songs;
    const names = songs.map((s) => ({ id: s.id, zh: '幽' + s.id, en: 'Echo ' + s.id }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ names }) } }], usage: { prompt_tokens: 300, completion_tokens: 40, prompt_cache_miss_tokens: 300, prompt_cache_hit_tokens: 0 } }), { status: 200 });
  };
  return { fetchImpl, calls };
};

test('the liked folder is a copy folder everywhere: index, dedupe and classification skip it', () => {
  assert.ok(COPY_FOLDERS.includes('已點讚'));
  assert.ok(isCopyFolderName('已點讚') && isCopyFolderName('收藏') && isCopyFolderName('整理輸出'));
  assert.equal(isCopyFolderName('成品MP3'), false);
});

test('liked songs: final MP3/WAV are copied under DeepSeek names, originals untouched, cost recorded', async (t) => {
  const s = sandbox(t, ['so_a', 'so_b']);
  const mp3 = s.audio('so_a', 'mp3', 1); s.audio('so_a', 'wav', 1); s.audio('so_b', 'mp3', 2);
  const ds = deepseek();
  const r = await collectLikedSongs({ cfg: s.cfg, apiKey: 'test-key', fetchImpl: ds.fetchImpl, index: s.index(), songs: s.songs(['so_a', 'so_b']) });
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(r.aiNamed, 2);
  assert.equal(r.copied, 3);
  assert.deepEqual(fs.readdirSync(s.outDir).filter((n) => !n.startsWith('_')).sort(), ['幽n1 - Echo n1.mp3', '幽n1 - Echo n1.wav', '幽n2 - Echo n2.mp3']);
  assert.ok(fs.existsSync(mp3), 'original stays in place');
  assert.equal(ds.calls.length, 1, 'one batched call');
  assert.equal(ds.calls[0].body.thinking.type, 'disabled');
  assert.equal(ds.calls[0].auth, 'Bearer test-key');
  assert.ok(!JSON.stringify(ds.calls[0].body).includes('test-key'), 'the key never enters the request body');
  const map = JSON.parse(fs.readFileSync(path.join(s.outDir, LIKED_MAP_FILE), 'utf8'));
  assert.ok(map.spent_usd > 0 && map.spent_usd < 0.001, 'actual token cost recorded: ' + map.spent_usd);
  assert.equal(map.items.so_a.source, 'deepseek');
  // a re-run never pays again and copies nothing new
  const again = await collectLikedSongs({ cfg: s.cfg, apiKey: 'test-key', fetchImpl: ds.fetchImpl, index: s.index(), songs: s.songs(['so_a', 'so_b']) });
  assert.equal(ds.calls.length, 1, 'names are reused');
  assert.equal(again.copied, 0);
  assert.equal(again.already, 3);
});

test('liked songs: the budget cap stops DeepSeek before spending; names fall back to the site title', async (t) => {
  const s = sandbox(t, ['so_a']);
  s.audio('so_a', 'mp3', 1);
  const ds = deepseek();
  const r = await collectLikedSongs({ cfg: s.cfg, apiKey: 'k', fetchImpl: ds.fetchImpl, index: s.index(), songs: s.songs(['so_a']), capUsd: 0.0000001 });
  assert.equal(ds.calls.length, 0, 'no request when the worst case would exceed the cap');
  assert.equal(r.aiStopped, 'budget_cap');
  assert.equal(r.titleNamed, 1);
  assert.ok(fs.existsSync(path.join(s.outDir, 'Title so_a.mp3')));
});

test('liked songs: no API key copies under site titles; later AI names rename our own untouched copies', async (t) => {
  const s = sandbox(t, ['so_a']);
  s.audio('so_a', 'mp3', 1);
  const first = await collectLikedSongs({ cfg: s.cfg, apiKey: '', index: s.index(), songs: s.songs(['so_a']) });
  assert.equal(first.aiStopped, 'no_api_key');
  assert.ok(fs.existsSync(path.join(s.outDir, 'Title so_a.mp3')));
  const ds = deepseek();
  const second = await collectLikedSongs({ cfg: s.cfg, apiKey: 'k', fetchImpl: ds.fetchImpl, index: s.index(), songs: s.songs(['so_a']) });
  assert.equal(second.renamed, 1);
  assert.ok(fs.existsSync(path.join(s.outDir, '幽n1 - Echo n1.mp3')) && !fs.existsSync(path.join(s.outDir, 'Title so_a.mp3')));
});

test('liked songs: an unknown outcome is charged at the reservation and not retried in the same run', async (t) => {
  const s = sandbox(t, ['so_a']);
  s.audio('so_a', 'mp3', 1);
  const ds = deepseek({ lose: true });
  const r = await collectLikedSongs({ cfg: s.cfg, apiKey: 'k', fetchImpl: ds.fetchImpl, index: s.index(), songs: s.songs(['so_a']) });
  assert.equal(r.aiStopped, 'outcome_unknown');
  assert.equal(ds.calls.length, 1);
  const map = JSON.parse(fs.readFileSync(path.join(s.outDir, LIKED_MAP_FILE), 'utf8'));
  assert.ok(map.spent_usd > 0, 'reserved amount counted as spent');
  assert.equal(map.calls[0].state, 'outcome_unknown');
});

test('liked songs: un-liked songs move to the archive subfolder, never deleted; user-edited copies stay', async (t) => {
  const s = sandbox(t, ['so_a', 'so_b']);
  s.audio('so_a', 'mp3', 1); s.audio('so_b', 'mp3', 2);
  await collectLikedSongs({ cfg: s.cfg, apiKey: '', index: s.index(), songs: s.songs(['so_a', 'so_b']) });
  fs.appendFileSync(path.join(s.outDir, 'Title so_b.mp3'), 'user edit');
  s.writeLikes([]);
  const r = await collectLikedSongs({ cfg: s.cfg, apiKey: '', index: s.index(), songs: s.songs(['so_a', 'so_b']) });
  assert.equal(r.unlikedMoved, 1);
  assert.ok(fs.existsSync(path.join(s.outDir, UNLIKED_DIR, 'Title so_a.mp3')), 'our copy archived, not deleted');
  assert.ok(fs.existsSync(path.join(s.outDir, 'Title so_b.mp3')), 'a user-edited copy is left alone');
});

test('liked songs: an incomplete likes snapshot is refused so nothing is mistaken for un-liked', async (t) => {
  const s = sandbox(t, ['so_a'], { complete: false });
  const r = await collectLikedSongs({ cfg: s.cfg, apiKey: '', index: { byTask: {} }, songs: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /完整同步/);
});

test('liked songs: dry run estimates cost and lists names without calling DeepSeek or writing', async (t) => {
  const s = sandbox(t, ['so_a']);
  s.audio('so_a', 'mp3', 1);
  const ds = deepseek();
  const r = await collectLikedSongs({ cfg: s.cfg, dryRun: true, apiKey: 'k', fetchImpl: ds.fetchImpl, index: s.index(), songs: s.songs(['so_a']) });
  assert.equal(ds.calls.length, 0);
  assert.equal(r.needsNaming, 1);
  assert.ok(r.estimatedUsd > 0);
  assert.equal(fs.existsSync(s.outDir), false);
});

test('assignBases makes names unique without colliding with each other', () => {
  const out = assignBases([['a', 'Echo'], ['b', 'echo'], ['c', 'Echo']]);
  assert.deepEqual([...out.values()], ['Echo', 'echo (2)', 'Echo (3)']);
});

test('nameWithDeepSeek ignores malformed or unknown ids instead of misassigning names', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ names: [{ id: 'n9', zh: 'x', en: 'y' }, { id: 'n1', zh: '', en: 'only en' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  const ledger = { spent_usd: 0, calls: [] };
  const r = await nameWithDeepSeek([{ taskId: 'so_a', title: 't', style: 's' }], { apiKey: 'k', fetchImpl, ledger, capUsd: 1 });
  assert.equal(r.names.size, 0);
  assert.equal(ledger.calls[0].named, 0);
});

test('parseNames tolerates code fences, surrounding text, bare arrays and other id styles', async () => {
  const { parseNames } = await import('../../agent/lib/liked-folder.mjs');
  assert.equal(parseNames('```json\n{"names":[{"id":"n1","zh":"幽","en":"A"}]}\n```').length, 1);
  assert.equal(parseNames('Here you go: {"names":[{"id":"1","zh":"幽","en":"A"}]} done').length, 1);
  assert.equal(parseNames('[{"id":"N2","zh":"幽","en":"A"}]').length, 1);
  assert.deepEqual(parseNames('not json at all'), []);
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"names":[{"id":"1","zh":"幽石","en":"Stone"},{"id":"N2","zh":"暗流","en":"Undertow"}]}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  const ledger = { spent_usd: 0, calls: [] };
  const r = await nameWithDeepSeek([{ taskId: 'so_a', title: 'a', style: '' }, { taskId: 'so_b', title: 'b', style: '' }], { apiKey: 'k', fetchImpl, ledger, capUsd: 1 });
  assert.deepEqual(r.names.get('so_a'), { zh: '幽石', en: 'Stone' });
  assert.deepEqual(r.names.get('so_b'), { zh: '暗流', en: 'Undertow' });
  const bad = { spent_usd: 0, calls: [] };
  await nameWithDeepSeek([{ taskId: 'so_a', title: 'a', style: '' }], { apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'sorry' } }], usage: {} }), { status: 200 }), ledger: bad, capUsd: 1 });
  assert.equal(bad.calls[0].unparsed_excerpt, 'sorry', 'an unparsable reply is kept for diagnosis');
});
