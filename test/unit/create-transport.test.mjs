import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { createAceTransport } from '../../agent/lib/create-transport.mjs';
import { createRequestHash } from '../../agent/lib/create-contract.mjs';

const MODEL = 'acemusic-v1.1';
const KEY = 'isolated-transport-key';
const CREATED = '2026-11-16T00:00:00.000Z';
const cfg = { baseUrl: 'http://127.0.0.1:32109', sessionFile: 'in-memory-fake-transport-session', ua: 'Isolated test' };
const copy = (value) => JSON.parse(JSON.stringify(value));
function prepared(body = {}, extra = {}) {
    const request = { endpoint: '/api/custom', body: { model: MODEL, mode: 'cover', style: 'Restrained sub bass', lyrics: '', references: [], ...body } };
    return { ok: true, request, request_hash: createRequestHash(request), requested_model: request.body.model, mode: 'custom', has_upload: false, has_references: false, ...extra };
}

function setup(t, plan, { status, post, get, authorityOptions = {} } = {}) {
    const events = [];
    const calls = [];
    let sessionReads = 0;
    const live = status || { models: [{ id: plan.requested_model, limits: { prompt: 2000, style: 1000, lyrics: 5000 } }], costs: { song: 4 }, user: { credits: 100, plan: 'artist', email: 'private@example.invalid' } };
    t.mock.method(fsp, 'readFile', async (file) => {
        assert.equal(file, cfg.sessionFile, 'Only the in-memory fake session may be read');
        sessionReads++;
        events.push('session');
        return '{"cookie":"test-cookie=local-only","ua":"Fake test UA"}';
    });
    const row = { state: 'reserved', model: plan.requested_model, mode: plan.mode, request_hash: plan.request_hash,
        has_upload: plan.has_upload || plan.has_references, estimated_credits: 4, actual_credits: null, remote_task_ids: [], created_at: CREATED, ...authorityOptions.row };
    const authority = {
        getReceipt(key) { assert.equal(key, KEY); events.push('getReceipt'); return { ok: true, status: row.state, reservation: copy(row), reused: true }; },
        canSubmit(key) { assert.equal(key, KEY); events.push('canSubmit'); return authorityOptions.allowed !== false && row.state === 'reserved'; },
        recordOutcome(key, outcome) {
            assert.equal(key, KEY); events.push('record:' + outcome.state);
            if (authorityOptions.failMark && outcome.state === 'outcome_unknown') return { ok: false, status: 'storage_error' };
            if (authorityOptions.reusedMark && outcome.state === 'outcome_unknown') return { ok: true, status: 'outcome_unknown', reused: true };
            if (authorityOptions.failAccepted && outcome.state === 'submitted') return { ok: false, status: 'storage_error' };
            assert.ok(outcome.state !== 'not_submitted', 'Unknown submissions must never release their reservation');
            Object.assign(row, outcome);
            return { ok: true, status: row.state, reservation: copy(row), reused: false };
        },
    };
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        const method = options.method || 'GET';
        const pathname = new URL(url).pathname;
        calls.push({ url, method, options });
        events.push(method);
        assert.equal(options.redirect, 'error');
        if (method === 'GET') {
            if (get) return get(url, options);
            assert.equal(pathname, '/api/status'); return new Response(JSON.stringify(live));
        }
        assert.equal(row.state, 'outcome_unknown', 'The independent receipt must be persisted before POST');
        return post ? post(url, options) : new Response(JSON.stringify({ songs: [{ task_id: 'so_one', model: plan.requested_model }, { task_id: 'so_two', model: plan.requested_model }] }));
    });
    return { transport: createAceTransport(cfg, { authority }), authority, row, live, calls, events, get sessionReads() { return sessionReads; } };
}

