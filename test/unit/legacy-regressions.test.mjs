import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMixdeskServer } from '../../mixdesk/server.mjs';
import { request as mixRequest } from '../../mixdesk/mcp.mjs';
import { benchMcp } from '../../scripts/bench.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP = process.env.ACE_TEST_TEMP || 'F:/DevData/Temp';
const hash = (value) => createHash('sha256').update(value).digest('hex');
function sandbox() {
  fs.mkdirSync(TEMP, { recursive: true });
  const base = fs.mkdtempSync(path.join(TEMP, 'ace-legacy-regression-'));
  const stateDir = path.join(base, 'state');
  const libraryRoot = path.join(base, 'library');
  fs.mkdirSync(stateDir); fs.mkdirSync(libraryRoot);
  return { base, stateDir, libraryRoot, file: path.join(stateDir, 'state.json'), options: { stateDir, libraryRoot, mockDir: path.join(base, 'mock'), cfg: { stateDir, downloadDir: path.join(base, 'downloads') }, indexOnStart: false, analyzeFiles: () => { throw new Error('test must not invoke a real analyzer'); } } };
}
async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
function seed(sb) {
  const audio = path.join(sb.libraryRoot, 'fixture.wav');
  const outside = path.join(sb.base, 'outside.wav');
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, index) => index));
  fs.writeFileSync(audio, bytes); fs.writeFileSync(outside, bytes);
  const state = { schema: 'ace_mix_desk_state_v1', station: { nowPlaying: null, slot: 'opening', autoplay: false }, tracks: [{ id: 't_0001', file: audio, title: 'Fixture', slot: 'opening' }, { id: 't_0002', file: outside, title: 'Outside', slot: 'build' }], decisions: [], prompts: [], generations: [], pending: [], events: [], counters: { track: 2, decision: 0, prompt: 0, generation: 0 } };
  fs.writeFileSync(sb.file, JSON.stringify(state)); return { state, bytes };
}

test('legacy mixdesk：損壞狀態fail-closed，原件與獨立備份雜湊相同，不索引覆寫', async () => {
  const sb = sandbox();
  const raw = Buffer.from('{"schema":"ace_mix_desk_state_v1","uniqueEvidence":"retain"');
  await fsp.writeFile(sb.file, raw);
  let backup;
  await assert.rejects(createMixdeskServer(sb.options), (error) => { backup = error.backupPath; return error.code === 'MIXDESK_STATE_UNREADABLE'; });
  assert(backup);
  assert.equal(hash(await fsp.readFile(sb.file)), hash(raw));
  assert.equal(hash(await fsp.readFile(backup)), hash(raw));
});

