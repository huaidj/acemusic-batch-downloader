// fingerprints：既有 WAV／MP3 指紋就地清除（不改檔長、不改 inode、可還原）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripFingerprints, planFingerprintStrip, scanAudioFingerprint, restoreFingerprints } from '../../agent/lib/fingerprints.mjs';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function mp3Audio(seed = 1) {
    const data = Buffer.alloc(417);
    Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(data);
    data[100] = seed;
    return data;
}

function syncsafeBytes(value) {
    return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function id3Frame(id, payload, version) {
    const header = Buffer.alloc(10);
    header.write(id, 0, 'ascii');
    if (version === 4) syncsafeBytes(payload.length).copy(header, 4);
    else header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
}
const textFrame = (id, text, version) => id3Frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]), version);
const commFrame = (text, version) => id3Frame('COMM', Buffer.concat([Buffer.from([3]), Buffer.from('eng'), Buffer.from([0]), Buffer.from(text, 'utf8')]), version);
const urlFrame = (url, version) => id3Frame('WOAS', Buffer.concat([Buffer.from([0]), Buffer.from(url, 'latin1')]), version);

function mp3File(frames, { version = 3, audio = mp3Audio() } = {}) {
    const body = Buffer.concat(frames);
    const header = Buffer.alloc(10);
    header.write('ID3', 0, 'ascii');
    header[3] = version;
    header[5] = 0;
    syncsafeBytes(body.length).copy(header, 6);
    return Buffer.concat([header, body, audio]);
}

function riffChunk(id, payload) {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function wavFile({ list = true, bytes = 19200 } = {}) {
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(2, 2); fmt.writeUInt32LE(48000, 4);
    fmt.writeUInt32LE(192000, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(16, 14);
    const info = Buffer.concat([
        Buffer.from('INFO'),
        riffChunk('INAM', Buffer.from('Twin\u0000')),
        riffChunk('IART', Buffer.from('Zaliva-D\u0000')),
        riffChunk('ICMT', Buffer.from('Made with ACE Music; created=2026-11-16T10:06:22.950Z; id=so_fixture\u0000')),
        riffChunk('ISFT', Buffer.from('ACE Music\u0000')),
    ]);
    const data = Buffer.alloc(bytes);
    Buffer.from([0x11, 0x22, 0x33, 0x44]).copy(data);
    const chunks = [riffChunk('fmt ', fmt)];
    if (list) chunks.push(riffChunk('LIST', info));
    chunks.push(riffChunk('data', data));
    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(body.length + 4, 4);
    header.write('WAVE', 8, 'ascii');
    return Buffer.concat([header, body]);
}

function sandbox() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-fingerprints-'));
    const stateDir = path.join(base, 'state');
    const downloadDir = path.join(base, 'downloads');
    const root = path.join(downloadDir, 'ai音樂');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const cfg = { stateDir, downloadDir, stateFile: path.join(stateDir, 'agent-state.json'), historyFile: path.join(stateDir, 'history.json'), baseUrl: 'https://example.test' };
    const write = (rel, value) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
        return file;
    };
    return { base, cfg, root, stateDir, write };
}

const AUDIO = mp3Audio();

