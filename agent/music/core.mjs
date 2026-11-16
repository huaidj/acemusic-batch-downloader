import { createHash } from 'node:crypto';
import { DICTIONARY, CAPABILITIES } from './dictionary.mjs';

export const COMPILER_VERSION = '1.0.1';
const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => Array.isArray(value) ? value.map(stable) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const hashObject = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fail = (status, code, reason, details = {}) => ({ ok: false, status, code, reason, ...details });
const bad = (reason, details) => fail('invalid', 'INVALID_INPUT', reason, details);
const dictionaryVersions = new Map([[DICTIONARY.version, hashObject(DICTIONARY)]]);
const capabilityVersions = new Map([[CAPABILITIES.id, hashObject(CAPABILITIES)]]);
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

const plain = (value) => { const { hash, ...payload } = value; return clone(payload); };
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const utc = (value) => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value));
const privatePath = (value) => /(?:(?:^|[\s"'(])[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/|\/(?:Users|home|mnt|private)\/)/i.test(JSON.stringify(value));
function evidencePolicy(cards, ids) {
  if (!Array.isArray(cards) || cards.length > 256 || !Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some((id) => !text(id, 128))) return fail('policy_blocked', 'DICTIONARY_EVIDENCE_REQUIRED', '新詞條需要完整、已核對使用範圍的來源卡。');
  const byId = new Map();
  for (const card of cards) {
    if (!isObject(card) || !text(card.id, 128) || byId.has(card.id) || hasSecrets(card) || privatePath(card) || sourceIsSpotify(card)) return fail('policy_blocked', 'DICTIONARY_EVIDENCE_INVALID', '來源卡包含秘密、私人路徑、Spotify 或重複識別。');
    byId.set(card.id, card);
  }
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((card) => !card)) return fail('policy_blocked', 'DICTIONARY_EVIDENCE_REQUIRED', '來源卡未涵蓋所有證據識別。');
  for (const card of selected) {
    try {
      const url = new URL(card.source_url);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname)) throw new Error();
    } catch { return fail('policy_blocked', 'DICTIONARY_EVIDENCE_URL', '來源證據必須是公開 HTTPS 文字來源。'); }
    if (!text(card.source, 256) || !text(card.summary, 10000) || !Array.isArray(card.allowed_use) || !card.allowed_use.includes('reviewed_term_candidates')) return fail('policy_blocked', 'DICTIONARY_EVIDENCE_REQUIRED', '來源卡缺少來源、摘要或經審閱詞條候選的明確使用範圍。');
  }
  for (let offset = 0; offset < selected.length; offset += 20) { const policy = validateReferences(selected.slice(offset, offset + 20)); if (!policy.ok) return policy; }
  return { ok: true, cards: clone(selected) };
}
function validateDictionary(candidate) {
  if (!isObject(candidate) || hasSecrets(candidate) || privatePath(candidate)) return fail('policy_blocked', 'DICTIONARY_SENSITIVE_DATA', '詞典不能包含秘密或私人路徑。');
  if (!text(candidate.id, 128) || !text(candidate.version, 128) || candidate.source_policy_version !== DICTIONARY.source_policy_version || !Array.isArray(candidate.terms) || !candidate.terms.length || candidate.terms.length > 256) return bad('詞典需要識別、版本、已知來源政策與有限完整詞條。');
  const payload = plain(candidate);
  const hash = hashObject(payload);
  if (candidate.hash !== undefined && candidate.hash !== hash) return fail('invalid', 'DICTIONARY_HASH_MISMATCH', '詞典內容與固定 hash 不一致。');
  if (dictionaryVersions.has(candidate.version) && dictionaryVersions.get(candidate.version) !== hash) return fail('conflict', 'DICTIONARY_VERSION_CONFLICT', '相同詞典版本不能對應不同內容，請建立新版本。');
  const canonical = new Map(DICTIONARY.terms.map((term) => [term.term_id, term]));
  const ids = new Set();
  for (const term of payload.terms) {
    if (!isObject(term) || !['term_id', 'zh', 'en', 'dimension', 'definition', 'source_type', 'confidence'].every((key) => text(term[key], key === 'definition' ? 4000 : 512)) || sourceIsSpotify(term)) return fail('policy_blocked', 'DICTIONARY_TERM_INVALID', '詞條缺少完整文字欄位或包含不允許來源。');
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(term.term_id) || ids.has(term.term_id) || term.dictionary_version !== payload.version) return bad('詞條識別必須唯一，且每個詞條固定同一詞典版本。');
    ids.add(term.term_id);
    if (typeof term.base_weight !== 'number' || !Number.isFinite(term.base_weight) || term.base_weight < 0 || term.base_weight > 1 || typeof term.user_adjustment !== 'number' || !Number.isFinite(term.user_adjustment) || term.user_adjustment < -1 || term.user_adjustment > 1 || typeof term.hard_constraint !== 'boolean') return bad('詞條權重、調整值或硬約束類型無效。');
    for (const key of ['aliases', 'excludes', 'requires', 'evidence_refs']) if (!Array.isArray(term[key]) || term[key].length > 50 || term[key].some((value) => !text(value, 512)) || new Set(term[key]).size !== term[key].length) return bad('詞條 aliases、excludes、requires 與 evidence_refs 必須是有限且唯一的文字陣列。');
    if (!term.aliases.length || !term.evidence_refs.length || !isObject(term.model_mappings) || !Object.keys(term.model_mappings).length) return bad('詞條需要可識別別名、證據及明確模型映射。');
    for (const [model, mapping] of Object.entries(term.model_mappings)) if (!['acemusic-v1', 'acemusic-v1.1', 'ace-step-v1.5-xl'].includes(model) || !isObject(mapping) || !text(mapping.phrase, 4000) || !text(mapping.status, 128)) return bad('詞條模型映射需要已知模型、自然語言 phrase 與驗證狀態。');
    const original = canonical.get(term.term_id);
    const unchanged = original && hashObject({ ...term, dictionary_version: DICTIONARY.version }) === hashObject(original);
    if (!unchanged) {
      if (payload.reviewed_by !== 'user' || !utc(payload.reviewed_at) || payload.validation !== 'human_reviewed_research' || term.source_type !== 'reviewed_research') return fail('awaiting_review', 'DICTIONARY_REVIEW_REQUIRED', '新增或改寫詞條需要使用者審閱與來源證據，不能只宣告為預設詞條。');
      const policy = evidencePolicy(payload.evidence_cards, term.evidence_refs); if (!policy.ok) return policy;
    }
  }
  const termMap = new Map(payload.terms.map((term) => [term.term_id, term]));
  const dependencyState = new Map();
  const walk = (id) => {
    if (dependencyState.get(id) === 'visiting') return false;
    if (dependencyState.get(id) === 'complete') return true;
    dependencyState.set(id, 'visiting');
    if (!termMap.get(id).requires.every(walk)) return false;
    dependencyState.set(id, 'complete'); return true;
  };
  for (const term of payload.terms) {
    if ([...term.excludes, ...term.requires].some((id) => !ids.has(id) || id === term.term_id) || term.requires.some((id) => term.excludes.includes(id))) return bad('詞條依賴/排斥須指向其他現有詞條，不能自我引用或互相矛盾。');
    if (!walk(term.term_id)) return bad('詞條 requires 不能形成循環。');
  }
  return { ok: true, dictionary: { ...payload, hash } };
}
function validateCapabilities(candidate) {
  if (!isObject(candidate) || hasSecrets(candidate) || privatePath(candidate) || !text(candidate.id, 128) || !Array.isArray(candidate.models) || !candidate.models.length || candidate.models.length > 3) return bad('能力快照無效。');
  const payload = plain(candidate), hash = hashObject(payload), ids = new Set();
  if (candidate.hash !== undefined && candidate.hash !== hash) return fail('invalid', 'CAPABILITY_HASH_MISMATCH', '能力內容與 hash 不一致。');
  if (capabilityVersions.has(candidate.id) && capabilityVersions.get(candidate.id) !== hash) return fail('conflict', 'CAPABILITY_ID_CONFLICT', '相同能力識別不能指向不同內容。');
  for (const model of payload.models) {
    if (!isObject(model) || !['acemusic-v1', 'acemusic-v1.1', 'ace-step-v1.5-xl'].includes(model.id) || ids.has(model.id) || !Array.isArray(model.modes) || !model.modes.length || model.modes.some((mode) => !['idea', 'custom'].includes(mode))) return bad('能力快照只能包含已知且唯一的模型與模式。');
    ids.add(model.id);
  }
  return { ok: true, capabilities: { ...payload, hash } };
}

