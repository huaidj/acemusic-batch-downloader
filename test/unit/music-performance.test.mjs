import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMusicPerformance, planPerformanceBuffer } from '../../agent/lib/music-performance.mjs';

const artifact = (id, duration = 300, extra = {}) => ({
    id, title: id, path: `/fixture/music-performance/${id}.wav`, sha256: id.padEnd(64, '0'),
    duration_seconds: duration, technical_verified: true, human_accepted: true, ...extra,
});
const a = artifact('a');
const b = artifact('b', 120);
const c = artifact('c', 240);
const external = { base_url: 'http://127.0.0.1:18886', owner: 'declared-external-owner' };
const status = () => ({
    schema: 'baddj.status.v1', service: 'baddj.mixcore', server: 'baddj-mixcore', api_version: 1, version: '0.4.1',
    algorithm_version: 'baddj-original-0.4.0', capabilities: { full_analysis: true, full_mix_render: true, alignment_metrics: true },
    counts: { audio_paths: 389, analyzed: 389 }, input_root: 'private-source-path', work_dir: 'private-runtime-path',
    job: { id: 123, kind: 'render', status: 'done', error: 'private-error', result: { output: 'private-output' } },
});
const neverFetch = async () => { throw new Error('No network call is permitted in this test'); };

test('buffer estimates use approved durations, stated target and one generation P95 reserve', () => {
    const result = planPerformanceBuffer({ assets: [a], backup_assets: [b], target_minutes: 10, generation_p95_seconds: 120 });
    assert.equal(result.inventory_seconds, 300);
    assert.equal(result.target_seconds, 600);
    assert.equal(result.required_seconds, 720);
    assert.equal(result.target_shortfall_seconds, 300);
    assert.equal(result.shortfall_seconds, 420);
    assert.equal(result.suggested_additional_tracks, 2);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.backup.inventory_seconds, 120);
    assert.equal(result.mixed_output_duration_verified, false);
    assert.equal(result.auto_play, false);
    const enough = planPerformanceBuffer({ assets: [a, c], target_minutes: 5, generation_p95_seconds: 120 });
    assert.equal(enough.status, 'sufficient_estimate');
    assert.equal(enough.shortfall_seconds, 0);
});

test('unknown duration, P95 or target stays unknown rather than becoming zero', () => {
    const result = planPerformanceBuffer({ assets: [a, artifact('d', null)] });
    assert.equal(result.inventory_seconds, null);
    assert.equal(result.known_inventory_seconds, 300);
    assert.equal(result.unknown_duration_count, 1);
    for (const field of ['target_minutes', 'target_seconds', 'generation_p95_seconds', 'required_seconds', 'shortfall_seconds', 'suggested_additional_tracks']) assert.equal(result[field], null);
    assert.equal(result.status, 'unknown');
    assert.ok(result.suggestions.some(item => item.code === 'verify_durations'));
    const invalid = planPerformanceBuffer({ assets: [a], target_minutes: Infinity, generation_p95_seconds: NaN });
    assert.equal(invalid.target_minutes, null);
    assert.equal(invalid.generation_p95_seconds, null);
    const overflow = planPerformanceBuffer({ assets: [a], target_minutes: Number.MAX_VALUE, generation_p95_seconds: 1 });
    assert.equal(overflow.required_seconds, null);
    assert.equal(overflow.status, 'unknown');
});

test('rejected, unlistened and technically unverified audio is excluded and exact duplicate bytes do not inflate stock', () => {
    const rejected = artifact('e', 300, { status: 'rejected' });
    const unlistened = artifact('f', 300, { human_accepted: false, machine_rating: 100 });
    const unverified = artifact('1', 300, { technical_verified: false });
    const result = planPerformanceBuffer({ assets: [a, rejected, unlistened, unverified, artifact('2', 300, { sha256: a.sha256 })], target_minutes: 1, generation_p95_seconds: 30 });
    assert.equal(result.eligible_count, 1);
    assert.equal(result.inventory_seconds, 300);
    assert.deepEqual(result.excluded.map(item => item.reason), ['rejected', 'awaiting_listen', 'unverified_asset', 'duplicate_audio']);
});