test('fingerprints：MP3 清掉 TSSE／ACE COMM／WOAS，保留標題藝人與音量 bytes', async () => {
    const s = sandbox();
    const file = s.write('成品MP3/Twin.mp3', mp3File([
        textFrame('TSSE', 'ACE Music'),
        textFrame('TIT2', 'Twin'),
        textFrame('TPE1', 'Zaliva-D'),
        commFrame('Made with ACE Music; created=2026-11-16T10:06:22.950Z; id=so_fixture'),
        urlFrame('https://acemusic.ai/song/h632h9x6pe7j'),
        commFrame('我的備註，不是指紋'),
    ]));
    const before = fs.statSync(file).size;
    const payloadBefore = fs.readFileSync(file).subarray(fs.readFileSync(file).length - AUDIO.length);
    const plan = await planFingerprintStrip({ cfg: s.cfg });
    assert.equal(plan.files.length, 1);
    assert.deepEqual(plan.files[0].frames.sort(), ['COMM', 'TSSE', 'WOAS']);

    const result = await stripFingerprints({ cfg: s.cfg });
    assert.equal(result.ok, true);
    assert.equal(result.mp3, 1);
    assert.equal(result.framesRemoved, 3);
    assert.equal(fs.statSync(file).size, before, '檔案長度不變');

    const after = fs.readFileSync(file);
    assert.equal(after.subarray(after.length - AUDIO.length).equals(payloadBefore), true, '音頻 bytes 未動');
    assert.equal(after.includes(Buffer.from('ACE Music')), false, 'TSSE 已抹除');
    assert.equal(after.includes(Buffer.from('acemusic.ai')), false, 'WOAS 已抹除');
    assert.equal(after.includes(Buffer.from('Twin')), true, 'TIT2 保留');
    assert.equal(after.includes(Buffer.from('Zaliva-D')), true, 'TPE1 保留');
    assert.equal(after.includes(Buffer.from('我的備註，不是指紋')), true, '非 ACE 的 COMM 保留');

    const again = await stripFingerprints({ cfg: s.cfg });
    assert.equal(again.targets, 0, '第二次沒有可清的指紋');
});

test('fingerprints：ID3v2.4 也支援，APIC 封面保留', async () => {
    const s = sandbox();
    const cover = id3Frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg'), Buffer.from([0, 0]), Buffer.from([0xff, 0xd8, 0xff, 0xe0])]), 4);
    const file = s.write('成品MP3/Twin.mp3', mp3File([
        textFrame('TSSE', 'Lavf63.1.102', 4),
        textFrame('TIT2', 'Twin', 4),
        cover,
    ], { version: 4 }));
    const result = await stripFingerprints({ cfg: s.cfg });
    assert.equal(result.mp3, 1);
    const after = fs.readFileSync(file);
    assert.equal(after.includes(Buffer.from('Lavf63.1.102')), false);
    assert.equal(after.includes(Buffer.from('image/jpeg')), true, 'APIC 保留');
});

test('fingerprints：WAV 的 LIST/INFO 就地換成 JUNK 補零，data 不動', async () => {
    const s = sandbox();
    const file = s.write('成品WAV/Twin.wav', wavFile());
    const before = fs.readFileSync(file);
    const dataOffset = before.indexOf(Buffer.from('data'));
    const payload = before.subarray(dataOffset + 8);
    const result = await stripFingerprints({ cfg: s.cfg });
    assert.equal(result.wav, 1);
    const after = fs.readFileSync(file);
    assert.equal(after.length, before.length, '檔案長度不變');
    assert.equal(after.includes(Buffer.from('ACE Music')), false);
    assert.equal(after.includes(Buffer.from('Zaliva-D')), false);
    assert.equal(after.subarray(dataOffset + 8).equals(payload), true, 'data chunk 未動');
    assert.equal(after.includes(Buffer.from('LIST')), false);
    assert.equal(after.includes(Buffer.from('JUNK')), true);
    // 之後下載流程的 stripWavMetadata 仍可辨識這個 JUNK chunk
    const { stripWavMetadata } = await import('../../agent/lib/audio-library.mjs');
    assert.ok(stripWavMetadata(after).length < after.length);
});

test('fingerprints：硬連結的音頻分類檢視一起更新，連結數不變', async () => {
    const s = sandbox();
    const file = s.write('成品MP3/Twin.mp3', mp3File([textFrame('TSSE', 'ACE Music'), textFrame('TIT2', 'Twin')]));
    const view = path.join(s.root, '音頻分類', '完整歌曲', 'Twin.mp3');
    fs.mkdirSync(path.dirname(view), { recursive: true });
    fs.linkSync(file, view);
    assert.equal(fs.statSync(file).nlink, 2);
    const result = await stripFingerprints({ cfg: s.cfg });
    assert.equal(result.targets, 1, '同 inode 只算一個目標');
    assert.equal(fs.readFileSync(view).includes(Buffer.from('ACE Music')), false, '檢視路徑也看不到指紋');
    assert.equal(fs.statSync(file).nlink, 2, '硬連結沒有被拆掉');
});

