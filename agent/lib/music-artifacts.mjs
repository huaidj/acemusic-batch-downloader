// Direct-audio collection only. No split, MIDI, transcription or generation POSTs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { loadSession } from './ace.mjs';

const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonicalModel = value => value === 'ace-step-v1.5-xl' ? 'ace-step-1.5-xl' : value;
const MODELS = new Set(['acemusic-v1', 'acemusic-v1.1', 'ace-step-1.5-xl']);
const SAFE_ERROR = Symbol('collector_safe_error');
const message = (code, text) => Object.assign(new Error(text), { code, [SAFE_ERROR]: true });
const now = () => new Date().toISOString();
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : null;

function causeCodes(error) {
  const found = new Set();
  const visit = (value, depth) => {
    if (!value || depth > 3) return;
    const code = safeCode(value.code); if (code) found.add(code);
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 5)) visit(child, depth + 1);
  };
  visit(error?.cause, 0); visit(error, 0);
  return [...found].slice(0, 8);
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)) &&
      !(a === 198 && [18, 19].includes(b)) && !(a === 198 && b === 51 && c === 100) && !(a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    if (/^::ffff:/i.test(address)) {
      const tail = address.slice(7);
      if (isIP(tail) === 4) return publicAddress(tail);
      const words = tail.split(':');
      if (words.length === 2 && words.every(word => /^[a-f0-9]{1,4}$/i.test(word))) {
        const high = parseInt(words[0], 16), low = parseInt(words[1], 16);
        return publicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
      return false;
    }
    return /^[23][a-f0-9]{0,3}:/i.test(address) && !/^2001:(?:db8|2):/i.test(address);
  }
  return false;
}

function tunFakeAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

async function boundedDnsJson(response) {
  if (!response || response.status !== 200 || response.redirected || !response.body?.getReader ||
      response.url && new URL(response.url).origin !== 'https://1.1.1.1') throw message('DOWNLOAD_REDIRECT_DNS_UNVERIFIED', '獨立 DNS 回應未通過核驗。');
  const reader = response.body.getReader(), parts = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16384) throw new Error();
      parts.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch { throw message('DOWNLOAD_REDIRECT_DNS_UNVERIFIED', '獨立 DNS 回應未通過核驗。'); }
  finally { reader.cancel().catch(() => {}); }
}

function redirectOrigins(values) {
  if (!Array.isArray(values) || values.length > 10) throw message('INVALID_COLLECTOR_CONFIG', '重新導向來源清單無效。');
  return new Set(values.map(value => {
    let url; try { url = new URL(value); } catch { throw message('INVALID_COLLECTOR_CONFIG', '重新導向來源必須是 HTTPS origin。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|onion)$/i.test(url.hostname) || isIP(url.hostname.replace(/^\[|\]$/g, '')) && !publicAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw message('INVALID_COLLECTOR_CONFIG', '重新導向來源必須是公開且無憑據的 HTTPS origin。');
    }
    return url.origin;
  }));
}

function originOf(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw message('INVALID_BASE_URL', '音訊來源網址無效。'); }
  const mock = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!mock && url.origin !== 'https://acemusic.ai') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw message('INVALID_BASE_URL', '音訊僅可來自 ACE 官方同源網址或隔離本機測試。');
  return { origin: url.origin, mock };
}

function audioUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2000 || /[\\\u0000-\u001f]|%(?:2e|2f|5c)/i.test(value)) throw message('UNSAFE_AUDIO_URL', '音訊路徑無效；不讀取外站、帶憑據或路徑穿越網址。');
  let url;
  try { url = new URL(value, origin); } catch { throw message('UNSAFE_AUDIO_URL', '音訊路徑無效。'); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/data/') || /(?:^|\/)\.\.(?:\/|$)/.test(value)) throw message('UNSAFE_AUDIO_URL', '音訊必須使用同源 /data/ 路徑。');
  return url;
}

function within(root, candidate) {
  const resolved = path.resolve(candidate), relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw message('UNSAFE_OUTPUT_PATH', '產物路徑必須位於設定的專用目錄。');
  return resolved;
}

