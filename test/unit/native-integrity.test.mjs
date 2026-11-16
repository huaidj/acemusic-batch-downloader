import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const supported = process.platform === 'win32' && fs.existsSync(compiler);
const base = supported ? fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-native-integrity-')) : '';
const executable = path.join(base, 'host.exe');
const source = fileURLToPath(new URL('../../native/host.cs', import.meta.url));
if (supported) {
  const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${executable}`, '/r:System.Web.Extensions.dll', source], { windowsHide: true, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
}

function request(root, moves, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: true, env: { ...process.env, ACE_DOWNLOAD_DIR: root, ACE_STATE_DIR: options.stateDir || path.join(base, 'state'), ...(options.env || {}) } });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      try {
        assert.equal(code, 0);
        const bytes = Buffer.concat(chunks);
        assert.ok(bytes.length >= 4);
        resolve(JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString('utf8')));
      } catch (error) { reject(error); }
    });
    const body = Buffer.from(JSON.stringify(options.payload || { cmd: 'move', moves }));
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([prefix, body]));
  });
}

test('native move preserves equal-size different audio instead of deleting it', { skip: !supported }, async () => {
  const root = path.join(base, 'different'); fs.mkdirSync(root);
  const from = path.join(root, 'new.mp3'), to = path.join(root, 'song.mp3');
  fs.writeFileSync(from, 'take-B'); fs.writeFileSync(to, 'take-A');
  const result = await request(root, [{ from, to }]);
  assert.equal(result.movedCount, 1); assert.equal(result.dedupedCount, 0);
  assert.equal(fs.readFileSync(to, 'utf8'), 'take-A');
  assert.equal(fs.readFileSync(result.moved[0].to, 'utf8'), 'take-B');
  assert.notEqual(result.moved[0].to, to);
});

test('native move deduplicates only byte-identical disposable test files', { skip: !supported }, async () => {
  const root = path.join(base, 'identical'); fs.mkdirSync(root);
  const from = path.join(root, 'copy.wav'), to = path.join(root, 'song.wav');
  fs.writeFileSync(from, 'same-audio'); fs.writeFileSync(to, 'same-audio');
  const result = await request(root, [{ from, to }]);
  assert.equal(result.dedupedCount, 1); assert.equal(result.movedCount, 0);
  assert.equal(fs.readFileSync(to, 'utf8'), 'same-audio');
  assert.equal(fs.existsSync(from), false);
  const backup=result.deduped[0].backup;
  assert.equal(fs.readFileSync(backup,'utf8'),'same-audio');
  let batch=path.dirname(backup);
  while(!fs.existsSync(path.join(batch,'_operation.json'))) batch=path.dirname(batch);
  const metadata=JSON.parse(fs.readFileSync(path.join(batch,'_operation.json'),'utf8'));
  assert.equal(metadata.from,from);
  assert.ok(metadata.sha256&&metadata.retention);
});

test('native move rejects a directory junction escaping Downloads', { skip: !supported }, async () => {
  const root=path.join(base,'junction-root'),outside=path.join(base,'junction-outside');fs.mkdirSync(root);fs.mkdirSync(outside);
  const original=path.join(outside,'original.wav');fs.writeFileSync(original,'unique original');
  fs.symlinkSync(outside,path.join(root,'linked'),'junction');
  const result=await request(root,[{from:path.join(root,'linked','original.wav'),to:path.join(root,'moved.wav')}]);
  assert.equal(result.failedCount,1);
  assert.equal(fs.readFileSync(original,'utf8'),'unique original');
});

test('native move rejects a sibling outside the configured library root', { skip: !supported }, async () => {
  const root = path.join(base, 'restricted'); fs.mkdirSync(root);
  const from = path.join(base, 'outside.wav'), to = path.join(root, 'song.wav');
  fs.writeFileSync(from, 'original');
  const result = await request(root, [{ from, to }]);
  assert.equal(result.failedCount, 1);
  assert.equal(fs.readFileSync(from, 'utf8'), 'original');
  assert.equal(fs.existsSync(to), false);
});

test('native history exports preserve older records and update matching identities atomically', { skip: !supported }, async () => {
  const root = path.join(base, 'history-root'), stateDir = path.join(base, 'history-state');
  fs.mkdirSync(root); fs.mkdirSync(stateDir);
  const item = (id, state = 'complete') => ({ id, startTime: '2026-11-16T00:00:00Z', url: `https://acemusic.ai/data/${id}.wav`, state });
  for (const items of [[item(1, 'in_progress')], [item(2)], [item(1)]]) {
    const result = await request(root, [], { stateDir, payload: { cmd: 'export', name: 'history', data: { savedAt: Date.now(), items } } });
    assert.equal(result.ok, true);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'history.json'), 'utf8'));
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items.find((row) => row.id === 1).state, 'complete');
});

test('native malformed history never replaces the existing evidence', { skip: !supported }, async () => {
  const root = path.join(base, 'malformed-root'), stateDir = path.join(base, 'malformed-state');
  fs.mkdirSync(root); fs.mkdirSync(stateDir);
  const evidence = '{"items":[{"id":1}],"privateOriginal":true}';
  fs.writeFileSync(path.join(stateDir, 'history.json'), evidence);
  const result = await request(root, [], { stateDir, payload: { cmd: 'export', name: 'history', data: { items: 'bad' } } });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(stateDir, 'history.json'), 'utf8'), evidence);
});

test('native timeout reports an unknown result and preserves the submitted child writer', { skip: !supported }, async () => {
  const root = path.join(base, 'timeout-root'), stateDir = path.join(base, 'timeout-state');
  fs.mkdirSync(root); fs.mkdirSync(path.join(stateDir, 'agent'), {recursive:true});
  const marker = path.join(stateDir, 'completed.json');
  fs.writeFileSync(path.join(stateDir, 'agent', 'cli.mjs'), `import fs from 'node:fs'; setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)}, 'finished safely');},450);`);
  const result = await request(root, [], { stateDir, env:{ACE_NATIVE_TIMEOUT_MS:'100'}, payload:{cmd:'organize',commit:true,reqId:'timeout-fixture'} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SUBMISSION_UNKNOWN');
  assert.equal(result.reqId, 'timeout-fixture');
  assert.ok(result.pid > 0);
  const deadline = Date.now()+5000;
  while(!fs.existsSync(marker) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(fs.readFileSync(marker,'utf8'),'finished safely');
});

test('native oversized output returns a bounded error with the original request identity', { skip: !supported }, async () => {
  const root = path.join(base,'large-root'), stateDir = path.join(base,'large-state');
  fs.mkdirSync(root); fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir,'page-songs.json'), JSON.stringify({songs:[{title:'x'.repeat(1100000)}]}));
  const result = await request(root,[],{stateDir,payload:{cmd:'read',name:'page-songs',reqId:44}});
  assert.equal(result.ok,false);
  assert.equal(result.code,'NATIVE_FRAME_TOO_LARGE');
  assert.equal(result.reqId,44);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<1000);
});