test('legacy mixdesk：Host/Origin、JSON/body gate、ID、Range與writer失敗恢復均用ephemeral fixture', async () => {
  const sb = sandbox(); const { bytes } = seed(sb);
  let failNext = false;
  const server = await createMixdeskServer({ ...sb.options, persistSnapshot: async (snapshot, file) => { if (failNext) { failNext = false; throw new Error('fixture I/O failure'); } await fsp.writeFile(file, JSON.stringify(snapshot)); } });
  const base = await listen(server);
  const post = (route, body, headers = { 'Content-Type': 'application/json' }) => fetch(base + route, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    const forbidden = await fetch(base + '/api/state', { headers: { Origin: 'https://untrusted.invalid' } });
    assert.equal(forbidden.status, 403); assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
    const wrongHost = await new Promise((resolve, reject) => { http.get(base + '/api/state', { headers: { Host: 'untrusted.invalid:' + server.address().port } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
    assert.equal(wrongHost, 403);
    assert.equal((await post('/api/closed-loop', '{')).status, 400);
    assert.equal((await post('/api/closed-loop', '{}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('/api/closed-loop', JSON.stringify({ pad: 'x'.repeat(270000) }))).status, 413);
    const untouched = await (await fetch(base + '/api/state')).json();
    assert.equal(untouched.counts.generations, 0); assert.equal(fs.existsSync(sb.options.mockDir), false);
    assert.equal((await post('/api/decisions', { trackId: 't_0001', id: '<img src=x onerror=alert(1)>', fitSlot: 'opening', prompt: 'fixture' })).status, 400);
    const page = await fetch(base + '/');
    assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
    assert.match(await page.text(), /<script nonce="[A-Za-z0-9+/=]+">/);
    const suffix = await fetch(base + '/media/t_0001', { headers: { Range: 'bytes=-4' } });
    assert.equal(suffix.status, 206); assert.equal(suffix.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-4));
    const clamped = await fetch(base + '/media/t_0001', { headers: { Range: 'bytes=0-999999' } });
    assert.equal(clamped.headers.get('content-length'), '100'); assert.equal((await clamped.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(base + '/media/t_0001', { headers: { Range: 'bytes=9-2' } })).status, 416);
    assert.equal((await fetch(base + '/media/t_0002')).status, 403, 'indexed IDs do not authorize a path outside the configured roots');
    failNext = true;
    assert.equal((await post('/api/prompts', { trackId: 't_0001', prompt: 'first write fails' })).status, 500);
    assert.equal((await post('/api/prompts', { trackId: 't_0001', prompt: 'next write succeeds' })).status, 200);
    assert((JSON.parse(await fsp.readFile(sb.file, 'utf8'))).prompts.some((item) => item.prompt === 'next write succeeds'));
  } finally { await close(server); }
});

test('legacy renderer：decision ID以文字呈現，ended只在新src刷新成功後play', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'mixdesk/public/index.html'), 'utf8');
  const box = { innerHTML: '' };
  const decision = { payload: { decisionId: '<img src=x onerror=alert(1)>', trackId: 't_0001', slot: 'opening' } };
  const context = vm.createContext({ $: () => box, lastDecisions: [decision] });
  vm.runInContext(html.split('\n').find((line) => line.startsWith('function escapeHtml(')), context);
  vm.runInContext(html.split('\n').find((line) => line.includes("$('decisionBox').innerHTML")), context);
  assert(!box.innerHTML.includes('<img')); assert(box.innerHTML.includes('&lt;img'));
  const start = html.indexOf("player.addEventListener('ended'");
  const endedSource = html.slice(start, html.indexOf('\n});', start) + 4);
  let handler; const played = [];
  const player = { src: '/media/t_0001', addEventListener: (_event, callback) => { handler = callback; }, play: async () => { played.push(player.src); } };
  const scope = { player, currentTrack: { id: 't_0001' }, toast() {}, api: async (route) => route === '/api/queue' ? { track: { id: 't_0002' } } : { ok: true } };
  scope.refresh = async () => { await Promise.resolve(); scope.currentTrack = { id: 't_0002' }; player.src = '/media/t_0002'; return true; };
  vm.runInNewContext(endedSource, scope); await handler();
  assert.deepEqual(played, ['/media/t_0002']);
  played.length = 0; player.src = '/media/t_0001'; scope.refresh = async () => false;
  await handler(); assert.deepEqual(played, [], 'failed refresh must not restart the old source');
});

test('legacy MCP transport：HTTP/ok:false、abort、wall timeout均reject，不假報成功', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/unicode') {
      const body = Buffer.from(JSON.stringify({ ok: true, title: '慢鼓' }));
      const cut = body.indexOf(Buffer.from('慢')) + 1;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(body.subarray(0, cut));
      return setImmediate(() => res.end(body.subarray(cut)));
    }
    if (req.url === '/hang') return;
    if (req.url === '/abort') { res.writeHead(200); res.write('{"ok":'); return res.destroy(); }
    res.writeHead(req.url === '/http' ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'fixture rejection' }));
  });
  const base = await listen(server);
  try {
    assert.equal((await mixRequest('GET', '/unicode', null, { base, timeoutMs: 500 })).title, '慢鼓');
    await assert.rejects(mixRequest('GET', '/http', null, { base, timeoutMs: 500 }), /fixture rejection/);
    await assert.rejects(mixRequest('GET', '/business', null, { base, timeoutMs: 500 }), /fixture rejection/);
    await assert.rejects(mixRequest('GET', '/abort', null, { base, timeoutMs: 500 }));
    await assert.rejects(mixRequest('POST', '/hang', {}, { base, timeoutMs: 40 }), /逾時/);
  } finally { await close(server); }
});

