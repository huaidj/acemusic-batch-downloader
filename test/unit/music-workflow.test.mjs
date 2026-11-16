import { test } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMusicService } from '../../agent/lib/music-service.mjs';
import { createMusicPerformance } from '../../agent/lib/music-performance.mjs';
import { prepareCreateRequest } from '../../agent/lib/create-contract.mjs';
import { hashObject } from '../../agent/music/core.mjs';
import { createResearchService } from '../../agent/research/service.mjs';

const ROOT = process.env.ACE_TEST_TEMP || os.tmpdir();
const flush = () => new Promise(resolve => setImmediate(resolve));
const direction = { natural_language: 'sub bass, micro swing, spatial depth, instrumental', model: 'acemusic-v1.1', mode: 'custom', seed: 31, locked_term_ids: [], hard_constraints: ['instrumental'] };
function backend() {
    let submits = 0, collections = 0;
    const receipts = new Map();
    const options = { grant: true, auto: false, realTagForContractTest: false, unknown: false, mismatch: false, conflict: false, invalidArtifact: false };
    const transport = { async preview(prepared) { assert.equal(prepared.ok, true); return { ok: true, estimated_credits: 4, requested_model: prepared.requested_model }; }, async status({ task_ids, requested_model }) {
        return { ok: true, model_verified: !options.mismatch, actual_models: [options.mismatch ? 'acemusic-v1' : requested_model],
            model_mismatch_task_ids: options.mismatch ? task_ids : [], model_unknown_task_ids: [], conflicting_task_ids: options.conflict ? task_ids : [],
            complete: true, remote_audio_available: true, failed: false, songs: task_ids.map(task_id => ({ task_id, model: requested_model, status: 'succeeded', local_audio: '/data/' + task_id + '.wav' })) };
    } };
    const api = {
        getAuthority: () => ({ summary: () => ({ ok: options.grant, status: options.grant ? 'ready' : 'grant_missing',
            grant: { grant_id: 'isolated_contract_grant', allow_auto_continue: options.auto, expires_at: new Date(Date.now() + 3600000).toISOString(), models: ['acemusic-v1.1'], modes: ['idea', 'custom'], max_generations: 5, max_credits_per_request: 4 },
            budget: { available: 100, max_credits_per_request: 4 }, slots: { available: 5 } }) }),
        getTransport: () => transport,
        cancelPending: () => ({ ok: false, status: 'already_submitted' }),
        async call(action, input) {
            if (action === 'receipt') { const reservation = receipts.get(input.idempotency_key); return reservation ? { ok: true, status: reservation.state, reservation: structuredClone(reservation) } : { ok: false, status: 'not_found' }; }
            assert.equal(action, 'submit');
            assert.match(input.idempotency_key, /^music:[a-f0-9]{64}$/);
            assert.equal(prepareCreateRequest(input.input).request_hash, input.reviewed_request_hash);
            submits++;
            const reservation = { state: options.unknown ? 'outcome_unknown' : 'submitted', model: input.input.model, mode: input.input.mode,
                request_hash: input.reviewed_request_hash, remote_task_ids: options.unknown ? [] : ['so_' + submits], estimated_credits: 4, actual_credits: null };
            receipts.set(input.idempotency_key, reservation);
            if (options.unknown) throw new Error('secret-cookie=never-return-this');
            return { ok: true, status: 'queued', jobId: 'api_' + submits, reservation: { ...reservation, state: 'reserved' },
                authorization_preview: { requested_model: input.input.model, estimated_credits: 4, plan: 'simulated-test-plan', observed_at: new Date().toISOString() } };
        },
    };
    const collector = { async collect(input) {
        collections++;
        return { ok: true, status: 'collected', errors: [], artifacts: input.task_ids.map(remote_task_id => ({
            id: 'artifact_' + remote_task_id, path: ROOT + '/workflow-fixture/' + remote_task_id + '.wav', sha256: remote_task_id.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a'), bytes: 1024, duration: 60,
            source_job: input.source_job, remote_task_id, actual_model: input.requested_model, requested_model: input.requested_model,
            technical_review: { full_decode: !options.invalidArtifact, human_listen: { status: 'accepted', accepted: true } }, real_or_mock: options.realTagForContractTest ? 'real' : 'mock',
        })) };
    } };
    return { api, collector, receipts, options, get submits() { return submits; }, get collections() { return collections; } };
}
function fixture(t, extra = {}) {
    fs.mkdirSync(ROOT, { recursive: true });
    const stateDir = fs.mkdtempSync(path.join(ROOT, 'huaidj-workflow-'));
    const provider = backend();
    let instance = createMusicService({ stateDir, createApi: provider.api, collector: provider.collector, pollIntervalMs: 0, ...extra });
    t.after(() => instance.close());
    return { provider, stateDir, get service() { return instance; }, reopen(overrides = {}) { instance.close(); instance = createMusicService({ stateDir, createApi: provider.api, collector: provider.collector, pollIntervalMs: 0, ...extra, ...overrides }); } };
}
function prepare(fx, { max_depth = 2, parameters, key = 'private-user-prepare-key' } = {}) {
    const created = fx.service.call('session_create', { max_generations: 5, max_depth });
    const compiled = fx.service.call('prompt_compile', direction);
    assert.equal(compiled.ok, true, JSON.stringify(compiled));
    const response = fx.service.call('generation_prepare', { session_id: created.session.id, plan_id: compiled.plan.id, reviewed: true, idempotency_key: key, ...(parameters ? { api_parameters: parameters } : {}) });
    assert.equal(response.ok, true, JSON.stringify(response));
    return { session: created.session, plan: compiled.plan, job: response.job };
}
async function collect(fx, job) {
    const result = fx.service.call('generation_submit', { job_id: job.id });
    assert.equal(result.status, 'submitting');
    await flush(); await fx.service.tick();
    return fx.service.call('job_status', { job_id: job.id }).job;
}

