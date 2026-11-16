// Local audio integrity checks. This module never loads account sessions or calls ACE.
import fs from 'node:fs/promises';
import path from 'node:path';

const HEADER_BYTES = 65536;
export async function buildAudioLibrary(options) {
    return (await import('./local-index.mjs')).buildAudioLibrary(options);
}
const MAX_WAV_CHUNKS = 4096;
const AUDIO_FORMATS = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'aiff']);
const normalizeFormat = (value) => {
    const name = String(value || '').toLowerCase().replace(/^\./, '');
    return name === 'aif' || name === 'aifc' ? 'aiff' : name;
};

function inspectHeader(buffer, bytes, requestedFormat = '') {
    const expected = normalizeFormat(requestedFormat);
    const result = { validity: 'unknown', format: AUDIO_FORMATS.has(expected) ? expected : 'unknown', bytes };
    const damaged = (reason, expectedBytes) => ({ ...result, validity: 'damaged', reason, ...(expectedBytes ? { expectedBytes } : {}) });
    if (!bytes) return damaged('Audio file is empty');
    const prefix = buffer.subarray(0, 256).toString('utf8').trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<\?xml\b|<Error\b|\{|\[)/i.test(prefix)) return damaged('Response contains text markup or JSON instead of audio');

    const tag = buffer.toString('ascii', 0, 4);
    let actual = '';
    if ((tag === 'RIFF' || tag === 'RF64' || tag === 'RIFX') && buffer.toString('ascii', 8, 12) === 'WAVE') actual = 'wav';
    else if (tag === 'fLaC') actual = 'flac';
    else if (tag === 'OggS') actual = 'ogg';
    else if (tag === 'FORM' && ['AIFF', 'AIFC'].includes(buffer.toString('ascii', 8, 12))) actual = 'aiff';
    else if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') actual = 'm4a';
    else if (buffer.length >= 7 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) actual = 'aac';
    else if (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer.length >= 4 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) actual = 'mp3';
    if (actual) result.format = actual;
    if (actual && AUDIO_FORMATS.has(expected) && actual !== expected) return damaged(`Audio format is ${actual}, expected ${expected}`);

    if (actual === 'wav') {
        if (tag !== 'RIFF') return { ...result, reason: 'RF64/RIFX requires a separate container parser' };
        if (buffer.length < 12) return damaged('Incomplete WAV header', 12);
        const riffBytes = buffer.readUInt32LE(4) + 8;
        if (riffBytes > bytes) return damaged('WAV RIFF length exceeds the downloaded file', riffBytes);
        let byteRate = 0;
        let dataBytes = null;
        let dataOffset = 0;
        for (let offset = 12, chunks = 0; offset + 8 <= buffer.length && chunks < MAX_WAV_CHUNKS; chunks++) {
            const chunk = buffer.toString('ascii', offset, offset + 4);
            const length = buffer.readUInt32LE(offset + 4);
            const end = offset + 8 + length;
            if (end > bytes) return damaged(`WAV ${chunk} chunk exceeds the downloaded file`, end);
            if (end > riffBytes) return damaged(`WAV ${chunk} chunk exceeds its RIFF container`, end);
            if (chunk === 'fmt ') {
                if (length < 16) return damaged('WAV fmt chunk is too short');
                if (offset + 24 > buffer.length) return { ...result, reason: 'WAV fmt chunk is outside the inspected header' };
                const channels = buffer.readUInt16LE(offset + 10);
                const sampleRate = buffer.readUInt32LE(offset + 12);
                byteRate = buffer.readUInt32LE(offset + 16);
                if (!channels || !sampleRate || !byteRate) return damaged('WAV fmt chunk has invalid channel/rate values');
            }
            if (chunk === 'data') {
                dataBytes = length;
                dataOffset = offset + 8;
                break;
            }
            offset = end + (length & 1);
        }
        if (dataBytes === null || !byteRate) return { ...result, reason: 'WAV fmt/data chunks were not both found in the inspected header' };
        if (!dataBytes) return damaged('WAV contains no audio samples');
        return { ...result, validity: 'valid', duration: dataBytes / byteRate, expectedBytes: Math.max(riffBytes, dataOffset + dataBytes) };
    }

    if (actual === 'mp3') {
        let offset = 0;
        if (buffer.toString('ascii', 0, 3) === 'ID3') {
            if (buffer.length < 10) return damaged('Incomplete MP3 ID3 header', 10);
            if ([buffer[6], buffer[7], buffer[8], buffer[9]].some((value) => value & 0x80)) return damaged('Invalid MP3 ID3 tag size');
            offset = 10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9]);
            if (offset > bytes) return damaged('MP3 ID3 tag exceeds the downloaded file', offset);
        }
        if (offset + 4 > buffer.length) return { ...result, reason: 'MP3 audio frames are outside the inspected header' };
        const first = buffer[offset], second = buffer[offset + 1], third = buffer[offset + 2];
        const version = (second >> 3) & 3, layer = (second >> 1) & 3;
        const rateIndex = (third >> 2) & 3, bitrateIndex = third >> 4;
        if (first !== 0xff || (second & 0xe0) !== 0xe0 || version === 1 || !layer || rateIndex === 3 || bitrateIndex === 15) return { ...result, reason: 'No valid MPEG audio frame follows the MP3 tag' };
        if (!bitrateIndex) return { ...result, reason: 'Free-format MP3 requires a full decoder' };
        const rates = [44100, 48000, 32000];
        const sampleRate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
        const mpeg1 = { 3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] };
        const lowRate = layer === 3 ? mpeg1[3] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
        const bitrate = (version === 3 ? mpeg1[layer] : lowRate)[bitrateIndex] * 1000;
        const padding = (third >> 1) & 1;
        const frameBytes = layer === 3 ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4 : Math.floor((layer === 1 && version !== 3 ? 72 : 144) * bitrate / sampleRate) + padding;
        if (offset + frameBytes > bytes) return damaged('MP3 first audio frame is truncated', offset + frameBytes);
        return { ...result, validity: 'valid' };
    }

    if (actual === 'aiff') {
        const expectedBytes = buffer.readUInt32BE(4) + 8;
        if (expectedBytes > bytes) return damaged('AIFF FORM length exceeds the downloaded file', expectedBytes);
        return { ...result, reason: 'AIFF container recognized; audio payload has not been decoded' };
    }
    if (actual === 'm4a') {
        const boxBytes = buffer.readUInt32BE(0);
        if (boxBytes !== 0 && boxBytes !== 1 && boxBytes > bytes) return damaged('MP4 ftyp box exceeds the downloaded file', boxBytes);
        return { ...result, reason: 'MP4/M4A container recognized; audio payload has not been decoded' };
    }
    if (actual === 'ogg') {
        if (bytes < 27) return damaged('Incomplete Ogg page header', 27);
        return { ...result, reason: 'Ogg container recognized; audio payload has not been decoded' };
    }
    if (actual === 'flac') {
        if (bytes < 8) return damaged('Incomplete FLAC metadata header', 8);
        const metadataBytes = 8 + buffer.readUIntBE(5, 3);
        if (metadataBytes > bytes) return damaged('FLAC metadata exceeds the downloaded file', metadataBytes);
        return { ...result, reason: 'FLAC container recognized; audio payload has not been decoded' };
    }
    if (actual === 'aac') {
        const frameBytes = ((buffer[3] & 3) << 11) | (buffer[4] << 3) | (buffer[5] >> 5);
        if (frameBytes < 7) return damaged('Invalid AAC ADTS frame length');
        if (frameBytes > bytes) return damaged('AAC first audio frame is truncated', frameBytes);
        return { ...result, reason: 'AAC ADTS header recognized; remaining frames have not been decoded' };
    }
    if (expected === 'wav') return damaged('Expected a RIFF/WAVE audio file');
    return { ...result, reason: 'Audio format could not be confirmed from its header' };
}

