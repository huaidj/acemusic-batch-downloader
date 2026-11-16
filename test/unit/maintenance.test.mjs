// 備份保留（預設只預覽、commit 才刪、保留最近）、母帶清單（WAV 標頭解析、版本拆分，唯讀）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ACE = await import('../../agent/lib/ace.mjs');
const { config } = await import('../../agent/lib/config.mjs');

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-maint-'));
  const cfg = { ...config(), stateDir: path.join(base, 'state'), downloadDir: path.join(base, 'downloads') };
  return { base, cfg };
}

function makeBackup(cfg, name, ageDays, bytes) {
  const dir = path.join(cfg.stateDir, 'organize-backups', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(dir, t, t);
  return dir;
}

test('pruneBackups：預設只預覽；保留最近 1 個；超過天數才列入；commit 才刪', async () => {
  const { cfg } = sandbox();
  const oldest = makeBackup(cfg, 'content-old', 30, 1000);
  makeBackup(cfg, 'content-mid', 10, 2000);
  makeBackup(cfg, 'content-new', 1, 3000);
  const latestOld = makeBackup(cfg, 'content-latest-but-old', 0.1, 10);

  const preview = await ACE.pruneBackups(cfg, { keepDays: 7, keepLast: 1 });
  assert.equal(preview.committed, false);
  assert.deepEqual(preview.prune.map((b) => b.name).sort(), ['content-mid', 'content-old']);
  assert.equal(preview.bytesReclaimable, 3000);
  assert.ok(fs.existsSync(oldest), '預覽不得刪除');

  const capped = await ACE.pruneBackups(cfg, { keepDays: 365, keepLast: 1, maxBytes: 3500 });
  assert.deepEqual(capped.prune.map((b) => b.name).sort(), ['content-mid', 'content-old'], '總量上限由舊到新刪，最近 1 個永遠保留');

  const done = await ACE.pruneBackups(cfg, { keepDays: 7, keepLast: 1, commit: true });
  assert.equal(done.committed, true);
  assert.deepEqual(done.removed.sort(), ['content-mid', 'content-old']);
  assert.ok(!fs.existsSync(oldest));
  assert.ok(fs.existsSync(latestOld));
});

test('pruneBackups：沒有備份資料夾 → exists=false', async () => {
  const { cfg } = sandbox();
  const r = await ACE.pruneBackups(cfg);
  assert.equal(r.exists, false);
  assert.equal(r.prune.length, 0);
});

function wav({ rate = 48000, bits = 24, channels = 2, seconds = 1 }) {
  const byteRate = (rate * channels * bits) / 8;
  const data = Buffer.alloc(byteRate * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('listMasters：WAV 標頭解析＋版本拆分；不刪任何檔', async () => {
  const { cfg } = sandbox();
  const dir = path.join(cfg.downloadDir, 'ai音樂', '俱樂部版');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '幽冥靈擺_HD_48k24.wav'), wav({ seconds: 2 }));
  fs.writeFileSync(path.join(dir, '幽冥靈擺_HD_320k.mp3'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, '說明.md'), 'x');
  const r = await ACE.listMasters(cfg);
  assert.equal(r.total, 2);
  const w = r.masters.find((m) => m.ext === 'wav');
  assert.equal(w.song, '幽冥靈擺');
  assert.equal(w.version, 'HD_48k24');
  assert.equal(w.wav.sampleRate, 48000);
  assert.equal(w.wav.bitsPerSample, 24);
  assert.equal(w.wav.durationSec, 2);
  assert.deepEqual(r.bySong['幽冥靈擺'].sort(), ['幽冥靈擺_HD_320k.mp3', '幽冥靈擺_HD_48k24.wav']);
  assert.equal(fs.readdirSync(dir).length, 3);
});
