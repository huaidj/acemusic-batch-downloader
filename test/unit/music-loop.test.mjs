import { test } from 'node:test';
import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMusicLoop } from '../../agent/lib/music-loop.mjs';

const ROOT = path.join(process.env.ACE_TEST_TEMP || os.tmpdir(), 'HuaiDJ-ACE-phase2-loops');
fs.mkdirSync(ROOT, { recursive: true });
const snapshot = { dictionary_snapshot_id: 'fixture_dict', dictionary_version: 'fixture-1', dictionary_hash: 'a'.repeat(64), taste_snapshot_id: 'fixture_taste', compiler_version: 'fixture-1', capability_snapshot_id: 'fixture_cap', capability_snapshot_hash: 'b'.repeat(64) };
const asset = (id, depth, hash, accepted = true) => ({ id, generation_depth: depth, sha256: hash.repeat(64), real_or_mock: 'real', technical_review: { full_decode: true }, human_listen: { status: accepted ? 'accepted' : 'awaiting_listen', accepted }, actual_model: 'acemusic-v1.1', versions: structuredClone(snapshot) });
function fake() {
  const assets = new Map([['anchor', asset('anchor', 0, '1')]]), jobs = new Map();
  const calls = { prepare: [], submit: [], getJob: [] };
  const state = { auto: true, available: 10, expires: new Date(Date.now() + 3600000).toISOString(), model: 'acemusic-v1.1', estimate: 1 };
  const workflow = {
    async getAsset(id) { return { ok: true, asset: structuredClone(assets.get(id)) }; },
    async getSession(id) { return { ok: true, session: { id, max_generations: 10, max_depth: 10 } }; },
    async prepareNext(input) {
      calls.prepare.push(structuredClone(input));
      const parent = assets.get(input.artifact_id);
      const job = { id: `job_${calls.prepare.length}`, status: 'awaiting_authorization', requested_model: state.model, mode: 'custom', versions: structuredClone(parent.versions), generation_depth: parent.generation_depth + 1, estimated_credits: state.estimate, artifact_ids: [] };
      jobs.set(job.id, job); return { ok: true, job: structuredClone(job) };
    },
    async submitJob(id) { calls.submit.push(id); jobs.get(id).status = 'submitting'; return { ok: true, status: 'queued' }; },
    async getJob(id) { calls.getJob.push(id); return { ok: true, job: structuredClone(jobs.get(id)) }; },
    authoritySummary() { return { ok: true, status: 'ready', grant: { grant_id: 'fixture_grant', allow_auto_continue: state.auto, expires_at: state.expires, models: ['acemusic-v1.1'], modes: ['custom'], max_generations: 10, max_credits_per_request: 2 }, budget: { available: state.available, max_credits_per_request: 2 } }; },
  };
  function produce(jobId, { accepted = false, rejected = false, hash } = {}) {
    const job = jobs.get(jobId), id = `artifact_${jobId}`;
    const next = asset(id, job.generation_depth, hash || (jobId === 'job_1' ? '2' : '3'), accepted);
    if (rejected) next.human_listen = { status: 'rejected', accepted: false };
    assets.set(id, next); job.artifact_ids = [id]; job.status = accepted ? 'accepted' : rejected ? 'rejected' : 'awaiting_listen'; return id;
  }
  return { workflow, assets, jobs, calls, state, produce };
}
const settings = extra => ({ session_id: 'session_fixture', anchor_artifact_id: 'anchor', max_generations: 2, max_depth: 2, seed: 123, max_failures: 2, max_rejections: 2, ...extra });
const instance = workflow => createMusicLoop({ stateDir: fs.mkdtempSync(path.join(ROOT, 'fixture-')), workflow });

test('finite loops require a true human-accepted decoded anchor and explicit auto-continuation grant', async () => {
  const fixture = fake(), loop = instance(fixture.workflow);
  try {
    fixture.assets.get('anchor').human_listen.accepted = false;
    assert.equal((await loop.prepare(settings())).code, 'LOOP_ACCEPTED_REAL_ANCHOR_REQUIRED');
    fixture.assets.get('anchor').human_listen.accepted = true;
    fixture.assets.get('anchor').real_or_mock = 'mock';
    assert.equal((await loop.prepare(settings())).status, 'invalid_anchor');
    fixture.assets.get('anchor').real_or_mock = 'real';
    assert.equal((await loop.prepare(settings({ max_generations: Infinity }))).status, 'invalid');
    assert.equal((await loop.prepare({ ...settings(), grant: { allow_auto_continue: true } })).status, 'invalid');
    const prepared = await loop.prepare(settings());
    assert.equal(prepared.status, 'paused');
    fixture.state.auto = false;
    assert.equal((await loop.start(prepared.loop.id)).code, 'LOOP_AUTO_NOT_AUTHORIZED');
    assert.equal(fixture.calls.submit.length, 0);
    assert.equal(fixture.calls.prepare.length, 0);
  } finally { loop.close(); }
});

