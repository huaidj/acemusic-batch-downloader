// 設計 token 把關：面板（src/content.js 的 :host）與 design/tokens.css 的共用色彩必須逐項一致；面板不得出現寫死的漸層／發光
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}

test('🔒 面板 :host 的共用色彩與 design/tokens.css 一致', () => {
  const tokens = read('design/tokens.css');
  const root = /:root \{([\s\S]*?)\n\}/.exec(tokens);
  assert.ok(root, '找不到 tokens.css 的 :root');
  const tokenVars = declarations(root[1]);
  const content = read('src/content.js');
  const host = /:host \{([\s\S]*?)\n\}/.exec(content);
  assert.ok(host, '找不到面板的 :host');
  const hostVars = declarations(host[1]);
  const shared = Object.keys(hostVars);
  assert.ok(shared.length >= 18, '面板應定義完整色彩變數');
  const diffs = [];
  for (const name of shared) {
    if (tokenVars[name] == null) diffs.push(`${name}: tokens.css 沒有定義`);
    else if (tokenVars[name].replace(/\s+/g, '') !== hostVars[name].replace(/\s+/g, '')) diffs.push(`${name}: 面板 ${hostVars[name]} ≠ tokens ${tokenVars[name]}`);
  }
  assert.deepEqual(diffs, []);
});

test('🔒 面板樣式不寫死色碼：顏色都走變數（品牌色彩只在 :host）', () => {
  const content = read('src/content.js');
  const css = /const CSS = `([\s\S]*?)\n`;/.exec(content);
  assert.ok(css, '找不到面板 CSS');
  const hostEnd = css[1].indexOf('* { box-sizing');
  const body = css[1].slice(hostEnd);
  const hard = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(hard, [], '元件樣式不得出現寫死的 #色碼：' + hard.join(','));
});

test('🔒 去 AI 味：面板樣式沒有漸層與發光（linear-gradient／radial-gradient／彩色 box-shadow glow）', () => {
  const css = /const CSS = `([\s\S]*?)\n`;/.exec(read('src/content.js'))[1];
  assert.ok(!/linear-gradient|radial-gradient|conic-gradient/.test(css), '不得使用漸層');
  const glows = [...css.matchAll(/box-shadow:[^;]*0 0 \d+px/g)].map((m) => m[0]);
  assert.deepEqual(glows, [], '不得使用光暈 box-shadow');
});
