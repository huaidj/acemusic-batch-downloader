// official.mjs — ACE Music 官方遠端 MCP 通道（OAuth 2.1 + Streamable HTTP）
//
// 為什麼需要這一層：
//   站點 session（extensions 匯出的 cookie）失效時，整條下載管線會一起停擺。
//   官方 MCP（https://acemusic.ai/mcp）用 OAuth 2.1 授權（Dynamic Client Registration +
//   PKCE S256 + loopback callback），提供歌單、單曲狀態、生成與 mp3/wav/midi 下載連結；
//   分軌（stems）與 MusicXML 官方沒有，仍得靠瀏覽器 session。
//
// 這一層只做「兜底」：站點 session 能用時照舊走站點，官方通道補上站點拿不到的部分，
//   兩邊都拿不到時給出明確錯誤碼，不假裝成功。
//
// 授權範圍（scope）：songs:read songs:create；access token 只活 60 分鐘，
//   由 ensureToken() 在快到期前用 refresh_token 續約（本地端自己續，不需要人手動按）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, readJson, writeJson, replaceFileAtomic, cachePeek, cacheWrite } from './config.mjs';

const PKG_VERSION = (() => {
    try {
        const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'manifest.json');
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || '0.0.0';
    } catch {
        return '0.0.0';
    }
})();

const SCOPE = 'songs:read songs:create';
const CLIENT_NAME = 'ACE Music Batch Downloader';
const TOKEN_SKEW_MS = 10 * 60 * 1000; // 剩不到 10 分鐘就續約
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_WAIT_MS = 90000;

/** 官方通道錯誤：一律帶 code，讓上層能分辨「沒授權」與「真的失敗」 */
export function officialError(code, message, extra = {}) {
    return Object.assign(new Error(message), { code, ...extra });
}

function origin(cfg) {
    let url;
    try { url = new URL(cfg.officialMcpUrl); } catch { throw officialError('OFFICIAL_URL_INVALID', '官方 MCP 網址無效。'); }
    const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password) {
        throw officialError('OFFICIAL_URL_INVALID', '官方 MCP 只接受不含帳密的 HTTPS 網址（本機 127.0.0.1 測試可用 HTTP）。');
    }
    return url.origin;
}

function redirectUri(cfg) {
    return `http://127.0.0.1:${Number(cfg.officialRedirectPort) || 8791}/callback`;
}

function b64url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

/* ------------------------------------------------------------------ *
 * 授權狀態（token 存檔）
 * ------------------------------------------------------------------ */

async function readAuth(cfg) {
    return (await readJson(cfg.officialAuthFile, null)) || {};
}

function tokenState(auth = {}) {
    const token = auth.token || {};
    const expiresAt = Number(token.expires_at || 0);
    const leftMs = expiresAt ? expiresAt - Date.now() : null;
    return {
        hasToken: !!token.access,
        hasRefreshToken: !!token.refresh,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        expiresInSeconds: leftMs == null ? null : Math.round(leftMs / 1000),
        fresh: !!token.access && (leftMs == null || leftMs > TOKEN_SKEW_MS),
    };
}

/** 唯讀狀態（不連網）：給 status / probe / doctor 用 */
export async function officialStatus(cfg = config()) {
    const enabled = !cfg.officialDisabled;
    const auth = enabled ? await readAuth(cfg) : {};
    const state = tokenState(auth);
    return {
        enabled,
        url: cfg.officialMcpUrl,
        authFile: cfg.officialAuthFile,
        registered: !!auth.client_id,
        authenticated: state.hasToken && state.fresh,
        ...state,
        obtainedAt: auth.token && auth.token.obtained_at ? auth.token.obtained_at : null,
    };
}

/** 有可用 token（或能續約）就回 true；只用來決定「要不要嘗試官方兜底」，不 throw */
export async function officialReady(cfg = config()) {
    if (cfg.officialDisabled) return false;
    const state = tokenState(await readAuth(cfg));
    return !!(state.hasToken && (state.fresh || state.hasRefreshToken));
}

async function storeToken(cfg, auth, payload) {
    const now = Date.now();
    const expiresIn = Number(payload.expires_in || 0);
    const token = {
        access: String(payload.access_token || ''),
        refresh: String(payload.refresh_token || (auth.token && auth.token.refresh) || ''),
        token_type: String(payload.token_type || 'Bearer'),
        scope: payload.scope || auth.scope || SCOPE,
        expires_at: expiresIn ? now + expiresIn * 1000 : 0,
        obtained_at: new Date(now).toISOString(),
    };
    if (!token.access) throw officialError('OFFICIAL_TOKEN_INVALID', '官方授權回應沒有 access_token。');
    const next = { ...auth, token, updated_at: token.obtained_at };
    await writeJson(cfg.officialAuthFile, next);
    return next;
}

