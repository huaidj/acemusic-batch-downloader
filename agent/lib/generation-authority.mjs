// Finite server-owned ACE authority. This module never contacts a provider or
// reads credentials. Pass grantFile only from the Hub process configuration.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const UNIT = 1_000_000;
const MODEL_ALIASES = new Map([
  ['acemusic-v1', 'acemusic-v1'], ['acemusic-v1.1', 'acemusic-v1.1'],
  ['ace-step-v1.5-xl', 'ace-step-1.5-xl'], ['ace-step-1.5-xl', 'ace-step-1.5-xl'],
]);
const MODES = new Set(['idea', 'custom']);
const GRANT_FIELDS = ['grant_id', 'provider', 'models', 'modes', 'max_credits_per_request', 'max_credits_total', 'max_generations', 'expires_at', 'allow_upload', 'allow_auto_continue'];
const RESERVE_FIELDS = new Set(['idempotency_key', 'request_hash', 'model', 'mode', 'estimated_credits', 'has_upload']);
const OUTCOME_FIELDS = new Set(['state', 'remote_task_ids', 'actual_credits']);
const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (status, error) => ({ ok: false, status, error });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const validKey = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const creditUnits = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const units = Math.round(value * UNIT);
  return Number.isSafeInteger(units) && units / UNIT === value ? units : null;
};

function validateGrant(value) {
  if (!OBJECT(value) || Object.keys(value).length !== GRANT_FIELDS.length || GRANT_FIELDS.some(field => !(field in value))) return null;
  if (!validId(value.grant_id) || value.provider !== 'ace' || value.allow_upload !== false || typeof value.allow_auto_continue !== 'boolean') return null;
  if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 3 || value.models.some(model => !MODEL_ALIASES.has(model))) return null;
  const models = value.models.map(model => MODEL_ALIASES.get(model)).sort();
  if (new Set(models).size !== models.length) return null;
  if (!Array.isArray(value.modes) || value.modes.length < 1 || value.modes.length > 2 || value.modes.some(mode => !MODES.has(mode)) || new Set(value.modes).size !== value.modes.length) return null;
  if (creditUnits(value.max_credits_per_request) === null || creditUnits(value.max_credits_total) === null || !Number.isSafeInteger(value.max_generations) || value.max_generations < 1) return null;
  if (typeof value.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.expires_at)) return null;
  const expiry = Date.parse(value.expires_at);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString().slice(0, 19) !== value.expires_at.slice(0, 19)) return null;
  return {
    grant_id: value.grant_id, provider: 'ace', models, modes: [...value.modes].sort(),
    max_credits_per_request: value.max_credits_per_request, max_credits_total: value.max_credits_total,
    max_generations: value.max_generations, expires_at: new Date(expiry).toISOString(), allow_upload: false, allow_auto_continue: value.allow_auto_continue,
  };
}

