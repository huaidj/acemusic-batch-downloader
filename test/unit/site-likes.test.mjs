import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectSiteLikes, syncSiteLikes, readSiteLikes, siteLikesView, siteRating, siteLikesFile } from '../../agent/lib/site-likes.mjs';
import { syncSiteLikesFromSite } from '../../agent/lib/ace.mjs';

const song = (id, rating, extra = {}) => ({ task_id: id, status: 'succeeded', model: 'acemusic-v1.1', created_at: Number(id.replace(/\D/g, '')) || 1, meta: { title: 'T ' + id, ...(rating === undefined ? {} : { rating }) }, ...extra });

function pager(pages) {
  const calls = [];
  const fetchPage = async (after) => {
    calls.push(after);
    const index = after ? Number(after.slice(1)) : 0;
    const page = pages[index];
    if (page instanceof Error) throw page;
    if (typeof page === 'number') return { status: page, data: null };
    return { status: 200, data: { items: page.items, next: page.next ?? (index + 1 < pages.length ? 'p' + (index + 1) : '') } };
  };
  return { fetchPage, calls };
}

function sandbox(t) {
  const base = process.platform === 'win32' && fs.existsSync('F:\\DevData\\Temp') ? 'F:\\DevData\\Temp' : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'site-likes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { stateDir: dir };
}

test('site rating follows the site frontend: good=liked, bad=disliked, anything else unrated', () => {
  assert.equal(siteRating(song('s1', 'good')), 'liked');
  assert.equal(siteRating(song('s2', 'bad')), 'disliked');
  assert.equal(siteRating(song('s3', null)), 'unrated');
  assert.equal(siteRating(song('s4')), 'unrated');
  assert.equal(siteRating(song('s5', 'GOOD')), 'unrated');
});

test('collects liked songs across every page, including the oldest page, deduplicated by task id', async () => {
  const { fetchPage, calls } = pager([
    { items: [song('s9', 'good'), song('s8', 'bad'), song('s7')] },
    { items: [song('s6', null), song('s5', 'good'), song('s9', 'good')] },
    { items: [song('s1', 'good')] },
  ]);
  const result = await collectSiteLikes(fetchPage);
  assert.deepEqual(calls, ['', 'p1', 'p2']);
  assert.deepEqual(result.likes.map((item) => item.task_id), ['s9', 's5', 's1']);
  assert.equal(result.pages, 3);
  assert.equal(result.scanned, 6);
  assert.equal(result.disliked, 1);
  assert.deepEqual(Object.keys(result.likes[0]).sort(), ['created_at', 'model', 'task_id', 'title']);
});

test('an empty page that still has a cursor is followed instead of ending the scan early', async () => {
  const { fetchPage, calls } = pager([{ items: [], next: 'p1' }, { items: [song('s1', 'good')] }]);
  const result = await collectSiteLikes(fetchPage);
  assert.deepEqual(calls, ['', 'p1']);
  assert.deepEqual(result.likes.map((item) => item.task_id), ['s1']);
});

test('a site response with zero songs cannot wipe existing likes', async (t) => {
  const cfg = sandbox(t);
  await syncSiteLikes(cfg, pager([{ items: [song('s1', 'good')] }]).fetchPage);
  const result = await syncSiteLikes(cfg, pager([{ items: [] }]).fetchPage);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY_LIBRARY');
  assert.equal(result.count, 1);
});

test('auth failure, HTTP error, malformed page, repeated cursor and page limit are all incomplete', async () => {
  await assert.rejects(collectSiteLikes(pager([{ items: [song('s1', 'good')] }, 401]).fetchPage), { code: 'AUTH_EXPIRED' });
  await assert.rejects(collectSiteLikes(pager([{ items: [song('s1', 'good')] }, 502]).fetchPage), { code: 'HTTP_ERROR' });
  await assert.rejects(collectSiteLikes(async () => ({ status: 200, data: { nope: true } })), { code: 'BAD_RESPONSE' });
  await assert.rejects(collectSiteLikes(async () => ({ status: 200, data: { items: [song('s1', 'good')], next: 'same' } })), { code: 'CURSOR_LOOP' });
  let n = 0;
  await assert.rejects(collectSiteLikes(async () => ({ status: 200, data: { items: [song('s1')], next: 'c' + (n++) } }), { maxPages: 3 }), { code: 'PAGE_LIMIT' });
});