test('two finite generations wait for actual human feedback, update the accepted anchor, then stop', async () => {
  const fixture = fake(), loop = instance(fixture.workflow);
  try {
    const prepared = await loop.prepare(settings()), id = prepared.loop.id;
    assert.equal((await loop.start(id)).status, 'running');
    assert.equal((await loop.tick(id)).status, 'awaiting_feedback');
    assert.equal((await loop.tick(id)).status, 'awaiting_feedback'); // ordinary submitting is not unknown
    assert.equal(fixture.calls.prepare.length, 1);
    const firstAsset = fixture.produce('job_1');
    assert.equal((await loop.tick(id)).status, 'awaiting_feedback');
    assert.equal(fixture.calls.submit.length, 1);
    fixture.assets.get(firstAsset).human_listen = { accepted: true, status: 'accepted' };
    assert.equal((await loop.tick(id)).status, 'running');
    assert.equal(loop.get(id).loop.current_anchor.id, firstAsset);
    await loop.tick(id);
    assert.equal(fixture.calls.prepare[1].artifact_id, firstAsset);
    assert.equal(fixture.calls.prepare[1].exploration_proposal.preserve_hard_constraints, true);
    assert.notEqual(fixture.calls.prepare[0].idempotency_key, fixture.calls.prepare[1].idempotency_key);
    fixture.produce('job_2', { accepted: true });
    const completed = await loop.tick(id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.loop.stop_condition, 'max_depth');
    assert.equal(completed.loop.generations_submitted, 2);
    assert.equal(completed.loop.accepted_generations, 2);
    assert.equal(completed.quality_verified, false);
    await loop.tick(id);
    assert.equal(fixture.calls.submit.length, 2);
  } finally { loop.close(); }
});

test('concurrent ticks share one in-flight preparation and one submission', async () => {
  const fixture = fake(), loop = instance(fixture.workflow);
  try {
    const id = (await loop.prepare(settings())).loop.id;
    await loop.start(id);
    const [first, second] = await Promise.all([loop.tick(id), loop.tick(id)]);
    assert.equal(first.status, 'awaiting_feedback');
    assert.deepEqual(first, second);
    assert.equal(fixture.calls.prepare.length, 1);
    assert.equal(fixture.calls.submit.length, 1);
  } finally { loop.close(); }
});

test('unknown submission survives restart without a second prepare or submit call', async () => {
  const fixture = fake(), stateDir = fs.mkdtempSync(path.join(ROOT, 'restart-'));
  fixture.workflow.submitJob = async id => { fixture.calls.submit.push(id); fixture.jobs.get(id).status = 'outcome_unknown'; throw new Error('private path or provider message must not be stored'); };
  let loop = createMusicLoop({ stateDir, workflow: fixture.workflow });
  const id = (await loop.prepare(settings())).loop.id;
  await loop.start(id);
  assert.equal((await loop.tick(id)).code, 'submit_outcome_unknown');
  assert.equal(loop.get(id).loop.pending.job_id, 'job_1');
  loop.close();
  // Simulate a process dying immediately after its durable submit claim.
  const db = new DatabaseSync(path.join(stateDir, 'music-loop.sqlite'));
  const stored = JSON.parse(db.prepare('SELECT data FROM music_loops WHERE id=?').get(id).data); stored.phase = 'submitting';
  db.prepare('UPDATE music_loops SET data=? WHERE id=?').run(JSON.stringify(stored), id); db.close();
  loop = createMusicLoop({ stateDir, workflow: fixture.workflow });
  try {
    assert.equal(loop.get(id).loop.blocked_reason, 'submit_outcome_unknown');
    await loop.tick(id);
    await loop.tick(id);
    assert.equal(fixture.calls.prepare.length, 1);
    assert.equal(fixture.calls.submit.length, 1);
    assert.equal(loop.get(id).loop.generations_submitted, 1);
    assert.doesNotMatch(JSON.stringify(loop.get(id)), /private path/);
  } finally { loop.close(); }
});

test('a crash after preparation begins but before job persistence requires reconciliation', async () => {
  const fixture = fake(), stateDir = fs.mkdtempSync(path.join(ROOT, 'prepare-unknown-'));
  fixture.workflow.prepareNext = async input => { fixture.calls.prepare.push(input); throw new Error('job may have been created'); };
  let loop = createMusicLoop({ stateDir, workflow: fixture.workflow });
  const id = (await loop.prepare(settings())).loop.id;
  await loop.start(id);
  assert.equal((await loop.tick(id)).code, 'prepare_outcome_unknown');
  loop.close();
  loop = createMusicLoop({ stateDir, workflow: fixture.workflow });
  try {
    assert.equal((await loop.resume(id)).code, 'prepare_outcome_unknown');
    await loop.tick(id);
    assert.equal(fixture.calls.prepare.length, 1);
    assert.equal(fixture.calls.submit.length, 0);
  } finally { loop.close(); }
});

