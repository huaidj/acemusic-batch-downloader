// A durable finite controller driven by the existing Hub's explicit tick calls.
// No timer, provider session, network, audio, grant file or new service is used.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashObject, normalizeModel } from '../music/core.mjs';

const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const failure = (status, code, reason, extra = {}) => ({ ok: false, status, code, reason, ...extra });
const stoppedStatuses = new Set(['paused', 'stop', 'completed', 'blocked']);
const snapshotKeys = ['dictionary_snapshot_id', 'dictionary_version', 'dictionary_hash', 'taste_snapshot_id', 'taste_snapshot_hash', 'compiler_version', 'capability_snapshot_id', 'capability_snapshot_hash'];
function versions(value) {
  if (!OBJECT(value)) return null;
  const required = ['dictionary_version', 'dictionary_hash', 'taste_snapshot_id', 'compiler_version', 'capability_snapshot_id'];
  if (required.some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 256)) return null;
  if (!/^[a-f0-9]{64}$/i.test(value.dictionary_hash)) return null;
  return Object.fromEntries(snapshotKeys.filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
}
function sameVersions(left, right) {
  return snapshotKeys.every(key => left[key] === undefined || right[key] === undefined || left[key] === right[key]);
}
function assetView(value) {
  const asset = OBJECT(value?.asset) ? value.asset : value;
  if (!OBJECT(asset) || !idOK(asset.id) || asset.real_or_mock !== 'real' || asset.technical_review?.full_decode !== true || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '') || !integer(asset.generation_depth, 0, 10000)) return null;
  const snapshot = versions(asset.versions);
  if (!snapshot) return null;
  const listen = asset.human_listen;
  return { id: asset.id, sha256: asset.sha256.toLowerCase(), generation_depth: asset.generation_depth, versions: snapshot,
    actual_model: typeof (asset.actual_model || asset.requested_model) === 'string' ? normalizeModel(asset.actual_model || asset.requested_model) : null,
    human_accepted: listen?.accepted === true && (!listen.status || listen.status === 'accepted'),
    human_rejected: listen?.status === 'rejected', full_decode: true };
}
function sessionView(value) {
  const session = OBJECT(value?.session) ? value.session : value;
  if (!OBJECT(session) || !idOK(session.id) || !integer(session.max_generations, 1, 10000) || !integer(session.max_depth, 0, 10000)) return null;
  return { id: session.id, max_generations: session.max_generations, max_depth: session.max_depth, stopped: session.stopped === true || ['stop', 'stopped', 'cancelled'].includes(session.status) };
}
function jobView(value) {
  const job = OBJECT(value?.job) ? value.job : value;
  if (!OBJECT(job) || !idOK(job.id)) return null;
  const artifactIds = [...new Set([...(Array.isArray(job.artifact_ids) ? job.artifact_ids : []), ...(Array.isArray(job.artifacts) ? job.artifacts.map(asset => typeof asset === 'string' ? asset : asset?.id) : []), ...(idOK(job.artifact_id) ? [job.artifact_id] : [])].filter(idOK))];
  const requestedModel = job.requested_model || job.native_requested_model;
  const actualModels = [...new Set([...(Array.isArray(job.actual_models) ? job.actual_models : []), ...(typeof job.actual_model === 'string' ? [job.actual_model] : [])].filter(model => typeof model === 'string').map(normalizeModel))];
  return { id: job.id, status: typeof job.status === 'string' ? job.status : 'unknown', artifact_ids: artifactIds,
    requested_model: typeof requestedModel === 'string' ? normalizeModel(requestedModel) : null,
    mode: job.mode || job.request?.mode || null, versions: versions(job.versions),
    actual_models: actualModels, model_mismatch: Array.isArray(job.model_mismatch_task_ids) && job.model_mismatch_task_ids.length > 0, submission_unknown: job.submission_unknown === true,
    estimated_credits: job.estimated_credits, generation_depth: job.generation_depth };
}

