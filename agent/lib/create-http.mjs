import path from 'node:path';
import { getCreateCapabilities, prepareCreateRequest, CREATE_INPUT_SCHEMA } from './create-contract.mjs';
import { createGenerationAuthority } from './generation-authority.mjs';
import { createAceTransport } from './create-transport.mjs';
import { CREATE_CONTRACT } from './create-tools.mjs';

const failed = (status, error) => ({ ok: false, status, error });
export function createApiController({ cfg, addJob, enqueue }) {
  let authority, transport;
  const pendingJobs = new Map();
  function ledger() { return authority ||= createGenerationAuthority({ stateDir: path.join(cfg.stateDir, 'music-agent'), grantFile: process.env.ACE_GENERATION_GRANT_FILE }); }
  function provider() { return transport ||= createAceTransport(cfg, { authority: ledger() }); }
  const reply = (http_status, result) => ({ http_status, result });
  async function execute(action, input = {}) {
    if (!CREATE_CONTRACT.some(c => c.action === action)) return reply(404, failed('not_found', '未知 Create API 操作。'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(400, failed('invalid', '參數需要是 JSON 物件。'));
    try {
      if (action === 'capabilities') return reply(200, { ...getCreateCapabilities(), input_schema: CREATE_INPUT_SCHEMA });
      if (action === 'prepare') { const result = prepareCreateRequest(input); return reply(result.ok ? 200 : 422, result); }
      const auth = ledger();
      if (action === 'authority') return reply(200, auth.summary());
      if (action === 'tasks') { const result = await provider().status(input); return reply(result.ok === false ? 422 : 200, result); }
      if (action === 'receipt' || action === 'stop') {
        const key = action === 'receipt' ? 'idempotency_key' : 'grant_id';
        if (Object.keys(input).some(k => k !== key) || typeof input[key] !== 'string' || !input[key] || input[key].length > 128) return reply(400, failed('invalid', '需要有效的批次或幂等識別碼。'));
        const result = action === 'receipt' ? auth.getReceipt(input[key]) : auth.stop(input[key]);
        return reply(result.ok === false ? 422 : 200, result);
      }
      const submitting = action === 'submit';
      if (submitting && (Object.keys(input).some(k => !['input', 'reviewed_request_hash', 'idempotency_key'].includes(k)) || typeof input.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotency_key))) return reply(400, failed('invalid', '提交需要原始參數、已審閱的 hash 與固定幂等鍵。'));
      const prepared = prepareCreateRequest(submitting ? input.input : input);
      if (!prepared.ok) return reply(422, prepared);
      if (action === 'preview') { const result = await provider().preview(prepared); return reply(result.ok === false ? 422 : 200, result); }
      if (input.reviewed_request_hash !== prepared.request_hash) return reply(409, failed('awaiting_review', '實際參數與審閱版本不同，請重新準備及核對。'));
      const previous = auth.getReceipt(input.idempotency_key);
      if (previous.ok) {
        if (previous.reservation.request_hash !== prepared.request_hash) return reply(409, failed('idempotency_conflict', '此幂等鍵屬於另一份請求。'));
        return reply(200, { ...previous, reused: true, message: '只讀原收據，不會重新提交。' });
      }
      // Check for an independent grant before loading any session or reading the
      // provider. The tool payload has no way to create or expand that grant.
      const summary = auth.summary();
      if (summary.ok === false || !summary.grant || summary.status !== 'ready') return reply(403, failed('awaiting_authorization', '尚無有效的獨立批次授權。需要供應商/模型、單次及全批次 Credits 上限、任務數、期限及素材範圍。'));
      const preview = await provider().preview(prepared);
      if (!preview.ok) return reply(422, preview);
      const reserved = auth.reserve({ idempotency_key: input.idempotency_key, request_hash: prepared.request_hash, model: prepared.requested_model, mode: prepared.mode,
        estimated_credits: preview.estimated_credits, has_upload: prepared.has_upload || prepared.has_references });
      if (!reserved.ok || reserved.reused) return reply(reserved.ok ? 200 : 403, reserved);
      const job = addJob('generate');
      pendingJobs.set(input.idempotency_key, job);
      enqueue(job, async () => {
        const result = await provider().submit(prepared, input.idempotency_key);
        if (result.ok === false) throw Object.assign(new Error(result.error || result.reason || '提交未確認，請查原收據。'), { code: result.code || 'GENERATION_SUBMISSION_UNKNOWN', submission_unknown: result.submission_unknown !== false });
        return result;
      });
      return reply(202, { ok: true, jobId: job.id, reservation: reserved.reservation, status: 'queued',
        authorization_preview: { requested_model: prepared.requested_model, estimated_credits: preview.estimated_credits, plan: preview.plan || null, observed_at: new Date().toISOString() },
        message: '只排入一次；用原幂等鍵查持久化收據。音檔及聽感尚未驗收。' });
    } catch (err) {
      const code = err?.code || 'CREATE_API_FAILED';
      const authRequired = code === 'NO_SESSION' || /AUTH/.test(code);
      return reply(authRequired ? 401 : 422, { ok: false, status: authRequired ? 'auth_required' : 'failed', code, error: authRequired ? '需要有效的本機登入與批次授權；未提交生成。' : 'Create API 操作未完成；請保留原幂等鍵並查看收據。', submission_unknown: err?.submission_unknown === true });
    }
  }
  return {
    execute, async call(action, input) { return (await execute(action, input)).result; }, getTransport: provider, getAuthority: ledger,
    cancelPending(key) {
      const receipt = ledger().getReceipt(key);
      if (!receipt.ok) return { ok: true, status: 'not_submitted', remote_task_ids: [] };
      if (receipt.reservation.state !== 'reserved') return { ok: false, status: receipt.reservation.state, remote_task_ids: receipt.reservation.remote_task_ids, remote_continues: true };
      const result = ledger().recordOutcome(key, { state: 'not_submitted' });
      if (result.ok) { const job = pendingJobs.get(key); if (job) job.cancelled = true; }
      return result;
    },
  };
}

export function createHttp({ controller, ...options }) {
  const api = controller || createApiController(options);
  return async function handleCreate(req, res, url, { json, readBody }) {
    if (!url.pathname.startsWith('/create-api/')) return false;
    const route = CREATE_CONTRACT.find(c => c.path === url.pathname && c.method === req.method);
    if (!route) { json(res, 404, failed('not_found', '未知 Create API 操作。')); return true; }
    let input = {};
    try { if (req.method === 'POST') input = await readBody(req); }
    catch { json(res, 400, failed('invalid', '需要有效的 JSON 物件。')); return true; }
    const response = await api.execute(route.action, input);
    json(res, response.http_status, response.result);
    return true;
  };
}