test('finite closed loop submits once, collects verified audio, records human feedback and proposes the next preview', async t => {
    const fx = fixture(t);
    const { plan, job } = prepare(fx, { parameters: { title: 'Reviewed title', style_influence: 70 } });
    assert.equal(job.native_input.title, 'Reviewed title');
    assert.equal(JSON.stringify(job).includes('private-user-prepare-key'), false);
    assert.equal(fx.service.call('generation_submit', { job_id: job.id }).status, 'submitting');
    assert.equal(fx.service.call('generation_submit', { job_id: job.id }).reused, true);
    await flush(); await fx.service.tick();
    const current = fx.service.call('job_status', { job_id: job.id }).job;
    assert.equal(current.status, 'awaiting_listen');
    assert.equal(current.real_success, false);
    assert.equal(fx.provider.submits, 1);
    assert.equal(fx.provider.collections, 1);
    const artifact = fx.service.getAsset(current.artifacts[0]).asset;
    assert.equal(artifact.human_listen.status, 'awaiting_listen', 'Collector cannot manufacture human acceptance');
    assert.equal(artifact.technical_review.human_listen.accepted, false);
    assert.equal(artifact.rights_snapshot.commercial_use, 'unknown');
    assert.equal(artifact.rights_snapshot.observed_subscription_plan, 'simulated-test-plan');
    assert.equal(artifact.rights_snapshot.observation_scope, 'pre_submit_status');
    assert.equal(artifact.real_or_mock, 'mock');
    const dimensions = { [plan.selected_terms[0].dimension]: 1 };
    const feedback = fx.service.call('feedback_record', { artifact_id: artifact.id, accepted: true, text: 'Accepted after listening', author: 'user', dimensions, idempotency_key: 'review-1' });
    assert.equal(feedback.status, 'accepted');
    assert.equal(fx.service.call('feedback_record', { artifact_id: artifact.id, accepted: true, text: 'Accepted after listening', author: 'user', dimensions, idempotency_key: 'review-1' }).reused, true);
    const next = fx.service.call('next_iteration', { artifact_id: artifact.id, seed: 32 });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(next.auto_submit, false);
    assert.equal(next.long_term_taste_updated, false);
    assert.deepEqual(next.plan.hard_constraints, plan.hard_constraints);
    assert.deepEqual(next.plan.locked_term_ids, plan.locked_term_ids);
    assert.deepEqual(next.inherited_versions, plan.versions);
    assert.equal(next.plan.requested_model, plan.requested_model);
    assert.ok(next.weight_proposals.every(item => Math.abs(item.to - item.from) <= 0.05000001));
    await fx.service.tick();
    assert.equal(fx.provider.collections, 1);
    assert.equal(fx.service.call('state').feedback.length, 1);
    assert.equal(fx.service.call('job_status', { job_id: job.id }).job.real_success, false);
});

