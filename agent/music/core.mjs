import { createHash } from 'node:crypto';
import { DICTIONARY, CAPABILITIES } from './dictionary.mjs';

export const COMPILER_VERSION = '1.0.0';
const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => Array.isArray(value) ? value.map(stable) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const hashObject = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fail = (status, code, reason, details = {}) => ({ ok: false, status, code, reason, ...details });
const bad = (reason, details) => fail('invalid', 'INVALID_INPUT', reason, details);
const snapshot = { ...DICTIONARY, hash: hashObject(DICTIONARY) };
const capabilitySnapshot = { ...CAPABILITIES, hash: hashObject(CAPABILITIES) };
const termById = new Map(snapshot.terms.map((term) => [term.term_id, term]));
const aliases = new Map([
  ['ace-step-1.5-xl', 'ace-step-v1.5-xl'], ['ace-step-v1.5-xl', 'ace-step-v1.5-xl'],
  ['ace-step v1.5 xl', 'ace-step-v1.5-xl'], ['acemusic-v1.1-preview', 'acemusic-v1.1'],
  ['ace music v1.1 preview', 'acemusic-v1.1'], ['ace music v1', 'acemusic-v1'],
]);
export function normalizeModel(value = 'acemusic-v1.1') {
  return typeof value === 'string' ? aliases.get(value.toLowerCase()) || value.toLowerCase() : '';
}
function hasSecrets(value) {
  let content;
  try { content = typeof value === 'string' ? value : JSON.stringify(value); } catch { return true; }
  return /\b(?:Bearer\s+\S+|sk-(?:proj-|ant-|[A-Za-z0-9])[A-Za-z0-9_-]{12,}|(?:api[_-]?key|cookie|session|token)\s*[:=]\s*[^\s,;]{8,})/i.test(content || '') ||
    /https?:\/\/[^\s/]*@/i.test(content || '');
}
function sourceIsSpotify(reference) {
  // Provenance is checked before creating any AI request fields. This also
  // catches derived_from/original_source wrappers and copied metadata.
  return /spotify/i.test(JSON.stringify(reference));
}
const RIGHTS = new Set(['owned', 'user_owned', 'licensed', 'public_domain', 'generated', 'generated_owned', 'authorized']);
export function validateReferences(references = []) {
  if (!Array.isArray(references) || references.length > 20) return bad('參考必須是最多 20 筆的陣列。');
  const rejected = [];
  const accepted = [];
  const navigation = [];
  references.forEach((reference, index) => {
    if (!isObject(reference)) { rejected.push({ index, reason: 'invalid_reference' }); return; }
    const id = typeof reference.id === 'string' ? reference.id : `reference_${index + 1}`;
    if (hasSecrets(reference)) { rejected.push({ id, reason: 'sensitive_data' }); return; }
    if (sourceIsSpotify(reference)) {
      rejected.push({ id, reason: 'spotify_ai_ingestion_prohibited' });
      navigation.push({ id, kind: 'spotify_reference', user_input: reference.user_input || reference.url || null, ai_ingestion_allowed: false });
      return;
    }
    if (reference.ai_ingestion_allowed !== true || !RIGHTS.has(reference.rights_status)) {
      rejected.push({ id, reason: 'ai_permission_or_rights_unknown' }); return;
    }
    // Audio files are not uploaded by this compiler. Only a separately supplied
    // description can be included in text, with the same provenance checks.
    accepted.push({ ...clone(reference), id });
  });
  if (rejected.length) return fail('policy_blocked', 'REFERENCE_POLICY', '參考尚未符合 AI 使用來源與權利條件。', { rejected, navigation_references: navigation });
  return { ok: true, status: 'validated', references: accepted, navigation_references: navigation };
}

