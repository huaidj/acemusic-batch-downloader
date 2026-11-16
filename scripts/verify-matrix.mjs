#!/usr/bin/env node
// scripts/verify-matrix.mjs — 驗證 12×12 提示詞矩陣：144 格都能編譯、長度合法、固定約束不丟。
// 用法：node scripts/verify-matrix.mjs <matrix.json> [--limit 1000] [--json]
// 規則來自交接文件附錄 A 的 compileCell：opening + A.phrase + B.phrase + closing；
// 固定約束（純器樂、無人聲、sub 約束）必須仍在；長度不得超過目標模型 style 上限（v1.1＝1000，ACE-Step XL＝512）。
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/verify-matrix.mjs <matrix.json> [--limit 1000] [--json]');
  process.exit(2);
}
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : 1000;
const asJson = process.argv.includes('--json');
const dict = JSON.parse(fs.readFileSync(file, 'utf8'));

/** 固定約束：每一格輸出都必須包含（小寫比對） */
const REQUIRED = [
  { id: 'instrumental', test: /\binstrumental\b/ },
  { id: 'no-vocals', test: /no vocals/ },
  { id: 'no-humming-chanting', test: /humming, chanting, speech or vocal samples/ },
  { id: 'sub-bass-centered', test: /sub-bass stays mono and centered/ },
  { id: 'bpm', test: /\b\d{2,3} bpm\b/ },
];
/** 互相矛盾的正向描述（不應同時出現在一格） */
const CONFLICTS = [
  { id: 'sub-wide-vs-mono', test: (s) => /wide sub|stereo sub|sub[^.]*left and right/.test(s) },
  { id: 'vocal-positive', test: (s) => /(?<!no )(?<!no vocals, )\b(vocal chop|sung|singing|choir|chant sample)\b/.test(s.replace(/no vocals, humming, chanting, speech or vocal samples/g, '')) },
];

const problems = [];
const lengths = [];
const seen = new Set();
const cells = [];
for (const a of dict.axis_a) {
  for (const b of dict.axis_b) {
    const style = [dict.opening_en, a.phrase_en, b.phrase_en, dict.closing_en].join(' ');
    const low = style.toLowerCase();
    const id = `${a.id}_${b.id}`;
    lengths.push(style.length);
    cells.push({ id, length: style.length });
    if (seen.has(style)) problems.push({ id, problem: '與其他格內容重複' });
    seen.add(style);
    if (style.length > LIMIT) problems.push({ id, problem: `長度 ${style.length} 超過上限 ${LIMIT}` });
    for (const req of REQUIRED) if (!req.test.test(low)) problems.push({ id, problem: '缺少固定約束：' + req.id });
    for (const c of CONFLICTS) if (c.test(low)) problems.push({ id, problem: '矛盾描述：' + c.id });
    if (/[^\x00-\x7F]/.test(style)) problems.push({ id, problem: '含非 ASCII 字元（Style 預設英文）' });
  }
}
const sorted = [...lengths].sort((x, y) => x - y);
const report = {
  file,
  limit: LIMIT,
  cells: cells.length,
  axisA: dict.axis_a.length,
  axisB: dict.axis_b.length,
  unique: seen.size,
  length: { min: sorted[0], p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] },
  overLimit: cells.filter((c) => c.length > LIMIT).length,
  problems,
  ok: problems.length === 0 && cells.length === 144 && seen.size === 144,
};
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`矩陣 ${report.axisA}×${report.axisB} = ${report.cells} 格，唯一 ${report.unique}；長度 min ${report.length.min} / p50 ${report.length.p50} / max ${report.length.max}（上限 ${LIMIT}）`);
  console.log(report.ok ? '✔ 全部通過' : `✖ ${problems.length} 個問題`);
  for (const p of problems.slice(0, 20)) console.log('  ', p.id, p.problem);
}
process.exit(report.ok ? 0 : 1);
