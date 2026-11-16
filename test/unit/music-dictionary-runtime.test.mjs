import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptCompiler, mergeReviewedDictionary, dictionaryQuery, compilePrompt, hashObject, COMPILER_VERSION } from '../../agent/music/core.mjs';

const base = () => dictionaryQuery().dictionary;
const evidence = (extra = {}) => ({ id: 'evidence_runtime_fixture', source: 'user_licensed_reference', source_url: 'https://example.com/rhythm', title: 'Public rhythm notes', summary: 'The licensed source describes tactile grains and sparse accents.', rights_status: 'licensed', ai_ingestion_allowed: true, allowed_use: ['local_research', 'reviewed_term_candidates'], observed_at: '2026-11-16T11:30:59.163Z', ...extra });
const term = (extra = {}) => ({ term_id: 'density.tactile_grains', zh: '微粒回響', en: 'tactile grains with room between accents', dimension: 'density', definition: 'An optional density dimension describing sparse grains.', source_type: 'research_candidate', evidence_refs: ['evidence_runtime_fixture'], confidence: 'inference_requires_human_review', base_weight: 1, model_mappings: {}, hard_constraint: false, ...extra });
function approved(terms = [term()], extra = {}) {
  const payload = { parent_version: '1.0.0', terms, evidence_ids: ['evidence_runtime_fixture'], snapshot_ids: { dictionary_version: '1.0.0', compiler_version: COMPILER_VERSION, taste_snapshot_id: 'project-plan-v1-initial', capability_snapshot_id: 'ace-documented-2026-11-16' }, compiler_dictionary_changed: false, long_term_taste_updated: false, status: 'approved_candidate_not_installed' };
  const hash = hashObject(payload);
  return { ...payload, id: `research_dictionary_${hash.slice(0, 24)}`, version: `${payload.parent_version}+research.${hash.slice(0, 12)}`, hash, reviewed_by: 'user', reviewed_at: '2026-11-16T11:30:59.163Z', evidence: [evidence()], ...extra };
}
const session = { id: 'dictionary_runtime_fixture', max_generations: 1, max_depth: 0, budget_limits: { ace_credits: 0 } };

test('reviewed research adds a real compiler dimension with deterministic seeded selection and locking', () => {
  const merged = mergeReviewedDictionary(base(), approved());
  assert.equal(merged.ok, true);
  const compiler = createPromptCompiler({ dictionary: merged.dictionary });
  assert.equal(compiler.ok, true);
  const input = { natural_language: 'instrumental', seed: 124, model: 'acemusic-v1.1' };
  const first = compiler.compilePrompt(input);
  assert.equal(first.ok, true);
  assert.deepEqual(first, compiler.compilePrompt(input));
  assert.ok(first.plan.selected_terms.some((selected) => selected.term_id === 'density.tactile_grains' && selected.dimension === 'density'));
  assert.match(first.plan.prompt_fields.prompt, /tactile grains/);
  assert.equal(first.plan.dictionary_snapshot_id, merged.dictionary.id);
  assert.equal(first.plan.versions.dictionary_hash, merged.dictionary.hash);
  assert.equal(first.plan.versions.dictionary_version, merged.dictionary.version);
  const locked = compiler.compilePrompt({ natural_language: '微粒回響，無人聲', locked_term_ids: ['density.tactile_grains'], weights: { 'density.tactile_grains': 0 }, seed: 999 });
  assert.equal(locked.status, 'validated');
  assert.ok(locked.plan.selected_terms.some((selected) => selected.term_id === 'density.tactile_grains' && selected.locked));
  assert.equal(compiler.dictionaryQuery({ query: '微粒回響' }).terms[0].term_id, 'density.tactile_grains');
});

