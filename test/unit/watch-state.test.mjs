import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createWatchStatusWriter, runPipeline } from '../../agent/watch.mjs';
import { appendLog, config } from '../../agent/lib/config.mjs';

const TEMP = process.env.ACE_TEST_TEMP || 'F:/DevData/Temp';
function sandbox() {
  fs.mkdirSync(TEMP, { recursive: true });
  const base = fs.mkdtempSync(path.join(TEMP, 'ace-watch-state-'));
  const stateDir = path.join(base, 'state');
  const cfg = { ...config(), stateDir, downloadDir: path.join(base, 'downloads'), stateFile: path.join(stateDir, 'agent-state.json'), sessionFile: path.join(stateDir, 'session.json'), historyFile: path.join(stateDir, 'history.json'), logFile: path.join(stateDir, 'agent.log') };
  return { base, cfg, file: path.join(stateDir, 'watch-status.json') };
}
const emptyResult = () => ({ total: 0, downloaded: 0, copied: 0, moved: 0, skipped: 0, migrated: 0, removed: 0, savedBytes: 0, analyzed: 0, linked: 0, failed: [], unanalyzable: [] });
function services(overrides = {}) {
  return { listSongs: async () => [{ task_id: 'fixture-song' }], extractFullMp3s: async () => emptyResult(), collectSamples: async () => emptyResult(), classifyByAttributes: async () => emptyResult(), dedupeSongCopies: async () => emptyResult(), classifyByAudio: async () => emptyResult(), ...overrides };
}

