import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGenerationAuthority } from '../../agent/lib/generation-authority.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const baseGrant = () => ({ grant_id: 'fixture-grant', provider: 'ace', models: ['acemusic-v1.1'], modes: ['idea', 'custom'],
  max_credits_per_request: 3, max_credits_total: 5, max_generations: 3,
  expires_at: new Date(Date.now() + 60000).toISOString(), allow_upload: false, allow_auto_continue: false });
const request = (key, extra = {}) => ({ idempotency_key: key, request_hash: hash('request:' + key), model: 'acemusic-v1.1', mode: 'idea', estimated_credits: 2, ...extra });

function fixture(t, initial = baseGrant()) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-authority-'));
  const stateDir = path.join(base, 'state');
  const grantFile = path.join(base, 'server-grant.json');
  if (initial !== null) fs.writeFileSync(grantFile, JSON.stringify(initial));
  let authority = createGenerationAuthority({ stateDir, grantFile });
  t.after(() => authority.close());
  return {
    base, stateDir, grantFile,
    get authority() { return authority; },
    write(grant) { fs.writeFileSync(grantFile, JSON.stringify(grant)); },
    reopen() { authority.close(); authority = createGenerationAuthority({ stateDir, grantFile }); },
  };
}

test('finite grant reserves credit and slots once; receipts have stable UTC identity without raw keys or paths', (t) => {
  const fix = fixture(t);
  const ready = fix.authority.summary();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.budget, { max_credits_per_request: 3, max_credits_total: 5, reserved: 0, spent: 0, available: 5 });
  const input = request('private-idem-key');
  const first = fix.authority.reserve(input);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.reused, false);
  assert.equal(first.status, 'reserved');
  assert.equal(first.can_submit, true);
  assert.equal(fix.authority.canSubmit(input.idempotency_key), true);
  assert.equal(new Date(first.reservation.created_at).toISOString(), first.reservation.created_at);
  assert.match(first.reservation.id, /^reservation_[a-f0-9]{64}$/);
  const retry = fix.authority.reserve(input);
  assert.equal(retry.reused, true);
  assert.equal(retry.can_submit, false, 'retry must not itself authorize another POST');
  assert.deepEqual(retry.reservation, first.reservation);
  assert.equal(fix.authority.summary().budget.reserved, 2);
  assert.equal(fix.authority.summary().slots.used, 1);
  for (const changed of [{ request_hash: hash('other') }, { mode: 'custom' }, { model: 'acemusic-v1' }, { estimated_credits: 1 }, { has_upload: true }]) {
    assert.equal(fix.authority.reserve({ ...input, ...changed }).status, 'idempotency_conflict');
  }
  const publicData = JSON.stringify([fix.authority.getReceipt(input.idempotency_key), fix.authority.summary()]);
  assert.equal(publicData.includes(input.idempotency_key), false);
  assert.equal(publicData.includes(fix.base), false);
  assert.equal(fix.authority.summary().slots.receipts, 1);
});

test('missing, invalid and expired server grants deny reservations without accepting caller authority', (t) => {
  const fix = fixture(t, null);
  assert.equal(fix.authority.summary().status, 'authorization_required');
  assert.equal(fix.authority.reserve(request('missing')).ok, false);
  const invalidGrants = [
    { ...baseGrant(), max_credits_total: '5' },
    { ...baseGrant(), max_credits_total: null },
    { ...baseGrant(), max_credits_total: -1 },
    { ...baseGrant(), max_credits_per_request: 1e30 },
    { ...baseGrant(), max_generations: 1.5 },
    { ...baseGrant(), allow_upload: true },
    { ...baseGrant(), allow_auto_continue: true },
    { ...baseGrant(), models: ['arbitrary-provider-model'] },
    { ...baseGrant(), modes: ['mashup'] },
    { ...baseGrant(), expires_at: '2099-02-30T00:00:00Z' },
    { ...baseGrant(), expires_at: '2099-01-01T00:00:00+08:00' },
    { ...baseGrant(), api_key: 'do-not-store-credentials' },
  ];
  for (const grant of invalidGrants) {
    fix.write(grant);
    const result = fix.authority.reserve(request('invalid-grant'));
    assert.equal(result.ok, false, JSON.stringify(grant));
    assert.equal(result.status, 'grant_invalid');
  }
  fix.write({ ...baseGrant(), expires_at: '2000-01-01T00:00:00Z' });
  assert.equal(fix.authority.reserve(request('expired')).status, 'grant_expired');
  fix.write(baseGrant());
  for (const caller of [{ grant: baseGrant() }, { grantFile: fix.grantFile }, { authorized: true }, { max_credits_total: 999 }]) {
    assert.equal(fix.authority.reserve({ ...request('caller-grant'), ...caller }).status, 'invalid');
  }
  assert.deepEqual(fix.authority.summary().ledger, [], 'rejected requests create neither grants nor receipts');
});