test('model-specific research mappings are used verbatim and unsupported explicit terms cannot disappear', () => {
  const research = approved([term({ term_id: 'density.model_specific', zh: '偏置顆粒', model_mappings: { 'acemusic-v1.1': { phrase: 'offset granular accents', status: 'draft_user_reviewed' } } })]);
  const merged = mergeReviewedDictionary(base(), research);
  assert.equal(merged.ok, true);
  const compiler = createPromptCompiler({ dictionary: merged.dictionary });
  const usable = compiler.compilePrompt({ natural_language: 'instrumental', model: 'acemusic-v1.1', locked_term_ids: ['density.model_specific'], seed: 1 });
  assert.equal(usable.ok, true);
  assert.match(usable.plan.prompt_fields.prompt, /offset granular accents/);
  const unavailable = compiler.compilePrompt({ natural_language: 'instrumental', model: 'acemusic-v1', locked_term_ids: ['density.model_specific'] });
  assert.equal(unavailable.code, 'TERM_MODEL_MAPPING');
  const random = compiler.compilePrompt({ natural_language: 'instrumental', model: 'acemusic-v1', seed: 1 });
  assert.equal(random.ok, true);
  assert.ok(random.plan.exclusions.some((entry) => entry.term_id === 'density.model_specific' && entry.reason === 'model_mapping_unavailable'));
});

test('historical plans remain bound to their compiler snapshot; mixing versions is rejected', () => {
  const oldCompiler = createPromptCompiler();
  const oldPlan = oldCompiler.compilePrompt({ natural_language: 'instrumental', seed: 2 }).plan;
  const merged = mergeReviewedDictionary(base(), approved());
  const nextCompiler = createPromptCompiler({ dictionary: merged.dictionary });
  const nextPlan = nextCompiler.compilePrompt({ natural_language: 'instrumental', seed: 2 }).plan;
  assert.equal(oldCompiler.prepareGeneration({ plan: oldPlan, reviewed: true, session }).status, 'awaiting_authorization');
  assert.equal(nextCompiler.prepareGeneration({ plan: nextPlan, reviewed: true, session }).status, 'awaiting_authorization');
  assert.equal(oldCompiler.prepareGeneration({ plan: nextPlan, reviewed: true, session }).code, 'SNAPSHOT_UNAVAILABLE');
  assert.equal(nextCompiler.prepareGeneration({ plan: oldPlan, reviewed: true, session }).code, 'SNAPSHOT_UNAVAILABLE');
  assert.equal(nextCompiler.compilePrompt({ natural_language: 'instrumental', dictionary_version: '1.0.0' }).code, 'DICTIONARY_VERSION');
  assert.equal(nextCompiler.compilePrompt({ natural_language: 'instrumental', dictionary_snapshot_id: 'different' }).code, 'DICTIONARY_SNAPSHOT_MISMATCH');
  assert.equal(nextCompiler.compilePrompt({ natural_language: 'instrumental', dictionary: merged.dictionary }).status, 'invalid');
});

test('merging and returned snapshots never mutate the base, approved research, or another compiler', () => {
  const original = base();
  const before = structuredClone(original);
  const research = approved();
  const researchBefore = structuredClone(research);
  const merged = mergeReviewedDictionary(original, research);
  assert.deepEqual(original, before);
  assert.deepEqual(research, researchBefore);
  assert.equal(dictionaryQuery().dictionary_hash, before.hash);
  const compiler = createPromptCompiler({ dictionary: merged.dictionary });
  merged.dictionary.terms[0].en = 'changed after construction';
  const result = compiler.dictionaryQuery();
  result.dictionary.terms[0].en = 'caller mutation';
  assert.notEqual(compiler.dictionaryQuery().terms[0].en, 'caller mutation');
  assert.notEqual(compiler.dictionaryQuery().terms[0].en, 'changed after construction');
  assert.equal(compilePrompt({ natural_language: 'instrumental', seed: 2 }).plan.versions.dictionary_hash, before.hash);
});

test('same dictionary version with different content or forged hash cannot be loaded', () => {
  const changedBase = base();
  delete changedBase.hash;
  changedBase.terms[0].base_weight = 0.123;
  assert.equal(createPromptCompiler({ dictionary: changedBase }).code, 'DICTIONARY_VERSION_CONFLICT');
  const merged = mergeReviewedDictionary(base(), approved([term({ term_id: 'density.version_identity' })]));
  assert.equal(createPromptCompiler({ dictionary: merged.dictionary }).ok, true);
  const changed = structuredClone(merged.dictionary);
  delete changed.hash;
  changed.terms.at(-1).base_weight = 0.2;
  assert.equal(createPromptCompiler({ dictionary: changed }).code, 'DICTIONARY_VERSION_CONFLICT');
  const forged = structuredClone(merged.dictionary); forged.hash = '0'.repeat(64);
  assert.equal(createPromptCompiler({ dictionary: forged }).code, 'DICTIONARY_HASH_MISMATCH');
});