test('watch --stop requests a cooperative exit without killing a writer or washing status', async () => {
  const sb = sandbox();
  await fsp.mkdir(sb.cfg.stateDir, {recursive:true});
  const marker = path.join(sb.cfg.stateDir, 'writer-finished');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'safe'),700);`], {windowsHide:true,stdio:'ignore'});
  const exited = once(writer,'exit');
  await fsp.writeFile(sb.file, JSON.stringify({pid:writer.pid,phase:'running',steps:[{name:'fixture'}],error:'preserve evidence'}));
  const cli = fileURLToPath(new URL('../../agent/cli.mjs', import.meta.url));
  const child = spawn(process.execPath,[cli,'watch','--stop','--json'],{windowsHide:true,env:{...process.env,ACE_STATE_DIR:sb.cfg.stateDir,ACE_DOWNLOAD_DIR:sb.cfg.downloadDir}});
  let output=''; child.stdout.on('data',b=>output+=b); child.stderr.resume();
  const [code] = await once(child,'exit');
  assert.equal(code,0);
  assert.equal(JSON.parse(output).stopRequested,true);
  assert.equal(JSON.parse(await fsp.readFile(path.join(sb.cfg.stateDir,'watch-stop.json'),'utf8')).pid,writer.pid);
  assert.equal(JSON.parse(await fsp.readFile(sb.file,'utf8')).error,'preserve evidence');
  await exited;
  assert.equal(await fsp.readFile(marker,'utf8'),'safe');
});

test('watch：pipeline失敗後 heartbeat保留error、steps、lastRunAt，重建writer亦不洗掉最後結果', async () => {
  const sb = sandbox();
  let clock = Date.now();
  const report = createWatchStatusWriter({ file: sb.file, root: path.join(sb.cfg.downloadDir, 'mock'), phase: () => 'idle', now: () => new Date(clock += 5000).toISOString() });
  const result = await runPipeline({ cfg: sb.cfg, rootName: 'mock', reportStatus: report, services: services({ classifyByAttributes: async () => { throw new Error('fixture classification failed'); } }) });
  assert.equal(result.ok, false);
  const failed = JSON.parse(await fsp.readFile(sb.file, 'utf8'));
  assert.equal(failed.error, 'fixture classification failed');
  assert.equal(failed.steps.length, 2);
  assert.equal(failed.lastRun.ok, false);
  assert.equal(failed.lastRunAt, result.finishedAt);
  await report({ lastFingerprint: { files: 1, bytes: 100 } });
  const heartbeat = JSON.parse(await fsp.readFile(sb.file, 'utf8'));
  assert.equal(heartbeat.ok, false, 'idle heartbeat is not a successful pipeline result');
  assert.equal(heartbeat.error, failed.error);
  assert.deepEqual(heartbeat.steps, failed.steps);
  assert.equal(heartbeat.lastRunAt, failed.lastRunAt);
  assert(heartbeat.beatAt > failed.beatAt);
  const restarted = createWatchStatusWriter({ file: sb.file, root: path.join(sb.cfg.downloadDir, 'mock'), phase: () => 'idle' });
  await restarted({ daemonCheck: true });
  const preserved = JSON.parse(await fsp.readFile(sb.file, 'utf8'));
  assert.equal(preserved.error, failed.error);
  assert.equal(preserved.lastRunAt, failed.lastRunAt);
  assert.deepEqual(preserved.lastRun.steps, failed.steps);
});

test('watch：自訂root傳入每個pipeline階段，成品MPEG只落指定root，不落預設ai音樂', async () => {
  const sb = sandbox();
  const customRoot = 'Custom Library';
  const roots = [];
  const record = async (options) => { roots.push(options.root); return emptyResult(); };
  const result = await runPipeline({ cfg: sb.cfg, rootName: customRoot, services: services({
    extractFullMp3s: async ({ root = 'ai音樂', cfg }) => {
      roots.push(root);
      const dir = path.join(cfg.downloadDir, root, '成品MP3');
      await fsp.mkdir(dir, { recursive: true });
      const bytes = Buffer.alloc(417); bytes.set([0xff, 0xfb, 0x90, 0x64]);
      await fsp.writeFile(path.join(dir, 'fixture.mp3'), bytes);
      return { ...emptyResult(), total: 1, downloaded: 1 };
    },
    collectSamples: record, classifyByAttributes: record, dedupeSongCopies: record, classifyByAudio: record,
  }) });
  assert.equal(result.ok, true);
  assert.deepEqual(roots, Array(5).fill(customRoot));
  assert.equal(fs.existsSync(path.join(sb.cfg.downloadDir, customRoot, '成品MP3', 'fixture.mp3')), true);
  assert.equal(fs.existsSync(path.join(sb.cfg.downloadDir, 'ai音樂')), false);
  const stored = JSON.parse(await fsp.readFile(sb.file, 'utf8'));
  assert.equal(stored.lastRun.ok, true);
  assert.equal(stored.root, path.join(sb.cfg.downloadDir, customRoot));
});

test('appendLog：只改stateDir但繼承舊logFile時，舊log雜湊不變，只寫新stateDir', async () => {
  const sb = sandbox();
  const originalState = path.join(sb.base, 'original-state');
  await fsp.mkdir(originalState, { recursive: true });
  const originalLog = path.join(originalState, 'agent.log');
  await fsp.writeFile(originalLog, 'preserve original evidence\n');
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const originalHash = digest(await fsp.readFile(originalLog));
  const originalConfig = { ...config(), stateDir: originalState, logFile: originalLog };
  const sandboxConfig = { ...originalConfig, stateDir: sb.cfg.stateDir };
  await appendLog('isolated-state-only-marker', sandboxConfig);
  assert.equal(digest(await fsp.readFile(originalLog)), originalHash);
  const sandboxLog = await fsp.readFile(path.join(sb.cfg.stateDir, 'agent.log'), 'utf8');
  assert.match(sandboxLog, /isolated-state-only-marker/);
  assert.match(sandboxLog, /^\d{4}-\d\d-\d\dT.*Z /);
  const customLog = path.join(sb.cfg.stateDir, 'custom.log');
  await appendLog('inside-state-dir', { ...sb.cfg, logFile: customLog });
  assert.match(await fsp.readFile(customLog, 'utf8'), /inside-state-dir/);
});
