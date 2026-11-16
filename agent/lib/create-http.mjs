import path from 'node:path';
import { getCreateCapabilities, prepareCreateRequest, CREATE_INPUT_SCHEMA } from './create-contract.mjs';
import { createGenerationAuthority } from './generation-authority.mjs';
import { createAceTransport } from './create-transport.mjs';
import { CREATE_CONTRACT } from './create-tools.mjs';

const failed = (status, error) => ({ ok: false, status, error });
export function createHttp({ cfg, addJob, enqueue }) {
  let authority, transport;
  function ledger() { return authority ||= createGenerationAuthority({ stateDir: path.join(cfg.stateDir, 'music-agent'), grantFile: process.env.ACE_GENERATION_GRANT_FILE }); }
  function provider() { return transport ||= createAceTransport(cfg, { authority: ledger() }); }
  return async function handleCreate(req, res, url, { json, readBody }) {
    if (!url.pathname.startsWith('/create-api/')) return false;
    const route = CREATE_CONTRACT.find(c => c.path === url.pathname && c.method === req.method);
    if (!route) { json(res, 404, failed('not_found', '未知 Create API 操作。')); return true; }
    let input = {};
    try { if (req.method === 'POST') input = await readBody(req); }
    catch { json(res, 400, failed('invalid', '需要有效的 JSON 物件。')); return true; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { json(res, 400, failed('invalid', '參數需要是 JSON 物件。')); return true; }
    try {
      if (route.action === 'capabilities') { json(res, 200, { ...getCreateCapabilities(), input_schema: CREATE_INPUT_SCHEMA }); return true; }
      if (route.action === 'prepare') { const result = prepareCreateRequest(input); json(res, result.ok ? 200 : 422, result); return true; }
      const auth = ledger();
      if (route.action === 'authority') { json(res, 200, auth.summary()); return true; }
      if (route.action === 'tasks') { const result = await provider().status(input); json(res, result.ok === false ? 422 : 200, result); return true; }
      if (route.action === 'receipt' || route.action === 'stop') {
        const key = route.action === 'receipt' ? 'idempotency_key' : 'grant_id';
        if (Object.keys(input).some(k => k !== key) || typeof input[key] !== 'string' || !input[key] || input[key].length > 128) { json(res, 400, failed('invalid', '需要有效的批次或幂等識別碼。')); return true; }
        const result = route.action === 'receipt' ? auth.getReceipt(input[key]) : auth.stop(input[key]);
        json(res, result.ok === false ? 422 : 200, result); return true;
      }
      const submitting = route.action === 'submit';
      if (submitting && (Object.keys(input).some(k => !['input', 'reviewed_request_hash', 'idempotency_key'].includes(k)) || typeof input.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotency_key))) { json(res, 400, failed('invalid', '提交需要原始參數、已審閱的 hash 與固定幂等鍵。')); return true; }
      const prepared = prepareCreateRequest(submitting ? input.input : input);
      if (!prepared.ok) { json(res, 422, prepared); return true; }
      if (route.action === 'preview') { const result = await provider().preview(prepared); json(res, result.ok === false ? 422 : 200, result); return true; }
      if (input.reviewed_request_hash !== prepared.request_hash) { json(res, 409, failed('awaiting_review', '實際參數與審閱版本不同，請重新準備及核對。')); return true; }
      const previous = auth.getReceipt(input.idempotency_key);
      if (previous.ok) {
        if (previous.reservation.request_hash !== prepared.request_hash) { json(res, 409, failed('idempotency_conflict', '此幂等鍵屬於另一份請求。')); return true; }
        json(res, 200, { ...previous, reused: true, message: '只讀原收據，不會重新提交。' }); return true;
      }
      // Check for an independent grant before loading any session or reading the
      // provider. The tool payload has no way to create or expand that grant.
      const summary = auth.summary();
      if (summary.ok === false || !summary.grant || summary.status !== 'ready') { json(res, 403, failed('awaiting_authorization', '尚無有效的獨立批次授權。需要供應商/模型、單次及全批次 Credits 上限、任務數、期限及素材範圍。')); return true; }
      const preview = await provider().preview(prepared);
      if (!preview.ok) { json(res, 422, preview); return true; }
      const reserved = auth.reserve({ idempotency_key: input.idempotency_key, request_hash: prepared.request_hash, model: prepared.requested_model, mode: prepared.mode,
        estimated_credits: preview.estimated_credits, has_upload: prepared.has_upload || prepared.has_references });
      if (!reserved.ok || reserved.reused) { json(res, reserved.ok ? 200 : 403, reserved); return true; }
      const job = addJob('generate');
      enqueue(job, async () => {
        const result = await provider().submit(prepared, input.idempotency_key);
        if (result.ok === false) throw Object.assign(new Error(result.error || result.reason || '提交未確認，請查原收據。'), { code: result.code || 'GENERATION_SUBMISSION_UNKNOWN', submission_unknown: result.submission_unknown !== false });
        return result;
      });
      json(res, 202, { ok: true, jobId: job.id, reservation: reserved.reservation, status: 'queued', message: '只排入一次；用原幂等鍵查持久化收據。音檔及聽感尚未驗收。' });
    } catch (err) {
      const code = err?.code || 'CREATE_API_FAILED';
      const authRequired = code === 'NO_SESSION' || /AUTH/.test(code);
      json(res, authRequired ? 401 : 422, { ok: false, status: authRequired ? 'auth_required' : 'failed', code, error: authRequired ? '需要有效的本機登入與批次授權；未提交生成。' : 'Create API 操作未完成；請保留原幂等鍵並查看收據。', submission_unknown: err?.submission_unknown === true });
    }
    return true;
  };
}
