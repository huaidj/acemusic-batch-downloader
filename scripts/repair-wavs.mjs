// Repair WAV files only. Every remote request in this script is GET.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../agent/lib/config.mjs';
import { listSongs, getLossyModels, loadSession } from '../agent/lib/ace.mjs';
import { loadShared } from '../agent/lib/shared.mjs';
import { inspectAudioFile } from '../agent/lib/audio-library.mjs';

const { N, P } = loadShared();
const RANGE_BYTES = 65536;
const RAYBURST = 'C:\\Program Files\\Rayburst\\aria2-next.exe';
const SCHEMA = 'ace_verified_audio_v1';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problem = (code, message, status) => Object.assign(new Error(message), { code, status });
const safeReason = (err) => err?.status ? `HTTP ${err.status}` : ({ AUDIO_INVALID: 'WAV 結構或檔案長度不完整', SOURCE_CHANGED: '下載結果與來源大小或首尾不一致', NO_SESSION: '缺少本機登入狀態', AUTH_EXPIRED: '本機登入已過期', LOCKED: '已有另一個 WAV 修復工作', INVALID_MANIFEST: '驗證紀錄無法讀取，原檔已保留' }[err?.code] || '網路或檔案處理失敗（原檔已保留）');

function targetUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw problem('BAD_URL', '來源網址格式不正確'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\r\n]/.test(url.href)) throw problem('BAD_URL', '來源網址不受支援');
  return url;
}

async function safeGet(value, { cfg, session, range, timeoutMs = 120000 }) {
  let current = targetUrl(value, cfg.baseUrl);
  const accountOrigin = new URL(cfg.baseUrl).origin;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const headers = { Accept: '*/*', 'User-Agent': session.ua || cfg.ua || 'HuaiDJ-WAV-Repair' };
    if (current.origin === accountOrigin && session.cookie) headers.Cookie = session.cookie;
    if (range) headers.Range = range;
    const response = await fetch(current, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw problem('REDIRECT_LIMIT', '來源轉址過多');
      current = targetUrl(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw problem(response.status === 401 || response.status === 403 ? 'AUTH_EXPIRED' : 'HTTP_ERROR', `HTTP ${response.status}`, response.status);
    }
    return { response, finalUrl: current.href };
  }
  throw problem('REDIRECT_LIMIT', '來源轉址過多');
}

async function retry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(attempt); } catch (err) {
      const retryable = !err.status ? ['TypeError', 'TimeoutError', 'AbortError'].includes(err.name) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(err.code) : err.status >= 500 && err.status <= 599;
      if (!retryable || attempt >= 2) throw err;
      await pause(500 * (attempt + 1));
    }
  }
}

async function boundedBody(response, limit, exact = false) {
  if (!response.body) throw problem('EMPTY_RESPONSE', '來源沒有檔案內容');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const keep = Math.min(value.byteLength, limit - size);
      chunks.push(Buffer.from(value.subarray(0, keep)));
      size += keep;
      if (keep < value.byteLength) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (exact && size !== limit) throw problem('SOURCE_CHANGED', '來源範圍不完整');
  return Buffer.concat(chunks, size);
}

async function resolveWav(song, context) {
  if (song.capability !== 'music_generate' && /\.wav(?:[?#]|$)/i.test(String(song.local_audio || ''))) {
    return targetUrl(song.local_audio, context.cfg.baseUrl).href;
  }
  const songId = song.task_id;
  const direct = `${context.cfg.baseUrl}/api/songs/${encodeURIComponent(songId)}/file?kind=wav`;
  const { response } = await retry(() => safeGet(direct + '&as=parts', context));
  if (!/json/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    return direct;
  }
  const buffer = await boundedBody(response, 1048576);
  let body;
  try { body = JSON.parse(buffer.toString('utf8')); } catch { throw problem('BAD_RESPONSE', '站點下載回應無法解析'); }
  if (body?.server) return direct;
  const value = typeof body?.audio === 'string' ? body.audio : typeof body?.url === 'string' ? body.url : '';
  return value ? targetUrl(value, context.cfg.baseUrl).href : direct;
}

async function remoteRange(url, start, end, context) {
  const { response, finalUrl } = await retry(() => safeGet(url, { ...context, range: `bytes=${start}-${end}`, timeoutMs: 60000 }));
  let total;
  let length;
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!match || Number(match[1]) !== start || Number(match[2]) < start || Number(match[2]) > end) { await response.body?.cancel(); throw problem('BAD_RANGE', '來源範圍回應不正確'); }
    total = Number(match[3]);
    length = Number(match[2]) - start + 1;
  } else if (response.status === 200 && start === 0) {
    total = Number(response.headers.get('content-length'));
    length = Math.min(end + 1, total);
  } else {
    await response.body?.cancel();
    throw problem('BAD_RANGE', '來源不支援指定的檔案範圍');
  }
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(length) || length <= 0 || length > RANGE_BYTES || start + length > total) { await response.body?.cancel(); throw problem('BAD_LENGTH', '來源檔案大小不明'); }
  return { bytes: await boundedBody(response, length, true), total, finalUrl };
}

