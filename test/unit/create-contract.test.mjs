import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREATE_INPUT_SCHEMA, getCreateCapabilities, prepareCreateRequest, createRequestHash } from '../../agent/lib/create-contract.mjs';

const asset = (payload, extra = {}) => ({ payload, source: 'user_independent', rights_status: 'owned', ai_ingestion_allowed: true, ...extra });
const song = () => asset({ name: 'Owned reference', ref: 'music', libId: 'so_test' });
const minimalScore = () => ({ bpm: 120, end: 4, meters: [{ s: 0, n: 4, d: 4 }], keys: [{ s: 0, f: 0, minor: false }], chords: [{ s: 0, sym: 'C' }], sections: [{ s: 0, name: 'verse' }], tracks: { vocal: { notes: [{ p: 60, s: 0, d: 1, v: 0.8 }], tuplets: [] }, ins: { notes: [], tuplets: [] } } });

test('Create contract documents actual frontend schema and read-only crosscheck without enabling submissions', () => {
  const caps = getCreateCapabilities();
  assert.equal(caps.evidence_status, 'frontend_observed');
  assert.equal(caps.server_acceptance_verified, false);
  assert.equal(caps.submission_enabled, false);
  assert.equal(caps.readonly_status_crosscheck.generation_post, false);
  assert.equal(caps.models.length, 3);
  assert.ok(caps.discovered_models.every((model) => model.hidden && !model.supported));
  assert.ok(caps.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256) && source.captured_at.endsWith('Z')));
  assert.deepEqual(Object.keys(CREATE_INPUT_SCHEMA.properties.step.properties), ['mode', 'duration_sec', 'bpm', 'time_signature', 'key', 'negative', 'thinking', 'cover', 'remix', 'start_sec', 'end_sec']);
  assert.equal(CREATE_INPUT_SCHEMA.additionalProperties, false);
  caps.models[0].limits.style = 1;
  assert.equal(getCreateCapabilities().models[0].limits.style, 1000);
});

test('Idea supports all native frontend fields while stripping permission metadata', () => {
  const result = prepareCreateRequest({ mode: 'idea', model: 'acemusic-v1.1', prompt: 'subtle swing', created_at: 1794820000000,
    references: [song()], media: [asset({ kind: 'file', id: 'media_test', name: 'image.png' }), asset({ kind: 'link', url: 'https://example.com/visual' })],
    covers: [asset({ id: 'cover_a' }), asset({ id: 'cover_b' })], analytics: { attempt_id: 'attempt_1', requested_model: 'acemusic-v1.1' } });
  assert.equal(result.ok, true);
  assert.equal(result.request.endpoint, '/api/idea');
  assert.deepEqual(result.request.body.references, [{ name: 'Owned reference', ref: 'music', libId: 'so_test' }]);
  assert.deepEqual(result.request.body.covers, ['cover_a', 'cover_b']);
  assert.equal(result.has_references, true);
  assert.equal(result.has_upload, false);
  assert.doesNotMatch(JSON.stringify(result.request), /rights_status|ai_ingestion_allowed|user_independent/);
  assert.equal(result.request_hash, createRequestHash(result.request));
  const changed = structuredClone(result.request); changed.body.prompt = 'different';
  assert.notEqual(createRequestHash(changed), result.request_hash);
});

test('Custom v1/v1.1 fields retain lyricsMode, title, influences and conditional HD controls', () => {
  const hd = prepareCreateRequest({ mode: 'custom', model: 'acemusic-v1', style: 'slow dry drums', lyrics: '', title: 'Test', style_influence: 95, hd: { duration_sec: 600, negative: 'no bright cymbals' } });
  assert.equal(hd.ok, true);
  assert.equal(hd.request.endpoint, '/api/custom');
  assert.equal(hd.request.body.mode, 'cover');
  assert.equal(hd.request.body.style_influence, 95);
  assert.deepEqual(hd.request.body.hd, { duration_sec: 600, negative: 'no bright cymbals' });
  const mash = prepareCreateRequest({ mode: 'custom', model: 'acemusic-v1.1', custom_mode: 'mashup', references: [song(), song()], lyricsMode: 'mashup', audio_influence: 0, style_influence: 100 });
  assert.equal(mash.ok, true);
  assert.equal(mash.request.body.audio_influence, 0);
  assert.equal(mash.request.body.lyricsMode, 'mashup');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'acemusic-v1.1', style: 'x', hd: { duration_sec: 60 } }).status, 'unsupported');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'acemusic-v1', style: 'x', audio_influence: 50 }).status, 'unsupported');
});

