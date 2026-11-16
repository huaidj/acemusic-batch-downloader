import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMusicService } from '../../agent/lib/music-service.mjs';
import { MUSIC_CONTRACT, validateMusicInput } from '../../agent/lib/music-contract.mjs';

const direction = { natural_language: 'sub bass, micro swing, spatial depth, instrumental', model: 'acemusic-v1.1', mode: 'idea', seed: 11 };

function openFixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-music-service-'));
  let service = createMusicService({ stateDir });
  t.after(() => service?.close());
  return {
    call: (...args) => service.call(...args),
    reopen() { service.close(); service = createMusicService({ stateDir }); },
  };
}

function sessionAndPlan(service, { model = direction.model, max = 4 } = {}) {
  const created = service.call('session_create', { goal: 'Offline service acceptance', max_generations: max, max_depth: 2 });
  assert.equal(created.ok, true);
  const compiled = service.call('prompt_compile', { ...direction, model });
  assert.equal(compiled.ok, true);
  assert.equal(compiled.plan.translation_required, false);
  return { session: created.session, plan: compiled.plan };
}

test('music ledger preserves preparation, idempotency, events and cancellation across restart', (t) => {
  const service = openFixture(t);
  const { session, plan } = sessionAndPlan(service);
  const compiledAgain = service.call('prompt_compile', direction);
  assert.equal(compiledAgain.plan.id, plan.id);
  assert.equal(service.call('state').plans.length, 1, 'deterministic preview is stored once');
  const request = { session_id: session.id, plan_id: plan.id, idempotency_key: 'same-review', reviewed: true };
  const first = service.call('generation_prepare', request);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.status, 'awaiting_authorization');
  assert.equal(first.provider_calls, 0);
  assert.equal(first.job.real_success, false);
  assert.equal(first.job.remote_task_id, null);
  assert.deepEqual(first.job.artifacts, []);
  assert.deepEqual(first.job.budget_reservation, { ace_credits: 0, deepseek_usd: 0 });
  const retry = service.call('generation_prepare', request);
  assert.equal(retry.reused, true);
  assert.equal(retry.job.id, first.job.id);
  const secondPlan = service.call('prompt_compile', { ...direction, seed: 12 }).plan;
  assert.notEqual(secondPlan.id, plan.id);
  assert.equal(service.call('generation_prepare', { ...request, plan_id: secondPlan.id }).status, 'idempotency_conflict');
  assert.equal(service.call('state').jobs.length, 1);
  const beforeRestart = service.call('events', { since: 0, limit: 100 });
  assert.ok(beforeRestart.events.some((event) => event.type === 'generation_prepared'));
  service.reopen();
  const restored = service.call('job_status', { job_id: first.job.id });
  assert.equal(restored.job.id, first.job.id);
  assert.equal(restored.status, 'awaiting_authorization');
  assert.equal(service.call('state').plans.find((item) => item.id === plan.id).hash, plan.hash);
  assert.deepEqual(service.call('events', { since: beforeRestart.cursor }).events, []);
  const stop = service.call('session_stop', { session_id: session.id });
  assert.equal(stop.status, 'stopped');
  assert.deepEqual(stop.remote_tasks, []);
  assert.equal(service.call('job_status', { job_id: first.job.id }).status, 'cancelled');
  assert.equal(service.call('generation_prepare', { ...request, idempotency_key: 'after-stop' }).status, 'cancelled');
  const retryAfterStop = service.call('generation_prepare', request);
  assert.equal(retryAfterStop.job.id, first.job.id);
  assert.equal(retryAfterStop.status, 'cancelled');
  assert.equal(service.call('state').jobs.length, 1, 'stop prevents new records as well as provider submission');
  service.reopen();
  assert.equal(service.call('job_status', { job_id: first.job.id }).status, 'cancelled');
  assert.equal(service.call('state').sessions[0].status, 'stopped');
});