/** Seek past large RIFF metadata without loading it or the audio payload into memory. */
async function inspectRiffFile(handle, bytes, prefix) {
    const result = { validity: 'unknown', format: 'wav', bytes };
    const damaged = (reason, expectedBytes) => ({ ...result, validity: 'damaged', reason, ...(expectedBytes ? { expectedBytes } : {}) });
    const riffBytes = prefix.readUInt32LE(4) + 8;
    if (riffBytes > bytes) return damaged('WAV RIFF length exceeds the downloaded file', riffBytes);
    const readAt = async (length, position) => {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
            const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
            if (!bytesRead) break;
            filled += bytesRead;
        }
        return buffer.subarray(0, filled);
    };
    let offset = 12;
    let byteRate = 0;
    let dataBytes = null;
    let dataEnd = 0;
    for (let chunks = 0; chunks < MAX_WAV_CHUNKS && offset < riffBytes; chunks++) {
        if (!Number.isSafeInteger(offset) || offset < 12 || offset + 8 > bytes) return damaged('Incomplete WAV chunk header', offset + 8);
        if (offset + 8 > riffBytes) return damaged('WAV chunk header exceeds its RIFF container');
        const header = await readAt(8, offset);
        if (header.length !== 8) return damaged('Incomplete WAV chunk header', offset + 8);
        const chunk = header.toString('ascii', 0, 4);
        const length = header.readUInt32LE(4);
        const end = offset + 8 + length;
        const next = end + (length & 1);
        if (!Number.isSafeInteger(next) || next <= offset) return damaged('Invalid WAV chunk offset');
        if (end > bytes) return damaged(`WAV ${chunk} chunk exceeds the downloaded file`, end);
        if (end > riffBytes || next > riffBytes) return damaged(`WAV ${chunk} chunk exceeds its RIFF container`, next);
        if (chunk === 'fmt ') {
            if (length < 16) return damaged('WAV fmt chunk is too short');
            const fmt = await readAt(16, offset + 8);
            if (fmt.length !== 16) return damaged('Incomplete WAV fmt chunk', offset + 24);
            const channels = fmt.readUInt16LE(2);
            const sampleRate = fmt.readUInt32LE(4);
            byteRate = fmt.readUInt32LE(8);
            if (!channels || !sampleRate || !byteRate) return damaged('WAV fmt chunk has invalid channel/rate values');
        }
        if (chunk === 'data') {
            if (!length) return damaged('WAV contains no audio samples');
            dataBytes = length;
            dataEnd = end;
        }
        if (dataBytes !== null && byteRate) return { ...result, validity: 'valid', duration: dataBytes / byteRate, expectedBytes: Math.max(riffBytes, dataEnd) };
        offset = next;
    }
    return { ...result, reason: offset < riffBytes ? 'WAV chunk inspection limit reached' : 'WAV fmt/data chunks were not both found' };
}