test('pause permits collecting original feedback while preventing a new generation; stop is terminal', async () => {
  const fixture = fake(), loop = instance(fixture.workflow);
  try {
    const id = (await loop.prepare(settings())).loop.id; await loop.start(id); await loop.tick(id);
    assert.equal(loop.pause(id).status, 'paused');
    fixture.produce('job_1', { accepted: true });
    assert.equal((await loop.tick(id)).status, 'paused');
    await loop.tick(id);
    assert.equal(fixture.calls.submit.length, 1);
    assert.equal((await loop.resume(id)).status, 'running');
    await loop.tick(id);
    assert.equal(fixture.calls.submit.length, 2);
    assert.equal(loop.stop(id).status, 'stop');
    fixture.produce('job_2', { accepted: true });
    assert.equal((await loop.tick(id)).status, 'stop');
    assert.equal((await loop.resume(id)).code, 'LOOP_TERMINAL');
    assert.equal(fixture.calls.submit.length, 2);
  } finally { loop.close(); }
});

test('pausing while prepare is awaiting a callback saves its job but does not submit it', async () => {
  const fixture = fake(), original = fixture.workflow.prepareNext;
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  fixture.workflow.prepareNext = async input => { entered(); await new Promise(resolve => { release = resolve; }); return original(input); };
  const loop = instance(fixture.workflow);
  try {
    const id = (await loop.prepare(settings())).loop.id; await loop.start(id);
    const ticking = loop.tick(id); await ready; loop.pause(id); release();
    assert.equal((await ticking).status, 'paused');
    assert.equal(loop.get(id).loop.pending.job_id, 'job_1');
    assert.equal(fixture.calls.submit.length, 0);
    await loop.resume(id); await loop.tick(id);
    assert.equal(fixture.calls.prepare.length, 1);
    assert.equal(fixture.calls.submit.length, 1);
  } finally { loop.close(); }
});

test('budget, expiry, fee uncertainty and model changes block before additional submissions', async () => {
  for (const mutate of [fixture => { fixture.state.available = 0; }, fixture => { fixture.state.estimate = undefined; }, fixture => { fixture.state.model = 'acemusic-v1'; }]) {
    const fixture = fake(), loop = instance(fixture.workflow);
    try { const id = (await loop.prepare(settings())).loop.id; await loop.start(id); mutate(fixture); assert.equal((await loop.tick(id)).status, 'blocked'); assert.equal(fixture.calls.submit.length, 0); }
    finally { loop.close(); }
  }
  const fixture = fake(), loop = instance(fixture.workflow);
  try { const id = (await loop.prepare(settings())).loop.id; fixture.state.expires = '2020-01-01T00:00:00Z'; assert.equal((await loop.start(id)).code, 'LOOP_GRANT_EXPIRED'); assert.equal(fixture.calls.submit.length, 0); }
  finally { loop.close(); }
});

test('rejections return to the original accepted anchor and reach a finite rejection threshold', async () => {
  const fixture = fake(), loop = instance(fixture.workflow);
  try {
    const id = (await loop.prepare(settings({ max_generations: 3, max_depth: 3, max_rejections: 2 }))).loop.id;
    await loop.start(id); await loop.tick(id); fixture.produce('job_1', { rejected: true });
    assert.equal((await loop.tick(id)).status, 'running');
    await loop.tick(id);
    assert.equal(fixture.calls.prepare[1].artifact_id, 'anchor');
    fixture.produce('job_2', { rejected: true });
    const result = await loop.tick(id);
    assert.equal(result.status, 'completed');
    assert.equal(result.loop.stop_condition, 'max_rejections');
    assert.equal(result.loop.accepted_generations, 0);
    assert.equal(fixture.calls.submit.length, 2);
  } finally { loop.close(); }
});

test('duplicate audio and invalid lineage depth stop the loop without declaring music acceptance', async () => {
  const fixture = fake(), loop = instance(fixture.workflow);
  try {
    const id = (await loop.prepare(settings())).loop.id; await loop.start(id); await loop.tick(id);
    fixture.produce('job_1', { hash: '1' });
    const result = await loop.tick(id);
    assert.equal(result.status, 'completed'); assert.equal(result.loop.stop_condition, 'duplicate_hash'); assert.equal(result.quality_verified, false); assert.equal(fixture.calls.submit.length, 1); assert.equal(result.loop.history[0].job_id, 'job_1');
  } finally { loop.close(); }
  const depthFixture = fake(); depthFixture.assets.get('anchor').generation_depth = 2;
  const depthLoop = instance(depthFixture.workflow);
  try { assert.equal((await depthLoop.prepare(settings())).code, 'LOOP_DEPTH_LIMIT'); }
  finally { depthLoop.close(); }
});