/** The Hub owns this writer; clients must never pass a grant filename here. */
export function createGenerationAuthority({ stateDir, grantFile } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('A server-owned state directory is required.');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, 'generation-authority.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS generation_grants (
      grant_id TEXT PRIMARY KEY, grant_hash TEXT NOT NULL, data TEXT NOT NULL, stopped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS generation_reservations (
      key_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL, grant_id TEXT NOT NULL,
      estimated_units INTEGER NOT NULL, actual_units INTEGER,
      state TEXT NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY(grant_id) REFERENCES generation_grants(grant_id)
    );
    CREATE INDEX IF NOT EXISTS generation_reservation_grant ON generation_reservations(grant_id);`);
  let closed = false;
  const decode = row => row ? JSON.parse(row.data) : null;
  const grantRow = id => db.prepare('SELECT * FROM generation_grants WHERE grant_id=?').get(id);
  const receiptRow = key => validKey(key) ? db.prepare('SELECT * FROM generation_reservations WHERE key_hash=?').get(sha(key)) : null;
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  function safe(work) {
    if (closed) return fail('closed', '授權帳本已關閉。');
    try { return work(); }
    catch { return fail('failed', '本機授權帳本未完成操作；既有預留保留。'); }
  }
  function readGrant() {
    if (typeof grantFile !== 'string' || !grantFile) return { ...fail('authorization_required', '未設定伺服器授權檔案。'), grant: null };
    let raw;
    try {
      if (fs.statSync(grantFile).size > 65536) return { ...fail('grant_invalid', '授權檔案格式無效。'), grant: null };
      raw = JSON.parse(fs.readFileSync(grantFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch { return { ...fail('authorization_required', '無法讀取有效的伺服器授權檔案。'), grant: null }; }
    const grant = validateGrant(raw);
    if (!grant) return { ...fail('grant_invalid', '授權須明確限定模型、模式、有限預算、任務數、UTC 到期時間及是否自動繼續；上傳保持關閉。'), grant: null };
    const grantHash = sha(JSON.stringify(grant));
    const stored = grantRow(grant.grant_id);
    if (stored && stored.grant_hash !== grantHash) return { ...fail('grant_changed', '同一授權識別碼的內容已改變；不建立新預留。'), grant, grantHash };
    if (stored?.stopped_at) return { ...fail('stopped', '此授權已停止新增任務。'), grant, grantHash };
    if (Date.parse(grant.expires_at) <= Date.now()) return { ...fail('grant_expired', '此授權已到期。'), grant, grantHash };
    return { ok: true, status: 'active', grant, grantHash };
  }
  function budgetFor(grant) {
    const rows = db.prepare('SELECT estimated_units,actual_units,state FROM generation_reservations WHERE grant_id=?').all(grant.grant_id);
    let reserved = 0;
    let spent = 0;
    const states = { reserved: 0, submitted: 0, outcome_unknown: 0, not_submitted: 0, settled: 0 };
    for (const row of rows) {
      states[row.state] += 1;
      if (row.state === 'settled') spent += row.actual_units;
      else if (row.state !== 'not_submitted') reserved += row.estimated_units;
    }
    const used = rows.length - states.not_submitted;
    return {
      budget: { max_credits_per_request: grant.max_credits_per_request, max_credits_total: grant.max_credits_total, reserved: reserved / UNIT, spent: spent / UNIT,
        available: (creditUnits(grant.max_credits_total) - reserved - spent) / UNIT },
      slots: { max_generations: grant.max_generations, used, available: grant.max_generations - used, receipts: rows.length, ...states },
    };
  }
  function receipt(row, reused = false) {
    const reservation = decode(row);
    return { ok: true, status: reservation.state, reservation, reused };
  }
  function canSubmit(key) {
    if (closed) return false;
    try {
      const reservation = decode(receiptRow(key));
      if (!reservation || reservation.state !== 'reserved') return false;
      const current = readGrant();
      return current.ok === true && current.grant.grant_id === reservation.grant_id && current.grantHash === reservation.grant_hash &&
        current.grant.models.includes(reservation.model) && current.grant.modes.includes(reservation.mode) &&
        reservation.has_upload === false && creditUnits(reservation.estimated_credits) <= creditUnits(current.grant.max_credits_per_request);
    } catch { return false; }
  }
  function reserve(input) {
    if (!OBJECT(input) || Object.keys(input).some(key => !RESERVE_FIELDS.has(key)) || !validKey(input.idempotency_key) ||
      typeof input.request_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.request_hash) ||
      !MODEL_ALIASES.has(input.model) || !MODES.has(input.mode) || creditUnits(input.estimated_credits) === null ||
      (input.has_upload !== undefined && typeof input.has_upload !== 'boolean')) return fail('invalid', '需要有效幂等鍵、SHA-256 請求摘要、模型、模式及已知的非負有限估價；不接受請求自行增加授權欄位。');
    const normalized = { request_hash: input.request_hash.toLowerCase(), model: MODEL_ALIASES.get(input.model), mode: input.mode,
      estimated_credits: input.estimated_credits, has_upload: input.has_upload ?? false };
    return transaction(() => {
      const previous = receiptRow(input.idempotency_key);
      if (previous) {
        const existing = decode(previous);
        if (previous.request_hash !== normalized.request_hash || ['model', 'mode', 'estimated_credits', 'has_upload'].some(field => existing[field] !== normalized[field])) return fail('idempotency_conflict', '此幂等鍵已綁定不同請求；保留原收據。');
        return { ...receipt(previous, true), can_submit: false };
      }
      const current = readGrant();
      if (!current.ok) return fail(current.status, current.error);
      const { grant, grantHash } = current;
      if (normalized.has_upload) return fail('upload_not_authorized', '此授權不允許上傳參考素材。');
      if (!grant.models.includes(normalized.model) || !grant.modes.includes(normalized.mode)) return fail('scope_denied', '模型或模式不在伺服器授權範圍。');
      const amount = creditUnits(normalized.estimated_credits);
      const { budget, slots } = budgetFor(grant);
      if (amount > creditUnits(grant.max_credits_per_request) || amount > creditUnits(budget.available)) return fail('budget_blocked', '此請求超過單次或整批可用額度。');
      if (slots.available < 1) return fail('generation_limit', '已達此授權的最大生成任務數。');
      if (!grantRow(grant.grant_id)) db.prepare('INSERT INTO generation_grants VALUES(?,?,?,NULL)').run(grant.grant_id, grantHash, JSON.stringify(grant));
      const keyHash = sha(input.idempotency_key);
      const at = now();
      const reservation = { id: 'reservation_' + keyHash, grant_id: grant.grant_id, grant_hash: grantHash, ...normalized,
        state: 'reserved', actual_credits: null, remote_task_ids: [], created_at: at, updated_at: at };
      db.prepare('INSERT INTO generation_reservations VALUES(?,?,?,?,NULL,?,?)').run(keyHash, normalized.request_hash, grant.grant_id, amount, 'reserved', JSON.stringify(reservation));
      return { ok: true, status: 'reserved', reservation, reused: false, can_submit: true };
    });
  }
  function recordOutcome(key, outcome) {
    if (!validKey(key) || !OBJECT(outcome) || Object.keys(outcome).some(field => !OUTCOME_FIELDS.has(field)) ||
      !['submitted', 'outcome_unknown', 'not_submitted', 'settled'].includes(outcome.state)) return fail('invalid', '需要有效收據與支援的結果狀態。');
    if (outcome.remote_task_ids !== undefined && (!Array.isArray(outcome.remote_task_ids) || outcome.remote_task_ids.length > 20 ||
      outcome.remote_task_ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id)))) return fail('invalid', '遠端任務識別碼無效。');
    if (outcome.state === 'settled' ? creditUnits(outcome.actual_credits) === null : outcome.actual_credits !== undefined) return fail('invalid', '僅結算狀態接受明確的非負有限實際額度。');
    return transaction(() => {
      const row = receiptRow(key);
      if (!row) return fail('not_found', '找不到此預留收據。');
      const previous = decode(row);
      const state = outcome.state;
      // This transition is also the executor's durable compare-and-set claim:
      // only the first reserved -> unknown result may initiate a POST. A replay
      // reports reused below; an acknowledged submission cannot be reclaimed.
      if (state === 'outcome_unknown' && previous.state === 'submitted') return fail('invalid_transition', '已確認送出的任務不能重新取得提交權。');
      if (state === 'outcome_unknown' && previous.state === 'reserved' && !canSubmit(key)) return fail('authorization_revoked', '提交前授權已停止、到期或改變；尚未送出。');
      const mergedIds = [...new Set([...previous.remote_task_ids, ...(outcome.remote_task_ids || [])])];
      if (mergedIds.length > 20) return fail('invalid', '遠端任務識別碼超過上限。');
      if (state === 'not_submitted' && (previous.state !== 'reserved' && previous.state !== 'not_submitted' || mergedIds.length)) return fail('unsafe_release', '已送出或結果未知的請求不得釋放預留。');
      if (state === 'settled' && !['submitted', 'outcome_unknown', 'settled'].includes(previous.state)) return fail('invalid_transition', '須先記錄已送出或結果未知，才能結算。');
      if (state === 'settled' && creditUnits(outcome.actual_credits) > row.estimated_units) return fail('settlement_exceeds_reservation', '實際費用超出原預留；不釋放預留，需人工核對。');
      if (['not_submitted', 'settled'].includes(previous.state)) {
        const same = previous.state === state && (state !== 'settled' || previous.actual_credits === outcome.actual_credits) && mergedIds.length === previous.remote_task_ids.length;
        return same ? receipt(row, true) : fail('terminal_receipt', '終結收據不能重播或改寫。');
      }
      const updated = { ...previous, state, remote_task_ids: mergedIds, updated_at: now() };
      if (state === 'settled') updated.actual_credits = outcome.actual_credits;
      if (previous.state === state && mergedIds.length === previous.remote_task_ids.length) return receipt(row, true);
      db.prepare('UPDATE generation_reservations SET actual_units=?,state=?,data=? WHERE key_hash=?').run(state === 'settled' ? creditUnits(outcome.actual_credits) : null, state, JSON.stringify(updated), sha(key));
      return { ok: true, status: state, reservation: updated, reused: false };
    });
  }
  return {
    close() { if (!closed) { db.close(); closed = true; } },
    reserve(input) { return safe(() => reserve(input)); },
    recordOutcome(key, outcome) { return safe(() => recordOutcome(key, outcome)); },
    canSubmit,
    getReceipt(key) { return safe(() => {
      if (!validKey(key)) return fail('invalid', '收據識別碼無效。');
      const row = receiptRow(key);
      return row ? receipt(row, true) : fail('not_found', '找不到此預留收據。');
    }); },
    summary() { return safe(() => {
      const current = readGrant();
      const ledger = db.prepare('SELECT * FROM generation_grants ORDER BY rowid').all().map(row => ({ grant_id: row.grant_id, stopped: !!row.stopped_at, ...budgetFor(decode(row)) }));
      return { ok: current.ok, status: current.ok ? 'ready' : current.status, error: current.error, grant: current.grant,
        ...(current.grant ? budgetFor(current.grant) : { budget: null, slots: null }), ledger };
    }); },
    stop(grantId) { return safe(() => {
      if (!validId(grantId)) return fail('invalid', '授權識別碼無效。');
      return transaction(() => {
        let row = grantRow(grantId);
        if (!row) {
          const current = readGrant();
          if (!current.grant || current.grant.grant_id !== grantId) return fail('not_found', '找不到此授權。');
          db.prepare('INSERT INTO generation_grants VALUES(?,?,?,NULL)').run(grantId, current.grantHash, JSON.stringify(current.grant));
          row = grantRow(grantId);
        }
        if (!row.stopped_at) db.prepare('UPDATE generation_grants SET stopped_at=? WHERE grant_id=?').run(now(), grantId);
        return { ok: true, status: 'stopped', grant_id: grantId, ...budgetFor(decode(row)) };
      });
    }); },
  };
}