test('benchmark：child退出/無回應有界，MCP isError不記成成功latency', async () => {
  const sb = sandbox();
  const exit = path.join(sb.base, 'exit.mjs'); await fsp.writeFile(exit, 'process.exit(2);');
  const dead = await benchMcp({ args: [exit], rounds: 1, timeoutMs: 300 });
  assert.equal(dead.ok, false); assert.match(dead.error, /exited/);
  const silent = path.join(sb.base, 'silent.mjs'); await fsp.writeFile(silent, 'process.stdin.resume();');
  const hung = await benchMcp({ args: [silent], rounds: 1, timeoutMs: 100 });
  assert.equal(hung.ok, false); assert.match(hung.error, /timeout/);
  const errors = path.join(sb.base, 'errors.mjs');
  await fsp.writeFile(errors, `import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const result=m.method==='initialize'?{}:{isError:true,content:[{type:'text',text:'fixture tool error'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`.replace("+'\\\\n'", "+'\\n'"));
  const failed = await benchMcp({ args: [errors], rounds: 1, timeoutMs: 1000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.ace_overview.ms.n, 0); assert.equal(failed.ace_overview.ok, false);
});

test('矩陣驗證：錯誤/缺失limit與9×16假144格均不能通過', async () => {
  const sb = sandbox();
  const dict = (a, b) => ({ opening_en: 'Instrumental at 110 BPM, sub-bass stays mono and centered.', closing_en: 'No vocals, humming, chanting, speech or vocal samples.', axis_a: Array.from({ length: a }, (_, n) => ({ id: 'A' + n, phrase_en: 'Bass color number ' + n + '.' })), axis_b: Array.from({ length: b }, (_, n) => ({ id: 'B' + n, phrase_en: 'Hand drum pattern number ' + n + '.' })) });
  const matrix = path.join(sb.base, 'matrix.json'); await fsp.writeFile(matrix, JSON.stringify(dict(12, 12)));
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-matrix.mjs'), matrix, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(run('--json').status, 0);
  for (const args of [['--limit'], ['--limit', 'invalid'], ['--limit', 'Infinity'], ['--limit', '0']]) assert.notEqual(run(...args).status, 0);
  await fsp.writeFile(matrix, JSON.stringify(dict(9, 16)));
  const invalid = run('--json'); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).ok, false);
});

test('Gemini registration：僅F fixture空object亦有效，其他設定保留、備份原件與回讀正確', async () => {
  const sb = sandbox(); const file = path.join(sb.base, 'settings.json');
  const original = { mcpServers: {}, theme: 'dark', untouched: { marker: 'not-a-real-secret', values: [1, 2] } };
  const raw = JSON.stringify(original); await fsp.writeFile(file, raw);
  const q = (value) => "'" + value.replaceAll("'", "''") + "'";
  const command = `. ${q(path.join(ROOT, 'agent/register-mcp.ps1'))} -FunctionsOnly\nAdd-AceMcpJsonRegistration -Path ${q(file)} -ServerName 'fixture-server' -NodePath 'C:\\Tools\\node.exe' -ScriptPath 'F:\\Fixture\\agent.mjs' | ConvertTo-Json -Compress\n`;
  const run = () => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: command, encoding: 'utf8', timeout: 10000, windowsHide: true });
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout.trim()); assert.equal(outcome.Changed, true);
  const current = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.deepEqual(current.untouched, original.untouched); assert.equal(current.theme, 'dark');
  assert.equal(current.mcpServers['fixture-server'].command, 'C:\\Tools\\node.exe');
  assert.equal(hash(await fsp.readFile(outcome.BackupPath)), hash(Buffer.from(raw)));
  const duplicate = run(); assert.equal(duplicate.status, 0, duplicate.stderr); assert.equal(JSON.parse(duplicate.stdout.trim()).Changed, false);
});

test('音訊key：合成頻率使用C-based pitch classes，version可區分舊cache', () => {
  const script = `import importlib.util,json,sys,numpy as np\ns=importlib.util.spec_from_file_location('fixture_audio',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nf=np.array([440.,440.*2**(-9/12),440.*2**(-8/12),440.*2**(-5/12),440.*2**(-2/12)])\nt=np.arange(22050*8)/22050\na=(np.sin(2*np.pi*f[1]*t)+.7*np.sin(2*np.pi*f[3]*t)+.8*np.sin(2*np.pi*f[4]*t)).astype(np.float32)\nkey,camelot,confidence=m.estimate_key(a,22050)\nprint(json.dumps({'classes':m.pitch_classes_for_frequencies(f).tolist(),'key':key,'camelot':camelot,'version':m.analyze('nonexistent-fixture-path',120)['algorithmVersion']}))`;
  const result = spawnSync(process.env.ACE_PYTHON || 'python', ['-c', script, path.join(ROOT, 'agent/analyze_audio.py')], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.classes, [9, 0, 1, 4, 7]);
  assert.equal(output.key, 'C:major'); assert.equal(output.camelot, '8B');
  assert.equal(output.version, 'huaidj-audio-v2-pitch-class-c');
});
