import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMusicService } from './music-service.mjs';
import { createMusicRuntime } from './music-runtime.mjs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { MUSIC_CONTRACT, validateMusicInput } from './music-contract.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const staticFiles = new Map([
  ['/music', ['agent/public/music.html', 'text/html; charset=utf-8']],
  ['/music/', ['agent/public/music.html', 'text/html; charset=utf-8']],
  ['/music/api', ['agent/public/create-api.html', 'text/html; charset=utf-8']],
  ['/music/create-api.js', ['agent/public/create-api.js', 'text/javascript; charset=utf-8']],
  ['/music/app.js', ['agent/public/music-app.js', 'text/javascript; charset=utf-8']],
  ['/music/app.css', ['agent/public/music-app.css', 'text/css; charset=utf-8']],
  ['/music/tokens.css', ['design/tokens.css', 'text/css; charset=utf-8']],
]);
export function musicHttp({ stateDir, onEvent, cfg, createApi }) {
  let service;
  let runtime;
  const verifiedAudio = new Map();
  function instance() {
    if (!service) {
      runtime = cfg && createApi ? createMusicRuntime({ cfg, createApi }) : {};
      service = createMusicService({ stateDir, onEvent, createApi, ...runtime });
    }
    return service;
  }
  return async function handleMusic(req, res, url, { readBody, json }) {
    if (!url.pathname.startsWith('/music')) return false;
    const asset = staticFiles.get(url.pathname);
    if (asset && req.method === 'GET') {
      const body = await fs.readFile(path.join(project, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      res.end(body); return true;
    }
    const audio = /^\/music\/audio\/([A-Za-z0-9_.:-]+)$/.exec(url.pathname);
    if (audio && req.method === 'GET') {
      const result = instance().getAsset(audio[1]);
      const record = result.asset;
      if (!record || record.technical_review?.full_decode !== true) { json(res, 404, { ok: false, status: 'not_found', error: '找不到已核驗音檔。' }); return true; }
      try {
      const root = await fs.realpath(runtime.artifactsDir);
      const file = await fs.realpath(record.path);
      const rel = path.relative(root, file);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { json(res, 403, { ok: false, error: '音檔不在本中樞產物目錄。' }); return true; }
      const stat = await fs.stat(file);
      const cached = verifiedAudio.get(file);
      if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size || cached.sha256 !== record.sha256) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        if (hash.digest('hex') !== record.sha256) { json(res, 409, { ok: false, error: '音檔內容已變更，需要重新核驗。' }); return true; }
        verifiedAudio.set(file, { mtime: stat.mtimeMs, size: stat.size, sha256: record.sha256 });
      }
      const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4' }[record.format] || 'application/octet-stream';
      const range = String(req.headers.range || '');
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (range && (!match || !match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true; }
      const start = match ? match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2])) : 0;
      const end = match && match[1] && match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
      if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true; }
      res.writeHead(match ? 206 : 200, { 'Content-Type': mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) });
      const stream = createReadStream(file, { start, end });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return true;
      } catch { if (!res.headersSent) json(res, 404, { ok: false, status: 'not_found', error: '音檔目前無法讀取，請保留產物紀錄並重新核驗。' }); return true; }
    }
    const route = MUSIC_CONTRACT.find(c => c.path === url.pathname && c.method === req.method);
    if (!route) { json(res, 404, { ok: false, status: 'not_found', error: '未知音樂介面。' }); return true; }
    let input;
    try {
      input = route.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
      if (route.method === 'GET') for (const [key, prop] of Object.entries(route.inputSchema.properties)) if (input[key] !== undefined && ['integer', 'number'].includes(prop.type)) input[key] = Number(input[key]);
    } catch { json(res, 400, { ok: false, status: 'invalid', error: '需要有效且大小受限的 JSON。' }); return true; }
    const error = validateMusicInput(input, route.inputSchema);
    if (error) { json(res, 400, { ok: false, status: 'invalid', error }); return true; }
    const result = await instance().call(route.action, input);
    const status = result.ok === false ? (result.status === 'not_found' ? 404 : result.status === 'failed' ? 500 : 422) : 200;
    json(res, status, result); return true;
  };
}
