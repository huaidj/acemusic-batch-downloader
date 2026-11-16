// fingerprints.mjs — 把既有音檔裡的 ACE 生成器指紋就地抹掉。
//
// 下載流程（v1.8.1 起）只清 WAV；這支處理「已經在磁碟上」的檔案：
//   * WAV：LIST/INFO（IART/ICMT/ISFT…）、id3／bext／iXML／XMP chunk、data chunk 尾端夾帶的 ID3
//   * MP3：TSSE／TENC 編碼器戳記、COMM／TXXX／WOAS 內含 ACE Music 或 acemusic.ai 的 frame
//
// 原則：就地覆寫、檔案長度不變、inode 不變 → 硬連結的音頻分類檢視自動同步，
// 既有 size 紀錄（agent-state／manifest／Chrome 下載紀錄）與音頻分析快取都不失效。
// 標題、藝人、專輯、BPM、調性、封面、歌詞一律保留。mtime／atime 還原，指紋原 bytes 另存可還原。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, readJson, writeJson, toWin, exists } from './config.mjs';
import { hasLibraryWriteLease, withLibraryWriteLease } from './library-lease.mjs';

export const FINGERPRINT_BACKUP_SCHEMA = 'ace_fingerprint_backup_v1';
export const FINGERPRINT_BACKUP_DIR = 'fingerprint-backups';

const ACE_TEXT = /ace\s*music|acemusic|made with ace/i;
const WAV_METADATA = new Set(['id3 ', 'bext', 'iXML', 'XMP ']);
const MP3_ALWAYS = new Set(['TSSE', 'TENC']);

const sha256 = async (file) => {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
};

const syncsafe = (buffer, offset) => ((buffer[offset] & 0x7f) << 21) | ((buffer[offset + 1] & 0x7f) << 14) | ((buffer[offset + 2] & 0x7f) << 7) | (buffer[offset + 3] & 0x7f);

function decodeText(encoding, body) {
    if (encoding === 0) return body.toString('latin1');
    if (encoding === 3) return body.toString('utf8');
    if (encoding === 1 || encoding === 2) {
        const trimmed = body[0] === 0xff && body[1] === 0xfe ? body.subarray(2) : body;
        return trimmed.toString('utf16le');
    }
    return body.toString('latin1');
}

/** 讀 MP3 的 ID3v2 tag body（不含 10-byte header）；沒有 tag 回 null。 */
async function readMp3Tag(fh, fileSize) {
    if (fileSize < 10) return null;
    const header = Buffer.alloc(10);
    await fh.read(header, 0, 10, 0);
    if (header.toString('ascii', 0, 3) !== 'ID3') return null;
    const version = header[3];
    const flags = header[5];
    if (version !== 3 && version !== 4) return { unsupported: 'ID3v2.' + version };
    if (flags & 0xc0) return { unsupported: 'ID3 flags 0x' + flags.toString(16) };
    const size = syncsafe(header, 6);
    if (size < 0 || size + 10 > fileSize) return { unsupported: 'ID3 size exceeds file' };
    const body = Buffer.alloc(size);
    await fh.read(body, 0, size, 10);
    return { version, flags, size, body };
}

