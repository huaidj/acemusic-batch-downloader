// One narrow contract shared by HTTP, MCP and CLI. No provider credentials here.
import { CREATE_INPUT_SCHEMA } from './create-contract.mjs';
import { RESEARCH_PREPARE_SCHEMA } from '../research/service.mjs';
import { MUSIC_LOOP_PREPARE_SCHEMA } from './music-loop.mjs';
const string = { type: 'string', maxLength: 8000 };
const stringList = { type: 'array', items: string, maxItems: 50 };
const apiParameters = { type: 'object', properties: Object.fromEntries(['step', 'hd', 'title', 'audio_influence', 'style_influence'].map(key => [key, CREATE_INPUT_SCHEMA.properties[key]])), additionalProperties: false };
const bufferInput = { target_minutes: { type: 'number', exclusiveMinimum: 0 }, generation_p95_seconds: { type: 'number', exclusiveMinimum: 0 } };
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
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly || ['prompt_compile', 'generation_prepare', 'generation_submit', 'poll_generation', 'session_stop', 'dictionary_activate'].includes(action), openWorldHint: ['generation_submit', 'poll_generation', 'research_run', 'performance_probe'].includes(action) } };
}
export const MUSIC_CONTRACT = [
  entry('capabilities', 'music_capabilities', 'GET', '/music/capabilities', '三模型與模式的文件能力、實測狀態及授權限制。'),
  entry('dictionary', 'music_dictionary_query', 'GET', '/music/dictionary', '查詢版本化中英詞條、內部權重及來源。', { query: string, dimension: string, version: string }),
  entry('dictionary_activate', 'music_dictionary_activate', 'POST', '/music/dictionary/activate', '啟用使用者已批准且來源可驗證的研究詞典快照；保留歷史版本。', { snapshot_id: string }, ['snapshot_id'], false),
  entry('reference_register', 'music_reference_register', 'POST', '/music/references', '本機登記引用，不抓取音訊或網頁；Spotify 只作導覽並封鎖 AI 使用。', { user_input: string, source: string, kind: string, description: string, rights_status: string, ai_ingestion_allowed: { type: 'boolean' } }, ['user_input'], false),
  entry('intent_prepare', 'music_intent_prepare', 'POST', '/music/intent/prepare', '解析創作方向與來源門禁；不發送模型請求。', compile),
  entry('prompt_compile', 'music_prompt_compile', 'POST', '/music/prompts/compile', '產生可重現、可審閱的模型提示詞並保存版本；不扣費。', compile, ['natural_language'], false),
  entry('session_create', 'music_session_create', 'POST', '/music/sessions', '建立僅允許本機準備的有限批次；無法開啟供應商權限。', { goal: string, max_generations: { type: 'integer', minimum: 1, maximum: 100 }, max_depth: { type: 'integer', minimum: 1, maximum: 10 } }, [], false),
  entry('generation_prepare', 'music_generation_prepare', 'POST', '/music/generations/prepare', '固定已審提示詞、原生參數、版本與父代；僅準備，不送出。', { plan_id: string, session_id: string, idempotency_key: { type: 'string', minLength: 1, maxLength: 128 }, actual_model: string, reviewed: { type: 'boolean' }, api_parameters: apiParameters, parent_artifact_ids: stringList }, ['plan_id', 'session_id', 'idempotency_key', 'reviewed'], false),
  entry('generation_submit', 'music_generation_submit', 'POST', '/music/generations/submit', '將已存任務交給獨立伺服器授權；立即回本機任務，不自行批准費用。', { job_id: string }, ['job_id'], false),
  entry('poll_generation', 'music_generation_poll', 'POST', '/music/generations/poll', '短呼叫喚醒背景對帳與回收；未知提交不重送。', { job_id: string }, [], false),
  entry('job_status', 'music_job_status', 'GET', '/music/job', '查詢持久化準備任務，不將預覽報為生成成功。', { job_id: string }, ['job_id']),
  entry('events', 'music_events', 'GET', '/music/events', '以持久化游標讀取音樂準備事件。', { since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  entry('session_stop', 'music_session_stop', 'POST', '/music/sessions/stop', '停止本機後續準備並取消尚未送出的任務。', { session_id: string }, ['session_id'], false),
  entry('assets_query', 'music_assets_query', 'GET', '/music/assets', '僅列出經本流程回收驗證的實際音訊產物。', { limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  entry('feedback_record', 'music_feedback_record', 'POST', '/music/feedback', '為已核驗產物追加可撤回的人類評語；機器測量不能自動接受音樂。', { artifact_id: string, text: string, accepted: { type: 'boolean' }, author: { type: 'string', enum: ['user'] }, explicit_rating: { type: 'number', minimum: 0, maximum: 5 }, dimensions: { type: 'object', maxProperties: 20, additionalProperties: { type: 'number', minimum: -1, maximum: 1 } }, idempotency_key: { type: 'string', minLength: 1, maxLength: 128 }, retracts: string }, ['artifact_id'], false),
  entry('next_iteration', 'music_next_iteration', 'POST', '/music/iterations/prepare', '從人工接受產物提出有限下一輪預覽；保留硬約束，不提交、不自動更新長期口味。', { artifact_id: string, seed: { type: ['string', 'number'] } }, ['artifact_id'], false),
  entry('loop_prepare', 'music_loop_prepare', 'POST', '/music/loops/prepare', '以人工接受的真實錨點準備有限循環；預設暫停，不能自批自動權限。', MUSIC_LOOP_PREPARE_SCHEMA.properties, MUSIC_LOOP_PREPARE_SCHEMA.required, false),
  ...['start', 'pause', 'resume', 'stop'].map(action => entry('loop_' + action, 'music_loop_' + action, 'POST', '/music/loops/' + action, '控制有限循環；每代仍需真實人類回饋與獨立伺服器自動繼續授權。', { loop_id: string }, ['loop_id'], false)),
  entry('loop_state', 'music_loop_state', 'GET', '/music/loops', '讀取持久化有限循環狀態與停止條件。', { loop_id: string }),
  entry('research_summary', 'music_research_summary', 'GET', '/music/research', '研究授權、預留及來源快照；不取得或顯示憑據。'),
  entry('research_library', 'music_research_library', 'GET', '/music/research/library', '重新載入有限研究任務、來源、候選及已審快照。'),
  entry('research_prepare', 'music_research_prepare', 'POST', '/music/research/prepare', '準備公開文字 Search/Fetch，請求不能加入供應商憑據或預算。', RESEARCH_PREPARE_SCHEMA.properties, [], false),
  entry('research_run', 'music_research_run', 'POST', '/music/research/run', '有限伺服器授權下排入研究，短回任務識別。', { job_id: string }, ['job_id'], false),
  entry('research_job', 'music_research_job', 'GET', '/music/research/job', '讀取已持久化研究狀態。', { job_id: string }, ['job_id']),
  entry('research_evidence', 'music_research_evidence', 'GET', '/music/research/evidence', '讀取有來源的證據卡。', { evidence_id: string }, ['evidence_id']),
  entry('research_import_evidence', 'music_research_import_evidence', 'POST', '/music/research/evidence/import', '匯入獨立允許的公開文字證據。', { source_url: string, title: string, summary: string, source: string, rights_status: string, ai_ingestion_allowed: { type: 'boolean' }, facts: stringList, inferences: stringList, snapshot_ids: RESEARCH_PREPARE_SCHEMA.properties.snapshot_ids }, ['source_url', 'summary', 'source', 'rights_status', 'ai_ingestion_allowed'], false),
  entry('research_propose_terms', 'music_research_propose_terms', 'POST', '/music/research/terms', '依證據提出待審詞條，不自動修改現行詞典。', { evidence_ids: stringList, terms: { type: 'array', maxItems: 30, items: { type: 'object' } }, parent_dictionary_version: string }, ['evidence_ids', 'terms', 'parent_dictionary_version'], false),
  entry('research_review_candidate', 'music_research_review_candidate', 'POST', '/music/research/terms/review', '人類審閱研究詞條，保留版本。', { candidate_id: string, approved: { type: 'boolean' }, review_note: string, reviewed_by: { type: 'string', enum: ['user'] } }, ['candidate_id', 'approved', 'review_note', 'reviewed_by'], false),
  entry('research_stop', 'music_research_stop', 'POST', '/music/research/stop', '停止後續研究並保留已送出請求的未知預留。', {}, [], false),
  entry('performance_state', 'music_performance_state', 'GET', '/music/performance', '人工佇列、備用庫存及只讀引擎狀態。'),
  entry('performance_probe', 'music_performance_probe', 'POST', '/music/performance/probe', '只讀核對已配置的本機 MixCore 健康端點。', {}, [], false),
  entry('performance_plan', 'music_performance_plan', 'POST', '/music/performance/plan', '估計已接受主佇列與 P95 預留，未知值維持未知。', bufferInput),
  entry('performance_queue', 'music_performance_queue', 'POST', '/music/performance/queue', '手動加入已核驗且人工接受的產物；不播放。', { artifact_id: string, role: { type: 'string', enum: ['main', 'backup'] }, position: { type: 'integer', minimum: 0 } }, ['artifact_id'], false),
  entry('performance_dequeue', 'music_performance_dequeue', 'POST', '/music/performance/dequeue', '手動移除佇列中的產物。', { artifact_id: string }, ['artifact_id'], false),
  ...['pause', 'takeover', 'resume', 'stop'].map(action => entry('performance_' + action, 'music_performance_' + action, 'POST', '/music/performance/' + action, '僅改變人工控制中繼資料，不觸發播放。', action === 'resume' ? {} : { reason: string }, [], false)),
  entry('performance_manifest', 'music_performance_manifest', 'POST', '/music/performance/manifest', '保存待人審 manifest；不寫外部混音庫或啟動引擎。', bufferInput, [], false),
  entry('state', 'music_state', 'GET', '/music/state', '本機批次、提示詞、任務及實際費用總覽。'),
];
export const MUSIC_TOOLS = MUSIC_CONTRACT.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));

export function validateMusicInput(value, schema) {
  function validate(v, p, key) {
    const types = Array.isArray(p.type) ? p.type : [p.type];
    if (p.type && !types.some(t => t === 'integer' ? Number.isSafeInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : t === 'null' ? v === null : typeof v === t)) return '欄位類型錯誤：' + key;
    if (p.const !== undefined && v !== p.const) return '不支援的值：' + key;
    if (typeof v === 'string' && (v.length > (p.maxLength ?? 8000) || v.length < (p.minLength ?? 0))) return '文字長度超限：' + key;
    if (typeof v === 'number' && (!Number.isFinite(v) || v < (p.minimum ?? -Infinity) || v > (p.maximum ?? Infinity))) return '數值超出範圍：' + key;
    if (typeof v === 'number' && (p.exclusiveMinimum !== undefined && v <= p.exclusiveMinimum || p.exclusiveMaximum !== undefined && v >= p.exclusiveMaximum)) return '數值超出範圍：' + key;
    if (p.enum && !p.enum.includes(v)) return '不支援的值：' + key;
    if (Array.isArray(v) && v.length > (p.maxItems ?? 100)) return '項目過多：' + key;
    if (Array.isArray(v) && p.items) for (const item of v) { const error = validate(item, p.items, key); if (error) return error; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (Object.keys(v).length > (p.maxProperties ?? Infinity)) return '欄位過多：' + key;
      for (const required of p.required || []) if (!(required in v)) return '缺少欄位：' + required;
      for (const [name, item] of Object.entries(v)) {
        const rule = p.properties && Object.prototype.hasOwnProperty.call(p.properties, name) ? p.properties[name] : typeof p.additionalProperties === 'object' ? p.additionalProperties : null;
        if (!rule && p.additionalProperties === false) return '不支援欄位：' + name;
        if (rule) { const error = validate(item, rule, name); if (error) return error; }
      }
    }
    return null;
  }
  return validate(value, schema, 'input');
}
