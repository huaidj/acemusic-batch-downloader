// Local-only preparation ledger. Only the existing Hub instantiates this writer.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getCapabilities, dictionaryQuery, prepareIntent, compilePrompt, prepareGeneration, normalizeModel } from '../music/core.mjs';
import { MUSIC_CONTRACT, validateMusicInput } from './music-contract.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (status, error) => ({ ok: false, status, error });
const now = () => new Date().toISOString();

export function createMusicService({ stateDir, onEvent = () => {} }) {
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
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
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
  function saveSession(session) { db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id, JSON.stringify(session)); }
  function list(table, limit = 50) { return db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC LIMIT ?`).all(Math.min(100, Math.max(1, Number(limit) || 50))).map(decode); }
  function snapshot(kind, value) {
    const id = kind + ':' + hash(value);
    db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?)').run(id, JSON.stringify({ kind, value }));
  }
  function safe(work) {
    try { return work(); }
    catch { return failure('failed', '本機紀錄未完成；原有任務保留，請查看本機服務狀態。'); }
  }
  function sessionCreate(input) {
    const max = input.max_generations ?? 1;
    const depth = input.max_depth ?? 1;
    if (!Number.isInteger(max) || max < 1 || max > 100 || !Number.isInteger(depth) || depth < 1 || depth > 10) return failure('invalid', '任務上限需為 1–100，代數需為 1–10。');
    const session = { id: 's_' + randomUUID(), goal: String(input.goal || '本機提示詞預覽').slice(0, 2000), status: 'active', max_generations: max, max_depth: depth,
      budget_limits: { ace_credits: 0, deepseek_usd: 0 }, permission_scope: ['local_prepare'], created_at: now(), actual_cost: { ace_credits: 0, deepseek_usd: 0 } };
    // No request field can grant provider access or increase this build's permissions.
    const e = transaction(() => { saveSession(session); return event('session_created', { session_id: session.id }); });
    emit(e); return { ok: true, status: 'active', session };
  }
  function compile(input) {
    const result = compilePrompt(input);
    if (!result.plan) return result;
    const p = result.plan;
    const existing = decode(db.prepare('SELECT data FROM plans WHERE id=?').get(p.id));
    if (existing && hash(existing) !== hash(p)) return failure('conflict', '同一計畫識別碼內容不同，已保留原紀錄。');
    if (existing) return { ...result, persisted: true, reused: true };
    const e = transaction(() => {
      db.prepare('INSERT OR IGNORE INTO plans VALUES(?,?,?)').run(p.id, p.hash || hash(p), JSON.stringify(p));
      snapshot('dictionary', dictionaryQuery({})); snapshot('capabilities', getCapabilities());
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
    const request = { plan_id: input.plan_id, session_id: session.id, actual_model: input.actual_model ? normalizeModel(input.actual_model) : null, reviewed: input.reviewed };
    const requestHash = hash(request);
    const previous = db.prepare('SELECT request_hash,data FROM jobs WHERE idem=?').get(input.idempotency_key);
    if (previous) return previous.request_hash === requestHash ? { ok: true, status: JSON.parse(previous.data).status, job: decode(previous), reused: true } : failure('idempotency_conflict', '此幂等鍵已用於不同計畫，請保留原任務並使用新鍵。');
    if (session.status !== 'active') return failure('cancelled', '此批次已停止；不再建立任務。');
    const count = db.prepare('SELECT data FROM jobs').all().map(decode).filter(j => j.session_id === session.id).length;
    if (count >= session.max_generations) return failure('budget_blocked', '已達本批次任務數上限。');
    if (input.actual_model && normalizeModel(input.actual_model) !== plan.requested_model) return failure('needs_recompile', '模型已變更，請重新編譯並審閱提示詞。');
    const check = prepareGeneration({ plan, session, reviewed: input.reviewed, actual_model: input.actual_model });
    if (check.ok === false && !['awaiting_authorization', 'unsupported'].includes(check.status)) return check;
    if (plan.translation_required) return failure('translation_required', '仍有待核對的翻譯，請先審閱英文描述。');
    const job = { id: 'g_' + randomUUID(), plan_id: plan.id, session_id: session.id, status: 'awaiting_authorization', adapter: null,
      requested_model: plan.requested_model, actual_model: null, remote_task_id: null, dictionary_version: plan.dictionary_version || plan.versions?.dictionary_version,
      versions: plan.versions, budget_reservation: { ace_credits: 0, deepseek_usd: 0 }, estimated_cost: null,
      submitted_at: null, created_at: now(), reviewed_at: now(), real_success: false, artifacts: [], stop_semantics: '僅停止本機後續排程；此版本未送出遠端任務。' };
    const e = transaction(() => { db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(job.id, input.idempotency_key, requestHash, JSON.stringify(job)); return event('generation_prepared', { job_id: job.id, session_id: session.id, status: job.status }); });
    emit(e); return { ok: true, status: job.status, job, authorization_requirements: ['供應商及可用 adapter', '模型與實際價格', '單輪及全批次預算', '上傳範圍', '是否自動繼續'], provider_calls: 0 };
  }
  function stop(input) {
    const session = getSession(input.session_id || '');
    if (!session) return failure('not_found', '找不到此批次。');
    const e = transaction(() => {
      session.status = 'stopped'; session.stopped_at ||= now(); saveSession(session);
      for (const row of db.prepare('SELECT id,data FROM jobs').all()) {
        const j = decode(row);
        if (j.session_id === session.id && j.status === 'awaiting_authorization') { j.status = 'cancelled'; j.cancelled_at = now(); db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(j), j.id); }
      }
      return event('session_stopped', { session_id: session.id });
    });
    emit(e); return { ok: true, status: 'stopped', session, remote_tasks: [], message: '已停止後續任務；此批次沒有送出的遠端任務。' };
  }
  return {
    close() { db.close(); },
    call(action, input = {}) {
      return safe(() => {
        const contract = MUSIC_CONTRACT.find(c => c.action === action);
        if (!contract) return failure('unsupported', '未知音樂操作。');
        const invalid = validateMusicInput(input, contract.inputSchema);
        if (invalid) return failure('invalid', invalid);
        switch (action) {
          case 'capabilities': return getCapabilities();
          case 'dictionary': return dictionaryQuery(input);
          case 'intent_prepare': return prepareIntent(input);
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
          case 'generation_submit': return failure('unsupported', '尚無獲准並完成驗收的真實生成 adapter。預覽可用；本版本不送出 ACE 或 DeepSeek 請求。');
          case 'job_status': { const job = decode(db.prepare('SELECT data FROM jobs WHERE id=?').get(input.job_id || '')); return job ? { ok: true, status: job.status, job } : failure('not_found', '找不到此任務。'); }
          case 'state': return { ok: true, sessions: list('sessions'), plans: list('plans'), jobs: list('jobs'), references: list('refs'), assets: list('assets'), costs: { ace_credits: 0, deepseek_usd: 0 }, provider_calls: 0, playback: 'not_connected', research: 'not_connected' };
          case 'events': { const since = Number.isSafeInteger(Number(input.since)) && Number(input.since) >= 0 ? Number(input.since) : 0; const events = db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(since, Math.min(200, Math.max(1, Number(input.limit) || 50))).map(r => ({ seq: r.seq, at: r.at, type: r.type, ...JSON.parse(r.data) })); return { ok: true, events, cursor: events.at(-1)?.seq ?? since }; }
          case 'assets_query': return { ok: true, assets: list('assets', input.limit), message: '尚無經本工作流程驗證的實際產物。' };
          case 'feedback_record': {
            const artifact = decode(db.prepare('SELECT data FROM assets WHERE id=?').get(input.artifact_id || ''));
            if (!artifact) return failure('not_found', '需要已核驗的實際產物才能記錄人類試聽。提示詞預覽不是音樂。');
            return failure('unsupported', '實際產物回收尚未接通。');
          }
          default: return failure('unsupported', '未知音樂操作。');
        }
      });
    },
  };
}
