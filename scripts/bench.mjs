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
if (!Number.isSafeInteger(ROUNDS) || ROUNDS <= 0) throw new Error('--rounds must be a positive finite integer');

const stats = (arr) => {
  if (!arr.length) return { n: 0, min: null, p50: null, p95: null, max: null };
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
        ok = ok && res.status === 200 && res.data?.ok !== false;
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
      const r = spawnSync(process.execPath, [path.join(ROOT, 'agent', 'cli.mjs'), ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      times.push(round1(performance.now() - t));
      code = code || (r.status ?? 1);
    }
    out[args.join(' ')] = { exit: code, ms: stats(times) };
  }
  return out;
}

export async function benchMcp({ rounds = ROUNDS, timeoutMs = 15000, command = process.execPath, args = [path.join(ROOT, 'agent', 'mcp.mjs')] } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  child.stdout.setEncoding('utf8');
  const waiting = new Map();
  let childFailure = null;
  const rejectAll = (error) => {
    childFailure = childFailure || error;
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(childFailure); }
    waiting.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', (code, signal) => rejectAll(new Error(`MCP exited before reply (${code ?? signal})`)));
  child.stdin.on('error', rejectAll);
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
          clearTimeout(w.timer);
          waiting.delete(msg.id);
          w.resolve(msg);
        }
      } catch { /* ignore */ }
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      if (childFailure) return reject(childFailure);
      const requestId = ++id;
      const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`MCP ${method} timeout ${timeoutMs}ms`)); }, timeoutMs);
      waiting.set(requestId, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); }
      catch (error) { clearTimeout(timer); waiting.delete(requestId); reject(error); }
    });
  const checked = (response) => {
    if (response.error || !response.result || response.result.isError) throw new Error(response.error?.message || response.result?.content?.map((item) => item.text || '').join(' ') || 'MCP returned an error');
    for (const item of response.result.content || []) {
      if (item.type !== 'text') continue;
      let data; try { data = JSON.parse(item.text); } catch { continue; }
      if (data?.ok === false) throw new Error(data.error || 'MCP tool reported ok=false');
    }
    return response;
  };
  const t0 = performance.now();
  const out = { ok: true, startupMs: null };
  try {
  checked(await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '0' } }));
  out.startupMs = round1(performance.now() - t0);
  for (const [name, args] of [['ace_overview', {}], ['ace_locate', {}], ['ace_list_songs', { limit: 20 }], ['ace_library', {}], ['ace_events', { limit: 10 }]]) {
    const times = [];
    let bytes = 0;
    const errors = [];
    for (let i = 0; i < rounds; i += 1) {
      const t = performance.now();
      try {
        const res = checked(await call('tools/call', { name, arguments: args }));
        times.push(round1(performance.now() - t));
        bytes = JSON.stringify(res).length;
      } catch (error) { errors.push(error.message); out.ok = false; break; }
    }
    out[name] = { ok: errors.length === 0, bytes, ms: stats(times), errors };
  }
  } catch (error) { out.ok = false; out.error = error.message; out.startupMs = round1(performance.now() - t0); }
  finally { rejectAll(new Error('MCP benchmark ended')); child.kill(); }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const result = { at: new Date().toISOString(), rounds: ROUNDS, hub: await benchHub(), cli: benchCli(), mcp: await benchMcp() };
const file = path.join(ROOT, 'test', '.tmp', 'bench.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(result, null, 2));
const line = (k, v) => console.log(`${k.padEnd(28)} p50 ${String(v.ms.p50).padStart(7)} ms  p95 ${String(v.ms.p95).padStart(7)} ms${v.bytes ? `  ${v.bytes} B` : ''}${v.ok === false || v.exit ? '  ✖' : ''}`);
console.log('— Hub'); for (const [k, v] of Object.entries(result.hub)) line(k, v);
console.log('— CLI（含 node 啟動）'); for (const [k, v] of Object.entries(result.cli)) line(k, v);
console.log(`— MCP（啟動 ${result.mcp.startupMs} ms）${result.mcp.ok === false ? ' ✖ ' + (result.mcp.error || '含失敗項目') : ''}`); for (const [k, v] of Object.entries(result.mcp)) if (v?.ms) line(k, v);
console.log('寫入 ' + file);
if (Object.values(result.hub).some((item) => !item.ok) || Object.values(result.cli).some((item) => item.exit !== 0) || result.mcp.ok === false) process.exitCode = 1;
}