// Check each existing ancestor before mkdir/open. In particular, never follow
// a pre-existing Windows directory junction into a different output tree.
function noLinks(candidate) {
  const absolute = path.resolve(candidate), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (err) { if (err.code === 'ENOENT') break; throw err; }
    if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(current), path.resolve(current))) throw message('OUTPUT_LINK_REJECTED', '產物目錄含連結或聯接；請使用獨立實體目錄。');
  }
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function magicFormat(header, bytes) {
  const start = header.subarray(0, 4).toString('ascii');
  if (header.length >= 12 && ['RIFF', 'RF64'].includes(start) && header.subarray(8, 12).toString('ascii') === 'WAVE') {
    if (start === 'RIFF' && header.readUInt32LE(4) + 8 > bytes) throw message('TRUNCATED_CONTAINER', 'WAV 標頭宣告的資料長度超過實際檔案。');
    return 'wav';
  }
  if (start === 'fLaC') return 'flac';
  if (start === 'OggS') return 'ogg';
  if (header.length >= 12 && start === 'FORM' && ['AIFF', 'AIFC'].includes(header.subarray(8, 12).toString('ascii'))) {
    if (header.readUInt32BE(4) + 8 > bytes) throw message('TRUNCATED_CONTAINER', 'AIFF 標頭宣告的資料長度超過實際檔案。');
    return 'aiff';
  }
  if (header.subarray(0, 3).toString('ascii') === 'ID3' || header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return 'mp3';
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  throw message('UNKNOWN_AUDIO_MAGIC', '檔案內容沒有支援的音訊容器標記。');
}

function allowedContentType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return !type || type.startsWith('audio/') || ['application/octet-stream', 'binary/octet-stream', 'application/ogg', 'video/mp4'].includes(type);
}

