// Bounded, session-persistent diagnostics. No account/session/cookie reads.
(() => {
  'use strict';
  const MAX_EVENTS = 200;
  const KEY = 'aceDownloadDiagnosticsV1';
  const FIELDS = ['taskId', 'kind', 'filename', 'phase', 'errorCode', 'error', 'current'];
  const NUMBERS = ['elapsedMs', 'activePrep', 'activeDl'];
  function redact(value, limit = 320) {
    return String(value == null ? '' : value).slice(0, 16384)
      .replace(/(?:https?|blob|file|data|chrome-extension):[^\s<>"']+/gi, '[url]')
      .replace(/\b(?:set-cookie|cookie|authorization)\s*[:=]\s*[^\r\n]*/gi, '[redacted]')
      .replace(/\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|secret|password|sess(?:ion)?(?:id)?|sid)\s*["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '[redacted]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[secret]')
      .replace(/\b[A-Za-z]:[\\/][^\s<>"']+/g, '[path]')
      .slice(0, limit);
  }
  function utc(value, fallback) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(fallback).toISOString();
  }
  function sanitizeEvent(raw, now = Date.now()) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const output = { at: utc(input.at, now), event: redact(input.event || 'event', 48).replace(/[^a-zA-Z0-9_-]/g, '_') };
    for (const key of FIELDS) if (input[key] != null) output[key] = redact(input[key], key === 'filename' ? 180 : 320);
    for (const key of NUMBERS) if (Number.isFinite(Number(input[key]))) output[key] = Math.max(0, Math.min(1e12, Number(input[key])));
    if (input.counts && typeof input.counts === 'object') {
      output.counts = {};
      for (const key of ['songs', 'done', 'failed', 'skipped', 'total', 'rateLimited']) {
        if (Number.isFinite(Number(input.counts[key]))) output.counts[key] = Math.max(0, Math.min(1e9, Number(input.counts[key])));
      }
    }
    return output;
  }
  function sanitizeSnapshot(raw, now = Date.now()) {
    const output = { schema: 'ace-download-diagnostics-v1', savedAt: new Date(now).toISOString(),
      events: (raw && Array.isArray(raw.events) ? raw.events : []).slice(-MAX_EVENTS).map((entry) => sanitizeEvent(entry, now)) };
    while (JSON.stringify(output).length > 240000 && output.events.length) output.events.shift();
    return output;
  }
  function createLogger({ storage = null, key = KEY, now = Date.now, onRecord = null } = {}) {
    let events = [];
    try { events = sanitizeSnapshot(JSON.parse(storage && storage.getItem(key)), now()).events; } catch (_) { /* unavailable or malformed storage */ }
    const snapshot = () => sanitizeSnapshot({ events }, now());
    const persist = () => { try { if (storage) storage.setItem(key, JSON.stringify(snapshot())); } catch (_) { /* ring remains available in memory */ } };
    return {
      record(event, fields = {}) {
        const entry = sanitizeEvent({ ...fields, event, at: new Date(now()).toISOString() }, now());
        events.push(entry);
        if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
        persist();
        try { if (onRecord) onRecord(entry); } catch (_) { /* logging must never stop a download */ }
        return entry;
      }, snapshot, persist,
    };
  }
  globalThis.AceDLDiagnostics = Object.freeze({ MAX_EVENTS, KEY, redact, sanitizeEvent, sanitizeSnapshot, createLogger });
})();