export function getCapabilities() {
  return { ok: true, status: 'documented', capability_snapshot: clone(capabilitySnapshot), capabilities: clone(capabilitySnapshot) };
}
export function dictionaryQuery(input = {}) {
  if (!isObject(input)) return bad('查詢必須是物件。');
  if (input.version && input.version !== snapshot.version) return fail('unsupported', 'DICTIONARY_VERSION', '找不到指定詞典版本。');
  if (input.query !== undefined && typeof input.query !== 'string') return bad('query 必須是文字。');
  if (input.dimension !== undefined && typeof input.dimension !== 'string') return bad('dimension 必須是文字。');
  const query = (input.query || '').toLowerCase();
  const terms = snapshot.terms.filter((term) => (!input.dimension || term.dimension === input.dimension) &&
    (!query || `${term.term_id} ${term.zh} ${term.en} ${term.aliases.join(' ')}`.toLowerCase().includes(query)));
  return { ok: true, status: 'ready', dictionary_version: snapshot.version, dictionary_hash: snapshot.hash, dictionary: clone(snapshot), terms: clone(terms) };
}

function inputCheck(input) {
  if (!isObject(input)) return bad('輸入必須是物件。');
  if (typeof input.natural_language !== 'string' || !input.natural_language.trim() || input.natural_language.length > 4000) return bad('請輸入 1–4000 字的音樂方向。');
  if (input.scope !== undefined && !['session', 'project', 'long_term_taste'].includes(input.scope)) return bad('scope 必須是 session、project 或 long_term_taste。');
  if (hasSecrets(input)) return fail('policy_blocked', 'SENSITIVE_DATA', '請先移除憑據、帶帳密的 URL 或工作階段資料。');
  if (/https?:\/\/(?:[\w-]+\.)?spotify\.com|spotify:/i.test(input.natural_language)) return fail('policy_blocked', 'SPOTIFY_INPUT', 'Spotify 引用需隔離保存，不能進入 AI 文字。');
  for (const key of ['locked_term_ids', 'hard_constraints', 'parent_ids']) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 30 || input[key].some((value) => typeof value !== 'string' || value.length > 1000))) return bad(`${key} 必須是文字陣列。`);
  }
  if (input.weights !== undefined && (!isObject(input.weights) || Object.entries(input.weights).some(([key, value]) => !termById.has(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))) return bad('詞條權重必須是已知詞條的 0–1 數值。');
  if (input.dictionary_version && input.dictionary_version !== snapshot.version) return fail('unsupported', 'DICTIONARY_VERSION', '歷史詞典版本不可被目前版本靜默取代。');
  const policy = validateReferences(input.references === undefined ? [] : input.references);
  if (!policy.ok) return policy;
  return { ok: true, references: policy.references };
}

function matchLanguage(text) {
  const found = new Set();
  const excluded = new Set();
  let remaining = text;
  const entries = snapshot.terms.flatMap((term) => term.aliases.map((alias) => ({ term, alias }))).sort((a, b) => b.alias.length - a.alias.length);
  for (const { term, alias } of entries) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /[A-Za-z]/.test(alias) ? `(?<![A-Za-z])${escaped}(?![A-Za-z])` : escaped;
    remaining = remaining.replace(new RegExp(pattern, 'gi'), (matched, offset, whole) => {
      if (!/^(?:no |without )/i.test(alias) && /\b(?:no|not|without)\s+(?:any\s+)?$/i.test(whole.slice(Math.max(0, offset - 16), offset))) {
        excluded.add(term.term_id);
        return matched; // Keep the explicit negative request in the submitted text.
      }
      found.add(term.term_id);
      return ' ';
    });
  }
  // Only grammatical connectors are ignored, never unknown musical details.
  const untranslated = remaining.replace(/[我要想請请給给以用有把讓让帶带一點点些和與与及的並并且但不更而是能夠够保持加上音樂乐方向風风格聲声響响聽听感]+/g, '').match(/[\u3400-\u9fff]+/g) || [];
  const english = remaining.replace(/[\u3400-\u9fff]/g, ' ').replace(/[,，、。；;：:\s]+/g, ' ').trim();
  return { matched_term_ids: [...found], excluded_term_ids: [...excluded], untranslated: [...new Set(untranslated)], english_remainder: english };
}

