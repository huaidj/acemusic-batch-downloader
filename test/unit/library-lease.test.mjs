import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withLibraryWriteLease } from '../../agent/lib/library-lease.mjs';

const moduleUrl = new URL('../../agent/lib/library-lease.mjs', import.meta.url).href;
const childSource = `import fs from 'node:fs/promises';import path from 'node:path';import {withLibraryWriteLease} from ${JSON.stringify(moduleUrl)};const cfg={stateDir:process.argv[1]};await withLibraryWriteLease(cfg,async()=>{const f=path.join(cfg.stateDir,'result.json');let rows=[];try{rows=JSON.parse(await fs.readFile(f,'utf8'))}catch{};await new Promise(r=>setTimeout(r,80));rows.push(process.argv[2]);await fs.writeFile(f,JSON.stringify(rows));});`;
function run(dir, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, dir, value], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(child.pid) : reject(new Error(stderr)));
  });
}

test('library mutation lease serializes independent CLI processes without losing either update', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ace-library-process-'));
  await Promise.all([run(dir, 'a'), run(dir, 'b')]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8')).sort(), ['a', 'b']);
  await assert.rejects(fs.stat(path.join(dir, 'library-write.lock')), { code: 'ENOENT' });
});

test('library lease recovers a confirmed dead owner but cancellation does not remove a live owner lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ace-library-stale-'));
  const deadPid = await run(dir, 'finished');
  const file = path.join(dir, 'library-write.lock');
  await fs.writeFile(file, JSON.stringify({ pid: deadPid, token: 'dead-owner-proof' }));
  assert.equal(await withLibraryWriteLease({ stateDir: dir }, async () => true), true);
  const active = JSON.stringify({ pid: process.pid, token: 'another-live-owner' });
  await fs.writeFile(file, active);
  await assert.rejects(withLibraryWriteLease({ stateDir: dir }, async () => false, { isCancelled: () => true }), { code: 'JOB_CANCELLED' });
  assert.equal(await fs.readFile(file, 'utf8'), active);
});