test('factory and capabilities do not probe; explicit read-only probe validates live identity and sanitizes state', async () => {
    const calls = [];
    const performance = createMusicPerformance({ external, assets: [a] }, { fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(status()));
    } });
    assert.equal(performance.getCapabilities().external_available, null);
    assert.equal(performance.getCapabilities().external.current, null);
    assert.equal(calls.length, 0);
    const result = await performance.probeExternal();
    assert.equal(result.ok, true);
    const caps = performance.getCapabilities();
    assert.equal(caps.external_available, true);
    assert.equal(caps.external.current.version, '0.4.1');
    assert.equal(caps.external.current.algorithm_version, 'baddj-original-0.4.0');
    assert.equal(caps.external.owner, external.owner);
    assert.equal(caps.external.current.counts.full_mixes, null);
    assert.equal(caps.acceptance.alignment, 'unverified');
    assert.equal(caps.acceptance.mixed_listening, 'unverified');
    assert.equal(caps.engine_start, false);
    assert.equal(caps.auto_play, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:18886/api/status');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.body, undefined);
    for (const value of ['private-source-path', 'private-runtime-path', 'private-error', 'private-output']) assert.equal(JSON.stringify(caps).includes(value), false);
});

test('unconfigured or wrong-identity engines do not invent availability, version or owner', async () => {
    const unconfigured = createMusicPerformance({}, { fetchImpl: neverFetch });
    assert.equal((await unconfigured.probeExternal()).status, 'not_configured');
    assert.equal(unconfigured.getCapabilities().external.owner, null);
    assert.equal(unconfigured.getCapabilities().external.current, null);
    const wrong = createMusicPerformance({ external }, { fetchImpl: async () => new Response(JSON.stringify({ ...status(), service: 'another.engine' })) });
    assert.equal((await wrong.probeExternal()).ok, false);
    assert.equal(wrong.getCapabilities().external_available, false);
    assert.equal(wrong.getCapabilities().external.last_known, null);
    for (const base_url of ['https://example.invalid', 'http://127.0.0.1:18886/api/status', 'http://user:pass@localhost:18886']) {
        assert.throws(() => createMusicPerformance({ external: { base_url } }, { fetchImpl: neverFetch }));
    }
});

test('manual main/backup queue accepts only verified human-approved assets and never starts playback', () => {
    const rejected = artifact('e', 120, { human_accepted: true, rejected: true });
    const performance = createMusicPerformance({ assets: [a, b, c, rejected, artifact('f', 100, { technical_verified: false }), artifact('1', 100, { human_accepted: false }), artifact('2', 300, { sha256: a.sha256 })] }, { fetchImpl: neverFetch });
    for (const artifact_id of ['e', 'f', '1', 'missing']) assert.equal(performance.queue({ artifact_id }).status, 'asset_not_accepted');
    assert.equal(performance.queue({ artifact_id: 'a' }).ok, true);
    assert.equal(performance.queue({ artifact_id: 'a' }).reused, true);
    assert.equal(performance.queue({ artifact_id: '2' }).status, 'duplicate_audio');
    assert.equal(performance.queue({ artifact_id: 'b', role: 'backup' }).ok, true);
    assert.equal(performance.queue({ artifact_id: 'c', position: 0 }).ok, true);
    assert.deepEqual(performance.getState().queue.map(item => item.artifact_id), ['c', 'a']);
    assert.deepEqual(performance.getState().backup.map(item => item.artifact_id), ['b']);
    assert.equal(performance.getState().status, 'paused');
    assert.equal(performance.getState().playback, 'not_connected');
    assert.equal(performance.getState().auto_play, false);
    assert.equal(performance.planBuffer({ target_minutes: 5, generation_p95_seconds: 120 }).inventory_seconds, 540);
    assert.equal(JSON.stringify(performance.getState()).includes('F:/'), false);
    assert.equal(performance.dequeue({ artifact_id: 'c' }).removed, true);
    assert.deepEqual(performance.getState().queue.map(item => item.artifact_id), ['a']);
});

