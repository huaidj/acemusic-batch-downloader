import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMusicService } from './music-service.mjs';
import { MUSIC_CONTRACT, validateMusicInput } from './music-contract.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const staticFiles = new Map([
  ['/music', ['agent/public/music.html', 'text/html; charset=utf-8']],
  ['/music/', ['agent/public/music.html', 'text/html; charset=utf-8']],
  ['/music/app.js', ['agent/public/music-app.js', 'text/javascript; charset=utf-8']],
  ['/music/app.css', ['agent/public/music-app.css', 'text/css; charset=utf-8']],
  ['/music/tokens.css', ['design/tokens.css', 'text/css; charset=utf-8']],
]);
export function musicHttp({ stateDir, onEvent }) {
  let service;
  function instance() { return service ||= createMusicService({ stateDir, onEvent }); }
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
    const route = MUSIC_CONTRACT.find(c => c.path === url.pathname && c.method === req.method);
    if (!route) { json(res, 404, { ok: false, status: 'not_found', error: '未知音樂介面。' }); return true; }
    let input;
    try {
      input = route.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
      if (route.method === 'GET') for (const [key, prop] of Object.entries(route.inputSchema.properties)) if (input[key] !== undefined && ['integer', 'number'].includes(prop.type)) input[key] = Number(input[key]);
    } catch { json(res, 400, { ok: false, status: 'invalid', error: '需要有效且大小受限的 JSON。' }); return true; }
    const error = validateMusicInput(input, route.inputSchema);
    if (error) { json(res, 400, { ok: false, status: 'invalid', error }); return true; }
    const result = instance().call(route.action, input);
    const status = result.ok === false ? (result.status === 'not_found' ? 404 : result.status === 'failed' ? 500 : 422) : 200;
    json(res, status, result); return true;
  };
}