test('unknown costs, malformed types, out-of-scope models, uploads and insufficient budgets fail closed', (t) => {
  const fix = fixture(t);
  for (const bad of [null, {}, { ...request('unknown'), estimated_credits: null }, { ...request('nan'), estimated_credits: NaN },
    { ...request('infinite'), estimated_credits: Infinity }, { ...request('negative'), estimated_credits: -1 },
    { ...request('text'), estimated_credits: '2' }, { ...request('tiny'), estimated_credits: 0.0000001 },
    { ...request('hash'), request_hash: 'not-a-content-hash' }, { ...request('upload-type'), has_upload: 'false' }]) {
    assert.equal(fix.authority.reserve(bad).status, 'invalid');
  }
  assert.equal(fix.authority.reserve(request('wrong-model', { model: 'acemusic-v1' })).status, 'scope_denied');
  assert.equal(fix.authority.reserve(request('upload', { has_upload: true })).status, 'upload_not_authorized');
  assert.equal(fix.authority.reserve(request('per-request', { estimated_credits: 4 })).status, 'budget_blocked');
  assert.equal(fix.authority.reserve(request('first')).ok, true);
  assert.equal(fix.authority.reserve(request('second')).ok, true);
  assert.equal(fix.authority.reserve(request('over-total')).status, 'budget_blocked');
  const summary = fix.authority.summary();
  assert.equal(summary.budget.reserved, 4);
  assert.equal(summary.budget.available, 1);
  assert.equal(summary.slots.used, 2);
});

test('submitted and unknown costs stay held; settlement releases only the verified difference', (t) => {
  const fix = fixture(t);
  fix.authority.reserve(request('submitted'));
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'settled', actual_credits: 1 }).status, 'invalid_transition');
  const claim = fix.authority.recordOutcome('submitted', { state: 'outcome_unknown' });
  assert.equal(claim.ok, true);
  assert.equal(claim.reused, false);
  assert.equal(fix.authority.canSubmit('submitted'), false);
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'outcome_unknown' }).reused, true);
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'not_submitted' }).status, 'unsafe_release');
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'submitted', remote_task_ids: ['so_fixture_1'] }).ok, true);
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'outcome_unknown' }).status, 'invalid_transition');
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'not_submitted' }).status, 'unsafe_release');
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'settled', actual_credits: 3 }).status, 'settlement_exceeds_reservation');
  assert.equal(fix.authority.summary().budget.reserved, 2);
  for (const actual_credits of [null, NaN, Infinity, -1, '1']) assert.equal(fix.authority.recordOutcome('submitted', { state: 'settled', actual_credits }).status, 'invalid');
  const settled = fix.authority.recordOutcome('submitted', { state: 'settled', actual_credits: 1.5 });
  assert.equal(settled.ok, true);
  assert.deepEqual(settled.reservation.remote_task_ids, ['so_fixture_1']);
  const summary = fix.authority.summary();
  assert.equal(summary.budget.reserved, 0);
  assert.equal(summary.budget.spent, 1.5);
  assert.equal(summary.budget.available, 3.5);
  assert.equal(summary.slots.used, 1, 'settled tasks still consume the generation cap');
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'settled', actual_credits: 1.5 }).reused, true);
  assert.equal(fix.authority.recordOutcome('submitted', { state: 'settled', actual_credits: 1 }).status, 'terminal_receipt');
});

test('certainly-not-posted cancellation releases a slot and credit but never replays its key', (t) => {
  const fix = fixture(t, { ...baseGrant(), max_generations: 1 });
  const input = request('never-posted');
  fix.authority.reserve(input);
  assert.equal(fix.authority.reserve(request('slot-full', { estimated_credits: 0 })).status, 'generation_limit');
  assert.equal(fix.authority.recordOutcome(input.idempotency_key, { state: 'not_submitted' }).ok, true);
  assert.equal(fix.authority.summary().budget.reserved, 0);
  assert.equal(fix.authority.summary().slots.available, 1);
  const replay = fix.authority.reserve(input);
  assert.equal(replay.reused, true);
  assert.equal(replay.status, 'not_submitted');
  assert.equal(replay.can_submit, false);
  assert.equal(fix.authority.canSubmit(input.idempotency_key), false);
  assert.equal(fix.authority.recordOutcome(input.idempotency_key, { state: 'submitted' }).status, 'terminal_receipt');
  assert.equal(fix.authority.reserve(request('new-key')).ok, true);
  fix.reopen();
  assert.equal(fix.authority.getReceipt(input.idempotency_key).status, 'not_submitted');
  assert.equal(fix.authority.reserve(input).reused, true);
  assert.equal(fix.authority.summary().slots.used, 1);
  assert.equal(fix.authority.summary().slots.receipts, 2);
});