async function readSlice(file, start, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function validWav(file, expected) {
  const inspected = await inspectAudioFile(file);
  if (inspected.format !== 'wav' || inspected.validity !== 'valid' || inspected.bytes !== expected) throw problem('AUDIO_INVALID', 'WAV 結構或檔案長度不完整');
  return inspected;
}

async function readManifest(file) {
  try {
    const value = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (value?.schema !== SCHEMA || !Array.isArray(value.files)) throw problem('INVALID_MANIFEST', '驗證紀錄格式不正確');
    return value;
  } catch (err) {
    if (err.code === 'ENOENT') return { schema: SCHEMA, files: [] };
    throw problem('INVALID_MANIFEST', '驗證紀錄無法讀取');
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    await fsp.rename(temporary, file);
  } finally { await fsp.unlink(temporary).catch((err) => { if (err.code !== 'ENOENT') throw err; }); }
}

async function downloadNode(url, partBase, total, context) {
  let successful;
  await retry(async (attempt) => {
    const part = `${partBase}.node-${attempt}.part`;
    const { response } = await safeGet(url, { ...context, timeoutMs: 300000 });
    if (response.status !== 200) { await response.body?.cancel(); throw problem('BAD_RESPONSE', '完整下載未回傳完整檔案'); }
    const declared = Number(response.headers.get('content-length'));
    if (declared && declared !== total) { await response.body?.cancel(); throw problem('SOURCE_CHANGED', '來源大小在下載時改變'); }
    if (!response.body) throw problem('EMPTY_RESPONSE', '來源沒有檔案內容');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part, { flags: 'wx' }));
    await validWav(part, total);
    successful = part;
  });
  return successful;
}