test('unknown submission survives restart, never resubmits, and reconciles later known remote IDs', async t => {
    const fx = fixture(t);
    fx.provider.options.unknown = true;
    const { job } = prepare(fx);
    fx.service.call('generation_submit', { job_id: job.id });
    await flush();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'outcome_unknown');
    assert.equal(JSON.stringify(fx.service.call('state')).includes('secret-cookie'), false);
    fx.reopen();
    assert.equal(fx.service.call('generation_submit', { job_id: job.id }).reused, true);
    await fx.service.tick();
    assert.equal(fx.provider.submits, 1);
    const receipt = fx.provider.receipts.get(job.api_idempotency_key);
    receipt.state = 'submitted'; receipt.remote_task_ids = ['so_reconciled'];
    await fx.service.tick();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'awaiting_listen');
    assert.equal(fx.service.call('job_status', { job_id: job.id }).job.submission_unknown, false);
    assert.equal(fx.provider.submits, 1);
});

test('missing independent grant stays awaiting authorization; stop blocks new submits while remote collection continues', async t => {
    const fx = fixture(t);
    fx.provider.options.grant = false;
    const { job, session } = prepare(fx);
    assert.equal(fx.service.call('generation_submit', { job_id: job.id }).status, 'awaiting_authorization');
    assert.equal(fx.provider.submits, 0);
    fx.provider.options.grant = true;
    fx.service.call('generation_submit', { job_id: job.id });
    await flush();
    const stopped = fx.service.call('session_stop', { session_id: session.id });
    assert.equal(stopped.status, 'stopped');
    assert.ok(stopped.remote_outcomes_unknown.includes(job.id));
    await fx.service.tick();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'awaiting_listen');
    assert.equal(fx.provider.submits, 1);
    assert.equal(fx.service.call('generation_prepare', { session_id: session.id, plan_id: job.plan_id, reviewed: true, idempotency_key: 'after-stop' }).status, 'cancelled');
});

test('model mismatch, contradictory remote states and unverified files never pass collection', async t => {
    for (const option of ['mismatch', 'conflict', 'invalidArtifact']) {
        await t.test(option, async child => {
            const fx = fixture(child); fx.provider.options[option] = true;
            const { job } = prepare(fx);
            const current = await collect(fx, job);
            assert.equal(current.status, 'needs_review');
            assert.equal(current.real_success, false);
            assert.equal(fx.service.call('assets_query').assets.length, 0);
            if (option !== 'invalidArtifact') assert.equal(fx.provider.collections, 0);
        });
    }
});

