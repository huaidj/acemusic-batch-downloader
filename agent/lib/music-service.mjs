// Hub-owned workflow ledger. Independent server authorities gate provider access.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPromptCompiler, mergeReviewedDictionary, normalizeModel, COMPILER_VERSION } from '../music/core.mjs';
import { MUSIC_CONTRACT, validateMusicInput } from './music-contract.mjs';
import { prepareCreateRequest, createRequestHash } from './create-contract.mjs';
import { createMusicLoop } from './music-loop.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (status, error) => ({ ok: false, status, error });
const now = () => new Date().toISOString();
const copy = value => JSON.parse(JSON.stringify(value));
const shaText = value => createHash('sha256').update(String(value)).digest('hex');
const MONITOR = new Set(['submitting', 'queued', 'submitted', 'generating', 'collecting', 'technical_review', 'outcome_unknown']);

export function createMusicService({ stateDir, onEvent = () => {}, createApi, collector, research, performance, pollIntervalMs = 2000 }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, 'music-agent.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS refs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS music_settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  let closed = false;
  let ticking = null;
  let loopInstance;
  const inFlight = new Set();
  const researchInFlight = new Set();
  const compilers = new Map();
  const defaultCompiler = createPromptCompiler();
  const defaultVersion = defaultCompiler.dictionaryQuery({}).dictionary_version;
  compilers.set(defaultVersion, defaultCompiler);
  const decode = row => row ? JSON.parse(row.data) : null;
  function event(type, data) {
    const at = now();
    const result = db.prepare('INSERT INTO events(at,type,data) VALUES(?,?,?)').run(at, type, JSON.stringify(data));
    return { seq: Number(result.lastInsertRowid), at, type, ...data };
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  function emit(e) { try { onEvent(e); } catch { /* observer cannot undo a committed record */ } }
  function getSession(id) { return decode(db.prepare('SELECT data FROM sessions WHERE id=?').get(id)); }
  function getJob(id) { return decode(db.prepare('SELECT data FROM jobs WHERE id=?').get(id)); }
  function getAsset(id) { return decode(db.prepare('SELECT data FROM assets WHERE id=?').get(id)); }
  function setting(key, value) { if (value === undefined) return decode(db.prepare('SELECT data FROM music_settings WHERE key=?').get(key)); db.prepare('INSERT INTO music_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value)); }
  function compilerRecord(compiler) { return { dictionary: compiler.dictionaryQuery({}).dictionary, capabilities: compiler.getCapabilities().capability_snapshot }; }
  function persistCompiler(compiler) { const record = compilerRecord(compiler); db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?)').run('compiler:' + record.dictionary.version, JSON.stringify(record)); }
  persistCompiler(defaultCompiler);
  for (const row of db.prepare("SELECT data FROM snapshots WHERE id LIKE 'compiler:%'").all()) {
    const record = decode(row); const compiler = createPromptCompiler(record);
    if (compiler.ok) compilers.set(record.dictionary.version, compiler);
  }
  let activeDictionary = setting('dictionary_active') || defaultVersion;
  function compilerFor(version = activeDictionary) { return compilers.get(version); }
  function saveJob(job, type) {
    if (closed) return;
    job.updated_at = now();
    const e = transaction(() => { db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id); return event(type || 'generation_updated', { job_id: job.id, status: job.status }); });
    emit(e);
  }
  function saveSession(session) { db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id, JSON.stringify(session)); }
  function list(table, limit = 50) { return db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC LIMIT ?`).all(Math.min(100, Math.max(1, Number(limit) || 50))).map(decode); }
  function snapshot(kind, value) {
    const id = kind + ':' + hash(value);
    db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?)').run(id, JSON.stringify({ kind, value }));
  }
  function safe(work) {
    try { const result = work(); return result && typeof result.then === 'function' ? result.catch(() => failure('failed', '操作未完成；原有紀錄與未知預留保留。')) : result; }
    catch { return failure('failed', '本機紀錄未完成；原有任務保留，請查看本機服務狀態。'); }
  }
  function sessionCreate(input) {
    const max = input.max_generations ?? 1;
    const depth = input.max_depth ?? 1;
    if (!Number.isInteger(max) || max < 1 || max > 100 || !Number.isInteger(depth) || depth < 1 || depth > 10) return failure('invalid', '任務上限需為 1–100，代數需為 1–10。');
    const session = { id: 's_' + randomUUID(), goal: String(input.goal || '本機提示詞預覽').slice(0, 2000), status: 'active', max_generations: max, max_depth: depth,
      budget_limits: { ace_credits: 0, deepseek_usd: 0 }, budget_limits_scope: 'local_preparation_only', provider_budget_source: 'independent_server_authority',
      permission_scope: ['local_prepare'], created_at: now(), actual_cost: { ace_credits: 0, deepseek_usd: 0 }, actual_cost_scope: 'local_preparation_only' };
    // No request field can grant provider access or increase this build's permissions.
    const e = transaction(() => { saveSession(session); return event('session_created', { session_id: session.id }); });
    emit(e); return { ok: true, status: 'active', session };
  }
  function compile(input) {
    const compiler = compilerFor(input.dictionary_version);
    if (!compiler) return failure('unsupported', '找不到所需的固定詞典版本，禁止靜默替換。');
    const result = compiler.compilePrompt(input);
    if (!result.plan) return result;
    const p = result.plan;
    const existing = decode(db.prepare('SELECT data FROM plans WHERE id=?').get(p.id));
    if (existing && hash(existing) !== hash(p)) return failure('conflict', '同一計畫識別碼內容不同，已保留原紀錄。');
    if (existing) return { ...result, persisted: true, reused: true };
    const e = transaction(() => {
      db.prepare('INSERT OR IGNORE INTO plans VALUES(?,?,?)').run(p.id, p.hash || hash(p), JSON.stringify(p));
      snapshot('dictionary', compiler.dictionaryQuery({})); snapshot('capabilities', compiler.getCapabilities());
      return event('prompt_prepared', { plan_id: p.id, status: result.status });
    });
    emit(e); return { ...result, persisted: true };
  }
  function generationPrepare(input) {
    if (typeof input.plan_id !== 'string' || typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim() || input.idempotency_key.length > 128) return failure('invalid', '需要已保存的 plan_id 與 1–128 字 idempotency_key。');
    const plan = decode(db.prepare('SELECT data FROM plans WHERE id=?').get(input.plan_id));
    if (!plan) return failure('not_found', '找不到提示詞計畫，請先預覽。');
    const session = getSession(input.session_id || '');
    if (!session) return failure('not_found', '找不到創作批次，請先建立本機批次。');
    const parentIds = [...new Set(input.parent_artifact_ids ?? plan.parent_ids ?? [])];
    if ((plan.parent_ids || []).some(id => !parentIds.includes(id))) return failure('invalid_parent', '不能移除已審計畫的父代。');
    const parents = parentIds.map(getAsset);
    if (parents.some(asset => !asset || asset.technical_review?.full_decode !== true)) return failure('invalid_parent', '父代必須是本流程已核驗的真實產物紀錄。');
    const depth = parents.length ? Math.max(...parents.map(asset => asset.generation_depth ?? 0)) + 1 : 0;
    if (depth > session.max_depth) return failure('depth_blocked', '已達本批次自供迭代深度上限。');
    const request = { plan_id: input.plan_id, session_id: session.id, actual_model: input.actual_model ? normalizeModel(input.actual_model) : null, reviewed: input.reviewed, api_parameters: input.api_parameters || {}, parent_artifact_ids: parentIds };
    const requestHash = hash(request);
    const keyHash = shaText(input.idempotency_key);
    const previous = db.prepare('SELECT request_hash,data FROM jobs WHERE idem IN (?,?)').get('prepare:' + keyHash, input.idempotency_key);
    if (previous) return previous.request_hash === requestHash ? { ok: true, status: JSON.parse(previous.data).status, job: decode(previous), reused: true } : failure('idempotency_conflict', '此幂等鍵已用於不同計畫，請保留原任務並使用新鍵。');
    if (session.status !== 'active') return failure('cancelled', '此批次已停止；不再建立任務。');
    const count = db.prepare('SELECT data FROM jobs').all().map(decode).filter(j => j.session_id === session.id).length;
    if (count >= session.max_generations) return failure('budget_blocked', '已達本批次任務數上限。');
    if (input.actual_model && normalizeModel(input.actual_model) !== plan.requested_model) return failure('needs_recompile', '模型已變更，請重新編譯並審閱提示詞。');
    const compiler = compilerFor(plan.dictionary_version);
    if (!compiler) return failure('unsupported', '找不到此任務需要的固定詞典及編譯器快照。');
    const check = compiler.prepareGeneration({ plan, session, reviewed: input.reviewed, actual_model: input.actual_model });
    if (check.ok === false) return check;
    if (plan.translation_required) return failure('translation_required', '仍有待核對的翻譯，請先審閱英文描述。');
    const nativeInput = { mode: plan.mode, model: plan.remote_model_id || plan.requested_model, ...copy(plan.prompt_fields), ...copy(input.api_parameters || {}) };
    // Current compiler references are descriptions, not remote upload handles.
    // Preserve them in the versioned plan, but never invent a provider reference.
    const native = prepareCreateRequest(nativeInput);
    if (!native.ok) return native;
    const job = { id: 'g_' + randomUUID(), plan_id: plan.id, session_id: session.id, status: 'awaiting_authorization', adapter: null,
      requested_model: plan.requested_model, mode: plan.mode, actual_model: null, remote_task_id: null, dictionary_version: plan.dictionary_version || plan.versions?.dictionary_version,
      versions: plan.versions, budget_reservation: { ace_credits: 0, deepseek_usd: 0 }, estimated_cost: null,
      native_input: nativeInput, native_request: native.request, native_request_hash: native.request_hash, native_requested_model: native.requested_model,
      api_idempotency_key: 'music:' + keyHash, api_job_id: null, submit_attempted: false,
      parent_artifact_ids: parentIds, generation_depth: depth,
      rights_snapshot: { status: 'unknown', commercial_use: 'unknown', plan: null, model: native.requested_model },
      submitted_at: null, created_at: now(), reviewed_at: now(), real_success: false, artifacts: [], stop_semantics: '停止新增本機提交；已受理的遠端任務可能繼續並回收。' };
    const e = transaction(() => { db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(job.id, 'prepare:' + keyHash, requestHash, JSON.stringify(job)); return event('generation_prepared', { job_id: job.id, session_id: session.id, status: job.status }); });
    emit(e); return { ok: true, status: job.status, job, authorization_requirements: ['供應商及可用 adapter', '模型與實際價格', '單輪及全批次預算', '上傳範圍', '是否自動繼續'], provider_calls: 0 };
  }
  function refreshPerformance() {
    if (!performance) return;
    performance.setAssets(db.prepare('SELECT data FROM assets').all().map(decode).filter(asset => asset.technical_review?.full_decode === true).map(asset => ({
      id: asset.id, path: asset.path, sha256: asset.sha256, title: asset.title || asset.id, duration_seconds: asset.duration ?? null,
      technical_verified: true, human_accepted: asset.human_listen?.status === 'accepted',
      rejected: asset.human_listen?.status === 'rejected',
    })));
  }
  function savePerformance() { if (performance) setting('performance', performance.getState()); }
  function recomputeJobFeedback(jobId) {
    const job = getJob(jobId);
    if (!job || !job.artifacts.length) return;
    const assets = job.artifacts.map(getAsset).filter(Boolean);
    const collected = new Set(assets.map(asset => asset.remote_task_id));
    if ((job.remote_task_ids || []).some(id => !collected.has(id))) {
      job.real_success = false;
      if (['accepted', 'rejected', 'awaiting_listen'].includes(job.status)) job.status = 'collection_failed';
      saveJob(job, 'partial_human_listen_updated'); return;
    }
    const decisions = assets.map(asset => asset.human_listen?.status);
    if (decisions.every(status => status === 'accepted')) job.status = 'accepted';
    else if (decisions.every(status => ['accepted', 'rejected'].includes(status))) job.status = 'rejected';
    else job.status = 'awaiting_listen';
    job.real_success = job.status === 'accepted' && assets.every(asset => asset.real_or_mock === 'real' && asset.technical_review?.full_decode === true);
    saveJob(job, 'human_listen_updated');
  }
  async function submitWork(id) {
    let job = getJob(id);
    try {
      const response = await createApi.call('submit', { input: copy(job.native_input), reviewed_request_hash: job.native_request_hash, idempotency_key: job.api_idempotency_key });
      if (closed) return;
      job = getJob(id);
      job.api_job_id = response.jobId || job.api_job_id;
      if (response.ok) job.adapter = 'ace_browser';
      if (response.reservation) { job.api_reservation = response.reservation; job.budget_reservation = { ace_credits: response.reservation.estimated_credits, deepseek_usd: 0 }; }
      if (response.authorization_preview) job.rights_snapshot = { ...job.rights_snapshot,
        observed_subscription_plan: typeof response.authorization_preview.plan === 'string' ? response.authorization_preview.plan : null,
        observed_at: typeof response.authorization_preview.observed_at === 'string' ? response.authorization_preview.observed_at : null,
        observation_scope: 'pre_submit_status', status: 'unknown', commercial_use: 'unknown' };
      if (!response.ok) {
        const preflight = ['awaiting_authorization', 'auth_required', 'budget_blocked', 'scope_denied', 'generation_limit', 'awaiting_review', 'invalid', 'unsupported', 'needs_recompile'].includes(response.status) && response.submission_unknown !== true;
        job.status = preflight ? response.status === 'auth_required' ? 'awaiting_authorization' : response.status : 'outcome_unknown';
        if (preflight) job.submit_attempted = false;
        if (preflight && getSession(job.session_id)?.status === 'stopped') job.status = 'cancelled';
      } else { const state = response.reservation?.state || response.status || 'queued'; job.status = ['submitted', 'settled'].includes(state) ? 'submitted' : state; }
      if (job.status === 'reserved') job.status = 'queued';
      if (job.status === 'outcome_unknown') job.submission_unknown = true;
      if (response.ok) job.api_enqueued_at ||= now();
      if (['submitted', 'settled'].includes(response.reservation?.state)) job.submitted_at ||= response.reservation.updated_at || now();
      saveJob(job, 'generation_submit_result');
      if (getSession(job.session_id)?.status === 'stopped' && typeof createApi.cancelPending === 'function') {
        const cancelled = createApi.cancelPending(job.api_idempotency_key);
        if (cancelled?.ok && cancelled.status === 'not_submitted') { job.status = 'cancelled'; saveJob(job); }
      }
    } catch {
      if (!closed) { job = getJob(id); job.status = 'outcome_unknown'; job.submission_unknown = true; saveJob(job, 'generation_outcome_unknown'); }
    } finally { inFlight.delete(id); }
  }
  function generationSubmit(input) {
    if (closed) return failure('closed', '音樂服務已關閉。');
    if (!createApi) return failure('unsupported', '未配置可用生成執行器；保留已審預覽。');
    const job = getJob(input.job_id);
    if (!job) return failure('not_found', '找不到此任務。');
    if (job.submit_attempted || inFlight.has(job.id) || !['awaiting_authorization', 'auth_required', 'budget_blocked'].includes(job.status)) return { ok: true, status: job.status, job, reused: true };
    if (getSession(job.session_id)?.status !== 'active') return failure('cancelled', '此批次已停止新增提交。');
    const prepared = prepareCreateRequest(job.native_input);
    if (!prepared.ok || prepared.request_hash !== job.native_request_hash || createRequestHash(job.native_request) !== job.native_request_hash) return failure('awaiting_review', '已存原生參數與審閱摘要不一致，禁止提交。');
    const summary = createApi.getAuthority?.()?.summary?.();
    if (summary && (!summary.ok || summary.status !== 'ready')) return { ok: false, status: 'awaiting_authorization', job, error: '尚無有效的獨立伺服器生成授權。' };
    job.status = 'submitting'; job.submit_attempted = true; job.submit_started_at = now();
    saveJob(job, 'generation_submitting');
    inFlight.add(job.id);
    Promise.resolve().then(() => submitWork(job.id)).catch(() => {});
    return { ok: true, status: 'submitting', job, message: '已排入一次；背景核對收據及結果，不重送未知任務。' };
  }
  async function monitorJob(id) {
    if (!createApi || inFlight.has(id) || closed) return;
    inFlight.add(id);
    let job = getJob(id);
    try {
      if (!job || !MONITOR.has(job.status) || !job.api_idempotency_key) return;
      const receipt = await createApi.call('receipt', { idempotency_key: job.api_idempotency_key });
      if (closed) return;
      if (!receipt?.ok || !receipt.reservation) { if (job.status === 'submitting') job.status = 'outcome_unknown'; saveJob(job); return; }
      job.api_reservation = receipt.reservation;
      job.budget_reservation = { ace_credits: receipt.reservation.estimated_credits ?? null, deepseek_usd: 0 };
      job.actual_cost = { ace_credits: receipt.reservation.state === 'settled' && Number.isFinite(receipt.reservation.actual_credits) ? receipt.reservation.actual_credits : null };
      const state = receipt.reservation.state;
      if (state === 'not_submitted') { job.status = 'cancelled'; job.submission_unknown = false; saveJob(job); return; }
      const ids = [...new Set(receipt.reservation.remote_task_ids || [])];
      job.remote_task_ids = ids; job.remote_task_id = ids[0] || null;
      if (!ids.length) { job.status = state === 'reserved' ? 'queued' : 'outcome_unknown'; job.submission_unknown = state !== 'reserved'; saveJob(job); return; }
      if (['submitted', 'settled'].includes(state)) { job.submission_unknown = false; job.submitted_at ||= receipt.reservation.updated_at || now(); }
      const transport = createApi.getTransport?.();
      if (!transport?.status) { job.status = 'submitted'; saveJob(job); return; }
      const statuses = [];
      for (let index = 0; index < ids.length; index += 10) statuses.push(await transport.status({ task_ids: ids.slice(index, index + 10), requested_model: job.native_requested_model }));
      if (closed) return;
      job.actual_models = [...new Set(statuses.flatMap(status => status.actual_models || []))];
      job.actual_model = job.actual_models.length === 1 ? job.actual_models[0] : null;
      if (statuses.some(status => status.ok === false)) { job.last_monitor_status = 'temporarily_unavailable'; saveJob(job); return; }
      if (statuses.some(status => status.model_mismatch_task_ids?.length || status.conflicting_task_ids?.length) ||
          statuses.every(status => status.complete) && statuses.some(status => status.model_verified !== true || status.model_unknown_task_ids?.length)) {
        job.status = 'needs_review'; job.real_success = false; job.review_reason = 'actual_model_or_task_state_unverified'; saveJob(job); return;
      }
      if (statuses.some(status => status.model_verified !== true || status.model_unknown_task_ids?.length)) { job.status = 'generating'; job.review_reason = 'actual_model_pending'; saveJob(job); return; }
      if (job.review_reason === 'actual_model_pending') delete job.review_reason;
      if (statuses.some(status => status.failed === true)) { job.status = 'failed'; job.real_success = false; saveJob(job); return; }
      if (statuses.some(status => !status.complete || !status.remote_audio_available)) { job.status = 'generating'; saveJob(job); return; }
      if (!collector?.collect) { job.status = 'technical_review'; saveJob(job); return; }
      job.status = 'collecting'; saveJob(job);
      const results = [];
      for (let index = 0; index < ids.length; index += 10) results.push(await collector.collect({ task_ids: ids.slice(index, index + 10), requested_model: job.native_requested_model, source_job: job.id, rights_snapshot: job.rights_snapshot, parent_ids: job.parent_artifact_ids }));
      if (closed) return;
      const accepted = [];
      let invalidArtifact = false;
      transaction(() => {
        for (const artifact of results.flatMap(result => result.artifacts || [])) {
          if (!artifact || artifact.technical_review?.full_decode !== true || !/^[a-f0-9]{64}$/i.test(artifact.sha256 || '') ||
              !artifact.path || !(path.isAbsolute(artifact.path) || path.win32.isAbsolute(artifact.path)) || !(artifact.bytes > 0) || !(artifact.duration > 0) ||
              !Number.isFinite(artifact.duration) || artifact.source_job !== job.id || !ids.includes(artifact.remote_task_id) ||
              normalizeModel(artifact.actual_model) !== normalizeModel(job.native_requested_model) || !['real', 'mock'].includes(artifact.real_or_mock)) { invalidArtifact = true; continue; }
          const existing = getAsset(artifact.id);
          if (existing && (existing.sha256 !== artifact.sha256 || existing.remote_task_id !== artifact.remote_task_id)) { invalidArtifact = true; continue; }
          if (!existing) {
            const stored = { ...copy(artifact), versions: copy(job.versions), generation_depth: job.generation_depth, parent_ids: copy(job.parent_artifact_ids),
              rights_snapshot: copy(job.rights_snapshot), human_listen: { status: 'awaiting_listen', accepted: false }, real_success: false };
            stored.technical_review.human_listen = copy(stored.human_listen);
            db.prepare('INSERT INTO assets VALUES(?,?)').run(stored.id, JSON.stringify(stored));
          }
          accepted.push(artifact.id);
        }
      });
      job.artifacts = [...new Set([...job.artifacts, ...accepted])];
      const collectedIds = new Set(job.artifacts.map(getAsset).filter(Boolean).map(asset => asset.remote_task_id));
      job.status = invalidArtifact ? 'needs_review' : ids.every(id => collectedIds.has(id)) ? 'awaiting_listen' : 'collection_failed';
      job.real_success = false; job.collection_error_count = results.reduce((total, result) => total + (result.errors?.length || 0), 0);
      job.collection_errors = results.flatMap(result => result.errors || []).map(error => ({ code: error.code || 'COLLECTION_FAILED', message: error.message || '音檔尚未通過回收核驗。' }));
      saveJob(job, 'generation_collected');
      if (job.status === 'awaiting_listen') recomputeJobFeedback(job.id);
      refreshPerformance(); savePerformance();
    } catch { if (!closed && job) { job.last_monitor_status = 'temporarily_unavailable'; saveJob(job); } }
    finally { inFlight.delete(id); }
  }
  function tick() {
    if (closed) return Promise.resolve(failure('closed', '音樂服務已關閉。'));
    if (ticking) return ticking;
    const jobs = db.prepare('SELECT data FROM jobs').all().map(decode).filter(job => MONITOR.has(job.status));
    const pending = [...jobs];
    const worker = async () => { while (pending.length && !closed) await monitorJob(pending.shift().id); };
    ticking = Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker)).then(async () => {
      if (loopInstance && !closed) for (const loop of loopInstance.list().loops || []) {
        if (loop.pending || !['paused', 'stop', 'completed', 'blocked'].includes(loop.status)) await loopInstance.tick({ loop_id: loop.id });
      }
      return { ok: true, monitored: jobs.length };
    }).finally(() => { ticking = null; });
    return ticking;
  }
  function feedbackRecord(input) {
    const artifact = getAsset(input.artifact_id);
    if (!artifact || artifact.technical_review?.full_decode !== true) return failure('not_found', '需要已核驗的實際產物才能記錄人類試聽。提示詞預覽不是音樂。');
    const payload = { artifact_id: artifact.id, author: 'user', text: input.text || '', dimensions: input.dimensions || {},
      ...(input.accepted === undefined ? {} : { accepted: input.accepted }), ...(input.explicit_rating === undefined ? {} : { explicit_rating: input.explicit_rating }), ...(input.retracts ? { retracts: input.retracts } : {}) };
    const fingerprint = hash(payload);
    const idem = input.idempotency_key ? shaText(input.idempotency_key) : null;
    const rows = db.prepare('SELECT data FROM feedback WHERE artifact_id=? ORDER BY rowid').all(artifact.id).map(decode);
    if (idem) { const previous = rows.find(row => row.idempotency_hash === idem); if (previous) return previous.request_hash === fingerprint ? { ok: true, feedback: previous, reused: true, artifact } : failure('idempotency_conflict', '此評語幂等鍵已用於不同內容。'); }
    if (input.retracts && !rows.some(row => row.id === input.retracts)) return failure('not_found', '找不到同一產物可撤回的評語。');
    const feedback = { ...payload, id: 'feedback_' + randomUUID(), created_at: now(), idempotency_hash: idem, request_hash: fingerprint };
    rows.push(feedback);
    const inactive = new Set();
    for (const row of [...rows].reverse()) if (!inactive.has(row.id) && row.retracts) inactive.add(row.retracts);
    const active = rows.filter(row => !inactive.has(row.id));
    const decision = active.filter(row => typeof row.accepted === 'boolean').at(-1);
    artifact.human_listen = { status: decision ? decision.accepted ? 'accepted' : 'rejected' : 'awaiting_listen', accepted: decision?.accepted === true, latest_feedback_id: feedback.id, decision_feedback_id: decision?.id || null };
    artifact.technical_review.human_listen = copy(artifact.human_listen);
    const e = transaction(() => { db.prepare('INSERT INTO feedback VALUES(?,?,?)').run(feedback.id, artifact.id, JSON.stringify(feedback)); db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(artifact), artifact.id); return event('human_feedback_recorded', { artifact_id: artifact.id, feedback_id: feedback.id, status: artifact.human_listen.status }); });
    emit(e); recomputeJobFeedback(artifact.source_job); refreshPerformance(); savePerformance();
    return { ok: true, status: artifact.human_listen.status, feedback, artifact, long_term_taste_updated: false };
  }
  function nextIteration(input) {
    const asset = getAsset(input.artifact_id);
    if (!asset || asset.human_listen?.status !== 'accepted') return failure('awaiting_listen', '下一輪需要人工明確接受的錨點產物。');
    const job = getJob(asset.source_job); const plan = job && decode(db.prepare('SELECT data FROM plans WHERE id=?').get(job.plan_id));
    if (!plan) return failure('not_found', '找不到此產物的來源計畫。');
    const feedback = db.prepare('SELECT data FROM feedback WHERE artifact_id=? ORDER BY rowid').all(asset.id).map(decode);
    const inactive = new Set();
    for (const row of [...feedback].reverse()) if (!inactive.has(row.id) && row.retracts) inactive.add(row.retracts);
    const dimensions = Object.assign({}, ...feedback.filter(row => !inactive.has(row.id)).map(row => row.dimensions || {}));
    const proposals = plan.selected_terms.map(term => ({ term_id: term.term_id, from: term.weight, to: Math.min(1, Math.max(0, term.weight + (dimensions[term.dimension] || 0) * 0.05)) })).filter(item => item.from !== item.to);
    const weights = Object.fromEntries(plan.selected_terms.map(term => [term.term_id, proposals.find(item => item.term_id === term.term_id)?.to ?? term.weight]));
    const result = compile({ natural_language: plan.original_intent, model: plan.requested_model, mode: plan.mode,
      seed: input.seed ?? `${plan.seeds.terms}:${asset.id}`, locked_term_ids: plan.locked_term_ids, hard_constraints: plan.hard_constraints,
      references: plan.references, lyrics: plan.prompt_fields.lyrics || '', parent_ids: [asset.id], previous_term_ids: plan.selected_terms.map(term => term.term_id), weights, max_changed_dimensions: input.max_changed_dimensions ?? 1, dictionary_version: plan.dictionary_version });
    return { ...result, parent_artifact_ids: [asset.id], inherited_versions: plan.versions, weight_proposals: proposals, auto_submit: false, long_term_taste_updated: false };
  }
  function activateDictionary(input) {
    if (!research?.getSnapshot || !research?.getEvidence) return failure('unsupported', '尚未配置可核驗的研究快照來源。');
    const result = research.getSnapshot(input.snapshot_id);
    if (!result.ok) return result;
    const base = compilerFor();
    if (!base) return failure('unsupported', '目前固定詞典版本不可用。');
    if (base.dictionaryQuery({}).dictionary.research_snapshot_id === input.snapshot_id) return { ok: true, status: 'activated', reused: true, dictionary_version: activeDictionary, long_term_taste_updated: false };
    const cards = [];
    for (const id of result.snapshot.evidence_ids || []) { const evidence = research.getEvidence(id); if (!evidence.ok) return failure('not_found', '找不到研究詞典的來源證據。'); cards.push(evidence.evidence); }
    const merged = mergeReviewedDictionary(base.dictionaryQuery({}).dictionary, { ...result.snapshot, evidence: cards });
    if (!merged.ok) return merged;
    const compiler = createPromptCompiler({ dictionary: merged.dictionary, capabilities: base.getCapabilities().capability_snapshot });
    if (!compiler.ok) return compiler;
    const e = transaction(() => { persistCompiler(compiler); setting('dictionary_active', merged.dictionary.version); return event('dictionary_activated', { version: merged.dictionary.version, research_snapshot_id: input.snapshot_id }); });
    compilers.set(merged.dictionary.version, compiler); activeDictionary = merged.dictionary.version; emit(e);
    return { ok: true, status: 'activated', dictionary_version: activeDictionary, dictionary_snapshot_id: merged.dictionary.id, long_term_taste_updated: false };
  }
  function loops() {
    return loopInstance ||= createMusicLoop({ stateDir, workflow: {
      getAsset, getSession, getJob: id => { const job = getJob(id); return job ? { ok: true, job } : failure('not_found', '找不到循環任務。'); },
      authoritySummary: () => createApi?.getAuthority?.()?.summary?.() || { ok: false, status: 'awaiting_authorization' },
      submitJob: id => generationSubmit({ job_id: id }),
      async prepareNext(input) {
        if (closed) return failure('closed', '音樂服務已關閉。');
        const next = nextIteration({ artifact_id: input.artifact_id, seed: input.seed, max_changed_dimensions: input.exploration_proposal?.max_changed_dimensions ?? 1 });
        if (!next.ok) return next;
        const source = getAsset(input.artifact_id); const parent = source && getJob(source.source_job);
        const parameters = Object.fromEntries(['step', 'hd', 'title', 'audio_influence', 'style_influence'].filter(key => parent?.native_input?.[key] !== undefined).map(key => [key, copy(parent.native_input[key])]));
        const prepared = generationPrepare({ session_id: input.session_id, plan_id: next.plan.id, reviewed: true, idempotency_key: input.idempotency_key, parent_artifact_ids: [input.artifact_id], api_parameters: parameters });
        if (!prepared.ok) return prepared;
        let job = prepared.job;
        const summary = createApi?.getAuthority?.()?.summary?.();
        if (summary?.ok && summary.grant?.allow_auto_continue === true && createApi.getTransport?.()?.preview) {
          const preview = await createApi.getTransport().preview(prepareCreateRequest(job.native_input));
          if (closed) return failure('closed', '音樂服務已關閉。');
          if (!preview?.ok || typeof preview.estimated_credits !== 'number' || !Number.isFinite(preview.estimated_credits)) return failure('budget_blocked', '循環下一代費用未核實，未提交。');
          job = getJob(job.id); job.estimated_credits = preview.estimated_credits;
          job.estimated_cost = { ace_credits: preview.estimated_credits, source: 'live_account_preview', observed_at: now() };
          saveJob(job, 'loop_generation_prepared');
        }
        return { ok: true, job };
      },
    } });
  }
  function stop(input) {
    const session = getSession(input.session_id || '');
    if (!session) return failure('not_found', '找不到此批次。');
    const e = transaction(() => {
      session.status = 'stopped'; session.stopped_at ||= now(); saveSession(session);
      for (const row of db.prepare('SELECT id,data FROM jobs').all()) {
        const j = decode(row);
        if (j.session_id !== session.id) continue;
        j.stop_requested = true;
        if (!j.submit_attempted && ['awaiting_authorization', 'auth_required', 'budget_blocked'].includes(j.status)) { j.status = 'cancelled'; j.cancelled_at = now(); }
        else if (j.status === 'queued' && createApi?.cancelPending) {
          const cancelled = createApi.cancelPending(j.api_idempotency_key);
          if (cancelled?.ok && cancelled.status === 'not_submitted') { j.status = 'cancelled'; j.cancelled_at = now(); }
        }
        db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(j), j.id);
      }
      return event('session_stopped', { session_id: session.id });
    });
    const jobs = db.prepare('SELECT data FROM jobs').all().map(decode).filter(job => job.session_id === session.id);
    emit(e); return { ok: true, status: 'stopped', session, remote_tasks: [...new Set(jobs.flatMap(job => job.remote_task_ids || []))],
      remote_outcomes_unknown: jobs.filter(job => MONITOR.has(job.status)).map(job => job.id), message: '已停止新增提交；已受理或結果未知的遠端任務可能仍繼續，背景只核對與回收。' };
  }
  function researchAction(action, input) {
    if (!research) return failure('unsupported', '尚未配置研究執行器。');
    switch (action) {
      case 'research_summary': return research.summary();
      case 'research_library': return typeof research.library === 'function' ? research.library() : failure('unsupported', '研究執行器尚無資料庫快照介面。');
      case 'research_prepare': {
        const compiler = compilerFor();
        if (!compiler) return failure('unsupported', '目前詞典快照不可用。');
        const capabilities = compiler.getCapabilities();
        const dictionary = compiler.dictionaryQuery({}).dictionary;
        const plan = list('plans', 100).find(plan => plan.dictionary_version === activeDictionary);
        return research.prepare({ ...input, snapshot_ids: { dictionary_version: activeDictionary, taste_snapshot_id: plan?.versions?.taste_snapshot_id || dictionary.source_snapshot_ids?.taste_snapshot_id || 'project-plan-v1-initial', compiler_version: COMPILER_VERSION, capability_snapshot_id: capabilities.capability_snapshot.id, ...(input.snapshot_ids || {}) } });
      }
      case 'research_job': return research.getJob(input.job_id);
      case 'research_evidence': return research.getEvidence(input.evidence_id);
      case 'research_import_evidence': return research.importEvidence(input);
      case 'research_propose_terms': return research.proposeTerms(input);
      case 'research_review_candidate': return research.reviewCandidate(input);
      case 'research_stop': return research.stop();
      case 'research_analyze': return research.analyze(input);
      case 'research_run': {
        const result = research.getJob(input.job_id);
        if (!result.ok) return result;
        if (researchInFlight.has(input.job_id) || result.job.status !== 'prepared') return { ...result, reused: true };
        researchInFlight.add(input.job_id);
        Promise.resolve().then(() => research.run(input.job_id)).then(result => {
          if (!closed) emit(event('research_result', { job_id: input.job_id, status: result?.status || 'unknown' }));
        }).catch(() => { if (!closed) emit(event('research_result', { job_id: input.job_id, status: 'outcome_unknown' })); }).finally(() => researchInFlight.delete(input.job_id));
        return { ok: true, status: 'queued', job_id: input.job_id, job: result.job };
      }
    }
  }
  function performanceAction(action, input) {
    if (!performance) return failure('unsupported', '尚未配置演出準備介面。');
    refreshPerformance();
    let result;
    switch (action) {
      case 'performance_state': return { ok: true, state: performance.getState(), capabilities: performance.getCapabilities(), manifest: setting('performance_manifest') || null };
      case 'performance_probe': return performance.probeExternal();
      case 'performance_plan': return performance.planBuffer(input);
      case 'performance_queue': result = performance.queue(input); break;
      case 'performance_dequeue': result = performance.dequeue(input); break;
      case 'performance_pause': result = performance.pause(input); break;
      case 'performance_takeover': result = performance.takeover(input); break;
      case 'performance_resume': result = performance.resume(); break;
      case 'performance_stop': result = performance.stop(input); break;
      case 'performance_manifest': result = performance.prepareManifest(input); if (result.ok) { setting('performance_manifest', result.manifest); snapshot('performance_manifest', result.manifest); } break;
    }
    savePerformance();
    if (result?.ok) emit(event(action, { status: result.status || 'recorded' }));
    return result;
  }
  for (const row of db.prepare('SELECT data FROM jobs').all()) {
    const job = decode(row);
    if (job.status === 'submitting') { job.status = 'outcome_unknown'; job.submission_unknown = true; saveJob(job, 'generation_recovered_unknown'); }
  }
  if (fs.existsSync(path.join(stateDir, 'music-loop.sqlite'))) loops();
  if (performance) {
    refreshPerformance();
    const saved = setting('performance');
    if (saved) {
      for (const [role, rows] of [['main', saved.queue], ['backup', saved.backup]]) for (const row of rows || []) performance.queue({ artifact_id: row.artifact_id, role });
      if (saved.control_mode === 'takeover') performance.takeover();
      else if (saved.paused) performance.pause();
      if (saved.stopped) performance.stop();
    }
  }
  const interval = createApi && Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? setInterval(() => { tick().catch(() => {}); }, Math.min(60000, Math.max(100, pollIntervalMs))) : null;
  interval?.unref();
  return {
    tick,
    getAsset(id) { return safe(() => { const asset = getAsset(id); return asset ? { ok: true, asset } : failure('not_found', '找不到此產物。'); }); },
    close() { if (!closed) { closed = true; clearInterval(interval); loopInstance?.close(); db.close(); } },
    call(action, input = {}) {
      return safe(() => {
        const contract = MUSIC_CONTRACT.find(c => c.action === action);
        if (!contract) return failure('unsupported', '未知音樂操作。');
        const invalid = validateMusicInput(input, contract.inputSchema);
        if (invalid) return failure('invalid', invalid);
        switch (action) {
          case 'capabilities': {
            const documented = compilerFor()?.getCapabilities();
            if (!documented) return failure('unsupported', '目前詞典快照不可用。');
            return { ...documented, runtime: { workflow_connected: !!createApi, generation_authority: createApi?.getAuthority?.()?.summary?.() || null,
              artifact_collection: !!collector, research: research ? research.summary() : null, performance: performance ? performance.getCapabilities() : null,
              capability_snapshot_scope: 'immutable_documented_model_snapshot', execution_scope: 'separate_finite_server_authority', automatic_playback: false } };
          }
          case 'dictionary': return compilerFor(input.version)?.dictionaryQuery(input) || failure('unsupported', '找不到指定詞典版本。');
          case 'dictionary_activate': return activateDictionary(input);
          case 'intent_prepare': return compilerFor(input.dictionary_version)?.prepareIntent(input) || failure('unsupported', '找不到指定詞典版本。');
          case 'reference_register': {
            if (/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|cookie|token)\s*[:=]\s*[^\s,;]{8,})/i.test(JSON.stringify(input)) || /https?:\/\/[^\s/]*@/i.test(input.user_input)) return failure('policy_blocked', '請移除引用中的憑據。');
            const spotify = /spotify/i.test(JSON.stringify(input));
            const ref = { ...input, id: 'r_' + hash(input).slice(0, 20), source: spotify ? 'spotify' : input.source || 'user_supplied',
              kind: spotify ? 'spotify_reference' : input.kind || 'link', rights_status: input.rights_status || 'unknown',
              ai_ingestion_allowed: !spotify && input.ai_ingestion_allowed === true && ['owned', 'licensed', 'public_domain', 'generated_owned'].includes(input.rights_status), audio_available: false };
            db.prepare('INSERT OR IGNORE INTO refs VALUES(?,?)').run(ref.id, JSON.stringify(ref));
            return { ok: true, status: ref.ai_ingestion_allowed ? 'registered' : 'policy_blocked', reference: ref, fetched: false };
          }
          case 'prompt_compile': return compile(input);
          case 'session_create': return sessionCreate(input);
          case 'session_stop': return stop(input);
          case 'generation_prepare': return generationPrepare(input);
          case 'generation_submit': return generationSubmit(input);
          case 'poll_generation': { const job = input.job_id ? getJob(input.job_id) : null; if (input.job_id && !job) return failure('not_found', '找不到此任務。'); if (job?.status === 'collection_failed') { job.status = 'technical_review'; saveJob(job, 'collection_retry_requested'); } tick().catch(() => {}); return { ok: true, status: 'monitor_scheduled', ...(job ? { job } : {}) }; }
          case 'job_status': { const job = decode(db.prepare('SELECT data FROM jobs WHERE id=?').get(input.job_id || '')); return job ? { ok: true, status: job.status, job } : failure('not_found', '找不到此任務。'); }
          case 'state': return { ok: true, sessions: list('sessions'), plans: list('plans'), jobs: list('jobs'), references: list('refs'), assets: list('assets'), feedback: list('feedback'),
            costs: { ace_credits: createApi ? null : 0, deepseek_usd: research ? null : 0, source: 'provider_authority_ledgers', actual_unknown_until_settled: !!createApi || !!research },
            provider_calls: createApi ? null : 0, playback: 'not_connected', research: research ? research.summary() : 'not_connected',
            generation_authority: createApi?.getAuthority?.()?.summary?.() || null,
            dictionary_active: activeDictionary, dictionary_versions: [...compilers.keys()],
            performance: performance ? { state: performance.getState(), capabilities: performance.getCapabilities() } : null };
          case 'events': { const since = Number.isSafeInteger(Number(input.since)) && Number(input.since) >= 0 ? Number(input.since) : 0; const events = db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(since, Math.min(200, Math.max(1, Number(input.limit) || 50))).map(r => ({ seq: r.seq, at: r.at, type: r.type, ...JSON.parse(r.data) })); return { ok: true, events, cursor: events.at(-1)?.seq ?? since }; }
          case 'assets_query': { const assets = list('assets', input.limit); return { ok: true, assets, message: assets.length ? '已核驗產物與人類試聽狀態分開記錄。' : '尚無經本工作流程驗證的實際產物。' }; }
          case 'feedback_record': return feedbackRecord(input);
          case 'next_iteration': return nextIteration(input);
          case 'loop_prepare': return loops().prepare(input);
          case 'loop_start': return loops().start(input);
          case 'loop_pause': return loops().pause(input);
          case 'loop_resume': return loops().resume(input);
          case 'loop_stop': return loops().stop(input);
          case 'loop_state': return input.loop_id ? loops().get(input) : loops().list();
          case 'research_summary': case 'research_library': case 'research_prepare': case 'research_run': case 'research_analyze': case 'research_job': case 'research_evidence': case 'research_import_evidence': case 'research_propose_terms': case 'research_review_candidate': case 'research_stop': return researchAction(action, input);
          case 'performance_state': case 'performance_probe': case 'performance_plan': case 'performance_queue': case 'performance_dequeue': case 'performance_pause': case 'performance_takeover': case 'performance_resume': case 'performance_stop': case 'performance_manifest': return performanceAction(action, input);
          default: return failure('unsupported', '未知音樂操作。');
        }
      });
    },
  };
}
