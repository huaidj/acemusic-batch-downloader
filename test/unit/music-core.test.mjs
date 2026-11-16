import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePrompt, dictionaryQuery, getCapabilities, prepareIntent, prepareGeneration, hashObject } from '../../agent/music/core.mjs';

const base = { natural_language: '重 sub 壓力、微搖擺、交錯打擊、克制變化、前後景深，無人聲', model: 'acemusic-v1.1', mode: 'idea', seed: 24 };
const session = { id: 'session_test', max_generations: 1, max_depth: 0, budget_limits: { ace_credits: 10 } };

test('music compiler: deterministic plan and bounded independent weights, all provenance identifiers fixed', () => {
  const first = compilePrompt(base);
  assert.equal(first.status, 'validated');
  assert.deepEqual(first, compilePrompt(base));
  assert.equal(first.plan.seeds.generation, null);
  assert.ok(first.plan.versions.dictionary_hash);
  assert.ok(first.plan.versions.taste_snapshot_hash);
  assert.ok(first.plan.versions.capability_snapshot_hash);
  assert.ok(first.plan.compiler_version);
  assert.equal(first.plan.estimated_cost.ace_credits, null);
  assert.doesNotMatch(first.plan.prompt_fields.prompt, /\([^)]*:\d/);
  const weighted = compilePrompt({ natural_language: 'instrumental', seed: 24, weights: { 'texture.organic': 0, 'texture.rough_metal': 0, 'texture.hybrid': 1 } });
  assert.equal(weighted.ok, true);
  assert.ok(weighted.plan.selected_terms.some((term) => term.term_id === 'texture.hybrid'));
  assert.ok(weighted.plan.exclusions.some((term) => term.term_id === 'texture.organic' && term.reason === 'zero_weight'));
});

test('music compiler: locks survive weight zero; conflicting explicit terms are rejected', () => {
  const locked = compilePrompt({ ...base, locked_term_ids: ['bass.centered_pulses'], weights: { 'bass.centered_pulses': 0 } });
  assert.equal(locked.ok, true);
  assert.ok(locked.plan.selected_terms.some((term) => term.term_id === 'bass.centered_pulses' && term.locked));
  assert.equal(compilePrompt({ ...base, locked_term_ids: ['voice.vocal'] }).status, 'conflict');
  assert.equal(compilePrompt({ ...base, locked_term_ids: ['missing'] }).status, 'invalid');
  assert.equal(compilePrompt({ ...base, mode: 'custom', lyrics: 'sing this' }).status, 'conflict');
});

test('music compiler respects no-vocal and negative requests instead of inverting their meaning', () => {
  const noVocal = compilePrompt({ natural_language: 'no lead vocals, micro-swing', seed: 3 });
  assert.equal(noVocal.ok, true);
  assert.ok(noVocal.plan.selected_terms.some((term) => term.term_id === 'voice.instrumental'));
  assert.ok(!noVocal.plan.selected_terms.some((term) => term.term_id === 'voice.vocal'));
  const constraint = compilePrompt({ natural_language: 'a slow groove', hard_constraints: ['no lead vocals'], weights: { 'voice.vocal': 1, 'voice.instrumental': 0 } });
  assert.ok(constraint.plan.selected_terms.some((term) => term.term_id === 'voice.instrumental' && term.locked));
  const negative = compilePrompt({ natural_language: 'not instrumental, micro-swing' });
  assert.ok(!negative.plan.selected_terms.some((term) => term.term_id === 'voice.instrumental'));
  assert.match(negative.plan.prompt_fields.prompt, /not instrumental/);
  assert.ok(negative.plan.exclusions.some((entry) => entry.reason === 'explicitly_excluded'));
  assert.equal(compilePrompt({ natural_language: 'not instrumental', locked_term_ids: ['voice.instrumental'] }).status, 'conflict');
  const chineseConstraint = compilePrompt({ natural_language: '微搖擺', hard_constraints: ['無人聲'] });
  assert.equal(chineseConstraint.status, 'validated');
  assert.doesNotMatch(chineseConstraint.plan.prompt_fields.prompt, /無人聲/);
});

