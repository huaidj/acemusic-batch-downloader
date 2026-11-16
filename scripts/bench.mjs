#!/usr/bin/env node
// scripts/bench.mjs — 效能基準：Hub 端點、CLI 指令、MCP 工具呼叫。結果寫 test/.tmp/bench.json。
// 用法：node scripts/bench.mjs [--rounds 20]（需 Hub 在跑：node agent\cli.mjs hub --background）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { hubRequest } = await import(pathToFileURL(path.join(ROOT, 'agent', 'lib', 'hubclient.mjs')).href);
const HUB = process.env.ACE_HUB_URL || 'http://127.0.0.1:8788';
const roundsArg = process.argv.indexOf('--rounds');
const ROUNDS = roundsArg > 0 ? Number(process.argv[roundsArg + 1]) || 20 : 20;

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, min: s[0], p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
};
const round1 = (n) => Math.round(n * 10) / 10;

async function benchHub() {
  const out = {};
  const endpoints = ['/health', '/overview', '/songs?limit=50&compact=1', '/locate', '/locate?latest=5', '/library', '/page/events?limit=20', '/page'];
  for (const ep of endpoints) {
    const times = [];
    let bytes = 0;
    let ok = true;
    for (let i = 0; i < ROUNDS; i += 1) {
      const t = performance.now();
      try {
        const res = await hubRequest(ep, { base: HUB, timeoutMs: 10000 });
        bytes = JSON.stringify(res.data).length;
        ok = ok && res.status === 200;
      } catch {
        ok = false;
      }
      times.push(round1(performance.now() - t));
    }
    out[ep] = { ok, bytes, ms: stats(times) };
  }
  return out;
}

function benchCli() {
  const out = {};
  const cmds = [['doctor'], ['status', '--json'], ['locate', '--json'], ['library', '--json'], ['list', '--limit', '5', '--json']];
  for (const args of cmds) {
    const times = [];
    let code = 0;
    for (let i = 0; i < 5; i += 1) {
      const t = performance.now();
      const r = spawnSync(process.execPath, [path.join(ROOT, 'agent', 'cli.mjs'), ...args], { encoding: 'utf8' });
      times.push(round1(performance.now() - t));
      code = code || r.status;
    }
    out[args.join(' ')] = { exit: code, ms: stats(times) };
  }
  return out;
}

async function benchMcp() {
  const child = spawn(process.execPath, [path.join(ROOT, 'agent', 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buf += String(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const w = waiting.get(msg.id);
        if (w) {
          waiting.delete(msg.id);
          w(msg);
        }
      } catch { /* ignore */ }
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const t0 = performance.now();
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '0' } });
  const out = { startupMs: round1(performance.now() - t0) };
  for (const [name, args] of [['ace_overview', {}], ['ace_locate', {}], ['ace_list_songs', { limit: 20 }], ['ace_library', {}], ['ace_events', { limit: 10 }]]) {
    const times = [];
    let bytes = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const t = performance.now();
      const res = await call('tools/call', { name, arguments: args });
      times.push(round1(performance.now() - t));
      bytes = JSON.stringify(res).length;
    }
    out[name] = { bytes, ms: stats(times) };
  }
  child.kill();
  return out;
}

const result = { at: new Date().toISOString(), rounds: ROUNDS, hub: await benchHub(), cli: benchCli(), mcp: await benchMcp() };
const file = path.join(ROOT, 'test', '.tmp', 'bench.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(result, null, 2));
const line = (k, v) => console.log(`${k.padEnd(28)} p50 ${String(v.ms.p50).padStart(7)} ms  p95 ${String(v.ms.p95).padStart(7)} ms${v.bytes ? `  ${v.bytes} B` : ''}${v.ok === false || v.exit ? '  ✖' : ''}`);
console.log('— Hub'); for (const [k, v] of Object.entries(result.hub)) line(k, v);
console.log('— CLI（含 node 啟動）'); for (const [k, v] of Object.entries(result.cli)) line(k, v);
console.log(`— MCP（啟動 ${result.mcp.startupMs} ms）`); for (const [k, v] of Object.entries(result.mcp)) if (v.ms) line(k, v);
console.log('寫入 ' + file);
