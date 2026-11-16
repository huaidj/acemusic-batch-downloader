// 自動由 studio-notes 的矩陣 JSON 產生；內容是創作詞條（不是 ACE 的模型權重）。更換詞典請改資料、跑 scripts/verify-matrix.mjs。
(function () {
  'use strict';
  globalThis.AceDLPromptData = Object.freeze({ dictionaries: [{
  "id": "ace-v11-cover-dark-body-20261116",
  "version": "1.0.0",
  "targets": [
    "acemusic-v1.1"
  ],
  "modes": [
    "idea",
    "custom"
  ],
  "tempo_bpm": 110,
  "opening_en": "Instrumental dark industrial body music at 110 BPM, slow and asymmetrical, with an uncanny physical groove. Dense sub-bass stays mono and centered, with clear breathing gaps.",
  "closing_en": "Slow phase motion affects upper harmonics and effects only. Separate dry close hits, a defined middle plane and sparse distant echoes. Restrained repetition, small mutations, no oversized build or drop. No vocals, humming, chanting, speech or vocal samples; no straight techno, psytrance or epic scoring.",
  "axis_a": [
    {
      "id": "A01",
      "name_zh": "玄武岩壓力",
      "phrase_en": "Rounded sub pulses support dense, mineral upper-bass resonances. Each impact has a solid edge and a dark, slowly swelling interior.",
      "selection_weight": 50
    },
    {
      "id": "A02",
      "name_zh": "橡膠機械",
      "phrase_en": "A heavy sub pulse anchors rubbery upper-bass knots, elastic bends and short mechanical recoils, all mutations of one synthetic sound.",
      "selection_weight": 50
    },
    {
      "id": "A03",
      "name_zh": "鏽蝕金屬",
      "phrase_en": "Firm sub phrases carry a corroded metallic shell. Rough upper harmonics scrape and bend slowly while the fundamental remains solid.",
      "selection_weight": 50
    },
    {
      "id": "A04",
      "name_zh": "焦油流體",
      "phrase_en": "Dense rounded bass notes alternate with deliberate gaps. Sticky upper-bass resonances fold and stretch like a dark, viscous mechanism.",
      "selection_weight": 50
    },
    {
      "id": "A05",
      "name_zh": "木腔異物",
      "phrase_en": "Deep sub pulses hold hollow wooden bass cavities, dry resonant knocks and unfamiliar low-mid tones that contract into short silences.",
      "selection_weight": 50
    },
    {
      "id": "A06",
      "name_zh": "液壓肺室",
      "phrase_en": "Measured sub pressure supports synthetic bellows in the upper bass. Their tone inflates, buckles and releases in controlled cycles.",
      "selection_weight": 50
    },
    {
      "id": "A07",
      "name_zh": "黑液線圈",
      "phrase_en": "A compact sub pulse carries wet upper-bass coils and small resonant curls. Use few notes, low brightness and tightly contained motion.",
      "selection_weight": 50
    },
    {
      "id": "A08",
      "name_zh": "碎陶外殼",
      "phrase_en": "Broad rounded sub pulses wear a brittle ceramic shell. Small dry fractures appear around the upper-bass attacks without filling the gaps.",
      "selection_weight": 50
    },
    {
      "id": "A09",
      "name_zh": "磁塵摩擦",
      "phrase_en": "Solid low pulses support grainy harmonic dust and slow abrasive drift. The roughness belongs to the bass surface, never the sub foundation.",
      "selection_weight": 50
    },
    {
      "id": "A10",
      "name_zh": "彈膜裝置",
      "phrase_en": "Deep discrete sub thuds meet elastic synthetic membranes. Tension, recoil and short pitch bends create one family of uncanny bass objects.",
      "selection_weight": 50
    },
    {
      "id": "A11",
      "name_zh": "夜間拍頻",
      "phrase_en": "Stable bass phrases support two close upper harmonic layers with slow beating and dark resonance. The deep fundamental stays unwavering.",
      "selection_weight": 50
    },
    {
      "id": "A12",
      "name_zh": "斷續巨物",
      "phrase_en": "Heavy separated sub pulses carry dense upper-bass blocks. Abrupt stops expose residual texture, making each return feel physically larger.",
      "selection_weight": 50
    }
  ],
  "axis_b": [
    {
      "id": "B01",
      "name_zh": "近距離錯步",
      "phrase_en": "Muted and open hand-drum countersteps stay close; a few rim clicks answer in the middle distance, with sparse shaker grains farther back.",
      "selection_weight": 50
    },
    {
      "id": "B02",
      "name_zh": "皮木接力",
      "phrase_en": "Hand drums and wooden clicks trade short phrases with slight human timing shifts; tiny metal ticks answer from a distant, narrow echo.",
      "selection_weight": 50
    },
    {
      "id": "B03",
      "name_zh": "八拍偏斜",
      "phrase_en": "A lopsided eight-pulse hand-drum cell repeats with small dynamic changes. Offset dry taps occupy the middle plane; a few tails recede.",
      "selection_weight": 50
    },
    {
      "id": "B04",
      "name_zh": "留白口袋",
      "phrase_en": "Leave wide pockets between a few weighted skin hits. Isolated wood and shell ticks cross the middle plane, followed by a distant answer.",
      "selection_weight": 50
    },
    {
      "id": "B05",
      "name_zh": "人性推進",
      "phrase_en": "A restrained hand-drum ensemble leans gently ahead of the pulse, with uneven touch. Soft rim details answer sideways; distant echoes stay rare.",
      "selection_weight": 50
    },
    {
      "id": "B06",
      "name_zh": "悶擊停頓",
      "phrase_en": "Short muted hand-drum phrases stop briefly before resolving. Small dry clicks finish each phrase in the middle distance; decay falls away.",
      "selection_weight": 50
    },
    {
      "id": "B07",
      "name_zh": "雙鼓對話",
      "phrase_en": "Two distinct hand drums exchange compact phrases, one close and one farther back. Restrained small percussion fills only the spaces between.",
      "selection_weight": 50
    },
    {
      "id": "B08",
      "name_zh": "細粒軌道",
      "phrase_en": "A sparse hand-drum pattern grounds small dry rattles and granular ticks. The little sounds move around the middle plane, with sparse far echoes.",
      "selection_weight": 50
    },
    {
      "id": "B09",
      "name_zh": "循環錯位",
      "phrase_en": "A recurring hand-drum phrase shifts its accent slightly each cycle. Wood clicks answer in different gaps, creating motion without a busy fill.",
      "selection_weight": 50
    },
    {
      "id": "B10",
      "name_zh": "聚散呼吸",
      "phrase_en": "Hand drums gather and thin through changes of touch rather than speed. Fine taps enter in the openings; a faint distant haze comes and goes.",
      "selection_weight": 50
    },
    {
      "id": "B11",
      "name_zh": "窄近寬遠",
      "phrase_en": "Keep a compact hand-drum cell dry and near. Sparse ticks open the middle sides, while a few quiet echoes widen farther behind the main groove.",
      "selection_weight": 50
    },
    {
      "id": "B12",
      "name_zh": "負空間呼應",
      "phrase_en": "A short hand-drum call follows each bass gap; one small click or rattle replies from the middle distance. Let the distant residue disappear.",
      "selection_weight": 50
    }
  ],
  "source": "studio handoff appendix A (verified 144 cells by scripts/verify-matrix.mjs)",
  "role_mix_is_model_weight": false
}] });
})();