/* ------------------------------------------------------------------ *
 * OAuth 2.1：DCR → PKCE authorize → loopback callback → token
 * ------------------------------------------------------------------ */

async function tokenRequest(cfg, form) {
    const doPost = (params) => fetch(`${origin(cfg)}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: params.toString(),
        signal: AbortSignal.timeout(30000),
    });
    let res = await doPost(form);
    let text = await res.text();
    if (!res.ok && form.has('resource')) {
        // 少數授權伺服器不接受 RFC 8707 的 resource 參數：拿掉再試一次。
        const retry = new URLSearchParams(form);
        retry.delete('resource');
        res = await doPost(retry);
        text = await res.text();
    }
    let data = null;
    try { data = JSON.parse(text); } catch { /* 保留原文給錯誤訊息 */ }
    if (!res.ok) {
        const detail = data && data.error ? `${data.error}${data.error_description ? '：' + data.error_description : ''}` : text.slice(0, 200);
        throw officialError('OFFICIAL_TOKEN_REJECTED', `官方授權換發 token 失敗（HTTP ${res.status}）：${detail}`, { httpStatus: res.status });
    }
    if (!data) throw officialError('OFFICIAL_TOKEN_INVALID', '官方授權回應不是 JSON。');
    return data;
}

async function registerClient(cfg, author = {}) {
    const uri = redirectUri(cfg);
    if (author.client_id && author.redirect_uri === uri) return author;
    const body = {
        client_name: CLIENT_NAME,
        redirect_uris: [uri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
    };
    const res = await fetch(`${origin(cfg)}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 同上 */ }
    if (!res.ok || !data || !data.client_id) {
        throw officialError('OFFICIAL_REGISTER_FAILED', `官方客戶端註冊失敗（HTTP ${res.status}）：${text.slice(0, 200)}`, { httpStatus: res.status });
    }
    const next = {
        ...author,
        client_id: data.client_id,
        redirect_uri: uri,
        scope: SCOPE,
        resource: cfg.officialMcpUrl,
        registered_at: new Date().toISOString(),
    };
    await writeJson(cfg.officialAuthFile, next);
    return next;
}