test('fingerprints：mtime 還原，音頻分析快取不會失效', async () => {
    const s = sandbox();
    const file = s.write('成品MP3/Twin.mp3', mp3File([textFrame('TSSE', 'ACE Music'), textFrame('TIT2', 'Twin')]));
    const old = new Date('2026-11-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    const before = fs.statSync(file).mtimeMs;
    await stripFingerprints({ cfg: s.cfg });
    const after = fs.statSync(file).mtimeMs;
    assert.ok(Math.abs(after - before) < 2, 'mtime 應還原');
});

test('fingerprints：備份可以還原原始 bytes', async () => {
    const s = sandbox();
    const original = mp3File([textFrame('TSSE', 'ACE Music'), textFrame('TIT2', 'Twin')]);
    const file = s.write('成品MP3/Twin.mp3', original);
    const result = await stripFingerprints({ cfg: s.cfg });
    assert.ok(result.backup && fs.existsSync(result.backup));
    assert.equal(fs.readFileSync(file).includes(Buffer.from('ACE Music')), false);
    const restored = await restoreFingerprints({ cfg: s.cfg });
    assert.equal(restored.restored, 1);
    assert.deepEqual(fs.readFileSync(file), original, '還原後與原檔完全相同');
});

test('fingerprints：已驗證音檔的 sha256 同步更新，不讓索引誤判待核對', async () => {
    const s = sandbox();
    const file = s.write('成品MP3/Twin.mp3', mp3File([textFrame('TSSE', 'ACE Music'), textFrame('TIT2', 'Twin')]));
    const bytes = fs.statSync(file).size;
    const proofFile = path.join(s.stateDir, 'verified-audio.json');
    fs.writeFileSync(proofFile, JSON.stringify({
        schema: 'ace_verified_audio_v1',
        files: [{ task_id: 'so_fixture', kind: 'mp3', absolute: file, path: 'ai音樂/成品MP3/Twin.mp3', bytes, sha256: sha(fs.readFileSync(file)), verifiedAt: '2026-11-16T10:00:00.000Z' }],
    }));
    const result = await stripFingerprints({ cfg: s.cfg });
    assert.equal(result.proofsUpdated, 1);
    const proofs = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
    assert.equal(proofs.files[0].sha256, sha(fs.readFileSync(file)), 'sha256 要是改過後的真實內容');
    assert.equal(proofs.files[0].bytes, bytes);
    assert.ok(proofs.files[0].sourceSha256 && proofs.files[0].sourceSha256 !== proofs.files[0].sha256, '清除前的來源 sha256 要保留');
    assert.equal(proofs.files[0].sourceBytes, bytes);
    assert.ok(!fs.existsSync(path.join(s.stateDir, 'verified-audio.lock')), '更新完要釋放 proof 鎖');
});

test('fingerprints：proof 鎖被別的工作持有時不改 proof，回報待補', async () => {
    const s = sandbox();
    const file = s.write('成品MP3/Locked.mp3', mp3File([textFrame('TSSE', 'ACE Music'), textFrame('TIT2', 'Locked')]));
    const original = sha(fs.readFileSync(file));
    const proofFile = path.join(s.stateDir, 'verified-audio.json');
    fs.writeFileSync(proofFile, JSON.stringify({ schema: 'ace_verified_audio_v1', files: [{ task_id: 'so_lock', kind: 'mp3', absolute: file, bytes: fs.statSync(file).size, sha256: original, verifiedAt: '2026-11-16T10:00:00.000Z' }] }));
    const lockFile = path.join(s.stateDir, 'verified-audio.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, purpose: 'other writer' }));
    const result = await stripFingerprints({ cfg: s.cfg });
    assert.equal(result.proofsUpdated, 0);
    assert.equal(result.proofsUpdatePending, true);
    assert.equal(JSON.parse(fs.readFileSync(proofFile, 'utf8')).files[0].sha256, original, '別人持鎖時 proof 原封不動');
    assert.ok(fs.existsSync(lockFile), '不刪別人的鎖');
});

test('fingerprints：下載時用等長緩衝區清除，audio bytes 與長度都不變', async () => {
    const { stripMp3TagBuffer } = await import('../../agent/lib/fingerprints.mjs');
    const buffer = mp3File([textFrame('TSSE', 'ACE Music'), textFrame('TIT2', 'Twin'), commFrame('Made with ACE Music; created=x; id=so_1')]);
    const out = stripMp3TagBuffer(buffer);
    assert.equal(out.length, buffer.length, '下載路徑不能讓檔案變長或變短');
    assert.equal(out.includes(Buffer.from('ACE Music')), false);
    assert.equal(out.includes(Buffer.from('Twin')), true);
    assert.deepEqual(out.subarray(out.length - AUDIO.length), buffer.subarray(buffer.length - AUDIO.length));
    const clean = mp3File([textFrame('TIT2', 'Clean')]);
    assert.equal(stripMp3TagBuffer(clean), clean, '乾淨的檔原樣回傳，不複製');
});

test('fingerprints：截斷的 data chunk 尾端 id3 chunk 也清掉（音頻分類找回的殘檔）', async () => {
    const s = sandbox();
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(2, 2); fmt.writeUInt32LE(48000, 4);
    fmt.writeUInt32LE(192000, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(16, 14);
    const data = Buffer.alloc(19200);
    data[0] = 0x11;
    const dataHeader = Buffer.alloc(8);
    dataHeader.write('data', 0, 'ascii');
    dataHeader.writeUInt32LE(42086144, 4); // 宣告比實際大：截斷檔
    const id3Payload = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), Buffer.from('ACE Music; created=2026-11-16T10:06:22.950Z; id=so_fixture')]);
    const chunks = [riffChunk('fmt ', fmt), Buffer.concat([dataHeader, data]), riffChunk('id3 ', id3Payload)];
    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(body.length + 4, 4);
    header.write('WAVE', 8, 'ascii');
    const file = s.write('_未對應/音頻分類找回/Partial.wav', Buffer.concat([header, body]));
    const before = fs.readFileSync(file);
    const result = await stripFingerprints({ cfg: s.cfg });
    assert.equal(result.wav, 1);
    const after = fs.readFileSync(file);
    assert.equal(after.length, before.length);
    assert.equal(after.includes(Buffer.from('ACE Music')), false);
    assert.equal(after.subarray(0, 36 + 8 + 64).equals(before.subarray(0, 36 + 8 + 64)), true, 'fmt／data 前段不動');
    const again = await stripFingerprints({ cfg: s.cfg });
    assert.equal(again.targets, 0);
});

test('fingerprints：dry-run 不寫檔；非音檔與沒有指紋的檔都不動', async () => {
    const s = sandbox();
    const file = s.write('成品MP3/Twin.mp3', mp3File([textFrame('TSSE', 'ACE Music')]));
    const clean = s.write('成品MP3/Clean.mp3', mp3File([textFrame('TIT2', 'Clean')]));
    s.write('成品MP3/notes.txt', Buffer.from('ACE Music'));
    const original = fs.readFileSync(file);
    const plan = await stripFingerprints({ cfg: s.cfg, dryRun: true });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.cleaned, 0);
    assert.deepEqual(fs.readFileSync(file), original, 'dry-run 不改檔');
    const scan = await scanAudioFingerprint(clean);
    assert.equal(scan.removable, false);
});
