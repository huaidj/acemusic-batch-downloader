// test/unit/official.test.mjs — 官方 MCP 兜底層：官方資料 → 站點形狀、格式對映、授權狀態、MCP 客戶端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-official-'));
process.env.ACE_STATE_DIR = stateDir;
const authFile = path.join(stateDir, 'official-auth.json');
process.env.ACE_OFFICIAL_AUTH_FILE = authFile;

const Official = await import('../../agent/lib/official.mjs');

const writeAuth = (value) => fs.writeFileSync(authFile, JSON.stringify(value, null, 2), 'utf8');
const freshToken = () => ({ access: 'access-token', refresh: 'refresh-token', expires_at: Date.now() + 30 * 60 * 1000 });

test('官方單曲轉成站點形狀：完成的歌可下載、沒有分軌', () => {
    const song = Official.officialSongToSite({
        id: 'so_abc',
        title: 'Chamber of Stones',
        kind: 'song',
        status: 'ready',
        model: 'acemusic-v1.1',
        duration_sec: 149,
        cover_url: 'https://acemusic.ai/data/so_abc-cover.jpg',
        song_page: 'https://acemusic.ai/song/xyz',
        created_at: '2026-11-17T17:25:16.653Z',
    });
    assert.equal(song.task_id, 'so_abc');
    assert.equal(song.status, 'succeeded');
    assert.equal(song.capability, 'music_generate');
    assert.equal(song.local_audio, '/data/so_abc.mp3');
    assert.equal(song.local_cover, 'https://acemusic.ai/data/so_abc-cover.jpg');
    assert.equal(song.meta.title, 'Chamber of Stones');
    assert.equal(song.result.duration_sec, 149);
    assert.equal(song.stems, null);
    assert.equal(song.official, true);
    assert.equal(song.song_page, 'https://acemusic.ai/song/xyz');
});

test('未完成的歌不會被當成可下載；上傳類標成轉錄', () => {
    const pending = Official.officialSongToSite({ id: 'so_p', title: 'WIP', status: 'rendering' });
    assert.equal(pending.status, 'rendering');
    assert.equal(pending.capability, 'music_generate');
    const upload = Official.officialSongToSite({ id: 'so_u', kind: 'upload', status: 'ready' });
    assert.equal(upload.capability, 'music_transcribe');
    assert.equal(Official.officialSongToSite({}), null);
    assert.equal(Official.officialSongToSite({ title: 'no id' }), null);
});

test('官方歌單只保留有 id 的項目', () => {
    const songs = Official.officialRowsToSongs([{ id: 'a', title: 'A', status: 'ready' }, { title: 'x' }, null]);
    assert.equal(songs.length, 1);
    assert.equal(songs[0].task_id, 'a');
});

test('格式對映：分軌與 MusicXML 明確不支援', () => {
    assert.equal(Official.officialFormatForKind('mp3'), 'mp3');
    assert.equal(Official.officialFormatForKind('wav'), 'wav');
    assert.equal(Official.officialFormatForKind('midi'), 'midi');
    assert.equal(Official.officialFormatForKind('full'), 'midi_full');
    assert.equal(Official.officialFormatForKind('stems'), null);
    assert.equal(Official.officialFormatForKind('musicxml'), null);
    assert.equal(Official.officialFormatForKind(''), null);
});

test('沒授權時狀態是未授權，且 officialReady 為 false', async () => {
    fs.rmSync(authFile, { force: true });
    const status = await Official.officialStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.authenticated, false);
    assert.equal(status.hasToken, false);
    assert.equal(await Official.officialReady(), false);
});

test('token 快到期：fresh 為 false 但有 refresh_token 時官方通道仍可嘗試續約', async () => {
    writeAuth({ client_id: 'c1', token: { access: 'a', refresh: 'r', expires_at: Date.now() + 5 * 60 * 1000 } });
    const status = await Official.officialStatus();
    assert.equal(status.fresh, false);
    assert.equal(status.hasRefreshToken, true);
    assert.equal(status.authenticated, false);
    assert.equal(await Official.officialReady(), true);
});

test('有效 token：狀態顯示已授權', async () => {
    writeAuth({ client_id: 'c1', token: freshToken() });
    const status = await Official.officialStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.fresh, true);
    assert.equal(status.expiresInSeconds > 0, true);
});

test('不支援的檔案類型直接回 OFFICIAL_UNSUPPORTED_KIND，不連網', async () => {
    await assert.rejects(
        () => Official.officialDownloadUrl(undefined, 'so_1', 'stems'),
        (err) => err.code === 'OFFICIAL_UNSUPPORTED_KIND',
    );
});

/* ------------------------------------------------------------------ *
 * MCP 客戶端：本機 stub server（initialize / notifications / tools/call）
 * ------------------------------------------------------------------ */

function startStubMcp() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const body = JSON.parse(raw || '{}');
            calls.push(body);
            const send = (payload, status = 200) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            if (body.method === 'initialize') {
                return send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'stub' } } });
            }
            if (body.method === 'notifications/initialized') {
                res.writeHead(202, {});
                return res.end();
            }
            if (body.method === 'tools/call') {
                const name = body.params && body.params.name;
                if (name === 'get_account') {
                    return send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'stub account' }], structuredContent: { plan: 'artist_pro', plan_name: 'Artist Pro', credits: 42 } } });
                }
                if (name === 'list_songs') {
                    return send({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: { songs: [{ id: 'so_1', title: 'T', status: 'ready', model: 'acemusic-v1.1' }], next_cursor: '' } } });
                }
                if (name === 'download_song') {
                    return send({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: { url: 'https://example.test/file.mp3' } } });
                }
            }
            return send({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } });
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }));
    });
}

test('MCP 客戶端：握手、工具呼叫、結構化內容', async () => {
    const stub = await startStubMcp();
    process.env.ACE_OFFICIAL_MCP_URL = `http://127.0.0.1:${stub.port}/mcp`;
    writeAuth({ client_id: 'c1', token: freshToken(), resource: process.env.ACE_OFFICIAL_MCP_URL });
    const account = await Official.officialAccount(undefined, { fresh: true });
    assert.equal(account.plan, 'artist_pro');
    assert.equal(account.credits, 42);
    const list = await Official.officialListSongs(undefined, { limit: 1 });
    assert.equal(list.songs.length, 1);
    assert.equal(list.songs[0].id, 'so_1');
    const link = await Official.officialDownloadUrl(undefined, 'so_1', 'mp3', { waitMs: 0 });
    assert.equal(link.url, 'https://example.test/file.mp3');
    assert.deepEqual(stub.calls.map((call) => call.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call', 'tools/call']);
    await new Promise((resolve) => stub.server.close(resolve));
});

test('MCP 客戶端：作者欄位帶 Bearer token', async () => {
    const stub = await startStubMcp();
    process.env.ACE_OFFICIAL_MCP_URL = `http://127.0.0.1:${stub.port}/mcp`;
    writeAuth({ client_id: 'c1', token: freshToken(), resource: process.env.ACE_OFFICIAL_MCP_URL });
    let seen = '';
    const realCreate = http.createServer;
    // 直接檢查 stub 收到的請求標頭
    stub.server.on('request', (req) => { seen = String(req.headers.authorization || ''); });
    await Official.officialAccount(undefined, { fresh: true });
    assert.equal(seen, 'Bearer access-token');
    assert.equal(realCreate, http.createServer);
    await new Promise((resolve) => stub.server.close(resolve));
});
