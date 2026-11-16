// SUB RITUAL 驗收 #12：Cover 不傳 instrumental=true；Generate 純器樂不混傳 lyrics；未知欄位不出站。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareCreateRequest } from '../../agent/lib/create-contract.mjs';
import { prepareGenerationRequest } from '../../agent/lib/ace.mjs';
import { compilePrompt } from '../../agent/music/core.mjs';

const asset = (payload) => ({ payload, source: 'user_independent', rights_status: 'owned', ai_ingestion_allowed: true });
const song = (id = 'so_test') => asset({ name: 'Owned reference', ref: 'music', libId: id });
const bodyOf = (result) => result.request?.body || result.body || {};
const deepKeys = (value, out = new Set()) => {
  if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { out.add(key); deepKeys(inner, out); }
  return out;
};

test('#12 Cover never sends an instrumental flag: the field is rejected, not silently dropped or forwarded', () => {
  for (const instrumental of [true, false, 'true']) {
    const result = prepareCreateRequest({ mode: 'custom', model: 'acemusic-v1.1', custom_mode: 'cover', references: [song()], style: 'dark industrial body music', instrumental });
    assert.equal(result.ok, false, `instrumental=${instrumental} must not be accepted`);
  }
  const cover = prepareCreateRequest({ mode: 'custom', model: 'acemusic-v1.1', custom_mode: 'cover', references: [song()], style: 'dark industrial body music' });
  assert.equal(cover.ok, true);
  assert.ok(!deepKeys(bodyOf(cover)).has('instrumental'), 'cover body has no instrumental key');
});

test('#12 no Create mode puts an instrumental key on the wire', () => {
  const cases = [
    { mode: 'idea', model: 'acemusic-v1.1', prompt: 'instrumental dark body music, no vocals' },
    { mode: 'custom', model: 'acemusic-v1.1', style: 'instrumental, no vocals', lyrics: '' },
    { mode: 'custom', model: 'acemusic-v1.1', custom_mode: 'mashup', references: [song('so_a'), song('so_b')], lyricsMode: 'mashup' },
  ];
  for (const input of cases) {
    const result = prepareCreateRequest(input);
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 200));
    assert.ok(!deepKeys(bodyOf(result)).has('instrumental'), `${input.mode}/${input.custom_mode || ''} has no instrumental key`);
  }
});

test('#12 direct v1.1 generate: Idea refuses lyrics, unknown instrumental field is refused, custom body carries only declared fields', () => {
  assert.throws(() => prepareGenerationRequest({ mode: 'idea', prompt: 'instrumental, no vocals', lyrics: 'la la la' }), /Idea 請只填 prompt/);
  assert.throws(() => prepareGenerationRequest({ mode: 'custom', style: 'instrumental', instrumental: true }), /不支援的生成參數/);
  const idea = prepareGenerationRequest({ mode: 'idea', prompt: 'Song title: "外殼停頓". Instrumental dark industrial body music. No vocals.' });
  const custom = prepareGenerationRequest({ mode: 'custom', style: 'instrumental dark body music, no vocals' });
  for (const prepared of [idea, custom]) {
    const keys = deepKeys(prepared.body || prepared.request?.body || prepared);
    assert.ok(!keys.has('instrumental'), 'no instrumental key on the wire');
  }
  const customBody = custom.body || custom.request?.body;
  assert.equal(customBody.lyrics, '', 'an instrumental custom request carries empty lyrics');
});

test('#12 music compiler: an instrumental requirement plus lyrics is a conflict, never a silent merge', () => {
  const result = compilePrompt({ natural_language: '重 sub 壓力、微搖擺，無人聲', model: 'acemusic-v1.1', mode: 'custom', seed: 7, lyrics: '這是一段歌詞' });
  assert.notEqual(result.status, 'validated');
  assert.equal(result.code || result.error?.code, 'LYRICS_INSTRUMENTAL_CONFLICT', JSON.stringify(result).slice(0, 240));
  const clean = compilePrompt({ natural_language: '重 sub 壓力、微搖擺，無人聲', model: 'acemusic-v1.1', mode: 'custom', seed: 7 });
  assert.equal(clean.status, 'validated');
});
