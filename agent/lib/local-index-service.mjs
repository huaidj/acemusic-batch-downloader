import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from './config.mjs';
import { buildLocalDownloadIndex } from './local-index.mjs';
import { loadShared } from './shared.mjs';
const { N } = loadShared();
const caches = new Map();

export function invalidateLocalIndex(cfg = config()) {
  for (const entry of caches.values()) if (entry.stateDir === path.resolve(cfg.stateDir)) entry.generation++;
}

/** Release watchers before disposing an isolated workspace or closing its owner. */
export function disposeLocalIndex(cfg = config()) {
  const stateDir = path.resolve(cfg.stateDir);
  for (const [key, entry] of caches) {
    if (entry.stateDir !== stateDir) continue;
    for (const watcher of entry.watchers) watcher.close();
    caches.delete(key);
  }
}

export function compactLocalIndex(index) {
  const byTask = {};
  for (const [id, row] of Object.entries(index.byTask)) {
    const done = row.downloaded;
    const completedKeys = [...new Set(row.files.filter((file) => file.confidence !== 'uncertain' && file.validity !== 'damaged'
      && (!['mp3', 'wav', 'audio', 'stems'].includes(file.kind) || file.validity === 'valid')
      && (file.kind === 'stems' || done[file.kind])).map((file) => file.key))];
    const uncertainKinds = new Set(row.files.filter((file) => (file.kind === 'stems' || !done[file.kind]) && (file.confidence === 'uncertain' || file.validity === 'unknown')).map((file) => file.kind));
    if (!done.mp3 && row.problems.some((problem) => ['MP3_SOURCE_UNPROVEN', 'COPIED_FROM_OTHER_TASK'].includes(problem.code))) uncertainKinds.add('mp3');
    byTask[id] = { downloaded: done, completedKeys, uncertainKinds: [...uncertainKinds], notationRequested: row.notationRequested,
      wavSupported: row.wavSupported, problemCodes: [...new Set(row.problems.map((problem) => problem.code))].slice(0, 8) };
  }
  return { ok: true, apiVersion: 1, revision: index.revision, savedAt: index.savedAt, summary: index.summary, byTask };
}

/** Native host output is capped at 1 MiB; leave room for the host's JSON wrapper. */
export function nativeIndexPayload(index) {
  const raw = Buffer.from(JSON.stringify(index), 'utf8');
  if (raw.length > 32 * 1024 * 1024) throw Object.assign(new Error('本機索引解壓大小超過上限，請透過 Hub API 分批讀取'), { code: 'NATIVE_FRAME_TOO_LARGE' });
  const payload = { ok: true, encoding: 'gzip-base64', data: gzipSync(raw).toString('base64') };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 900 * 1024) throw Object.assign(new Error('本機索引超過 native 傳輸上限，請透過 Hub API 分批讀取'), { code: 'NATIVE_FRAME_TOO_LARGE' });
  return payload;
}

export async function localDownloadIndex(cfg = config(), { root = 'ai音樂', refresh = false, full = false } = {}) {
  root = N.sanitizeComponent(root, 40) || 'ai音樂';
  const key = path.resolve(cfg.stateDir) + '|' + path.resolve(cfg.downloadDir) + '|' + root;
  let entry = caches.get(key);
  if (!entry) {
    entry = { stateDir: path.resolve(cfg.stateDir), generation: 0, indexedGeneration: -1, indexedAt: 0, pending: null, index: null, watchers: [] };
    caches.set(key, entry);
    for (const [dir, recursive] of [[path.join(cfg.downloadDir, root), true], [cfg.stateDir, false]]) {
      try {
        const watcher = fs.watch(dir, { recursive }, (_event, name) => {
          if (recursive && /\.(?:crdownload|part|tmp)$/i.test(String(name))) return;
          if (recursive || ['history.json', 'browser-download-state.json', 'agent-state.json', 'verified-audio.json', 'page-songs.json', 'page-unavailable.json'].includes(String(name))) entry.generation++;
        });
        watcher.on('error', () => { entry.generation++; }); watcher.unref(); entry.watchers.push(watcher);
      } catch { /* A not-yet-created directory is retried through the bounded cache TTL. */ }
    }
  }
  if (refresh || !entry.index || entry.generation !== entry.indexedGeneration || Date.now() - entry.indexedAt > (entry.watchers.length ? 30000 : 3000)) {
    if (!entry.pending) {
      const generation = entry.generation;
      entry.pending = buildLocalDownloadIndex({ cfg, root }).then((index) => {
        entry.index = index; entry.indexedAt = Date.now(); entry.indexedGeneration = generation; return index;
      }).finally(() => { entry.pending = null; });
    }
    await entry.pending;
  }
  return full ? { ok: true, ...entry.index } : compactLocalIndex(entry.index);
}