test('Step Standard includes every supported option with independent, source-gated Advanced reference', () => {
  const result = prepareCreateRequest({ mode: 'custom', model: 'ace-step-v1.5-xl', style: 'dry drums', lyrics: '', step: { mode: 'standard', duration_sec: 240, bpm: 200, time_signature: '6/8', key: 'F# minor', negative: 'vocal', thinking: 70 }, step_reference: asset({ ref_url: 'https://assets.example/audio.wav' }) });
  assert.equal(result.ok, true);
  assert.equal(result.request.body.model, 'ace-step-1.5-xl');
  assert.deepEqual(result.request.body.step, { mode: 'standard', duration_sec: 240, bpm: 200, time_signature: '6/8', key: 'F# minor', negative: 'vocal', thinking: 70, ref_url: 'https://assets.example/audio.wav' });
  assert.equal(result.request.body.style_influence, undefined);
  const off = prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', style: 'x', step: { mode: 'standard' } });
  assert.equal(off.request.body.step.thinking, undefined);
  const defaults = prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', style: 'x' });
  assert.equal(defaults.request.body.step.thinking, 70);
});

test('Step Cover maps to remix and Edit only sends its source/range controls', () => {
  const remix = prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', references: [song()], step: { mode: 'remix', key: 'C minor', cover: 0, remix: 100 }, step_reference: asset({ ref_song: 'so_ref', ref_song_of: 'so_parent' }) });
  assert.equal(remix.ok, true);
  assert.deepEqual(remix.request.body.step, { mode: 'remix', key: 'C minor', cover: 0, remix: 100, ref_song: 'so_ref', ref_song_of: 'so_parent' });
  const edit = prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', references: [song()], step: { mode: 'edit', start_sec: 10.25, end_sec: 14.5 } });
  assert.equal(edit.ok, true);
  assert.deepEqual(edit.request.body.step, { mode: 'edit', start_sec: 10.25, end_sec: 14.5 });
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', references: [song()], step: { mode: 'edit', start_sec: 1, end_sec: 1.5 } }).status, 'invalid');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', references: [song()], step: { mode: 'remix', bpm: 120 } }).status, 'unsupported');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', references: [song()], step: { mode: 'edit', start_sec: 1, end_sec: 3, thinking: 70 } }).status, 'unsupported');
});

test('Score/reference payload supports explicit notes, meter/key/chords/sections and server identifiers', () => {
  const refs = [asset({ name: 'Own score', ref: 'midi', score: minimalScore() }), asset({ name: 'Sheet', ref: 'sheet', contextId: 'ctx_test' }), asset({ ref: 'music', stemId: 'stem_1', stemOf: 'so_1', songSlug: 'public-song' })];
  const result = prepareCreateRequest({ mode: 'idea', model: 'acemusic-v1.1', prompt: 'x', references: refs });
  assert.equal(result.ok, true);
  assert.deepEqual(result.request.body.references[0].score, minimalScore());
  const invalidScore = minimalScore(); invalidScore.tracks.vocal.notes[0].p = 500;
  assert.equal(prepareCreateRequest({ mode: 'idea', references: [asset({ ref: 'midi', score: invalidScore })] }).status, 'invalid');
  assert.equal(prepareCreateRequest({ mode: 'idea', references: [asset({ ref: 'music', stemId: 'stem_1' })] }).status, 'invalid');
});

test('Policies run before body assembly for all references, media, covers and Step reference', () => {
  const banned = (payload) => asset(payload, { source: 'derived_from_spotify' });
  for (const extra of [
    { references: [banned({ ref: 'music', libId: 'so_test' })] },
    { media: [banned({ kind: 'link', url: 'https://example.com' })] },
    { covers: [banned({ id: 'cover_a' }), asset({ id: 'cover_b' })] },
  ]) {
    const result = prepareCreateRequest({ mode: 'idea', prompt: 'x', ...extra });
    assert.equal(result.status, 'policy_blocked');
    assert.equal(result.request, undefined);
  }
  const step = prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', style: 'x', step_reference: banned({ ref_url: 'https://example.com/audio.wav' }) });
  assert.equal(step.status, 'policy_blocked');
  for (const references of [[{ ref: 'music', libId: 'so_test' }], [asset({ ref: 'music', libId: 'so_test' }, { ai_ingestion_allowed: 'true' })], [asset({ ref: 'music', libId: 'so_test' }, { rights_status: 'unknown' })]]) {
    assert.equal(prepareCreateRequest({ mode: 'idea', prompt: 'x', references }).status, 'policy_blocked');
  }
});

