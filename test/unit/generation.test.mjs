import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateSong, generationStatus, prepareGenerationRequest } from '../../agent/lib/ace.mjs';

async function fixture(t, options = {}) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-generation-'));
    const cookie = 'test_session=private-cookie-value';
    fs.writeFileSync(path.join(stateDir, 'session.json'), JSON.stringify({ cookie, ua: 'Test UA' }));
    const calls = [];
    const status = { ok: true, costs: { song: 4 }, models: [{ id: 'acemusic-v1.1', limits: { prompt: 2000, style: 1000, lyrics: 5000 } }], user: { credits: 12, plan: 'artist', email: 'private@example.test', name: 'Private Name' } };
    const server = http.createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += chunk;
        calls.push({ url: req.url, method: req.method, headers: req.headers, body: text ? JSON.parse(text) : undefined });
        if (options.handler && await options.handler(req, res, calls.at(-1))) return;
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/status') { res.end(JSON.stringify(options.status || status)); return; }
        if (req.url.startsWith('/api/songs?')) { res.end(JSON.stringify(options.songs || { items: [] })); return; }
        res.end(JSON.stringify(options.result || { song: { task_id: 'so_first', model: 'acemusic-v1.1', status: 'queued' }, songs: [{ task_id: 'so_second', model: 'acemusic-v1.1', status: 'planning' }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}`, stateDir, sessionFile: path.join(stateDir, 'session.json'), ua: 'Fallback UA' };
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        if (path.resolve(stateDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(stateDir, { recursive: true, force: true });
    });
    return { cfg, calls, status, cookie };
}

const paid = { dry_run: false, confirm_credit_spend: true, max_credits: 4, idempotency_key: 'generation-test-1' };

test('canonical request is pure and stable without a session or live balance', () => {
    const input = { style: '  house  ', title: 'Demo', ...paid };
    const first = prepareGenerationRequest(input);
    assert.deepEqual(first, prepareGenerationRequest({ ...input, max_credits: 50, idempotency_key: 'different-key', request_created_at: 1770000000000 }));
    assert.equal(first.endpoint, '/api/custom');
    assert.equal(first.body.style, 'house');
    assert.equal('created_at' in first.body, false);
    assert.equal('request_created_at' in first, false);
    assert.equal(input.style, '  house  ');
    assert.throws(() => prepareGenerationRequest({ ...input, confirm_credit_spend: false }), { code: 'GENERATION_CREDIT_CONFIRMATION' });
});

test('generate preview uses current account model and cost without POST or private fields', async (t) => {
    const { cfg, calls, cookie } = await fixture(t);
    const result = await generateSong(cfg, { style: '  tribal house  ', lyrics: '', title: '  Test  ' });
    assert.equal(result.dry_run, true);
    assert.equal(result.estimated_credits, 4);
    assert.equal(result.credits_before, 12);
    assert.equal(result.model, 'acemusic-v1.1');
    assert.equal(result.requested_model, 'acemusic-v1.1');
    assert.deepEqual(result.request, prepareGenerationRequest({ style: '  tribal house  ', lyrics: '', title: '  Test  ' }));
    assert.deepEqual(result.request, { endpoint: '/api/custom', body: { mode: 'cover', model: 'acemusic-v1.1', references: [], style: 'tribal house', lyrics: '', lyricsMode: 'own', style_influence: 80, title: 'Test' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers.cookie, cookie);
    assert.equal(calls[0].headers.origin, cfg.baseUrl);
    for (const secret of [cookie, 'private@example.test', 'Private Name']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('generate guards and unsupported inputs reject before any request', async (t) => {
    const { cfg, calls } = await fixture(t);
    for (const opts of [
        { prompt: 'music', dry_run: false },
        { prompt: 'music', ...paid, confirm_credit_spend: false },
        { prompt: 'music', ...paid, max_credits: undefined },
        { prompt: 'music', ...paid, idempotency_key: undefined },
        { prompt: 'music', style: 'house' },
        { style: 'house', duration: 60 },
        { style: 'house', model: 'acemusic-v1' },
        { style: 'house', style_influence: 101 },
        { style: 'house', dry_run: 'false' },
        { style: 'house', request_created_at: 0 },
        { style: 'house', title: 'a'.repeat(81) },
    ]) await assert.rejects(generateSong(cfg, opts));
    assert.equal(calls.length, 0);
});

test('remote charged generation requires process authorization before session or network access', async (t) => {
    const previous = process.env.ACE_DIRECT_GENERATION_ENABLED;
    delete process.env.ACE_DIRECT_GENERATION_ENABLED;
    t.after(() => {
        if (previous === undefined) delete process.env.ACE_DIRECT_GENERATION_ENABLED;
        else process.env.ACE_DIRECT_GENERATION_ENABLED = previous;
    });
    let sessionReads = 0;
    let networkCalls = 0;
    t.mock.method(fsp, 'readFile', async () => { sessionReads++; throw new Error('Unexpected session access'); });
    t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('Unexpected network access'); });
    await assert.rejects(
        generateSong({ baseUrl: 'https://acemusic.ai', sessionFile: 'unused-review-session' }, { style: 'house', ...paid }),
        (err) => err.code === 'GENERATION_AUTHORIZATION_REQUIRED' && err.submission_unknown === false,
    );
    assert.equal(sessionReads, 0);
    assert.equal(networkCalls, 0);
});

test('Unicode limits count trimmed code points and follow tighter live model limits', async (t) => {
    const { cfg, status, calls } = await fixture(t);
    const preview = await generateSong(cfg, { style: '🎵'.repeat(1000) });
    assert.equal([...preview.request.body.style].length, 1000);
    await assert.rejects(generateSong(cfg, { style: '🎵'.repeat(1001) }), { code: 'GENERATION_INPUT' });
    status.models[0].limits.style = 5;
    await assert.rejects(generateSong(cfg, { style: '123456' }), { code: 'GENERATION_INPUT' });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('missing model, unknown cost, unknown balance, low balance and cost cap fail closed', async (t) => {
    const { cfg, status, calls } = await fixture(t);
    status.models = [];
    await assert.rejects(generateSong(cfg, { style: 'house', ...paid }), { code: 'GENERATION_MODEL_UNAVAILABLE' });
    status.models = [{ id: 'acemusic-v1.1' }];
    delete status.costs.song;
    await assert.rejects(generateSong(cfg, { style: 'house', ...paid }), { code: 'GENERATION_COST_UNKNOWN' });
    status.costs.song = 4;
    delete status.user.credits;
    await assert.rejects(generateSong(cfg, { style: 'house', ...paid }), { code: 'GENERATION_BALANCE_UNKNOWN' });
    status.user.credits = 3;
    await assert.rejects(generateSong(cfg, { style: 'house', ...paid }), { code: 'GENERATION_INSUFFICIENT_CREDITS' });
    status.user.credits = 12;
    await assert.rejects(generateSong(cfg, { style: 'house', ...paid, max_credits: 3 }), { code: 'GENERATION_CREDIT_LIMIT' });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('actual Custom sends one frontend-shaped POST with persisted created_at and reports IDs', async (t) => {
    const { cfg, calls } = await fixture(t);
    const result = await generateSong(cfg, { style: 'house', lyrics: '[Verse]\nHello', title: 'Demo', style_influence: 70, request_created_at: 1770000000000, ...paid });
    const post = calls.filter((c) => c.method === 'POST');
    assert.equal(post.length, 1);
    assert.equal(post[0].url, '/api/custom');
    assert.deepEqual(post[0].body, { mode: 'cover', model: 'acemusic-v1.1', references: [], style: 'house', lyrics: '[Verse]\nHello', lyricsMode: 'own', style_influence: 70, title: 'Demo', created_at: 1770000000000 });
    assert.deepEqual(result.task_ids, ['so_first', 'so_second']);
    assert.equal(result.submission_state, 'accepted');
    assert.equal(result.created_at, 1770000000000);
    assert.equal(result.model_verified, true);
    assert.equal(result.model, 'acemusic-v1.1');
    assert.deepEqual(result.actual_models, ['acemusic-v1.1']);
});

test('accepted different or unknown models retain IDs without claiming v1.1 verification', async (t) => {
    const { cfg, calls } = await fixture(t, { result: { song: { task_id: 'so_other', model: 'ace-step-1.5-xl', status: 'queued' } } });
    const other = await generateSong(cfg, { style: 'house', ...paid });
    assert.equal(other.submission_state, 'accepted');
    assert.deepEqual(other.task_ids, ['so_other']);
    assert.equal(other.requested_model, 'acemusic-v1.1');
    assert.equal(other.model, 'ace-step-1.5-xl');
    assert.deepEqual(other.model_mismatch_task_ids, ['so_other']);
    assert.equal(other.model_verified, false);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);

    const unknownFixture = await fixture(t, { result: { task_ids: ['so_unknown'] } });
    const unknown = await generateSong(unknownFixture.cfg, { style: 'house', ...paid });
    assert.equal(unknown.submission_state, 'accepted');
    assert.deepEqual(unknown.task_ids, ['so_unknown']);
    assert.equal(unknown.model, null);
    assert.deepEqual(unknown.actual_models, []);
    assert.deepEqual(unknown.model_unknown_task_ids, ['so_unknown']);
    assert.equal(unknown.model_verified, false);
});

test('actual Idea sends no Custom or ACE-Step fields', async (t) => {
    const { cfg, calls } = await fixture(t);
    await generateSong(cfg, { prompt: 'Dreamy piano', request_created_at: 1770000000001, ...paid });
    assert.deepEqual(calls[1].body, { prompt: 'Dreamy piano', references: [], model: 'acemusic-v1.1', media: [], created_at: 1770000000001 });
    assert.equal(calls[1].url, '/api/idea');
});

test('accepted response without IDs is unresolved and never replayed internally', async (t) => {
    const { cfg, calls } = await fixture(t, { result: { ok: true } });
    const result = await generateSong(cfg, { style: 'house', ...paid });
    assert.equal(result.submission_state, 'unresolved');
    assert.deepEqual(result.task_ids, []);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('lost, malformed, timed-out and server-error POST responses are uncertain with no retry or body echo', async (t) => {
    for (const scenario of ['disconnect', 'malformed', 'request-timeout', 'server-error']) {
        const { cfg, calls, cookie } = await fixture(t, { handler: (req, res) => {
            if (req.method !== 'POST') return false;
            if (scenario === 'disconnect') req.socket.destroy();
            else if (scenario === 'malformed') res.end('private@example.test ' + cookie);
            else { res.statusCode = scenario === 'request-timeout' ? 408 : 500; res.end('private@example.test ' + cookie); }
            return true;
        } });
        await assert.rejects(generateSong(cfg, { style: 'house', ...paid }), (err) => err.code === 'GENERATION_SUBMISSION_UNKNOWN' && err.submission_unknown === true && !err.message.includes(cookie) && !err.message.includes('private@'));
        assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    }
});

test('generation never forwards session through a redirect or non-ACE remote host', async (t) => {
    let destinationRequests = 0;
    const { cfg, calls } = await fixture(t, { handler: (req, res) => {
        if (req.method === 'POST') { res.writeHead(307, { Location: '/cookie-trap' }); res.end(); return true; }
        if (req.url === '/cookie-trap') { destinationRequests++; res.end('{}'); return true; }
        return false;
    } });
    await assert.rejects(generateSong(cfg, { style: 'house', ...paid }), { code: 'GENERATION_SUBMISSION_UNKNOWN' });
    assert.equal(destinationRequests, 0);
    await assert.rejects(generateSong({ ...cfg, baseUrl: 'https://other.example' }, { style: 'house' }), { code: 'GENERATION_BASE_URL' });
    assert.equal(calls.length, 2);
});

test('generation status queries exact IDs, filters unrelated data and reports terminal states', async (t) => {
    const privateCookie = 'test_session=private-cookie-value';
    const { cfg, calls, cookie } = await fixture(t, { songs: { items: [
        { task_id: 'so_done', status: 'succeeded', model: 'acemusic-v1.1', local_audio: '/data/done.mp3', meta: { title: 'Done', email: 'private@example.test' }, cookie: privateCookie },
        { task_id: 'so_pending', status: 'scoring', model: 'acemusic-v1.1' },
        { task_id: 'so_failed', status: 'interrupted', error: { secret: privateCookie } },
        { task_id: 'so_unrelated', status: 'succeeded', local_audio: '/data/unrelated.mp3' },
    ] } });
    const result = await generationStatus(cfg, { task_ids: ['so_done', 'so_pending', 'so_failed', 'so_missing'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(new URL(calls[0].url, cfg.baseUrl).searchParams.get('ids'), 'so_done,so_pending,so_failed,so_missing');
    assert.deepEqual(result.succeeded_task_ids, ['so_done']);
    assert.deepEqual(result.failed_task_ids, ['so_failed']);
    assert.deepEqual(result.pending_task_ids, ['so_pending', 'so_missing']);
    assert.deepEqual(result.missing_task_ids, ['so_missing']);
    assert.equal(result.complete, false);
    assert.equal(result.failed, true);
    assert.equal(JSON.stringify(result).includes('so_unrelated'), false);
    assert.equal(JSON.stringify(result).includes(cookie), false);
    assert.equal(JSON.stringify(result).includes('private@example.test'), false);
    const before = calls.length;
    for (const ids of [[], ['../bad'], ['so?x'], new Array(11).fill('same')]) await assert.rejects(generationStatus(cfg, { task_ids: ids }));
    assert.equal(calls.length, before);
});

test('status separates playable audio completion from verified v1.1 completion', async (t) => {
    const songs = { items: [
        { task_id: 'so_other', status: 'succeeded', model: 'ace-step-1.5-xl', local_audio: '/data/other.mp3' },
        { task_id: 'so_unknown', status: 'succeeded', local_audio: '/data/unknown.mp3' },
    ] };
    const { cfg } = await fixture(t, { songs });
    const result = await generationStatus(cfg, { task_ids: ['so_other', 'so_unknown'] });
    assert.equal(result.complete, true);
    assert.equal(result.audio_complete, true);
    assert.equal(result.v11_complete, false);
    assert.equal(result.model_verified, false);
    assert.equal(result.model, null);
    assert.equal(result.requested_model, 'acemusic-v1.1');
    assert.deepEqual(result.actual_models, ['ace-step-1.5-xl']);
    assert.deepEqual(result.model_mismatch_task_ids, ['so_other']);
    assert.deepEqual(result.model_unknown_task_ids, ['so_unknown']);
    for (const song of songs.items) song.model = 'acemusic-v1.1';
    const corrected = await generationStatus(cfg, { task_ids: ['so_other', 'so_unknown'] });
    assert.equal(corrected.model_verified, true);
    assert.equal(corrected.v11_complete, true);
    assert.equal(corrected.model, 'acemusic-v1.1');
});

test('conflicting duplicate statuses remain pending while consistent duplicates share one terminal ID', async (t) => {
    const songs = { items: [
        { task_id: 'so_same', status: 'failed', model: 'acemusic-v1.1' },
        { task_id: 'so_same', status: 'succeeded', model: 'acemusic-v1.1', local_audio: '/data/same.mp3' },
    ] };
    const { cfg, calls } = await fixture(t, { songs });
    for (const status of ['failed', 'queued']) {
        songs.items[0].status = status;
        const result = await generationStatus(cfg, { task_ids: ['so_same'] });
        assert.deepEqual(result.conflicting_task_ids, ['so_same']);
        assert.deepEqual(result.pending_task_ids, ['so_same']);
        assert.deepEqual(result.succeeded_task_ids, []);
        assert.deepEqual(result.failed_task_ids, []);
        assert.equal(result.complete, false);
        assert.equal(result.audio_complete, false);
        assert.equal(result.v11_complete, false);
    }
    songs.items[0] = { ...songs.items[1] };
    const consistent = await generationStatus(cfg, { task_ids: ['so_same'] });
    assert.deepEqual(consistent.conflicting_task_ids, []);
    assert.deepEqual(consistent.succeeded_task_ids, ['so_same']);
    assert.deepEqual(consistent.pending_task_ids, []);
    assert.equal(consistent.v11_complete, true);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});
