import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectAudioFile, validateAudioBuffer } from '../../agent/lib/audio-library.mjs';

function wav(dataBytes = 19200) {
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

test('audio integrity: complete WAV has duration; RIFF truncation never passes', () => {
  const complete = wav();
  const checked = validateAudioBuffer(complete, 'wav');
  assert.equal(checked.validity, 'valid');
  assert.equal(checked.duration, 0.1);
  assert.throws(() => validateAudioBuffer(complete.subarray(0, 100), 'wav'), { code: 'AUDIO_TRUNCATED' });
});

test('audio integrity: data truncation is detected even if RIFF size was changed to the short file length', () => {
  const short = Buffer.from(wav().subarray(0, 100));
  short.writeUInt32LE(short.length - 8, 4);
  assert.throws(() => validateAudioBuffer(short, 'wav'), { code: 'AUDIO_TRUNCATED' });
});

test('audio integrity: WAV/MP4 cannot be silently saved with an mp3 extension; HTML/JSON are rejected', () => {
  assert.throws(() => validateAudioBuffer(wav(), 'mp3'), { code: 'AUDIO_FORMAT_MISMATCH' });
  const mp4 = Buffer.alloc(24); mp4.writeUInt32BE(24); mp4.write('ftypM4A ', 4);
  assert.throws(() => validateAudioBuffer(mp4, 'mp3'), { code: 'AUDIO_FORMAT_MISMATCH' });
  assert.equal(validateAudioBuffer(mp4, 'm4a').validity, 'unknown');
  assert.throws(() => validateAudioBuffer(Buffer.from('<!doctype html><html>Error</html>'), 'mp3'), { code: 'AUDIO_INVALID' });
  assert.throws(() => validateAudioBuffer(Buffer.from('{"error":"not an audio file"}'), 'wav'), { code: 'AUDIO_INVALID' });
  assert.equal(validateAudioBuffer(Buffer.from('unrecognized binary fixture'), 'mp3').validity, 'unknown');
});

test('audio integrity: a complete MPEG audio frame passes; a truncated frame or oversized ID3 tag fails', () => {
  const mp3 = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(mp3);
  assert.equal(validateAudioBuffer(mp3, 'mp3').validity, 'valid');
  assert.throws(() => validateAudioBuffer(mp3.subarray(0, 20), 'mp3'), { code: 'AUDIO_TRUNCATED' });
  const tag = Buffer.alloc(10);
  tag.write('ID3'); tag[3] = 4; tag[9] = 64;
  assert.throws(() => validateAudioBuffer(tag, 'mp3'), { code: 'AUDIO_TRUNCATED' });
});

test('audio integrity: local inspection reports valid, truncated, mismatched and missing files without modifying them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-audio-integrity-'));
  const good = path.join(dir, 'good.wav'), short = path.join(dir, 'short.wav'), wrong = path.join(dir, 'wrong.mp3');
  fs.writeFileSync(good, wav()); fs.writeFileSync(short, wav().subarray(0, 100)); fs.writeFileSync(wrong, wav());
  assert.equal((await inspectAudioFile(good)).validity, 'valid');
  assert.equal((await inspectAudioFile(short)).validity, 'damaged');
  assert.equal((await inspectAudioFile(wrong)).validity, 'damaged');
  assert.equal((await inspectAudioFile(path.join(dir, 'missing.wav'))).validity, 'unknown');
  assert.equal(fs.statSync(short).size, 100);
});