test('preview reads live account fields without a grant or POST and omits private session/account fields', async (t) => {
    const plan = prepared();
    const fx = setup(t, plan);
    const result = await createAceTransport(cfg).preview(plan);
    assert.equal(result.estimated_credits, 4);
    assert.equal(result.credits_before, 100);
    assert.deepEqual(result.limits, { style: 1000, lyrics: 5000 });
    assert.deepEqual(fx.calls.map((call) => call.method), ['GET']);
    assert.equal(fx.calls[0].options.headers.Cookie, 'test-cookie=local-only');
    for (const secret of ['test-cookie', 'private@example', 'sessionFile']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('untrusted endpoints, bases, hashes, model mismatch and uploads stop before credentials or network', async (t) => {
    const plan = prepared();
    const fx = setup(t, plan);
    const invalid = [
        { ...plan, request_hash: 'a'.repeat(64) },
        { ...plan, requested_model: 'acemusic-v1' },
        { ...plan, request: { ...plan.request, endpoint: '/api/upload-raw' } },
        { ...plan, has_upload: true },
        { ...plan, has_references: true },
        { ...plan, ok: false },
    ];
    for (const input of invalid) await assert.rejects(fx.transport.preview(input));
    for (const baseUrl of ['https://example.invalid', 'https://acemusic.ai/path', 'https://name:password@acemusic.ai', 'http://192.168.1.1']) {
        assert.throws(() => createAceTransport({ ...cfg, baseUrl }), { code: 'CREATE_BASE_URL' });
    }
    assert.equal(fx.sessionReads, 0);
    assert.equal(fx.calls.length, 0);
});

test('unknown live cost, limits or model and tighter limits fail closed without a POST', async (t) => {
    const plan = prepared();
    const fx = setup(t, plan);
    delete fx.live.costs.song;
    await assert.rejects(fx.transport.preview(plan), { code: 'CREATE_COST_UNKNOWN' });
    fx.live.costs.song = 4;
    delete fx.live.models[0].limits.style;
    await assert.rejects(fx.transport.preview(plan), { code: 'CREATE_LIMITS_UNKNOWN' });
    fx.live.models[0].limits.style = 3;
    await assert.rejects(fx.transport.preview(plan), { code: 'CREATE_TEXT_LIMIT' });
    fx.live.models = [];
    await assert.rejects(fx.transport.preview(plan), { code: 'CREATE_MODEL_UNAVAILABLE' });
    assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 0);
});

test('free model pricing requires its live free flag; visual-reference totals remain unknown', async (t) => {
    const plan = prepared({ model: 'ace-step-1.5-xl' });
    const fx = setup(t, plan);
    fx.live.models[0].free = true;
    assert.equal((await fx.transport.preview(plan)).estimated_credits, 0);
    fx.live.models[0].free = false;
    assert.equal((await fx.transport.preview(plan)).estimated_credits, 4);
    const request = { endpoint: '/api/idea', body: { model: plan.requested_model, prompt: 'Music', references: [], media: [{ kind: 'link', url: 'https://example.invalid/video' }] } };
    const mediaPlan = { ...plan, request, request_hash: createRequestHash(request), mode: 'idea', has_references: true };
    await assert.rejects(fx.transport.preview(mediaPlan), { code: 'CREATE_COST_UNKNOWN' });
    assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 0);
});

test('Step live provider ID can submit against its canonical legacy receipt alias', async (t) => {
    const plan = prepared({ model: 'ace-step-1.5-xl' });
    const fx = setup(t, plan, { authorityOptions: { row: { model: 'ace-step-v1.5-xl', estimated_credits: 0 } } });
    fx.live.models[0].free = true;
    const result = await fx.transport.submit(plan, KEY);
    assert.equal(result.status, 'submitted');
    assert.equal(result.estimated_credits, 0);
    assert.equal(result.requested_model, 'ace-step-1.5-xl');
    assert.equal(JSON.parse(fx.calls.find((call) => call.method === 'POST').options.body).model, 'ace-step-1.5-xl');
});

test('submit always requires an independent authority, even for loopback or force-looking flags', async (t) => {
    const plan = { ...prepared(), force: true, confirm_credit_spend: true };
    const fx = setup(t, plan, { authorityOptions: { allowed: false } });
    await assert.rejects(createAceTransport(cfg).submit(plan, KEY), { code: 'CREATE_AUTHORIZATION_REQUIRED' });
    await assert.rejects(fx.transport.submit(plan, KEY), { code: 'CREATE_AUTHORIZATION_REQUIRED' });
    assert.equal(fx.sessionReads, 0);
    assert.equal(fx.calls.length, 0);
});

test('authorized submit persists unknown before one POST, fixes receipt time and separates wire hash', async (t) => {
    const plan = prepared();
    const fx = setup(t, plan);
    const result = await fx.transport.submit(plan, KEY);
    assert.equal(result.status, 'submitted');
    assert.equal(result.submission_state, 'accepted');
    assert.equal(result.model_verified, true);
    assert.equal(result.artifact_verified, false);
    assert.deepEqual(result.task_ids, ['so_one', 'so_two']);
    assert.ok(fx.events.indexOf('record:outcome_unknown') < fx.events.indexOf('POST'));
    assert.ok(fx.events.indexOf('POST') < fx.events.indexOf('record:submitted'));
    const post = fx.calls.find((call) => call.method === 'POST');
    const body = JSON.parse(post.options.body);
    assert.equal(body.created_at, Date.parse(CREATED));
    assert.equal(result.request_hash, plan.request_hash);
    assert.equal(result.submitted_request_hash, createRequestHash({ endpoint: plan.request.endpoint, body }));
    assert.notEqual(result.submitted_request_hash, result.request_hash);
    const again = await fx.transport.submit(plan, KEY);
    assert.equal(again.reused, true);
    assert.equal(again.status, 'submitted');
    assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 1);
});