export const MUSIC_LOOP_PREPARE_SCHEMA = { type: 'object', additionalProperties: false, required: ['session_id', 'anchor_artifact_id', 'max_generations', 'max_depth'], properties: {
  session_id: { type: 'string' }, anchor_artifact_id: { type: 'string' }, max_generations: { type: 'integer', minimum: 1, maximum: 100 }, max_depth: { type: 'integer', minimum: 1, maximum: 100 },
  seed: { type: 'integer', minimum: 0, maximum: 4294967295 }, exploration_ratio: { type: 'number', minimum: 0, maximum: 1 }, max_failures: { type: 'integer', minimum: 1, maximum: 10 }, max_rejections: { type: 'integer', minimum: 1, maximum: 10 },
} };

export function createMusicLoop({ stateDir, workflow } = {}) {
  if (typeof stateDir !== 'string' || !stateDir || !OBJECT(workflow) || ['getAsset', 'getSession', 'prepareNext', 'submitJob', 'getJob', 'authoritySummary'].some(key => typeof workflow[key] !== 'function')) throw new TypeError('Server-owned state and complete workflow callbacks are required.');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, 'music-loop.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS music_loops(id TEXT PRIMARY KEY,request_hash TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS music_loop_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,loop_id TEXT NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL);`);
  let closed = false;
  const inflight = new Map();
  const decode = row => row ? JSON.parse(row.data) : null;
  const load = id => decode(db.prepare('SELECT data FROM music_loops WHERE id=?').get(id));
  // The explicit column list prevents depending on SQLite's rowid layout.
  function emit(loop, type, data = {}) { db.prepare('INSERT INTO music_loop_events(loop_id,at,type,data) VALUES(?,?,?,?)').run(loop.id, now(), type, JSON.stringify(data)); }
  function save(loop, type, detail = {}) { loop.updated_at = now(); db.prepare('UPDATE music_loops SET data=? WHERE id=?').run(JSON.stringify(loop), loop.id); if (type) emit(loop, type, detail); }
  function tx(work) { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function safe(work) { if (closed) return failure('closed', 'LOOP_CLOSED', '有限循環帳本已關閉。'); try { return work(); } catch { return failure('failed', 'LOOP_STORAGE_FAILED', '循環帳本未完成操作，既有工作與進度保留。'); } }
  const wrap = loop => ({ ok: true, status: loop.status, loop: clone(loop), quality_verified: false });
  function block(loop, code, reason) {
    if (!['stop', 'paused', 'completed'].includes(loop.status)) loop.status = 'blocked';
    loop.blocked_reason = code; loop.message = reason; save(loop, 'blocked', { code }); return failure(loop.status, code, reason, { loop: clone(loop) });
  }
  function complete(loop, condition) {
    if (!['stop', 'paused'].includes(loop.status)) loop.status = 'completed';
    if (loop.pending) loop.history.push({ iteration: loop.pending.iteration, job_id: loop.pending.job_id, seed: loop.pending.seed, artifact_ids: loop.pending.artifact_ids || [], status: 'condition_reached', condition });
    loop.stop_condition = condition; loop.phase = 'idle'; loop.pending = null;
    loop.message = '有限流程已達停止條件；不代表整體音樂品質或演出驗收通過。';
    save(loop, 'condition_reached', { condition }); return wrap(loop);
  }
  function authority(loop, job = null) {
    let summary; try { summary = workflow.authoritySummary(); } catch { return failure('blocked', 'LOOP_AUTH_UNAVAILABLE', '無法核對獨立自動繼續授權。'); }
    if (!OBJECT(summary) || summary.then || summary.ok !== true || !OBJECT(summary.grant) || summary.grant.allow_auto_continue !== true) return failure('blocked', 'LOOP_AUTO_NOT_AUTHORIZED', '此批次沒有明確的自動繼續授權。');
    const grant = summary.grant, budget = summary.budget;
    if (!idOK(grant.grant_id || grant.id) || typeof grant.expires_at !== 'string' || !/Z$/.test(grant.expires_at) || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) return failure('blocked', 'LOOP_GRANT_EXPIRED', '自動循環授權已到期或缺少有效期限。');
    if (!Array.isArray(grant.models) || !grant.models.length || grant.models.some(model => !['acemusic-v1', 'acemusic-v1.1', 'ace-step-v1.5-xl'].includes(normalizeModel(model))) || !Array.isArray(grant.modes) || !grant.modes.length || grant.modes.some(mode => !['idea', 'custom'].includes(mode)) || !integer(grant.max_generations, 1, 10000) || loop.max_generations > grant.max_generations) return failure('blocked', 'LOOP_GRANT_SCOPE', '模型、模式或有限任務數不在自動授權範圍。');
    if (!OBJECT(budget) || !finite(budget.available)) return failure('blocked', 'LOOP_BUDGET_UNKNOWN', '無法確認獨立批次剩餘預算。');
    if (job) {
      if (!job.requested_model || !grant.models.map(normalizeModel).includes(job.requested_model) || !grant.modes.includes(job.mode)) return failure('blocked', 'LOOP_MODEL_SCOPE', '下一代模型或模式不在授權範圍，需要重新審閱。');
      if (!finite(job.estimated_credits)) return failure('blocked', 'LOOP_COST_UNKNOWN', '下一代費用尚未核實，不會假設為零。');
      const perRequest = budget.max_credits_per_request ?? grant.max_credits_per_request;
      if (job.estimated_credits > budget.available || perRequest !== undefined && (!finite(perRequest) || job.estimated_credits > perRequest) || summary.slots?.available !== undefined && summary.slots.available < 1) return failure('blocked', 'LOOP_BUDGET_LIMIT', '下一代超過剩餘預算、單次上限或任務數。');
    }
    return { ok: true, grant: { grant_id: grant.grant_id || grant.id, expires_at: grant.expires_at, models: [...grant.models], modes: [...grant.modes], max_generations: grant.max_generations, allow_auto_continue: true }, available: budget.available };
  }
  async function sessionFor(loop) {
    const session = sessionView(await workflow.getSession(loop.session_id));
    if (!session || session.id !== loop.session_id || session.stopped || loop.max_generations > session.max_generations || loop.max_depth > session.max_depth) return failure('blocked', 'LOOP_SESSION_SCOPE', '會話已停止、無效或有限條件超出會話範圍。');
    return { ok: true, session };
  }
  // Preparing can already have created a job in the workflow. Its missing ID
  // requires reconciliation, never a repeated prepare callback after restart.
  tx(() => {
    for (const row of db.prepare('SELECT data FROM music_loops').all()) {
      const loop = decode(row);
      if (loop.phase === 'preparing') { if (!['stop', 'paused'].includes(loop.status)) loop.status = 'blocked'; loop.blocked_reason = 'prepare_outcome_unknown'; loop.message = '準備工作可能已建立任務；需要人工按原幂等識別對帳，不能重做。'; save(loop, 'restart_prepare_unknown'); }
      else if (loop.phase === 'submitting') { loop.phase = 'awaiting_job'; if (!['stop', 'paused'].includes(loop.status)) loop.status = 'blocked'; loop.blocked_reason = 'submit_outcome_unknown'; loop.message = '提交結果未知；只核對原任務，不會重送。'; save(loop, 'restart_submit_unknown'); }
    }
  });
  async function prepare(input = {}) {
    if (closed) return failure('closed', 'LOOP_CLOSED', '有限循環帳本已關閉。');
    if (!OBJECT(input) || Object.keys(input).some(key => !Object.prototype.hasOwnProperty.call(MUSIC_LOOP_PREPARE_SCHEMA.properties, key)) || !idOK(input.session_id) || !idOK(input.anchor_artifact_id) || !integer(input.max_generations, 1, 100) || !integer(input.max_depth, 1, 100) || input.seed !== undefined && !integer(input.seed, 0, 4294967295) || input.exploration_ratio !== undefined && (!finite(input.exploration_ratio) || input.exploration_ratio > 1) || input.max_failures !== undefined && !integer(input.max_failures, 1, 10) || input.max_rejections !== undefined && !integer(input.max_rejections, 1, 10)) return failure('invalid', 'LOOP_FINITE_INPUT_REQUIRED', '需要有效錨點、會話與有限代數/深度/失敗停止條件，不能由請求提供授權或費用。');
    try {
      const anchor = assetView(await workflow.getAsset(input.anchor_artifact_id));
      if (!anchor || anchor.id !== input.anchor_artifact_id || !anchor.human_accepted) return failure('invalid_anchor', 'LOOP_ACCEPTED_REAL_ANCHOR_REQUIRED', '錨點必須是完整解碼、使用者明確接受的真實產物，且有可追溯版本。');
      const session = sessionView(await workflow.getSession(input.session_id));
      if (!session || session.stopped || session.id !== input.session_id || input.max_generations > session.max_generations || input.max_depth > session.max_depth) return failure('blocked', 'LOOP_SESSION_SCOPE', '有限條件超出有效會話範圍。');
      if (anchor.generation_depth >= input.max_depth) return failure('blocked', 'LOOP_DEPTH_LIMIT', '錨點已達指定譜系深度上限。');
      const settings = { session_id: input.session_id, anchor_artifact_id: input.anchor_artifact_id, max_generations: input.max_generations, max_depth: input.max_depth, seed: input.seed ?? 0, exploration_ratio: input.exploration_ratio ?? 0.2, max_failures: input.max_failures ?? 3, max_rejections: input.max_rejections ?? 2 };
      const requestHash = hashObject({ ...settings, anchor_hash: anchor.sha256, snapshot_ids: anchor.versions });
      return safe(() => tx(() => {
        const existing = decode(db.prepare('SELECT data FROM music_loops WHERE request_hash=?').get(requestHash));
        if (existing) return { ...wrap(existing), reused: true };
        const loop = { ...settings, id: `music_loop_${requestHash.slice(0, 24)}`, request_hash: requestHash, status: 'paused', phase: 'idle', started: false,
          original_anchor: anchor, current_anchor: anchor, current_model: anchor.actual_model, snapshot_ids: anchor.versions, generations_submitted: 0, accepted_generations: 0, rejected_generations: 0, failures: 0,
          pending: null, history: [], seen_hashes: [anchor.sha256], created_at: now(), updated_at: now(),
          stop_conditions: ['max_generations', 'max_depth', 'max_failures', 'max_rejections', 'budget_or_auth', 'unknown_result', 'model_or_snapshot_change', 'duplicate_hash', 'user_stop'],
          quality_verified: false, automatic_acceptance: false, message: '已準備有限計畫；開始前仍須獨立自動繼續授權。' };
        db.prepare('INSERT INTO music_loops VALUES(?,?,?)').run(loop.id, requestHash, JSON.stringify(loop)); emit(loop, 'prepared'); return wrap(loop);
      }));
    } catch { return failure('failed', 'LOOP_WORKFLOW_UNAVAILABLE', '無法讀取可核驗的錨點或會話，未建立自動任務。'); }
  }
  async function start(input, resuming = false) {
    const id = typeof input === 'string' ? input : input?.loop_id;
    if (!idOK(id)) return failure('invalid', 'LOOP_ID_REQUIRED', '需要有限循環識別碼。');
    try {
      let loop = load(id); if (!loop) return failure('not_found', 'LOOP_NOT_FOUND', '找不到有限循環。');
      if (['stop', 'completed'].includes(loop.status)) return failure(loop.status, 'LOOP_TERMINAL', '已停止或完成的循環不會重新啟動。', { loop });
      if (loop.phase === 'preparing' || loop.blocked_reason === 'prepare_outcome_unknown') return block(loop, 'prepare_outcome_unknown', '須先按原幂等識別人工對帳，不能重做準備。');
      const session = await sessionFor(loop); if (!session.ok) return block(loop, session.code, session.reason);
      loop = load(id);
      if (['stop', 'completed'].includes(loop.status)) return wrap(loop);
      const auth = authority(loop, loop.pending?.job || null); if (!auth.ok) return block(loop, auth.code, auth.reason);
      loop.status = loop.pending ? 'awaiting_feedback' : 'running'; loop.started = true; loop.grant_snapshot = auth.grant; loop.blocked_reason = null;
      loop.message = '僅在每代真實人類試聽後，按有限條件決定下一步。'; save(loop, resuming ? 'resumed' : 'started'); return wrap(loop);
    } catch { return failure('failed', 'LOOP_WORKFLOW_UNAVAILABLE', '循環尚未啟動，請檢查既有會話狀態。'); }
  }
  function control(input, status) {
    const id = typeof input === 'string' ? input : input?.loop_id;
    return safe(() => { if (!idOK(id)) return failure('invalid', 'LOOP_ID_REQUIRED', '需要有限循環識別碼。'); const loop = load(id); if (!loop) return failure('not_found', 'LOOP_NOT_FOUND', '找不到有限循環。'); if (loop.status === 'completed' || loop.status === 'stop') return wrap(loop); loop.status = status; loop.message = status === 'stop' ? '停止新增提交；已送出任務仍可核對及回收，不代表遠端取消。' : '已暫停新增提交；在途任務仍保留。'; save(loop, status); return wrap(loop); });
  }
  async function poll(loop) {
    const pending = loop.pending;
    if (!pending?.job_id) return block(loop, 'missing_inflight_job', '在途任務缺少可核對識別，不會重新提交。');
    const result = await workflow.getJob(pending.job_id), job = jobView(result);
    loop = load(loop.id);
    if (!job || job.id !== pending.job_id) return block(loop, 'job_status_unknown', '無法核對原任務；不會重送。');
    if (job.requested_model && job.requested_model !== pending.job.requested_model || job.actual_models.some(model => model !== pending.job.requested_model) || job.model_mismatch || job.versions && !sameVersions(loop.snapshot_ids, job.versions) || job.status === 'needs_recompile') return block(loop, 'model_or_snapshot_changed', '原任務模型或詞典版本改變，停止後續生成。');
    if (['outcome_unknown', 'unknown'].includes(job.status) || job.submission_unknown) return block(loop, 'submit_outcome_unknown', '原提交結果仍未知；保留工作識別，不會重送。');
    if (['auth_required', 'budget_blocked', 'awaiting_authorization', 'unsupported', 'policy_blocked'].includes(job.status)) return block(loop, job.status, '原任務遇到授權、預算或能力限制，停止新增提交。');
    if (!job.artifact_ids.length) {
      if (['failed', 'cancelled', 'canceled', 'rejected'].includes(job.status)) {
        loop.failures++; loop.history.push({ iteration: pending.iteration, job_id: job.id, seed: pending.seed, status: 'failed' }); loop.pending = null; loop.phase = 'idle'; save(loop, 'generation_failed');
        if (loop.failures >= loop.max_failures) return complete(loop, 'max_failures');
        if (loop.generations_submitted >= loop.max_generations) return complete(loop, 'max_generations');
        if (!stoppedStatuses.has(loop.status)) loop.status = 'running'; save(loop); return wrap(loop);
      }
      if (['accepted', 'done', 'completed', 'succeeded'].includes(job.status)) return block(loop, 'missing_real_artifacts', '任務未提供已核驗產物，不算生成完成。');
      if (!stoppedStatuses.has(loop.status)) loop.status = 'awaiting_feedback'; save(loop); return wrap(loop);
    }
    const assets = [];
    for (const artifactId of job.artifact_ids) {
      const asset = assetView(await workflow.getAsset(artifactId));
      if (!asset || asset.id !== artifactId) return block(load(loop.id), 'artifact_not_verified', '產物尚未完整解碼或缺少真實來源版本，停止新增提交。');
      assets.push(asset);
    }
    loop = load(loop.id);
    if (assets.some(asset => !sameVersions(loop.snapshot_ids, asset.versions) || asset.actual_model && asset.actual_model !== pending.job.requested_model || asset.generation_depth <= loop.current_anchor.generation_depth || asset.generation_depth > loop.max_depth)) return block(loop, 'lineage_or_snapshot_changed', '產物譜系深度、模型或版本不符原計畫，不會放寬限制。');
    const hashes = assets.map(asset => asset.sha256);
    loop.pending.artifact_ids = assets.map(asset => asset.id);
    if (new Set(hashes).size !== hashes.length || hashes.some(hash => loop.seen_hashes.includes(hash))) return complete(loop, 'duplicate_hash');
    const accepted = assets.filter(asset => asset.human_accepted).sort((left, right) => left.id.localeCompare(right.id));
    const rejected = assets.every(asset => asset.human_rejected);
    if (!accepted.length && !rejected) { if (!stoppedStatuses.has(loop.status)) loop.status = 'awaiting_feedback'; loop.phase = 'awaiting_job'; loop.pending.artifact_ids = job.artifact_ids; save(loop, 'awaiting_human_feedback'); return wrap(loop); }
    const decision = accepted.length ? 'accepted' : 'rejected';
    loop.history.push({ iteration: pending.iteration, job_id: job.id, seed: pending.seed, artifact_ids: assets.map(asset => asset.id), status: decision, selected_anchor_id: accepted[0]?.id || null });
    loop.seen_hashes = [...new Set([...loop.seen_hashes, ...hashes])]; loop.pending = null; loop.phase = 'idle';
    if (accepted.length) { loop.current_anchor = accepted[0]; loop.snapshot_ids = accepted[0].versions; loop.accepted_generations++; }
    else { loop.rejected_generations++; loop.current_anchor = clone(loop.original_anchor); }
    save(loop, 'human_feedback_observed', { decision });
    if (loop.current_anchor.generation_depth >= loop.max_depth) return complete(loop, 'max_depth');
    if (loop.rejected_generations >= loop.max_rejections) return complete(loop, 'max_rejections');
    if (loop.generations_submitted >= loop.max_generations) return complete(loop, 'max_generations');
    if (!stoppedStatuses.has(loop.status)) loop.status = 'running'; save(loop); return wrap(loop);
  }
  async function performTick(id) {
    let loop = load(id); if (!loop) return failure('not_found', 'LOOP_NOT_FOUND', '找不到有限循環。');
    if (loop.status === 'completed') return wrap(loop);
    if (!['paused', 'stop'].includes(loop.status)) {
      const auth = authority(loop, loop.pending?.job || null); if (!auth.ok) block(loop, auth.code, auth.reason);
      const session = await sessionFor(loop); loop = load(id); if (!session.ok) block(loop, session.code, session.reason);
    }
    loop = load(id);
    if (loop.pending?.submit_attempted) return poll(loop);
    if (stoppedStatuses.has(loop.status)) return wrap(loop);
    if (loop.generations_submitted >= loop.max_generations) return complete(loop, 'max_generations');
    if (loop.current_anchor.generation_depth >= loop.max_depth) return complete(loop, 'max_depth');
    if (!loop.pending) {
      const iteration = loop.generations_submitted + 1;
      const seed = loop.exploration_ratio === 0 ? loop.seed : parseInt(hashObject({ base: loop.seed, iteration, anchor_hash: loop.current_anchor.sha256 }).slice(0, 8), 16) >>> 0;
      loop.pending = { iteration, seed, idempotency_key: `${loop.id}:${iteration}`, parent_artifact_id: loop.current_anchor.id, submit_attempted: false, job_id: null };
      loop.phase = 'preparing'; save(loop, 'prepare_started', { iteration, seed });
      let result;
      try { result = await workflow.prepareNext({ artifact_id: loop.current_anchor.id, session_id: loop.session_id, seed, loop_id: loop.id, iteration, idempotency_key: loop.pending.idempotency_key, exploration_ratio: loop.exploration_ratio, exploration_proposal: { max_changed_dimensions: loop.exploration_ratio === 0 ? 0 : loop.exploration_ratio <= 0.25 ? 1 : 2, preserve_hard_constraints: true } }); }
      catch { return block(load(id), 'prepare_outcome_unknown', '準備工作結果未知，需按原幂等識別人工對帳，不能重做。'); }
      const job = jobView(result); loop = load(id);
      if (result?.ok === false || !job) return block(loop, 'prepare_outcome_unknown', '準備未回傳可持久核對的工作識別，不能重試此代。');
      loop.pending.job_id = job.id; loop.pending.job = job; loop.phase = 'prepared_job'; save(loop, 'job_prepared', { job_id: job.id });
    }
    loop = load(id);
    if (stoppedStatuses.has(loop.status)) return wrap(loop);
    const job = loop.pending.job;
    if (!job.versions || !sameVersions(loop.snapshot_ids, job.versions) || loop.current_model && job.requested_model !== loop.current_model || !integer(job.generation_depth, loop.current_anchor.generation_depth + 1, loop.max_depth)) return block(loop, 'prepared_lineage_or_snapshot_changed', '下一代缺少原版本、模型或有效譜系深度，不會提交。');
    const session = await sessionFor(loop); loop = load(id); if (!session.ok) return block(loop, session.code, session.reason);
    if (stoppedStatuses.has(loop.status)) return wrap(loop);
    const auth = authority(loop, job); if (!auth.ok) return block(loop, auth.code, auth.reason);
    // Persist the irreversible claim before invoking the callback. A restart or
    // an exception never makes this job eligible for a second submit call.
    loop.pending.submit_attempted = true; loop.phase = 'submitting'; loop.generations_submitted++; loop.grant_snapshot = auth.grant; loop.current_model ??= job.requested_model;
    save(loop, 'submit_claimed', { job_id: job.id, iteration: loop.pending.iteration });
    let submitted;
    try { submitted = await workflow.submitJob(job.id); }
    catch { loop = load(id); loop.phase = 'awaiting_job'; return block(loop, 'submit_outcome_unknown', '提交結果未知；只核對原工作，不會重送。'); }
    loop = load(id); loop.phase = 'awaiting_job';
    if (submitted?.ok === false || submitted?.submission_unknown === true || submitted?.status === 'outcome_unknown') return block(loop, submitted?.submission_unknown === false ? 'submission_blocked' : 'submit_outcome_unknown', '提交未獲完整確認；保留原工作且停止後續提交。');
    if (!OBJECT(submitted) || submitted.ok !== true) return block(loop, 'submit_outcome_unknown', '提交回應無法核對；不會重送。');
    if (!['stop', 'paused', 'blocked'].includes(loop.status)) loop.status = 'awaiting_feedback';
    save(loop, 'submit_returned', { job_id: job.id }); return wrap(loop);
  }
  function tick(input) {
    const id = typeof input === 'string' ? input : input?.loop_id;
    if (closed) return Promise.resolve(failure('closed', 'LOOP_CLOSED', '有限循環帳本已關閉。'));
    if (!idOK(id)) return Promise.resolve(failure('invalid', 'LOOP_ID_REQUIRED', '需要有限循環識別碼。'));
    if (inflight.has(id)) return inflight.get(id);
    const result = (async () => { try { return await performTick(id); } catch { return failure('blocked', 'LOOP_CALLBACK_FAILED', '無法完成循環核對；沒有重新提交未知工作。'); } finally { inflight.delete(id); } })();
    inflight.set(id, result); return result;
  }
  return {
    prepare, start(input) { return start(input); }, resume(input) { return start(input, true); }, pause(input) { return control(input, 'paused'); }, stop(input) { return control(input, 'stop'); }, tick,
    get(input) { const id = typeof input === 'string' ? input : input?.loop_id; return safe(() => { if (!idOK(id)) return failure('invalid', 'LOOP_ID_REQUIRED', '需要有限循環識別碼。'); const loop = load(id); return loop ? wrap(loop) : failure('not_found', 'LOOP_NOT_FOUND', '找不到有限循環。'); }); },
    list() { return safe(() => ({ ok: true, loops: db.prepare('SELECT data FROM music_loops ORDER BY rowid DESC LIMIT 100').all().map(decode) })); },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