test('stop and restart retain unknown reservations and deny any new submission claim', (t) => {
  const grant = baseGrant();
  const fix = fixture(t, grant);
  fix.authority.reserve(request('unknown'));
  fix.authority.recordOutcome('unknown', { state: 'outcome_unknown' });
  fix.authority.reserve(request('queued'));
  assert.equal(fix.authority.stop(grant.grant_id).status, 'stopped');
  assert.equal(fix.authority.summary().budget.reserved, 4);
  assert.equal(fix.authority.canSubmit('queued'), false);
  assert.equal(fix.authority.recordOutcome('queued', { state: 'outcome_unknown' }).status, 'authorization_revoked');
  assert.equal(fix.authority.reserve(request('after-stop')).status, 'stopped');
  fix.reopen();
  assert.equal(fix.authority.summary().status, 'stopped');
  assert.equal(fix.authority.getReceipt('unknown').status, 'outcome_unknown');
  assert.equal(fix.authority.summary().budget.reserved, 4);
  assert.equal(fix.authority.reserve(request('after-restart')).status, 'stopped');
  assert.equal(fix.authority.recordOutcome('queued', { state: 'not_submitted' }).ok, true, 'executor can cancel a queued, never-posted task');
  assert.equal(fix.authority.summary().budget.reserved, 2);
  assert.equal(fix.authority.recordOutcome('unknown', { state: 'not_submitted' }).status, 'unsafe_release');
});

test('same-ID grant changes and expiry invalidate queued claims without erasing historical receipts', (t) => {
  const grant = baseGrant();
  const fix = fixture(t, grant);
  fix.authority.reserve(request('original'));
  fix.write({ ...grant, max_credits_total: 100 });
  assert.equal(fix.authority.summary().status, 'grant_changed');
  assert.equal(fix.authority.canSubmit('original'), false);
  assert.equal(fix.authority.reserve(request('changed')).status, 'grant_changed');
  fix.reopen();
  assert.equal(fix.authority.reserve(request('still-changed')).status, 'grant_changed');
  fix.write(grant);
  assert.equal(fix.authority.canSubmit('original'), true);
  fs.unlinkSync(fix.grantFile);
  assert.equal(fix.authority.canSubmit('original'), false);
  assert.equal(fix.authority.getReceipt('original').status, 'reserved');
  assert.equal(fix.authority.reserve(request('original')).reused, true, 'the existing receipt is readable even without its live grant');
  const soon = { ...baseGrant(), grant_id: 'short-lived-grant', expires_at: new Date(Date.now() + 60000).toISOString() };
  fix.write(soon);
  fix.authority.reserve(request('time-bound'));
  const originalClock = Date.now;
  Date.now = () => Date.parse(soon.expires_at) + 1;
  try {
    assert.equal(fix.authority.summary().status, 'grant_expired');
    assert.equal(fix.authority.canSubmit('time-bound'), false);
    assert.equal(fix.authority.recordOutcome('time-bound', { state: 'outcome_unknown' }).status, 'authorization_revoked');
    assert.equal(fix.authority.reserve(request('too-late')).status, 'grant_expired');
    assert.equal(fix.authority.getReceipt('time-bound').status, 'reserved');
    assert.equal(fix.authority.summary().budget.reserved, 2);
  } finally { Date.now = originalClock; }
});

test('an atomic unknown claim can be won once across two authority handles', (t) => {
  const fix = fixture(t);
  const other = createGenerationAuthority({ stateDir: fix.stateDir, grantFile: fix.grantFile });
  t.after(() => other.close());
  const first = fix.authority.reserve(request('atomic-claim'));
  assert.equal(other.reserve(request('atomic-claim')).reservation.id, first.reservation.id);
  assert.equal(fix.authority.canSubmit('atomic-claim'), true);
  assert.equal(other.canSubmit('atomic-claim'), true);
  assert.equal(fix.authority.recordOutcome('atomic-claim', { state: 'outcome_unknown' }).reused, false);
  assert.equal(other.recordOutcome('atomic-claim', { state: 'outcome_unknown' }).reused, true);
  assert.equal(other.canSubmit('atomic-claim'), false);
  assert.equal(fix.authority.summary().slots.used, 1);
  assert.equal(other.summary().budget.reserved, 2);
});

test('fractional finite credit accounting uses exact units rather than binary float headroom', (t) => {
  const fix = fixture(t, { ...baseGrant(), max_credits_per_request: 0.3, max_credits_total: 0.3 });
  assert.equal(fix.authority.reserve(request('fraction-a', { estimated_credits: 0.1 })).ok, true);
  assert.equal(fix.authority.reserve(request('fraction-b', { estimated_credits: 0.2 })).ok, true);
  assert.deepEqual(fix.authority.summary().budget, { max_credits_per_request: 0.3, max_credits_total: 0.3, reserved: 0.3, spent: 0, available: 0 });
  assert.equal(fix.authority.reserve(request('no-headroom', { estimated_credits: 0.000001 })).status, 'budget_blocked');
});

test('ACE-Step provider model ID and its compiler alias share one normalized authorization receipt', (t) => {
  const fix = fixture(t, { ...baseGrant(), models: ['ace-step-v1.5-xl'] });
  const input = request('step-model', { model: 'ace-step-1.5-xl' });
  const first = fix.authority.reserve(input);
  assert.equal(first.ok, true);
  assert.equal(first.reservation.model, 'ace-step-1.5-xl', 'receipt matches the actual provider payload model');
  assert.equal(fix.authority.reserve({ ...input, model: 'ace-step-v1.5-xl' }).reused, true);
  assert.equal(fix.authority.canSubmit(input.idempotency_key), true);
});