test('changed cost and mismatched receipt prevent a POST', async (t) => {
    const plan = prepared();
    const fx = setup(t, plan);
    fx.live.costs.song = 5;
    await assert.rejects(fx.transport.submit(plan, KEY), { code: 'CREATE_BUDGET_CHANGED' });
    fx.live.costs.song = 4;
    fx.row.request_hash = 'f'.repeat(64);
    await assert.rejects(fx.transport.submit(plan, KEY), { code: 'CREATE_RECEIPT_MISMATCH' });
    fx.row.request_hash = plan.request_hash;
    assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 0);
    assert.equal(fx.row.state, 'reserved');
});

test('an explicitly reviewed native timestamp is preserved with the same submitted hash', async (t) => {
    const plan = prepared({ created_at: 1770000000000 });
    const fx = setup(t, plan);
    const result = await fx.transport.submit(plan, KEY);
    assert.equal(result.created_at, 1770000000000);
    assert.equal(JSON.parse(fx.calls.find((call) => call.method === 'POST').options.body).created_at, 1770000000000);
    assert.equal(result.request_hash, result.submitted_request_hash);
});

test('lost, HTTP 4xx/5xx, malformed and ID-less POST results retain unknown with no retry or release', async (t) => {
    for (const scenario of ['network', 400, 401, 402, 408, 429, 500, 'json', 'noids']) {
        await t.test(String(scenario), async (child) => {
            const plan = prepared();
            const fx = setup(child, plan, { post: async () => {
                if (scenario === 'network') throw new Error('private-cookie server detail');
                if (typeof scenario === 'number') return new Response('private-cookie server detail', { status: scenario });
                if (scenario === 'json') return new Response('private-cookie not JSON');
                return new Response('{"ok":true}');
            } });
            const result = await fx.transport.submit(plan, KEY);
            assert.equal(result.status, 'outcome_unknown');
            assert.equal(result.submission_state, 'unresolved');
            assert.equal(result.submission_unknown, true);
            assert.equal(fx.row.state, 'outcome_unknown');
            assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 1);
            assert.equal(JSON.stringify(result).includes('private-cookie'), false);
            const repeated = await fx.transport.submit(plan, KEY);
            assert.equal(repeated.reused, true);
            assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 1);
        });
    }
});

test('actual-model mismatch or absent model retains accepted IDs without claiming verification', async (t) => {
    const plan = prepared();
    const fx = setup(t, plan, { post: async () => new Response(JSON.stringify({ songs: [
        { task_id: 'so_other', model: 'ace-step-1.5-xl' }, { task_id: 'so_unknown' },
    ] })) });
    const result = await fx.transport.submit(plan, KEY);
    assert.equal(result.status, 'submitted');
    assert.equal(result.model_verified, false);
    assert.deepEqual(result.model_mismatch_task_ids, ['so_other']);
    assert.deepEqual(result.model_unknown_task_ids, ['so_unknown']);
    assert.deepEqual(fx.row.remote_task_ids, ['so_other', 'so_unknown']);
});