/** Trusted server code adds evidence cards read from its research store. */
export function mergeReviewedDictionary(baseSnapshot, researchSnapshot) {
  try {
    const base = validateDictionary(baseSnapshot); if (!base.ok) return base;
    if (!isObject(researchSnapshot) || researchSnapshot.status !== 'approved_candidate_not_installed' || researchSnapshot.reviewed_by !== 'user' || !utc(researchSnapshot.reviewed_at) || researchSnapshot.compiler_dictionary_changed !== false || researchSnapshot.long_term_taste_updated !== false || !Array.isArray(researchSnapshot.terms) || !researchSnapshot.terms.length || researchSnapshot.parent_version !== base.dictionary.version) return fail('awaiting_review', 'RESEARCH_SNAPSHOT_REVIEW_REQUIRED', '研究詞典必須已由使用者批准，且父版本與目前詞典一致。');
    if (hasSecrets(researchSnapshot) || privatePath(researchSnapshot) || sourceIsSpotify(researchSnapshot)) return fail('policy_blocked', 'RESEARCH_SNAPSHOT_POLICY', '研究快照含秘密、私人路徑或不允許來源。');
    const sourcePayload = Object.fromEntries(['parent_version', 'terms', 'evidence_ids', 'snapshot_ids', 'compiler_dictionary_changed', 'long_term_taste_updated', 'status'].map((key) => [key, researchSnapshot[key]]));
    if (researchSnapshot.hash !== hashObject(sourcePayload) || researchSnapshot.id !== `research_dictionary_${researchSnapshot.hash.slice(0, 24)}` || researchSnapshot.version !== `${researchSnapshot.parent_version}+research.${researchSnapshot.hash.slice(0, 12)}`) return fail('invalid', 'RESEARCH_SNAPSHOT_HASH', '研究快照識別、版本或 hash 不一致。');
    const permission = evidencePolicy(researchSnapshot.evidence, researchSnapshot.evidence_ids); if (!permission.ok) return permission;
    const version = researchSnapshot.version;
    const byId = new Map(base.dictionary.terms.map((term) => [term.term_id, { ...clone(term), dictionary_version: version }]));
    const seen = new Set();
    for (const incoming of researchSnapshot.terms) {
      if (!isObject(incoming) || !text(incoming.term_id, 128) || seen.has(incoming.term_id)) return bad('研究詞條識別需要唯一。');
      seen.add(incoming.term_id);
      const refs = incoming.evidence_refs || researchSnapshot.evidence_ids;
      if (refs.some((id) => !researchSnapshot.evidence_ids.includes(id))) return fail('policy_blocked', 'TERM_EVIDENCE_MISMATCH', '詞條引用了研究快照之外的證據。');
      const mappings = isObject(incoming.model_mappings) && Object.keys(incoming.model_mappings).length ? clone(incoming.model_mappings) : Object.fromEntries(['acemusic-v1', 'acemusic-v1.1', 'ace-step-v1.5-xl'].map((id) => [id, { phrase: incoming.en, status: 'draft_research_mapping' }]));
      byId.set(incoming.term_id, { ...clone(incoming), aliases: incoming.aliases || [...new Set([incoming.zh, incoming.en])], source_type: 'reviewed_research', confidence: 'human_reviewed_inference', evidence_refs: clone(refs), base_weight: incoming.base_weight ?? 0.5, user_adjustment: incoming.user_adjustment ?? 0, hard_constraint: incoming.hard_constraint ?? false, excludes: incoming.excludes || [], requires: incoming.requires || [], model_mappings: mappings, dictionary_version: version });
    }
    const priorCards = Array.isArray(base.dictionary.evidence_cards) ? base.dictionary.evidence_cards : [];
    const evidenceCards = [...new Map([...priorCards, ...permission.cards].map((card) => [card.id, card])).values()];
    const dictionary = { id: `huaidj_dictionary_${hashObject({ base_hash: base.dictionary.hash, research_hash: researchSnapshot.hash }).slice(0, 24)}`, version, source_policy_version: base.dictionary.source_policy_version, validation: 'human_reviewed_research', parent_version: base.dictionary.version, parent_hash: base.dictionary.hash, research_snapshot_id: researchSnapshot.id, source_snapshot_ids: clone(researchSnapshot.snapshot_ids), reviewed_by: 'user', reviewed_at: researchSnapshot.reviewed_at, evidence_cards: evidenceCards, terms: [...byId.values()] };
    const checked = validateDictionary(dictionary);
    return checked.ok ? { ok: true, status: 'merged', dictionary: checked.dictionary, research_snapshot_id: researchSnapshot.id, compiler_dictionary_changed: false } : checked;
  } catch { return bad('無法驗證研究詞典快照。'); }
}

