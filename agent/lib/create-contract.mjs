// Observed public Create frontend contract; does not read credentials, upload,
// fetch, submit, or imply that these private website routes are a public API.
import { hashObject, validateReferences } from '../music/core.mjs';

const copy = (value) => JSON.parse(JSON.stringify(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const deepFreeze = (value) => { Object.values(value).forEach((item) => { if (item && typeof item === 'object' && !Object.isFrozen(item)) deepFreeze(item); }); return Object.freeze(value); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = (reason, extra = {}) => ({ ok: false, status: 'invalid', reason, ...extra });
const unsupported = (reason, extra = {}) => ({ ok: false, status: 'unsupported', reason, ...extra });
export const createRequestHash = (request) => hashObject(request);
const SOURCES = [
  { url: 'https://acemusic.ai/public/app.js', captured_at: '2026-11-16T10:46:36.5265950Z', sha256: '60bc8a5bc638ee6c71e3a07a98fb9740b1f6e03ef63e838d3bd7f5f545ff7bf1', evidence: ['idea:2768-2771', 'custom:3167-3170', 'reference:1242-1245', 'advanced:970-1033', 'model-routing:450-471', 'reference-count:573-588', 'costs:222-223,471,2670-2673'] },
  { url: 'https://acemusic.ai/public/text-limit.js', captured_at: '2026-11-16T10:47:03.4667661Z', sha256: '46681008b583cffa79c7e9936726e7503c0d7dfa6a0a33ca8705c55d981afdaa', evidence: ['limits/count:1-12'] },
  { url: 'https://acemusic.ai/public/upload.js', captured_at: '2026-11-16T10:47:04.0415501Z', sha256: 'a55da765e4262610bed35bf5b77e4a4f48dfe3c5f1cbf07d68b43acf518e1ea1', evidence: ['limits:21-32', 'upload-protocol:143-159'] },
  { url: 'https://acemusic.ai/public/midi-editor.js', captured_at: '2026-11-16T10:47:50.7602279Z', sha256: 'a2f6d74a9dcb501d3f115e6b5b7b7999cf499220f140c553b7f3a851885f03a4', evidence: ['score:315-328', 'compose-focus:554-558'] },
  { url: 'https://acemusic.ai/public/play-flow.js', captured_at: '2026-11-16T10:48:15.2200097Z', sha256: '79200ae44cdcc801cf331c95333aea2c1d36544ea8eaaf4c3e0fb4ea1de98897', evidence: ['chords:632', 'between:827-841', 'recording:3412-3415'] },
];
const TARGETS = {
  'acemusic-v1': { id: 'acemusic-v1', group: 'hd', limits: { prompt: 2000, style: 1000, lyrics: 5000 } },
  'acemusic-v1.1': { id: 'acemusic-v1.1', group: 'reader', limits: { prompt: 2000, style: 1000, lyrics: 5000 } },
  'ace-step-1.5-xl': { id: 'ace-step-1.5-xl', group: 'step', limits: { prompt: 2000, style: 512, lyrics: 2000 } },
};
const DISCOVERED = ['ace-step-1.5-turbo', 'ace-step-1.5', 'ace-step-1.5-turbo-shift3', 'ace-step-1.5-legacy'];
const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].flatMap((note) => [`${note} major`, `${note} minor`]);
const METERS = ['2/4', '3/4', '4/4', '6/8'];
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const strictObject = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const noteSchema = strictObject({ p: { type: 'integer', minimum: 0, maximum: 127 }, s: num('Start in beats', { minimum: 0 }), d: num('Duration in beats', { exclusiveMinimum: 0 }), v: num('Velocity', { minimum: 0, maximum: 1 }) }, ['p', 's', 'd']);
const scoreSchema = strictObject({
  bpm: num('Score tempo; frontend default 120, server range unknown', { exclusiveMinimum: 0 }), end: num('Score end in beats', { minimum: 0 }),
  meters: { type: 'array', items: strictObject({ s: num('Beat', { minimum: 0 }), n: { type: 'integer', minimum: 1 }, d: { type: 'integer', minimum: 1 } }, ['s', 'n', 'd']) },
  keys: { type: 'array', items: strictObject({ s: num('Beat', { minimum: 0 }), f: { type: 'integer', minimum: -7, maximum: 7 }, minor: { type: 'boolean' } }, ['s', 'f', 'minor']) },
  chords: { type: 'array', items: strictObject({ s: num('Beat', { minimum: 0 }), sym: str('Chord symbol') }, ['s', 'sym']) },
  sections: { type: 'array', items: strictObject({ s: num('Beat', { minimum: 0 }), name: str('Section name') }, ['s', 'name']) },
  tracks: strictObject(Object.fromEntries(['vocal', 'ins'].map((track) => [track, strictObject({ notes: { type: 'array', items: noteSchema }, tuplets: { type: 'array', items: strictObject({ s: num('Beat', { minimum: 0 }), len: num('Tuplet span in beats', { exclusiveMinimum: 0 }) }, ['s', 'len']) } }, ['notes'])])), ['vocal', 'ins']),
}, ['bpm', 'tracks']);
const refSchema = strictObject({
  name: str('Reference label'), ref: { type: 'string', enum: ['music', 'record', 'midi', 'sheet'] },
  libId: str('Existing Library song/task id'), stemId: str('Existing stem id; pair with stemOf'), stemOf: str('Parent song id'),
  contextId: str('Existing uploaded recording/sheet context id'), songSlug: str('Existing shared song slug'),
  score: { ...scoreSchema, description: 'Only user-played or edited score; no raw audio/ABC field' },
}, ['ref']);
const mediaSchema = { oneOf: [strictObject({ kind: { const: 'file' }, id: str('Existing uploaded media id'), name: str('File label') }, ['kind', 'id', 'name']), strictObject({ kind: { const: 'link' }, url: str('Public HTTPS image/video/page URL') }, ['kind', 'url'])] };
const stepRefSchema = strictObject({ ref_url: str('Already uploaded public HTTPS reference audio URL'), ref_song: str('Existing Library song id'), ref_song_of: str('Parent song id if applicable') });
const wrapped = (payload, description) => strictObject({ payload, source: str('Independent allowed provenance; Spotify and derivatives are blocked'), rights_status: { type: 'string', enum: ['owned', 'user_owned', 'licensed', 'public_domain', 'generated', 'generated_owned', 'authorized'] }, ai_ingestion_allowed: { const: true } }, ['payload', 'source', 'rights_status', 'ai_ingestion_allowed']);
const percent = (description) => ({ type: 'integer', minimum: 0, maximum: 100, description });
const parameterProperties = {
  model: { type: 'string', enum: [...Object.keys(TARGETS), 'ace-step-v1.5-xl'], description: 'Requested model. No automatic substitution.' },
  prompt: str('Idea description; trim then count Unicode code points; maximum 2000'),
  style: str('Custom Style; v1/v1.1 1000, Step XL 512 Unicode code points'),
  lyrics: str('Custom Lyrics; v1/v1.1 5000, Step XL 2000 Unicode code points'),
  lyricsMode: { type: 'string', enum: ['own', 'mashup'], description: 'mashup only for Custom Mashup; own preserves supplied lyrics' },
  title: str('Custom title; no hard maximum observed in Create handler'),
  created_at: { type: 'integer', minimum: 0, description: 'Stable request timestamp in epoch milliseconds; browser always sends Date.now() and receives a pair' },
  references: { type: 'array', maxItems: 3, items: wrapped(refSchema, 'Authorized existing audio/melody/score reference') },
  media: { type: 'array', maxItems: 3, items: wrapped(mediaSchema, 'Idea-only authorized existing visual/link') },
  covers: { type: 'array', maxItems: 2, items: wrapped(strictObject({ id: str('Existing uploaded JPEG cover id') }, ['id']), 'Idea cover for each generated song; either zero or two') },
  audio_influence: percent('Non-Step Custom with references only; frontend default 60'),
  style_influence: percent('Non-Step Custom; frontend default 80'),
  step: strictObject({
    mode: { type: 'string', enum: ['standard', 'remix', 'edit'], description: 'Step XL only. standard requires no main references; remix/edit requires one song. UI Cover maps to remix.' },
    duration_sec: { type: 'integer', minimum: 10, maximum: 240, description: 'Step standard only; omit for Auto; UI step 10 seconds' },
    bpm: { type: 'integer', minimum: 30, maximum: 200, description: 'Step standard only; omit for Auto; UI step 5 BPM' },
    time_signature: { type: 'string', enum: METERS, description: 'Step standard only; omit for Auto' },
    key: { type: 'string', enum: KEYS, description: 'Step standard or remix only' },
    negative: str('Step standard only; text limit not observed'),
    thinking: percent('Step standard only; omit when Thinking off; frontend on/default strength 70'),
    cover: percent('Step remix only; default 20'), remix: percent('Step remix only; default 0'),
    start_sec: num('Step edit only; waveform range start, rounded to 2 decimals in frontend', { minimum: 0 }),
    end_sec: num('Step edit only; waveform range end; must be >= start_sec + 1', { exclusiveMinimum: 0 }),
  }, ['mode']),
  step_reference: wrapped(stepRefSchema, 'Optional independent Step Advanced reference audio; existing remote assets only'),
  hd: strictObject({ duration_sec: { type: 'integer', minimum: 30, maximum: 600, description: 'v1 Custom without refs/Assistant only; omit for Auto; UI step 10 seconds' }, negative: str('v1 Custom without refs/Assistant only; limit not observed') }),
  analytics: strictObject({ attempt_id: str('Optional attempt identifier; no credentials or local machine metadata'), requested_model: str('Must agree with requested model') }),
};
export const CREATE_INPUT_SCHEMA = deepFreeze(strictObject({
  mode: { type: 'string', enum: ['idea', 'custom'], description: 'Create surface; Custom uses custom_mode for its API mode' },
  custom_mode: { type: 'string', enum: ['cover', 'mashup'], description: 'Custom endpoint mode, default cover. No references means plain text generation.' },
  ...parameterProperties,
  surface: { type: 'string', enum: ['idea', 'custom'], description: 'Alternative native form: surface + payload. Do not mix with top-level request fields.' },
  payload: strictObject({ mode: { type: 'string', enum: ['cover', 'mashup'] }, ...parameterProperties }),
}));

const CAPABILITY = {
  ok: true, status: 'frontend_observed', evidence_status: 'frontend_observed',
  version: 'create-contract-1.0.0', ui_verified: false, server_acceptance_verified: false, submission_enabled: false,
  capture_method: 'Public GET downloads; captured_at is observed download completion (LastWriteTimeUtc)',
  sources: SOURCES,
  models: Object.values(TARGETS).map((model) => ({ ...model, evidence_status: 'frontend_observed', limits_condition: 'Public defaults/comments; authenticated /api/status models[*].limits can replace style/lyrics limits; re-read before submission' })),
  discovered_models: DISCOVERED.map((id) => ({ id, hidden: true, evidence_status: 'discovered', mapping: 'unknown', supported: false, reason: 'Hidden in authenticated status; no public workflow mapping. Never reuse XL controls silently.' })),
  readonly_status_crosscheck: { checked_at: '2026-11-16T10:53:59.960Z', http: 200, generation_post: false, compared_fields: ['models.id', 'models.reads', 'models.limits', 'models.free', 'models.hidden', 'costs'], result: 'Target model limits and groups match the frontend observations; live status is account/time-specific.' },
  costs: { source: 'GET /api/status costs + models[actual_model].free', observed_at: '2026-11-16T10:53:59.960Z', observed: { song: 4, video_minute: 1 }, condition: 'Frontend base = actual model free===true ? 0 : costs.song. Idea adds video_minute * ceil(uploaded-file-video seconds/60). Actual model changes, media-link cost, plan changes and final charges require revalidation; no blanket zero-cost promise.' },
  endpoints: [
    { method: 'POST', path: '/api/idea', fields: ['prompt', 'created_at', 'references', 'model', 'analytics', 'covers', 'media'], condition: 'Idea; no hd/step/Custom-only fields observed' },
    { method: 'POST', path: '/api/custom', fields: ['mode', 'references', 'style', 'lyrics', 'lyricsMode', 'title', 'audio_influence', 'style_influence', 'created_at', 'model', 'analytics', 'step', 'hd'], condition: 'Custom; step and hd mutually exclusive' },
  ],
  input_schema: CREATE_INPUT_SCHEMA,
  defaults: { custom_mode: 'cover', lyricsMode: 'own', influence: { audio: 60, style: 80, cover: 20, remix: 0, thinking: 70 } },
  limits: { references: { idea: 3, custom_cover: 1, custom_mashup: [2, 3] }, media: { idea: 3 }, covers: { idea: [0, 2] }, minimum_notes_for_recording: 4, v11_cover_seconds: 440, audio_upload_seconds: 480, step_reference_seconds: 480, video_seconds: 2400, count: 'Unicode code points after trim; never truncate', server_ranges_unverified: true },
  conditions: [
    'v1 references or Songwriting Assistant require the reader model; return needs_recompile rather than silently switch.',
    'v1.1 supports references/melody/sheet and Mashup; model actual value must still be re-read.',
    'Step XL Custom supports one audio Library song; MIDI, sheet/context and Mashup require reader model.',
    'Step standard sends duration_sec/bpm/time_signature/key/negative/ref/thinking; remix sends ref/key/cover/remix; edit sends ref/start_sec/end_sec.',
    'Step reference uses step_reference metadata wrapper; translated into ref_url OR ref_song with optional ref_song_of.',
    'hd only with v1 Custom, no references, no Assistant; duration_sec 30..600 and negative only.',
    'Audio/Style influence omitted for Step XL; audio_influence only with references; internal creative weights are never sent.',
  ],
  uploads: [
    { endpoint: '/api/upload-url', method: 'POST', fields: { endpoint: 'allowed upload endpoint', name: 'string', size: 'bytes' }, response_fields: ['direct', 'url', 'method', 'headers', 'token'], condition: 'Upload authorization required; not executed by prepareCreateRequest' },
    { endpoint: '/api/upload-raw', method: 'POST', body: 'audio bytes', headers: ['Content-Type', 'x-filename'], max_mb: 100, formats: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'] },
    { endpoint: '/api/import-raw', method: 'POST', fields: { id: 'upload id', ext: 'extension', title: 'string', created_at: 'epoch ms' }, condition: 'Creates Library item after raw upload' },
    { endpoint: '/api/import', method: 'POST', body: 'audio bytes', headers: ['Content-Type', 'x-filename', 'x-title', 'x-ref'], max_mb: 100, condition: 'Recording context; x-ref=record' },
    { endpoint: '/api/import-sheet', method: 'POST', body: 'sheet bytes', headers: ['Content-Type', 'x-filename'], max_mb_by_format: { mid: 2, midi: 2, musicxml: 10, xml: 10, mxl: 10 } },
    { endpoint: '/api/upload-media', method: 'POST', body: 'image/video bytes', headers: ['Content-Type', 'x-filename'], max_mb_by_kind: { image: 10, video: 1024 }, condition: 'Idea; video max 40 minutes' },
    { endpoint: '/api/upload-cover', method: 'POST', body: 'JPEG bytes', headers: ['Content-Type'], max_mb: 4, condition: 'Frontend generates two 1024px JPEG covers, one per song' },
    { endpoint: '/api/step/ref-audio', method: 'POST', body: 'audio bytes', headers: ['Content-Type', 'x-filename'], max_mb: 90, condition: 'Step Advanced reference; max 8 minutes' },
    { endpoint: '/api/songwriter/take', method: 'POST', body: 'WAV bytes', headers: ['Content-Type', 'x-filename', 'X-Bpm', 'X-Beats'], max_mb: 12, condition: 'Songwriting Assistant recording' },
    { endpoint: '/api/upload-check', method: 'POST', fields: { seconds: 'total pending audio seconds', longest: 'longest file seconds' }, condition: 'Plan capacity check; no upload implied' },
  ],
  helper_endpoints: [
    { method: 'GET', path: '/api/status', fields: [], reads: ['upload', 'cover', 'costs', 'models', 'user', 'plans'], anonymous_verification: '401; no session used' },
    { method: 'GET', path: '/api/melody', query: ['id', 'of', 'slug'], condition: 'id, id+of(stem), or slug(shared song)' },
    { method: 'GET', path: '/api/contexts', query: ['id'], reads: ['status', 'lyrics', 'score'], condition: 'Poll ready/failed context' },
    { method: 'GET', path: '/api/presets', query: ['kind', 'n'], condition: 'guides/melody/writer-new/writer-edit and other UI preset categories' },
    { method: 'POST', path: '/api/style-tags', fields: ['style', 'row'], condition: 'row is currently shown strings when partially refreshing' },
    { method: 'POST', path: '/api/style', fields: ['style', 'model', 'lyrics'], condition: 'model+lyrics only when v1 hdOpts' },
    { method: 'POST', path: '/api/lyrics', fields: ['request', 'style', 'lyrics', 'title', 'history', 'reference', 'model'], condition: 'model only when hdOpts; reference uses same refPayload' },
    { method: 'POST', path: '/api/compose', fields: ['score', 'request', 'focus', 'lyrics', 'style', 'useLyrics', 'loop'], condition: 'focus=null or {kind:section,s} or {kind:notes,start,end,track}; loop in beats' },
    { method: 'POST', path: '/api/keyboard-take', fields: ['notes', 'bpm'], condition: 'Quantizes captured notes onto inferred beats' },
    { method: 'POST', path: '/api/chords', fields: ['feels', 'seed', 'count', 'key', 'held'], condition: 'Assistant chord planning; seed is not an audio-generation seed' },
    { method: 'POST', path: '/api/chords/between', fields: ['prev', 'next', 'minor', 'level', 'seed', 'key', 'avoid'], condition: 'Assistant chord insertion/reroll only' },
  ],
  excluded_debug_fields: ['fake', 'fail', 'checks'],
  unknowns: ['Undocumented server fields and constraints', 'Current authenticated per-model limits/costs', 'API/automation authorization', 'Generation seed (no field observed in Create requests)', 'Title and negative-text server maxima', 'Actual model switching and real generation acceptance'],
};

export function getCreateCapabilities() { return copy(CAPABILITY); }
function keysOnly(value, allowed, label) {
  if (!object(value)) return invalid(`${label} 必須是物件。`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  return unknown.length ? unsupported(`${label} 含未核實的欄位，未忽略或提交。`, { fields: unknown }) : null;
}
function sensitive(value) {
  let text; try { text = JSON.stringify(value); } catch { return true; }
  return /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|cookie|session|token)\s*["']?\s*[:=]\s*["']?[^\s,;"']{8,}|https?:\/\/[^\s/]*@/i.test(text) || /(?:(?:^|[\s"'(])[A-Za-z]:[\\/]|\\\\[^\\]+\\|file:\/\/|\/(?:Users|home|mnt)\/)/i.test(text);
}
function publicUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      !/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[|::)/i.test(url.hostname) && !url.hostname.endsWith('.local');
  } catch { return false; }
}
function identifier(value) { return typeof value === 'string' && value.trim().length > 0 && /^[\p{L}\p{N}_.:@ -]+$/u.test(value) && value.length <= 512; }
function number(value, lo, hi, integer = true) { return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi && (!integer || Number.isInteger(value)); }
function count(value) { return [...value.trim()].length; }
function validateScore(score) {
  const error = keysOnly(score, ['bpm', 'end', 'meters', 'keys', 'chords', 'sections', 'tracks'], 'score');
  if (error) return error;
  if (!number(score.bpm, Number.MIN_VALUE, Infinity, false) || !object(score.tracks)) return invalid('score 需要正值 bpm 與 tracks。');
  const trackError = keysOnly(score.tracks, ['vocal', 'ins'], 'score.tracks');
  if (trackError) return trackError;
  for (const name of ['vocal', 'ins']) {
    const track = score.tracks[name];
    const trackKeys = keysOnly(track, ['notes', 'tuplets'], `score.tracks.${name}`);
    if (trackKeys) return trackKeys;
    if (!Array.isArray(track.notes) || track.notes.length > 20000) return invalid('score notes 必須是有限陣列。');
    for (const note of track.notes) {
      const noteKeys = keysOnly(note, ['p', 's', 'd', 'v'], 'note'); if (noteKeys) return noteKeys;
      if (!number(note.p, 0, 127) || !number(note.s, 0, Infinity, false) || !number(note.d, Number.MIN_VALUE, Infinity, false) || own(note, 'v') && !number(note.v, 0, 1, false)) return invalid('note 需要 MIDI p、非負起點 s、正值時長 d 與 0–1 v。');
    }
    if (track.tuplets !== undefined) {
      if (!Array.isArray(track.tuplets)) return invalid('tuplets 必須是陣列。');
      for (const tuplet of track.tuplets) { const error = keysOnly(tuplet, ['s', 'len'], 'tuplet'); if (error) return error; if (!number(tuplet.s, 0, Infinity, false) || !number(tuplet.len, Number.MIN_VALUE, Infinity, false)) return invalid('tuplet 需要 s 與正值 len。'); }
    }
  }
  if (own(score, 'end') && !number(score.end, 0, Infinity, false)) return invalid('score.end 必須非負。');
  for (const [key, fields] of Object.entries({ meters: ['s', 'n', 'd'], keys: ['s', 'f', 'minor'], chords: ['s', 'sym'], sections: ['s', 'name'] })) {
    if (!own(score, key)) continue;
    if (!Array.isArray(score[key])) return invalid(`score.${key} 必須是陣列。`);
    for (const item of score[key]) {
      const itemError = keysOnly(item, fields, `score.${key}`); if (itemError) return itemError;
      if (!number(item.s, 0, Infinity, false)) return invalid(`score.${key} 起點必須非負。`);
      if (key === 'meters' && (!number(item.n, 1, Infinity) || !number(item.d, 1, Infinity))) return invalid('meter 需要正整數 n/d。');
      if (key === 'keys' && (!number(item.f, -7, 7) || typeof item.minor !== 'boolean')) return invalid('key 需要 f=-7..7 與 minor boolean。');
      if (key === 'chords' && typeof item.sym !== 'string' || key === 'sections' && typeof item.name !== 'string') return invalid('chord/section 標籤必須是文字。');
    }
  }
  return null;
}
function unwrap(wrapper, label, allowed) {
  const wrapperError = keysOnly(wrapper, ['payload', 'source', 'rights_status', 'ai_ingestion_allowed'], label); if (wrapperError) return wrapperError;
  if (typeof wrapper.source !== 'string' || !wrapper.source.trim()) return invalid(`${label}.source 必須標明來源。`);
  const payloadError = keysOnly(wrapper.payload, allowed, `${label}.payload`); if (payloadError) return payloadError;
  return { ok: true, value: copy(wrapper.payload) };
}

export function prepareCreateRequest(input = {}) {
  if (!object(input)) return invalid('Create 輸入必須是物件。');
  if (sensitive(input)) return { ok: false, status: 'policy_blocked', reason: '輸入含本機路徑、憑據或 URL 帳密；不會放進 Create 請求。' };
  const topError = keysOnly(input, Object.keys(CREATE_INPUT_SCHEMA.properties), 'Create input'); if (topError) return topError;
  const native = own(input, 'payload');
  if (native && (!object(input.payload) || Object.keys(input).some((key) => !['surface', 'payload', 'mode'].includes(key)))) return invalid('原生 payload 形式只接受 surface、payload 與相同值的 mode。');
  const surface = native ? input.surface || input.mode : input.mode || input.surface || 'idea';
  if (!['idea', 'custom'].includes(surface)) return invalid('mode/surface 必須是 idea 或 custom。');
  if (input.surface && input.mode && input.surface !== input.mode) return invalid('mode 與 surface 互相衝突。');
  const data = native ? input.payload : Object.fromEntries(Object.entries(input).filter(([key]) => !['mode', 'surface'].includes(key)));
  const dataError = keysOnly(data, [...Object.keys(parameterProperties), 'custom_mode', ...(native ? ['mode'] : [])], 'Create fields'); if (dataError) return dataError;
  if (own(data, 'model') && (typeof data.model !== 'string' || !data.model)) return invalid('model 必須是已知模型識別文字。');
  const modelId = data.model === 'ace-step-v1.5-xl' ? 'ace-step-1.5-xl' : data.model ?? 'acemusic-v1.1';
  const model = TARGETS[modelId];
  if (!model) return unsupported(DISCOVERED.includes(modelId) ? '此模型已被發現，但尚無已核實的 Create 欄位映射。' : '此模型不在已核實 Create 能力中。', { requested_model: modelId });
  for (const key of ['references', 'media', 'covers']) if (own(data, key) && !Array.isArray(data[key])) return invalid(`${key} 必須是受權利包裝的陣列。`);
  const refInputs = data.references || [], mediaInputs = data.media || [], coverInputs = data.covers || [];
  const assetWrappers = [...refInputs, ...mediaInputs, ...coverInputs, ...(data.step_reference === undefined ? [] : [data.step_reference])];
  // Permission/provenance checks happen before a native body exists, including
  // nested payload content and derivatives of disallowed sources.
  const policy = validateReferences(assetWrappers); if (!policy.ok) return policy;
  const refs = [], media = [], covers = [];
  if (refInputs.length > 3 || mediaInputs.length > 3 || coverInputs.length > 2) return invalid('參考/視覺各最多 3 筆；封面最多 2 筆。');
  for (const wrapper of refInputs) {
    const result = unwrap(wrapper, 'reference', ['name', 'ref', 'libId', 'stemId', 'stemOf', 'contextId', 'songSlug', 'score']); if (!result.ok) return result;
    const ref = result.value;
    if (!['music', 'record', 'midi', 'sheet'].includes(ref.ref)) return invalid('reference.ref 必須是 music/record/midi/sheet。');
    for (const key of ['libId', 'stemId', 'stemOf', 'contextId', 'songSlug']) if (own(ref, key) && !identifier(ref[key])) return invalid(`reference.${key} 不是有效遠端資產識別。`);
    if (own(ref, 'name') && typeof ref.name !== 'string') return invalid('reference.name 必須是文字。');
    if (!!ref.stemId !== !!ref.stemOf) return invalid('stemId 與 stemOf 必須成對。');
    if (!ref.libId && !ref.stemId && !ref.contextId && !ref.songSlug && !ref.score) return invalid('reference 需要既有遠端資產識別或已驗證 score。');
    if (ref.score) { const scoreError = validateScore(ref.score); if (scoreError) return scoreError; }
    if (ref.ref === 'midi' && !ref.score) return invalid('midi reference 需要實際 score。');
    refs.push(ref);
  }
  for (const wrapper of mediaInputs) {
    const result = unwrap(wrapper, 'media', ['kind', 'id', 'name', 'url']); if (!result.ok) return result;
    const item = result.value;
    if (item.kind === 'file') { if (!identifier(item.id) || typeof item.name !== 'string' || own(item, 'url')) return invalid('file media 需要 id/name，不能混用 url。'); }
    else if (item.kind === 'link') { if (!publicUrl(item.url) || own(item, 'id') || own(item, 'name')) return invalid('link media 只接受公開 HTTPS url。'); }
    else return invalid('media.kind 必須是 file 或 link。');
    media.push(item);
  }
  for (const wrapper of coverInputs) { const result = unwrap(wrapper, 'cover', ['id']); if (!result.ok) return result; if (!identifier(result.value.id)) return invalid('cover 需要既有遠端 id。'); covers.push(result.value.id); }
  if (covers.length && covers.length !== 2) return invalid('前端將成對歌曲的封面一起送出，covers 必須是 0 或 2 筆。');
  if (covers.length && !media.length) return invalid('前端 covers 只來自 Idea media；缺少 media 來源。');
  let stepReference;
  if (data.step_reference !== undefined) {
    const result = unwrap(data.step_reference, 'step_reference', ['ref_url', 'ref_song', 'ref_song_of']); if (!result.ok) return result;
    stepReference = result.value;
    if (!!stepReference.ref_url === !!stepReference.ref_song || stepReference.ref_url && !publicUrl(stepReference.ref_url) || stepReference.ref_song && !identifier(stepReference.ref_song) || stepReference.ref_song_of && (!stepReference.ref_song || !identifier(stepReference.ref_song_of))) return invalid('Step reference 需 ref_url 或 ref_song 擇一；ref_song_of 僅能隨 ref_song。');
  }
  for (const key of ['prompt', 'style', 'lyrics', 'title']) if (own(data, key) && typeof data[key] !== 'string') return invalid(`${key} 必須是文字。`);
  for (const key of ['prompt', 'style', 'lyrics']) if (typeof data[key] === 'string' && count(data[key]) > model.limits[key]) return invalid(`${key} 超過此前端模型限制，不會截斷。`, { field: key, count: count(data[key]), limit: model.limits[key] });
  if (own(data, 'created_at') && !number(data.created_at, 0, Number.MAX_SAFE_INTEGER)) return invalid('created_at 必須是非負 epoch 毫秒整數。');
  let analytics;
  if (own(data, 'analytics')) {
    const analyticsError = keysOnly(data.analytics, ['attempt_id', 'requested_model'], 'analytics'); if (analyticsError) return analyticsError;
    if (own(data.analytics, 'attempt_id') && !identifier(data.analytics.attempt_id)) return invalid('analytics.attempt_id 必須是識別文字。');
    if (data.analytics.requested_model !== undefined && data.analytics.requested_model !== modelId) return invalid('analytics.requested_model 與請求模型不符。');
    analytics = copy(data.analytics);
  }
  const body = { model: modelId };
  if (own(data, 'created_at')) body.created_at = data.created_at;
  if (analytics) body.analytics = analytics;
  if (surface === 'idea') {
    const forbidden = ['style', 'lyrics', 'lyricsMode', 'title', 'custom_mode', 'mode', 'audio_influence', 'style_influence', 'step', 'step_reference', 'hd'].filter((key) => own(data, key));
    if (forbidden.length) return unsupported('Idea 前端沒有這些 Custom/Advanced 欄位，請改用 Custom。', { fields: forbidden });
    if (!(data.prompt || '').trim() && !refs.length && !media.length) return invalid('Idea 需要描述、參考或視覺素材。');
    const needsReader = refs.some((ref) => ref.ref !== 'music' || !!ref.score || !!ref.contextId);
    if (needsReader && model.group !== 'reader') return { ok: false, status: 'needs_recompile', reason: '旋律/譜面參考需要 ACE Music v1.1，請明確重選模型。', requested_model: modelId, required_model: 'acemusic-v1.1' };
    Object.assign(body, { prompt: (data.prompt || '').trim(), references: refs, media });
    if (covers.length) body.covers = covers;
  } else {
    if (own(data, 'prompt') || own(data, 'media') || own(data, 'covers')) return unsupported('Custom 前端不送 prompt/media/covers；請使用 Style、Lyrics 與 references。');
    const mode = data.custom_mode ?? (native ? data.mode : undefined) ?? 'cover';
    if (own(data, 'custom_mode') && typeof data.custom_mode !== 'string' || native && own(data, 'mode') && typeof data.mode !== 'string') return invalid('Custom mode 必須是 cover 或 mashup 文字。');
    if (data.custom_mode && native && data.mode && data.mode !== data.custom_mode) return invalid('payload.mode 與 custom_mode 衝突。');
    if (!['cover', 'mashup'].includes(mode)) return unsupported('Custom mode 只核到 cover 與 mashup；Step 工作流放在 step.mode。');
    if (mode === 'cover' && refs.length > 1 || mode === 'mashup' && refs.length < 2) return invalid('Cover 最多一筆參考；Mashup 需要 2–3 筆。');
    if (data.lyricsMode !== undefined && !['own', 'mashup'].includes(data.lyricsMode)) return invalid('lyricsMode 必須是 own 或 mashup。');
    if (data.lyricsMode === 'mashup' && mode !== 'mashup') return invalid('lyricsMode=mashup 只能用於 Mashup。');
    if (!(data.style || '').trim() && !(mode === 'mashup' || refs[0]?.ref === 'music')) return invalid('純文字或旋律 Custom 需要 Style。');
    const readerRefs = refs.some((ref) => ref.ref !== 'music' || !!ref.score || !!ref.contextId);
    if ((model.group === 'hd' && refs.length || model.group === 'step' && (readerRefs || mode === 'mashup')) && model.group !== 'reader') return { ok: false, status: 'needs_recompile', reason: '目前參考/模式需要 ACE Music v1.1；不會靜默改模型。', requested_model: modelId, required_model: 'acemusic-v1.1' };
    Object.assign(body, { mode, references: refs, style: (data.style || '').trim(), lyrics: (data.lyrics || '').trim(), lyricsMode: data.lyricsMode || 'own' });
    if (data.title?.trim()) body.title = data.title.trim();
    if (model.group === 'step') {
      if (own(data, 'hd') || own(data, 'audio_influence') || own(data, 'style_influence')) return unsupported('Step XL 不接受此頁面的 hd、Audio influence 或 Style influence。');
      const step = data.step === undefined ? (refs.length ? { mode: 'remix' } : { mode: 'standard', thinking: 70 }) : data.step;
      const stepError = keysOnly(step, Object.keys(parameterProperties.step.properties), 'step'); if (stepError) return stepError;
      if (!['standard', 'remix', 'edit'].includes(step.mode)) return unsupported('step.mode 必須是 standard/remix/edit。');
      if (refs.length && step.mode === 'standard' || !refs.length && step.mode !== 'standard') return invalid('前端 Step Standard 沒有主參考；Cover/Edit 需要一首主參考歌曲。');
      const allowedByMode = { standard: ['mode', 'duration_sec', 'bpm', 'time_signature', 'key', 'negative', 'thinking'], remix: ['mode', 'key', 'cover', 'remix'], edit: ['mode', 'start_sec', 'end_sec'] };
      const disallowed = Object.keys(step).filter((key) => !allowedByMode[step.mode].includes(key));
      if (disallowed.length) return unsupported(`Step ${step.mode} 不傳這些控件；不會忽略。`, { fields: disallowed });
      if (own(step, 'duration_sec') && !number(step.duration_sec, 10, 240)) return invalid('Step duration_sec 必須是 10–240 秒整數。');
      if (own(step, 'bpm') && !number(step.bpm, 30, 200)) return invalid('Step bpm 必須是 30–200 整數。');
      if (own(step, 'time_signature') && !METERS.includes(step.time_signature)) return invalid('Step time_signature 不在前端選項中。');
      if (own(step, 'key') && !KEYS.includes(step.key)) return invalid('Step key 不在前端 24 調選項中。');
      if (own(step, 'negative') && typeof step.negative !== 'string') return invalid('Step negative 必須是文字。');
      for (const key of ['thinking', 'cover', 'remix']) if (own(step, key) && !number(step[key], 0, 100)) return invalid(`Step ${key} 必須是 0–100 整數。`);
      if (step.mode === 'edit' && (!number(step.start_sec, 0, Infinity, false) || !number(step.end_sec, step.start_sec + 1, Infinity, false))) return invalid('Edit 需要 start_sec/end_sec，選取區段至少一秒。');
      body.step = copy(step);
      if (body.step.mode === 'remix') { body.step.cover ??= 20; body.step.remix ??= 0; }
      // Omitting thinking is explicit Thinking-off. Never fill it back in.
      if (stepReference) Object.assign(body.step, stepReference);
    } else {
      if (own(data, 'step') || own(data, 'step_reference')) return unsupported('step 控件只適用 ACE-Step XL。');
      if (own(data, 'audio_influence') && !refs.length) return unsupported('沒有參考時前端不送 audio_influence。');
      for (const key of ['audio_influence', 'style_influence']) if (own(data, key) && !number(data[key], 0, 100)) return invalid(`${key} 必須是 0–100 整數。`);
      body.style_influence = data.style_influence ?? 80;
      if (refs.length) body.audio_influence = data.audio_influence ?? 60;
      if (own(data, 'hd')) {
        if (model.group !== 'hd' || refs.length) return unsupported('hd 只適用無參考的 ACE Music v1 Custom。');
        const hdError = keysOnly(data.hd, ['duration_sec', 'negative'], 'hd'); if (hdError) return hdError;
        if (own(data.hd, 'duration_sec') && !number(data.hd.duration_sec, 30, 600)) return invalid('v1 hd.duration_sec 必須是 30–600 秒整數。');
        if (own(data.hd, 'negative') && typeof data.hd.negative !== 'string') return invalid('hd.negative 必須是文字。');
        body.hd = copy(data.hd);
      }
    }
  }
  const request = { endpoint: surface === 'idea' ? '/api/idea' : '/api/custom', body };
  return { ok: true, status: 'prepared', evidence_status: 'frontend_observed', request, request_hash: createRequestHash(request), requested_model: modelId, mode: surface,
    has_upload: false, has_references: assetWrappers.length > 0, submission_enabled: false,
    requirements: ['實際提交須另有明確授權與經核實執行器。', '提交前重新核對目前模型、動態文字限制、credit 成本與帳戶能力。', ...(!own(body, 'created_at') ? ['提交前固定 created_at；公開前端每次均有此值，省略的服務端行為未測。'] : []), ...(assetWrappers.length ? ['來源門禁通過僅表示本地輸入條件；遠端素材讀取仍需在已授權範圍。'] : [])] };
}