/** Locate MPEG audio after a bounded ID3 tag without reading a large embedded cover. */
async function inspectId3File(handle, bytes, prefix) {
    const result = { validity: 'unknown', format: 'mp3', bytes };
    const damaged = (reason, expectedBytes) => ({ ...result, validity: 'damaged', reason, ...(expectedBytes ? { expectedBytes } : {}) });
    if (prefix.length < 10) return damaged('Incomplete MP3 ID3 header', 10);
    const major = prefix[3], revision = prefix[4], flags = prefix[5];
    if (major === 0xff || revision === 0xff) return damaged('Invalid MP3 ID3 version');
    if (![2, 3, 4].includes(major)) return { ...result, reason: 'Unsupported ID3 major version' };
    const reserved = major === 2 ? 0x3f : major === 3 ? 0x1f : 0x0f;
    if (flags & reserved) return damaged('Invalid reserved MP3 ID3 flags');
    if ([prefix[6], prefix[7], prefix[8], prefix[9]].some((value) => value & 0x80)) return damaged('Invalid MP3 ID3 tag size');
    const tagSize = prefix[6] * 2097152 + prefix[7] * 16384 + prefix[8] * 128 + prefix[9];
    const tagEnd = 10 + tagSize;
    // ID3v2.4 size excludes its ten-byte header and optional ten-byte footer.
    // https://id3.org/id3v2.4.0-structure
    const hasFooter = major === 4 && !!(flags & 0x10);
    const audioOffset = tagEnd + (hasFooter ? 10 : 0);
    if (!Number.isSafeInteger(audioOffset) || audioOffset < 10) return damaged('Invalid MP3 ID3 audio offset');
    if (audioOffset > bytes) return damaged('MP3 ID3 tag exceeds the downloaded file', audioOffset);
    if (hasFooter) {
        const footer = Buffer.alloc(10);
        const read = await handle.read(footer, 0, 10, tagEnd);
        if (read.bytesRead !== 10) return damaged('Incomplete MP3 ID3 footer', audioOffset);
        if (footer.toString('ascii', 0, 3) !== '3DI' || !footer.subarray(3, 10).equals(prefix.subarray(3, 10))) return damaged('MP3 ID3 footer does not match its header');
    }
    if (audioOffset + 4 > bytes) return damaged('MP3 tag leaves no complete MPEG frame header', audioOffset + 4);
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, audioOffset);
    if (bytesRead !== header.length) return damaged('Incomplete MPEG frame header', audioOffset + 4);
    const checked = inspectHeader(header, bytes - audioOffset, 'mp3');
    return { ...checked, bytes, audioOffset, id3Bytes: audioOffset,
        ...(checked.expectedBytes ? { expectedBytes: audioOffset + checked.expectedBytes } : {}) };
}