test('unreviewed, missing-rights, Spotify and tampered research cannot enter a runtime dictionary', () => {
  assert.equal(mergeReviewedDictionary(base(), approved(undefined, { status: 'awaiting_review' })).ok, false);
  assert.equal(mergeReviewedDictionary(base(), approved(undefined, { reviewed_by: 'model' })).ok, false);
  assert.equal(mergeReviewedDictionary(base(), approved(undefined, { evidence: [] })).ok, false);
  assert.equal(mergeReviewedDictionary(base(), approved(undefined, { evidence: [evidence({ rights_status: 'unknown' })] })).status, 'policy_blocked');
  assert.equal(mergeReviewedDictionary(base(), approved(undefined, { evidence: [evidence({ allowed_use: ['source_navigation'] })] })).status, 'policy_blocked');
  assert.equal(mergeReviewedDictionary(base(), approved(undefined, { evidence: [evidence({ source: 'spotify-derived' })] })).status, 'policy_blocked');
  assert.equal(mergeReviewedDictionary(base(), approved([term({ en: 'Bearer a-sensitive-test-token-123' })])).status, 'policy_blocked');
  const tampered = approved(); tampered.terms[0].en = 'silently replaced';
  assert.equal(mergeReviewedDictionary(base(), tampered).code, 'RESEARCH_SNAPSHOT_HASH');
  const raw = base(); delete raw.hash; raw.version = 'unreviewed-custom-v1'; raw.id = 'unreviewed-custom'; raw.terms.forEach((entry) => { entry.dictionary_version = raw.version; }); raw.terms.push({ ...raw.terms[0], term_id: 'new.unreviewed', dictionary_version: raw.version });
  assert.equal(createPromptCompiler({ dictionary: raw }).code, 'DICTIONARY_REVIEW_REQUIRED');
});

test('dynamic dependencies and exclusions are enforced, invalid relations and duplicate IDs are rejected', () => {
  const merged = mergeReviewedDictionary(base(), approved([term({ term_id: 'density.dependent', requires: ['bass.centered_pulses'], excludes: ['bass.sub_pressure'] })]));
  assert.equal(merged.ok, true);
  const compiler = createPromptCompiler({ dictionary: merged.dictionary });
  const result = compiler.compilePrompt({ natural_language: 'instrumental', locked_term_ids: ['density.dependent'], seed: 5 });
  assert.equal(result.ok, true);
  assert.ok(result.plan.selected_terms.some((entry) => entry.term_id === 'bass.centered_pulses'));
  assert.ok(!result.plan.selected_terms.some((entry) => entry.term_id === 'bass.sub_pressure'));
  assert.equal(compiler.compilePrompt({ natural_language: 'sub-bass', locked_term_ids: ['density.dependent'] }).status, 'conflict');
  assert.equal(mergeReviewedDictionary(base(), approved([term({ term_id: 'density.invalid_dependency', requires: ['missing.term'] })])).ok, false);
  assert.equal(mergeReviewedDictionary(base(), approved([term({ term_id: 'density.self_dependency', requires: ['density.self_dependency'] })])).ok, false);
  assert.equal(mergeReviewedDictionary(base(), approved([term(), term()])).ok, false);
  assert.equal(mergeReviewedDictionary(base(), approved([term({ term_id: 'density.bad_weight', base_weight: 2 })])).ok, false);
});

test('capability snapshot IDs also bind immutable content and injected dictionaries retain text limits', () => {
  const defaultCompiler = createPromptCompiler();
  const capabilities = defaultCompiler.getCapabilities().capability_snapshot;
  const changed = structuredClone(capabilities); delete changed.hash; changed.models[0].modes = ['idea'];
  assert.equal(createPromptCompiler({ capabilities: changed }).code, 'CAPABILITY_ID_CONFLICT');
  const merged = mergeReviewedDictionary(base(), approved([term({ term_id: 'density.long_phrase', en: 'texture '.repeat(40) })]));
  assert.equal(merged.ok, true);
  const compiler = createPromptCompiler({ dictionary: merged.dictionary });
  const result = compiler.compilePrompt({ natural_language: 'instrumental', model: 'ace-step-v1.5-xl', mode: 'custom', locked_term_ids: ['density.long_phrase'] });
  assert.equal(result.code, 'TEXT_LIMIT');
  assert.equal(result.limit, 512);
});
