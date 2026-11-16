import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripWavMetadata } from '../../agent/lib/audio-library.mjs';

function chunk(id, payload) {
  const size = payload.length;
  const b = Buffer.alloc(8 + size + (size & 1));
  b.write(id, 0, 'ascii');
  b.writeUInt32LE(size, 4);
  payload.copy(b, 8);
  return b;
}

function wavWithInfo() {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(48000, 4);
  fmt.writeUInt32LE(192000, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);
  const info = Buffer.concat([
    Buffer.from('INFO', 'ascii'),
    chunk('INAM', Buffer.from('Sacrilegious Liturgy\0', 'utf8')),
    chunk('IART', Buffer.from('于天禹\0', 'utf8')),
    chunk('ICMT', Buffer.from('Made with ACE Music; created=2026-11-16T10:06:22.950Z; id=so_7e97f78f\0', 'utf8')),
    chunk('ISFT', Buffer.from('ACE Music\0', 'ascii')),
  ]);
  const body = Buffer.concat([
    chunk('fmt ', fmt),
    chunk('LIST', info),
    chunk('data', Buffer.alloc(8, 1)),
  ]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WAVE', 8, 'ascii');
  return Buffer.concat([head, body]);
}

function chunkIds(buffer) {
  const ids = [];
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    ids.push(id);
    offset += 8 + size + (size & 1);
  }
  return ids;
}

test('stripWavMetadata: removes LIST/INFO fingerprint and keeps fmt/data', () => {
  const source = wavWithInfo();
  assert.deepEqual(chunkIds(source), ['fmt ', 'LIST', 'data']);
  assert.match(source.toString('latin1'), /ACE Music/);

  const clean = stripWavMetadata(source);
  assert.deepEqual(chunkIds(clean), ['fmt ', 'data']);
  assert.equal(clean.readUInt32LE(4), clean.length - 8);
  assert.doesNotMatch(clean.toString('latin1'), /ACE Music|于天禹|so_7e97/);
  assert.deepEqual(clean.subarray(clean.length - 8), Buffer.alloc(8, 1));
});

test('stripWavMetadata: clean WAV is returned unchanged', () => {
  const body = Buffer.concat([chunk('fmt ', Buffer.alloc(16)), chunk('data', Buffer.alloc(8, 2))]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WAVE', 8, 'ascii');
  const clean = Buffer.concat([head, body]);
  assert.equal(stripWavMetadata(clean), clean);
});

test('stripWavMetadata: non-WAV and truncated input pass through untouched', () => {
  const mp3 = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000', 'latin1');
  assert.equal(stripWavMetadata(mp3), mp3);
  const broken = wavWithInfo().subarray(0, 40);
  assert.equal(stripWavMetadata(broken), broken);
});

test('stripWavMetadata: removes an ID3v2 tag appended after the samples', () => {
  const id3Body = Buffer.from('TSSE\u0000\u0000\u0000\n\u0000\u0000\u0000ACE MusicCOMM\u0000\u0000\u0000Zeng\u0000Made with ACE Music\0', 'latin1');
  const id3 = Buffer.alloc(10);
  id3.write('ID3', 0, 'ascii');
  id3[3] = 4;
  const size = id3Body.length;
  id3[6] = (size >> 21) & 0x7f;
  id3[7] = (size >> 14) & 0x7f;
  id3[8] = (size >> 7) & 0x7f;
  id3[9] = size & 0x7f;
  const data = Buffer.concat([Buffer.alloc(64, 7), id3, id3Body]);
  const body = Buffer.concat([chunk('fmt ', Buffer.alloc(16)), chunk('data', data)]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WAVE', 8, 'ascii');
  const source = Buffer.concat([head, body]);

  const clean = stripWavMetadata(source);
  assert.doesNotMatch(clean.toString('latin1'), /ACE Music/);
  const dataSize = clean.readUInt32LE(12 + 8 + 16 + 4);
  assert.equal(dataSize, 64);
  assert.equal(clean.readUInt32LE(4), clean.length - 8);
  assert.deepEqual(clean.subarray(clean.length - 64), Buffer.alloc(64, 7));
});