test('append-only feedback can reject and retract; unknown parents and over-depth offspring are blocked', async t => {
    const fx = fixture(t);
    const { job, session } = prepare(fx, { max_depth: 1 });
    const current = await collect(fx, job); const id = current.artifacts[0];
    fx.service.call('feedback_record', { artifact_id: id, accepted: true });
    const rejected = fx.service.call('feedback_record', { artifact_id: id, accepted: false });
    assert.equal(fx.service.call('next_iteration', { artifact_id: id }).status, 'awaiting_listen');
    assert.equal(fx.service.call('feedback_record', { artifact_id: id, retracts: rejected.feedback.id }).status, 'accepted');
    assert.equal(fx.service.call('state').feedback.length, 3);
    const next = fx.service.call('next_iteration', { artifact_id: id, seed: 42 });
    const request = { session_id: session.id, plan_id: next.plan.id, reviewed: true, idempotency_key: 'child', parent_artifact_ids: [id] };
    assert.equal(fx.service.call('generation_prepare', { ...request, parent_artifact_ids: ['invented'] }).status, 'invalid_parent');
    const child = fx.service.call('generation_prepare', request).job;
    assert.equal(child.generation_depth, 1);
    const offspring = await collect(fx, child);
    fx.service.call('feedback_record', { artifact_id: offspring.artifacts[0], accepted: true });
    const third = fx.service.call('next_iteration', { artifact_id: offspring.artifacts[0] });
    assert.equal(fx.service.call('generation_prepare', { ...request, plan_id: third.plan.id, parent_artifact_ids: third.parent_artifact_ids, idempotency_key: 'grandchild' }).status, 'depth_blocked');
});

test('native parameter schema blocks caller grants, text/model replacement and machine-authored feedback', t => {
    const fx = fixture(t);
    const { session, plan } = prepare(fx);
    for (const api_parameters of [{ model: 'acemusic-v1' }, { style: 'override' }, { references: [] }, { grant: true }, { step: { mode: 'standard', force: true } }]) {
        assert.equal(fx.service.call('generation_prepare', { plan_id: plan.id, session_id: session.id, reviewed: true, idempotency_key: JSON.stringify(api_parameters), api_parameters }).status, 'invalid');
    }
    assert.equal(fx.service.call('generation_submit', { job_id: 'x', confirm_credit_spend: true }).status, 'invalid');
    assert.equal(fx.service.call('feedback_record', { artifact_id: 'x', author: 'machine' }).status, 'invalid');
    assert.equal(fx.service.call('feedback_record', { artifact_id: 'x', dimensions: { groove: 1.1 } }).status, 'invalid');
    assert.equal(fx.provider.submits, 0);
});

test('unsupported versioned plans cannot be silently registered as executable jobs', t => {
    const fx = fixture(t);
    const session = fx.service.call('session_create', { max_generations: 2, max_depth: 1 }).session;
    const plan = fx.service.call('prompt_compile', direction).plan;
    const { id, hash, ...payload } = plan;
    payload.advanced = { invented: true };
    const changed = { ...payload, hash: hashObject(payload) }; changed.id = 'plan_' + changed.hash.slice(0, 20);
    const db = new DatabaseSync(path.join(fx.stateDir, 'music-agent.sqlite'));
    db.prepare('INSERT INTO plans VALUES(?,?,?)').run(changed.id, changed.hash, JSON.stringify(changed)); db.close();
    const result = fx.service.call('generation_prepare', { plan_id: changed.id, session_id: session.id, reviewed: true, idempotency_key: 'unsupported-plan' });
    assert.equal(result.status, 'unsupported');
    assert.equal(fx.service.call('state').jobs.length, 0);
});

test('performance mapping uses only persisted accepted assets and restores queue/stop metadata', async t => {
    const performance = createMusicPerformance();
    const fx = fixture(t, { performance });
    const { job } = prepare(fx);
    const collected = await collect(fx, job); const id = collected.artifacts[0];
    assert.equal(fx.service.call('performance_queue', { artifact_id: id }).ok, false);
    fx.service.call('feedback_record', { artifact_id: id, accepted: true });
    assert.equal(fx.service.call('performance_queue', { artifact_id: id }).ok, true);
    fx.service.call('performance_stop', {});
    assert.equal(fx.service.call('performance_manifest', { target_minutes: 10, generation_p95_seconds: 120 }).status, 'awaiting_user_review');
    fx.reopen({ performance: createMusicPerformance() });
    const restored = fx.service.call('performance_state');
    assert.equal(restored.state.stopped, true);
    assert.deepEqual(restored.state.queue.map(item => item.artifact_id), [id]);
    assert.equal(restored.state.auto_play, false);
    fx.service.call('feedback_record', { artifact_id: id, accepted: false });
    assert.equal(fx.service.call('performance_state').state.queue.length, 0);
});