function mp3Frames(tag) {
    if (!tag || !tag.body) return [];
    const frames = [];
    let offset = 0;
    if (tag.flags & 0x40) offset += (tag.version === 4 ? syncsafe(tag.body, 0) : tag.body.readUInt32BE(0)) + 4;
    while (offset + 10 <= tag.body.length) {
        const id = tag.body.toString('ascii', offset, offset + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break; // 0 padding：後面沒有 frame 了
        const size = tag.version === 4 ? syncsafe(tag.body, offset + 4) : tag.body.readUInt32BE(offset + 4);
        if (!size || offset + 10 + size > tag.body.length) break;
        frames.push({ id, offset, size, total: 10 + size });
        offset += 10 + size;
    }
    return frames;
}

function mp3FrameText(tag, frame) {
    const payload = tag.body.subarray(frame.offset + 10, frame.offset + 10 + frame.size);
    if (!payload.length) return '';
    const encoding = payload[0];
    if (frame.id === 'WOAS') return payload.subarray(1).toString('latin1');
    if (frame.id === 'COMM') return decodeText(encoding, payload.subarray(4)).replace(/\u0000+/g, ' ').trim(); // 編碼 + 語言(3)
    if (frame.id === 'TXXX') return decodeText(encoding, payload.subarray(1)).replace(/\u0000+/g, ' ').trim();
    return decodeText(encoding, payload.subarray(1));
}

function isRemovableMp3Frame(tag, frame) {
    if (MP3_ALWAYS.has(frame.id)) return true;
    const text = mp3FrameText(tag, frame);
    if (!text) return false;
    if (frame.id === 'WOAS') return /acemusic\.ai/i.test(text);
    return ACE_TEXT.test(text);
}

/** 產生「保留 frame + 補零」的同長 tag body（audio 起點不變）。 */
function rebuildMp3Body(tag, keepFrames) {
    const out = Buffer.alloc(tag.body.length);
    let cursor = 0;
    for (const frame of keepFrames) {
        tag.body.copy(out, cursor, frame.offset, frame.offset + frame.total);
        cursor += frame.total;
    }
    return out;
}

/**
 * 下載時用：把緩衝區裡的 MP3 指紋 frame 就地抹掉（等長、audio 位移不動）。
 * 沒有 tag／沒有可移除 frame／不支援的格式一律原樣回傳。
 */
export function stripMp3TagBuffer(input) {
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (data.length < 10 || data.toString('ascii', 0, 3) !== 'ID3') return data;
    const version = data[3], flags = data[5];
    if ((version !== 3 && version !== 4) || (flags & 0xc0)) return data;
    const size = syncsafe(data, 6);
    if (size + 10 > data.length) return data;
    const tag = { version, flags, size, body: data.subarray(10, 10 + size) };
    const frames = mp3Frames(tag);
    const removed = frames.filter((frame) => isRemovableMp3Frame(tag, frame));
    if (!removed.length) return data;
    const keep = frames.filter((frame) => !removed.includes(frame));
    const out = Buffer.from(data);
    rebuildMp3Body(tag, keep).copy(out, 10);
    return out;
}

async function walkWavChunks(fh, fileSize) {
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= fileSize) {
        const header = Buffer.alloc(8);
        await fh.read(header, 0, 8, offset);
        const id = header.toString('ascii', 0, 4);
        const size = header.readUInt32LE(4);
        const end = offset + 8 + size;
        if (!/^[\x20-\x7e]{4}$/.test(id)) break;
        if (end > fileSize) { chunks.push({ id, size, offset, end, truncated: true }); break; }
        chunks.push({ id, size, offset, end });
        if (chunks.length > 64) break;
        offset = end + (size & 1);
    }
    return chunks;
}

/** 檔案尾端（截斷的 data chunk 後面）若還有完整的 id3 chunk，回傳要歸零的範圍。 */
async function tailId3Chunk(fh, fileSize) {
    const len = Math.min(fileSize, 131072);
    if (len < 8) return null;
    const tail = Buffer.alloc(len);
    await fh.read(tail, 0, len, fileSize - len);
    const marker = tail.lastIndexOf(Buffer.from('id3 '));
    if (marker < 0 || marker + 8 > tail.length) return null;
    const size = tail.readUInt32LE(marker + 4);
    const absolute = fileSize - len + marker;
    const end = absolute + 8 + size;
    if (!size || (end !== fileSize && end + 1 !== fileSize)) return null;
    return { offset: absolute, length: fileSize - absolute, payloadOffset: absolute, payloadLength: fileSize - absolute, chunk: 'tail/id3' };
}

