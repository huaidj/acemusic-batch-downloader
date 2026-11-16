// DeepSeek's raw Search/Fetch JSON APIs. The Hub owns this writer and passes
// credentials only through server configuration. Nothing reads process.env.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hashObject, validateReferences } from '../music/core.mjs';

const OBJECT = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = (value) => JSON.parse(JSON.stringify(value));
const deepFreeze = (value) => { Object.values(value).forEach((item) => { if (item && typeof item === 'object' && !Object.isFrozen(item)) deepFreeze(item); }); return Object.freeze(value); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const now = () => new Date().toISOString();
const fail = (status, code, reason, extra = {}) => ({ ok: false, status, code, reason, ...extra });
const invalid = (reason) => fail('invalid', 'INVALID_INPUT', reason);
const PRICE_UNITS = 750; // one USD = 1,000,000 units; official per-call price.
const UNIT = 1_000_000;
// 思考模式（deepseek-flash）：價格用尖峰價當上限，預算寧可多留不可少算。
const ANALYZE_MODEL = 'deepseek-flash';
const ANALYZE_ENDPOINT = '/chat/completions';
const ANALYZE_PRICE_INPUT = 0.3;       // USD / 1M tokens (peak, cache miss)
const ANALYZE_PRICE_CACHE_HIT = 0.006; // USD / 1M tokens (peak, cache hit)
const ANALYZE_PRICE_OUTPUT = 1.2;      // USD / 1M tokens (peak)
const ANALYZE_MAX_MESSAGES = 20;
const ANALYZE_MAX_CHARS = 24000;
const ANALYZE_MAX_OUTPUT_TOKENS = 8192;
const ANALYZE_EFFORTS = new Set(['low', 'high', 'max']);
const DOH_ORIGIN = 'https://1.1.1.1';
const DOH_ENDPOINT = DOH_ORIGIN + '/dns-query';
const DNS_POLICY_SOURCE = 'https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/';
const RIGHTS = new Set(['owned', 'user_owned', 'licensed', 'public_domain', 'generated', 'generated_owned', 'authorized']);
const DEFAULT_SNAPSHOTS = Object.freeze({ dictionary_version: '1.0.0', taste_snapshot_id: 'project-plan-v1-initial', compiler_version: '1.0.0', capability_snapshot_id: 'deepseek-search-fetch-2026-11-16' });
const PROVENANCE = Object.freeze({ url: 'https://api-docs.deepseek.com/guides/search/', captured_at: '2026-11-16T11:30:59.1635801Z', sha256: '0050f44bddc2d9d4b3a9230390b2330233fc3f8c9cffb9fb7780eb46752935ea' });

export function getResearchCapabilities() {
  return { ok: true, status: 'documented', provider: 'deepseek', protocol: 'Search/Fetch raw JSON', sources: [copy(PROVENANCE)],
    endpoints: { search: 'https://api.deepseek.com/v1/tools/search', fetch: 'https://api.deepseek.com/v1/tools/fetch', analyze: 'https://api.deepseek.com/chat/completions (' + ANALYZE_MODEL + ', thinking mode)' },
    limits: { query_code_points: 128, count: [1, 50], fetch_url_code_points: 8192 },
    estimated_usd_per_billable_request: PRICE_UNITS / UNIT, actual_cost_known: false,
    billing: 'HTTP 200 non-empty Search results / Fetch content is billable per documentation; count does not change per-call cost. Final invoice cost remains unknown.',
    permissions: { server_config_only: true, public_text_only: true, uploads: false, automatic_long_term_taste_updates: false },
    resolver: { fallback: 'server-exact-host allowlist and local addresses entirely in 198.18.0.0/15 only', endpoint: DOH_ENDPOINT, methods: ['GET A', 'GET AAAA'], source: DNS_POLICY_SOURCE, credentials: 'omitted', tls_verification: 'unchanged', maximum_response_bytes: 65536 },
    request_schema: copy(RESEARCH_PREPARE_SCHEMA), execution_enabled_by_default: false };
}
export const RESEARCH_PREPARE_SCHEMA = deepFreeze({
  type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['search', 'fetch'] }, query: { type: 'string', minLength: 1, maxLength: 128 },
    count: { type: 'integer', minimum: 1, maximum: 50 }, need_content: { type: 'boolean' },
    ori_question: { type: 'string', minLength: 1, maxLength: 128 }, url: { type: 'string', maxLength: 8192 },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
    references: { type: 'array', maxItems: 20, items: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, source_url: { type: 'string' }, url: { type: 'string' }, user_input: { type: 'string' }, rights_status: { type: 'string' }, ai_ingestion_allowed: { const: true } }, required: ['source', 'rights_status', 'ai_ingestion_allowed'], additionalProperties: false } },
    snapshot_ids: { type: 'object', properties: Object.fromEntries(Object.keys(DEFAULT_SNAPSHOTS).map((key) => [key, { type: 'string' }])), additionalProperties: false },
  },
});

