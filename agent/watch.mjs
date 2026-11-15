#!/usr/bin/env node
// agent/watch.mjs — 靜默背景整理 daemon：監看 ai音樂 變化 → 補齊成品MP3 → 採樣包 → 分類搬移 → 去重
import fs from 'node:fs';
import path from 'node:path';
import { config, writeJson, readJson, sleep } from './lib/config.mjs';
import { extractFullMp3s, collectSamples, classifyByAttributes, dedupeSongCopies, classifyByAudio, listSongs } from './lib/ace.mjs';

const cfg = config();
const ROOT_NAME = process.env.ACE_WATCH_ROOT || 'ai音樂';
const ROOT = path.join(cfg.downloadDir, ROOT_NAME);
const STATUS_FILE = path.join(cfg.stateDir, 'watch-status.json');
const POLL_MS = Math.max(5000, Number(process.env.ACE_WATCH_INTERVAL || 20000));
const STARTED_AT = new Date().toISOString();
let stopped = false;
let currentPhase = 'idle';

function statusBase(extra = {}) {
  return { pid: process.pid, startedAt: STARTED_AT, root: ROOT, pollMs: POLL_MS, phase: currentPhase, beatAt: new Date().toISOString(), ...extra };
}

async function setStatus(extra = {}) {
  await writeJson(STATUS_FILE, statusBase(extra)).catch(() => {});
}

function fingerprint() {
  const result = { files: 0, bytes: 0, latest: 0 };
  if (!fs.existsSync(ROOT)) return result;
  // 忽略自動整理自己產生的檔案，否則 manifest 一寫入就自我觸發、每 20 秒空跑一次
  const IGNORE_NAMES = new Set(['_manifest.json']);
  const IGNORE_EXT = /\.(part|tmp|crdownload)$/i;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          if (depth > 0) walk(full, depth - 1);
        } else {
          if (IGNORE_NAMES.has(entry.name.toLowerCase()) || IGNORE_EXT.test(entry.name)) continue;
          const stat = fs.statSync(full);
          result.files += 1;
          result.bytes += stat.size;
          if (stat.mtimeMs > result.latest) result.latest = stat.mtimeMs;
        }
      } catch { /* ignore */ }
    }
  };
  walk(ROOT, 2);
  return result;
}

async function runPipeline() {
  const startedAt = new Date().toISOString();
  currentPhase = 'running';
  const status = { phase: 'running', pid: process.pid, startedAt, root: ROOT, steps: [], ok: false };
  await writeJson(STATUS_FILE, status);
  try {
    const songs = await listSongs(cfg, { refresh: true });
    const mp3 = await extractFullMp3s({ songs, cfg, concurrency: 3 });
    status.steps.push({ name: 'mp3', total: mp3.total, downloaded: mp3.downloaded, copied: mp3.copied, skipped: mp3.skipped, failed: mp3.failed.length });
    const samples = await collectSamples({ root: ROOT_NAME, cfg });
    status.steps.push({ name: 'samples', total: samples.total, copied: samples.copied, skipped: samples.skipped, migrated: samples.migrated, failed: samples.failed.length });
    const classify = await classifyByAttributes({ root: ROOT_NAME, move: true, cfg });
    status.steps.push({ name: 'classify', total: classify.total, moved: classify.moved, copied: classify.copied, skipped: classify.skipped, failed: classify.failed.length });
    const dedupe = await dedupeSongCopies({ root: ROOT_NAME, cfg });
    status.steps.push({ name: 'dedupe', removed: dedupe.removed, savedMB: Math.round(dedupe.savedBytes / 1048576), failed: dedupe.failed.length });
    const audio = await classifyByAudio({ root: ROOT_NAME, cfg });
    status.steps.push({ name: 'audio', total: audio.total, analyzed: audio.analyzed, linked: audio.linked, failed: audio.failed.length, unanalyzable: audio.unanalyzable ? audio.unanalyzable.length : 0 });
    status.ok = !status.steps.some((step) => step.failed > 0);
    await setStatus({ phase: 'running', startedAt, steps: status.steps });
  } catch (err) {
    status.error = String((err && err.message) || err);
  }
  status.phase = 'idle';
  status.finishedAt = new Date().toISOString();
  currentPhase = 'idle';
  await writeJson(STATUS_FILE, { ...status, lastRunAt: status.finishedAt });
  return status;
}

async function main() {
  console.log('[watch] 靜默背景整理啟動，監看：' + ROOT + '（每 ' + Math.round(POLL_MS / 1000) + ' 秒）');
  currentPhase = 'idle';
  await setStatus({ startedAt: STARTED_AT });
  let last = null;
  while (!stopped) {
    const fp = fingerprint();
    if (!last || fp.files !== last.files || fp.bytes !== last.bytes || fp.latest !== last.latest) {
      console.log('[watch] 偵測到變化，自動整理開始（首次會補齊成品MP3）');
      const result = await runPipeline();
      last = fingerprint();
      console.log('[watch] 完成：' + JSON.stringify(result.steps.map((step) => step.name + ':' + (step.downloaded ?? step.copied ?? step.moved ?? step.removed ?? 0))));
    }
    const deadline = Date.now() + POLL_MS;
    while (!stopped && Date.now() < deadline) await sleep(Math.min(1000, deadline - Date.now()));
    if (!stopped) await setStatus({ lastFingerprint: { files: last ? last.files : 0, bytes: last ? last.bytes : 0 } });
  }
  currentPhase = 'stopped';
  await setStatus({ stoppedAt: new Date().toISOString() });
}

async function shutdown(signal) {
  stopped = true;
  currentPhase = 'stopped';
  await setStatus({ stoppedAt: new Date().toISOString(), signal });
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('uncaughtException', async (err) => {
  currentPhase = 'error';
  await setStatus({ error: String((err && err.message) || err), crashedAt: new Date().toISOString() }).catch(() => {});
  process.exit(1);
});
process.on('unhandledRejection', async (err) => {
  currentPhase = 'error';
  await setStatus({ error: String((err && err.message) || err), crashedAt: new Date().toISOString() }).catch(() => {});
  process.exit(1);
});
if (process.argv.includes('--once')) {
  await runPipeline().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });
} else {
  await main();
}