/** data chunk 尾端若夾著 ID3v2（ACE 匯出常見），回傳那段在檔案內的起點與長度。 */
async function trailingId3InData(fh, chunk) {
    const len = Math.min(chunk.size, 65536);
    if (len < 10) return null;
    const tail = Buffer.alloc(len);
    await fh.read(tail, 0, len, chunk.offset + 8 + chunk.size - len);
    const marker = tail.lastIndexOf(Buffer.from('ID3'));
    if (marker < 0 || marker + 10 > tail.length) return null;
    const version = tail[marker + 3];
    if (version !== 3 && version !== 4) return null;
    const flags = tail[marker + 5];
    const size = syncsafe(tail, marker + 6);
    if (!size) return null;
    const footer = version === 4 && (flags & 0x10) ? 10 : 0;
    const tagEnd = marker + 10 + size + footer;
    if (tagEnd !== tail.length && tagEnd !== tail.length - 1) return null;
    return { offset: chunk.offset + 8 + chunk.size - len + marker, length: tail.length - marker };
}

/** 掃描單一檔案（只讀）回傳可清除的指紋範圍。 */
export async function scanAudioFingerprint(file) {
    let stat;
    try { stat = await fsp.lstat(file); } catch { return null; }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const isWav = /\.wav$/i.test(file), isMp3 = /\.mp3$/i.test(file);
    if (!isWav && !isMp3) return null;
    let fh;
    try { fh = await fsp.open(file, 'r'); } catch { return null; }
    try {
        if (isMp3) {
            const tag = await readMp3Tag(fh, stat.size);
            if (!tag) return { kind: 'mp3', file, removable: false };
            if (tag.unsupported) return { kind: 'mp3', file, removable: false, unsupported: tag.unsupported };
            const frames = mp3Frames(tag);
            const removed = frames.filter((frame) => isRemovableMp3Frame(tag, frame));
            return { kind: 'mp3', file, removable: removed.length > 0, frames: removed.map((frame) => frame.id), allFrames: frames, tag, stat };
        }
        const chunks = await walkWavChunks(fh, stat.size);
        const targets = [];
        let truncatedData = false;
        for (const chunk of chunks) {
            if (chunk.truncated) { if (chunk.id === 'data') truncatedData = true; continue; }
            if (WAV_METADATA.has(chunk.id)) targets.push({ offset: chunk.offset, length: 8 + chunk.size, payloadOffset: chunk.offset + 8, payloadLength: chunk.size, chunk: chunk.id.trim() });
            else if (chunk.id === 'LIST' && chunk.size >= 4) {
                const head = Buffer.alloc(4);
                await fh.read(head, 0, 4, chunk.offset + 8);
                if (head.toString('ascii', 0, 4) === 'INFO') targets.push({ offset: chunk.offset, length: 8 + chunk.size, payloadOffset: chunk.offset + 8, payloadLength: chunk.size, chunk: 'LIST/INFO' });
            } else if (chunk.id === 'data') {
                const trailing = await trailingId3InData(fh, chunk);
                if (trailing) targets.push({ offset: trailing.offset, length: trailing.length, payloadOffset: trailing.offset, payloadLength: trailing.length, chunk: 'data/ID3' });
            }
        }
        // 被截斷的 data chunk 後面可能還接著完整的 id3 chunk（音頻分類找回的殘檔就是這樣）
        if (truncatedData) {
            const tail = await tailId3Chunk(fh, stat.size);
            if (tail) targets.push(tail);
        }
        return { kind: 'wav', file, removable: targets.length > 0, targets, stat };
    } finally { await fh.close(); }
}

/** 走整個曲庫，回傳需要處理的實體檔（同 inode 只算一次，paths 列出所有路徑）。 */
export async function planFingerprintStrip({ root = 'ai音樂', cfg = config(), onProgress = null } = {}) {
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    if (!exists(rootDir)) return { root: rootDir, files: [], scanned: 0, uniqueFiles: 0, error: '找不到 ' + rootDir };
    const byInode = new Map();
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.(mp3|wav)$/i.test(entry.name)) continue;
            let stat;
            try { stat = fs.lstatSync(full, { bigint: true }); } catch { continue; }
            const key = stat.dev + ':' + stat.ino;
            if (!byInode.has(key)) byInode.set(key, { paths: [], size: Number(stat.size) });
            byInode.get(key).paths.push(full);
        }
    };
    walk(rootDir);
    const files = [];
    let scanned = 0;
    for (const group of byInode.values()) {
        scanned += 1;
        const primary = group.paths[0];
        let scan;
        try { scan = await scanAudioFingerprint(primary); } catch { continue; }
        if (typeof onProgress === 'function') {
            try { onProgress({ done: scanned, total: byInode.size, current: path.basename(primary) }); } catch { /* ignore */ }
        }
        if (!scan || !scan.removable) continue;
        files.push({ ...scan, paths: group.paths });
    }
    return { root: rootDir, files, scanned, uniqueFiles: byInode.size };
}

