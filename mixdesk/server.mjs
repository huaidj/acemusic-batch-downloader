#!/usr/bin/env node
// mixdesk/server.mjs — ACE MIX DESK：AI 生成音樂混音台 / 數據路由中心（MVP）
// 只用 Node 內建模組；音訊分析呼叫 agent/analyze_audio.py（numpy+ffmpeg）
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as agentConfig } from '../agent/lib/config.mjs';
import { analyzeFiles } from './lib/analyzer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const PORT = Number(process.env.ACE_MIX_PORT || 8777);
const HOST = process.env.ACE_MIX_HOST || '127.0.0.1';
const cfg = agentConfig();
const MIX_ROOT = process.env.ACE_MIX_LIBRARY || path.join(cfg.downloadDir, 'ai音樂', '成品MP3');
const STATE_DIR = process.env.ACE_MIX_STATE_DIR || path.join(cfg.stateDir, 'mixdesk');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
// mock 生成輸出（P4 離線閉環用）：與使用者的成品 MP3 庫分開，避免污染
const MOCK_DIR = process.env.ACE_MIX_MOCK_DIR || path.join(STATE_DIR, 'mock-library');
const ANALYZER = process.env.ACE_ANALYZER || path.join(PROJECT, 'agent', 'analyze_audio.py');
const PYTHON = process.env.ACE_PYTHON || 'python';
const SLOTS = ['opening', 'build', 'peak', 'cooldown', 'transition'];
const SLOT_TEXT = { opening: '暖場', build: '推進', peak: '高潮', cooldown: '降溫', transition: '過渡' };
const MAX_REFS = 3;
const ANALYSIS_TIMEOUT_MS = Number(process.env.ACE_MIX_ANALYSIS_TIMEOUT_MS || 600000);
const MAX_INDEX_QUEUE = 8;
let indexChain = Promise.resolve();
const indexing = { status: 'idle', queued: 0, total: 0, processed: 0, failed: 0, startedAt: null, finishedAt: null, error: null };

/* ------------------------------------------------------------------ *
 * 狀態
 * ------------------------------------------------------------------ */
const defaultState = () => ({
  schema: 'ace_mix_desk_state_v1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  station: { nowPlaying: null, slot: 'opening', startedAt: null, autoplay: false },
  tracks: [],
  decisions: [],
  prompts: [],
  generations: [],
  pending: [],
  events: [],
  counters: { track: 0, decision: 0, prompt: 0, generation: 0 },
});
let state = defaultState();
let writeChain = Promise.resolve();

function saveState() {
  state.updatedAt = new Date().toISOString();
  const snapshot = JSON.parse(JSON.stringify(state));
  writeChain = writeChain.then(async () => {
    await fsp.mkdir(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await fsp.rename(tmp, STATE_FILE);
  });
  return writeChain;
}

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.schema === 'ace_mix_desk_state_v1') state = { ...defaultState(), ...data };
  } catch {
    /* first run */
  }
}

function logEvent(type, payload = {}) {
  state.events.push({ at: new Date().toISOString(), type, payload });
  if (state.events.length > 800) state.events.splice(0, state.events.length - 800);
}

const nextId = (kind) => {
  state.counters[kind] = (Number(state.counters[kind]) || 0) + 1;
  const prefix = { track: 't_', decision: 'd_', prompt: 'p_', generation: 'g_' }[kind];
  return prefix + String(state.counters[kind]).padStart(4, '0');
};

const trimTitle = (name) => String(name || '').replace(/\.mp3$/i, '').trim();

/* ------------------------------------------------------------------ *
 * 曲庫索引 + 音訊分析
 * ------------------------------------------------------------------ */
function listLibraryFiles() {
  const roots = [MIX_ROOT, MOCK_DIR];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /\.(mp3|wav|flac|aiff?)$/i.test(entry.name)) files.push(path.join(root, entry.name));
    }
  }
  return files.sort();
}