export const RESEARCH_ANALYZE_SCHEMA = deepFreeze({
  type: 'object', additionalProperties: false, properties: {
    messages: {
      type: 'array', minItems: 1, maxItems: ANALYZE_MAX_MESSAGES, items: {
        type: 'object', additionalProperties: false,
        properties: { role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string', minLength: 1, maxLength: 8000 } },
        required: ['role', 'content'],
      },
    },
    model: { type: 'string', enum: [ANALYZE_MODEL] },
    reasoning_effort: { type: 'string', enum: ['low', 'high', 'max'], default: 'high' },
    max_output_tokens: { type: 'integer', minimum: 128, maximum: ANALYZE_MAX_OUTPUT_TOKENS, default: 2048 },
    idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
    snapshot_ids: { type: 'object', properties: Object.fromEntries(Object.keys(DEFAULT_SNAPSHOTS).map((key) => [key, { type: 'string' }])), additionalProperties: false },
    references: { type: 'array', maxItems: 20, items: { type: 'object' } },
  },
  required: ['messages'],
});

const secretParameter = name => /(?:^|[_-])(?:access[_-]?token|api[_-]?key|key|token|secret|password|credential|signature|authorization|session|auth)(?:$|[_-])/i.test(name) || /(?:token|secret|password|credential|signature|authorization|session|api[_-]?key)$/i.test(name);
function decodedFragment(value) { let text = value.replace(/^#/, ''); for (let n = 0; n < 2; n++) { try { const decoded = decodeURIComponent(text); if (decoded === text) break; text = decoded; } catch { break; } } return text; }
function textSensitiveRules(value) {
  const rules = new Set();
  if (/\bBearer\s+\S+/i.test(value)) rules.add('BEARER_CREDENTIAL');
  if (/\bsk-[A-Za-z0-9_-]{10,}/i.test(value)) rules.add('API_KEY_PATTERN');
  if (/\b(?:api[_-]?key|cookie|session|token|password|secret)\b["']?\s*[:=]\s*["']?[^\s,;"']{6,}/i.test(value)) rules.add('CREDENTIAL_ASSIGNMENT');
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) rules.add('JWT_CREDENTIAL');
  const urls = value.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  for (const found of urls) {
    try {
      const url = new URL(found.replace(/[),.;]+$/, ''));
      if (url.username || url.password) rules.add('URL_CREDENTIALS');
      if ([...url.searchParams.keys()].some(secretParameter)) rules.add('URL_SECRET_PARAMETER');
      const fragment = decodedFragment(url.hash);
      if (fragment && [...new URLSearchParams(fragment.replace(/^\?/, '')).keys()].some(secretParameter)) rules.add('URL_SECRET_FRAGMENT');
      if (fragment && /(?:^|[;&\s])(?:access[_-]?token|api[_-]?key|key|auth|password|secret|session|credential|signature)\s*[:=]/i.test(fragment)) rules.add('URL_SECRET_FRAGMENT');
      if (fragment && /\bBearer\s+|\bsk-[A-Za-z0-9_-]{10,}/i.test(fragment)) rules.add('URL_SECRET_FRAGMENT');
    } catch { /* URL structure is validated independently before use. */ }
  }
  // Inspect original string values, never JSON's escaping. In particular,
  // LaTeX's \alpha ... \beta must not turn into a fabricated UNC path.
  const withoutUrls = value.replace(/https?:\/\/[^\s<>"'`]+/gi, ' ');
  if (/(?:^|[\s"'(])[A-Za-z]:[\\/]/.test(withoutUrls)) rules.add('LOCAL_WINDOWS_DRIVE');
  if (/(?:^|[\s"'(])\\\\[A-Za-z0-9][A-Za-z0-9.-]{0,252}\\[A-Za-z0-9$_-][^\s"'<>]*/.test(withoutUrls)) rules.add('LOCAL_UNC_PATH');
  if (/file:\/\//i.test(withoutUrls)) rules.add('LOCAL_FILE_URL');
  if (/(?:^|[\s"'(])\/(?:Users|home|mnt|etc|private)\/[^\s"'<>]+/i.test(withoutUrls)) rules.add('LOCAL_POSIX_PATH');
  return [...rules];
}
export function sensitiveResearchRuleCodes(value) {
  const rules = new Set(), seen = new WeakSet();
  const visit = (item, depth = 0) => {
    if (depth > 30) { rules.add('INPUT_DEPTH_LIMIT'); return; }
    if (typeof item === 'string') { textSensitiveRules(item).forEach(rule => rules.add(rule)); return; }
    if (!item || typeof item !== 'object') return;
    if (seen.has(item)) { rules.add('NON_JSON_REFERENCE'); return; }
    seen.add(item);
    for (const [key, entry] of Object.entries(item)) {
      if (/^(?:api[_-]?key|cookie|session|token|password|secret)$/i.test(key) && typeof entry === 'string' && entry.length >= 6) rules.add('CREDENTIAL_FIELD');
      visit(entry, depth + 1);
    }
    seen.delete(item);
  };
  visit(value); return [...rules].sort();
}
function hasSensitive(value) { return sensitiveResearchRuleCodes(value).length > 0; }
function safeText(value, max = 4000, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.trim().length > 0) && [...value].length <= max && !hasSensitive(value) && !/spotify/i.test(value);
}
function validSnapshots(input) {
  if (input === undefined) return { ok: true, value: copy(DEFAULT_SNAPSHOTS) };
  if (!OBJECT(input) || Object.keys(input).some((key) => !own(DEFAULT_SNAPSHOTS, key)) || Object.values(input).some((value) => !safeText(value, 128))) return invalid('snapshot_ids 只能包含固定版本識別文字。');
  return { ok: true, value: { ...DEFAULT_SNAPSHOTS, ...copy(input) } };
}
function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) &&
      !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
  }
  if (family === 6) return /^[23][a-f0-9]{3}:/i.test(address) && !/^(?:2001:db8|2001:2:|2001:0:|2002:)/i.test(address);
  return false;
}
export function validatePublicResearchUrl(value) {
  if (typeof value !== 'string' || [...value].length > 8192 || hasSensitive(value) || /spotify/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port && url.port !== '443') return false;
    if (/\.(?:mp3|wav|m4a|flac|ogg|aac|aif|aiff|aifc|mid|midi|mp4|webm|mov|avi|jpg|jpeg|png|zip|exe|dmg)$/i.test(url.pathname)) return false;
    const host = url.hostname.toLowerCase();
    if (host.startsWith('[') || isIP(host) && !publicAddress(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|onion|invalid|test)$/.test(host)) return false;
    for (const key of url.searchParams.keys()) if (secretParameter(key)) return false;
    if (url.hash && hasSensitive(decodedFragment(url.hash))) return false;
    return true;
  } catch { return false; }
}
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function sourceFieldIssues(item) {
  if (!OBJECT(item)) return [{ field: 'result', type: valueType(item), code: 'RESULT_NOT_OBJECT' }];
  const issues = [];
  const issue = (field, value, code) => issues.push({ field, type: valueType(value), code });
  if (!validatePublicResearchUrl(item.url)) {
    let code = 'URL_NOT_PUBLIC_TEXT';
    if (typeof item.url !== 'string') code = 'URL_TYPE';
    else if (/spotify/i.test(item.url)) code = 'SPOTIFY_SOURCE';
    else if (hasSensitive(item.url)) code = 'URL_SENSITIVE_OR_PRIVATE';
    else {
      try { const url = new URL(item.url); if (url.protocol !== 'https:') code = 'URL_HTTPS_REQUIRED'; else if (url.username || url.password) code = 'URL_CREDENTIALS'; else if (url.port && url.port !== '443') code = 'URL_PORT'; }
      catch { code = 'URL_PARSE'; }
    }
    issue('url', item.url, code);
    if (hasSensitive(item.url)) issues[issues.length - 1].rules = sensitiveResearchRuleCodes(item.url);
  }
  for (const [field, value, max] of [['title', item.title || 'Untitled', 1000], ['summary', item.summary || item.snippet || '', 12000]]) {
    if (typeof value !== 'string') issue(field, value, 'TEXT_TYPE');
    else if ([...value].length > max) issue(field, value, 'TEXT_TOO_LONG');
    else if (/spotify/i.test(value)) issue(field, value, 'SPOTIFY_CONTENT');
    else if (hasSensitive(value)) { issue(field, value, 'SENSITIVE_OR_PRIVATE_TEXT'); issues[issues.length - 1].rules = sensitiveResearchRuleCodes(value); }
  }
  if (item.content !== undefined && item.content !== null && typeof item.content !== 'string') issue('content', item.content, 'TEXT_TYPE');
  else if (hasSensitive(item.content || '')) { issue('content', item.content, 'SENSITIVE_OR_PRIVATE_TEXT'); issues[issues.length - 1].rules = sensitiveResearchRuleCodes(item.content); }
  return issues;
}
function units(value) {
  const result = Math.round(value * UNIT);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(result) && result / UNIT === value ? result : null;
}
function configGrant(config) {
  if (typeof config.api_key !== 'string' || !config.api_key.trim() || /[\r\n]/.test(config.api_key)) return fail('auth_required', 'DEEPSEEK_AUTH_REQUIRED', '需要伺服器提供 DeepSeek 憑據；請求不能自行加入。');
  let base;
  let baseInput = typeof config.base_url === 'string' ? config.base_url.trim() : config.base_url || 'https://api.deepseek.com';
  if (typeof baseInput === 'string' && baseInput.length >= 2 && ((baseInput.startsWith('"') && baseInput.endsWith('"')) || (baseInput.startsWith("'") && baseInput.endsWith("'")))) baseInput = baseInput.slice(1, -1).trim();
  try { base = new URL(baseInput); } catch { return fail('unsupported', 'DEEPSEEK_ORIGIN', 'DeepSeek 服務網址無效。'); }
  if (base.origin !== 'https://api.deepseek.com' || base.username || base.password || !['/', '/v1', '/v1/'].includes(base.pathname) || base.search || base.hash) return fail('unsupported', 'DEEPSEEK_ORIGIN', '研究執行器只接受 DeepSeek 官方 HTTPS origin。');
  if (units(config.budget_usd) === null || config.budget_usd <= 0 || !Number.isSafeInteger(config.max_requests) || config.max_requests < 1 || config.max_requests > 10000 || typeof config.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(config.expires_at) || !Number.isFinite(Date.parse(config.expires_at)) || new Date(Date.parse(config.expires_at)).toISOString().slice(0, 19) !== config.expires_at.slice(0, 19)) return fail('auth_required', 'FINITE_RESEARCH_GRANT_REQUIRED', '需要明確的有限 USD 預算、請求數與 UTC 到期時間。');
  const kinds = config.allowed_kinds ?? ['search', 'fetch'];
  if (!Array.isArray(kinds) || !kinds.length || kinds.some((kind) => !['search', 'fetch', 'analyze'].includes(kind))) return fail('auth_required', 'RESEARCH_SCOPE_INVALID', '研究授權範圍無效。');
  if (Date.parse(config.expires_at) <= Date.now()) return fail('auth_required', 'RESEARCH_GRANT_EXPIRED', '研究批次授權已到期。');
  const data = { provider: 'deepseek', budget_usd: config.budget_usd, max_requests: config.max_requests, expires_at: config.expires_at, allowed_kinds: [...new Set(kinds)].sort(), public_text_only: true };
  // An omitted ID must not silently create a fresh budget when a launcher
  // recomputes its expiry after restart. New batches require an explicit ID.
  const id = config.grant_id ?? 'research_default_batch';
  if (!safeText(id, 128)) return fail('auth_required', 'RESEARCH_SCOPE_INVALID', '研究授權識別碼無效。');
  return { ok: true, id, hash: hashObject(data), data, budget_units: units(data.budget_usd) };
}
function analyzePlan(input, containsSecret = () => false) {
  if (!OBJECT(input) || Object.keys(input).some((key) => !own(RESEARCH_ANALYZE_SCHEMA.properties, key))) return invalid('思考模式只接受公開文字訊息、模型與輸出上限，不接受憑據或上傳欄位。');
  if (hasSensitive(input) || containsSecret(input)) return fail('policy_blocked', 'SENSITIVE_RESEARCH_INPUT', '請先移除憑據、本機路徑與私人素材。');
  if (/spotify/i.test(JSON.stringify(input))) return fail('policy_blocked', 'SPOTIFY_RESEARCH_INPUT', 'Spotify 與其衍生內容不能進入研究請求。');
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > ANALYZE_MAX_MESSAGES) return invalid(`messages 需要 1–${ANALYZE_MAX_MESSAGES} 則。`);
  const messages = [];
  let chars = 0;
  for (const message of input.messages) {
    if (!OBJECT(message) || Object.keys(message).some((key) => !['role', 'content'].includes(key))) return invalid('每則訊息只能有 role 與 content。');
    if (!['system', 'user', 'assistant'].includes(message.role)) return invalid('role 只能是 system／user／assistant。');
    if (!safeText(message.content, 8000)) return invalid('訊息內容需要 1–8000 個公開文字字元，且不能含憑據。');
    chars += [...message.content].length;
    messages.push({ role: message.role, content: message.content });
  }
  if (chars > ANALYZE_MAX_CHARS) return invalid(`訊息合計不能超過 ${ANALYZE_MAX_CHARS} 字。`);
  const model = input.model === undefined ? ANALYZE_MODEL : input.model;
  if (model !== ANALYZE_MODEL) return invalid(`目前只允許 ${ANALYZE_MODEL}（思考模式預設開啟）。`);
  const effort = input.reasoning_effort === undefined ? 'high' : input.reasoning_effort;
  if (!ANALYZE_EFFORTS.has(effort)) return invalid('reasoning_effort 只能是 low／high／max。');
  const maxOutput = input.max_output_tokens === undefined ? 2048 : input.max_output_tokens;
  if (!Number.isInteger(maxOutput) || maxOutput < 128 || maxOutput > ANALYZE_MAX_OUTPUT_TOKENS) return invalid(`max_output_tokens 必須是 128–${ANALYZE_MAX_OUTPUT_TOKENS} 整數（思考模式的 reasoning 也算在內）。`);
  if (input.idempotency_key !== undefined && !safeText(input.idempotency_key, 128)) return invalid('需要有效的幂等鍵。');
  const snapshots = validSnapshots(input.snapshot_ids); if (!snapshots.ok) return snapshots;
  const refs = input.references === undefined ? [] : input.references;
  const policy = validateReferences(refs); if (!policy.ok) return policy;
  const body = { model, messages, reasoning_effort: effort, thinking: { type: 'enabled' }, max_tokens: maxOutput, stream: false };
  return { ok: true, request: { kind: 'analyze', endpoint: ANALYZE_ENDPOINT, body }, snapshots: snapshots.value, references: copy(refs) };
}

function analyzeReservation(body) {
  const chars = body.messages.reduce((sum, message) => sum + [...message.content].length, 0);
  const promptTokens = Math.ceil(chars / 3) + 32; // 保守：每 token 3 字
  const usd = (promptTokens * ANALYZE_PRICE_INPUT + body.max_tokens * ANALYZE_PRICE_OUTPUT) / UNIT;
  return Math.max(1, Math.ceil(usd * UNIT));
}

function analyzeCharge(usage) {
  const hit = Number(usage?.prompt_cache_hit_tokens) || 0;
  const prompt = Number(usage?.prompt_tokens) || 0;
  const miss = Number.isFinite(Number(usage?.prompt_cache_miss_tokens)) ? Number(usage.prompt_cache_miss_tokens) : Math.max(0, prompt - hit);
  const completion = Number(usage?.completion_tokens) || 0;
  const usd = (Math.max(0, miss) * ANALYZE_PRICE_INPUT + Math.max(0, hit) * ANALYZE_PRICE_CACHE_HIT + Math.max(0, completion) * ANALYZE_PRICE_OUTPUT) / UNIT;
  return { units: Math.max(0, Math.ceil(usd * UNIT)), usd };
}

async function boundedJson(response, maxBytes) {  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) throw new Error('RESPONSE_LIMIT');
  if (!response.body?.getReader) throw new Error('RESPONSE_BODY');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('RESPONSE_LIMIT'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

function dnsName(value) { return typeof value === 'string' ? value.replace(/\.$/, '').toLowerCase() : ''; }
function exactDnsHost(value) {
  return typeof value === 'string' && value === value.trim() && value.length <= 253 && !isIP(value) && /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) && value.includes('.') && !value.includes('..') && value.split('.').every(label => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
}
function fakeIpAddress(value) {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number); return a === 198 && (b === 18 || b === 19);
}
function parseDohAddresses(data, host, requestedType) {
  if (!OBJECT(data) || data.Status !== 0 || data.TC === true || data.CD === true || !Array.isArray(data.Question) || data.Question.length !== 1 || dnsName(data.Question[0]?.name) !== host || data.Question[0]?.type !== requestedType) throw new Error('DNS_QUESTION_INVALID');
  const answers = data.Answer ?? [];
  if (!Array.isArray(answers) || answers.length > 100) throw new Error('DNS_ANSWER_INVALID');
  const reachable = new Set([host]);
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    for (const record of answers) {
      if (!OBJECT(record) || !Number.isInteger(record.type)) throw new Error('DNS_ANSWER_INVALID');
      if (record.type !== 5 || !reachable.has(dnsName(record.name))) continue;
      const target = dnsName(record.data);
      if (!exactDnsHost(target)) throw new Error('DNS_CNAME_INVALID');
      if (!reachable.has(target)) { reachable.add(target); changed = true; }
    }
    if (!changed) break;
  }
  const addresses = [];
  for (const record of answers) {
    if (![1, 28].includes(record.type)) continue;
    if (typeof record.data !== 'string' || !publicAddress(record.data) || isIP(record.data) !== (record.type === 1 ? 4 : 6)) throw new Error('DNS_PRIVATE_ANSWER');
    if (reachable.has(dnsName(record.name))) addresses.push({ address: record.data, family: record.type === 1 ? 4 : 6 });
  }
  return addresses;
}

/** One instance per Hub. Test-only networking/DNS injection is never an input field. */
export function createResearchService({ stateDir, config = {}, fetchImpl = globalThis.fetch, resolveImpl = lookup, dnsFetchImpl = globalThis.fetch } = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('A server-owned state directory is required.');
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, 'research.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS research_jobs(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_grants(id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_requests(id TEXT PRIMARY KEY, job_id TEXT UNIQUE NOT NULL, grant_id TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL, estimated_units INTEGER NOT NULL, billed_units INTEGER, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS research_request_hash ON research_requests(request_hash);
    CREATE TABLE IF NOT EXISTS research_cache(request_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_evidence(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_candidates(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_snapshots(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);
  // Copy only to a private closure. Never serialize or hash the supplied API key.
  const serverConfig = OBJECT(config) ? { ...config, allowed_kinds: Array.isArray(config.allowed_kinds) ? [...config.allowed_kinds] : config.allowed_kinds } : {};
  const hostInput = serverConfig.allowed_fetch_hosts ?? [];
  const allowedFetchHosts = Array.isArray(hostInput) && hostInput.length <= 100 && hostInput.every(exactDnsHost) ? [...new Set(hostInput.map(dnsName))].sort() : [];
  const resolverPolicy = { version: 'research-public-dns-1', allowed_fetch_hosts: allowedFetchHosts, fallback_range: '198.18.0.0/15', doh_endpoint: DOH_ENDPOINT, query_types: ['A', 'AAAA'], credentials: 'omit', redirects: 'error', tls_verification: 'unchanged' };
  const resolverPolicyHash = hashObject(resolverPolicy);
  const containsConfiguredSecret = (value) => typeof serverConfig.api_key === 'string' && serverConfig.api_key.length >= 8 && JSON.stringify(value).includes(serverConfig.api_key);
  const active = new Map();
  let closed = false;
  const decode = (row) => row ? JSON.parse(row.data) : null;
  function normalizeResult(result) {
    if (!OBJECT(result)) return result;
    const evidenceCount = Array.isArray(result.evidence_ids) ? result.evidence_ids.length : 0;
    const providerEmpty = result.provider_empty ?? result.empty;
    const noUsable = providerEmpty === false && evidenceCount === 0;
    return { ...result, ...(typeof providerEmpty === 'boolean' ? { provider_empty: providerEmpty } : {}), usable_source_count: evidenceCount, research_success: evidenceCount > 0, status: noUsable ? 'no_usable_sources' : result.status || 'completed' };
  }
  function normalizeJob(job) {
    if (!OBJECT(job) || !OBJECT(job.result)) return job;
    const result = normalizeResult(job.result);
    return { ...job, result, ...(result.status === 'no_usable_sources' ? { status: 'no_usable_sources' } : {}) };
  }
  const jobRow = (id) => db.prepare('SELECT * FROM research_jobs WHERE id=?').get(id);
  const event = (type, data) => db.prepare('INSERT INTO research_events(at,type,data) VALUES(?,?,?)').run(now(), type, JSON.stringify(data));
  const stopped = () => decode(db.prepare("SELECT data FROM research_settings WHERE key='stopped'").get()) === true;
  function tx(work) { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (err) { db.exec('ROLLBACK'); throw err; } }
  function safe(work) { if (closed) return fail('closed', 'CLOSED', '研究帳本已關閉。'); try { return work(); } catch { return fail('failed', 'RESEARCH_STORAGE', '研究帳本無法完成操作，既有預留保留。'); } }
  function saveJob(job) { db.prepare('UPDATE research_jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id); }
  function ledger(grantId) {
    const rows = db.prepare('SELECT state,estimated_units,billed_units FROM research_requests WHERE grant_id=?').all(grantId);
    return { requests_used: rows.length, reserved_units: rows.filter((row) => row.state === 'outcome_unknown').reduce((sum, row) => sum + row.estimated_units, 0), estimated_spent_units: rows.filter((row) => row.state === 'completed').reduce((sum, row) => sum + (row.billed_units || 0), 0), unknown_requests: rows.filter((row) => row.state === 'outcome_unknown').length };
  }
  function planInput(input) {
    if (!OBJECT(input) || Object.keys(input).some((key) => !own(RESEARCH_PREPARE_SCHEMA.properties, key))) return invalid('研究只接受公開文字 Search/Fetch 參數，不接受授權、憑據或上傳欄位。');
    if (hasSensitive(input) || containsConfiguredSecret(input)) return fail('policy_blocked', 'SENSITIVE_RESEARCH_INPUT', '請先移除憑據、本機路徑與私人素材。');
    if (/spotify/i.test(JSON.stringify(input))) return fail('policy_blocked', 'SPOTIFY_RESEARCH_INPUT', 'Spotify 與其衍生內容不能進入研究請求。');
    const refs = input.references === undefined ? [] : input.references;
    const policy = validateReferences(refs); if (!policy.ok) return policy;
    for (const ref of refs) {
      if (!OBJECT(ref) || Object.keys(ref).some((key) => !['id', 'source', 'source_url', 'url', 'user_input', 'rights_status', 'ai_ingestion_allowed'].includes(key)) || typeof ref.source !== 'string' || !ref.source.trim()) return invalid('references 必須只有公開來源識別與完整權利資料；不接收音訊或檔案。');
      for (const key of ['source_url', 'url']) if (ref[key] !== undefined && !validatePublicResearchUrl(ref[key])) return fail('policy_blocked', 'PUBLIC_URL_REQUIRED', '研究參考只能是公開 HTTPS 文字來源。');
    }
    const snapshots = validSnapshots(input.snapshot_ids); if (!snapshots.ok) return snapshots;
    const kind = input.kind ?? 'search';
    let body;
    if (kind === 'search') {
      if (!safeText(input.query, 128) || own(input, 'url')) return invalid('Search query 需要 1–128 個公開文字 Unicode 字元，不能混用 Fetch URL。');
      const embeddedUrls = input.query.match(/https?:\/\/[^\s]+/g) || [];
      if (embeddedUrls.some((url) => !validatePublicResearchUrl(url))) return fail('policy_blocked', 'PUBLIC_TEXT_QUERY_REQUIRED', '研究 query 不能包含私人位址、帶憑據 URL 或音訊/二進位素材連結。');
      if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 50) || input.need_content !== undefined && typeof input.need_content !== 'boolean' || input.ori_question !== undefined && !safeText(input.ori_question, 128)) return invalid('Search count 必須 1–50，need_content 必須 boolean，ori_question 最多 128 字。');
      body = { query: input.query.trim(), count: input.count ?? 5, need_content: input.need_content ?? false };
      if (input.ori_question !== undefined) body.ori_question = input.ori_question.trim();
    } else if (kind === 'fetch') {
      if (!validatePublicResearchUrl(input.url) || ['query', 'count', 'need_content', 'ori_question'].some((key) => own(input, key))) return fail('policy_blocked', 'PUBLIC_URL_REQUIRED', 'Fetch 僅接受不帶帳密的公開 HTTPS URL，不接受 Search 欄位。');
      if (!refs.some((ref) => [ref.source_url, ref.url, ref.user_input].includes(input.url))) return fail('policy_blocked', 'FETCH_RIGHTS_REQUIRED', 'Fetch 需要與目標 URL 對應、已允許 AI 讀取的來源權利卡。');
      const target = new URL(input.url); target.hash = '';
      body = { url: target.href };
    } else return invalid('kind 必須是 search 或 fetch。');
    if (input.idempotency_key !== undefined && !safeText(input.idempotency_key, 128)) return invalid('需要有效的幂等鍵。');
    const request = { kind, endpoint: `/v1/tools/${kind}`, body };
    return { ok: true, request, snapshots: snapshots.value, references: copy(refs), ...(kind === 'fetch' ? { original_source_url: input.url } : {}) };
  }
  async function verifyFetchDns(host) {
    let addresses, dnsTimeout;
    try { addresses = await Promise.race([resolveImpl(host, { all: true, verbatim: true }), new Promise((_, reject) => { dnsTimeout = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 15000); })]); }
    catch { return fail('policy_blocked', 'PUBLIC_DNS_UNVERIFIED', '無法核實 Fetch 來源的公開網路位址。', { resolver_diagnostic: { route: 'local_dns_unverified', scope: 'public_text_only' } }); }
    finally { if (dnsTimeout) clearTimeout(dnsTimeout); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 100) return fail('policy_blocked', 'PRIVATE_FETCH_TARGET', 'Fetch 來源的公開 DNS 結果無效。', { resolver_diagnostic: { route: 'local_dns_rejected', scope: 'public_text_only' } });
    const localTypes = [...new Set(addresses.map(entry => isIP(entry?.address)).filter(Boolean))].sort();
    if (addresses.every(entry => publicAddress(entry?.address))) return { ok: true, proof: { route: 'local_public_dns', scope: 'public_text_only', local_address_count: addresses.length, verified_address_count: addresses.length, address_types: localTypes, resolver_policy_hash: resolverPolicyHash, verified_at: now() } };
    if (!addresses.every(entry => fakeIpAddress(entry?.address)) || !allowedFetchHosts.includes(host)) return fail('policy_blocked', 'PRIVATE_FETCH_TARGET', 'Fetch 來源含私人、混合或未獲指定的保留網路位址。', { resolver_diagnostic: { route: 'local_dns_rejected', scope: 'public_text_only', local_address_count: addresses.length, address_types: localTypes } });
    const deadlineMs = Number.isInteger(serverConfig.dns_timeout_ms) ? Math.max(50, Math.min(5000, serverConfig.dns_timeout_ms)) : 5000;
    const query = async type => {
      const controller = new AbortController(); let deadline;
      const work = (async () => {
        const url = new URL(DOH_ENDPOINT); url.searchParams.set('name', host); url.searchParams.set('type', type === 1 ? 'A' : 'AAAA');
        const response = await dnsFetchImpl(url.href, { method: 'GET', headers: { Accept: 'application/dns-json' }, credentials: 'omit', redirect: 'error', signal: controller.signal });
        if (response.status !== 200 || response.redirected || response.url && (new URL(response.url).origin !== DOH_ORIGIN || new URL(response.url).pathname !== '/dns-query')) throw new Error('DNS_HTTP_REJECTED');
        return parseDohAddresses(await boundedJson(response, 65536), host, type);
      })();
      try { return await Promise.race([work, new Promise((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new Error('DNS_DEADLINE')); }, deadlineMs); })]); }
      finally { if (deadline) clearTimeout(deadline); }
    };
    try {
      const results = await Promise.all([query(1), query(28)]);
      const verified = [...new Map(results.flat().map(entry => [entry.address, entry])).values()];
      if (!verified.length) throw new Error('DNS_EMPTY_ANSWER');
      return { ok: true, proof: { route: 'cloudflare_doh_verified_fake_ip', scope: 'server_exact_host_allowlist', local_address_count: addresses.length, local_fake_ipv4_count: addresses.length, verified_address_count: verified.length, address_types: [...new Set(verified.map(entry => entry.family))].sort(), query_types: ['A', 'AAAA'], resolver_policy_hash: resolverPolicyHash, verified_at: now() } };
    } catch { return fail('policy_blocked', 'PUBLIC_DNS_UNVERIFIED', '指定公開來源未通過獨立 DNS 核驗；未呼叫付費 Fetch。', { resolver_diagnostic: { route: 'fake_ip_doh_rejected', scope: 'server_exact_host_allowlist', local_address_count: addresses.length, query_types: ['A', 'AAAA'] } }); }
  }
  function prepare(input = {}) {
    return safe(() => {
      const parsed = planInput(input); if (!parsed.ok) return parsed;
      const requestHash = hashObject(parsed.request);
      const idem = hashObject(input.idempotency_key ?? `research:${hashObject({ requestHash, snapshots: parsed.snapshots, original_source_url: parsed.original_source_url })}`);
      const existing = db.prepare('SELECT * FROM research_jobs WHERE idem=?').get(idem);
      if (existing) {
        const previous = normalizeJob(decode(existing));
        if (previous.request_hash !== requestHash || hashObject(previous.snapshot_ids) !== hashObject(parsed.snapshots) || previous.original_source_url !== parsed.original_source_url) return fail('idempotency_conflict', 'IDEMPOTENCY_CONFLICT', '此幂等鍵已綁定另一份研究計畫。');
        return { ok: true, status: previous.status, job: previous, reused: true };
      }
      if (stopped()) return fail('stopped', 'RESEARCH_STOPPED', '研究批次已停止新增工作。');
      const job = { id: `research_job_${idem.slice(0, 24)}`, kind: parsed.request.kind, request: parsed.request, request_hash: requestHash, status: 'prepared', snapshot_ids: parsed.snapshots, ...(parsed.original_source_url ? { original_source_url: parsed.original_source_url, resolver_policy_hash: resolverPolicyHash } : {}), reference_ids: parsed.references.map((ref) => ref.id || hashObject(ref).slice(0, 16)), reference_permissions: parsed.references, source_policy_version: '1.0.0', created_at: now(), estimated_cost_usd: PRICE_UNITS / UNIT, actual_cost_usd: null, evidence_ids: [], execution_enabled: false };
      tx(() => { db.prepare('INSERT INTO research_jobs VALUES(?,?,?,?)').run(job.id, idem, requestHash, JSON.stringify(job)); event('prepared', { job_id: job.id, kind: job.kind, request_hash: requestHash }); });
      return { ok: true, status: 'prepared', job, reused: false, requirements: ['伺服器提供官方 DeepSeek 憑據與有限 USD/請求數/到期時間授權。', '僅研究公開文字；資料內容不會改變預算或工具權限。'] };
    });
  }
  function saveEvidence(data) {
    const base = { source_policy_version: '1.0.0', observed_at: now(), source_content_type: 'untrusted_web_data', instructions_executable: false, ...data };
    const id = `evidence_${hashObject({ ...base, observed_at: undefined }).slice(0, 24)}`;
    const card = { ...base, id, summary_hash: hashObject(base.summary), content_hash: base.content_hash || hashObject(base.summary), hash_algorithm: 'sha256_canonical_json' };
    db.prepare('INSERT OR IGNORE INTO research_evidence VALUES(?,?)').run(id, JSON.stringify(card));
    return decode(db.prepare('SELECT * FROM research_evidence WHERE id=?').get(id));
  }
  function collect(job, data) {
    const cards = [], exclusions = [];
    if (job.kind === 'search') {
      if (!OBJECT(data) || !Array.isArray(data.results) || data.results.length > 50) throw new Error('RESPONSE_SCHEMA');
      for (const item of data.results) {
        const issues = sourceFieldIssues(item);
        if (issues.length) { exclusions.push({ reason: 'unsafe_or_unpermitted_source', fields: issues }); continue; }
        const summary = (item.summary || item.snippet || '').slice(0, 3000);
        cards.push(saveEvidence({ source: 'deepseek_search_result', source_url: item.url, title: item.title || 'Untitled', summary, content_hash: hashObject(item.content || item.summary || item.snippet || ''), retrieval_job_id: job.id, snapshot_ids: job.snapshot_ids, rights_status: 'unknown', ai_ingestion_allowed: false, allowed_use: ['source_navigation', 'human_source_review'], facts: [], inferences: [], unverified_claims: summary ? [{ text: summary, label: 'provider_summary_unverified' }] : [], source_publication_date: safeText(item.date || '', 64, true) ? item.date || null : null, authority_hint: typeof item.authority === 'number' && item.authority >= -1 && item.authority <= 4 ? item.authority : null }));
      }
      return { cards, exclusions, billable: data.results.length > 0 };
    }
    if (!OBJECT(data) || typeof data.content !== 'string' || typeof data.title !== 'string') throw new Error('RESPONSE_SCHEMA');
    if (hasSensitive(data.content) || !safeText(data.title || 'Untitled', 1000) || /spotify/i.test(data.content)) return { cards, exclusions: [{ reason: 'unsafe_or_unpermitted_content' }], billable: data.content.trim().length > 0 };
    const summary = data.content.slice(0, 3000);
    const permission = (job.reference_permissions || []).find((ref) => [ref.source_url, ref.url, ref.user_input].includes(job.original_source_url || job.request.body.url));
    if (data.content.trim()) cards.push(saveEvidence({ source: 'deepseek_fetch', source_url: job.request.body.url, ...(job.original_source_url ? { original_source_url: job.original_source_url } : {}), ...(job.resolver_verification ? { resolver_policy_hash: job.resolver_policy_hash, resolver_verification: job.resolver_verification } : {}), title: data.title || 'Untitled', summary, content_hash: hashObject(data.content), retrieval_job_id: job.id, snapshot_ids: job.snapshot_ids, rights_status: permission?.rights_status || 'unknown', ai_ingestion_allowed: permission?.ai_ingestion_allowed === true, allowed_use: permission?.ai_ingestion_allowed === true ? ['local_research', 'reviewed_term_candidates'] : ['source_navigation', 'human_source_review'], facts: [], inferences: [], unverified_claims: [{ text: summary, label: 'source_excerpt_unverified' }] }));
    return { cards, exclusions, billable: data.content.trim().length > 0 };
  }
  async function run(jobInput) {
    if (closed) return fail('closed', 'CLOSED', '研究帳本已關閉。');
    const id = typeof jobInput === 'string' ? jobInput : OBJECT(jobInput) && typeof jobInput.id === 'string' ? jobInput.id : null;
    if (!id) return invalid('run 需要已持久化的 job ID。');
    let job, requestId, controller, timeout, resolverProof;
    try {
      job = normalizeJob(decode(jobRow(id)));
      if (!job) return fail('not_found', 'JOB_NOT_FOUND', '找不到研究工作。');
      if (job.status !== 'prepared') return { ok: !['outcome_unknown', 'failed', 'cancelled', 'no_usable_sources'].includes(job.status), status: job.status, job, reused: true };
      if (stopped()) return fail('stopped', 'RESEARCH_STOPPED', '研究已停止，未送出請求。');
      const grant = configGrant(serverConfig); if (!grant.ok) return grant;
      if (!grant.data.allowed_kinds.includes(job.kind)) return fail('auth_required', 'RESEARCH_SCOPE_DENIED', '此研究操作未在伺服器授權範圍。');
      if (job.kind === 'fetch') {
        if (!validatePublicResearchUrl(job.request.body.url)) return fail('policy_blocked', 'PUBLIC_URL_REQUIRED', 'Fetch URL 未通過公開來源檢查。');
        const verification = await verifyFetchDns(new URL(job.request.body.url).hostname);
        if (!verification.ok) return verification;
        resolverProof = verification.proof;
      }
      const claim = tx(() => {
        job = normalizeJob(decode(jobRow(id)));
        if (job.status !== 'prepared') return { ok: false, status: job.status, job, reused: true };
        if (stopped()) return fail('stopped', 'RESEARCH_STOPPED', '研究已停止，未送出請求。');
        const current = configGrant(serverConfig); if (!current.ok) return current;
        const priorGrant = db.prepare('SELECT * FROM research_grants WHERE id=?').get(current.id);
        if (priorGrant && priorGrant.hash !== current.hash) return fail('auth_required', 'RESEARCH_GRANT_CHANGED', '同一研究授權識別的限制已改變，不建立新預留。');
        const unknown = db.prepare("SELECT job_id FROM research_requests WHERE request_hash=? AND state='outcome_unknown'").get(job.request_hash);
        if (unknown) return fail('outcome_unknown', 'PREVIOUS_RESEARCH_UNKNOWN', '相同研究先前結果未知；保留原預留，不以新幂等鍵重送。', { original_job_id: unknown.job_id });
        const cached = db.prepare('SELECT * FROM research_cache WHERE request_hash=? AND expires_at>?').get(job.request_hash, Date.now());
        if (cached) {
          const cachedResult = normalizeResult(decode(cached));
          const result = { ...cachedResult, snapshot_ids: job.snapshot_ids, cache_source_snapshot_ids: cachedResult.snapshot_ids };
          job = { ...job, status: result.status, result, evidence_ids: result.evidence_ids, from_cache: true, estimated_cost_usd: 0, completed_at: now() };
          saveJob(job); event('cache_hit', { job_id: job.id }); return { ok: result.status !== 'no_usable_sources', status: result.status, job, from_cache: true };
        }
        const used = ledger(current.id);
        if (used.requests_used >= current.data.max_requests || used.reserved_units + used.estimated_spent_units + PRICE_UNITS > current.budget_units) return fail('budget_blocked', 'RESEARCH_BUDGET_LIMIT', '研究已達請求數或全批次 USD 上限。');
        if (!priorGrant) db.prepare('INSERT INTO research_grants VALUES(?,?,?)').run(current.id, current.hash, JSON.stringify(current.data));
        requestId = `research_request_${hashObject(job.id).slice(0, 24)}`;
        const receipt = { id: requestId, job_id: job.id, request_hash: job.request_hash, grant_id: current.id, state: 'outcome_unknown', reserved_usd: PRICE_UNITS / UNIT, estimated_billed_usd: null, actual_cost_usd: null, created_at: now(), source: PROVENANCE.url };
        db.prepare('INSERT INTO research_requests VALUES(?,?,?,?,?,?,NULL,?)').run(requestId, job.id, current.id, job.request_hash, 'outcome_unknown', PRICE_UNITS, JSON.stringify(receipt));
        job = { ...job, status: 'outcome_unknown', request_id: requestId, started_at: now(), execution_enabled: true, ...(resolverProof ? { resolver_policy_hash: resolverPolicyHash, resolver_verification: resolverProof } : {}) };
        saveJob(job); event('request_reserved', { job_id: job.id, request_id: requestId, reserved_usd: PRICE_UNITS / UNIT });
        return { ok: true, send: true };
      });
      if (!claim.send) return claim;
      controller = new AbortController(); active.set(id, controller);
      const timeoutMs = Number.isInteger(serverConfig.timeout_ms) ? Math.max(50, Math.min(30000, serverConfig.timeout_ms)) : 15000;
      const maxBytes = Number.isInteger(serverConfig.response_max_bytes) ? Math.max(256, Math.min(2_000_000, serverConfig.response_max_bytes)) : 1_000_000;
      // Keep the deadline active until the complete bounded response body is read.
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl('https://api.deepseek.com' + job.request.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + serverConfig.api_key, 'Content-Type': 'application/json' }, body: JSON.stringify(job.request.body), redirect: 'error', signal: controller.signal });
      if (response.redirected || response.url && new URL(response.url).origin !== 'https://api.deepseek.com') throw new Error('REDIRECT_DENIED');
      if (response.status !== 200) {
        // Known HTTP failures are non-billable per documentation. Never read,
        // persist, or return a provider's raw error body.
        const code = response.status === 401 ? 'DEEPSEEK_AUTH_REQUIRED' : response.status === 402 ? 'DEEPSEEK_BALANCE_REQUIRED' : 'DEEPSEEK_HTTP_FAILED';
        tx(() => {
          const receipt = decode(db.prepare('SELECT * FROM research_requests WHERE id=?').get(requestId));
          const updated = { ...receipt, state: 'completed', reserved_usd: 0, estimated_billed_usd: 0, billing_basis: 'documented_non_200', completed_at: now() };
          db.prepare("UPDATE research_requests SET state='completed',billed_units=0,data=? WHERE id=?").run(JSON.stringify(updated), requestId);
          job = { ...job, status: 'failed', code, completed_at: now() }; saveJob(job); event('request_failed', { job_id: job.id, code, http: response.status });
        });
        return fail(response.status === 401 ? 'auth_required' : response.status === 402 ? 'budget_blocked' : 'failed', code, '研究服務未完成請求；不會自動重試或充值。', { job });
      }
      const data = await boundedJson(response, maxBytes);
      if (controller.signal.aborted) throw new Error('REQUEST_TIMEOUT');
      if (containsConfiguredSecret(data)) throw new Error('SENSITIVE_PROVIDER_RESPONSE');
      let result;
      tx(() => {
        const collected = collect(job, data);
        const providerEmpty = job.kind === 'search' ? data.results.length === 0 : !data.content.trim();
        const usable = collected.cards.length > 0;
        result = { evidence_ids: collected.cards.map((card) => card.id), evidence: collected.cards, exclusions: collected.exclusions, empty: providerEmpty, provider_empty: providerEmpty, usable_source_count: collected.cards.length, research_success: usable, status: usable || providerEmpty ? 'completed' : 'no_usable_sources', billing_basis: collected.billable ? 'documented_nonempty_200_estimate' : 'documented_empty_200', estimated_billed_usd: collected.billable ? PRICE_UNITS / UNIT : 0, actual_cost_usd: null, snapshot_ids: job.snapshot_ids };
        const receipt = decode(db.prepare('SELECT * FROM research_requests WHERE id=?').get(requestId));
        const updated = { ...receipt, state: 'completed', reserved_usd: 0, estimated_billed_usd: result.estimated_billed_usd, billing_basis: result.billing_basis, completed_at: now() };
        db.prepare("UPDATE research_requests SET state='completed',billed_units=?,data=? WHERE id=?").run(collected.billable ? PRICE_UNITS : 0, JSON.stringify(updated), requestId);
        job = { ...job, status: result.status, evidence_ids: result.evidence_ids, result, completed_at: now() }; saveJob(job);
        const ttl = Number.isInteger(serverConfig.cache_ttl_ms) ? Math.max(0, Math.min(7 * 86400000, serverConfig.cache_ttl_ms)) : 86400000;
        db.prepare('INSERT OR REPLACE INTO research_cache VALUES(?,?,?)').run(job.request_hash, Date.now() + ttl, JSON.stringify(result));
        event('research_completed', { job_id: job.id, evidence_ids: result.evidence_ids, estimated_billed_usd: result.estimated_billed_usd });
      });
      return { ok: result.status !== 'no_usable_sources', status: result.status, ...(result.status === 'no_usable_sources' ? { code: 'NO_USABLE_RESEARCH_SOURCES', reason: '供應商回傳了結果，但沒有來源通過目前門禁；費用估算仍保留，不能視為成功研究。' } : {}), job, result };
    } catch {
      if (requestId && !closed) safe(() => event('outcome_unknown', { job_id: id, request_id: requestId }));
      return fail(requestId ? 'outcome_unknown' : 'failed', requestId ? 'RESEARCH_OUTCOME_UNKNOWN' : 'RESEARCH_UNAVAILABLE', requestId ? '研究請求結果未知；原預留保留，不會重送。' : '研究暫時無法執行，未送出請求。', requestId ? { job_id: id, request_id: requestId, reserved_usd: PRICE_UNITS / UNIT } : {});
    } finally { if (timeout) clearTimeout(timeout); active.delete(id); }
  }
  /**
   * DeepSeek 思考模式（deepseek-flash，thinking 預設開啟）。只回傳模型輸出與用量，
   * 不建立證據卡、不寫詞典；費用按 usage 的 token 數結算（以尖峰價為上限），
   * 並受同一份有限授權的預算與請求數限制。
   */
  async function analyze(input = {}) {
    if (closed) return fail('closed', 'CLOSED', '研究帳本已關閉。');
    const parsed = analyzePlan(input, containsConfiguredSecret); if (!parsed.ok) return parsed;
    if (stopped()) return fail('stopped', 'RESEARCH_STOPPED', '研究批次已停止新增工作。');
    const requestHash = hashObject(parsed.request);
    const idem = hashObject(input.idempotency_key ?? `analyze:${requestHash}`);
    const jobId = `research_analyze_${idem.slice(0, 24)}`;
    const cached = db.prepare('SELECT * FROM research_cache WHERE request_hash=? AND expires_at>?').get(requestHash, Date.now());
    if (cached) {
      const previous = decode(cached);
      return { ok: true, status: 'completed', from_cache: true, job_id: jobId, content: previous.content, reasoning_content: previous.reasoning_content, usage: previous.usage, model: previous.model, finish_reason: previous.finish_reason, estimated_billed_usd: 0, actual_cost_usd: null, evidence_ids: [], long_term_taste_updated: false };
    }
    const grant = configGrant(serverConfig); if (!grant.ok) return grant;
    if (!grant.data.allowed_kinds.includes('analyze')) return fail('auth_required', 'RESEARCH_SCOPE_DENIED', '此研究操作未在伺服器授權範圍。');
    const reserve = analyzeReservation(parsed.request.body);
    let requestId, job, controller, timeout;
    try {
      const claim = tx(() => {
        const current = configGrant(serverConfig); if (!current.ok) return current;
        const priorGrant = db.prepare('SELECT * FROM research_grants WHERE id=?').get(current.id);
        if (priorGrant && priorGrant.hash !== current.hash) return fail('auth_required', 'RESEARCH_GRANT_CHANGED', '同一研究授權識別的限制已改變，不建立新預留。');
        const used = ledger(current.id);
        if (used.requests_used >= current.data.max_requests || used.reserved_units + used.estimated_spent_units + reserve > current.budget_units) return fail('budget_blocked', 'RESEARCH_BUDGET_LIMIT', '研究已達請求數或全批次 USD 上限。');
        if (!priorGrant) db.prepare('INSERT INTO research_grants VALUES(?,?,?)').run(current.id, current.hash, JSON.stringify(current.data));
        requestId = `research_request_${hashObject(jobId).slice(0, 24)}`;
        job = { id: jobId, kind: 'analyze', request: parsed.request, request_hash: requestHash, status: 'outcome_unknown', model: parsed.request.body.model, reasoning_effort: parsed.request.body.reasoning_effort, max_output_tokens: parsed.request.body.max_tokens, snapshot_ids: parsed.snapshots, reference_ids: parsed.references.map((ref) => ref.id || hashObject(ref).slice(0, 16)), reference_permissions: parsed.references, source_policy_version: '1.0.0', created_at: now(), estimated_cost_usd: reserve / UNIT, actual_cost_usd: null, evidence_ids: [], execution_enabled: true, request_id: requestId };
        db.prepare('INSERT OR REPLACE INTO research_jobs VALUES(?,?,?,?)').run(job.id, idem, requestHash, JSON.stringify(job));
        const receipt = { id: requestId, job_id: job.id, request_hash: requestHash, grant_id: current.id, state: 'outcome_unknown', reserved_usd: reserve / UNIT, estimated_billed_usd: null, actual_cost_usd: null, created_at: now(), source: PROVENANCE.url };
        db.prepare('INSERT OR REPLACE INTO research_requests VALUES(?,?,?,?,?,?,NULL,?)').run(requestId, job.id, current.id, requestHash, 'outcome_unknown', reserve, JSON.stringify(receipt));
        event('analysis_reserved', { job_id: job.id, request_id: requestId, reserved_usd: reserve / UNIT });
        return { ok: true, send: true };
      });
      if (!claim.send) return claim;
      controller = new AbortController(); active.set(jobId, controller);
      const timeoutMs = Number.isInteger(serverConfig.analyze_timeout_ms) ? Math.max(5000, Math.min(180000, serverConfig.analyze_timeout_ms)) : 90000;
      const maxBytes = Number.isInteger(serverConfig.response_max_bytes) ? Math.max(1024, Math.min(2_000_000, serverConfig.response_max_bytes)) : 1_000_000;
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl('https://api.deepseek.com' + ANALYZE_ENDPOINT, { method: 'POST', headers: { Authorization: 'Bearer ' + serverConfig.api_key, 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.request.body), redirect: 'error', signal: controller.signal });
      if (response.redirected || response.url && new URL(response.url).origin !== 'https://api.deepseek.com') throw new Error('REDIRECT_DENIED');
      if (response.status !== 200) {
        const code = response.status === 401 ? 'DEEPSEEK_AUTH_REQUIRED' : response.status === 402 ? 'DEEPSEEK_BALANCE_REQUIRED' : response.status === 429 ? 'DEEPSEEK_RATE_LIMITED' : 'DEEPSEEK_HTTP_FAILED';
        tx(() => {
          const receipt = decode(db.prepare('SELECT * FROM research_requests WHERE id=?').get(requestId));
          const updated = { ...receipt, state: 'completed', reserved_usd: 0, estimated_billed_usd: 0, billing_basis: 'documented_non_200', completed_at: now() };
          db.prepare("UPDATE research_requests SET state='completed',billed_units=0,data=? WHERE id=?").run(JSON.stringify(updated), requestId);
          job = { ...job, status: 'failed', code, completed_at: now() }; saveJob(job); event('analysis_failed', { job_id: job.id, code, http: response.status });
        });
        return fail(response.status === 401 ? 'auth_required' : response.status === 402 ? 'budget_blocked' : 'failed', code, '思考模式請求未完成；不會自動重試或充值。', { job_id: jobId });
      }
      const data = await boundedJson(response, maxBytes);
      if (controller.signal.aborted) throw new Error('REQUEST_TIMEOUT');
      if (containsConfiguredSecret(data)) throw new Error('SENSITIVE_PROVIDER_RESPONSE');
      const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
      const message = choice && OBJECT(choice.message) ? choice.message : null;
      if (!message || typeof message.content !== 'string') throw new Error('RESPONSE_SCHEMA');
      const content = message.content.slice(0, 12000);
      const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content.slice(0, 20000) : '';
      const rawUsage = OBJECT(data.usage) ? data.usage : null;
      const usage = rawUsage ? {
        prompt_tokens: Number(rawUsage.prompt_tokens) || 0,
        completion_tokens: Number(rawUsage.completion_tokens) || 0,
        prompt_cache_hit_tokens: Number(rawUsage.prompt_cache_hit_tokens) || 0,
        prompt_cache_miss_tokens: Number.isFinite(Number(rawUsage.prompt_cache_miss_tokens)) ? Number(rawUsage.prompt_cache_miss_tokens) : Math.max(0, (Number(rawUsage.prompt_tokens) || 0) - (Number(rawUsage.prompt_cache_hit_tokens) || 0)),
        total_tokens: Number(rawUsage.total_tokens) || 0,
      } : null;
      const charge = analyzeCharge(usage);
      const truncated = choice.finish_reason === 'length';
      const result = { content, reasoning_content: reasoning, model: typeof data.model === 'string' ? data.model : parsed.request.body.model, finish_reason: choice.finish_reason || null, truncated, usage, estimated_billed_usd: charge.units / UNIT, snapshot_ids: parsed.snapshots };
      // 思考模式的 reasoning 也吃 max_output_tokens；用光時只有 reasoning、沒有答案。
      // 不自動重試（會重複計費），把用量與 reasoning 回給呼叫端並要求調高上限。
      if (!content.trim()) {
        tx(() => {
          const receipt = decode(db.prepare('SELECT * FROM research_requests WHERE id=?').get(requestId));
          const updated = { ...receipt, state: 'completed', reserved_usd: 0, estimated_billed_usd: result.estimated_billed_usd, actual_cost_usd: null, billing_basis: 'token_usage_peak_price_upper_bound', completed_at: now() };
          db.prepare("UPDATE research_requests SET state='completed',billed_units=?,data=? WHERE id=?").run(charge.units, JSON.stringify(updated), requestId);
          job = { ...job, status: 'incomplete', result, actual_cost_usd: null, completed_at: now() }; saveJob(job);
          event('analysis_incomplete', { job_id: job.id, max_output_tokens: parsed.request.body.max_tokens, completion_tokens: usage?.completion_tokens || 0 });
        });
        return { ok: false, status: 'incomplete', code: 'ANALYZE_OUTPUT_TRUNCATED', result, job_id: jobId, reasoning_content: reasoning, usage, estimated_billed_usd: result.estimated_billed_usd, advice: '思考模式把輸出上限用在 reasoning；請提高 max_output_tokens（例如 4096）後用新的 idempotency_key 重試，系統不會自動重送。' };
      }
      tx(() => {
        const receipt = decode(db.prepare('SELECT * FROM research_requests WHERE id=?').get(requestId));
        const updated = { ...receipt, state: 'completed', reserved_usd: 0, estimated_billed_usd: result.estimated_billed_usd, actual_cost_usd: null, billing_basis: 'token_usage_peak_price_upper_bound', completed_at: now() };
        db.prepare("UPDATE research_requests SET state='completed',billed_units=?,data=? WHERE id=?").run(charge.units, JSON.stringify(updated), requestId);
        job = { ...job, status: 'completed', result, actual_cost_usd: null, completed_at: now() }; saveJob(job);
        const ttl = Number.isInteger(serverConfig.cache_ttl_ms) ? Math.max(0, Math.min(7 * 86400000, serverConfig.cache_ttl_ms)) : 86400000;
        db.prepare('INSERT OR REPLACE INTO research_cache VALUES(?,?,?)').run(requestHash, Date.now() + ttl, JSON.stringify(result));
        event('analysis_completed', { job_id: job.id, estimated_billed_usd: result.estimated_billed_usd });
      });
      return { ok: true, status: 'completed', job_id: jobId, ...result, evidence_ids: [], long_term_taste_updated: false, instructions_executable: false };
    } catch {
      if (requestId && !closed) safe(() => event('analysis_outcome_unknown', { job_id: jobId, request_id: requestId }));
      return fail(requestId ? 'outcome_unknown' : 'failed', requestId ? 'RESEARCH_OUTCOME_UNKNOWN' : 'RESEARCH_UNAVAILABLE', requestId ? '思考模式請求結果未知；原預留保留，不會重送。' : '研究暫時無法執行，未送出請求。', requestId ? { job_id: jobId, request_id: requestId, reserved_usd: reserve / UNIT } : {});
    } finally { if (timeout) clearTimeout(timeout); active.delete(jobId); }
  }

  function importEvidence(input = {}) {
    return safe(() => {
      const allowed = ['source_url', 'title', 'summary', 'source', 'rights_status', 'ai_ingestion_allowed', 'facts', 'inferences', 'snapshot_ids'];
      if (!OBJECT(input) || Object.keys(input).some((key) => !allowed.includes(key)) || !validatePublicResearchUrl(input.source_url) || !safeText(input.summary, 6000) || !safeText(input.title || 'Untitled', 1000) || !safeText(input.source, 128) || typeof input.rights_status !== 'string' || typeof input.ai_ingestion_allowed !== 'boolean' || hasSensitive(input) || containsConfiguredSecret(input)) return invalid('人工證據卡需要公開 URL、摘要、來源、權利狀態與明確 AI 許可；不接收私人資料。');
      if (/spotify/i.test(JSON.stringify(input))) return fail('policy_blocked', 'SPOTIFY_EVIDENCE', 'Spotify 或其衍生內容不能匯入研究資料流。');
      if (input.ai_ingestion_allowed && !RIGHTS.has(input.rights_status)) return fail('policy_blocked', 'EVIDENCE_RIGHTS_UNKNOWN', 'AI 許可與來源權利狀態不符。');
      for (const key of ['facts', 'inferences']) if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 30 || input[key].some((item) => !safeText(item, 2000)))) return invalid('facts/inferences 必須是有限的文字陣列。');
      const snapshots = validSnapshots(input.snapshot_ids); if (!snapshots.ok) return snapshots;
      const card = tx(() => {
        const card = saveEvidence({ source: input.source, source_url: input.source_url, title: input.title || 'Untitled', summary: input.summary, rights_status: input.rights_status, ai_ingestion_allowed: input.ai_ingestion_allowed, allowed_use: input.ai_ingestion_allowed ? ['local_research', 'reviewed_term_candidates'] : ['source_navigation', 'human_source_review'], facts: (input.facts || []).map((text) => ({ text, label: 'human_supplied_fact_unverified', evidence_url: input.source_url })), inferences: (input.inferences || []).map((text) => ({ text, label: 'human_supplied_inference', evidence_url: input.source_url })), snapshot_ids: snapshots.value, review_status: 'human_supplied_not_independently_verified' });
        event('evidence_imported', { evidence_id: card.id }); return card;
      });
      return { ok: true, status: 'imported', evidence: card };
    });
  }
  function proposeTerms(input = {}) {
    return safe(() => {
      if (!OBJECT(input) || Object.keys(input).some((key) => !['evidence_ids', 'terms', 'parent_dictionary_version'].includes(key)) || !Array.isArray(input.evidence_ids) || !input.evidence_ids.length || input.evidence_ids.length > 30 || input.evidence_ids.some((id) => !safeText(id, 128)) || !Array.isArray(input.terms) || !input.terms.length || input.terms.length > 30 || !safeText(input.parent_dictionary_version, 128) || hasSensitive(input) || containsConfiguredSecret(input)) return invalid('詞條候選需要證據 ID、有限詞條陣列與父詞典版本。');
      const evidence = input.evidence_ids.map((id) => decode(db.prepare('SELECT * FROM research_evidence WHERE id=?').get(id)));
      if (evidence.some((card) => !card)) return fail('not_found', 'EVIDENCE_NOT_FOUND', '找不到部分證據卡。');
      if (evidence.some((card) => hashObject(card.snapshot_ids) !== hashObject(evidence[0].snapshot_ids))) return fail('conflict', 'EVIDENCE_SNAPSHOT_MISMATCH', '來源卡版本不同，不能靜默用第一張卡的版本建立詞條候選。');
      const policy = validateReferences(evidence.map((card) => ({ source: card.source, source_url: card.source_url, rights_status: card.rights_status, ai_ingestion_allowed: card.ai_ingestion_allowed }))); if (!policy.ok) return policy;
      const ids = new Set();
      for (const term of input.terms) {
        if (!OBJECT(term) || Object.keys(term).some((key) => !['term_id', 'zh', 'en', 'dimension', 'definition', 'base_weight'].includes(key)) || !['term_id', 'zh', 'en', 'dimension', 'definition'].every((key) => safeText(term[key], key === 'definition' ? 2000 : 256)) || term.base_weight !== undefined && (typeof term.base_weight !== 'number' || !Number.isFinite(term.base_weight) || term.base_weight < 0 || term.base_weight > 1) || ids.has(term.term_id)) return invalid('每個候選詞條需要唯一 term_id、zh/en、dimension、definition 與 0–1 權重。');
        ids.add(term.term_id);
      }
      const payload = { parent_dictionary_version: input.parent_dictionary_version, evidence_ids: [...input.evidence_ids].sort(), terms: input.terms.map((term) => ({ ...copy(term), source_type: 'research_candidate', evidence_refs: [...input.evidence_ids], confidence: 'inference_requires_human_review', base_weight: term.base_weight ?? 0.5, model_mappings: {}, hard_constraint: false })), snapshot_ids: evidence[0].snapshot_ids, source_policy_version: '1.0.0' };
      const id = `term_candidate_${hashObject(payload).slice(0, 24)}`;
      const previous = decode(db.prepare('SELECT * FROM research_candidates WHERE id=?').get(id));
      if (previous) return { ok: true, status: previous.status, candidate: previous, reused: true };
      const candidate = { ...payload, id, status: 'awaiting_review', created_at: now(), automatically_applied: false, long_term_taste_updated: false };
      tx(() => { db.prepare('INSERT INTO research_candidates VALUES(?,?)').run(id, JSON.stringify(candidate)); event('term_candidate_prepared', { candidate_id: id }); });
      return { ok: true, status: 'awaiting_review', candidate };
    });
  }
  function reviewCandidate(input = {}) {
    return safe(() => {
      if (!OBJECT(input) || Object.keys(input).some((key) => !['candidate_id', 'approved', 'review_note', 'reviewed_by'].includes(key)) || !safeText(input.candidate_id, 128) || typeof input.approved !== 'boolean' || !safeText(input.review_note, 2000) || input.reviewed_by !== 'user') return invalid('詞條審閱需要使用者明確選擇、評語及 reviewed_by=user。');
      const candidate = decode(db.prepare('SELECT * FROM research_candidates WHERE id=?').get(input.candidate_id));
      if (!candidate) return fail('not_found', 'CANDIDATE_NOT_FOUND', '找不到詞條候選。');
      if (candidate.status !== 'awaiting_review') return { ok: true, status: candidate.status, candidate, reused: true };
      const status = input.approved ? 'approved_candidate' : 'rejected';
      let snapshot = null;
      tx(() => {
        if (input.approved) {
          const payload = { parent_version: candidate.parent_dictionary_version, terms: candidate.terms, evidence_ids: candidate.evidence_ids, snapshot_ids: candidate.snapshot_ids, compiler_dictionary_changed: false, long_term_taste_updated: false, status: 'approved_candidate_not_installed' };
          const hash = hashObject(payload);
          snapshot = { ...payload, id: `research_dictionary_${hash.slice(0, 24)}`, version: `${candidate.parent_dictionary_version}+research.${hash.slice(0, 12)}`, hash, reviewed_at: now(), reviewed_by: 'user' };
          db.prepare('INSERT OR IGNORE INTO research_snapshots VALUES(?,?)').run(snapshot.id, JSON.stringify(snapshot));
          snapshot = decode(db.prepare('SELECT * FROM research_snapshots WHERE id=?').get(snapshot.id));
        }
        Object.assign(candidate, { status, review_note: input.review_note, reviewed_by: 'user', reviewed_at: now(), dictionary_snapshot_id: snapshot?.id || null });
        db.prepare('UPDATE research_candidates SET data=? WHERE id=?').run(JSON.stringify(candidate), candidate.id);
        event('term_candidate_reviewed', { candidate_id: candidate.id, status, dictionary_snapshot_id: snapshot?.id || null });
      });
      return { ok: true, status, candidate, dictionary_snapshot: snapshot, compiler_dictionary_changed: false, long_term_taste_updated: false };
    });
  }
  return {
    prepare,
    prepareFetch(input = {}) { return prepare({ ...input, kind: 'fetch' }); },
    run, analyze, importEvidence, proposeTerms, reviewCandidate,
    getJob(id) { return safe(() => { if (!safeText(id, 128)) return invalid('需要工作 ID。'); const job = normalizeJob(decode(jobRow(id))); return job ? { ok: true, status: job.status, job } : fail('not_found', 'JOB_NOT_FOUND', '找不到研究工作。'); }); },
    getEvidence(id) { return safe(() => { if (!safeText(id, 128)) return invalid('需要證據 ID。'); const evidence = decode(db.prepare('SELECT * FROM research_evidence WHERE id=?').get(id)); return evidence ? { ok: true, evidence } : fail('not_found', 'EVIDENCE_NOT_FOUND', '找不到證據卡。'); }); },
    getSnapshot(id) { return safe(() => { if (!safeText(id, 128)) return invalid('需要快照 ID。'); const snapshot = decode(db.prepare('SELECT * FROM research_snapshots WHERE id=?').get(id)); return snapshot ? { ok: true, snapshot } : fail('not_found', 'SNAPSHOT_NOT_FOUND', '找不到詞典候選快照。'); }); },
    listJobs() { return safe(() => ({ ok: true, jobs: db.prepare('SELECT data FROM research_jobs ORDER BY rowid DESC LIMIT 100').all().map(row => normalizeJob(decode(row))) })); },
    library() { return safe(() => ({ ok: true,
      jobs: db.prepare('SELECT data FROM research_jobs ORDER BY rowid DESC LIMIT 50').all().map(row => normalizeJob(decode(row))),
      evidence: db.prepare('SELECT data FROM research_evidence ORDER BY rowid DESC LIMIT 100').all().map(decode),
      candidates: db.prepare('SELECT data FROM research_candidates ORDER BY rowid DESC LIMIT 50').all().map(decode),
      snapshots: db.prepare('SELECT data FROM research_snapshots ORDER BY rowid DESC LIMIT 50').all().map(decode),
    })); },
    events({ since = 0 } = {}) { return safe(() => ({ ok: true, events: db.prepare('SELECT * FROM research_events WHERE seq>? ORDER BY seq LIMIT 200').all(Number.isSafeInteger(since) && since >= 0 ? since : 0).map((row) => ({ seq: row.seq, at: row.at, type: row.type, data: JSON.parse(row.data) })) })); },
    summary() { return safe(() => {
      const grant = configGrant(serverConfig);
      const current = grant.ok ? ledger(grant.id) : null;
      const grantHistory = db.prepare('SELECT id,data FROM research_grants ORDER BY rowid').all().map((row) => { const saved = JSON.parse(row.data); const used = ledger(row.id); return { grant_id: row.id, budget_usd: saved.budget_usd, max_requests: saved.max_requests, requests_used: used.requests_used, reserved_usd: used.reserved_units / UNIT, estimated_spent_usd: used.estimated_spent_units / UNIT, actual_spent_usd: null, unknown_requests: used.unknown_requests }; });
      return { ok: true, status: stopped() ? 'stopped' : grant.ok ? 'ready' : grant.status, execution_enabled: !stopped() && grant.ok, authorization_code: grant.ok ? null : grant.code, grant: grant.ok ? { id: grant.id, ...grant.data } : null,
        budget: current ? { max_usd: grant.data.budget_usd, requests_used: current.requests_used, max_requests: grant.data.max_requests, reserved_usd: current.reserved_units / UNIT, estimated_spent_usd: current.estimated_spent_units / UNIT, actual_spent_usd: null, available_usd: (grant.budget_units - current.reserved_units - current.estimated_spent_units) / UNIT, unknown_requests: current.unknown_requests } : null,
        ledger: grantHistory, pending_jobs: db.prepare("SELECT count(*) AS n FROM research_jobs WHERE json_extract(data,'$.status')='prepared'").get().n };
    }); },
    stop() { return safe(() => { tx(() => { db.prepare("INSERT OR REPLACE INTO research_settings VALUES('stopped','true')").run(); event('research_stopped', { active_request_count: active.size, remote_cancellation_confirmed: false }); }); for (const controller of active.values()) controller.abort(); return { ok: true, status: 'stopped', remote_cancellation_confirmed: false, message: '停止後續研究；已送出請求可能仍在服務端執行，未知預留保留。' }; }); },
    close() { if (!closed) { for (const controller of active.values()) controller.abort(); closed = true; db.close(); } },
  };
}
