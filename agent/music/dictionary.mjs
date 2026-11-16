// Versioned creative vocabulary. Selection weights are local product settings,
// never ACE influence values or a promise about the resulting audio.
const modelIds = ['acemusic-v1', 'acemusic-v1.1', 'ace-step-v1.5-xl'];
const deepFreeze = (value) => {
  Object.values(value).forEach((entry) => { if (entry && typeof entry === 'object') deepFreeze(entry); });
  return Object.freeze(value);
};
const term = (term_id, zh, en, dimension, aliases, options = {}) => ({
  term_id, zh, en, dimension, aliases, definition: zh,
  source_type: 'project_intent', confidence: 'project_initialization',
  evidence_refs: ['project-plan-v1'], base_weight: 0.7, user_adjustment: 0,
  hard_constraint: false, excludes: [], requires: [],
  model_mappings: Object.fromEntries(modelIds.map((id) => [id, { phrase: en, status: 'draft_unverified' }])),
  dictionary_version: '1.0.0', ...options,
});

export const DICTIONARY = deepFreeze({
  version: '1.0.0', id: 'huaidj-creative-v1', source_policy_version: '1.0.0',
  validation: 'offline_draft',
  terms: [
    term('bass.sub_pressure', '厚重低頻壓力', 'weighty sub-bass pressure with breathing gaps', 'bass', ['重 sub 壓力', '重sub壓力', '重 sub', '重sub', 'sub 壓力', 'sub压力', '低頻壓力', '低频压力', '厚重低頻', '厚重低频', '重低音', 'sub bass', 'sub-bass']),
    term('bass.centered_pulses', '居中的低頻脈衝', 'centered low-frequency pulses with a stable fundamental', 'bass', ['低頻脈衝', '低频脉冲', '居中低頻', '居中低频', 'centered sub']),
    term('bass.sparse_weight', '稀疏而有重量的低音', 'sparse bass phrases that leave room between impacts', 'bass', ['稀疏低音', '稀疏低頻', '稀疏低频', 'sparse bass']),
    term('rhythm.micro_swing', '微搖擺', 'subtle micro-swing and a relaxed, interlocking pulse', 'rhythm', ['微搖擺', '微摇摆', '微小搖擺', '微小摇摆', 'micro swing', 'micro-swing']),
    term('rhythm.interlocking', '交錯打擊', 'interlocking percussion with gently offset accents', 'rhythm', ['交錯打擊', '交错打击', '套拍', '交錯節奏', '交错节奏', 'interlocking percussion']),
    term('rhythm.steady', '穩定律動', 'a steady pulse with restrained variation', 'rhythm', ['穩定律動', '稳定律动', 'steady pulse']),
    term('space.slow_midrange_motion', '中頻紋理緩慢移動', 'slowly shifting midrange textures', 'space', ['中頻紋理緩慢移動', '中频纹理缓慢移动', '緩慢移動', '缓慢移动', 'slow midrange motion']),
    term('space.depth', '前後景深', 'a dry close foreground, a defined middle plane and sparse distant echoes', 'space', ['前後景深', '前后景深', '前後空間', '前后空间', '空間感', '空间感', 'spatial depth']),
    term('space.phase_motion', '上層諧波的緩慢相位移動', 'slow phase-like motion in upper harmonics while the bass remains stable', 'space', ['緩慢相位', '缓慢相位', '相位變化', '相位变化', 'phase motion']),
    term('texture.rough_metal', '粗糙金屬質地', 'rough metallic overtones and restrained industrial textures', 'texture', ['粗糙金屬', '粗糙金属', '工業', '工业', '粗糲', '粗粝', 'industrial texture']),
    term('texture.organic', '有機打擊質地', 'tactile organic percussion with small timbral variations', 'texture', ['有機打擊', '有机打击', '有機', '有机', 'organic percussion']),
    term('texture.hybrid', '異質打擊質地', 'contrasting synthetic and tactile percussion timbres', 'texture', ['異質', '异质', '混合打擊', '混合打击', 'hybrid percussion']),
    term('development.restrained', '克制變化', 'restrained repetition with small, deliberate mutations', 'development', ['克制變化', '克制变化', '克制', '小幅變化', '小幅变化', 'restrained variation']),
    term('development.slow_evolution', '緩慢演變', 'a slowly evolving arrangement with clear breathing space', 'development', ['緩慢演變', '缓慢演变', 'slow evolution']),
    term('voice.instrumental', '無人聲', 'instrumental; no lead vocals, humming, chanting, speech or vocal samples', 'voice', ['無人聲', '无人声', '無主唱', '无主唱', '無聲樂', '无声乐', '純音樂', '纯音乐', '不要人聲', '不要人声', '不需要人聲', '不需要人声', '不要主唱', '沒有主唱', '没有主唱', 'instrumental', 'no vocals', 'no lead vocals', 'no lead vocal', 'without vocals', 'without a lead vocal'], { excludes: ['voice.vocal'], base_weight: 0.8 }),
    term('voice.vocal', '人聲主唱', 'a clear lead vocal', 'voice', ['人聲主唱', '人声主唱', '有主唱', 'lead vocal'], { excludes: ['voice.instrumental'], base_weight: 0 }),
  ],
});

export const CAPABILITIES = deepFreeze({
  id: 'ace-documented-2026-11-16', version: '1.0.0',
  evidence_level: 'official_documentation', ui_verified: false, generation_verified: false,
  numeric_prompt_weights: 'unverified', automation_permission: 'unknown',
  models: [
    { id: 'acemusic-v1', name: 'ACE Music v1', modes: ['idea', 'custom'], workflows: ['text'], controls: [], controls_status: 'not_ui_verified' },
    { id: 'acemusic-v1.1', name: 'ACE Music v1.1 Preview', modes: ['idea', 'custom'], workflows: ['text', 'melody', 'score', 'mashup'], controls: [], controls_status: 'not_ui_verified' },
    { id: 'ace-step-v1.5-xl', remote_model_id: 'ace-step-1.5-xl', name: 'ACE-Step v1.5 XL', modes: ['idea', 'custom'], workflows: ['text', 'cover', 'edit'], controls: [], controls_status: 'not_ui_verified' },
  ],
  sources: [
    'https://acemusic.ai/help/articles/choose-an-ace-music-model/',
    'https://acemusic.ai/help/articles/choose-how-to-create-your-song/',
    'https://acemusic.ai/help/articles/set-the-style-mood-instruments-and-vocals/',
    'https://acemusic.ai/help/articles/api-mcp-ace-studio-integration-and-community/',
    'https://developer.spotify.com/policy',
  ],
  live_submission_enabled: false,
  adapters: { ace_official: 'not_connected', ace_browser: 'automation_permission_unknown', deepseek: 'not_connected', rea: 'identity_unknown' },
});
