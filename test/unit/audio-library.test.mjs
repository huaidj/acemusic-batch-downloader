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

function wavWithLargeMetadata() {
  const normal = wav();
  const metadata = Buffer.alloc(70010);
  metadata.write('LIST', 0);
  metadata.writeUInt32LE(70001, 4); // An odd-size chunk exercises the required padding byte.
  metadata.write('INFO', 8);
  const output = Buffer.concat([normal.subarray(0, 36), metadata, normal.subarray(36)]);
  output.writeUInt32LE(output.length - 8, 4);
  return output;
}

test('audio integrity: seek over metadata larger than 64 KiB to verify the actual fmt/data boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-wav-metadata-'));
  const file = path.join(dir, 'large-cover.part');
  const complete = wavWithLargeMetadata();
  fs.writeFileSync(file, complete);
  const checked = await inspectAudioFile(file);
  assert.equal(checked.validity, 'valid');
  assert.equal(checked.format, 'wav');
  assert.equal(checked.duration, 0.1);
  assert.equal(checked.expectedBytes, complete.length);
  assert.equal(fs.statSync(file).size, complete.length);
  assert.equal(validateAudioBuffer(complete, 'wav').validity, 'valid');
});

test('audio integrity: metadata seek still rejects truncated data and chunks extending beyond RIFF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-wav-metadata-bad-'));
  const complete = wavWithLargeMetadata();
  const short = Buffer.from(complete.subarray(0, complete.length - 100));
  short.writeUInt32LE(short.length - 8, 4); // Do not rely only on the outer RIFF size.
  const shortFile = path.join(dir, 'short.wav');
  fs.writeFileSync(shortFile, short);
  const damaged = await inspectAudioFile(shortFile);
  assert.equal(damaged.validity, 'damaged');
  assert.equal(damaged.expectedBytes, complete.length);
  const badRiff = Buffer.from(complete);
  badRiff.writeUInt32LE(70048, 4); // data header/payload cannot extend beyond this RIFF container.
  const badFile = path.join(dir, 'bad-riff.wav');
  fs.writeFileSync(badFile, badRiff);
  assert.equal((await inspectAudioFile(badFile)).validity, 'damaged');
});

function mp3WithLargeId3({ footer = false } = {}) {
  const size = 70032, header = Buffer.alloc(10), tag = Buffer.alloc(size), frame = Buffer.alloc(417);
  header.write('ID3'); header[3] = footer ? 4 : 3; header[5] = footer ? 0x10 : 0;
  header[6] = (size >>> 21) & 0x7f; header[7] = (size >>> 14) & 0x7f; header[8] = (size >>> 7) & 0x7f; header[9] = size & 0x7f;
  tag.write('APIC'); tag.writeUInt32BE(size - 10, 4); tag.write('image/jpeg\0', 11);
  Buffer.from([0xff, 0xfb, 0x90, 0]).copy(frame);
  const parts = [header, tag];
  if (footer) { const tail = Buffer.from(header); tail.write('3DI'); parts.push(tail); }
  parts.push(frame);
  return { bytes: Buffer.concat(parts), audioOffset: 10 + size + (footer ? 10 : 0) };
}

test('audio integrity: large ID3 cover is skipped to a complete MPEG frame without loading the tag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-large-id3-'));
  for (const footer of [false, true]) {
    const fixture = mp3WithLargeId3({ footer }), file = path.join(dir, footer ? 'footer.mp3' : 'cover.mp3');
    fs.writeFileSync(file, fixture.bytes);
    const inspected = await inspectAudioFile(file);
    assert.equal(inspected.validity, 'valid');
    assert.equal(inspected.format, 'mp3');
    assert.equal(inspected.bytes, fixture.bytes.length);
    assert.equal(inspected.audioOffset, fixture.audioOffset);
    assert.equal(fs.statSync(file).size, fixture.bytes.length);
  }
});

test('audio integrity: truncated large ID3 tags, illegal synchsafe sizes and incomplete MPEG frames remain damaged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-large-id3-bad-')), fixture = mp3WithLargeId3();
  const tagShort = path.join(dir, 'tag-short.mp3'), frameShort = path.join(dir, 'frame-short.mp3'), badSize = path.join(dir, 'bad-size.mp3');
  fs.writeFileSync(tagShort, fixture.bytes.subarray(0, fixture.audioOffset - 10));
  fs.writeFileSync(frameShort, fixture.bytes.subarray(0, fixture.audioOffset + 20));
  const malformed = Buffer.from(fixture.bytes); malformed[6] |= 0x80; fs.writeFileSync(badSize, malformed);
  assert.equal((await inspectAudioFile(tagShort)).validity, 'damaged');
  const frame = await inspectAudioFile(frameShort);
  assert.equal(frame.validity, 'damaged');
  assert.equal(frame.expectedBytes, fixture.bytes.length);
  assert.equal((await inspectAudioFile(badSize)).validity, 'damaged');
});