test('research run is a short background dispatch and request fields cannot supply credentials', async t => {
    let runs = 0, resolve;
    const job = { id: 'research_1', status: 'prepared' };
    const research = { summary: () => ({ ok: true, status: 'ready' }), getJob: () => ({ ok: true, status: job.status, job: { ...job } }),
        prepare: () => ({ ok: true, job }), run: () => { runs++; return new Promise(done => { resolve = () => { job.status = 'completed'; done({ ok: true, status: 'completed' }); }; }); } };
    const fx = fixture(t, { research });
    assert.equal(fx.service.call('research_prepare', { kind: 'search', query: 'percussion', api_key: 'caller-secret' }).status, 'invalid');
    const started = fx.service.call('research_run', { job_id: job.id });
    assert.equal(started.status, 'queued');
    assert.equal(typeof started.then, 'undefined');
    await flush();
    assert.equal(fx.service.call('research_run', { job_id: job.id }).reused, true);
    assert.equal(fx.service.call('state').ok, true);
    assert.equal(runs, 1);
    resolve(); await flush();
    assert.equal(fx.service.call('research_job', { job_id: job.id }).status, 'completed');
});

test('reviewed research dictionary activation is versioned, survives restart and keeps historical plans usable', t => {
    fs.mkdirSync(ROOT, { recursive: true });
    const researchDir = fs.mkdtempSync(path.join(ROOT, 'huaidj-workflow-research-'));
    const research = createResearchService({ stateDir: researchDir });
    t.after(() => research.close());
    const fx = fixture(t, { research });
    const { plan, session } = prepare(fx);
    const base = fx.service.call('dictionary');
    const termId = 'research.' + path.basename(researchDir);
    const evidence = research.importEvidence({ source_url: 'https://example.org/music/' + path.basename(researchDir), source: 'independent_licensed_reference', title: 'Ceramic pulse study', summary: 'A restrained low-register pulse with open space.', rights_status: 'licensed', ai_ingestion_allowed: true });
    assert.equal(evidence.ok, true, JSON.stringify(evidence));
    const proposed = research.proposeTerms({ evidence_ids: [evidence.evidence.id], parent_dictionary_version: base.dictionary_version, terms: [{ term_id: termId, zh: '低音陶質脈動', en: 'low-register ceramic pulse', dimension: base.terms[0].dimension, definition: 'An audible percussive texture direction.', base_weight: 0.4 }] });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const reviewed = research.reviewCandidate({ candidate_id: proposed.candidate.id, approved: true, reviewed_by: 'user', review_note: 'Accept this traceable term as a draft.' });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    const activated = fx.service.call('dictionary_activate', { snapshot_id: reviewed.dictionary_snapshot.id });
    assert.equal(activated.status, 'activated', JSON.stringify(activated));
    assert.notEqual(activated.dictionary_version, base.dictionary_version);
    assert.equal(fx.service.call('dictionary', { query: termId }).terms[0].term_id, termId);
    assert.equal(fx.service.call('dictionary', { version: base.dictionary_version }).dictionary_hash, base.dictionary_hash);
    const preview = fx.service.call('prompt_compile', { ...direction, natural_language: 'low-register ceramic pulse', locked_term_ids: [termId] });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.plan.dictionary_version, activated.dictionary_version);
    assert.ok(preview.plan.selected_terms.some(term => term.term_id === termId));
    const historical = fx.service.call('generation_prepare', { plan_id: plan.id, session_id: session.id, reviewed: true, idempotency_key: 'historical-after-activation' });
    assert.equal(historical.ok, true, JSON.stringify(historical));
    assert.equal(historical.job.dictionary_version, base.dictionary_version);
    fx.reopen();
    assert.equal(fx.service.call('state').dictionary_active, activated.dictionary_version);
    assert.ok(fx.service.call('state').dictionary_versions.includes(base.dictionary_version));
    assert.equal(fx.service.call('dictionary_activate', { snapshot_id: reviewed.dictionary_snapshot.id }).reused, true);
    assert.equal(fx.provider.submits, 0);
});