test('Length validation counts trimmed Unicode code points and never truncates', () => {
  const emoji = '🎵'.repeat(512);
  const valid = prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', style: ` ${emoji} ` });
  assert.equal(valid.ok, true);
  assert.equal(valid.request.body.style, emoji);
  const long = prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', style: '🎵'.repeat(513) });
  assert.equal(long.status, 'invalid');
  assert.equal(long.count, 513);
  assert.equal(long.limit, 512);
  assert.equal(long.request, undefined);
});

test('Unsupported model switches, conflicting controls and unknown fields cannot disappear silently', () => {
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'acemusic-v1', references: [song()] }).status, 'needs_recompile');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', custom_mode: 'mashup', references: [song(), song()] }).status, 'needs_recompile');
  assert.equal(prepareCreateRequest({ mode: 'idea', model: 'ace-step-1.5-xl', references: [asset({ ref: 'sheet', contextId: 'ctx_1' })] }).status, 'needs_recompile');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-turbo', style: 'x' }).status, 'unsupported');
  for (const extra of [{ step: { mode: 'standard' } }, { hd: { duration_sec: 60 } }, { fake: true }, { seed: 42 }, { endpoint: '/api/songs' }]) assert.equal(prepareCreateRequest({ mode: 'idea', prompt: 'x', ...extra }).status, 'unsupported');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', style: 'x', step: { mode: 'standard', bpm: 300 } }).status, 'invalid');
  assert.equal(prepareCreateRequest({ mode: 'custom', model: 'ace-step-1.5-xl', style: 'x', step: { mode: 'standard', ref_url: 'https://example.com/x.wav' } }).status, 'unsupported');
});

test('Native payload form remains permission-gated and uses exactly the same request/hash', () => {
  const top = prepareCreateRequest({ mode: 'custom', custom_mode: 'cover', model: 'acemusic-v1.1', style: 'dry drums', references: [song()], audio_influence: 22 });
  const native = prepareCreateRequest({ surface: 'custom', payload: { mode: 'cover', model: 'acemusic-v1.1', style: 'dry drums', references: [song()], audio_influence: 22 } });
  assert.equal(native.ok, true);
  assert.deepEqual(top.request, native.request);
  assert.equal(top.request_hash, native.request_hash);
  assert.equal(prepareCreateRequest({ surface: 'custom', style: 'ignored', payload: { style: 'x' } }).status, 'invalid');
  assert.equal(prepareCreateRequest({ surface: 'idea', payload: { prompt: 'x', references: [{ ref: 'music', libId: 'so_x' }] } }).status, 'policy_blocked');
});

test('Credentials, local paths, private URLs and unrecognized permission metadata are rejected', () => {
  for (const prompt of ['Bearer an-example-private-token', 'C:\\private\\track.wav', 'file:///music/a.wav', 'https://person:password@example.com/a']) assert.equal(prepareCreateRequest({ mode: 'idea', prompt }).status, 'policy_blocked');
  assert.equal(prepareCreateRequest({ mode: 'idea', media: [asset({ kind: 'link', url: 'https://127.0.0.1/x' })] }).status, 'invalid');
  assert.equal(prepareCreateRequest({ mode: 'idea', references: [asset({ ref: 'music', libId: 'so_x' }, { override_policy: true })] }).status, 'unsupported');
});

test('Malformed JSON shapes fail without throwing or silently selecting a model', () => {
  for (const input of [null, [], false, 'x', { mode: 'custom', style: 'x', model: null }, { mode: 'custom', style: 'x', step: null, model: 'ace-step-1.5-xl' }, { mode: 'idea', prompt: 'x', references: 'raw' }, { mode: 'custom', style: 'x', custom_mode: false }]) {
    assert.doesNotThrow(() => prepareCreateRequest(input));
    assert.equal(prepareCreateRequest(input).ok, false);
  }
  assert.equal(Object.isFrozen(CREATE_INPUT_SCHEMA.properties.step.properties), true);
});
