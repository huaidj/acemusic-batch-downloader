import { CREATE_INPUT_SCHEMA } from './create-contract.mjs';
function tool(action, name, method, path, description, inputSchema, readOnly = true) {
  return { action, method, path, name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: action !== 'submit', openWorldHint: ['preview', 'submit'].includes(action) } };
}
const empty = { type: 'object', properties: {}, additionalProperties: false };
export const CREATE_CONTRACT = [
  tool('capabilities', 'ace_create_capabilities', 'GET', '/create-api/capabilities', 'Create 頁面已核對的完整 API 參數、模型條件及實測邊界。', empty),
  tool('prepare', 'ace_create_prepare', 'POST', '/create-api/prepare', '依前端契約驗證所有 Create 參數，產生原生 HTTP JSON；純本機、不扣費、不讀登入。', CREATE_INPUT_SCHEMA),
  tool('preview', 'ace_create_preview', 'POST', '/create-api/preview', '以既有本機登入唯讀核對即時模型、成本及上限，不提交生成。', CREATE_INPUT_SCHEMA),
  tool('submit', 'ace_create_submit', 'POST', '/create-api/submit', '僅在獨立本機批次授權與累計預算允許時送出一次 API 請求；預設拒絕，unknown 不重送。', { type: 'object', properties: { input: CREATE_INPUT_SCHEMA, reviewed_request_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, idempotency_key: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['input', 'reviewed_request_hash', 'idempotency_key'], additionalProperties: false }, false),
  tool('authority', 'ace_create_authority', 'GET', '/create-api/authority', '讀取獨立批次授權及預留/支出狀態，不顯示憑據或本機路徑。', empty),
  tool('tasks', 'ace_create_task_status', 'POST', '/create-api/tasks', '依精確任務 ID 唯讀核對三模型的實際狀態；遠端音訊可用不代表下載或試聽驗收。', { type: 'object', properties: { task_ids: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' } }, requested_model: { type: 'string', enum: ['acemusic-v1', 'acemusic-v1.1', 'ace-step-1.5-xl'] } }, required: ['task_ids', 'requested_model'], additionalProperties: false }),
  tool('receipt', 'ace_create_receipt', 'POST', '/create-api/receipt', '以原幂等鍵查持久化收據；不因服務斷線或授權過期重送。', { type: 'object', properties: { idempotency_key: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['idempotency_key'], additionalProperties: false }),
  tool('stop', 'ace_create_stop', 'POST', '/create-api/stop', '停止授權批次的新提交；已送出或未知結果保留預留，不假裝遠端取消。', { type: 'object', properties: { grant_id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['grant_id'], additionalProperties: false }, false),
];
export const CREATE_TOOLS = CREATE_CONTRACT.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