async function downloadRayburst(url, part, context) {
  if (new URL(url).origin === new URL(context.cfg.baseUrl).origin || !fs.existsSync(RAYBURST)) return false;
  if (/[\r\n]/.test(url + part)) return false;
  return new Promise((resolve) => {
    const child = spawn(RAYBURST, ['--no-conf=true', '--enable-rpc=false', '--input-file=-', '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=false', '--file-allocation=none', '--max-tries=2', '--retry-wait=2', '--max-connection-per-server=4', '--split=4', '--console-log-level=error', '--summary-interval=0', '--download-result=hide'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 600000);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
    child.stdin.on('error', () => {});
    // Signed CDN URL stays on stdin and is never placed in argv or logs.
    child.stdin.end(`${url}\n  dir=${path.dirname(part)}\n  out=${path.basename(part)}\n`);
  });
}

async function copyNew(source, directory, basename) {
  await fsp.mkdir(directory, { recursive: true });
  for (let index = 0; index < 10000; index += 1) {
    const target = path.join(directory, `${basename}${index ? ` (${index + 1})` : ''}.wav`);
    try { await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL); return target; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  throw problem('NAME_CONFLICT', '同名檔案過多，所有原件均保留');
}

function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

export async function repairWavs({ cfg = config(), workDir, concurrency = 2, onProgress, useRayburst = true, dryRun = true, songIds = [], auditPath: _auditPath } = {}) {
  const songs = await listSongs(cfg, { refresh: true });
  const lossyModels = await getLossyModels(cfg);
  const supported = songs.filter((song) => P.isDone(song) && P.supportsWav(song, lossyModels));
  const selectedIds = new Set(songIds);
  const eligible = selectedIds.size ? supported.filter((song) => selectedIds.has(song.task_id)) : supported;
  const report = { schema: 'ace_wav_repair_result_v1', startedAt: new Date().toISOString(), dryRun: !!dryRun, totalSongs: songs.length, eligible: eligible.length, modelUnavailable: songs.length - supported.length, done: 0, reused: 0, downloaded: 0, failed: 0, items: [] };
  const emit = (value) => { try { onProgress?.(value); } catch { /* A display callback must not interrupt file verification. */ } };
  if (dryRun) {
    report.items = eligible.map((song) => ({ task_id: song.task_id, title: song.meta?.title || 'Untitled', action: 'verify_or_download_wav' }));
    emit({ type: 'plan', eligible: report.eligible, modelUnavailable: report.modelUnavailable, dryRun: true });
    return report;
  }
  // 工作目錄要明確指定的絕對路徑，且不能在下載資料夾內（半成品不得落進曲庫）；不再限定特定磁碟代號。
  if (!workDir || !path.isAbsolute(workDir)) throw problem('WORK_DIR_REQUIRED', '實際修復必須指定絕對路徑的工作目錄');
  if (inside(cfg.downloadDir, path.resolve(workDir))) throw problem('WORK_DIR_REQUIRED', '工作目錄不能放在下載資料夾內');
  const work = path.resolve(workDir);
  await fsp.mkdir(work, { recursive: true });
  await fsp.mkdir(cfg.stateDir, { recursive: true });
  const lockPath = path.join(cfg.stateDir, 'verified-audio.lock');
  let lock;
  try { lock = await fsp.open(lockPath, 'wx'); } catch (err) { if (err.code === 'EEXIST') throw problem('LOCKED', '已有另一個 WAV 修復工作'); throw err; }
  const lockToken = crypto.randomBytes(16).toString('hex');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: lockToken, startedAt: report.startedAt }));
    const session = await loadSession(cfg);
    const context = { cfg, session };
    const manifestPath = path.join(cfg.stateDir, 'verified-audio.json');
    const manifest = await readManifest(manifestPath);
    const destination = path.join(cfg.downloadDir, 'ai音樂', '成品WAV');
    let writeChain = Promise.resolve();
    let cursor = 0;
    const record = async (entry) => {
      const task = writeChain.then(async () => {
        manifest.files = manifest.files.filter((old) => !(old.task_id === entry.task_id && old.kind === 'wav'));
        manifest.files.push(entry);
        manifest.savedAt = new Date().toISOString();
        await writeJsonAtomic(manifestPath, manifest);
      });
      writeChain = task.catch(() => {});
      await task;
    };
    const worker = async () => {
      while (cursor < eligible.length) {
        const song = eligible[cursor++];
        const title = song.meta?.title || 'Untitled';
        const item = { task_id: song.task_id, title };
        try {
          const source = await resolveWav(song, context);
          const first = await remoteRange(source, 0, RANGE_BYTES - 1, context);
          const tailStart = Math.max(0, first.total - RANGE_BYTES);
          const last = tailStart === 0 ? first : await remoteRange(source, tailStart, first.total - 1, context);
          if (last.total !== first.total) throw problem('SOURCE_CHANGED', '來源大小在檢查時改變');
          let verified;
          for (const candidate of manifest.files.filter((entry) => entry.task_id === song.task_id && entry.kind === 'wav' && typeof entry.absolute === 'string' && inside(cfg.downloadDir, entry.absolute))) {
            try {
              await validWav(candidate.absolute, first.total);
              const [head, tail, hash] = await Promise.all([readSlice(candidate.absolute, 0, first.bytes.length), readSlice(candidate.absolute, tailStart, last.bytes.length), sha256(candidate.absolute)]);
              // 指紋清除是就地等長改寫：首段 metadata 與來源不同，但整檔 sha256 仍等於已更新的 proof，長度也等於來源 → 視為同一份，不重下載。
              const strippedProof = !!candidate.fingerprintStripAt && !!candidate.sha256 && candidate.sha256 === hash;
              if (!strippedProof && (!head.equals(first.bytes) || !tail.equals(last.bytes) || (candidate.sha256 && candidate.sha256 !== hash))) continue;
              verified = { absolute: candidate.absolute, sha256: hash, verification: strippedProof ? 'proof_sha_after_fingerprint_strip' : 'source_ranges_and_riff', reused: true };
              break;
            } catch { /* A mismatched old file is preserved and replaced by a new, distinct file. */ }
          }
          if (!verified) {
            const taskKey = crypto.createHash('sha256').update(String(song.task_id)).digest('hex').slice(0, 16);
            const partBase = path.join(work, `${taskKey}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
            let part = `${partBase}.rayburst.part`;
            let engineDone = useRayburst && await downloadRayburst(first.finalUrl, part, context);
            if (engineDone) {
              try { await validWav(part, first.total); } catch { engineDone = false; }
            }
            if (!engineDone) part = await downloadNode(source, partBase, first.total, context);
            const [head, tail, hash] = await Promise.all([readSlice(part, 0, first.bytes.length), readSlice(part, tailStart, last.bytes.length), sha256(part)]);
            if (!head.equals(first.bytes) || !tail.equals(last.bytes)) throw problem('SOURCE_CHANGED', '下載內容與來源不一致');
            verified = { absolute: part, sha256: hash, verification: 'download_and_riff', reused: false };
          }
          let absolute = verified.absolute;
          if (path.resolve(path.dirname(absolute)).toLowerCase() !== path.resolve(destination).toLowerCase()) {
            const tail = String(song.task_id).replace(/[^a-z0-9]/ig, '').slice(-8) || crypto.createHash('sha256').update(String(song.task_id)).digest('hex').slice(-8);
            absolute = await copyNew(absolute, destination, `${N.sanitizeComponent(title, 80) || 'Untitled'} [${tail}]`);
            await validWav(absolute, first.total);
            if (await sha256(absolute) !== verified.sha256) throw problem('SOURCE_CHANGED', '落檔校驗未通過');
          }
          const entry = { task_id: song.task_id, kind: 'wav', absolute, path: path.relative(cfg.downloadDir, absolute).split(path.sep).join('/'), bytes: first.total, sha256: verified.sha256, verifiedAt: new Date().toISOString(), sourceExpectedBytes: first.total, verification: verified.verification };
          await record(entry);
          if (!verified.reused && inside(work, verified.absolute)) await fsp.unlink(verified.absolute);
          Object.assign(item, { ok: true, action: verified.reused ? 'reused' : 'downloaded', absolute, bytes: first.total, sha256: verified.sha256 });
          report.done += 1;
          report[verified.reused ? 'reused' : 'downloaded'] += 1;
        } catch (err) {
          Object.assign(item, { ok: false, error: safeReason(err), code: /^[A-Z0-9_]{1,50}$/.test(String(err.code || '')) ? err.code : 'REPAIR_FAILED', ...(err.status ? { httpStatus: err.status } : {}) });
          report.failed += 1;
        }
        report.items.push(item);
        emit({ type: 'song', done: report.done, total: report.eligible, reused: report.reused, downloaded: report.downloaded, failed: report.failed, ...item });
        await writeJsonAtomic(path.join(work, 'repair-result.json'), { ...report, updatedAt: new Date().toISOString() });
      }
    };
    const width = Math.max(1, Math.min(4, Math.floor(Number(concurrency) || 2)));
    // 不可在其他 worker 仍寫檔時提前釋放全程序鎖。
    const workers = await Promise.allSettled(Array.from({ length: Math.min(width, eligible.length) }, worker));
    const rejected = workers.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    await writeChain;
    report.finishedAt = new Date().toISOString();
    await writeJsonAtomic(path.join(work, 'repair-result.json'), report);
    emit({ type: 'complete', done: report.done, total: report.eligible, reused: report.reused, downloaded: report.downloaded, failed: report.failed });
    return report;
  } finally {
    await lock.close();
    try {
      const current = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
      if (current.token === lockToken) await fsp.unlink(lockPath);
    } catch { /* Never remove a lock that is no longer this process's lock. */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const known = new Set(['--commit', '--work-dir', '--concurrency', '--no-rayburst', '--song']);
  for (let index = 0; index < args.length; index += 1) {
    if (!known.has(args[index])) throw new Error('不支援的參數');
    if (['--work-dir', '--concurrency', '--song'].includes(args[index])) index += 1;
  }
  repairWavs({ dryRun: !args.includes('--commit'), workDir: value('--work-dir'), concurrency: Number(value('--concurrency') || 2), songIds: String(value('--song') || '').split(',').filter(Boolean), useRayburst: !args.includes('--no-rayburst'), onProgress: (event) => console.log(JSON.stringify(event)) })
    .then((report) => { if (report.failed) process.exitCode = 1; })
    .catch((err) => { console.error(JSON.stringify({ ok: false, error: safeReason(err), code: err.code || 'REPAIR_FAILED' })); process.exitCode = 1; });
}
