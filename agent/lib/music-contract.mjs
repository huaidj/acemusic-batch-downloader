// One narrow contract shared by HTTP, MCP and CLI. No provider credentials here.
const string = { type: 'string', maxLength: 8000 };
const stringList = { type: 'array', items: string, maxItems: 50 };
const compile = {
  natural_language: string, model: { type: 'string', enum: ['acemusic-v1', 'acemusic-v1.1', 'ace-step-v1.5-xl', 'ace-step-1.5-xl'] },
  mode: { type: 'string', enum: ['idea', 'custom'] }, seed: { type: ['string', 'number'] },
  locked_term_ids: stringList, weights: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
  references: { type: 'array', maxItems: 20, items: { type: 'object' } }, hard_constraints: stringList,
  parent_ids: stringList, dictionary_version: string, actual_model: string, advanced: { type: 'object' }, lyrics: string,
  previous_term_ids: stringList, max_changed_dimensions: { type: 'integer', minimum: 0, maximum: 6 },
  reference_seed: { type: ['string', 'number'] }, model_seed: { type: ['string', 'number'] },
};
function entry(action, name, method, path, description, properties = {}, required = [], readOnly = true) {
  return { action, name, method, path, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly || ['prompt_compile', 'generation_prepare', 'session_stop'].includes(action), openWorldHint: false } };
}
export const MUSIC_CONTRACT = [
  entry('capabilities', 'music_capabilities', 'GET', '/music/capabilities', '三模型與模式的文件能力、實測狀態及授權限制。'),
  entry('dictionary', 'music_dictionary_query', 'GET', '/music/dictionary', '查詢版本化中英詞條、內部權重及來源。', { query: string, dimension: string, version: string }),
  entry('reference_register', 'music_reference_register', 'POST', '/music/references', '本機登記引用，不抓取音訊或網頁；Spotify 只作導覽並封鎖 AI 使用。', { user_input: string, source: string, kind: string, description: string, rights_status: string, ai_ingestion_allowed: { type: 'boolean' } }, ['user_input'], false),
  entry('intent_prepare', 'music_intent_prepare', 'POST', '/music/intent/prepare', '解析創作方向與來源門禁；不發送模型請求。', compile),
  entry('prompt_compile', 'music_prompt_compile', 'POST', '/music/prompts/compile', '產生可重現、可審閱的模型提示詞並保存版本；不扣費。', compile, ['natural_language'], false),
  entry('session_create', 'music_session_create', 'POST', '/music/sessions', '建立僅允許本機準備的有限批次；無法開啟供應商權限。', { goal: string, max_generations: { type: 'integer', minimum: 1, maximum: 100 }, max_depth: { type: 'integer', minimum: 1, maximum: 10 } }, [], false),
  entry('generation_prepare', 'music_generation_prepare', 'POST', '/music/generations/prepare', '將已存提示詞登記為待授權任務，持久化幂等鍵；不送出遠端任務。', { plan_id: string, session_id: string, idempotency_key: { type: 'string', minLength: 1, maxLength: 128 }, actual_model: string, reviewed: { type: 'boolean' } }, ['plan_id', 'session_id', 'idempotency_key', 'reviewed'], false),
  entry('generation_submit', 'music_generation_submit', 'POST', '/music/generations/submit', '目前固定 unsupported：真實 adapter、費用與上傳尚未授權及驗收。', { job_id: string }, ['job_id'], false),
  entry('job_status', 'music_job_status', 'GET', '/music/job', '查詢持久化準備任務，不將預覽報為生成成功。', { job_id: string }, ['job_id']),
  entry('events', 'music_events', 'GET', '/music/events', '以持久化游標讀取音樂準備事件。', { since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  entry('session_stop', 'music_session_stop', 'POST', '/music/sessions/stop', '停止本機後續準備並取消尚未送出的任務。', { session_id: string }, ['session_id'], false),
  entry('assets_query', 'music_assets_query', 'GET', '/music/assets', '僅列出經本流程回收驗證的實際音訊產物。', { limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  entry('feedback_record', 'music_feedback_record', 'POST', '/music/feedback', '實際產物驗證後才可記人類試聽；預覽不接受試聽評分。', { artifact_id: string, text: string, explicit_rating: { type: 'number', minimum: 0, maximum: 5 } }, ['artifact_id'], false),
  entry('state', 'music_state', 'GET', '/music/state', '本機批次、提示詞、任務及實際費用總覽。'),
];
export const MUSIC_TOOLS = MUSIC_CONTRACT.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));

export function validateMusicInput(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '輸入需要是 JSON 物件。';
  for (const key of schema.required || []) if (!(key in value)) return '缺少欄位：' + key;
  for (const [key, v] of Object.entries(value)) {
    const p = schema.properties[key];
    if (!p) return '不支援欄位：' + key;
    const types = Array.isArray(p.type) ? p.type : [p.type];
    if (!types.some(t => t === 'integer' ? Number.isSafeInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === t)) return '欄位類型錯誤：' + key;
    if (typeof v === 'string' && (v.length > (p.maxLength ?? 8000) || v.length < (p.minLength ?? 0))) return '文字長度超限：' + key;
    if (typeof v === 'number' && (!Number.isFinite(v) || v < (p.minimum ?? -Infinity) || v > (p.maximum ?? Infinity))) return '數值超出範圍：' + key;
    if (p.enum && !p.enum.includes(v)) return '不支援的值：' + key;
    if (Array.isArray(v) && v.length > (p.maxItems ?? 100)) return '項目過多：' + key;
    if (p.items?.type === 'string' && v.some(item => typeof item !== 'string' || item.length > 8000)) return '清單內容錯誤：' + key;
    if (p.items?.type === 'object' && v.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return '清單內容錯誤：' + key;
    if (key === 'weights' && Object.values(v).some(weight => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1)) return '詞條權重需為 0–1。';
  }
  return null;
}