export function prepareIntent(input = {}) {
  const check = inputCheck(input);
  if (!check.ok) return check;
  const mapped = matchLanguage(input.natural_language);
  const intent = {
    scope: input.scope || 'session', natural_language: input.natural_language.trim(),
    hard_constraints: clone(input.hard_constraints || []), parent_refs: clone(input.parent_ids || []),
    matched_term_ids: mapped.matched_term_ids, excluded_term_ids: mapped.excluded_term_ids, translation_required: mapped.untranslated.length > 0,
    untranslated_fragments: mapped.untranslated, references: check.references,
  };
  intent.id = `intent_${hashObject(intent).slice(0, 20)}`;
  return { ok: true, status: intent.translation_required ? 'translation_required' : 'validated', intent, references: check.references };
}

function rngFromSeed(seed) {
  let state = parseInt(hashObject(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function weightedPick(terms, weights, random) {
  const pool = terms.filter((term) => (weights[term.term_id] ?? term.base_weight) > 0);
  const total = pool.reduce((sum, term) => sum + (weights[term.term_id] ?? term.base_weight), 0);
  let cursor = random() * total;
  for (const term of pool) {
    cursor -= weights[term.term_id] ?? term.base_weight;
    if (cursor < 0) return term;
  }
  return pool.at(-1) || null;
}
function conflict(left, right) {
  return left.excludes.includes(right.term_id) || right.excludes.includes(left.term_id);
}

export function compilePrompt(input = {}) {
  const checked = inputCheck(input);
  if (!checked.ok) return checked;
  const model = normalizeModel(input.model);
  const info = capabilitySnapshot.models.find((entry) => entry.id === model);
  if (!info) return fail('unsupported', 'UNKNOWN_MODEL', '目前能力快照沒有此模型。');
  const mode = input.mode || 'idea';
  if (!info.modes.includes(mode)) return fail('unsupported', 'UNSUPPORTED_MODE', '僅支援 Idea 與 Custom。');
  if (input.workflow !== undefined && input.workflow !== 'text') return fail('unsupported', 'WORKFLOW_UNVERIFIED', '此離線編譯器目前只支援文字工作流；參考音訊、Cover、Edit 與 Mashup 仍需實測。');
  if (input.actual_model !== undefined && normalizeModel(input.actual_model) !== model) return fail('needs_recompile', 'MODEL_CHANGED', '實際模型已改變，請以實際模型重新編譯與審閱。', { requested_model: model, actual_model: normalizeModel(input.actual_model), changes: [{ field: 'model', from: model, to: normalizeModel(input.actual_model) }] });
  if (input.advanced !== undefined && (!isObject(input.advanced) || Object.keys(input.advanced).length > 0)) return fail('unsupported', 'UNVERIFIED_CONTROL', 'Advanced 控件尚未核對目前帳戶，暫不輸出。');
  if (input.lyrics !== undefined && (typeof input.lyrics !== 'string' || input.lyrics.length > 5000 || mode !== 'custom')) return bad('Lyrics 只能是 Custom 模式的文字。');
  if (input.seed !== undefined && !(['string', 'number'].includes(typeof input.seed)) || typeof input.seed === 'number' && !Number.isFinite(input.seed)) return bad('seed 必須是有限數字或文字。');
  const maxChanges = input.max_changed_dimensions ?? 2;
  if (!Number.isInteger(maxChanges) || maxChanges < 0 || maxChanges > 6) return bad('max_changed_dimensions 必須是 0–6 整數。');
  if (input.previous_term_ids !== undefined && (!Array.isArray(input.previous_term_ids) || input.previous_term_ids.some((id) => !termById.has(id)))) return bad('previous_term_ids 必須是已知詞條陣列。');
  const prepared = prepareIntent(input);
  const intent = prepared.intent;
  const constraintMappings = (input.hard_constraints || []).filter((value) => !termById.has(value)).map(matchLanguage);
  const requestedLocks = [...new Set([...(input.locked_term_ids || []), ...(input.hard_constraints || []).filter((value) => termById.has(value)), ...constraintMappings.flatMap((entry) => entry.matched_term_ids)])];
  const unknownLocks = requestedLocks.filter((id) => !termById.has(id));
  if (unknownLocks.length) return bad('找不到部分鎖定詞條。', { unknown_term_ids: unknownLocks });
  const locked = requestedLocks.map((id) => termById.get(id));
  const explicit = intent.matched_term_ids.map((id) => termById.get(id));
  const required = [...new Map([...locked, ...explicit].map((term) => [term.term_id, term])).values()];
  const forbiddenTerms = [...new Set([...intent.excluded_term_ids, ...constraintMappings.flatMap((entry) => entry.excluded_term_ids)])];
  if (required.some((term) => forbiddenTerms.includes(term.term_id))) return fail('conflict', 'NEGATED_TERM_CONFLICT', '明確要求同時包含與排除相同詞條。', { excluded_term_ids: forbiddenTerms });
  for (const term of required) {
    const other = required.find((candidate) => candidate !== term && conflict(term, candidate));
    if (other) return fail('conflict', 'TERM_CONFLICT', '明確要求或鎖定項互相衝突。', { conflicts: [{ term_id: term.term_id, excludes: other.term_id }], locked_term_ids: requestedLocks });
  }
  if (input.lyrics && required.some((term) => term.term_id === 'voice.instrumental')) return fail('conflict', 'LYRICS_INSTRUMENTAL_CONFLICT', '無人聲要求與非空歌詞衝突。');
  const weights = input.weights || {};
  const seed = input.seed ?? 0;
  const random = rngFromSeed(seed);
  const selected = [...required];
  const exclusions = [];
  const changes = [];
  const previous = (input.previous_term_ids || []).map((id) => termById.get(id));
  const dimensions = [...new Set(snapshot.terms.map((term) => term.dimension))];
  let changedDimensions = 0;
  for (const dimension of dimensions) {
    const already = selected.filter((term) => term.dimension === dimension);
    const previousDimension = previous.filter((term) => term.dimension === dimension);
    if (already.length) {
      if (previousDimension.length && previousDimension.map((term) => term.term_id).join('|') !== already.map((term) => term.term_id).join('|')) {
        changedDimensions += 1;
        changes.push({ dimension, from: previousDimension.map((term) => term.term_id), to: already.map((term) => term.term_id), reason: 'explicit_or_locked' });
      }
      continue;
    }
    const candidates = snapshot.terms.filter((term) => term.dimension === dimension).filter((term) => {
      const blockedBy = selected.find((other) => conflict(term, other));
      if (forbiddenTerms.includes(term.term_id)) { exclusions.push({ term_id: term.term_id, reason: 'explicitly_excluded' }); return false; }
      if (blockedBy) { exclusions.push({ term_id: term.term_id, reason: 'conflict', with: blockedBy.term_id }); return false; }
      if ((weights[term.term_id] ?? term.base_weight) <= 0) { exclusions.push({ term_id: term.term_id, reason: 'zero_weight' }); return false; }
      if (!term.model_mappings[model]) { exclusions.push({ term_id: term.term_id, reason: 'model_mapping_unavailable' }); return false; }
      return true;
    });
    let picked = null;
    if (previousDimension.length && changedDimensions >= maxChanges) {
      picked = previousDimension.find((term) => candidates.some((candidate) => candidate.term_id === term.term_id));
      if (!picked) return fail('conflict', 'CHANGE_LIMIT_CONFLICT', '保留上一代會違反目前限制，請明確調整變動上限。');
    } else picked = weightedPick(candidates, weights, random);
    if (picked) {
      selected.push(picked);
      if (previousDimension.length && !previousDimension.some((term) => term.term_id === picked.term_id)) {
        changedDimensions += 1;
        changes.push({ dimension, from: previousDimension.map((term) => term.term_id), to: [picked.term_id], reason: 'seeded_exploration' });
      }
    }
  }
  if (changedDimensions > maxChanges) return fail('conflict', 'CHANGE_LIMIT_EXCEEDED', '明確要求超過本代可變更維度上限，請審閱後提高上限。', { changes });
  const mapped = matchLanguage(input.natural_language);
  const phrases = selected.map((term) => term.model_mappings[model].phrase);
  const rawConstraints = (input.hard_constraints || []).filter((value) => !termById.has(value));
  const extraConstraints = rawConstraints.map((value, index) => {
    const mapping = constraintMappings[index];
    if (mapping.untranslated.length) return value;
    return [...mapping.matched_term_ids.map((termId) => termById.get(termId).model_mappings[model].phrase), mapping.english_remainder].filter(Boolean).join('. ') || value;
  });
  let text = phrases.join('. ') + '.';
  if (mapped.english_remainder) text += ` User direction: ${mapped.english_remainder}.`;
  if (intent.translation_required) text += ` Original direction requiring translation review: ${intent.natural_language}.`;
  if (extraConstraints.length) text += ` Required constraints: ${extraConstraints.join('; ')}.`;
  const referenceDescriptions = checked.references.map((reference) => typeof reference.description === 'string' ? reference.description : '').filter(Boolean);
  if (referenceDescriptions.length) text += ` User-authorized reference descriptions: ${referenceDescriptions.join('; ')}.`;
  // Chinese constraints/lyrics/reference descriptions are retained but cannot be
  // described as translated. No hidden LLM or network call fills this gap.
  const translationRequired = intent.translation_required || constraintMappings.some((entry) => entry.untranslated.length > 0) || /[\u3400-\u9fff]/.test(referenceDescriptions.join(' '));
  const promptFields = mode === 'idea' ? { prompt: text } : { style: text, lyrics: input.lyrics || '' };
  const versions = {
    dictionary_version: snapshot.version, dictionary_hash: snapshot.hash,
    taste_snapshot_id: 'project-plan-v1-initial', taste_snapshot_hash: hashObject({ source: 'project-plan-v1', status: 'initialization_only' }),
    compiler_version: COMPILER_VERSION, capability_snapshot_id: capabilitySnapshot.id, capability_snapshot_hash: capabilitySnapshot.hash,
  };
  const plan = {
    intent_id: intent.id, requested_model: model, remote_model_id: info.remote_model_id || model, actual_model: null, mode, workflow: 'text',
    dictionary_version: versions.dictionary_version, taste_snapshot_id: versions.taste_snapshot_id,
    compiler_version: COMPILER_VERSION, capability_snapshot_id: capabilitySnapshot.id, versions,
    prompt_fields: promptFields, advanced: {}, references: checked.references, parent_ids: input.parent_ids || [],
    locked_term_ids: requestedLocks, hard_constraints: input.hard_constraints || [],
    selected_terms: selected.map((term) => ({ term_id: term.term_id, zh: term.zh, en: term.model_mappings[model].phrase, dimension: term.dimension, locked: requestedLocks.includes(term.term_id), weight: weights[term.term_id] ?? term.base_weight })),
    candidate_pool: snapshot.terms.map((term) => term.term_id), exclusions, changes,
    seeds: { reference: input.reference_seed ?? seed, terms: seed, mode_model: input.model_seed ?? seed, generation: null },
    max_changed_dimensions: maxChanges, translation_required: translationRequired,
    original_intent: intent.natural_language, untranslated_fragments: intent.untranslated_fragments,
    estimated_cost: { ace_credits: null, currency: null, amount: null, reason: 'current_account_cost_not_verified' },
    validation: { offline_draft: true, ui_verified: false, generation_verified: false, human_reviewed: false },
  };
  plan.hash = hashObject(plan);
  plan.id = `plan_${plan.hash.slice(0, 20)}`;
  return { ok: true, status: translationRequired ? 'translation_required' : 'validated', plan: clone(plan), preview: {
    explanation_zh: '已將已知詞條編成模型欄位；數字權重僅控制內部抽樣。請核對原意、未翻譯內容與目前模型。',
    original_intent: intent.natural_language, model, mode, prompt_fields: clone(promptFields), advanced: {},
    selected_terms: clone(plan.selected_terms), changes: clone(changes), translation_required: translationRequired,
    limitations: ['詞典為離線草案，尚未經真實生成驗證。', '空間與相位用詞只描述目標聽感。', '無人聲要求仍須以實際產物試聽確認。'],
  } };
}

export function prepareGeneration(input = {}) {
  if (!isObject(input) || !isObject(input.plan)) return bad('請先提供已編譯的 PromptPlan。');
  if (hasSecrets(input)) return fail('policy_blocked', 'SENSITIVE_DATA', '生成準備資料包含憑據或帶帳密的 URL。');
  const plan = input.plan;
  const { hash, id, ...payload } = plan;
  if (hash !== hashObject(payload) || id !== `plan_${hash?.slice(0, 20)}`) return bad('計畫內容與 hash 不一致，請重新編譯。');
  if (plan.versions?.dictionary_hash !== snapshot.hash || plan.versions?.capability_snapshot_hash !== capabilitySnapshot.hash || plan.compiler_version !== COMPILER_VERSION) return fail('unsupported', 'SNAPSHOT_UNAVAILABLE', '找不到此計畫需要的固定版本。');
  const info = capabilitySnapshot.models.find((entry) => entry.id === plan.requested_model);
  if (!info || !info.modes.includes(plan.mode) || plan.workflow !== 'text' || !isObject(plan.advanced) || Object.keys(plan.advanced).length || !isObject(plan.prompt_fields)) return fail('unsupported', 'INVALID_PLAN_CAPABILITY', '計畫模型、模式或控件不在已編譯能力範圍。');
  const policy = validateReferences(plan.references);
  if (!policy.ok) return policy;
  if (plan.translation_required) return fail('translation_required', 'TRANSLATION_REVIEW_REQUIRED', '請先完成未翻譯方向的審閱與重新編譯。');
  if (input.actual_model !== undefined && normalizeModel(input.actual_model) !== plan.requested_model) return fail('needs_recompile', 'MODEL_CHANGED', '提交前實際模型變動，必須重新編譯。');
  if (input.reviewed !== true) return fail('awaiting_review', 'HUMAN_REVIEW_REQUIRED', '請先審閱這份計畫的實際文字與模型。', { plan_id: plan.id });
  const session = input.session;
  if (!isObject(session) || !Number.isInteger(session.max_generations) || session.max_generations < 1 || session.max_generations > 100 || !Number.isInteger(session.max_depth) || session.max_depth < 0 || session.max_depth > 100 || !isObject(session.budget_limits) || !Number.isFinite(session.budget_limits.ace_credits) || session.budget_limits.ace_credits < 0) return fail('budget_blocked', 'SESSION_LIMITS_REQUIRED', '請設定有限任務數、代數與 ACE credit 上限。');
  if (session.stopped === true) return fail('cancelled', 'SESSION_STOPPED', '此會話已停止新增提交。');
  if (input.adapter !== undefined && !['ace_official', 'ace_browser'].includes(input.adapter)) return fail('unsupported', 'ADAPTER_UNSUPPORTED', '此 adapter 不能提交真實生成。');
  return { ok: true, status: 'awaiting_authorization', job: {
    id: `generation_${hashObject({ plan_id: plan.id, session_id: session.id || null, idempotency_key: input.idempotency_key || null }).slice(0, 20)}`,
    plan_id: plan.id, status: 'awaiting_authorization', requested_model: plan.requested_model,
    actual_model: null, adapter: input.adapter || 'ace_official', remote_task_id: null,
    idempotency_key: input.idempotency_key || null, budget_reservation: null, versions: clone(plan.versions),
    real_success: false,
  }, authorization_requirements: ['已授權且接通的 ACE adapter', '核對目前帳戶實際模型與 credit 成本', '明確單輪與全會話預算及是否自動繼續', '如有音訊參考，需另行核對素材上傳授權'], submission_enabled: false };
}