test('music preparation requires review, normalizes actual model aliases, and enforces the finite batch limit', (t) => {
  const service = openFixture(t);
  const { session, plan } = sessionAndPlan(service, { model: 'ace-step-1.5-xl', max: 1 });
  const request = { session_id: session.id, plan_id: plan.id, idempotency_key: 'review-gate', reviewed: false };
  assert.equal(service.call('generation_prepare', request).status, 'awaiting_review');
  assert.equal(service.call('state').jobs.length, 0, 'unreviewed drafts consume no slot');
  const modelChanged = service.call('generation_prepare', { ...request, reviewed: true, actual_model: 'acemusic-v1' });
  assert.equal(modelChanged.status, 'needs_recompile');
  assert.equal(service.call('state').jobs.length, 0);
  const prepared = service.call('generation_prepare', { ...request, reviewed: true, actual_model: 'ace-step-1.5-xl' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(prepared.job.requested_model, 'ace-step-v1.5-xl');
  const equivalentAlias = service.call('generation_prepare', { ...request, reviewed: true, actual_model: 'ace-step-v1.5-xl' });
  assert.equal(equivalentAlias.reused, true, 'equivalent model aliases denote the same request');
  assert.equal(equivalentAlias.job.id, prepared.job.id);
  assert.equal(service.call('generation_prepare', { ...request, reviewed: true, idempotency_key: 'over-limit' }).status, 'budget_blocked');
  assert.equal(service.call('state').jobs.length, 1);
});

test('real submit is unavailable, provider calls stay zero, and preview cannot fabricate a listening artifact', (t) => {
  const service = openFixture(t);
  const { session, plan } = sessionAndPlan(service);
  const prepared = service.call('generation_prepare', { session_id: session.id, plan_id: plan.id, idempotency_key: 'no-provider', reviewed: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  let fetches = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { fetches += 1; throw new Error('Network forbidden in this fixture'); };
  try {
    for (const job_id of [prepared.job.id, 'unknown-job']) {
      const result = service.call('generation_submit', { job_id });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'unsupported');
    }
    const feedback = service.call('feedback_record', { artifact_id: 'invented-artifact', text: 'I listened', explicit_rating: 5 });
    assert.equal(feedback.ok, false);
    assert.equal(feedback.status, 'not_found');
    assert.deepEqual(service.call('assets_query').assets, []);
    assert.equal(service.call('job_status', { job_id: prepared.job.id }).status, 'awaiting_authorization');
    const state = service.call('state');
    assert.equal(state.provider_calls, 0);
    assert.deepEqual(state.costs, { ace_credits: 0, deepseek_usd: 0 });
    assert.deepEqual(state.sessions[0].permission_scope, ['local_prepare']);
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = savedFetch; }
});

test('service rejects invalid shapes and caller-granted authority before any ledger mutation', (t) => {
  const service = openFixture(t);
  const invalid = [
    ['session_create', null],
    ['session_create', []],
    ['session_create', { max_generations: '1' }],
    ['session_create', { max_generations: 1.5 }],
    ['session_create', { max_depth: 0 }],
    ['session_create', { permission_scope: ['ace_submit'], authorized: true }],
    ['session_create', { budget_limits: { ace_credits: 999 }, provider_calls: 999 }],
    ['prompt_compile', { ...direction, weights: { 'bass.sub_pressure': 1.01 } }],
    ['prompt_compile', { ...direction, locked_term_ids: [false] }],
    ['prompt_compile', { ...direction, references: [false] }],
    ['generation_prepare', { session_id: 's', plan_id: 'p', idempotency_key: 'k', reviewed: 'true' }],
    ['generation_prepare', { session_id: 's', plan_id: 'p', idempotency_key: 'k', reviewed: true, authorized: true }],
    ['generation_submit', { job_id: 'x', approved_budget: 100, authorized: true }],
    ['feedback_record', { artifact_id: 'x', explicit_rating: '5' }],
  ];
  for (const [action, input] of invalid) {
    const result = service.call(action, input);
    assert.equal(result.ok, false, action + ' ' + JSON.stringify(input));
    assert.equal(result.status, 'invalid', action + ' ' + JSON.stringify(input));
  }
  const state = service.call('state');
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.plans, []);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(service.call('events').events, []);
});

test('shared generation schema requires boolean review and bounds weights to the compiler range', () => {
  const generation = MUSIC_CONTRACT.find((entry) => entry.action === 'generation_prepare');
  const compile = MUSIC_CONTRACT.find((entry) => entry.action === 'prompt_compile');
  const request = { session_id: 's', plan_id: 'p', idempotency_key: 'k' };
  assert.ok(validateMusicInput(request, generation.inputSchema));
  assert.ok(validateMusicInput({ ...request, reviewed: 'true' }, generation.inputSchema));
  assert.equal(validateMusicInput({ ...request, reviewed: true }, generation.inputSchema), null);
  assert.equal(validateMusicInput({ ...direction, weights: { 'bass.sub_pressure': 1 } }, compile.inputSchema), null);
  assert.ok(validateMusicInput({ ...direction, weights: { 'bass.sub_pressure': 1.01 } }, compile.inputSchema));
});