function openBrowser(url) {
    if (process.env.ACE_OFFICIAL_NO_BROWSER === '1') return;
    try {
        if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
        else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch { /* 瀏覽器打不開時仍會印出網址，使用者可自己貼 */ }
}

function waitForCallback(port, expectedState, timeoutMs) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://127.0.0.1:${port}`);
            if (url.pathname !== '/callback') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
            const error = url.searchParams.get('error');
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const ok = !!code && !error;
            res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><title>ACE Music 官方授權</title>
<body style="font-family:system-ui;padding:3rem;max-width:42rem">
<h1 style="font-size:1.3rem">${ok ? '授權完成，可以關閉這個視窗' : '授權失敗'}</h1>
<p>${ok ? '回到終端機／面板繼續即可。' : String(error || 'unknown') + ' ' + String(url.searchParams.get('error_description') || '')}</p>
</body>`);
            clearTimeout(timer);
            server.close();
            if (error) return reject(officialError('OFFICIAL_LOGIN_DENIED', `官方授權被拒絕：${error}`));
            if (state !== expectedState) return reject(officialError('OFFICIAL_LOGIN_STATE', '官方授權回呼的 state 不符，已中止。'));
            resolve(code);
        });
        server.on('error', (err) => {
            clearTimeout(timer);
            reject(officialError('OFFICIAL_LOGIN_PORT', `無法在 127.0.0.1:${port} 接授權回呼：${err.message}（可用 ACE_OFFICIAL_PORT 換一個埠）`));
        });
        const timer = setTimeout(() => {
            server.close();
            reject(officialError('OFFICIAL_LOGIN_TIMEOUT', `等待官方授權逾時（${Math.round(timeoutMs / 1000)} 秒）。可重跑 official login。`));
        }, timeoutMs);
        server.listen(port, '127.0.0.1', () => {
            process.stderr.write(`[ace] 等待官方授權回呼：${redirectUri({ officialRedirectPort: port })}\n`);
        });
    });
}

/**
 * 互動登入：註冊（或沿用）OAuth 客戶端 → 開瀏覽器 → 等回呼 → 換 token 存進 stateDir。
 * @returns {Promise<{url: string, redirectUri: string, expiresInSeconds: number|null}>}
 */
export async function officialLogin(cfg = config(), { open = true, timeoutMs = LOGIN_TIMEOUT_MS, onUrl = null } = {}) {
    if (cfg.officialDisabled) throw officialError('OFFICIAL_DISABLED', '官方 MCP 通道已被 ACE_OFFICIAL=0 關閉。');
    const author = await registerClient(cfg, await readAuth(cfg));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: author.client_id,
        redirect_uri: author.redirect_uri,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: cfg.officialMcpUrl,
    });
    const url = `${origin(cfg)}/oauth/authorize?${params.toString()}`;
    await writeJson(cfg.officialAuthFile, { ...author, pending: { state, verifier, created_at: new Date().toISOString() } });
    if (onUrl) onUrl(url);
    process.stderr.write(`[ace] 官方授權網址：${url}\n`);
    if (open) openBrowser(url);
    const code = await waitForCallback(Number(cfg.officialRedirectPort) || 8791, state, timeoutMs);
    const data = await tokenRequest(cfg, new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: author.redirect_uri,
        client_id: author.client_id,
        code_verifier: verifier,
        resource: cfg.officialMcpUrl,
    }));
    const next = await storeToken(cfg, { ...author, pending: undefined }, data);
    return { url, redirectUri: author.redirect_uri, expiresInSeconds: next.token.expires_at ? Math.round((next.token.expires_at - Date.now()) / 1000) : null };
}

/** 快到期就用 refresh_token 續約（本地自動，不需人手動） */
export async function officialEnsureToken(cfg = config()) {
    if (cfg.officialDisabled) throw officialError('OFFICIAL_DISABLED', '官方 MCP 通道已被 ACE_OFFICIAL=0 關閉。');
    const auth = await readAuth(cfg);
    const state = tokenState(auth);
    if (state.fresh) return auth;
    if (!state.hasRefreshToken) {
        throw officialError('OFFICIAL_AUTH_REQUIRED', '官方 MCP 需要一次授權：node agent/cli.mjs official login');
    }
    const data = await tokenRequest(cfg, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.token.refresh,
        client_id: auth.client_id,
        resource: cfg.officialMcpUrl,
    }));
    return storeToken(cfg, auth, data);
}

async function accessToken(cfg) {
    const auth = await officialEnsureToken(cfg);
    return auth.token.access;
}

/* ------------------------------------------------------------------ *
 * MCP（Streamable HTTP）
 * ------------------------------------------------------------------ */

function parseRpcBody(text, contentType) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const sse = /text\/event-stream/i.test(String(contentType || '')) || trimmed.startsWith('event:') || trimmed.startsWith('data:');
    if (sse) {
        let last = null;
        for (const block of trimmed.split(/\r?\n\r?\n/)) {
            const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (!data) continue;
            try { last = JSON.parse(data); } catch { /* 忽略壞掉的 event */ }
        }
        return last;
    }
    try { return JSON.parse(trimmed); } catch { return null; }
}

/** 從工具結果取出可用的結構化資料：優先用 structuredContent，其次從文字裡找最後一段 JSON */
function toolPayload(result) {
    if (!result) return null;
    if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    const texts = Array.isArray(result.content) ? result.content.filter((item) => item && item.type === 'text').map((item) => String(item.text || '')) : [];
    const joined = texts.join('\n').trim();
    if (!joined) return null;
    const start = joined.lastIndexOf('\n{');
    for (const candidate of [joined.slice(joined.indexOf('{')), start >= 0 ? joined.slice(start + 1) : '']) {
        if (!candidate) continue;
        try { return JSON.parse(candidate); } catch { /* 繼續試 */ }
    }
    return { text: joined };
}

async function mcpPost(cfg, payload, { timeoutMs = 60000 } = {}) {
    const token = await accessToken(cfg);
    let res;
    try {
        res = await fetch(cfg.officialMcpUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: 'Bearer ' + token,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
            throw officialError('OFFICIAL_TIMEOUT', '官方 MCP 回應逾時（歌曲不會因此消失，可用 get_song／list_songs 再接回）。', { cause: err });
        }
        throw officialError('OFFICIAL_NETWORK', '連不到官方 MCP：' + ((err && err.message) || err), { cause: err });
    }
    const text = await res.text();
    if (res.status === 401) {
        throw officialError('OFFICIAL_AUTH_EXPIRED', '官方 MCP 授權已失效：node agent/cli.mjs official login 重新授權。');
    }
    if (!res.ok) {
        throw officialError('OFFICIAL_HTTP', `官方 MCP HTTP ${res.status}：${text.slice(0, 200)}`, { httpStatus: res.status });
    }
    const body = parseRpcBody(text, res.headers.get('content-type'));
    if (!body) throw officialError('OFFICIAL_BAD_RESPONSE', '官方 MCP 回應不是可解析的 JSON-RPC。');
    if (body.error) {
        throw officialError('OFFICIAL_RPC', body.error.message || '官方 MCP 回報錯誤', { rpcError: body.error });
    }
    return body.result;
}

let handshake = null;

/** initialize + notifications/initialized（每個 process 一次） */
async function ensureHandshake(cfg) {
    if (handshake) return handshake;
    handshake = (async () => {
        const result = await mcpPost(cfg, {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acemusic-batch-downloader', version: PKG_VERSION } },
        });
        await mcpPost(cfg, { jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
        return result || {};
    })();
    handshake.catch(() => { handshake = null; });
    return handshake;
}

/** 呼叫官方 MCP 工具，回傳結構化內容 */
export async function callTool(cfg, name, args = {}, { timeoutMs = 90000 } = {}) {
    await ensureHandshake(cfg);
    const result = await mcpPost(cfg, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args },
    }, { timeoutMs });
    if (result && result.isError) {
        const detail = (Array.isArray(result.content) ? result.content.map((item) => item && item.text).filter(Boolean).join(' ') : '') || '官方工具回報錯誤';
        throw officialError('OFFICIAL_TOOL_ERROR', String(detail).slice(0, 400), { tool: name });
    }
    return toolPayload(result);
}

/* ------------------------------------------------------------------ *
 * 高階操作
 * ------------------------------------------------------------------ */

export async function officialAccount(cfg = config(), { fresh = false } = {}) {
    if (!fresh) {
        const cached = await cachePeek('official-account', { ttlMs: 60000, cfg });
        if (cached.fresh && cached.data && cached.data.account) return cached.data.account;
    }
    const account = await callTool(cfg, 'get_account', {});
    await cacheWrite('official-account', { account }, cfg).catch(() => {});
    return account;
}

export async function officialListSongs(cfg = config(), { limit = 30, cursor = '', waitMs = 0 } = {}) {
    const payload = await callTool(cfg, 'list_songs', { limit: Math.max(1, Math.min(30, Number(limit) || 30)), ...(cursor ? { cursor } : {}) });
    const songs = Array.isArray(payload && payload.songs) ? payload.songs : [];
    return { songs, nextCursor: (payload && (payload.next_cursor || payload.nextCursor)) || '' };
}

export async function officialGetSongs(cfg = config(), ids, { includeScore = false } = {}) {
    const payload = await callTool(cfg, 'get_song', { ids: (Array.isArray(ids) ? ids : [ids]).filter(Boolean), include_score: !!includeScore });
    return payload || {};
}

/** 不看剩餘時間，直接續約一次（給 CLI official refresh 用） */
export async function officialRefresh(cfg = config()) {
    const auth = await readAuth(cfg);
    if (!auth.token || !auth.token.refresh) {
        throw officialError('OFFICIAL_AUTH_REQUIRED', '官方 MCP 沒有 refresh_token：node agent/cli.mjs official login');
    }
    const data = await tokenRequest(cfg, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.token.refresh,
        client_id: auth.client_id,
        resource: cfg.officialMcpUrl,
    }));
    const next = await storeToken(cfg, auth, data);
    return tokenState(next);
}

const FORMAT_BY_KIND = { mp3: 'mp3', wav: 'wav', midi: 'midi', full: 'midi_full', midi_full: 'midi_full' };

/** 官方通道支援的檔案類型；不支援（分軌、MusicXML）回 null，由上層標成 N/A */
export function officialFormatForKind(kind) {
    return FORMAT_BY_KIND[String(kind || '').toLowerCase()] || null;
}

/** 找出文字裡的檔案連結（download_song 的結構在不同版本可能叫 url／download_url） */
function pickUrl(payload) {
    if (!payload) return '';
    for (const key of ['url', 'download_url', 'downloadUrl', 'link', 'href']) {
        if (typeof payload[key] === 'string' && /^https?:/i.test(payload[key])) return payload[key];
    }
    const text = typeof payload.text === 'string' ? payload.text : '';
    const match = text.match(/https?:\/\/[^\s)]+/);
    return match ? match[0] : '';
}

/**
 * 取得官方下載連結。
 * mp3/wav 立即回連結；midi/midi_full 站點可能要「讀取成 MIDI」（status=reading），
 * 這裡用 waitMs 輪詢（預設 90 秒），逾時丟 FILE_NOT_READY 讓上層下一輪再補。
 */
export async function officialDownloadUrl(cfg = config(), songId, kind, { waitMs = DEFAULT_WAIT_MS } = {}) {
    const format = officialFormatForKind(kind);
    if (!format) {
        throw officialError('OFFICIAL_UNSUPPORTED_KIND', `官方 MCP 不提供 ${kind}（分軌／MusicXML 仍需要瀏覽器 session）。`, { kind });
    }
    const started = Date.now();
    for (;;) {
        const payload = await callTool(cfg, 'download_song', { id: String(songId), format }, { timeoutMs: 90000 });
        const url = pickUrl(payload);
        if (url) return { url, format };
        const status = String((payload && (payload.status || payload.state)) || '').toLowerCase();
        if (status === 'reading' || status === 'pending' || status === 'processing') {
            if (Date.now() - started > waitMs) {
                throw Object.assign(officialError('FILE_NOT_READY', '官方正在把這首歌讀成 MIDI（reading），稍後再補。'), { kind });
            }
            await new Promise((resolve) => setTimeout(resolve, 20000));
            continue;
        }
        const code = payload && (payload.error || payload.code);
        if (code === 'plan_required') throw officialError('OFFICIAL_PLAN_REQUIRED', '官方下載需要付費方案（Free 方案不能下載檔案）。');
        if (code === 'insufficient_credits') throw officialError('OFFICIAL_NO_CREDITS', '官方額度不足，無法把歌曲讀成 MIDI。');
        throw officialError('OFFICIAL_NO_LINK', `官方沒有給出 ${format} 下載連結${code ? `（${code}）` : ''}。`);
    }
}

export async function officialCreateSong(cfg = config(), params = {}) {
    return callTool(cfg, 'create_song', params, { timeoutMs: 120000 });
}

export async function officialSkill(cfg = config(), name) {
    const payload = await callTool(cfg, 'get_skill', { name });
    return (payload && (payload.text || payload.skill || payload.content)) || payload;
}

/* ------------------------------------------------------------------ *
 * 相容層：官方單曲 → 站點 song 形狀
 * ------------------------------------------------------------------ */

/**
 * 站點 song 形狀是整個 planner／下載管線的契約（task_id/status/capability/model/
 * local_audio/meta/result/stems）。官方資料對得上就照著填：
 *   - local_audio 用站點慣例路徑 /data/<id>.mp3（實際抓取由官方連結兜底，不假裝檔案已在站點）
 *   - stems 一律 null：官方沒有分軌，planner 因此不會排分軌／MIDI 任務，不會誤扣額度
 */
export function officialSongToSite(row = {}) {
    if (!row || !row.id) return null;
    const id = String(row.id);
    const status = String(row.status || '').toLowerCase();
    const created = row.created_at ? Date.parse(row.created_at) : NaN;
    const duration = Number(row.duration_sec);
    return {
        task_id: id,
        status: status === 'ready' ? 'succeeded' : status || 'processing',
        capability: row.kind === 'upload' ? 'music_transcribe' : 'music_generate',
        model: row.model || null,
        local_audio: `/data/${id}.mp3`,
        local_cover: row.cover_url || null,
        meta: { title: row.title || 'Untitled' },
        result: { duration_sec: Number.isFinite(duration) ? duration : null },
        created_at: Number.isFinite(created) ? new Date(created).toISOString() : row.created_at || null,
        stems: null,
        official: true,
        official_kind: row.kind || 'song',
        official_status: status || null,
        song_page: row.song_page || null,
        instrumental: row.instrumental === true,
    };
}

/** 官方歌單 → 站點陣列（給 listSongs 兜底用） */
export function officialRowsToSongs(rows = []) {
    return (Array.isArray(rows) ? rows : []).map(officialSongToSite).filter(Boolean);
}

/** 產生授權網址但不等待（面板按「登入官方」時先顯示／開瀏覽器） */
export async function officialAuthorizeUrl(cfg = config()) {
    const author = await registerClient(cfg, await readAuth(cfg));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: author.client_id,
        redirect_uri: author.redirect_uri,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: cfg.officialMcpUrl,
    });
    return { url: `${origin(cfg)}/oauth/authorize?${params.toString()}`, state, verifier, author };
}

/** 換掉損壞的 token 檔（重登用） */
export async function officialLogout(cfg = config()) {
    try { await fs.promises.unlink(cfg.officialAuthFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    handshake = null;
    return true;
}