test('an empty but complete account is a real zero, distinct from never synced', async (t) => {
  const cfg = sandbox(t);
  assert.equal(siteLikesView(await readSiteLikes(cfg)).synced, false);
  const result = await syncSiteLikes(cfg, pager([{ items: [song('s1'), song('s2', 'bad')] }]).fetchPage);
  assert.equal(result.ok, true);
  assert.equal(result.synced, true);
  assert.equal(result.complete, true);
  assert.equal(result.count, 0);
});

test('a failed sync keeps the last complete likes and records why, never clearing them', async (t) => {
  const cfg = sandbox(t);
  const first = await syncSiteLikes(cfg, pager([{ items: [song('s3', 'good')] }, { items: [song('s2', 'good')] }]).fetchPage);
  assert.equal(first.count, 2);
  assert.equal(first.changed, true);
  const failed = await syncSiteLikes(cfg, pager([{ items: [] , next: 'p1' }, 401]).fetchPage);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'AUTH_EXPIRED');
  assert.deepEqual(failed.likes.map((item) => item.task_id), ['s3', 's2']);
  const stored = await readSiteLikes(cfg);
  assert.equal(stored.revision, first.revision);
  assert.equal(stored.fetchedAt, first.fetchedAt);
  assert.equal(stored.lastAttempt.ok, false);
  const thrown = await syncSiteLikes(cfg, async () => { throw new Error('network down'); });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.count, 2);
});

test('a failure before any success is reported as not synced instead of zero likes', async (t) => {
  const cfg = sandbox(t);
  const result = await syncSiteLikes(cfg, pager([503]).fetchPage);
  assert.equal(result.ok, false);
  assert.equal(result.synced, false);
  assert.equal(result.lastAttempt.code, 'HTTP_ERROR');
});

test('repeat syncs are idempotent and only report changed when the liked set changes', async (t) => {
  const cfg = sandbox(t);
  const pages = [{ items: [song('s2', 'good'), song('s1')] }];
  const a = await syncSiteLikes(cfg, pager(pages).fetchPage);
  const b = await syncSiteLikes(cfg, pager(pages).fetchPage);
  assert.equal(a.revision, b.revision);
  assert.equal(b.changed, false);
  const c = await syncSiteLikes(cfg, pager([{ items: [song('s2', 'good'), song('s1', 'good')] }]).fetchPage);
  assert.equal(c.changed, true);
  assert.notEqual(c.revision, a.revision);
});

test('an unreadable snapshot is preserved instead of being overwritten', async (t) => {
  const cfg = sandbox(t);
  await fsp.writeFile(siteLikesFile(cfg), '{broken');
  const result = await syncSiteLikes(cfg, pager([{ items: [song('s1', 'good')] }]).fetchPage);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_UNREADABLE');
  assert.equal(await fsp.readFile(siteLikesFile(cfg), 'utf8'), '{broken');
});

test('site sync only issues GET requests, sends the session cookie only to the site origin, and never writes ratings', async (t) => {
  const dir = sandbox(t).stateDir;
  const cfg = { stateDir: dir, sessionFile: path.join(dir, 'session.json'), baseUrl: 'https://acemusic.ai', ua: 'fixture' };
  fs.writeFileSync(cfg.sessionFile, JSON.stringify({ cookie: 'isolated=fixture', savedAt: new Date().toISOString() }));
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ origin: target.origin, path: target.pathname, method: options.method || 'GET', cookie: options.headers?.get?.('Cookie') || null, after: target.searchParams.get('after') });
    const after = target.searchParams.get('after');
    const body = after ? { items: [song('s1', 'good')], next: '' } : { items: [song('s2', 'good'), song('s3', 'bad')], next: 'cursor-1' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const result = await syncSiteLikesFromSite(cfg);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.likes.map((item) => item.task_id), ['s2', 's1']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.method === 'GET' && call.path === '/api/songs' && call.origin === 'https://acemusic.ai' && call.cookie === 'isolated=fixture'));
  assert.deepEqual(calls.map((call) => call.after), [null, 'cursor-1']);
});

test('missing session is a recorded failure, not an empty like list', async (t) => {
  const dir = sandbox(t).stateDir;
  const cfg = { stateDir: dir, sessionFile: path.join(dir, 'absent-session.json'), baseUrl: 'https://acemusic.ai', ua: 'fixture' };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not reach network without a session'); };
  t.after(() => { globalThis.fetch = original; });
  const result = await syncSiteLikesFromSite(cfg);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_SESSION');
  assert.equal(result.synced, false);
});
