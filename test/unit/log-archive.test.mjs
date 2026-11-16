import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDownloadLog } from '../../agent/lib/log-archive.mjs';

test('download log archive keeps every event across ring rollovers without duplicates', async (t) => {
  const stateDir = fs.mkdtempSync(path.join((process.env.ACE_TEST_TEMP || os.tmpdir()), 'log-archive-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const cfg = { stateDir };
  const ev = (n, day = '2026-11-16') => ({ at: new Date(Date.parse(day + 'T10:00:00Z') + n * 1000).toISOString(), event: 'download_start', filename: `f${n}.mp3` });
  const write = (events) => fs.writeFileSync(path.join(stateDir, 'download-log.json'), JSON.stringify({ schema: 'ace-download-diagnostics-v1', events }));
  const ring = Array.from({ length: 200 }, (_, i) => ev(i));
  write(ring);
  assert.equal((await archiveDownloadLog(cfg)).appended, 200);
  assert.equal((await archiveDownloadLog(cfg)).appended, 0, 'idempotent');
  // ring rolls: oldest 50 drop out, 50 new arrive (one on the next day)
  const next = [...ring.slice(50), ...Array.from({ length: 49 }, (_, i) => ev(200 + i)), ev(999, '2026-11-17')];
  write(next);
  assert.equal((await archiveDownloadLog(cfg)).appended, 50);
  const lines = (day) => fs.readFileSync(path.join(stateDir, 'logs', `download-log-${day}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const all = [...lines('2026-11-16'), ...lines('2026-11-17')];
  assert.equal(all.length, 250);
  assert.equal(new Set(all.map((e) => e.filename)).size, 250);
  assert.equal((await archiveDownloadLog({ stateDir: path.join(stateDir, 'missing') })).appended, 0);
});
