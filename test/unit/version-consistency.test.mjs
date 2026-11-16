// 版本號只有 manifest.json 一個來源；其他入口要等於它，介面不得寫死版本（1.8.1–1.8.5 曾讓面板與播放器停在 1.8.0）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const version = JSON.parse(read('manifest.json')).version;

test('package, CLI banner and MCP server report the manifest version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).version, version, 'package.json');
  assert.match(read('agent/cli.mjs'), new RegExp('CLI\\s+v' + version.replace(/\./g, '\\.') + '\\b'), 'CLI banner');
  assert.match(read('agent/mcp.mjs'), new RegExp("version: '" + version.replace(/\./g, '\\.') + "'"), 'MCP server version');
});

test('panel, player server and player page derive the version instead of hard-coding it', () => {
  const semverLiteral = /['"`]v?\d+\.\d+\.\d+['"`]/;
  const content = read('src/content.js');
  assert.ok(content.includes('chrome.runtime.getManifest().version'), 'panel reads the extension manifest');
  for (const rel of ['player/server.mjs', 'player/public/app.js']) {
    const code = read(rel).split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    const hits = code.filter((line) => semverLiteral.test(line) && !/HuaiDJ-ACE|ace_|schema/.test(line));
    assert.deepEqual(hits, [], rel + ' has no hard-coded version');
  }
});