function slotGuess(bpm, energy) {
  if (energy == null) return 'build';
  if (energy < 0.1) return 'opening';
  if (energy < 0.16) return 'build';
  if (energy < 0.22) return 'peak';
  return 'peak';
}

function indexLibrary(options = {}) {
  if (indexing.queued + Number(indexing.status === 'running') >= MAX_INDEX_QUEUE) {
    return Promise.reject(new Error('索引佇列已滿，請等待目前分析完成'));
  }
  indexing.queued += 1;
  const task = indexChain.then(async () => {
    indexing.queued -= 1;
    Object.assign(indexing, { status: 'running', total: 0, processed: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
    try {
      const result = await indexLibraryNow(options);
      indexing.status = result.failed ? 'partial' : 'done';
      return result;
    } catch (err) {
      indexing.status = 'failed';
      indexing.error = String(err.message || err);
      throw err;
    } finally {
      indexing.finishedAt = new Date().toISOString();
    }
  });
  indexChain = task.catch(() => {});
  return task;
}

async function indexLibraryNow({ limit = 30, refresh = false } = {}) {
  const files = listLibraryFiles();
  const existing = new Map(state.tracks.map((track) => [track.file, track]));
  const todo = [];
  const selected = Number(limit) > 0 ? files.slice(0, Number(limit)) : files;
  for (const file of selected) {
    const stat = fs.statSync(file);
    const old = existing.get(file);
    const oldMtime = old ? (typeof old.mtime === 'number' ? old.mtime : Date.parse(old.mtime)) : NaN;
    const sameTime = Number.isFinite(oldMtime) && Math.abs(oldMtime - stat.mtimeMs) < 1.5;
    if (!refresh && old && old.size === stat.size && sameTime && old.analyzedAt) continue;
    todo.push({ file, size: stat.size, mtime: stat.mtimeMs, old });
  }
  indexing.total = todo.length;
  const errors = [];
  const batch = 10;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const results = await analyzeFiles(chunk.map((item) => item.file), { executable: PYTHON, analyzer: ANALYZER, timeoutMs: ANALYSIS_TIMEOUT_MS });
    for (const item of chunk) {
      const analysis = results.find((result) => result && result.path && path.resolve(result.path) === path.resolve(item.file)) || {};
      const title = trimTitle(path.basename(item.file));
      const track = item.old || {
        id: nextId('track'),
        file: item.file,
        title,
        createdAt: new Date().toISOString(),
        slot: null,
        decisionId: null,
        recommended: false,
      };
      track.title = title;
      track.file = item.file;
      track.size = item.size;
      track.mtime = item.mtime;
      track.mock = item.file.startsWith(MOCK_DIR);
      track.duration = analysis.duration || null;
      track.bpm = analysis.bpm || null;
      track.key = analysis.key || null;
      track.camelot = analysis.camelot || null;
      track.energy = typeof analysis.energy === 'number' ? analysis.energy : null;
      track.analyzedAt = analysis.ok ? new Date().toISOString() : null;
      track.analysisStatus = analysis.ok ? 'done' : 'failed';
      track.analysisError = analysis.ok ? null : (analysis.error || { code: 'ANALYZER_MISSING_RESULT', message: '音訊分析結果缺失' });
      if (!analysis.ok) errors.push({ trackId: track.id, error: track.analysisError });
      track.slot = track.slot || slotGuess(track.bpm, track.energy);
      if (!item.old) state.tracks.push(track);
      indexing.processed += 1;
      indexing.failed = errors.length;
    }
    saveState().catch(() => {});
  }
  // 保留不在本次索引範圍內的舊歌曲
  logEvent('library.index', { total: state.tracks.length, analyzed: todo.length, successful: todo.length - errors.length, failed: errors.length, limit, errors });
  await saveState();
  return { total: state.tracks.length, files: files.length, analyzed: todo.length, successful: todo.length - errors.length, failed: errors.length, errors };
}

/* ------------------------------------------------------------------ *
 * 決策與提示詞
 * ------------------------------------------------------------------ */
const trackById = (id) => state.tracks.find((track) => track.id === id) || null;

function harmonicDistance(a, b) {
  if (!a || !b) return 3;
  const numA = Number(String(a).replace(/[AB]$/i, ''));
  const numB = Number(String(b).replace(/[AB]$/i, ''));
  if (!numA || !numB) return 3;
  const raw = Math.abs(numA - numB);
  return Math.min(raw, 12 - raw);
}

function similarity(from, to) {
  const bpmDiff = from.bpm && to.bpm ? Math.abs(from.bpm - to.bpm) : 20;
  const energyDiff = from.energy != null && to.energy != null ? Math.abs(from.energy - to.energy) : 0.1;
  const keyDiff = harmonicDistance(from.camelot, to.camelot);
  return bpmDiff * 1.0 + energyDiff * 60 + keyDiff * 4;
}

function chooseReferences(track) {
  const pool = state.tracks.filter((item) => item.id !== track.id && item.bpm != null);
  const ranked = pool
    .map((item) => ({ item, score: similarity(track, item) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_REFS * 2);
  const picked = [];
  const used = new Set();
  const roles = ['anchor', 'texture', 'transition'];
  for (const role of roles) {
    const candidate = ranked.find(({ item }) => !used.has(item.id) && (role !== 'anchor' || item.bpm != null));
    if (!candidate) break;
    used.add(candidate.item.id);
    picked.push({
      trackId: candidate.item.id,
      title: candidate.item.title,
      role,
      why:
        role === 'anchor'
          ? `BPM ${candidate.item.bpm ?? '-'}、調性 ${candidate.item.key || '-'} 最接近，作為主參考`
          : role === 'texture'
            ? `能量 ${candidate.item.energy ?? '-'} 接近，可參考音色/質感`
            : '提供段落過渡與律動參考',
    });
  }
  return picked;
}

function buildPrompt(track, slot, references, hint = '') {
  const mood = {
    opening: 'hypnotic, spacious, slow burn, intro',
    build: 'driving, tribal, evolving, tension',
    peak: 'peak-time, heavy, relentless, warehouse',
    cooldown: 'airy, deep, reduced, breathing',
    transition: 'bridging, minimal, atmospheric',
  }[slot];
  const refs = references.map((ref) => ref.title).join(' / ');
  const lines = [
    `[slot:${slot} 風格] ${mood}`,
    `BPM ${track.bpm ? Math.round(track.bpm) : 'auto'}、調性 ${track.key || 'auto'}${track.camelot ? `（Camelot ${track.camelot}）` : ''}、能量 ${track.energy ?? 'auto'}`,
    '編排：低頻厚實、打擊樂有機、段落 16/32 小節推進，保留 DJ 進出點',
    refs ? `參考曲目（不抄襲，取質感/律動）：${refs}` : '參考曲目：延續目前電台能量曲線',
  ];
  if (hint) lines.push(`下一段提示詞來源：${hint}`);
  return lines.join('\n');
}

function heuristicDecision(track, decidedBy = 'heuristic') {
  const now = trackById(state.station.nowPlaying);
  let slot = track.slot || 'build';
  let slotReason = '依曲目能量/BPM 自動歸類';
  if (now && now.bpm && track.bpm) {
    const bpmDelta = track.bpm - now.bpm;
    const energyDelta = (track.energy ?? 0) - (now.energy ?? 0);
    if (energyDelta > 0.04) slot = 'peak';
    else if (energyDelta > 0.015) slot = 'build';
    else if (energyDelta < -0.04) slot = 'cooldown';
    else if (Math.abs(bpmDelta) < 4) slot = 'transition';
    else slot = energyDelta >= 0 ? 'build' : 'cooldown';
    slotReason = `相對現正播放：BPM ${bpmDelta >= 0 ? '+' : ''}${bpmDelta.toFixed(1)}、能量 ${energyDelta >= 0 ? '+' : ''}${energyDelta.toFixed(3)} → ${SLOT_TEXT[slot]}`;
  }
  const references = chooseReferences(track);
  const targetRecommendation = {
    selected: (track.energy ?? 0) > 0.15 || slot === 'peak',
    reason:
      slot === 'peak'
        ? '能量與時段適合當下一首生成目標（peak 段）'
        : 'BPM/調性在可銜接範圍，列為候選推薦',
  };
  const nextPromptHint = now ? `延續「${now.title}」的 ${SLOT_TEXT[now.slot] || '目前'} 段，補一首 ${SLOT_TEXT[slot]} 段的曲目` : '從 opener 建立電台世界觀';
  const prompt = buildPrompt(track, slot, references, nextPromptHint);
  return {
    id: nextId('decision'),
    trackId: track.id,
    status: 'done',
    createdAt: new Date().toISOString(),
    decidedBy,
    analysis: { bpm: track.bpm, key: track.key, camelot: track.camelot, energy: track.energy, duration: track.duration },
    fitSlot: slot,
    slotReason,
    promptSource: now ? `現正播放「${now.title}」` : '電台開場',
    targetRecommendation,
    prompt,
    references,
    nextPromptHint,
  };
}

function applyDecision(decision) {
  const track = trackById(decision.trackId);
  if (!track) throw new Error('找不到曲目：' + decision.trackId);
  track.slot = decision.fitSlot;
  track.decisionId = decision.id;
  track.recommended = !!(decision.targetRecommendation && decision.targetRecommendation.selected);
  state.decisions.push(decision);
  state.pending = state.pending.filter((item) => item.trackId !== decision.trackId);
  const prompt = {
    id: nextId('prompt'),
    trackId: decision.trackId,
    decisionId: decision.id,
    prompt: decision.prompt,
    references: (decision.references || []).map((ref) => ref.trackId),
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  state.prompts.push(prompt);
  logEvent('decision.applied', { decisionId: decision.id, trackId: decision.trackId, slot: decision.fitSlot, promptId: prompt.id });
  return prompt;
}

function createPending(trackId) {
  const track = trackById(trackId);
  if (!track) throw new Error('找不到曲目：' + trackId);
  const existing = state.pending.find((item) => item.trackId === trackId);
  if (existing) return existing;
  const pending = {
    id: nextId('decision'),
    trackId,
    title: track.title,
    status: 'pending',
    createdAt: new Date().toISOString(),
    track: {
      bpm: track.bpm,
      key: track.key,
      camelot: track.camelot,
      energy: track.energy,
      duration: track.duration,
    },
    context: state.station,
  };
  state.pending.push(pending);
  logEvent('prelisten.pending', { trackId, pendingId: pending.id });
  return pending;
}

function nextTrack() {
  const now = trackById(state.station.nowPlaying);
  const currentSlot = state.station.slot || 'opening';
  const nextSlot = SLOTS[(SLOTS.indexOf(currentSlot) + 1) % SLOTS.length];
  const pool = state.tracks.filter((track) => track.id !== state.station.nowPlaying);
  if (!pool.length) return null;
  const scored = pool
    .map((track) => {
      let score = 0;
      if (track.slot === nextSlot) score -= 30;
      if (now) score += similarity(now, track);
      if (track.recommended) score -= 10;
      return { track, score };
    })
    .sort((a, b) => a.score - b.score);
  return { track: scored[0].track, nextSlot };
}

/* ------------------------------------------------------------------ *
 * P4：生成任務（mock 離線閉環；ACE 付費生成未接線）
 * ------------------------------------------------------------------ */
function ensureMockDir() {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
}

// 產生一段可被 analyze_audio.py 解析的節拍 WAV（124 BPM 低頻 kick + 微弱 pad）
function writeMockWav(file, { seconds = 8, bpm = 124, sr = 22050 } = {}) {
  const total = Math.floor(seconds * sr);
  const data = Buffer.alloc(total * 2);
  const beat = Math.max(1, Math.round((sr * 60) / Math.max(60, Math.min(200, bpm))));
  const click = Math.max(1, Math.round(sr * 0.03));
  for (let i = 0; i < total; i += 1) {
    const phase = i % beat;
    let value = Math.sin((2 * Math.PI * 110 * i) / sr) * 0.03;
    if (phase < click) value += Math.sin((2 * Math.PI * 55 * i) / sr) * Math.exp(-phase / (sr * 0.012)) * 0.7;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function latestOpenPrompt(trackId) {
  for (let i = state.prompts.length - 1; i >= 0; i -= 1) {
    const prompt = state.prompts[i];
    if ((!trackId || prompt.trackId === trackId) && prompt.status !== 'done') return prompt;
  }
  return null;
}

async function generateFromPrompt(prompt, adapter = 'mock') {
  const track = trackById(prompt.trackId);
  const generation = {
    id: nextId('generation'),
    promptId: prompt.id,
    trackId: prompt.trackId,
    adapter,
    status: 'generating',
    createdAt: new Date().toISOString(),
  };
  state.generations.push(generation);
  prompt.status = 'generating';
  logEvent('generation.start', { generationId: generation.id, promptId: prompt.id, adapter });
  await saveState();
  if (adapter !== 'mock') {
    generation.status = 'failed';
    generation.error = 'ACE 生成需要付費/額度授權，目前未接線；請用 adapter=mock 或人工生成';
    generation.finishedAt = new Date().toISOString();
    prompt.status = 'draft';
    logEvent('generation.failed', { generationId: generation.id, reason: generation.error });
    await saveState();
    return generation;
  }
  try {
    ensureMockDir();
    const title = '[MOCK] ' + prompt.id + ' ' + trimTitle(track ? track.title : 'untitled');
    const file = path.join(MOCK_DIR, title + '.wav');
    writeMockWav(file, { seconds: 8, bpm: track && track.bpm ? Math.round(track.bpm) : 124 });
    generation.file = file;
    await indexLibrary({ limit: 0 });
    const created = state.tracks.find((item) => item.file === file) || null;
    generation.resultTrackId = created ? created.id : null;
    generation.status = 'done';
    generation.finishedAt = new Date().toISOString();
    prompt.status = 'done';
    prompt.generatedTaskId = generation.resultTrackId;
    logEvent('generation.done', { generationId: generation.id, file, resultTrackId: generation.resultTrackId });
  } catch (err) {
    generation.status = 'failed';
    generation.error = String((err && err.message) || err);
    generation.finishedAt = new Date().toISOString();
    prompt.status = 'draft';
    logEvent('generation.failed', { generationId: generation.id, reason: generation.error });
  }
  await saveState();
  return generation;
}

async function runClosedLoop({ trackId, adapter = 'mock' } = {}) {
  const track = trackId
    ? trackById(trackId)
    : state.tracks.find((item) => !item.decisionId) || state.tracks[0];
  if (!track) throw new Error('曲庫是空的：先呼叫 /api/index');
  const decision = heuristicDecision(track, 'closed-loop');
  const prompt = applyDecision(decision);
  await saveState();
  const generation = await generateFromPrompt(prompt, adapter);
  return {
    trackId: track.id,
    decisionId: decision.id,
    promptId: prompt.id,
    slot: decision.fitSlot,
    promptStatus: prompt.status,
    generation,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function streamMedia(req, res, track) {
  if (!track || !fs.existsSync(track.file)) return json(res, 404, { ok: false, error: '找不到音檔' });
  const stat = fs.statSync(track.file);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(track.file).pipe(res);
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match && match[1] ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : stat.size - 1;
  if (start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Type': 'audio/mpeg',
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
  });
  fs.createReadStream(track.file, { start, end }).pipe(res);
}

function stateSummary() {
  return {
    ok: true,
    station: state.station,
    counts: {
      tracks: state.tracks.length,
      decisions: state.decisions.length,
      prompts: state.prompts.length,
      pending: state.pending.length,
      generations: state.generations.length,
    },
    nowPlaying: trackById(state.station.nowPlaying),
    queue: state.tracks.filter((track) => track.id !== state.station.nowPlaying).slice(0, 12).map((track) => ({ id: track.id, title: track.title, slot: track.slot, bpm: track.bpm, key: track.key, energy: track.energy, mock: !!track.mock })),
    pending: state.pending,
    prompts: state.prompts.slice(-20),
    generations: state.generations.slice(-10),
    events: state.events.slice(-40),
    libraryRoot: MIX_ROOT,
    mockRoot: MOCK_DIR,
    slots: SLOTS,
    indexing: { ...indexing },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      const html = await fsp.readFile(path.join(HERE, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (pathname.startsWith('/media/')) {
      const id = decodeURIComponent(pathname.slice('/media/'.length));
      return streamMedia(req, res, trackById(id));
    }

    if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, stateSummary());

    if (pathname === '/api/index' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await indexLibrary({ limit: body.limit ?? 30, refresh: !!body.refresh });
      return json(res, 200, { ok: result.failed === 0, ...result });
    }

    if (pathname === '/api/pending' && req.method === 'GET') return json(res, 200, { ok: true, pending: state.pending });

    if (pathname === '/api/prelisten' && req.method === 'POST') {
      const body = await readBody(req);
      const trackId = body.trackId;
      if (body.auto) {
        const track = trackById(trackId);
        if (!track) return json(res, 404, { ok: false, error: '找不到曲目' });
        const decision = heuristicDecision(track, body.decidedBy || 'heuristic');
        const prompt = applyDecision(decision);
        await saveState();
        return json(res, 200, { ok: true, decision, promptId: prompt.id });
      }
      const pending = createPending(trackId);
      await saveState();
      return json(res, 200, { ok: true, pending });
    }

    if (pathname === '/api/decisions' && req.method === 'POST') {
      const body = await readBody(req);
      const input = body.decision || body;
      const track = trackById(input.trackId);
      if (!track) return json(res, 404, { ok: false, error: '找不到曲目：' + input.trackId });
      const refs = Array.isArray(input.references) ? input.references : [];
      if (refs.length > MAX_REFS) return json(res, 400, { ok: false, error: `參考曲最多 ${MAX_REFS} 首（收到 ${refs.length}）` });
      const badRef = refs.find((ref) => !trackById(ref.trackId || ref));
      if (badRef) return json(res, 400, { ok: false, error: '參考曲不在本機曲庫：' + JSON.stringify(badRef) });
      if (!input.fitSlot || !SLOTS.includes(input.fitSlot)) return json(res, 400, { ok: false, error: 'fitSlot 必須是 ' + SLOTS.join('/') });
      if (!input.prompt || !String(input.prompt).trim()) return json(res, 400, { ok: false, error: 'prompt 不能為空' });
      const decision = {
        id: input.id || nextId('decision'),
        trackId: input.trackId,
        status: 'done',
        createdAt: new Date().toISOString(),
        decidedBy: input.decidedBy || 'agent',
        analysis: input.analysis || { bpm: track.bpm, key: track.key, camelot: track.camelot, energy: track.energy, duration: track.duration },
        fitSlot: input.fitSlot,
        slotReason: input.slotReason || '',
        promptSource: input.promptSource || '',
        targetRecommendation: input.targetRecommendation || { selected: false, reason: '' },
        prompt: String(input.prompt),
        references: refs.map((ref) => ({ trackId: ref.trackId || ref, title: (trackById(ref.trackId || ref) || {}).title || '', role: ref.role || 'reference', why: ref.why || '' })),
        nextPromptHint: input.nextPromptHint || '',
      };
      const prompt = applyDecision(decision);
      await saveState();
      return json(res, 200, { ok: true, decision, promptId: prompt.id });
    }

    if (pathname === '/api/prompts' && req.method === 'POST') {
      const body = await readBody(req);
      const track = trackById(body.trackId);
      if (!track) return json(res, 404, { ok: false, error: '找不到曲目' });
      const refs = Array.isArray(body.references) ? body.references.slice(0, MAX_REFS) : [];
      const prompt = {
        id: nextId('prompt'),
        trackId: body.trackId,
        decisionId: body.decisionId || track.decisionId,
        prompt: String(body.prompt || ''),
        references: refs.map((ref) => ref.trackId || ref),
        status: 'draft',
        createdAt: new Date().toISOString(),
      };
      state.prompts.push(prompt);
      logEvent('prompt.written', { promptId: prompt.id, trackId: prompt.trackId });
      await saveState();
      return json(res, 200, { ok: true, prompt });
    }

    if (pathname === '/api/generate' && req.method === 'POST') {
      const body = await readBody(req);
      const prompt = body.promptId
        ? state.prompts.find((item) => item.id === body.promptId)
        : latestOpenPrompt(body.trackId);
      if (!prompt) return json(res, 404, { ok: false, error: '找不到可生成的提示詞（先建立 prelisten 決策或寫入 prompt）' });
      const generation = await generateFromPrompt(prompt, body.adapter || 'mock');
      return json(res, 200, { ok: generation.status === 'done', generation, prompt });
    }

    if (pathname === '/api/generations' && req.method === 'GET') {
      return json(res, 200, { ok: true, generations: state.generations.slice(-50) });
    }

    if (pathname === '/api/closed-loop' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await runClosedLoop({ trackId: body.trackId, adapter: body.adapter || 'mock' });
      return json(res, 200, { ok: result.generation.status === 'done', ...result });
    }

    if (pathname === '/api/play' && req.method === 'POST') {
      const body = await readBody(req);
      const track = trackById(body.trackId);
      if (!track) return json(res, 404, { ok: false, error: '找不到曲目' });
      state.station.nowPlaying = track.id;
      state.station.slot = track.slot || 'build';
      state.station.startedAt = new Date().toISOString();
      logEvent('station.play', { trackId: track.id, title: track.title, slot: state.station.slot });
      await saveState();
      return json(res, 200, { ok: true, station: state.station });
    }

    if (pathname === '/api/queue' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.trackId) {
        const track = trackById(body.trackId);
        if (!track) return json(res, 404, { ok: false, error: '找不到曲目' });
        return json(res, 200, { ok: true, track });
      }
      const recommendation = nextTrack();
      return json(res, 200, { ok: true, ...recommendation });
    }

    if (pathname === '/api/next' && req.method === 'GET') {
      const recommendation = nextTrack();
      return json(res, 200, { ok: true, ...recommendation });
    }

    if (pathname === '/api/events' && req.method === 'GET') return json(res, 200, { ok: true, events: state.events.slice(-100) });

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not found: ' + pathname }));
  } catch (err) {
    json(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

await loadState();
const indexLimit = Number(process.env.ACE_MIX_INDEX_LIMIT || 30);
server.listen(PORT, HOST, () => {
  console.log(`[mixdesk] ACE MIX DESK 已啟動：http://${HOST}:${PORT}`);
  console.log(`[mixdesk] 曲庫：${MIX_ROOT}`);
  console.log(`[mixdesk] 狀態：${STATE_FILE}（${state.tracks.length} 首曲目）`);
  if (!state.tracks.length) {
    console.log('[mixdesk] 首次啟動，背景索引曲庫（limit ' + indexLimit + '）…');
    indexLibrary({ limit: indexLimit }).catch((err) => {
      logEvent('library.index.failed', { error: String(err.message || err) });
      saveState().catch(() => {});
    });
  }
});
