// Bounded, isolated P4 measurement. Never uses a real session, provider or library.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = 'F:\\DevData\\Temp\\HuaiDJ-ACE-Agent-20261116-bench';
const JOBS = 5, SAMPLES = 50, GENERATION_DELAY_MS = 1200, AUDIO_DELAY_MS = 1500;
const forbidden = new Set([8777, 8788, 18788, 18789, 18791]);
fs.mkdirSync(ROOT, { recursive: true });
if (process.platform === 'win32' && path.parse(fs.realpathSync.native(ROOT)).root.toLowerCase() !== 'f:\\') throw new Error('Benchmark TEMP must resolve on F:.');
const base = path.join(ROOT, randomUUID()), stateDir = path.join(base, 'state'), artifactsDir = path.join(base, 'artifacts');
fs.mkdirSync(base);
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); return file; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
agent.on('free', socket => socket.unref());

function jsonRequest(baseUrl, route, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now(), url = new URL(route, baseUrl), bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, agent,
      headers: bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {} }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks), data = JSON.parse(buffer.toString('utf8'));
          resolve({ status: response.statusCode, data, duration_ms: performance.now() - started, bytes: buffer.length });
        } catch (err) { reject(err); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('isolated benchmark request timeout')));
    request.on('error', reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}
async function call(baseUrl, route, body) {
  const result = await jsonRequest(baseUrl, route, body === undefined ? {} : { method: 'POST', body });
  if (result.status < 200 || result.status >= 300 || result.data.ok === false) throw new Error('Benchmark operation rejected: ' + route + ' ' + JSON.stringify(result.data));
  return result;
}
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); if (forbidden.has(port)) throw new Error('Refusing a known live-service port.'); return port; }
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b), at = percentile => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
  return { count: sorted.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: sorted.at(-1) ?? null, min_ms: sorted[0] ?? null };
}
function tinyWav() {
  const sampleRate = 22050, count = sampleRate * 2, buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 90 * index / sampleRate) * 3000), 44 + index * 2);
  return buffer;
}