test('failed or already-used durable claim cannot POST; failed accepted receipt keeps unknown IDs', async (t) => {
    for (const authorityOptions of [{ failMark: true }, { reusedMark: true }, { failAccepted: true }]) {
        await t.test(Object.keys(authorityOptions)[0], async (child) => {
            const plan = prepared();
            const fx = setup(child, plan, { authorityOptions });
            if (authorityOptions.failAccepted) {
                const result = await fx.transport.submit(plan, KEY);
                assert.equal(result.status, 'outcome_unknown');
                assert.deepEqual(result.task_ids, ['so_one', 'so_two']);
                assert.equal(fx.row.state, 'outcome_unknown');
            } else {
                await assert.rejects(fx.transport.submit(plan, KEY), { code: 'CREATE_RECEIPT_WRITE' });
                assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 0);
            }
        });
    }
});

test('concurrent same-key submitters can issue at most one POST', async (t) => {
    const plan = prepared();
    const fx = setup(t, plan);
    const results = await Promise.allSettled([fx.transport.submit(plan, KEY), fx.transport.submit(plan, KEY)]);
    assert.equal(fx.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value.status === 'submitted').length, 1);
});

test('exact-ID status checks all three requested models and treats remote audio as unverified', async (t) => {
    for (const model of ['acemusic-v1', 'acemusic-v1.1', 'ace-step-1.5-xl']) {
        await t.test(model, async (child) => {
            const fx = setup(child, prepared(), { get: async (url) => {
                const target = new URL(url);
                assert.equal(target.pathname, '/api/songs');
                assert.equal(target.searchParams.get('ids'), 'so_exact');
                return new Response(JSON.stringify({ items: [
                    { task_id: 'so_exact', model, status: 'succeeded', local_audio: '/data/exact.mp3', cookie: 'private-cookie', result: { private: true } },
                    { task_id: 'so_unrelated', model, status: 'succeeded', local_audio: '/data/other.mp3' },
                ] }));
            } });
            const result = await fx.transport.status({ task_ids: ['so_exact'], requested_model: model });
            assert.equal(result.model_verified, true);
            assert.equal(result.complete, true);
            assert.equal(result.remote_audio_available, true);
            assert.equal(result.artifact_verified, false);
            assert.equal(result.real_success, false);
            assert.deepEqual(result.songs, [{ task_id: 'so_exact', status: 'succeeded', model, local_audio: '/data/exact.mp3' }]);
            assert.deepEqual(fx.calls.map((call) => call.method), ['GET']);
            assert.equal(JSON.stringify(result).includes('private-cookie'), false);
        });
    }
});

test('status rejects invalid input, isolates missing/model conflicts and refuses contradictory terminal rows', async (t) => {
    const fx = setup(t, prepared(), { get: async () => new Response(JSON.stringify({ items: [
        { task_id: 'so_conflict', status: 'failed', model: MODEL },
        { task_id: 'so_conflict', status: 'succeeded', model: MODEL, local_audio: '/data/conflict.mp3' },
        { task_id: 'so_other', status: 'succeeded', model: 'acemusic-v1', local_audio: 'https://other.invalid/data/leak.mp3' },
        { task_id: 'so_unknown', status: 'succeeded', local_audio: '/data/signed.mp3?secret=value' },
    ] })) });
    for (const input of [
        { task_ids: [], requested_model: MODEL },
        { task_ids: Array(11).fill('same'), requested_model: MODEL },
        { task_ids: ['../invalid'], requested_model: MODEL },
        { task_ids: ['so_exact'] },
    ]) await assert.rejects(fx.transport.status(input), { code: 'CREATE_STATUS_INPUT' });
    assert.equal(fx.calls.length, 0);
    assert.equal(fx.sessionReads, 0);
    const result = await fx.transport.status({ task_ids: ['so_conflict', 'so_other', 'so_unknown', 'so_missing'], requested_model: MODEL });
    assert.deepEqual(result.conflicting_task_ids, ['so_conflict']);
    assert.deepEqual(result.pending_task_ids, ['so_conflict', 'so_missing']);
    assert.deepEqual(result.missing_task_ids, ['so_missing']);
    assert.deepEqual(result.model_mismatch_task_ids, ['so_other']);
    assert.deepEqual(result.model_unknown_task_ids, ['so_unknown', 'so_missing']);
    assert.equal(result.complete, false);
    assert.equal(result.model_verified, false);
    assert.equal(result.remote_audio_available, false);
    assert.deepEqual(result.remote_audio_available_task_ids, []);
    assert.equal(result.artifact_verified, false);
    assert.equal(result.real_success, false);
    assert.deepEqual(fx.calls.map((call) => call.method), ['GET']);
});