/** Inspect a local file without reading an account session or decoding the audio payload. */
export async function inspectAudioFile(absolutePath) {
    const requested = normalizeFormat(path.extname(absolutePath));
    let handle;
    try {
        const before = await fs.lstat(absolutePath);
        if (before.isSymbolicLink() || !before.isFile()) return { validity: 'damaged', format: requested, bytes: before.size, reason: 'Audio path is not a regular file' };
        handle = await fs.open(absolutePath, 'r');
        const buffer = Buffer.alloc(Math.min(HEADER_BYTES, before.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const prefix = buffer.subarray(0, bytesRead);
        let inspected = inspectHeader(prefix, before.size, requested);
        if (inspected.validity === 'unknown' && inspected.format === 'wav' && prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WAVE') {
            inspected = await inspectRiffFile(handle, before.size, prefix);
        }
        if (inspected.validity === 'unknown' && inspected.format === 'mp3' && prefix.toString('ascii', 0, 3) === 'ID3') {
            inspected = await inspectId3File(handle, before.size, prefix);
        }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== buffer.length) return { ...inspected, validity: 'unknown', reason: 'Audio file changed while its header was being inspected' };
        return inspected;
    } catch (error) {
        return { validity: 'unknown', format: requested, bytes: 0, reason: error.code === 'ENOENT' ? 'Audio file is missing' : 'Audio file could not be read' };
    } finally {
        await handle?.close();
    }
}

/** Validate a completed HTTP audio body before replacing any existing local file. */
export function validateAudioBuffer(buffer, kind) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const result = inspectHeader(data, data.length, kind);
    if (result.validity === 'damaged') {
        const error = new Error(result.reason);
        error.code = result.expectedBytes > result.bytes ? 'AUDIO_TRUNCATED' : 'AUDIO_INVALID';
        if (/Audio format is/.test(result.reason)) error.code = 'AUDIO_FORMAT_MISMATCH';
        error.expectedBytes = result.expectedBytes;
        error.actualBytes = result.bytes;
        throw error;
    }
    return result;
}