/** The only compiler implementation. HTTP inputs never choose raw snapshots. */
export function createPromptCompiler({ dictionary = DICTIONARY, capabilities = CAPABILITIES } = {}) {
  let dictionaryCheck, capabilityCheck;
  try { dictionaryCheck = validateDictionary(dictionary); capabilityCheck = validateCapabilities(capabilities); }
  catch { return bad('詞典或能力快照不是有效的 JSON。'); }
  if (!dictionaryCheck.ok) return dictionaryCheck;
  if (!capabilityCheck.ok) return capabilityCheck;
  const snapshot = dictionaryCheck.dictionary;
  const capabilitySnapshot = capabilityCheck.capabilities;
  dictionaryVersions.set(snapshot.version, snapshot.hash);
  capabilityVersions.set(capabilitySnapshot.id, capabilitySnapshot.hash);
  const termById = new Map(snapshot.terms.map((term) => [term.term_id, term]));

function getCapabilities() {
  return { ok: true, status: 'documented', dictionary_snapshot_id: snapshot.id, dictionary_version: snapshot.version, dictionary_hash: snapshot.hash, capability_snapshot: clone(capabilitySnapshot), capabilities: clone(capabilitySnapshot) };
}
function dictionaryQuery(input = {}) {
  if (!isObject(input)) return bad('查詢必須是物件。');
  if (input.version && input.version !== snapshot.version) return fail('unsupported', 'DICTIONARY_VERSION', '找不到指定詞典版本。');
  if (input.query !== undefined && typeof input.query !== 'string') return bad('query 必須是文字。');
  if (input.dimension !== undefined && typeof input.dimension !== 'string') return bad('dimension 必須是文字。');
  const query = (input.query || '').toLowerCase();
  const terms = snapshot.terms.filter((term) => (!input.dimension || term.dimension === input.dimension) &&
    (!query || `${term.term_id} ${term.zh} ${term.en} ${term.aliases.join(' ')}`.toLowerCase().includes(query)));
  return { ok: true, status: 'ready', dictionary_snapshot_id: snapshot.id, dictionary_version: snapshot.version, dictionary_hash: snapshot.hash, dictionary: clone(snapshot), terms: clone(terms) };
}

function inputCheck(input) {
  if (!isObject(input)) return bad('輸入必須是物件。');
  if (['dictionary', 'dictionary_snapshot', 'capabilities', 'capability_snapshot'].some((key) => Object.prototype.hasOwnProperty.call(input, key))) return bad('原始詞典與能力快照只能由伺服器載入，不能作為編譯請求欄位。');
  if (typeof input.natural_language !== 'string' || !input.natural_language.trim() || input.natural_language.length > 4000) return bad('請輸入 1–4000 字的音樂方向。');
  if (input.scope !== undefined && !['session', 'project', 'long_term_taste'].includes(input.scope)) return bad('scope 必須是 session、project 或 long_term_taste。');
  if (hasSecrets(input)) return fail('policy_blocked', 'SENSITIVE_DATA', '請先移除憑據、帶帳密的 URL 或工作階段資料。');
  if (/https?:\/\/(?:[\w-]+\.)?spotify\.com|spotify:/i.test(input.natural_language)) return fail('policy_blocked', 'SPOTIFY_INPUT', 'Spotify 引用需隔離保存，不能進入 AI 文字。');
  for (const key of ['locked_term_ids', 'hard_constraints', 'parent_ids']) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 30 || input[key].some((value) => typeof value !== 'string' || value.length > 1000))) return bad(`${key} 必須是文字陣列。`);
  }
  if (input.weights !== undefined && (!isObject(input.weights) || Object.entries(input.weights).some(([key, value]) => !termById.has(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))) return bad('詞條權重必須是已知詞條的 0–1 數值。');
  if (input.dictionary_version && input.dictionary_version !== snapshot.version) return fail('unsupported', 'DICTIONARY_VERSION', '歷史詞典版本不可被目前版本靜默取代。');
  if (input.dictionary_hash && input.dictionary_hash !== snapshot.hash || input.dictionary_snapshot_id && input.dictionary_snapshot_id !== snapshot.id) return fail('unsupported', 'DICTIONARY_SNAPSHOT_MISMATCH', '要求的詞典 hash/識別與此編譯器不符。');
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

function prepareIntent(input = {}) {
  const check = inputCheck(input);
  if (!check.ok) return check;
  const mapped = matchLanguage(input.natural_language);
  const intent = {
    scope: input.scope || 'session', natural_language: input.natural_language.trim(),
    dictionary_snapshot_id: snapshot.id, dictionary_version: snapshot.version, dictionary_hash: snapshot.hash,
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

function compilePrompt(input = {}) {
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
  if (!Number.isInteger(maxChanges) || maxChanges < 0 || maxChanges > Math.max(6, new Set(snapshot.terms.map((term) => term.dimension)).size)) return bad('max_changed_dimensions 必須是非負整數，且不超過詞典可用維度上限。');
  if (input.previous_term_ids !== undefined && (!Array.isArray(input.previous_term_ids) || input.previous_term_ids.some((id) => !termById.has(id)))) return bad('previous_term_ids 必須是已知詞條陣列。');
  const prepared = prepareIntent(input);
  const intent = prepared.intent;
  const constraintMappings = (input.hard_constraints || []).filter((value) => !termById.has(value)).map(matchLanguage);
  const requestedLocks = [...new Set([...(input.locked_term_ids || []), ...snapshot.terms.filter((term) => term.hard_constraint).map((term) => term.term_id), ...(input.hard_constraints || []).filter((value) => termById.has(value)), ...constraintMappings.flatMap((entry) => entry.matched_term_ids)])];
  const unknownLocks = requestedLocks.filter((id) => !termById.has(id));
  if (unknownLocks.length) return bad('找不到部分鎖定詞條。', { unknown_term_ids: unknownLocks });
  const locked = requestedLocks.map((id) => termById.get(id));
  const explicit = intent.matched_term_ids.map((id) => termById.get(id));
  const dependencyGroup = (term) => { const group = new Map(); const visit = (item) => { if (group.has(item.term_id)) return; group.set(item.term_id, item); item.requires.forEach((id) => visit(termById.get(id))); }; visit(term); return [...group.values()]; };
  const required = [...new Map([...locked, ...explicit].flatMap(dependencyGroup).map((term) => [term.term_id, term])).values()];
  const missingMappings = required.filter((term) => !term.model_mappings[model]);
  if (missingMappings.length) return fail('unsupported', 'TERM_MODEL_MAPPING', '明確或鎖定詞條尚無此模型映射，請重選模型或審閱映射；未丟棄詞條。', { model, term_ids: missingMappings.map((term) => term.term_id) });
  const forbiddenTerms = [...new Set([...intent.excluded_term_ids, ...constraintMappings.flatMap((entry) => entry.excluded_term_ids)])];
  if (required.some((term) => forbiddenTerms.includes(term.term_id))) return fail('conflict', 'NEGATED_TERM_CONFLICT', '明確要求同時包含與排除相同詞條。', { excluded_term_ids: forbiddenTerms });
  for (const term of required) {
    const other = required.find((candidate) => candidate !== term && conflict(term, candidate));
    if (other) return fail('conflict', 'TERM_CONFLICT', '明確要求或鎖定項互相衝突。', { conflicts: [{ term_id: term.term_id, excludes: other.term_id }], locked_term_ids: requestedLocks });
  }
  if (input.lyrics && required.some((term) => term.term_id === 'voice.instrumental')) return fail('conflict', 'LYRICS_INSTRUMENTAL_CONFLICT', '無人聲要求與非空歌詞衝突。');
  const weights = Object.fromEntries(snapshot.terms.map((term) => [term.term_id, input.weights?.[term.term_id] ?? Math.max(0, Math.min(1, term.base_weight + term.user_adjustment))]));
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
      if (previousDimension.length && previousDimension.map((term) => term.term_id).sort().join('|') !== already.map((term) => term.term_id).sort().join('|')) {
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
      const group = dependencyGroup(term);
      if (group.some((item) => forbiddenTerms.includes(item.term_id) || !item.model_mappings[model] || selected.some((other) => conflict(item, other)) || group.some((other) => other !== item && conflict(item, other)))) { exclusions.push({ term_id: term.term_id, reason: 'requires_conflict_or_mapping_unavailable' }); return false; }
      return true;
    });
    let picked = null;
    if (previousDimension.length && changedDimensions >= maxChanges) {
      picked = previousDimension.find((term) => candidates.some((candidate) => candidate.term_id === term.term_id));
      if (!picked) return fail('conflict', 'CHANGE_LIMIT_CONFLICT', '保留上一代會違反目前限制，請明確調整變動上限。');
    } else picked = weightedPick(candidates, weights, random);
    if (picked) {
      for (const term of dependencyGroup(picked)) if (!selected.some((item) => item.term_id === term.term_id)) selected.push(term);
      if (previousDimension.length && !previousDimension.some((term) => term.term_id === picked.term_id)) {
        changedDimensions += 1;
        changes.push({ dimension, from: previousDimension.map((term) => term.term_id), to: [picked.term_id], reason: 'seeded_exploration' });
      }
    }
  }
  const changed = dimensions.filter((dimension) => {
    const before = previous.filter((term) => term.dimension === dimension).map((term) => term.term_id).sort();
    return before.length && before.join('|') !== selected.filter((term) => term.dimension === dimension).map((term) => term.term_id).sort().join('|');
  });
  if (changed.length > maxChanges) return fail('conflict', 'CHANGE_LIMIT_EXCEEDED', '明確要求或依賴超過本代可變更維度上限，請審閱後提高上限。', { changes, changed_dimensions: changed });
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
  // Observed Create defaults and authenticated /api/status on 2026-11-16.
  // The execution adapter still re-reads live limits; previews must not claim a
  // usable plan for fields already over the known model limit.
  const textLimits = model === 'ace-step-v1.5-xl' ? { prompt: 2000, style: 512, lyrics: 2000 } : { prompt: 2000, style: 1000, lyrics: 5000 };
  for (const [field, value] of Object.entries(promptFields)) {
    const characters = [...value].length;
    if (characters > textLimits[field]) return fail('unsupported', 'TEXT_LIMIT', '編譯後文字超過此模型欄位上限，請縮短方向或減少詞條；未截斷或提交。', { field, characters, limit: textLimits[field], prompt_fields: promptFields });
  }
  const versions = {
    dictionary_snapshot_id: snapshot.id, dictionary_version: snapshot.version, dictionary_hash: snapshot.hash,
    taste_snapshot_id: 'project-plan-v1-initial', taste_snapshot_hash: hashObject({ source: 'project-plan-v1', status: 'initialization_only' }),
    compiler_version: COMPILER_VERSION, capability_snapshot_id: capabilitySnapshot.id, capability_snapshot_hash: capabilitySnapshot.hash,
  };
  const plan = {
    intent_id: intent.id, requested_model: model, remote_model_id: info.remote_model_id || model, actual_model: null, mode, workflow: 'text',
    dictionary_snapshot_id: versions.dictionary_snapshot_id, dictionary_version: versions.dictionary_version, taste_snapshot_id: versions.taste_snapshot_id,
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

function prepareGeneration(input = {}) {
  if (!isObject(input) || !isObject(input.plan)) return bad('請先提供已編譯的 PromptPlan。');
  if (hasSecrets(input)) return fail('policy_blocked', 'SENSITIVE_DATA', '生成準備資料包含憑據或帶帳密的 URL。');
  const plan = input.plan;
  const { hash, id, ...payload } = plan;
  if (hash !== hashObject(payload) || id !== `plan_${hash?.slice(0, 20)}`) return bad('計畫內容與 hash 不一致，請重新編譯。');
  if (plan.versions?.dictionary_hash !== snapshot.hash || plan.dictionary_version !== snapshot.version || plan.versions?.dictionary_version !== snapshot.version || plan.versions?.dictionary_snapshot_id && plan.versions.dictionary_snapshot_id !== snapshot.id || plan.versions?.capability_snapshot_hash !== capabilitySnapshot.hash || plan.compiler_version !== COMPILER_VERSION) return fail('unsupported', 'SNAPSHOT_UNAVAILABLE', '找不到此計畫需要的固定版本。');
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

  return { ok: true, dictionary_snapshot_id: snapshot.id, dictionary_hash: snapshot.hash, getCapabilities, dictionaryQuery, prepareIntent, compilePrompt, prepareGeneration };
}

const defaultCompiler = createPromptCompiler();
export const getCapabilities = defaultCompiler.getCapabilities;
export const dictionaryQuery = defaultCompiler.dictionaryQuery;
export const prepareIntent = defaultCompiler.prepareIntent;
export const compilePrompt = defaultCompiler.compilePrompt;
export const prepareGeneration = defaultCompiler.prepareGeneration;