test('disconnect preserves main/backup metadata; user stop blocks new queue until explicit resume', async () => {
    let online = true;
    let reads = 0;
    const performance = createMusicPerformance({ external, assets: [a, b, c] }, { fetchImpl: async (_url, options) => {
        assert.equal(options.method, 'GET'); reads++;
        if (!online) throw new Error('Network disconnected');
        return new Response(JSON.stringify(status()));
    } });
    performance.queue({ artifact_id: 'a' });
    performance.queue({ artifact_id: 'b', role: 'backup' });
    await performance.probeExternal();
    online = false;
    assert.equal((await performance.probeExternal()).status, 'unavailable');
    assert.equal(performance.getCapabilities().external.current, null);
    assert.equal(performance.getCapabilities().external.last_known.version, '0.4.1');
    assert.equal(performance.getState().queue.length, 1);
    assert.equal(performance.getState().backup.length, 1);
    performance.takeover({ reason: 'Manual control' });
    assert.equal(performance.getState().status, 'takeover');
    performance.pause();
    performance.stop({ reason: 'User stop' });
    assert.equal(performance.queue({ artifact_id: 'c' }).status, 'stopped');
    performance.takeover();
    assert.equal(performance.getState().stopped, true);
    performance.resume();
    assert.equal(performance.getState().status, 'ready');
    assert.equal(performance.queue({ artifact_id: 'c' }).ok, true);
    assert.equal(performance.getState().playback, 'not_connected');
    assert.equal(reads, 2);
});

test('export prepares only reviewed JSON with verified registry paths and performs no external write', () => {
    const performance = createMusicPerformance({ external, assets: [a, b] }, { fetchImpl: neverFetch });
    performance.queue({ artifact_id: 'a' });
    performance.queue({ artifact_id: 'b', role: 'backup' });
    const result = performance.prepareManifest({ target_minutes: 10, generation_p95_seconds: 120 });
    assert.equal(result.status, 'awaiting_user_review');
    assert.deepEqual(result.manifest.tracks.map(item => item.path), [a.path, b.path]);
    assert.deepEqual(result.manifest.tracks.map(item => item.role), ['main', 'backup']);
    assert.equal(result.manifest.execution.user_review_required, true);
    assert.equal(result.manifest.execution.auto_start, false);
    assert.equal(result.manifest.execution.auto_play, false);
    assert.equal(result.manifest.execution.external_write_performed, false);
    assert.equal(result.manifest.external.last_known_version, null);
    assert.equal(result.manifest.acceptance.mixed_listening, 'unverified');
});

test('revoked acceptance removes queued material; restored state never bypasses the current approved registry', () => {
    const performance = createMusicPerformance({ assets: [a, b], state: { stopped: true, paused: true, queue: ['a', 'missing'], backup: ['a', 'b'] } }, { fetchImpl: neverFetch });
    assert.equal(performance.getState().stopped, true);
    assert.deepEqual(performance.getState().queue.map(item => item.artifact_id), ['a']);
    assert.deepEqual(performance.getState().backup.map(item => item.artifact_id), ['b']);
    const updated = performance.setAssets([a, { ...a, status: 'rejected' }, b]);
    assert.deepEqual(updated.removed_from_buffer, ['a']);
    assert.deepEqual(performance.prepareManifest().manifest.tracks.map(item => item.artifact_id), ['b']);
    performance.resume();
    assert.equal(performance.queue({ artifact_id: 'a' }).status, 'asset_not_accepted');
    const snapshot = performance.getState();
    snapshot.backup.length = 0;
    assert.equal(performance.getState().backup.length, 1);
});