test('temporarily missing actual model remains monitorable until terminal model evidence arrives', async t => {
    const fx = fixture(t);
    const original = fx.provider.api.getTransport().status;
    let pending = true;
    fx.provider.api.getTransport().status = async input => pending ? { ok: true, complete: false, model_verified: false, model_unknown_task_ids: input.task_ids, actual_models: [], remote_audio_available: false } : original(input);
    const { job } = prepare(fx);
    await collect(fx, job);
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'generating');
    assert.equal(fx.provider.collections, 0);
    pending = false;
    await fx.service.tick();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'awaiting_listen');
});

test('a restart while submission is unresolved reconciles only and cannot replay the provider call', async t => {
    const fx = fixture(t);
    const original = fx.provider.api.call;
    let sends = 0, release;
    fx.provider.api.call = (action, input) => action === 'submit' ? (sends++, new Promise(resolve => { release = resolve; })) : original(action, input);
    const { job } = prepare(fx);
    fx.service.call('generation_submit', { job_id: job.id });
    await flush();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'submitting');
    fx.reopen();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'outcome_unknown');
    assert.equal(fx.service.call('generation_submit', { job_id: job.id }).reused, true);
    await fx.service.tick();
    assert.equal(sends, 1);
    release({ ok: false, status: 'awaiting_authorization' }); await flush();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'outcome_unknown');
});

test('long collection stays in background, cached reads are synchronous and duplicate ticks share one collection', async t => {
    const fx = fixture(t);
    const original = fx.provider.collector.collect;
    let release, calls = 0;
    fx.provider.collector.collect = input => { calls++; return new Promise(resolve => { release = async () => resolve(await original(input)); }); };
    const { job } = prepare(fx);
    fx.service.call('generation_submit', { job_id: job.id }); await flush();
    const pending = fx.service.tick(); await flush();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'collecting');
    const cached = fx.service.call('state');
    const poll = fx.service.call('poll_generation', { job_id: job.id });
    assert.equal(typeof cached.then, 'undefined');
    assert.equal(typeof poll.then, 'undefined');
    assert.equal(fx.service.tick(), pending);
    assert.equal(calls, 1);
    await release(); await pending;
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'awaiting_listen');
});

test('research preparation inherits active workflow snapshot IDs instead of stale service defaults', t => {
    let received;
    const fx = fixture(t, { research: { prepare: input => { received = input; return { ok: true, job: { id: 'research_metadata' } }; }, summary: () => ({ ok: true }) } });
    const { plan } = prepare(fx);
    assert.equal(fx.service.call('research_prepare', { kind: 'search', query: 'percussion research' }).ok, true);
    for (const key of ['dictionary_version', 'taste_snapshot_id', 'compiler_version', 'capability_snapshot_id']) assert.equal(received.snapshot_ids[key], plan.versions[key]);
    assert.equal(fx.service.call('state').sessions[0].budget_limits_scope, 'local_preparation_only');
    assert.equal(fx.service.call('state').generation_authority.status, 'ready');
});

test('partial collection cannot become whole-job success and explicit retry preserves prior human feedback', async t => {
    const fx = fixture(t);
    const original = fx.provider.collector.collect;
    let partial = true;
    fx.provider.collector.collect = async input => {
        const result = await original(input);
        return partial ? { ...result, ok: false, status: 'partial', artifacts: result.artifacts.slice(0, 1), errors: [{ code: 'UNAVAILABLE' }] } : result;
    };
    const { job } = prepare(fx);
    fx.service.call('generation_submit', { job_id: job.id }); await flush();
    fx.provider.receipts.get(job.api_idempotency_key).remote_task_ids.push('so_extra');
    await fx.service.tick();
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'collection_failed');
    const asset = fx.service.call('assets_query').assets[0];
    const accepted = fx.service.call('feedback_record', { artifact_id: asset.id, accepted: true });
    assert.equal(accepted.status, 'accepted');
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'collection_failed');
    await fx.service.tick();
    assert.equal(fx.provider.collections, 1, 'A failed decode/download is not blindly retried');
    partial = false;
    fx.service.call('poll_generation', { job_id: job.id }); await fx.service.tick();
    assert.equal(fx.provider.collections, 2);
    assert.equal(fx.service.getAsset(asset.id).asset.human_listen.decision_feedback_id, accepted.feedback.id);
    assert.equal(fx.service.call('state').feedback.length, 1);
    assert.equal(fx.service.call('job_status', { job_id: job.id }).status, 'awaiting_listen');
});

