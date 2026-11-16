import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createMusicArtifactCollector } from '../../agent/lib/music-artifacts.mjs';

const TEST_ROOT = path.join(process.env.ACE_TEST_TEMP || os.tmpdir(), 'HuaiDJ-ACE-phase2-artifacts');
fs.mkdirSync(TEST_ROOT, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
let samples;

async function createSample(file, silent = false) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', silent ? 'anullsrc=r=22050:cl=stereo' : 'sine=frequency=90:sample_rate=22050:duration=1',
    '-t', '1', '-ac', '2', '-c:a', 'pcm_s16le', '-n', file];
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.ACE_FFMPEG || 'ffmpeg', args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture ffmpeg timed out')); }, 10000);
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
  });
}

async function sampleBytes() {
  if (!samples) samples = (async () => {
    const root = path.join(TEST_ROOT, 'fixtures-' + randomUUID());
    await fsp.mkdir(root);
    const normal = path.join(root, 'tiny-generated-test.wav'), silence = path.join(root, 'tiny-silence-test.wav');
    await createSample(normal); await createSample(silence, true);
    return { normal: await fsp.readFile(normal), silence: await fsp.readFile(silence) };
  })();
  return samples;
}

async function fixture(t, { songs = {}, routes = {}, options = {}, anonymousPaths = [] } = {}) {
  const base = path.join(TEST_ROOT, 'case-' + randomUUID());
  fs.mkdirSync(base);
  const artifactsDir = path.join(base, 'artifacts');
  const sessionFile = path.join(base, 'fake-session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ cookie: 'fixture=local_only', ua: 'AudioCollectorFixture' }));
  const bytes = await sampleBytes(), requests = [], queries = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    assert.equal(req.method, 'GET', 'collector must never call a split/MIDI/generation POST');
    assert.equal(req.headers.cookie, anonymousPaths.includes(req.url) ? undefined : 'fixture=local_only');
    const route = routes[req.url];
    if (typeof route === 'function') return route(req, res, bytes);
    const body = Buffer.isBuffer(route?.body) ? route.body : req.url === '/data/silence.mp3' ? bytes.silence : bytes.normal;
    res.writeHead(route?.status ?? 200, { 'Content-Type': route?.type || 'audio/wav', 'Content-Length': body.length, ...route?.headers });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}`, sessionFile, ua: 'Fixture' };
  const transport = { async status(input) {
    queries.push(input);
    return { ok: true, songs: input.task_ids.map(task_id => ({ task_id, status: 'succeeded', model: 'acemusic-v1.1', local_audio: '/data/tiny.mp3', ...songs[task_id] })) };
  } };
  const collector = createMusicArtifactCollector({ cfg, artifactsDir, transport, ...options });
  return { base, artifactsDir, cfg, transport, collector, requests, queries, bytes,
    collect(task_ids = ['so_good'], extra = {}) { return collector.collect({ task_ids, requested_model: 'acemusic-v1.1', source_job: 'job_fixture', ...extra }); } };
}

test('collector hashes and fully decodes tiny mock audio, trusts content over extension, and persists technical evidence', async t => {
  let fetches = 0;
  const fix = await fixture(t, { options: { fetchImpl: (...args) => { fetches += 1; return fetch(...args); } } });
  const result = await fix.collect(['so_good'], { rights_snapshot: { status: 'fixture_only', commercial_use: 'unknown' }, parent_ids: ['artifact_parent'] });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.status, 'collected');
  assert.equal(result.downloaded, 1);
  assert.equal(result.artifacts.length, 1);
  assert.equal(fetches, 1);
  assert.deepEqual(fix.queries, [{ task_ids: ['so_good'], requested_model: 'acemusic-v1.1' }]);
  const artifact = result.artifacts[0];
  assert.equal(artifact.real_or_mock, 'mock', 'fixture is never promoted to a real ACE generation');
  assert.equal(artifact.format, 'wav', '/data/tiny.mp3 actually contains WAV bytes');
  assert.equal(artifact.sha256, hash(fix.bytes.normal));
  assert.match(artifact.path, /\.wav$/);
  assert.equal(hash(fs.readFileSync(artifact.path)), artifact.sha256);
  assert.equal(artifact.codec, 'pcm_s16le');
  assert.equal(artifact.sample_rate, 22050);
  assert.equal(artifact.channels, 2);
  assert.ok(artifact.duration >= 0.99 && artifact.duration <= 1.01);
  assert.equal(artifact.technical_review.full_decode, true);
  assert.equal(artifact.technical_review.measurements.kind, 'measurement');
  assert.equal(artifact.technical_review.heuristics.kind, 'heuristic');
  assert.equal(typeof artifact.technical_review.measurements.peak_dbfs, 'number');
  assert.equal(typeof artifact.technical_review.measurements.rms_dbfs, 'number');
  assert.equal(artifact.technical_review.heuristics.clipped_sample_count, null);
  assert.equal(artifact.technical_review.human_listen.accepted, false);
  assert.equal(artifact.technical_review.evidence_scope, 'isolated_mock_provider');
  assert.deepEqual(artifact.parent_ids, ['artifact_parent']);
  assert.equal(artifact.rights_snapshot.commercial_use, 'unknown');
  assert.ok(fs.existsSync(artifact.path.replace(/\.wav$/, '.json')));
  assert.ok(fix.requests.every(request => request.method === 'GET' && request.path.startsWith('/data/')));
});

test('same task and hash reuses one asset across collector restart; distinct takes remain separate', async t => {
  const fix = await fixture(t);
  const first = await fix.collect(['so_first']);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const retry = await fix.collect(['so_first']);
  assert.equal(retry.ok, true, JSON.stringify(retry.errors));
  assert.equal(retry.reused, 1);
  assert.equal(retry.downloaded, 0);
  assert.equal(retry.artifacts[0].id, first.artifacts[0].id);
  const reopened = createMusicArtifactCollector({ cfg: fix.cfg, artifactsDir: fix.artifactsDir, transport: fix.transport });
  const persisted = await reopened.collect({ task_ids: ['so_first'], requested_model: 'acemusic-v1.1', source_job: 'job_reopened' });
  assert.equal(persisted.reused, 1);
  assert.equal(persisted.artifacts[0].source_job, 'job_fixture', 'retries preserve original provenance');
  const other = await fix.collect(['so_other_take']);
  assert.equal(other.ok, true, JSON.stringify(other.errors));
  assert.equal(other.artifacts[0].sha256, first.artifacts[0].sha256);
  assert.notEqual(other.artifacts[0].id, first.artifacts[0].id);
  assert.notEqual(other.artifacts[0].path, first.artifacts[0].path);
});

test('model mismatch, unfinished tasks and unsafe remote paths fail before any audio read', async t => {
  const fix = await fixture(t, { songs: {
    so_mismatch: { model: 'acemusic-v1' }, so_pending: { status: 'running' },
    so_external: { local_audio: 'https://example.invalid/data/song.wav' },
    so_escape: { local_audio: '/data/../../private.wav' },
    so_encoded: { local_audio: '/data/%2e%2e/private.wav' },
    so_auth_url: { local_audio: 'http://user:password@127.0.0.1/data/song.wav' },
  } });
  const result = await fix.collect(['so_mismatch', 'so_pending', 'so_external', 'so_escape', 'so_encoded', 'so_auth_url']);
  assert.equal(result.ok, false);
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 6);
  assert.equal(result.errors[0].code, 'MODEL_MISMATCH');
  assert.equal(result.errors[1].code, 'TASK_NOT_SUCCEEDED');
  assert.ok(result.errors.slice(2).every(error => error.code === 'UNSAFE_AUDIO_URL'));
  assert.equal(fix.requests.length, 0);
  assert.ok(result.errors.every(error => fs.existsSync(error.evidence_path)));
  const invalid = await fix.collect(['so_good'], { source_job: '../escape' });
  assert.equal(invalid.status, 'invalid');
  assert.equal(fix.requests.length, 0);
});

test('invalid bytes, HTML, truncated containers and interrupted downloads keep error evidence without empty success', async t => {
  const bytes = await sampleBytes();
  const fix = await fixture(t, { songs: {
    so_bad: { local_audio: '/data/bad.mp3' }, so_html: { local_audio: '/data/html.mp3' },
    so_short: { local_audio: '/data/short.wav' }, so_drop: { local_audio: '/data/drop.wav' },
  }, routes: {
    '/data/bad.mp3': { body: Buffer.from('not an audio file'), type: 'audio/mpeg' },
    '/data/html.mp3': { body: Buffer.from('<html>login required</html>'), type: 'text/html' },
    '/data/short.wav': { body: bytes.normal.subarray(0, bytes.normal.length - 100) },
    '/data/drop.wav': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.normal.length });
      res.write(bytes.normal.subarray(0, 100));
      setTimeout(() => res.destroy(), 15);
    },
  } });
  const result = await fix.collect(['so_bad', 'so_html', 'so_short', 'so_drop']);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 4);
  assert.deepEqual(result.errors.slice(0, 3).map(error => error.code), ['UNKNOWN_AUDIO_MAGIC', 'DOWNLOAD_CONTENT_TYPE', 'TRUNCATED_CONTAINER']);
  for (const error of result.errors) {
    assert.ok(error.code);
    const evidence = JSON.parse(fs.readFileSync(error.evidence_path, 'utf8'));
    assert.equal(evidence.remote_task_id, error.remote_task_id);
  }
  assert.ok(result.errors.filter(error => ['so_bad', 'so_short', 'so_drop'].includes(error.remote_task_id)).every(error => {
    const evidence = JSON.parse(fs.readFileSync(error.evidence_path, 'utf8'));
    return evidence.partial_path && fs.existsSync(evidence.partial_path);
  }));
});

test('chunk and timeout limits stop downloads while preserving partial evidence', async t => {
  const fix = await fixture(t, { songs: { so_oversize: { local_audio: '/data/chunked.wav' }, so_slow: { local_audio: '/data/slow.wav' } }, routes: {
    '/data/chunked.wav': (req, res, bytes) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Transfer-Encoding': 'chunked' }); res.write(bytes.normal.subarray(0, 300)); res.end(bytes.normal.subarray(300)); },
    '/data/slow.wav': (req, res, bytes) => {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.normal.length });
      res.write(bytes.normal.subarray(0, 100));
      const timer = setTimeout(() => res.end(bytes.normal.subarray(100)), 2000);
      res.on('close', () => clearTimeout(timer));
    },
  }, options: { maxBytes: 1000, downloadTimeoutMs: 100 } });
  const oversize = await fix.collect(['so_oversize']);
  assert.equal(oversize.errors[0].code, 'DOWNLOAD_SIZE_LIMIT');
  const slowCollector = createMusicArtifactCollector({ cfg: fix.cfg, artifactsDir: path.join(fix.base, 'slow-artifacts'), transport: fix.transport, downloadTimeoutMs: 100 });
  const slow = await slowCollector.collect({ task_ids: ['so_slow'], requested_model: 'acemusic-v1.1', source_job: 'job_slow' });
  assert.equal(slow.ok, false);
  assert.ok(['DOWNLOAD_TIMEOUT', 'DOWNLOAD_INTERRUPTED'].includes(slow.errors[0].code), JSON.stringify(slow.errors));
  assert.equal(slow.artifacts.length, 0);
});

test('output junctions and tampered existing files are rejected without overwriting or following outside roots', async t => {
  const fix = await fixture(t);
  const outside = path.join(fix.base, 'outside');
  fs.mkdirSync(outside);
  const linkedRoot = path.join(fix.base, 'linked-root');
  fs.symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createMusicArtifactCollector({ cfg: fix.cfg, artifactsDir: linkedRoot, transport: fix.transport }), error => error.code === 'OUTPUT_LINK_REJECTED');
  const taskDirectory = path.join(fix.artifactsDir, 'task-' + hash('so_junction').slice(0, 24));
  fs.symlinkSync(outside, taskDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const junction = await fix.collect(['so_junction']);
  assert.equal(junction.ok, false);
  assert.equal(junction.errors[0].code, 'OUTPUT_LINK_REJECTED');
  assert.deepEqual(fs.readdirSync(outside), []);
  const first = await fix.collect(['so_original']);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const original = first.artifacts[0];
  fs.writeFileSync(original.path, 'tampered fixture evidence');
  const conflict = await fix.collect(['so_original']);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.errors[0].code, 'ARTIFACT_HASH_CONFLICT');
  assert.equal(fs.readFileSync(original.path, 'utf8'), 'tampered fixture evidence', 'never replace a conflicting original');
});

test('digital silence is measured separately from listening acceptance', async t => {
  const fix = await fixture(t, { songs: { so_silence: { local_audio: '/data/silence.mp3' } } });
  const result = await fix.collect(['so_silence']);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const review = result.artifacts[0].technical_review;
  assert.equal(review.measurements.digital_silence, true);
  assert.equal(review.measurements.peak_dbfs, null, 'JSON does not invent a finite value for negative infinity');
  assert.equal(review.heuristics.likely_silent, true);
  assert.equal(review.status, 'technical_warning');
  assert.equal(review.measurements.integrated_lufs, null, 'the meter floor is not a measured loudness for digital silence');
  assert.equal(review.human_listen.accepted, false);
  assert.equal(result.artifacts[0].real_or_mock, 'mock');
});

test('manual same-origin redirects are bounded and strip session headers on every subsequent hop', async t => {
  const finalPath = '/data/final.wav?signature=private-test-query';
  const fix = await fixture(t, { songs: { so_redirect: { local_audio: '/data/start.mp3' } },
    anonymousPaths: [finalPath], routes: { '/data/start.mp3': (_req, res) => { res.writeHead(302, { Location: finalPath }); res.end(); } } });
  const result = await fix.collect(['so_redirect']);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(fix.requests.length, 2);
  const sidecar = fs.readFileSync(result.artifacts[0].path.replace(/\.wav$/, '.json'), 'utf8');
  assert.equal(sidecar.includes('private-test-query'), false);
  assert.equal(sidecar.includes('signature='), false);
});

test('an explicitly allowed public HTTPS CDN redirect never receives cookies, origin, referer or session UA', async t => {
  const bytes = (await sampleBytes()).normal;
  const requests = [], lookups = [];
  const fix = await fixture(t, { options: {
    allowedRedirectOrigins: ['https://cdn.example.com'],
    resolveImpl: async host => { lookups.push(host); return [{ address: '8.8.8.8', family: 4 }]; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
      return requests.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://cdn.example.com/audio.mp3?signature=private-cdn-query' } }) : new Response(bytes, { headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) } });
    },
  } });
  const result = await fix.collect();
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(lookups, ['cdn.example.com']);
  assert.equal(requests[0].options.headers.Cookie, 'fixture=local_only');
  for (const field of ['Cookie', 'Origin', 'Referer']) assert.equal(requests[1].options.headers[field], undefined);
  assert.equal(requests[1].options.headers['User-Agent'], 'HuaiDJ-AudioCollector/1.0');
  assert.notEqual(requests[1].options.headers['User-Agent'], requests[0].options.headers['User-Agent']);
  assert.equal(JSON.stringify(result).includes('private-cdn-query'), false);
  assert.equal(fs.readFileSync(result.artifacts[0].path.replace(/\.wav$/, '.json'), 'utf8').includes('private-cdn-query'), false);
});

test('unknown redirect origins and configured origins with private DNS fail before any target request', async t => {
  for (const addresses of [null, [{ address: '127.0.0.1' }], [{ address: '8.8.8.8' }, { address: '192.168.1.10' }], [{ address: '::ffff:7f00:1' }]]) {
    await t.test(addresses === null ? 'unknown origin' : JSON.stringify(addresses), async child => {
      let requests = 0;
      const fix = await fixture(child, { options: {
        allowedRedirectOrigins: addresses ? ['https://cdn.example.com'] : [], resolveImpl: async () => addresses,
        fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { Location: 'https://cdn.example.com/audio?secret=do-not-persist' } }); },
      } });
      const result = await fix.collect();
      assert.equal(result.ok, false);
      assert.equal(requests, 1);
      assert.equal(result.errors[0].code, addresses ? 'DOWNLOAD_REDIRECT_PRIVATE' : 'DOWNLOAD_REDIRECT_NOT_ALLOWED');
      const evidence = JSON.parse(fs.readFileSync(result.errors[0].evidence_path, 'utf8'));
      assert.equal(evidence.partial_path, null);
      assert.equal(JSON.stringify(evidence).includes('do-not-persist'), false);
    });
  }
});

test('redirect loops stop after at most three hops and reject unsafe redirect configuration', async t => {
  let requests = 0;
  const fix = await fixture(t, { options: { fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { Location: '/data/loop.mp3' } }); } } });
  const result = await fix.collect();
  assert.equal(result.errors[0].code, 'DOWNLOAD_REDIRECT_LIMIT');
  assert.equal(result.errors[0].redirect_hops, 3);
  assert.equal(result.errors[0].http_status, 302);
  assert.equal(requests, 4);
  for (const invalid of [{ maxRedirects: 4 }, { allowedRedirectOrigins: ['http://cdn.example.com'] }, { allowedRedirectOrigins: ['https://user:password@cdn.example.com'] }, { allowedRedirectOrigins: ['https://127.0.0.1'] }]) {
    assert.throws(() => createMusicArtifactCollector({ cfg: fix.cfg, artifactsDir: fix.artifactsDir, transport: fix.transport, ...invalid }));
  }
});

test('fetch failures retain safe cause code and stage without leaking exception contents or signed URLs', async t => {
  const fix = await fixture(t, { options: { fetchImpl: async () => {
    throw Object.assign(new TypeError('cookie=fixture=local_only; https://cdn.example.com/?signature=private-exception'), {
      cause: Object.assign(new Error('private-response-body'), { code: 'ECONNRESET', address: 'private-address' }),
    });
  } } });
  const result = await fix.collect();
  assert.equal(result.errors[0].code, 'DOWNLOAD_INTERRUPTED');
  assert.equal(result.errors[0].cause_code, 'ECONNRESET');
  assert.equal(result.errors[0].download_stage, 'fetch_headers');
  assert.equal(result.errors[0].received_bytes, 0);
  const evidence = JSON.parse(fs.readFileSync(result.errors[0].evidence_path, 'utf8'));
  assert.equal(evidence.partial_path, null);
  for (const value of ['fixture=local_only', 'private-exception', 'private-response-body', 'private-address', 'signature=']) assert.equal(JSON.stringify(evidence).includes(value), false);
});

const R2_HOST = 'c56f4a80abefb3bfc10991eef7ce3ef8.r2.cloudflarestorage.com';
function dnsAnswer(url, addresses) {
  const parsed = new URL(url), type = parsed.searchParams.get('type') === 'A' ? 1 : 28;
  return new Response(JSON.stringify({ Status: 0, TC: false, Question: [{ name: parsed.searchParams.get('name') + '.', type }],
    Answer: addresses.map(address => ({ name: R2_HOST + '.', type: address.includes(':') ? 28 : 1, TTL: 60, data: address })) }), { headers: { 'content-type': 'application/dns-json' } });
}

test('allowlisted R2 with local TUN fakeIP needs independent public A/AAAA metadata without any session data', async t => {
  const bytes = (await sampleBytes()).normal;
  const audioRequests = [], dnsRequests = [];
  const fix = await fixture(t, { options: {
    allowedRedirectOrigins: ['https://' + R2_HOST], resolveImpl: async () => [{ address: '198.18.3.89', family: 4 }],
    dnsFetchImpl: async (url, options) => {
      dnsRequests.push({ url, options });
      const target = new URL(url);
      assert.equal(target.origin, 'https://1.1.1.1');
      assert.equal(target.pathname, '/dns-query');
      assert.deepEqual([...target.searchParams.keys()], ['name', 'type']);
      assert.equal(target.searchParams.get('name'), R2_HOST);
      assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      assert.deepEqual(options.headers, { Accept: 'application/dns-json' });
      return dnsAnswer(url, target.searchParams.get('type') === 'A' ? ['172.64.66.1'] : ['2606:4700:113::1']);
    },
    fetchImpl: async (url, options) => {
      audioRequests.push({ url, options });
      return audioRequests.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://' + R2_HOST + '/bucket/audio.mp3?signature=private-r2-token' } }) : new Response(bytes, { headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.length) } });
    },
  } });
  const result = await fix.collect();
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(audioRequests.length, 2);
  assert.equal(dnsRequests.length, 2);
  assert.equal(audioRequests[0].options.headers.Cookie, 'fixture=local_only');
  for (const field of ['Cookie', 'Origin', 'Referer']) assert.equal(audioRequests[1].options.headers[field], undefined);
  const evidence = result.artifacts[0].technical_review.integrity.redirect_dns_evidence[0];
  assert.equal(evidence.local_resolution, 'tun_fake_ip_198_18_15');
  assert.equal(evidence.independent_resolution, 'public');
  assert.equal(evidence.independent_resolver, 'cloudflare_1_1_1_1_doh');
  assert.equal(evidence.independent_a_count, 1); assert.equal(evidence.independent_aaaa_count, 1);
  assert.equal(evidence.route_verified, false);
  assert.equal(evidence.tls_policy, 'original_hostname_default_trust');
  const sidecar = fs.readFileSync(result.artifacts[0].path.replace(/\.wav$/, '.json'), 'utf8');
  for (const text of ['private-r2-token', 'signature=', 'fixture=local_only']) assert.equal(sidecar.includes(text), false);
});

test('fakeIP fallback never expands to generic hosts, unknown R2 origins, RFC1918 or mixed local answers', async t => {
  for (const input of [
    { host: 'cdn.example.com', allow: true, addresses: ['198.18.3.89'] },
    { host: R2_HOST, allow: false, addresses: ['198.18.3.89'] },
    { host: R2_HOST, allow: true, addresses: ['10.0.0.1'] },
    { host: R2_HOST, allow: true, addresses: ['198.18.3.89', '127.0.0.1'] },
    { host: R2_HOST, allow: true, addresses: ['198.18.3.89', '8.8.8.8'] },
  ]) {
    await t.test(input.host + ':' + input.addresses.join(','), async child => {
      let audio = 0, dns = 0;
      const fix = await fixture(child, { options: { allowedRedirectOrigins: input.allow ? ['https://' + input.host] : [],
        resolveImpl: async () => input.addresses.map(address => ({ address })),
        dnsFetchImpl: async () => { dns++; throw new Error('DNS fallback must remain closed'); },
        fetchImpl: async () => { audio++; return new Response(null, { status: 302, headers: { Location: 'https://' + input.host + '/audio?signature=private-r2' } }); },
      } });
      const result = await fix.collect();
      assert.equal(result.ok, false);
      assert.equal(audio, 1); assert.equal(dns, 0);
      assert.equal(result.errors[0].code, input.allow ? 'DOWNLOAD_REDIRECT_PRIVATE' : 'DOWNLOAD_REDIRECT_NOT_ALLOWED');
    });
  }
});

test('R2 fakeIP cannot pass on missing, malformed, redirected or private independent DNS answers', async t => {
  for (const scenario of ['private', 'empty', 'wrong-question', 'redirect', 'unavailable', 'malformed']) {
    await t.test(scenario, async child => {
      let audio = 0;
      const fix = await fixture(child, { options: { allowedRedirectOrigins: ['https://' + R2_HOST], resolveImpl: async () => [{ address: '198.19.1.2' }],
        fetchImpl: async () => { audio++; return new Response(null, { status: 302, headers: { Location: 'https://' + R2_HOST + '/audio?signature=secret-query' } }); },
        dnsFetchImpl: async url => {
          if (scenario === 'private') return dnsAnswer(url, ['192.168.1.1']);
          if (scenario === 'empty') return dnsAnswer(url, []);
          if (scenario === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/dns' } });
          if (scenario === 'unavailable') throw Object.assign(new Error('raw-private-detail'), { code: 'ECONNRESET' });
          if (scenario === 'malformed') return new Response('raw-private-detail');
          return new Response(JSON.stringify({ Status: 0, Question: [{ name: 'other.example.', type: 1 }], Answer: [{ type: 1, data: '8.8.8.8' }] }));
        },
      } });
      const result = await fix.collect();
      assert.equal(result.ok, false);
      assert.equal(audio, 1);
      assert.equal(result.errors[0].code, 'DOWNLOAD_REDIRECT_DNS_UNVERIFIED');
      assert.equal(result.errors[0].dns_resolution.local_resolution, 'tun_fake_ip_198_18_15');
      assert.equal(result.errors[0].dns_resolution.independent_resolution, 'unverified');
      const evidence = fs.readFileSync(result.errors[0].evidence_path, 'utf8');
      for (const text of ['secret-query', 'signature=', 'raw-private-detail', 'fixture=local_only']) assert.equal(evidence.includes(text), false);
    });
  }
});

test('#15 a generation pair is accepted song by song: both succeed as two separate artifacts', async t => {
  const fix = await fixture(t);
  const result = await fix.collect(['so_pair_a', 'so_pair_b']);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.status, 'collected');
  assert.deepEqual(result.artifacts.map(a => a.remote_task_id).sort(), ['so_pair_a', 'so_pair_b']);
  assert.notEqual(result.artifacts[0].id, result.artifacts[1].id);
  assert.notEqual(result.artifacts[0].path, result.artifacts[1].path);
  assert.ok(result.artifacts.every(a => a.technical_review.human_listen.accepted === false), 'each take still needs its own human listen');
});

test('#15 one song of a pair failing is partial: the good take is kept, the failure stays attached to its own song', async t => {
  for (const [label, songs, routes, code] of [
    ['remote failed', { so_pair_b: { status: 'failed' } }, {}, 'TASK_NOT_SUCCEEDED'],
    ['still generating', { so_pair_b: { status: 'running' } }, {}, 'TASK_NOT_SUCCEEDED'],
    ['download error', { so_pair_b: { local_audio: '/data/broken.mp3' } }, { '/data/broken.mp3': { status: 500, body: Buffer.from('x') } }, 'DOWNLOAD_HTTP'],
  ]) {
    const fix = await fixture(t, { songs, routes });
    const result = await fix.collect(['so_pair_a', 'so_pair_b']);
    assert.equal(result.ok, false, label);
    assert.equal(result.status, 'partial', label + ' is never reported as collected');
    assert.deepEqual(result.artifacts.map(a => a.remote_task_id), ['so_pair_a'], label);
    assert.deepEqual(result.errors.map(e => [e.remote_task_id, e.code]), [['so_pair_b', code]], label);
  }
});

test('#15 retrying a partial pair reuses the good take and only fetches the missing one', async t => {
  let broken = true;
  const fix = await fixture(t, { songs: { so_pair_b: { local_audio: '/data/later.mp3' } }, routes: { '/data/later.mp3': (req, res, bytes) => {
    if (broken) { res.writeHead(503, { 'Content-Type': 'text/plain' }); return res.end('busy'); }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.normal.length }); res.end(bytes.normal);
  } } });
  const first = await fix.collect(['so_pair_a', 'so_pair_b']);
  assert.equal(first.status, 'partial');
  broken = false;
  const second = await fix.collect(['so_pair_a', 'so_pair_b']);
  assert.equal(second.status, 'collected', JSON.stringify(second.errors));
  assert.equal(second.reused, 1, 'the already verified take is not downloaded again');
  assert.equal(second.downloaded, 1);
  assert.equal(second.artifacts.find(a => a.remote_task_id === 'so_pair_a').id, first.artifacts[0].id);
  assert.ok(fix.requests.every(r => r.method === 'GET'), 'a retry never re-generates');
});