test('music policy: source and derivative Spotify content cannot enter request assembly', () => {
  for (const reference of [
    { id: 'spotify', source: 'spotify', user_input: 'https://open.spotify.com/track/example' },
    { id: 'derived', source: 'user_description', derived_from: { original_source: 'Spotify metadata' }, description: 'copied title' },
    { id: 'unknown', source: 'file', rights_status: 'unknown' },
    { id: 'false-string', source: 'file', rights_status: 'owned', ai_ingestion_allowed: 'false' },
  ]) {
    const result = compilePrompt({ ...base, references: [{ rights_status: 'owned', ai_ingestion_allowed: true, ...reference }] });
    assert.equal(result.status, 'policy_blocked');
    assert.equal(result.plan, undefined);
    assert.equal(result.preview, undefined);
  }
  assert.equal(compilePrompt({ ...base, natural_language: 'use https://open.spotify.com/track/example' }).status, 'policy_blocked');
  assert.equal(compilePrompt({ ...base, references: false }).status, 'invalid');
  const allowed = compilePrompt({ ...base, references: [{ id: 'owned', source: 'user', rights_status: 'owned', ai_ingestion_allowed: true, description: 'A slow groove with dry drums.' }] });
  assert.match(allowed.plan.prompt_fields.prompt, /A slow groove with dry drums/);
});

test('music policy: credentials and URL userinfo never appear in compiled text', () => {
  assert.equal(compilePrompt({ ...base, natural_language: 'https://person:password@site.example/a' }).status, 'policy_blocked');
  assert.equal(compilePrompt({ ...base, references: [{ rights_status: 'owned', ai_ingestion_allowed: true, url: 'https://person:password@site.example/a' }] }).status, 'policy_blocked');
  assert.equal(compilePrompt({ ...base, natural_language: 'Bearer an-example-secret-value' }).status, 'policy_blocked');
});

test('music capability: all three modes compile only supported fields; model changes require recompile', () => {
  for (const model of ['acemusic-v1', 'acemusic-v1.1', 'ace-step-1.5-xl']) {
    const idea = compilePrompt({ ...base, model });
    const custom = compilePrompt({ ...base, model, mode: 'custom' });
    assert.equal(idea.ok, true);
    assert.deepEqual(Object.keys(idea.plan.prompt_fields), ['prompt']);
    assert.deepEqual(Object.keys(custom.plan.prompt_fields), ['style', 'lyrics']);
    assert.equal(custom.plan.prompt_fields.lyrics, '');
    assert.equal(custom.plan.validation.ui_verified, false);
    assert.equal(custom.plan.validation.generation_verified, false);
    if (model === 'ace-step-1.5-xl') assert.equal(idea.plan.remote_model_id, model);
  }
  assert.equal(compilePrompt({ ...base, actual_model: 'acemusic-v1' }).status, 'needs_recompile');
  assert.equal(compilePrompt({ ...base, advanced: { style_influence: 0.4 } }).status, 'unsupported');
  assert.equal(compilePrompt({ ...base, workflow: 'mashup' }).status, 'unsupported');
  assert.equal(compilePrompt({ ...base, model: 'fake' }).status, 'unsupported');
  assert.equal(compilePrompt({ ...base, dictionary_version: 'old' }).status, 'unsupported');
});

