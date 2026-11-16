/* ============================================================
   命名爐 NOMENCLATOR — 命名引擎
   低頻儀式 / 有機部落 / 工業冥界 —— 繁體中文 + English
   純函數，可用於瀏覽器與 Node。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 詞庫 ----------
     w = 權重軸：slow 慢 / dark 暗 / machine 機械 / organic 有機
                / heavy 重 / ritual 儀式 / heat 熱 / light 光 / weird 異
     cls = 語義類，用於配對相容性
  */

  // 修飾詞（前綴）
  const Q = [
    ['幽冥', 'Nether', { dark: 1, ritual: .6, slow: .5 }, 'place'],
    ['荒原', 'Wasteland', { organic: .55, ritual: .45, slow: .5 }, 'place'],
    ['巫毒', 'Voodoo', { ritual: 1, dark: .5 }, 'ritual'],
    ['薩滿', 'Shamanic', { ritual: 1, organic: .55 }, 'ritual'],
    ['祖靈', 'Ancestral', { ritual: .9, organic: .6 }, 'ritual'],
    ['巫', 'Witch', { ritual: .8, organic: .5 }, 'ritual'],
    ['冥', 'Underworld', { dark: .9, ritual: .6 }, 'place'],
    ['黑', 'Black', { dark: .9 }, 'colour'],
    ['暗', 'Dark', { dark: .8, slow: .3 }, 'colour'],
    ['濁', 'Turbid', { organic: .75, dark: .4 }, 'material'],
    ['逆', 'Reverse', { weird: .7, machine: .3 }, 'tech'],
    ['錯', 'Errant', { weird: .9, machine: .25 }, 'tech'],
    ['沉', 'Sunken', { slow: 1, dark: .45 }, 'state'],
    ['深', 'Deep', { slow: .8, dark: .45 }, 'place'],
    ['低', 'Low', { slow: .7, machine: .35 }, 'state'],
    ['重', 'Heavy', { heavy: 1, slow: .35 }, 'state'],
    ['慢', 'Slow', { slow: 1 }, 'state'],
    ['碎', 'Shattered', { heavy: .7, weird: .45 }, 'state'],
    ['融', 'Molten', { heavy: .55, heat: .9 }, 'state'],
    ['鏽', 'Rusted', { machine: .85, dark: .35 }, 'material'],
    ['鐵', 'Iron', { machine: .9, heavy: .55 }, 'material'],
    ['鹽', 'Salt', { organic: .45, light: .25 }, 'material'],
    ['蜜', 'Honey', { organic: .95, heat: .4 }, 'material'],
    ['泥', 'Mud', { organic: 1 }, 'material'],
    ['骨', 'Bone', { organic: .5, dark: .5, ritual: .35 }, 'material'],
    ['血', 'Blood', { dark: .85, ritual: .4 }, 'material'],
    ['髓', 'Marrow', { dark: .55, ritual: .4 }, 'material'],
    ['灰', 'Ash', { dark: .55, weird: .3 }, 'material'],
    ['煙', 'Smoke', { heat: .35, dark: .35, slow: .3 }, 'material'],
    ['霧', 'Mist', { slow: .55, light: .25 }, 'material'],
    ['汗', 'Sweat', { organic: .7, heat: .55 }, 'material'],
    ['苔', 'Moss', { organic: .9, slow: .4 }, 'material'],
    ['藤', 'Vine', { organic: .9 }, 'material'],
    ['蟻', 'Ant', { organic: .75, weird: .5 }, 'creature'],
    ['蜂', 'Swarm', { organic: .7, weird: .45 }, 'creature'],
    ['蛇', 'Serpent', { organic: .6, dark: .55 }, 'creature'],
    ['獸', 'Beast', { organic: .7, dark: .45 }, 'creature'],
    ['夜', 'Night', { dark: .75 }, 'place'],
    ['赤', 'Crimson', { heat: .5, dark: .3 }, 'colour'],
    ['白', 'Pale', { light: .75 }, 'colour'],
    ['青', 'Verdant', { organic: .6, light: .3 }, 'colour'],
    ['空', 'Void', { dark: .6, slow: .5, machine: .35 }, 'place'],
    ['半', 'Half', { weird: .85, machine: .2 }, 'number'],
    ['雙', 'Twin', { weird: .75 }, 'number'],
    ['千', 'Thousand', { ritual: .45, weird: .3 }, 'number'],
    ['濕', 'Damp', { organic: .65, slow: .3 }, 'state'],
    ['疫', 'Plague', { dark: .8, weird: .4 }, 'state'],
    ['聖', 'Sacred', { ritual: 1, light: .5 }, 'ritual'],
    ['瀆', 'Profane', { ritual: .8, dark: .6 }, 'ritual'],
    ['寂', 'Silent', { slow: .9, light: .2 }, 'state'],
    ['溺', 'Drowned', { slow: .85, dark: .45 }, 'state'],
    ['懸', 'Suspended', { slow: .8, weird: .5 }, 'state'],
    ['真空', 'Vacuum', { machine: 1, dark: .4 }, 'tech'],
    ['伺服', 'Servo', { machine: 1 }, 'tech'],
    ['延遲', 'Latency', { machine: .9, weird: .55 }, 'tech'],
    ['白噪', 'White-Noise', { machine: .8, weird: .65 }, 'tech'],
    ['低頻', 'Sub-Frequency', { machine: .6, slow: .85, dark: .3 }, 'tech'],
    ['迴', 'Echoed', { weird: .55, ritual: .3 }, 'tech'],
    ['沼', 'Mire', { organic: .85, slow: .7 }, 'place'],
    ['沙', 'Sand', { organic: .55, heat: .3 }, 'material'],
    ['火', 'Fire', { heat: 1, organic: .45 }, 'material'],
    ['露', 'Dew', { organic: .6, light: .45 }, 'material'],
    ['羽', 'Plumed', { organic: .5, light: .45 }, 'material'],
    ['蟒', 'Boa', { organic: .6, dark: .5 }, 'creature'],
    ['月光', 'Moonlit', { light: .75, slow: .55 }, 'place'],
    ['豹', 'Jaguar', { organic: .6, heat: .4, light: .2 }, 'creature'],
    ['鷹', 'Vulture', { dark: .5, organic: .35 }, 'creature'],
    ['石', 'Stone', { organic: .35, slow: .35 }, 'material'],
    ['昏', 'Dim', { dark: .6, slow: .4 }, 'state'],
    ['焦', 'Scorched', { heat: .85, dark: .5 }, 'state'],
    ['腐', 'Rotten', { dark: .7, organic: .3 }, 'state'],
    ['潮', 'Tidal', { slow: .4, organic: .35 }, 'material'],
    ['祖', 'Ancestor', { ritual: .8, organic: .5 }, 'ritual'],
    ['魂', 'Soul', { ritual: .7, dark: .4, organic: .3 }, 'ritual'],
    ['灰土', 'Ash-Soil', { dark: .5, organic: .4 }, 'material'],
    ['林', 'Forest', { organic: .85 }, 'place'],
    ['咆哮', 'Howling', { weird: .7, dark: .4 }, 'state']
  ];

  // 名詞（後綴 / 主體）
  const H = [
    ['靈擺', 'Pendulum', { ritual: .7, dark: .35 }, 'rite'],
    ['鼓', 'Drum', { organic: .55, ritual: .55 }, 'sound'],
    ['潮', 'Tide', { slow: .55, organic: .35 }, 'nature'],
    ['律', 'Rhythm', { ritual: .45, heavy: .3 }, 'abstract'],
    ['髓', 'Marrow', { dark: .6, ritual: .4 }, 'body'],
    ['骨', 'Bone', { dark: .5, organic: .4 }, 'body'],
    ['腱', 'Tendon', { dark: .55, weird: .35 }, 'body'],
    ['皮', 'Skin', { organic: .55, dark: .35 }, 'body'],
    ['膜', 'Membrane', { machine: .45, dark: .3 }, 'body'],
    ['篩', 'Sieve', { machine: .75 }, 'machine'],
    ['網', 'Net', { machine: .45, organic: .3 }, 'machine'],
    ['軸', 'Axis', { machine: .85 }, 'machine'],
    ['齒', 'Cog', { machine: .85, heavy: .35 }, 'machine'],
    ['釘', 'Nail', { machine: .8, dark: .4 }, 'machine'],
    ['管', 'Pipe', { machine: .75 }, 'machine'],
    ['泵', 'Pump', { machine: .85, heavy: .4 }, 'machine'],
    ['鏡', 'Mirror', { weird: .55, ritual: .35 }, 'rite'],
    ['屏', 'Screen', { machine: .8, light: .3 }, 'machine'],
    ['碼', 'Code', { machine: .85 }, 'abstract'],
    ['訊', 'Signal', { machine: .75, light: .25 }, 'abstract'],
    ['噪', 'Noise', { machine: .7, weird: .5 }, 'abstract'],
    ['波', 'Wave', { machine: .45, slow: .3 }, 'abstract'],
    ['相', 'Phase', { machine: .7, weird: .3 }, 'abstract'],
    ['頻', 'Frequency', { machine: .7, slow: .3 }, 'abstract'],
    ['壓', 'Pressure', { machine: .8, heavy: .65 }, 'abstract'],
    ['震', 'Quake', { heavy: .85, machine: .3 }, 'abstract'],
    ['塚', 'Barrow', { dark: .7, ritual: .55 }, 'rite'],
    ['墓', 'Grave', { dark: .75, ritual: .5 }, 'rite'],
    ['壇', 'Altar', { ritual: 1 }, 'rite'],
    ['祭', 'Offering', { ritual: 1 }, 'rite'],
    ['咒', 'Curse', { ritual: .9, dark: .55 }, 'rite'],
    ['印', 'Seal', { ritual: .8, light: .2 }, 'rite'],
    ['門', 'Gate', { ritual: .6, dark: .4 }, 'rite'],
    ['渡', 'Ferry', { ritual: .6, slow: .4 }, 'rite'],
    ['塔', 'Tower', { machine: .3, ritual: .4 }, 'rite'],
    ['窟', 'Crypt', { dark: .75, ritual: .55 }, 'rite'],
    ['巢', 'Nest', { organic: .6, dark: .3 }, 'nature'],
    ['繭', 'Cocoon', { organic: .65, slow: .45 }, 'nature'],
    ['核', 'Core', { machine: .5, organic: .3 }, 'machine'],
    ['焰', 'Flame', { heat: .9, light: .35 }, 'nature'],
    ['燼', 'Ember', { heat: .65, dark: .45 }, 'nature'],
    ['雨', 'Rain', { slow: .45, organic: .4 }, 'nature'],
    ['河', 'River', { organic: .55, slow: .3 }, 'nature'],
    ['根', 'Root', { organic: .85 }, 'nature'],
    ['蜜', 'Honey', { organic: .9, heat: .35 }, 'food'],
    ['塵', 'Dust', { dark: .45, slow: .35 }, 'nature'],
    ['砂', 'Grit', { organic: .45, machine: .3 }, 'nature'],
    ['脈', 'Pulse', { heavy: .35, machine: .3 }, 'body'],
    ['肺', 'Lung', { organic: .45, dark: .35 }, 'body'],
    ['臍', 'Navel', { weird: .55, ritual: .35 }, 'body'],
    ['脊', 'Spine', { dark: .55, heavy: .3 }, 'body'],
    ['眼', 'Eye', { weird: .4, ritual: .35 }, 'body'],
    ['舌', 'Tongue', { weird: .6, organic: .35 }, 'body'],
    ['禱', 'Prayer', { ritual: .95 }, 'rite'],
    ['懺', 'Confession', { ritual: .9, dark: .5 }, 'rite'],
    ['鑰', 'Key', { machine: .35, ritual: .35 }, 'machine'],
    ['鎖', 'Lock', { machine: .55, dark: .3 }, 'machine'],
    ['鐘', 'Bell', { ritual: .75, light: .25 }, 'instrument'],
    ['弦', 'String', { organic: .35, machine: .4 }, 'instrument'],
    ['箔', 'Foil', { machine: .6, weird: .55 }, 'machine'],
    ['鉛', 'Lead', { machine: .55, heavy: .55 }, 'machine'],
    ['硅', 'Silicon', { machine: .85 }, 'machine'],
    ['磁', 'Magnet', { machine: .6 }, 'machine'],
    ['電', 'Current', { machine: .7, heavy: .4 }, 'machine'],
    ['油', 'Oil', { machine: .5, organic: .35 }, 'machine'],
    ['蠟', 'Wax', { organic: .5, weird: .3 }, 'material'],
    ['歌', 'Song', { organic: .5, ritual: .5 }, 'sound'],
    ['舞', 'Dance', { organic: .6, ritual: .55 }, 'sound'],
    ['呼吸', 'Breath', { organic: .55, slow: .45 }, 'abstract'],
    ['魂', 'Soul', { ritual: .85, dark: .35 }, 'nature'],
    ['心跳', 'Heartbeat', { organic: .5, heavy: .35, ritual: .4 }, 'body'],
    ['路', 'Road', { organic: .4, slow: .3 }, 'abstract'],
    ['骸', 'Skeleton', { dark: .7, organic: .35 }, 'body'],
    ['鼓語', 'Drum Tongue', { organic: .7, ritual: .55 }, 'craft'],
    ['火塘', 'Hearth', { organic: .8, heat: .7 }, 'craft'],
    ['蟻路', 'Ant Road', { organic: .8, weird: .4 }, 'craft'],
    ['藤橋', 'Vine Bridge', { organic: .85, slow: .3 }, 'craft'],
    ['林鳴', 'Forest Call', { organic: .8, weird: .3 }, 'craft'],
    ['泥人', 'Mud Figure', { organic: .85, weird: .5 }, 'craft'],
    ['蜂蠟', 'Beeswax', { organic: .85, light: .3 }, 'food'],
    ['蜜酒', 'Mead', { organic: .8, heat: .5 }, 'food'],
    ['蟒皮', 'Boa Skin', { organic: .6, dark: .5 }, 'material'],
    ['羽冠', 'Plume Crown', { organic: .6, ritual: .7 }, 'craft'],
    ['骨笛', 'Bone Flute', { organic: .5, ritual: .7 }, 'instrument'],
    ['皮鼓', 'Skin Drum', { organic: .65, ritual: .6 }, 'instrument'],
    ['號', 'Horn', { ritual: .7, heavy: .3 }, 'instrument'],
    ['塤', 'Ocarina', { organic: .7, ritual: .6 }, 'instrument'],
    ['鈴', 'Chime', { ritual: .7, light: .4 }, 'instrument'],
    ['罈', 'Jar', { ritual: .55, dark: .35 }, 'craft'],
    ['鼓膜', 'Eardrum', { organic: .4, weird: .45 }, 'body'],
    ['聲帶', 'Vocal Cords', { organic: .35, weird: .5 }, 'body'],
    ['髓腔', 'Marrow Cavity', { dark: .7, weird: .3 }, 'body'],
    ['骨節', 'Joint', { dark: .55, organic: .3 }, 'body'],
    ['肋骨', 'Rib', { dark: .65 }, 'body'],
    ['血管', 'Vein', { dark: .6 }, 'body'],
    ['皮層', 'Cortex', { machine: .3, weird: .45 }, 'body'],
    ['菌絲', 'Mycelium', { organic: .95, weird: .35 }, 'organic'],
    ['孢子', 'Spore', { organic: .9, weird: .35 }, 'organic'],
    ['蜂巢', 'Hive', { organic: .8, dark: .25 }, 'organic'],
    ['蟻丘', 'Anthill', { organic: .85 }, 'organic'],
    ['熔岩', 'Lava', { heat: .95, heavy: .4 }, 'nature'],
    ['隕鐵', 'Meteorite', { machine: .5, dark: .6 }, 'machine'],
    ['電纜', 'Cable', { machine: .9 }, 'machine'],
    ['齒輪', 'Gear', { machine: .9, heavy: .3 }, 'machine'],
    ['軸承', 'Bearing', { machine: .9 }, 'machine'],
    ['液晶', 'Liquid Crystal', { machine: .6, light: .45 }, 'machine'],
    ['磁帶', 'Magnetic Tape', { machine: .7, slow: .3 }, 'machine'],
    ['部落', 'Tribe', { organic: .6, ritual: .6 }, 'craft'],
    ['獸骨', 'Beast Bone', { dark: .6, organic: .4 }, 'body'],
    // 抽象名詞：讓「幽冥慣性」「低頻熵」這種短銘也能出現
    ['慣性', 'Inertia', { machine: .3, weird: .5 }, 'abstract'],
    ['殘餘', 'Residue', { weird: .5, dark: .3 }, 'abstract'],
    ['褶皺', 'Fold', { organic: .3, weird: .6 }, 'abstract'],
    ['閾值', 'Threshold', { machine: .5, weird: .4 }, 'abstract'],
    ['折射', 'Refraction', { light: .4, weird: .5 }, 'abstract'],
    ['熵', 'Entropy', { machine: .4, weird: .7 }, 'abstract'],
    ['幽靈', 'Ghost', { dark: .5, ritual: .4 }, 'abstract'],
    ['缺席', 'Absence', { dark: .6, weird: .5 }, 'abstract'],
    ['半影', 'Penumbra', { dark: .4, light: .3 }, 'abstract'],
    ['幻肢', 'Phantom Limb', { body: .6, weird: .6 }, 'abstract'],
    ['共鳴', 'Resonance', { machine: .3, ritual: .4 }, 'abstract'],
    ['失焦', 'Defocus', { weird: .6, light: .3 }, 'abstract'],
    ['間隙', 'Interval', { machine: .3, weird: .4 }, 'abstract'],
    ['陰影', 'Shadow', { dark: .5 }, 'abstract'],
    ['形狀', 'Shape', { weird: .4 }, 'abstract'],
    ['重量', 'Weight', { heavy: .5 }, 'abstract'],
    ['回聲', 'Echo', { weird: .4, ritual: .3 }, 'abstract']
  ];

  // 儀式
  const R = [
    ['儀軌', 'Liturgy', { ritual: 1, dark: .35 }, 'rite'],
    ['彌撒', 'Mass', { ritual: 1, dark: .45 }, 'rite'],
    ['聖詠', 'Psalm', { ritual: 1, light: .3 }, 'rite'],
    ['守夜', 'Vigil', { ritual: .9, slow: .55 }, 'rite'],
    ['獻祭', 'Offering', { ritual: 1, heat: .2 }, 'rite'],
    ['懺悔', 'Confession', { ritual: .95, dark: .45 }, 'rite'],
    ['吟唱', 'Chant', { ritual: .9, slow: .35 }, 'rite'],
    ['驅魔', 'Exorcism', { ritual: .95, heavy: .35 }, 'rite'],
    ['葬列', 'Cortege', { ritual: .9, dark: .6, slow: .4 }, 'rite']
  ];

  // 並置素材
  const M = [
    ['骨', 'Bone', { organic: .4, dark: .5 }, 'body'],
    ['髓', 'Marrow', { dark: .6 }, 'body'],
    ['腱', 'Tendon', { dark: .5, weird: .4 }, 'body'],
    ['皮', 'Skin', { organic: .5 }, 'body'],
    ['血', 'Blood', { dark: .8 }, 'body'],
    ['蜜', 'Honey', { organic: .9, heat: .4 }, 'food'],
    ['蠟', 'Wax', { organic: .4, weird: .4 }, 'material'],
    ['鉛', 'Lead', { machine: .55, heavy: .6 }, 'machine'],
    ['箔', 'Foil', { machine: .6, weird: .6 }, 'machine'],
    ['鏽', 'Rust', { machine: .8, dark: .3 }, 'material'],
    ['鹽', 'Salt', { organic: .4, light: .3 }, 'material'],
    ['泥', 'Mud', { organic: 1 }, 'material'],
    ['灰', 'Ash', { dark: .5 }, 'material'],
    ['鐵', 'Iron', { machine: .9, heavy: .5 }, 'material'],
    ['沙', 'Sand', { organic: .5 }, 'material'],
    ['霧', 'Mist', { slow: .5, light: .3 }, 'material'],
    ['線', 'Wire', { machine: .7 }, 'machine'],
    ['膜', 'Membrane', { machine: .4, dark: .3 }, 'body'],
    ['齒', 'Cog', { machine: .8 }, 'machine'],
    ['羽', 'Plume', { organic: .5, light: .45 }, 'material'],
    ['露', 'Dew', { organic: .6 }, 'material'],
    ['汗', 'Sweat', { organic: .65, heat: .5 }, 'body'],
    ['火', 'Fire', { heat: .9 }, 'material'],
    ['油', 'Oil', { machine: .45, organic: .35 }, 'machine'],
    ['硅', 'Silicon', { machine: .85 }, 'machine'],
    ['藤', 'Vine', { organic: .9 }, 'material'],
    ['苔', 'Moss', { organic: .9 }, 'material'],
    ['煤', 'Coal', { dark: .7, machine: .3 }, 'material'],
    ['銅', 'Copper', { machine: .3, heat: .4 }, 'material'],
    ['絲', 'Silk', { organic: .4, light: .3 }, 'material'],
    ['塵', 'Dust', { dark: .4 }, 'material'],
    ['蜜蠟', 'Beeswax', { organic: .8, light: .3 }, 'food']
  ];

  // 抽象屬性：給「X 的 Y」用；愈怪愈好，但語感要成立
  const AB = [
    ['慣性', 'Inertia', { machine: .3, weird: .5, slow: .4 }],
    ['殘餘', 'Residue', { weird: .5, dark: .3 }],
    ['褶皺', 'Fold', { organic: .3, weird: .6 }],
    ['閾值', 'Threshold', { machine: .5, weird: .4 }],
    ['折射', 'Refraction', { light: .4, weird: .5 }],
    ['殘響', 'Reverb', { machine: .3, weird: .5, slow: .4 }],
    ['熵', 'Entropy', { machine: .4, weird: .7 }],
    ['幽靈', 'Ghost', { dark: .5, ritual: .4 }],
    ['缺席', 'Absence', { dark: .6, weird: .5 }],
    ['遺忘', 'Oblivion', { dark: .7, slow: .4 }],
    ['預感', 'Premonition', { dark: .3, weird: .5 }],
    ['幻肢', 'Phantom Limb', { body: .6, weird: .6 }],
    ['共鳴', 'Resonance', { machine: .3, ritual: .4 }],
    ['反相', 'Anti-Phase', { machine: .6, weird: .5 }],
    ['失焦', 'Defocus', { weird: .6, light: .3 }],
    ['半影', 'Penumbra', { dark: .4, light: .3 }],
    ['邊界', 'Boundary', { machine: .3, weird: .3 }],
    ['內裡', 'Interior', { dark: .3 }],
    ['餘波', 'Aftermath', { dark: .5, slow: .3 }],
    ['之外', 'Beyond', { weird: .5 }],
    ['形狀', 'Shape', { weird: .4 }],
    ['重量', 'Weight', { heavy: .5 }],
    ['剩餘', 'Remainder', { weird: .4 }],
    ['回聲', 'Echo', { weird: .4, ritual: .3 }],
    ['間隙', 'Interval', { machine: .3, weird: .4 }],
    ['裂縫', 'Crevice', { dark: .4, weird: .4 }],
    ['陰影', 'Shadow', { dark: .5 }],
    ['反面', 'Reverse', { weird: .5 }],
    ['不存在', 'Nonexistence', { dark: .6 }]
  ];

  // 語義根（避免同義堆疊：火 + 燼）
  const ROOT = {
    '火': 'fire', '焰': 'fire', '燼': 'fire', '火塘': 'fire', '焦': 'fire',
    '蜜': 'honey', '蜂蠟': 'honey', '蜜酒': 'honey', '蜜蠟': 'honey',
    '骨': 'bone', '骸': 'bone', '骨笛': 'bone',
    '皮': 'skin', '蟒皮': 'skin', '皮鼓': 'skin',
    '泥': 'mud', '泥人': 'mud',
    '鼓': 'drum', '鼓語': 'drum',
    '舞': 'dance',
    '灰': 'ash', '灰土': 'ash',
    '沙': 'sand', '砂': 'sand',
    '潮': 'tide',
    '霧': 'mist',
    '羽': 'plume', '羽冠': 'plume',
    '蟻': 'ant', '蟻路': 'ant',
    '蜂': 'swarm',
    '蟒': 'boa', '蟒皮': 'boa',
    '鐵': 'iron',
    '鏽': 'rust',
    '鹽': 'salt',
    '祭': 'offering', '獻祭': 'offering',
    '藤': 'vine', '藤橋': 'vine',
    '苔': 'moss',
    '髓': 'marrow',
    '血': 'blood',
    '油': 'oil',
    '弦': 'string',
    '歌': 'song',
    '林': 'forest', '林鳴': 'forest',
    '鐘': 'bell', '鈴': 'chime',
    '熔岩': 'fire', '融': 'fire', '蜂巢': 'swarm', '蟻丘': 'ant', '齒輪': 'cog',
    '隕鐵': 'iron', '獸骨': 'bone'
  };

  const RITUAL_Q = new Set(['巫毒', '薩滿', '祖靈', '巫', '聖', '瀆', '祖']);
  const TECH_Q = new Set(['真空', '伺服', '延遲', '低頻', '白噪', '逆', '錯']);
  const FOOD_H = new Set(['蜜', '蜂蠟', '蜜酒']);
  const ABSTRACT_H = new Set(['律', '碼', '訊', '噪', '波', '相', '頻', '壓', '震', '呼吸', '路',
    '慣性', '殘餘', '褶皺', '閾值', '折射', '熵', '幽靈', '缺席', '半影', '幻肢', '共鳴', '失焦', '間隙', '陰影', '形狀', '重量', '回聲']);
  const WATER_Q = new Set(['霧', '露', '沼', '濕', '溺', '潮']);
  const METAL_H = new Set(['鉛', '箔', '硅', '油', '電', '磁', '鎖', '鑰', '屏', '碼', '線']);
  const INSTR_H = new Set(['鈴', '鐘', '塤', '骨笛', '皮鼓', '號', '弦']);
  const QONLY = new Set(['幽冥', '荒原', '巫毒', '巫', '冥', '泥', '蜜', '骨', '血', '髓', '鹽', '鐵', '灰', '煙', '霧', '汗', '苔', '藤', '蟻', '蜂', '蛇', '獸', '夜', '空', '沼', '沙', '火', '露', '蟒', '豹', '鷹', '石', '林', '真空', '伺服', '延遲', '白噪', '低頻']);
  const CRAFT_H = new Set(['鼓語', '火塘', '蟻路', '藤橋', '藥歌', '林鳴', '泥人', '蜂蠟', '蜜酒', '蟒皮', '羽冠', '骨笛', '皮鼓', '罈']);

  const REGISTER_META = {
    sigil: { label: '銘', en: 'SIGIL', hint: '2–4 字 · 2–3 詞' },
    liturgy: { label: '儀', en: 'LITURGY', hint: '長儀式題 · X of the Y' },
    pair: { label: '並', en: 'JUXTAPOSE', hint: '兩材質並置 · A & B' },
    abstract: { label: '抽', en: 'ABSTRACT', hint: 'X 的 Y · The Y of X' }
  };

  /* ---------- 工具 ---------- */

  function clamp(n, a, b) { return n < a ? a : n > b ? b : n; }

  function hashStr(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function dot(tags, bias) {
    let s = 0;
    for (const k in tags) if (bias[k] != null) s += tags[k] * bias[k];
    return s;
  }

  function dominant(tags) {
    let best = 'neutral', v = 0;
    for (const k in tags) if (tags[k] > v) { v = tags[k]; best = k; }
    return best;
  }

  function isMachine(tags) { return (tags.machine || 0) > .55; }
  function isOrganic(tags) { return (tags.organic || 0) > .5; }

  function pickWeighted(rng, pool, bias, avoid, temp) {
    const t = temp || 1.35;
    let total = 0;
    const w = new Array(pool.length);
    for (let i = 0; i < pool.length; i++) {
      let s = dot(pool[i][2], bias);
      if (avoid && avoid.has(pool[i][0])) s -= 2.2;
      w[i] = Math.exp(clamp(s, -6, 6) * t);
      total += w[i];
    }
    let r = rng() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= w[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function toEntry(row) { return { zh: row[0], en: row[1], w: row[2], cls: row[3] }; }

  function sameRoot(a, b) {
    const ra = ROOT[a.zh], rb = ROOT[b.zh];
    return ra && rb && ra === rb;
  }

  function qFitsH(q, h) {
    if (sameRoot(q, h)) return false;
    if ((RITUAL_Q.has(q.zh) || TECH_Q.has(q.zh)) && FOOD_H.has(h.zh)) return false;
    if (WATER_Q.has(q.zh) && METAL_H.has(h.zh)) return false;
    if (['苔', '露', '蠟', '蜜', '鹽', '霧'].includes(q.zh) && INSTR_H.has(h.zh)) return false;
    if (['露', '苔', '灰土', '沙', '霧'].includes(q.zh) && CRAFT_H.has(h.zh)) return false;
    if (q.cls === 'creature' && (FOOD_H.has(h.zh) || CRAFT_H.has(h.zh))) return false;
    if (q.cls === 'state' && (METAL_H.has(h.zh) || h.cls === 'instrument')) return false;
    if (q.cls === 'ritual' && h.cls === 'machine') return false;
    if (q.cls === 'place' && h.zh === '油') return false;
    if (q.cls === 'state' || q.cls === 'tech') { if (h.zh === '熔岩') return false; }
    if (['半', '雙', '千'].includes(q.zh) && ['abstract', 'machine', 'rite'].includes(h.cls)) return false;
    if (q.zh === h.zh) return false;
    return true;
  }

  /* ---------- 既有名冊（防撞名） ---------- */

  function stripVersions(s) {
    return s.replace(/\s*[（(]\s*\d+\s*[)）]\s*$/g, '').trim();
  }

  function splitTitle(title) {
    const t = stripVersions(title).trim();
    let zh = '', en = '';
    const m = t.match(/^([^（(]+?)\s*[（(](.+?)[)）]\s*$/);
    if (m && /[A-Za-z]{2,}/.test(m[2])) { zh = m[1].trim(); en = m[2].trim(); }
    else if (/[\u3400-\u9fff]/.test(t) && !/[A-Za-z]{3,}/.test(t)) zh = t;
    else en = t;
    return { zh, en };
  }

  const PUNCT = /[\s\u3000·・「」『』【】\[\]（）()〈〉《》,，、。．.．:：;；!！?？\-—_\/\\|~～'’"“”]/g;
  function normZh(s) { return (s || '').replace(PUNCT, ''); }
  function normEn(s) { return (s || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').replace(/\s+/g, ' ').trim(); }

  function enTokens(s) {
    return new Set(normEn(s).split(' ').filter(w => w && w !== 'the' && w !== 'of' && w !== 'a' && w !== 'and'));
  }

  function prepareExisting(titles) {
    const zh = new Set(), en = new Set(), tokenSets = [];
    for (const title of titles || []) {
      const parts = splitTitle(title);
      if (parts.zh) zh.add(normZh(parts.zh));
      if (parts.en) {
        en.add(normEn(parts.en));
        const ts = enTokens(parts.en);
        if (ts.size) tokenSets.push({ set: ts, title: parts.en });
      }
    }
    return { zh, en, tokenSets };
  }

  function jaccard(a, b) {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function collides(cand, existing) {
    if (!existing) return false;
    if (existing.zh.has(normZh(cand.zh))) return true;
    if (existing.en.has(normEn(cand.en))) return true;
    const ts = enTokens(cand.en);
    if (ts.size >= 2) {
      for (const row of existing.tokenSets) {
        if (row.set.size >= 2 && jaccard(ts, row.set) >= .8) return true;
      }
    }
    return false;
  }

  /* ---------- 聽感 → 權重 ---------- */

  // 分析器的 energy 是 RMS 等級（低 <0.028、高 >0.161），映射到 0–1
  function normEnergy(raw) {
    if (raw == null) return .35;
    return clamp(Math.pow(clamp(raw / 0.16, 0, 1), .6), 0, 1);
  }

  function buildBias(track, settings) {
    const s = settings || {};
    const bpm = track && track.bpm ? track.bpm : 110;
    const energy = track && track.energy != null ? clamp(track.energy, 0, 1) : .35;
    const bright = track && track.brightness != null ? clamp(track.brightness, 0, 1) : .42;
    const key = (track && track.key) || '';
    const isMinor = /min/i.test(key) || /:\s*m\b/i.test(key);
    const mix = clamp((s.mix != null ? s.mix : 50) / 100, 0, 1);           // 0 有機 → 1 機械
    const shake = clamp((s.shake != null ? s.shake : 50) / 100, 0, 1);     // 0 靜 → 1 震
    const slow = clamp((128 - bpm) / 28, 0, 1);
    return {
      slow: .12 + slow * .95,
      dark: (isMinor ? .78 : .38) * (.7 + (1 - bright) * .5),
      machine: .1 + mix * .95,
      organic: .1 + (1 - mix) * .95,
      heavy: clamp(energy * 1.5, 0, 1) * (.45 + shake * .75),
      ritual: .5 + (1 - shake) * .28,
      heat: clamp(energy * 1.2, 0, 1) * .8 + (isMinor ? 0 : .2),
      light: bright * .9,
      weird: .3 + shake * .35 + (bright > .65 ? .1 : 0)
    };
  }

  function isMinorKey(key) { return /min/i.test(key || ''); }

  /* ---------- 生成 ---------- */

  function zhLen(s) { return Array.from(s).length; }

  function makeSigil(rng, bias, avoid) {
    const q = toEntry(pickWeighted(rng, Q, bias, avoid));
    const h = toEntry(pickWeighted(rng, H, bias, avoid));
    if (!qFitsH(q, h)) return null;
    if (q.zh.length === 1 && h.zh.length === 1 && rng() < .6) return null;
    const zh = q.zh + h.zh;
    if (zhLen(zh) > 4 || zhLen(zh) < 2) return null;
    const en = q.en + ' ' + h.en;
    if (en.split(/\s+/).length > 3) return null;
    let score = dot(q.w, bias) + dot(h.w, bias) + rng() * .1;
    if ((isOrganic(q.w) && isMachine(h.w)) || (isMachine(q.w) && isOrganic(h.w))) score += .4;
    // 語感偏好：四字最穩；避免「荒原壓」這種雙字前綴 + 單字抽象名詞
    const zl = zhLen(zh);
    if (zl === 4) score += .3;
    if (zl === 2) score -= .3;
    if (h.cls === 'abstract' && h.zh.length === 1 && q.zh.length >= 2) score -= .45;
    if (q.cls === 'place' && h.cls === 'abstract' && h.zh.length === 1) score -= .2;
    if (q.cls === 'state' && h.cls === 'instrument') score -= .35;
    return { zh, en, register: 'sigil', score, parts: [q.zh, h.zh] };
  }

  function makeLiturgy(rng, bias, avoid) {
    const r = toEntry(pickWeighted(rng, R, bias, avoid));
    const pool = H.filter(row => !['祭', '壇', '咒', '禱', '懺', '獻祭'].includes(row[0])
      && !FOOD_H.has(row[0]) && !ABSTRACT_H.has(row[0]) && !CRAFT_H.has(row[0])
      && row[3] !== 'rite');
    const h = toEntry(pickWeighted(rng, pool, bias, avoid));
    const useQ = rng() < .45;
    const q = useQ ? toEntry(pickWeighted(rng, Q, bias, avoid)) : null;
    if (q && (!qFitsH(q, h) || q.cls === 'creature' || q.cls === 'number')) return null;
    if (q && h.zh.length < 2) return null;
    if (q && zhLen(q.zh) + zhLen(h.zh) > 5) return null;
    const zh = (q ? q.zh : '') + h.zh + '之' + r.zh;
    if (zhLen(zh) < 4 || zhLen(zh) > 8) return null;
    const en = r.en + ' of the ' + (q ? q.en + ' ' : '') + h.en;
    if (en.split(/\s+/).length > 6) return null;
    let score = dot(r.w, bias) + dot(h.w, bias) + (q ? dot(q.w, bias) * .6 : 0) + rng() * .1;
    return { zh, en, register: 'liturgy', score, parts: [q ? q.zh : '', h.zh, r.zh] };
  }

  function makePair(rng, bias, avoid) {
    const a = toEntry(pickWeighted(rng, M, bias, avoid));
    let b = toEntry(pickWeighted(rng, M, bias, avoid));
    let guard = 0;
    while ((b.zh === a.zh || sameRoot(a, b)) && guard++ < 12) b = toEntry(pickWeighted(rng, M, bias, avoid));
    if (b.zh === a.zh || sameRoot(a, b)) return null;
    const zh = a.zh + '與' + b.zh;
    if (zhLen(zh) > 5) return null;
    const en = a.en + ' & ' + b.en;
    let score = dot(a.w, bias) + dot(b.w, bias) + rng() * .1;
    const cross = (isOrganic(a.w) || isMachine(a.w)) !== (isOrganic(b.w) || isMachine(b.w));
    if (cross) score += .3;
    return { zh, en, register: 'pair', score, parts: [a.zh, b.zh] };
  }

  function makeAbstract(rng, bias, avoid) {
    const ab = toEntry(pickWeighted(rng, AB, bias, avoid));
    const concrete = H.filter(row => ['body', 'material', 'nature', 'machine', 'sound', 'instrument', 'craft', 'organic'].includes(row[3])
      && !ABSTRACT_H.has(row[0]) && !FOOD_H.has(row[0]));
    if (!concrete.length) return null;
    const mode = rng();
    let q = null;
    let h = null;
    if (mode < .42) {
      h = toEntry(pickWeighted(rng, concrete, bias, avoid));
    } else if (mode < .72) {
      const qPool = Q.filter(row => QONLY.has(row[0]));
      q = toEntry(pickWeighted(rng, qPool, bias, avoid));
    } else {
      h = toEntry(pickWeighted(rng, concrete, bias, avoid));
      q = toEntry(pickWeighted(rng, Q, bias, avoid));
      if (!qFitsH(q, h) || q.cls === 'creature' || q.cls === 'number') return null;
    }
    if (!q && !h) return null;
    const zh = (q ? q.zh : '') + (h ? h.zh : '') + '的' + ab.zh;
    if (zhLen(zh) < 3 || zhLen(zh) > 8) return null;
    const article = (q || (h && /\s/.test(h.en))) ? 'the ' : '';
    const en = ('The ' + ab.en + ' of ' + article + (q ? q.en + ' ' : '') + (h ? h.en : '')).trim();
    if (en.split(/\s+/).length > 6) return null;
    let score = dot(ab.w, bias) + (h ? dot(h.w, bias) * .55 : 0) + (q ? dot(q.w, bias) * .55 : 0) + rng() * .1;
    if (zhLen(zh) >= 4 && zhLen(zh) <= 6) score += .15;
    return { zh, en, register: 'abstract', score, parts: [q ? q.zh : '', h ? h.zh : '', ab.zh] };
  }

  function chooseRegister(rng, track, bias, settings) {
    const s = settings || {};
    if (s.register && s.register !== 'auto') return s.register;
    const dur = (track && track.duration) || 0;
    const heavy = clamp(bias.heavy, 0, 1);
    let pLit = dur > 330 ? .44 : dur > 200 ? .28 : .18;
    if (heavy > .6) pLit += .06;
    const pAbs = .2 + clamp(bias.weird - .4, 0, .4) * .25;
    const pPair = .12 + clamp(bias.weird - .4, 0, .4) * .25;
    const r = rng();
    if (r < pAbs) return 'abstract';
    if (r < pAbs + pPair) return 'pair';
    if (r < pAbs + pPair + pLit) return 'liturgy';
    return 'sigil';
  }

  function normalizeSettings(settings) {
    return Object.assign({ mix: 50, shake: 50, register: 'auto' }, settings || {});
  }

  function generate(seedStr, track, settings, opts) {
    opts = opts || {};
    const s = normalizeSettings(settings);
    const bias = buildBias(track, s);
    const rng = makeRng(hashStr(String(seedStr)));
    const register = opts.register || chooseRegister(rng, track, bias, s);
    const used = opts.used || new Set();
    const avoid = opts.avoid || null;
    const existing = opts.existing || null;
    const pool = [];
    const makers = { sigil: makeSigil, liturgy: makeLiturgy, pair: makePair, abstract: makeAbstract };
    const maker = makers[register] || makeSigil;
    for (let i = 0; i < 90 && pool.length < 24; i++) {
      const cand = maker(rng, bias, avoid);
      if (!cand) continue;
      const key = normZh(cand.zh) + '|' + normEn(cand.en);
      if (used.has(key)) continue;
      if (collides(cand, existing)) continue;
      pool.push(cand);
    }
    if (!pool.length) return null;
    pool.sort((a, b) => b.score - a.score);
    const top = pool.slice(0, Math.min(8, pool.length));
    const wi = top.map((c, i) => Math.exp(-i * 1.0));
    const totalW = wi.reduce((a, b) => a + b, 0);
    let r = rng() * totalW, idx = 0;
    for (; idx < wi.length; idx++) { r -= wi[idx]; if (r <= 0) break; }
    const best = top[Math.min(idx, top.length - 1)];
    best.code = String(100 + (hashStr(String(seedStr) + '|' + register) % 900));
    used.add(normZh(best.zh) + '|' + normEn(best.en));
    return best;
  }

  function candidates(track, settings, n, opts) {
    opts = opts || {};
    n = n || 3;
    const out = [];
    const used = opts.used || new Set();
    const avoid = opts.avoid || new Set();
    const base = opts.seed != null ? String(opts.seed) : trackSeed(track);
    const want = opts.register && opts.register !== 'auto' ? opts.register : null;

    // 主提案：與 generate(base) 完全一致（自動體裁），方便重現與批次對齊
    const primary = generate(base, track, settings, {
      register: want || undefined,
      used, avoid,
      existing: opts.existing
    });
    if (primary) {
      out.push(primary);
      (primary.parts || []).forEach(p => p && avoid.add(p));
    }

    // 另外兩個提案：優先給抽象／不同體裁，換子種子
    const ranking = ['abstract', 'liturgy', 'sigil', 'pair'];
    const others = ranking.filter(r => !primary || r !== primary.register).slice(0, 2);
    for (let i = 0; out.length < n && i < 12; i++) {
      const reg = others[i % others.length];
      const cand = generate(base + '#' + (i + 1), track, settings, {
        register: reg,
        used, avoid,
        existing: opts.existing
      });
      if (cand && !out.some(o => o.zh === cand.zh)) {
        out.push(cand);
        (cand.parts || []).forEach(p => p && avoid.add(p));
      }
    }
    return out;
  }

  function trackSeed(track, salt) {
    if (!track) return 'empty';
    return [
      track.rel || track.name || '',
      track.size || 0,
      track.bpm || '',
      track.key || '',
      track.duration || '',
      salt || 0
    ].join('|');
  }

  const API = {
    Q, H, R, M, AB,
    REGISTERS: REGISTER_META,
    hashStr, makeRng, buildBias, normEnergy, isMinorKey,
    generate, candidates, trackSeed,
    prepareExisting, collides,
    normZh, normEn, splitTitle, zhLen
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.NOMEN = API;
})(typeof window !== 'undefined' ? window : globalThis);