test('loop bridge refuses mock/unreviewed anchors and request-supplied automatic grants', async t => {
    const fx = fixture(t);
    const { job, session } = prepare(fx);
    const collected = await collect(fx, job);
    const anchor = collected.artifacts[0];
    fx.service.call('feedback_record', { artifact_id: anchor, accepted: true });
    const input = { session_id: session.id, anchor_artifact_id: anchor, max_generations: 1, max_depth: 2 };
    assert.equal((await fx.service.call('loop_prepare', input)).status, 'invalid_anchor');
    assert.equal((await fx.service.call('loop_prepare', { ...input, allow_auto_continue: true })).status, 'invalid');
    assert.equal(fx.provider.submits, 1);
});

test('isolated loop callback contract preserves native controls, requires independent auto grant and waits for human feedback', async t => {
    const fx = fixture(t);
    // This deliberately exercises a trusted-collector metadata contract. All
    // provider, audio and human decisions remain synthetic; no real file exists.
    fx.provider.options.realTagForContractTest = true;
    const { job, session } = prepare(fx, { parameters: { title: 'Reviewed ancestor title', style_influence: 70 } });
    const collected = await collect(fx, job);
    fx.service.call('feedback_record', { artifact_id: collected.artifacts[0], accepted: true });
    const prepared = await fx.service.call('loop_prepare', { session_id: session.id, anchor_artifact_id: collected.artifacts[0], max_generations: 1, max_depth: 2, seed: 123 });
    assert.equal(prepared.status, 'paused', JSON.stringify(prepared));
    const loopId = prepared.loop.id;
    assert.equal((await fx.service.call('loop_start', { loop_id: loopId })).ok, false);
    await fx.service.tick();
    assert.equal(fx.provider.submits, 1);
    fx.provider.options.auto = true;
    assert.equal((await fx.service.call('loop_resume', { loop_id: loopId })).ok, true);
    await fx.service.tick(); await flush();
    assert.equal(fx.provider.submits, 2);
    const offspring = fx.service.call('state').jobs.find(candidate => candidate.id !== job.id);
    assert.equal(offspring.native_input.title, job.native_input.title);
    assert.equal(offspring.native_input.style_influence, 70);
    assert.equal(offspring.generation_depth, 1);
    assert.deepEqual(offspring.versions, job.versions);
    await fx.service.tick();
    const pending = fx.service.call('job_status', { job_id: offspring.id }).job;
    assert.equal(pending.status, 'awaiting_listen');
    assert.equal(fx.service.call('loop_state', { loop_id: loopId }).loop.status, 'awaiting_feedback');
    await fx.service.tick();
    assert.equal(fx.provider.submits, 2, 'No autonomous self-rating or second offspring');
    fx.service.call('feedback_record', { artifact_id: pending.artifacts[0], accepted: true });
    await fx.service.tick();
    const completed = fx.service.call('loop_state', { loop_id: loopId });
    assert.equal(completed.loop.status, 'completed', JSON.stringify(completed));
    assert.equal(completed.loop.generations_submitted, 1);
    fx.reopen();
    assert.equal(fx.service.call('loop_state', { loop_id: loopId }).loop.status, 'completed');
    await fx.service.tick();
    assert.equal(fx.provider.submits, 2);
});