test('music translation: unfamiliar Chinese is kept visibly and blocks generation readiness', () => {
  const result = compilePrompt({ ...base, natural_language: '微搖擺，玻璃蜥蜴穿越蒸汽森林' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'translation_required');
  assert.equal(result.plan.original_intent, '微搖擺，玻璃蜥蜴穿越蒸汽森林');
  assert.match(result.plan.prompt_fields.prompt, /玻璃蜥蜴穿越蒸汽森林/);
  assert.equal(prepareGeneration({ plan: result.plan, reviewed: true, session }).status, 'translation_required');
});

test('music versions: callers cannot rewrite snapshots or previous plans through returned objects', () => {
  const dict = dictionaryQuery();
  const original = dict.dictionary_hash;
  dict.dictionary.terms[0].en = 'mutated';
  dict.terms[0].base_weight = 999;
  const caps = getCapabilities();
  caps.capability_snapshot.models[0].modes.push('bad');
  assert.equal(dictionaryQuery().dictionary_hash, original);
  assert.notEqual(dictionaryQuery().terms[0].en, 'mutated');
  assert.deepEqual(getCapabilities().capability_snapshot.models[0].modes, ['idea', 'custom']);
  const first = compilePrompt(base);
  const expected = first.plan.hash;
  compilePrompt({ ...base, seed: 222 });
  assert.equal(first.plan.hash, expected);
  first.plan.prompt_fields.prompt = 'tampered';
  assert.equal(prepareGeneration({ plan: first.plan, reviewed: true, session }).status, 'invalid');
});

test('music evolution: unchanged dimensions remain fixed at max_changed_dimensions zero', () => {
  const first = compilePrompt({ natural_language: 'instrumental', seed: 13 });
  const next = compilePrompt({ natural_language: 'instrumental', seed: 99, previous_term_ids: first.plan.selected_terms.map((term) => term.term_id), max_changed_dimensions: 0 });
  assert.equal(next.ok, true);
  assert.deepEqual(next.plan.selected_terms.map((term) => term.term_id).sort(), first.plan.selected_terms.map((term) => term.term_id).sort());
  assert.equal(next.plan.changes.length, 0);
});

test('music generation preparation: finite session, review, model and adapter gates never submit', () => {
  const plan = compilePrompt(base).plan;
  assert.equal(prepareGeneration({ plan, session }).status, 'awaiting_review');
  assert.equal(prepareGeneration({ plan, reviewed: true }).status, 'budget_blocked');
  assert.equal(prepareGeneration({ plan, reviewed: true, session, actual_model: 'acemusic-v1' }).status, 'needs_recompile');
  assert.equal(prepareGeneration({ plan, reviewed: true, session, adapter: 'mock' }).status, 'unsupported');
  assert.equal(prepareGeneration({ plan, reviewed: true, session: { ...session, stopped: true } }).status, 'cancelled');
  const ready = prepareGeneration({ plan, reviewed: true, session });
  assert.equal(ready.status, 'awaiting_authorization');
  assert.equal(ready.submission_enabled, false);
  assert.equal(ready.job.remote_task_id, null);
  assert.equal(ready.job.real_success, false);
  assert.deepEqual(ready, prepareGeneration({ plan, reviewed: true, session }));
});

test('music core validates ordinary malformed values without exceptions', () => {
  for (const input of [null, [], false, 'text', {}, { natural_language: 'x', weights: { 'bass.sub_pressure': '1' } }]) {
    assert.equal(compilePrompt(input).ok, false);
    assert.equal(prepareIntent(input).ok, false);
  }
  assert.equal(dictionaryQuery({ dimension: [] }).status, 'invalid');
  assert.equal(prepareGeneration(null).status, 'invalid');
  const plan = compilePrompt(base).plan;
  plan.requested_model = 'fake';
  const { hash, id, ...payload } = plan;
  plan.hash = hashObject(payload);
  plan.id = `plan_${plan.hash.slice(0, 20)}`;
  assert.equal(prepareGeneration({ plan, reviewed: true, session }).status, 'unsupported');
});

test('model field limits reject oversized compiled plans without truncating the direction', () => {
  const direction = 'slowly evolving texture '.repeat(40);
  const idea = compilePrompt({ natural_language: direction, model: 'ace-step-1.5-xl', mode: 'idea', seed: 11 });
  assert.equal(idea.ok, true);
  const custom = compilePrompt({ natural_language: direction, model: 'ace-step-1.5-xl', mode: 'custom', seed: 11 });
  assert.equal(custom.code, 'TEXT_LIMIT');
  assert.equal(custom.field, 'style');
  assert.equal(custom.limit, 512);
  assert.ok(custom.characters > custom.limit);
  assert.ok(custom.prompt_fields.style.includes(direction.trim()), 'the review retains the complete original English direction');
  const lyrics = compilePrompt({ ...base, model: 'ace-step-1.5-xl', mode: 'custom', natural_language: 'micro swing', lyrics: 'a'.repeat(2001) });
  assert.equal(lyrics.code, 'TEXT_LIMIT');
  assert.equal(lyrics.field, 'lyrics');
});