async function writeInPlace(file, offset, buffer) {
    const fh = await fsp.open(file, 'r+');
    try {
        await fh.write(buffer, 0, buffer.length, offset);
        await fh.sync();
    } finally { await fh.close(); }
}

async function readRange(file, offset, length) {
    const fh = await fsp.open(file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, offset);
        return buffer;
    } finally { await fh.close(); }
}

/**
 * 就地清除指紋。同 inode 只處理一次；硬連結的其他路徑會一起看到結果。
 * mtime／atime 還原，讓音頻分析快取與其他「檔案沒變」的假設仍然成立。
 */
export async function stripFingerprints({ root = 'ai音樂', dryRun = false, cfg = config(), onProgress = null } = {}) {
    if (!dryRun && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => stripFingerprints(...arguments));
    const plan = await planFingerprintStrip({ root, cfg, onProgress });
    const report = {
        ok: true, dryRun: !!dryRun, root: plan.root,
        scanned: plan.scanned || 0, uniqueFiles: plan.uniqueFiles || 0,
        targets: plan.files.length,
        cleaned: 0, skipped: 0, unsupported: 0, failed: [],
        mp3: 0, wav: 0, framesRemoved: 0, chunksNeutralized: 0, bytesNeutralized: 0,
        backup: null, proofsUpdated: 0,
        items: plan.files.slice(0, 200).map((item) => ({ file: item.file, kind: item.kind, frames: item.frames || null, chunks: (item.targets || []).map((target) => target.chunk) })),
    };
    if (!plan.files.length || dryRun) {
        report.finishedAt = new Date().toISOString();
        return report;
    }
    const backupItems = [];
    const changedInodes = new Map();
    for (const item of plan.files) {
        const file = item.file;
        try {
            const before = await fsp.stat(file);
            if (item.kind === 'mp3') {
                const tag = item.tag;
                const frames = item.allFrames || mp3Frames(tag);
                const removed = frames.filter((frame) => isRemovableMp3Frame(tag, frame));
                if (!removed.length) { report.skipped += 1; continue; }
                const keep = frames.filter((frame) => !removed.includes(frame));
                const body = rebuildMp3Body(tag, keep);
                backupItems.push({ file, kind: 'mp3', offset: 10, original: tag.body.toString('base64'), bytes: tag.body.length, paths: item.paths });
                await writeInPlace(file, 10, body);
                const fh = await fsp.open(file, 'r');
                try {
                    const after = await readMp3Tag(fh, before.size);
                    const left = after && !after.unsupported ? mp3Frames(after).filter((frame) => isRemovableMp3Frame(after, frame)) : [];
                    if (!after || after.unsupported || left.length) throw Object.assign(new Error('MP3 tag 驗證失敗'), { code: 'VERIFY_FAILED' });
                } finally { await fh.close(); }
                report.mp3 += 1;
                report.framesRemoved += removed.length;
                report.bytesNeutralized += removed.reduce((sum, frame) => sum + frame.total, 0);
            } else {
                for (const target of item.targets || []) {
                    const original = await readRange(file, target.offset, target.length);
                    backupItems.push({ file, kind: 'wav', offset: target.offset, original: original.toString('base64'), bytes: target.length, chunk: target.chunk, paths: item.paths });
                    if (target.chunk === 'LIST/INFO' || target.chunk === 'id3' || target.chunk === 'bext' || target.chunk === 'iXML' || target.chunk === 'XMP') {
                        // 保留合法 chunk 結構：id 換成 JUNK、payload 歸零
                        const replacement = Buffer.alloc(target.length);
                        replacement.write('JUNK', 0, 'ascii');
                        replacement.writeUInt32LE(target.payloadLength, 4);
                        await writeInPlace(file, target.offset, replacement);
                    } else {
                        await writeInPlace(file, target.offset, Buffer.alloc(target.length));
                    }
                    report.bytesNeutralized += target.length;
                }
                const after = await fsp.stat(file);
                if (after.size !== before.size) throw Object.assign(new Error('WAV 檔案長度被改變'), { code: 'VERIFY_FAILED' });
                report.wav += 1;
                report.chunksNeutralized += (item.targets || []).length;
            }
            report.cleaned += 1;
            changedInodes.set(file, item.paths);
            await fsp.utimes(file, before.atime, before.mtime).catch(() => {});
        } catch (error) {
            report.failed.push({ file, error: String((error && error.message) || error).slice(0, 300), code: error.code || '' });
        }
    }
    if (backupItems.length) {
        const dir = path.join(cfg.stateDir, FINGERPRINT_BACKUP_DIR);
        await fsp.mkdir(dir, { recursive: true });
        const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
        await writeJson(file, {
            schema: FINGERPRINT_BACKUP_SCHEMA,
            createdAt: new Date().toISOString(),
            root: plan.root,
            retention: '保留到使用者確認不再需要還原；不會自動刪除',
            items: backupItems,
        });
        report.backup = file;
    }
    // 已驗證音檔的 sha256 是「整檔內容」證據；就地改過就誠實更新，不讓索引誤判成待核對
    if (changedInodes.size) {
        const proofFile = path.join(cfg.stateDir, 'verified-audio.json');
        const proofs = await readJson(proofFile, null);
        if (proofs && Array.isArray(proofs.files)) {
            const changed = new Map();
            for (const paths of changedInodes.values()) for (const p of paths) changed.set(path.resolve(p).toLowerCase(), true);
            const hashed = new Map();
            for (const entry of proofs.files) {
                if (!entry || !entry.absolute) continue;
                const key = path.resolve(entry.absolute).toLowerCase();
                if (!changed.has(key)) continue;
                try {
                    if (!hashed.has(key)) hashed.set(key, await sha256(entry.absolute));
                    const stat = await fsp.stat(entry.absolute);
                    entry.sha256 = hashed.get(key);
                    entry.bytes = stat.size;
                    entry.verifiedAt = new Date().toISOString();
                    entry.fingerprintStripAt = new Date().toISOString();
                    report.proofsUpdated += 1;
                } catch { /* 檔案不見了：留給索引自己回報 */ }
            }
            if (report.proofsUpdated) await writeJson(proofFile, proofs);
        }
    }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    return report;
}