const report = {
  schema: 'huaidj.music-workflow-benchmark.v1', started_at: new Date().toISOString(), ok: false,
  scope: 'Five fresh isolated generation jobs; delayed mock provider I/O plus real ffprobe and complete ffmpeg decoding of a two-second synthetic WAV. Not a real-provider, large-library, heavy-CPU or musical-quality acceptance test.',
  environment: { node: process.version, platform: os.platform(), os_release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model || null,
    logical_cpus: os.cpus().length, total_memory_bytes: os.totalmem(), free_memory_bytes_at_start: os.freemem(), temp_root: ROOT },
  configuration: { new_generation_jobs: JOBS, samples_per_hot_endpoint: SAMPLES, quantile: 'nearest rank: ceil(p*n)-1', http_keep_alive: true, client_max_sockets: 1,
    generation_delay_ms: GENERATION_DELAY_MS, direct_audio_delay_ms: AUDIO_DELAY_MS, audio_duration_seconds: 2,
    provider: 'loopback_mock_only', ace_credit_scope: { per_request: 0, total: 0, max_generations: JOBS }, real_provider_calls: 0, human_listening: 'not_run' },
};
const providerRequests = [], timings = { health: [], state: [], job: [] }, observations = [], acknowledgements = [], remoteTasks = new Map();
let provider, hub, hubExit, hubUrl, hubLog = '', postCount = 0, audioGets = 0;
const runStarted = performance.now(), fixture = tinyWav();
write(path.join(base, 'scope.json'), { ...report.configuration, note: 'All inputs, grants, cookies and audio in this directory are synthetic fixtures.' });
fs.writeFileSync(path.join(base, 'tiny-synthetic.wav'), fixture);
try {
  provider = http.createServer(async (request, response) => {
    const at = new Date().toISOString(); providerRequests.push({ method: request.method, path: request.url, at });
    const reply = data => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.headers.cookie !== 'bench_fixture=local_only') { response.writeHead(401); response.end('{}'); return; }
    if (request.method === 'GET' && request.url === '/api/status') return reply({ models: [{ id: 'ace-step-1.5-xl', free: true, limits: { prompt: 2000, style: 512, lyrics: 2000 } }], costs: { song: 0 }, user: { credits: 0, plan: 'isolated_benchmark_fixture' } });
    if (request.method === 'POST' && request.url === '/api/custom') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (++postCount > JOBS || input.model !== 'ace-step-1.5-xl') { response.writeHead(429); response.end('{}'); return; }
      const id = 'so_bench_' + postCount; remoteTasks.set(id, { ready_at: Date.now() + GENERATION_DELAY_MS, posted_at: at });
      return reply({ songs: [{ task_id: id, model: input.model, status: 'queued' }] });
    }
    if (request.method === 'GET' && request.url.startsWith('/api/songs?ids=')) {
      const ids = new URL(request.url, 'http://127.0.0.1').searchParams.get('ids').split(',');
      return reply({ items: ids.filter(id => remoteTasks.has(id)).map(id => ({ task_id: id, model: 'ace-step-1.5-xl', status: Date.now() >= remoteTasks.get(id).ready_at ? 'succeeded' : 'running',
        ...(Date.now() >= remoteTasks.get(id).ready_at ? { local_audio: '/data/' + id + '.wav' } : {}) })) });
    }
    if (request.method === 'GET' && /^\/data\/so_bench_\d+\.wav$/.test(request.url)) {
      audioGets++;
      const timer = setTimeout(() => { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': fixture.length }); response.end(fixture); }, AUDIO_DELAY_MS);
      response.on('close', () => clearTimeout(timer)); return;
    }
    if (request.method === 'GET' && request.url.startsWith('/api/songs')) return reply({ items: [], next: null });
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = 'http://127.0.0.1:' + provider.address().port;
  const sessionFile = write(path.join(base, 'fake-session.json'), { cookie: 'bench_fixture=local_only', ua: 'HuaiDJ-Bounded-Benchmark' });
  write(path.join(stateDir, 'cache/songs.json'), { cachedAt: Date.now(), songs: [], known: [] }); write(path.join(stateDir, 'cache/fs-index.json'), { cachedAt: Date.now(), files: [], rel: [], names: [] });
  write(path.join(stateDir, 'cache/session-status.json'), { cachedAt: Date.now(), ttlMs: 120000, sessionMtimeMs: fs.statSync(sessionFile).mtimeMs, status: { authenticated: true } });
  write(path.join(stateDir, 'page-songs.json'), { savedAt: Date.now(), songs: [] });
  const grantFile = write(path.join(base, 'fixture-grant.json'), { grant_id: 'bounded-bench-' + randomUUID(), provider: 'ace', models: ['ace-step-1.5-xl'], modes: ['custom'],
    max_credits_per_request: 0, max_credits_total: 0, max_generations: JOBS, expires_at: new Date(Date.now() + 120000).toISOString(), allow_upload: false, allow_auto_continue: false });
  const runtimeFile = write(path.join(base, 'runtime.json'), { artifacts_dir: artifactsDir, poll_interval_ms: 1000 });
  const port = await freePort(); hubUrl = 'http://127.0.0.1:' + port;
  const env = { ...process.env, TEMP: base, TMP: base, ACE_STATE_DIR: stateDir, ACE_DOWNLOAD_DIR: path.join(base, 'downloads'), LOCALAPPDATA: path.join(base, 'local-appdata'),
    ACE_BASE_URL: providerUrl, ACE_SESSION_FILE: sessionFile, ACE_HUB_HOST: '127.0.0.1', ACE_HUB_PORT: String(port), ACE_HUB_URL: hubUrl, ACE_HUB_TOKEN: '', ACE_HUB_EXTENSIONS: '',
    ACE_GENERATION_GRANT_FILE: grantFile, ACE_MUSIC_RUNTIME_CONFIG: runtimeFile, ACE_MUSIC_ARTIFACTS_DIR: artifactsDir, ACE_RESEARCH_CONFIG_FILE: '', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: '',
    ACE_FFMPEG: process.env.ACE_BENCH_FFMPEG || 'ffmpeg', ACE_FFPROBE: process.env.ACE_BENCH_FFPROBE || 'ffprobe' };
  const coldStarted = performance.now();
  hub = spawn(process.execPath, [path.join(PROJECT, 'agent/hub.mjs')], { cwd: PROJECT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stdout.on('data', chunk => { hubLog += chunk; }); hub.stderr.on('data', chunk => { hubLog += chunk; }); hubExit = new Promise(resolve => hub.on('exit', resolve));
  let healthy = false;
  while (performance.now() - coldStarted < 15000) { if (hub.exitCode !== null) throw new Error('Isolated Hub exited before startup.'); try { const result = await call(hubUrl, '/health'); if (result.data.ok) { healthy = true; break; } } catch {} await pause(20); }
  if (!healthy) throw new Error('Cold Hub startup timed out.');
  report.cold = { spawn_to_health_ms: performance.now() - coldStarted, startup_poll_interval_ms: 20 };
  const firstState = await call(hubUrl, '/music/state'); report.cold.first_music_state_ms = firstState.duration_ms;
  const session = (await call(hubUrl, '/music/sessions', { goal: 'Bounded isolated P4 measurement', max_generations: JOBS, max_depth: 1 })).data.session;
  const prepared = [];
  for (let index = 0; index < JOBS; index++) {
    const plan = (await call(hubUrl, '/music/prompts/compile', { natural_language: 'sub bass, micro swing, spatial depth, instrumental', model: 'ace-step-v1.5-xl', mode: 'custom', lyrics: '', seed: 100 + index })).data.plan;
    const result = await call(hubUrl, '/music/generations/prepare', { plan_id: plan.id, session_id: session.id, idempotency_key: 'fresh-bench-' + index + '-' + randomUUID(), reviewed: true,
      api_parameters: { step: { mode: 'standard', duration_sec: 10 } } });
    if (result.data.reused) throw new Error('A benchmark preparation was unexpectedly reused.');
    prepared.push(result.data.job);
  }
  if (new Set(prepared.map(job => job.id)).size !== JOBS) throw new Error('Benchmark jobs are not distinct.');
  for (const job of prepared) {
    const result = await call(hubUrl, '/music/generations/submit', { job_id: job.id });
    if (result.data.reused || result.data.job?.id !== job.id) throw new Error('A reused or mismatched acknowledgement cannot count as a new submit.');
    acknowledgements.push({ job_id: job.id, duration_ms: result.duration_ms, status: result.data.status, reused: result.data.reused === true });
  }
  report.submit_acknowledgements = { ...stats(acknowledgements.map(item => item.duration_ms)), samples: acknowledgements };
  const workStarted = performance.now(); let collecting = false;
  while (performance.now() - workStarted < 20000) { const result = await call(hubUrl, '/music/state'); if (result.data.jobs.some(job => prepared.some(item => item.id === job.id) && job.status === 'collecting')) { collecting = true; break; } await pause(50); }
  if (!collecting) throw new Error('No real collection phase was observed; refusing a misleading idle benchmark.');
  // All three paths use the same established keep-alive connection. Warm-up is
  // excluded, and job reads rotate across the five newly submitted jobs.
  await call(hubUrl, '/health'); await call(hubUrl, '/music/state'); await call(hubUrl, '/music/job?job_id=' + encodeURIComponent(prepared[0].id));
  for (let index = 0; index < SAMPLES; index++) {
    const health = await call(hubUrl, '/health'), current = await call(hubUrl, '/music/state'), job = await call(hubUrl, '/music/job?job_id=' + encodeURIComponent(prepared[index % JOBS].id));
    const relevant = current.data.jobs.filter(job => prepared.some(item => item.id === job.id));
    timings.health.push(health.duration_ms); timings.state.push(current.duration_ms); timings.job.push(job.duration_ms);
    observations.push({ sample: index + 1, at: new Date().toISOString(), collecting: relevant.filter(job => job.status === 'collecting').length, generating: relevant.filter(job => job.status === 'generating').length,
      awaiting_listen: relevant.filter(job => job.status === 'awaiting_listen').length, state_response_bytes: current.bytes });
    if (index + 1 < SAMPLES) await pause(50);
  }
  report.hot_reads = Object.fromEntries(Object.entries(timings).map(([route, values]) => [route, stats(values)]));
  report.background_work_observations = observations;
  let final;
  const completedDeadline = Date.now() + 30000;
  do { final = (await call(hubUrl, '/music/state')).data; if (prepared.every(item => final.jobs.find(job => job.id === item.id)?.status === 'awaiting_listen')) break; await pause(100); } while (Date.now() < completedDeadline);
  const jobs = final.jobs.filter(job => prepared.some(item => item.id === job.id)), ids = new Set(jobs.flatMap(job => job.artifacts || []));
  const collectedAssets = final.assets.filter(asset => ids.has(asset.id));
  report.reliability = { fresh_job_count: prepared.length, distinct_job_ids: new Set(prepared.map(job => job.id)).size, provider_generation_posts: postCount,
    distinct_remote_task_ids: remoteTasks.size, audio_gets: audioGets, collected_artifact_count: collectedAssets.length,
    full_decode_count: collectedAssets.filter(asset => asset.technical_review?.full_decode === true).length, mock_label_count: collectedAssets.filter(asset => asset.real_or_mock === 'mock').length,
    job_states: jobs.map(job => ({ id: job.id, status: job.status, remote_task_ids: job.remote_task_ids, artifact_ids: job.artifacts, real_success: job.real_success })),
    samples_during_collection: observations.filter(value => value.collecting > 0).length, samples_during_generation_or_collection: observations.filter(value => value.collecting + value.generating > 0).length,
    ace_authority: final.generation_authority, all_new_jobs_awaiting_listen: jobs.length === JOBS && jobs.every(job => job.status === 'awaiting_listen') };
  report.targets = { hot_health_p95_under_100ms: report.hot_reads.health.p95_ms < 100, hot_state_p95_under_100ms: report.hot_reads.state.p95_ms < 100,
    hot_job_p95_under_100ms: report.hot_reads.job.p95_ms < 100, new_submit_ack_p95_under_300ms: report.submit_acknowledgements.p95_ms < 300 };
  report.ok = Object.values(report.targets).every(Boolean) && report.reliability.all_new_jobs_awaiting_listen && postCount === JOBS && collectedAssets.length === JOBS && report.reliability.full_decode_count === JOBS && report.reliability.mock_label_count === JOBS && report.reliability.samples_during_collection === SAMPLES;
  if (!report.ok) report.failure = 'One or more declared latency, freshness, collection-overlap or decoding requirements were not met. Thresholds were not relaxed.';
} catch (err) {
  report.failure = String(err.message || err); report.ok = false;
} finally {
  if (hub?.exitCode === null) { try { await jsonRequest(hubUrl, '/shutdown', { method: 'POST', body: {}, timeoutMs: 1500 }); } catch { hub.kill(); } await hubExit; }
  agent.destroy();
  if (provider) await new Promise(resolve => provider.close(resolve));
  report.finished_at = new Date().toISOString(); report.elapsed_ms = performance.now() - runStarted;
  report.cleanup = { isolated_hub_exited: hub ? hub.exitCode !== null : true, isolated_mock_closed: provider ? !provider.listening : true, original_assets_touched: false };
  write(path.join(base, 'benchmark.json'), report); write(path.join(base, 'mock-provider-requests.json'), providerRequests); fs.writeFileSync(path.join(base, 'hub.log'), hubLog);
  write(path.join(ROOT, 'latest.json'), { report: path.join(base, 'benchmark.json'), ok: report.ok, finished_at: report.finished_at });
  console.log(JSON.stringify({ ok: report.ok, report: path.join(base, 'benchmark.json'), cold: report.cold, hot_reads: report.hot_reads, submit_acknowledgements: report.submit_acknowledgements && { ...report.submit_acknowledgements, samples: undefined }, targets: report.targets, reliability: report.reliability && { fresh_job_count: report.reliability.fresh_job_count, provider_generation_posts: postCount, collected_artifact_count: report.reliability.collected_artifact_count, full_decode_count: report.reliability.full_decode_count, samples_during_collection: report.reliability.samples_during_collection }, failure: report.failure }));
  if (!report.ok) process.exitCode = 1;
}