async function runProcess(executable, args, { timeoutMs, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child, settled = false, timer, outSize = 0, errorSize = 0;
    const stdout = [], stderr = [];
    const finish = (err, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const stop = (code, text) => { child?.kill('SIGKILL'); finish(message(code, text)); };
    try { child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return finish(message('AUDIO_TOOL_UNAVAILABLE', '無法啟動本機音訊核驗工具。')); }
    timer = setTimeout(() => stop('AUDIO_TOOL_TIMEOUT', '本機音訊核驗超時；未標記為通過。'), timeoutMs);
    child.on('error', () => finish(message('AUDIO_TOOL_UNAVAILABLE', '無法啟動本機音訊核驗工具。')));
    child.stdout.on('data', chunk => {
      if (settled) return;
      outSize += chunk.length;
      if (outSize > maxOutputBytes) return stop('AUDIO_TOOL_OUTPUT_LIMIT', '音訊核驗輸出超過上限。');
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (settled) return;
      errorSize += chunk.length;
      if (errorSize > maxOutputBytes) return stop('AUDIO_TOOL_OUTPUT_LIMIT', '音訊核驗輸出超過上限。');
      stderr.push(chunk);
    });
    child.on('close', code => {
      if (code !== 0) return finish(message('AUDIO_DECODE_FAILED', '本機工具未能完整核驗此音檔。'));
      finish(null, { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function parsedDb(value) {
  if (typeof value !== 'string') return { value: null, negativeInfinity: false };
  return { value: numeric(Number(value)), negativeInfinity: /^-inf$/i.test(value) };
}

async function inspectAudio(file, format, { ffprobe, ffmpeg, analysisTimeoutMs }) {
  const probe = await runProcess(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,duration:format=format_name,duration', '-of', 'json', file], { timeoutMs: analysisTimeoutMs });
  let data;
  try { data = JSON.parse(probe.stdout); } catch { throw message('AUDIO_PROBE_INVALID', '音訊探測未回傳有效資料。'); }
  const stream = data.streams?.find(value => value.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? stream?.duration), sampleRate = Number(stream?.sample_rate), channels = Number(stream?.channels);
  if (!stream || !Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(channels) || channels <= 0 ||
    typeof stream.codec_name !== 'string' || !/^[a-z0-9_]{1,64}$/i.test(stream.codec_name)) throw message('AUDIO_PROBE_INVALID', '無法核對音訊長度、編碼、取樣率或聲道。');
  const formats = { wav: ['wav'], mp3: ['mp3'], flac: ['flac'], ogg: ['ogg'], aiff: ['aiff'], m4a: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'] };
  if (!String(data.format?.format_name || '').split(',').some(value => formats[format].includes(value))) throw message('AUDIO_FORMAT_MISMATCH', '檔案標記與音訊探測格式不一致。');
  const decoded = await runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-xerror', '-err_detect', 'explode', '-protocol_whitelist', 'file,pipe', '-i', file,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples+Number_of_NaNs+Number_of_Infs,ebur128=framelog=verbose:peak=true', '-f', 'null', '-'], { timeoutMs: analysisTimeoutMs });
  const last = regex => [...decoded.stderr.matchAll(regex)].at(-1)?.[1];
  const samples = Number(last(/Number of samples:\s*([\d.]+)/g));
  if (!Number.isFinite(samples) || samples <= 0) throw message('AUDIO_EMPTY_DECODE', '未取得實際解碼樣本；不能標記為有效音訊。');
  const peak = parsedDb(last(/Peak level dB:\s*([-\w.]+)/g)), rms = parsedDb(last(/RMS level dB:\s*([-\w.]+)/g));
  const truePeak = parsedDb(last(/Peak:\s*([-\w.]+)\s*dBFS/g));
  const integrated = parsedDb(last(/\bI:\s*([-\w.]+)\s*LUFS/g));
  const digitalSilence = peak.negativeInfinity && rms.negativeInfinity ? true : peak.value !== null ? false : null;
  const likelySilent = peak.negativeInfinity || peak.value !== null ? peak.negativeInfinity || peak.value <= -60 : null;
  const possibleClipping = peak.value !== null ? peak.value >= -0.1 : null;
  const nans = Number(last(/Number of NaNs:\s*([\d.]+)/g)), infs = Number(last(/Number of Infs:\s*([\d.]+)/g));
  if (Number.isFinite(nans) && nans > 0 || Number.isFinite(infs) && infs > 0) throw message('AUDIO_NONFINITE_SAMPLES', '解碼樣本含非有限數值。');
  return { duration, codec: stream.codec_name, sample_rate: sampleRate, channels,
    technical_review: {
      status: likelySilent || possibleClipping ? 'technical_warning' : 'technical_pass', full_decode: true, decoder: 'ffmpeg', probe: 'ffprobe', decoded_samples: samples, decoded_duration: samples / sampleRate,
      measurements: { kind: 'measurement', peak_dbfs: peak.value, rms_dbfs: rms.value,
        integrated_lufs: samples / sampleRate >= 0.4 && digitalSilence !== true ? integrated.value : null,
        true_peak_dbfs: truePeak.value, digital_silence: digitalSilence },
      heuristics: { kind: 'heuristic', likely_silent: likelySilent,
        silence_threshold_dbfs: -60, possible_clipping: possibleClipping, clipping_threshold_dbfs: -0.1, clipped_sample_count: null },
      human_listen: { status: 'awaiting_listen', accepted: false },
      limitations: ['技術檢查不代表律動、音色或空間聽感已通過。', '峰值接近滿刻度僅為可能削波提示，不是已證實的削波樣本數。', '全檔解碼僅驗證取得的檔案；沒有來源完整長度時，無法排除所有創作層面的截斷。'],
    } };
}

export function createMusicArtifactCollector({ cfg, artifactsDir, transport, fetchImpl = globalThis.fetch, ffmpeg = process.env.ACE_FFMPEG || 'ffmpeg', ffprobe = process.env.ACE_FFPROBE || 'ffprobe',
  maxBytes = 100 * 1024 * 1024, downloadTimeoutMs = 120000, analysisTimeoutMs = 120000, allowedRedirectOrigins = [], maxRedirects = 3, resolveImpl = lookup, dnsFetchImpl = globalThis.fetch } = {}) {
  if (!OBJECT(cfg) || typeof artifactsDir !== 'string' || !path.isAbsolute(artifactsDir) || !transport || typeof transport.status !== 'function' || typeof fetchImpl !== 'function') throw message('INVALID_COLLECTOR_CONFIG', '回收器需要獨立絕對路徑、設定及唯讀任務查詢器。');
  for (const value of [maxBytes, downloadTimeoutMs, analysisTimeoutMs]) if (!Number.isSafeInteger(value) || value <= 0) throw message('INVALID_COLLECTOR_LIMITS', '回收大小與超時必須是有限正整數。');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3 || typeof resolveImpl !== 'function' || typeof dnsFetchImpl !== 'function') throw message('INVALID_COLLECTOR_LIMITS', '音訊重新導向最多三次，且需公開 DNS 核驗器。');
  const allowedOrigins = redirectOrigins(allowedRedirectOrigins);
  const { origin, mock } = originOf(cfg.baseUrl), root = path.resolve(artifactsDir);
  noLinks(root); fs.mkdirSync(root, { recursive: true }); noLinks(root);
  let chain = Promise.resolve();
  const checked = candidate => { const resolved = within(root, candidate); noLinks(resolved); return resolved; };

  async function verifyRedirectDns(url, signal, limit) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const evidence = { local_resolution: 'unknown', local_address_count: null, independent_resolution: 'not_attempted',
      route_verified: false, tls_policy: 'original_hostname_default_trust', checked_at: now() };
    let addresses;
    try { addresses = isIP(host) ? [{ address: host }] : await limit(resolveImpl(host, { all: true, verbatim: true })); }
    catch (err) { throw Object.assign(message('DOWNLOAD_REDIRECT_DNS_UNVERIFIED', '無法核對音訊來源的 DNS。'), { cause: err, dns_resolution: evidence }); }
    if (!Array.isArray(addresses) || !addresses.length) throw Object.assign(message('DOWNLOAD_REDIRECT_PRIVATE', '音訊重新導向未通過公開 DNS 核驗。'), { dns_resolution: evidence });
    evidence.local_address_count = addresses.length;
    if (addresses.every(entry => publicAddress(entry.address))) { evidence.local_resolution = 'public'; return evidence; }
    const fakeOnly = addresses.every(entry => tunFakeAddress(entry.address));
    evidence.local_resolution = fakeOnly ? 'tun_fake_ip_198_18_15' : 'private_or_mixed';
    // The fallback is deliberately confined to a server-allowlisted Cloudflare
    // R2 account endpoint. RFC1918, mixed answers and every other hostname still
    // fail closed. This validates global DNS; it never changes the TUN route or
    // disables TLS hostname/certificate verification for the subsequent fetch.
    if (!fakeOnly || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(host) || !allowedOrigins.has(url.origin)) {
      throw Object.assign(message('DOWNLOAD_REDIRECT_PRIVATE', '音訊重新導向未通過公開 DNS 核驗。'), { dns_resolution: evidence });
    }
    evidence.independent_resolution = 'unverified';
    evidence.independent_resolver = 'cloudflare_1_1_1_1_doh';
    try {
      const families = await Promise.all([1, 28].map(async type => {
        const target = new URL('https://1.1.1.1/dns-query');
        target.searchParams.set('name', host); target.searchParams.set('type', type === 1 ? 'A' : 'AAAA');
        const response = await limit(dnsFetchImpl(target.href, { method: 'GET', headers: { Accept: 'application/dns-json' }, credentials: 'omit',
          redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }));
        const data = await limit(boundedDnsJson(response));
        if (!OBJECT(data) || data.Status !== 0 || data.TC === true || !Array.isArray(data.Question) || data.Question.length !== 1 ||
            data.Question[0].type !== type || String(data.Question[0].name).replace(/\.$/, '').toLowerCase() !== host.toLowerCase() ||
            data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 64)) throw new Error();
        const answers = (data.Answer || []).filter(answer => answer.type === 1 || answer.type === 28);
        if (answers.some(answer => isIP(answer.data) !== (answer.type === 1 ? 4 : 6) || !publicAddress(answer.data))) throw new Error();
        return answers.filter(answer => answer.type === type).map(answer => answer.data);
      }));
      if (!families.flat().length) throw new Error();
      evidence.independent_resolution = 'public';
      evidence.independent_a_count = families[0].length;
      evidence.independent_aaaa_count = families[1].length;
      return evidence;
    } catch (err) {
      throw Object.assign(message('DOWNLOAD_REDIRECT_DNS_UNVERIFIED', '本機為合成 DNS 位址，但獨立公開 DNS 未核實；不取得音訊。'), { cause: err, dns_resolution: evidence });
    }
  }

  async function download(url, file) {
    let session;
    try { session = await loadSession(cfg); }
    catch { throw message('AUTH_REQUIRED', '需要有效的本機登入才能讀取音訊。'); }
    if (typeof session.cookie !== 'string' || !session.cookie || /[\r\n]/.test(session.cookie)) throw message('AUTH_REQUIRED', '需要有效的本機登入才能讀取音訊。');
    const controller = new AbortController();
    let timer, response, handle, reader, count = 0, hops = 0, stage = 'fetch_headers';
    const resolutionEvidence = [];
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(message('DOWNLOAD_TIMEOUT', '音訊下載超時；保留已取得內容以供核對。')); }, downloadTimeoutMs); });
    const limit = promise => Promise.race([promise, timeout]);
    try {
      let target = url;
      while (true) {
        stage = 'fetch_headers';
        const headers = hops === 0 ? { Accept: 'audio/*, application/octet-stream', Cookie: session.cookie, 'User-Agent': session.ua || cfg.ua || 'HuaiDJ', Origin: origin, Referer: origin + '/create/' } : { Accept: 'audio/*, application/octet-stream', 'User-Agent': 'HuaiDJ-AudioCollector/1.0' };
        response = await limit(fetchImpl(target.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal }));
        if (response.redirected) throw message('DOWNLOAD_REDIRECT_UNEXPECTED', '音訊來源發生未核准的自動重新導向。');
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        stage = 'redirect_validation';
        if (hops >= maxRedirects) throw message('DOWNLOAD_REDIRECT_LIMIT', '音訊重新導向超過允許次數，未取得成功產物。');
        const location = response.headers.get('location');
        let next;
        try { if (!location || location.length > 8192) throw new Error(); next = new URL(location, target); } catch { throw message('DOWNLOAD_REDIRECT_INVALID', '音訊重新導向缺少可核驗網址。'); }
        if (next.username || next.password || next.hash || next.origin !== origin && (next.protocol !== 'https:' || !allowedOrigins.has(next.origin)) || next.origin === origin && !next.pathname.startsWith('/data/')) {
          throw message('DOWNLOAD_REDIRECT_NOT_ALLOWED', '音訊重新導向來源未獲伺服器允許；未轉交登入資料。');
        }
        if (next.origin !== origin) {
          stage = 'redirect_dns';
          resolutionEvidence.push(await verifyRedirectDns(next, controller.signal, limit));
        }
        await limit(response.body?.cancel());
        target = next; hops++;
      }
      stage = 'response_headers';
      if (response.status !== 200 || response.redirected) throw message('DOWNLOAD_HTTP', '音訊下載沒有回傳完整的成功內容。');
      if (response.url && new URL(response.url).origin !== target.origin) throw message('DOWNLOAD_REDIRECT_UNEXPECTED', '音訊回應來源與已核准下載來源不同。');
      const contentType = response.headers.get('content-type');
      if (!allowedContentType(contentType)) throw message('DOWNLOAD_CONTENT_TYPE', '來源回傳的內容類型不是音訊或二進位檔案。');
      const rawLength = response.headers.get('content-length');
      const length = rawLength === null ? null : /^\d+$/.test(rawLength) ? Number(rawLength) : NaN;
      if (length !== null && (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes)) throw message('DOWNLOAD_SIZE_LIMIT', '來源檔案大小無效或超過回收上限。');
      if (!response.body || typeof response.body.getReader !== 'function') throw message('DOWNLOAD_BODY_MISSING', '來源沒有提供可讀取的音訊內容。');
      stage = 'file_open';
      handle = await fsp.open(checked(file), 'wx', 0o600);
      reader = response.body.getReader();
      stage = 'body_stream';
      const hash = createHash('sha256');
      let header = Buffer.alloc(0);
      while (true) {
        const part = await limit(reader.read());
        if (part.done) break;
        const chunk = Buffer.from(part.value);
        if (count + chunk.length > maxBytes) throw message('DOWNLOAD_SIZE_LIMIT', '串流音訊超過回收大小上限。');
        let offset = 0;
        while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw message('DOWNLOAD_WRITE_FAILED', '無法保存完整音訊內容。'); offset += result.bytesWritten; }
        hash.update(chunk); count += chunk.length;
        if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)]);
      }
      if (!count || length !== null && length !== count) throw message('DOWNLOAD_TRUNCATED', '音訊下載長度與來源宣告不符。');
      stage = 'file_sync'; await handle.sync();
      return { sha256: hash.digest('hex'), bytes: count, format: magicFormat(header, count), content_type: contentType || null, content_length: length,
        ...(resolutionEvidence.length ? { redirect_dns_evidence: resolutionEvidence } : {}) };
    } catch (err) {
      const codes = causeCodes(err);
      const error = controller.signal.aborted ? message('DOWNLOAD_TIMEOUT', '音訊下載超時；保留已取得內容以供核對。') : err?.[SAFE_ERROR] ? err : message('DOWNLOAD_INTERRUPTED', '音訊連線或串流中斷；保留已取得內容，未標記成功。');
      throw Object.assign(error, { download_stage: stage, received_bytes: count, redirect_hops: hops,
        cause_code: codes[0] || null, ...(codes.length > 1 ? { cause_codes: codes } : {}),
        ...(err?.dns_resolution ? { dns_resolution: err.dns_resolution } : resolutionEvidence.length ? { dns_resolution: resolutionEvidence.at(-1) } : {}),
        ...(Number.isInteger(response?.status) ? { http_status: response.status } : {}) });
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) reader.cancel().catch(() => {});
      else if (response?.body) response.body.cancel().catch(() => {});
      if (handle) await handle.close();
    }
  }

  async function failureEvidence(task, sourceJob, err, partial) {
    const error = { remote_task_id: task, code: safeCode(err?.code) || 'COLLECTION_FAILED', message: err?.[SAFE_ERROR] ? err.message : '音訊回收未完成；原始錯誤內容不對外顯示。' };
    for (const key of ['download_stage', 'received_bytes', 'redirect_hops', 'http_status', 'cause_code', 'cause_codes', 'dns_resolution']) if (err?.[key] !== undefined) error[key] = err[key];
    try {
      const evidencePath = checked(path.join(root, 'failure-' + randomUUID() + '.json'));
      const evidence = { ...error, source_job: sourceJob, at: now(), partial_path: partial && fs.existsSync(checked(partial)) ? partial : null };
      await fsp.writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
      error.evidence_path = evidencePath;
    } catch { /* returning a concrete failure must not depend on diagnostics */ }
    return error;
  }

  async function collectNow(input) {
    const fields = new Set(['task_ids', 'requested_model', 'source_job', 'rights_snapshot', 'parent_ids']);
    if (!OBJECT(input) || Object.keys(input).some(key => !fields.has(key)) || !Array.isArray(input.task_ids) || !input.task_ids.length || input.task_ids.length > 10 || input.task_ids.some(id => typeof id !== 'string' || !ID.test(id)) ||
      !MODELS.has(canonicalModel(input.requested_model)) || typeof input.source_job !== 'string' || !ID.test(input.source_job) ||
      input.parent_ids !== undefined && (!Array.isArray(input.parent_ids) || input.parent_ids.length > 50 || input.parent_ids.some(id => typeof id !== 'string' || !ID.test(id))) ||
      input.rights_snapshot !== undefined && (!OBJECT(input.rights_snapshot) || JSON.stringify(input.rights_snapshot).length > 8192)) return { ok: false, status: 'invalid', artifacts: [], errors: [{ code: 'INVALID_COLLECTION_INPUT', message: '需要精確任務識別、模型、來源任務與有限的權利及父代資料。' }], downloaded: 0, reused: 0 };
    const tasks = [...new Set(input.task_ids)], model = canonicalModel(input.requested_model), artifacts = [], errors = [];
    let status;
    try { status = await transport.status({ task_ids: tasks, requested_model: model }); }
    catch { return { ok: false, status: 'failed', artifacts, errors: [{ code: 'TASK_STATUS_UNAVAILABLE', message: '無法獨立核對原生成任務；未下載音訊。' }], downloaded: 0, reused: 0 }; }
    if (!status || status.ok !== true || !Array.isArray(status.songs)) return { ok: false, status: 'failed', artifacts, errors: [{ code: 'TASK_STATUS_INVALID', message: '原任務狀態缺少可核驗的歌曲紀錄。' }], downloaded: 0, reused: 0 };
    let downloaded = 0, reused = 0;
    for (const task of tasks) {
      let staging;
      try {
        noLinks(root);
        const matches = status.songs.filter(song => OBJECT(song) && song.task_id === task);
        if (matches.length !== 1) throw message('TASK_STATUS_AMBIGUOUS', '任務紀錄缺失或重複；不能猜測回收對象。');
        const song = matches[0];
        if (song.status !== 'succeeded') throw message('TASK_NOT_SUCCEEDED', '原任務尚未成功完成；不回收為候選音訊。');
        if (canonicalModel(song.model) !== model) throw message('MODEL_MISMATCH', '實際模型與審閱模型不符；不回收為成功產物。');
        const url = audioUrl(song.local_audio, origin);
        staging = checked(path.join(root, '.incoming-' + randomUUID() + '.part'));
        const integrity = await download(url, staging);
        const analysis = await inspectAudio(staging, integrity.format, { ffmpeg, ffprobe, analysisTimeoutMs });
        if (await fileHash(checked(staging)) !== integrity.sha256) throw message('STAGING_HASH_CHANGED', '核驗期間音訊內容已改變；不寫入產物。');
        const directory = checked(path.join(root, 'task-' + sha(task).slice(0, 24)));
        await fsp.mkdir(directory, { recursive: true }); checked(directory);
        const finalPath = checked(path.join(directory, integrity.sha256 + '.' + integrity.format));
        const sidecar = checked(path.join(directory, integrity.sha256 + '.json'));
        let existing;
        try { existing = JSON.parse(await fsp.readFile(sidecar, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw message('ARTIFACT_RECORD_CONFLICT', '既有產物紀錄無法核對；保留原件。'); }
        const id = 'artifact_' + sha(task + ':' + integrity.sha256);
        if (existing && (existing.id !== id || existing.remote_task_id !== task || existing.sha256 !== integrity.sha256 || typeof existing.path !== 'string' || !samePath(existing.path, finalPath) ||
          existing.real_or_mock !== (mock ? 'mock' : 'real') || existing.requested_model !== model || existing.actual_model !== model ||
          existing.format !== integrity.format || existing.bytes !== integrity.bytes || existing.codec !== analysis.codec || existing.sample_rate !== analysis.sample_rate || existing.channels !== analysis.channels ||
          !existing.technical_review?.full_decode || existing.technical_review.evidence_scope !== (mock ? 'isolated_mock_provider' : 'downloaded_provider_artifact'))) throw message('ARTIFACT_RECORD_CONFLICT', '既有產物紀錄與內容不一致；保留原件。');
        let alreadyPresent = false;
        try { await fsp.link(checked(staging), checked(finalPath)); }
        catch (err) { if (err.code !== 'EEXIST') throw err; alreadyPresent = true; }
        if (await fileHash(checked(finalPath)) !== integrity.sha256) throw message('ARTIFACT_HASH_CONFLICT', '既有同名產物內容不同；不覆寫原件。');
        const artifact = existing || { id, path: finalPath, sha256: integrity.sha256, format: integrity.format, bytes: integrity.bytes, duration: analysis.duration,
          codec: analysis.codec, sample_rate: analysis.sample_rate, channels: analysis.channels, source_job: input.source_job, remote_task_id: task,
          requested_model: model, actual_model: canonicalModel(song.model), rights_snapshot: input.rights_snapshot ? JSON.parse(JSON.stringify(input.rights_snapshot)) : { status: 'unknown', commercial_use: 'unknown', plan: null },
          parent_ids: [...new Set(input.parent_ids || [])], technical_review: { ...analysis.technical_review, integrity, evidence_scope: mock ? 'isolated_mock_provider' : 'downloaded_provider_artifact', verified_at: now() },
          real_or_mock: mock ? 'mock' : 'real', created_at: now() };
        if (!existing) await fsp.writeFile(checked(sidecar), JSON.stringify(artifact, null, 2), { flag: 'wx', mode: 0o600 });
        await fsp.unlink(checked(staging)); staging = null;
        artifacts.push(artifact);
        if (alreadyPresent || existing) reused += 1; else downloaded += 1;
      } catch (err) { errors.push(await failureEvidence(task, input.source_job, err, staging)); }
    }
    return { ok: errors.length === 0, status: errors.length ? artifacts.length ? 'partial' : 'failed' : 'collected', artifacts, errors, downloaded, reused };
  }
  return { collect(input) {
    const task = chain.then(() => collectNow(input)).catch(() => ({ ok: false, status: 'failed', artifacts: [], errors: [{ code: 'COLLECTION_FAILED', message: '本機回收未完成；既有檔案保留。' }], downloaded: 0, reused: 0 }));
    chain = task.then(() => undefined);
    return task;
  } };
}