/** 用最近一次（或指定）備份把指紋原 bytes 寫回原位；只在檔案長度足夠時還原。 */
export async function restoreFingerprints({ cfg = config(), backup = '' } = {}) {
    const dir = path.join(cfg.stateDir, FINGERPRINT_BACKUP_DIR);
    let file = backup;
    if (!file) {
        const names = await fsp.readdir(dir).catch(() => []);
        const latest = names.filter((name) => name.endsWith('.json')).sort().pop();
        if (!latest) throw Object.assign(new Error('找不到指紋備份'), { code: 'NO_BACKUP' });
        file = path.join(dir, latest);
    }
    const backupDoc = await readJson(file, null);
    if (!backupDoc || backupDoc.schema !== FINGERPRINT_BACKUP_SCHEMA || !Array.isArray(backupDoc.items)) throw Object.assign(new Error('備份檔格式不正確'), { code: 'BAD_BACKUP' });
    const report = { ok: true, backup: file, restored: 0, skipped: 0, failed: [] };
    for (const item of backupDoc.items) {
        if (!item || !item.file || !item.original) continue;
        try {
            const data = Buffer.from(item.original, 'base64');
            const stat = await fsp.stat(item.file);
            if (stat.size < item.offset + data.length) { report.skipped += 1; continue; }
            await writeInPlace(item.file, item.offset, data);
            report.restored += 1;
        } catch (error) {
            report.failed.push({ file: item.file, error: String((error && error.message) || error).slice(0, 300) });
        }
    }
    report.ok = report.failed.length === 0;
    return report;
}
