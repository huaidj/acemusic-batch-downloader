#!/usr/bin/env node
// mixdesk/mcp.mjs — ACE MIX DESK MCP server（stdio）：讓任何 agent 讀電台狀態、取預先監聽任務、回傳決策/提示詞
import http from 'node:http';

const BASE = process.env.ACE_MIX_URL || 'http://127.0.0.1:8777';
const VERSION = '1.1.0';

function request(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : JSON.stringify(payload);
    const req = http.request(BASE + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); }
        catch { reject(new Error('非 JSON 回應：' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('mixdesk 連線逾時（伺服器未啟動？）')));
    if (body) req.write(body);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'mixdesk_state',
    description: '讀取 ACE MIX DESK 電台狀態：nowPlaying、queue、待辦決策、提示詞、事件。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mixdesk_pending',
    description: '取得待「預先監聽」的曲目任務（Agent 要對每首分析：放電台哪裡、下一段提示詞來源、是否推薦為目標、參考三首）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mixdesk_prelisten',
    description: '建立/預覽預先監聽決策。auto=true 用啟發式立即決策；auto=false 建立 pending 任務給 agent。',
    inputSchema: {
      type: 'object',
      properties: {
        trackId: { type: 'string' },
        auto: { type: 'boolean' },
      },
      required: ['trackId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mixdesk_submit_prelisten',
    description: '回傳預先監聽決策（fitSlot、prompt、references≤3、targetRecommendation、promptSource、nextPromptHint）。寫入後會進提示詞庫。',
    inputSchema: {
      type: 'object',
      properties: {
        trackId: { type: 'string' },
        fitSlot: { type: 'string', enum: ['opening', 'build', 'peak', 'cooldown', 'transition'] },
        prompt: { type: 'string', description: '生成提示詞（可自由寫）' },
        references: { type: 'array', items: { type: 'object' }, description: '參考曲，最多 3 首：[{trackId,role,why}]' },
        targetRecommendation: { type: 'object', description: '{selected:boolean, reason:string}' },
        slotReason: { type: 'string' },
        promptSource: { type: 'string', description: '這則提示詞的來源/依據' },
        nextPromptHint: { type: 'string' },
        decidedBy: { type: 'string' },
      },
      required: ['trackId', 'fitSlot', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'mixdesk_write_prompt',
    description: '寫入提示詞草稿（可指定參考曲 taskId，最多 3 首）。',
    inputSchema: {
      type: 'object',
      properties: {
        trackId: { type: 'string' },
        prompt: { type: 'string' },
        references: { type: 'array', items: { type: 'string' } },
        decisionId: { type: 'string' },
      },
      required: ['trackId', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'mixdesk_next',
    description: '取得下一首推薦（依 slot 曲線、BPM/調性/能量相似度；Agent 決策優先）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mixdesk_generate',
    description: '把提示詞丟進生成管線。adapter=mock 會離線產生示範音檔並回流索引（不收費）；adapter=ace 尚未接線，會明確回報需要付費授權。',
    inputSchema: {
      type: 'object',
      properties: {
        promptId: { type: 'string', description: '指定提示詞；省略時用該曲目最新的未完成提示詞' },
        trackId: { type: 'string' },
        adapter: { type: 'string', enum: ['mock', 'ace'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mixdesk_generations',
    description: '列出最近的生成任務（狀態、輸出檔、回流曲目）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mixdesk_closed_loop',
    description: '跑一輪完整閉環：預先監聽決策 → 提示詞 → mock 生成 → 新歌回流索引。',
    inputSchema: {
      type: 'object',
      properties: {
        trackId: { type: 'string', description: '省略時挑一首還沒做決策的曲目' },
        adapter: { type: 'string', enum: ['mock', 'ace'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mixdesk_index',
    description: '索引/分析曲庫（limit=0 為全部）。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'mixdesk_state': return request('GET', '/api/state');
    case 'mixdesk_pending': return request('GET', '/api/pending');
    case 'mixdesk_prelisten': return request('POST', '/api/prelisten', { trackId: args.trackId, auto: !!args.auto });
    case 'mixdesk_submit_prelisten': return request('POST', '/api/decisions', args);
    case 'mixdesk_write_prompt': return request('POST', '/api/prompts', args);
    case 'mixdesk_next': return request('GET', '/api/next');
    case 'mixdesk_generate': return request('POST', '/api/generate', { promptId: args.promptId, trackId: args.trackId, adapter: args.adapter || 'mock' });
    case 'mixdesk_generations': return request('GET', '/api/generations');
    case 'mixdesk_closed_loop': return request('POST', '/api/closed-loop', { trackId: args.trackId, adapter: args.adapter || 'mock' });
    case 'mixdesk_index': return request('POST', '/api/index', { limit: args.limit ?? 30, refresh: !!args.refresh });
    default: throw new Error('unknown tool: ' + name);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { continue; }
    handle(message).catch((err) => {
      if (message.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String((err && err.message) || err) } });
    });
  }
});

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ace-mixdesk', version: VERSION },
        instructions: 'ACE MIX DESK：AI 生成音樂混音台。用 mixdesk_state 看電台、mixdesk_pending 取預先監聽任務、mixdesk_submit_prelisten 回傳決策（fitSlot/prompt/references≤3/targetRecommendation）。',
      },
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    try {
      const result = await callTool(name, args);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (err) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String((err && err.message) || err) }) }], isError: true } });
    }
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}
