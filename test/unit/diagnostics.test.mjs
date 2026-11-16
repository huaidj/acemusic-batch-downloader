import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../../src/diagnostics.js', import.meta.url), 'utf8'), context);
const D = context.AceDLDiagnostics;

test('diagnostics redacts URLs, credentials and secret-looking values without reading sessions', () => {
  const cleaned = D.redact('GET https://example.test/a?token=private token=secret-value ghp_abcdefghijklmnop cookie: session=hidden; more=hidden');
  assert.ok(!/example|private|secret-value|abcdefghijklmnop|hidden/.test(cleaned));
  assert.match(cleaned, /\[url\]/);
  const record = D.sanitizeEvent({ event: 'prep_error', error: 'Authorization: Bearer hidden', cookie: 'never-copy', url: 'https://private.test', counts: { done: 2, token: 'hidden' } });
  assert.equal(record.cookie, undefined);
  assert.equal(record.url, undefined);
  assert.equal(record.counts.token, undefined);
  assert.equal(record.counts.done, 2);
  assert.match(record.at, /Z$/);
});

test('diagnostics ring is bounded and reloads sanitized sessionStorage after invalidation', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  const logger = D.createLogger({ storage, now: () => 1794826800000 });
  for (let i = 0; i < 250; i++) logger.record('heartbeat', { activeDl: i, current: 'x'.repeat(1000) });
  assert.equal(logger.snapshot().events.length, 200);
  assert.equal(logger.snapshot().events[0].activeDl, 50);
  const reloaded = D.createLogger({ storage });
  assert.equal(reloaded.snapshot().events.length, 200);
  assert.equal(reloaded.snapshot().events[0].current.length, 320);
  const bounded = D.sanitizeSnapshot({ events: Array(1000).fill({ event: 'x', error: 'y'.repeat(100000), unknown: 'secret' }) });
  assert.equal(bounded.events.length, 200);
  assert.ok(JSON.stringify(bounded).length < 262144);
  assert.equal(bounded.events[0].unknown, undefined);
  const hugeFields = Object.fromEntries(['taskId', 'kind', 'filename', 'phase', 'errorCode', 'error', 'current'].map(key => [key, '\\'.repeat(10000)]));
  assert.ok(JSON.stringify(D.sanitizeSnapshot({ events: Array(200).fill(hugeFields) })).length <= 240000);
});

test('diagnostics remains usable when sessionStorage is blocked or corrupt', () => {
  const logger = D.createLogger({ storage: { getItem() { return 'bad json'; }, setItem() { throw new Error('blocked'); } } });
  logger.record('context_invalidated', { errorCode: 'EXTENSION_CONTEXT_INVALIDATED' });
  assert.equal(logger.snapshot().events.length, 1);
});
