// wav-names：成品WAV 分類後「只複製」乾淨名字到 整理輸出（來源永不移動／改名）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planWavCopies, copyCollectedWavs } from '../../agent/lib/wav-names.mjs';

function sandbox() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-wav-copies-'));
    const stateDir = path.join(base, 'state');
    const downloadDir = path.join(base, 'downloads');
    const root = path.join(downloadDir, 'ai音樂');
    const wavDir = path.join(root, '成品WAV');
    const outDir = path.join(root, '整理輸出', '成品WAV');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(wavDir, { recursive: true });
    const cfg = { stateDir, downloadDir, stateFile: path.join(stateDir, 'agent-state.json'), historyFile: path.join(stateDir, 'history.json'), baseUrl: 'https://example.test' };
    const wav = (name, bytes = 64) => {
        const file = path.join(wavDir, name);
        const data = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(bytes)]);
        data[8] = bytes % 251; // 讓不同 take 內容不同
        fs.writeFileSync(file, data);
        return file;
    };
    return { base, cfg, root, wavDir, outDir, wav };
}

const song = (id, title, createdAt = 1) => ({ task_id: id, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1', local_audio: '/data/' + id + '.mp3', meta: { title }, created_at: createdAt });
const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /\.wav$/i.test(name)).sort() : []);

test('wav-copies：[8hex] 尾碼對到唯一 task → 複製成 <歌名>.wav，來源不動', async () => {
    const s = sandbox();
    const source = s.wav('Twin [aabbcc11].wav');
    const songs = [song('so_1111aabbcc11', 'Twin')];
    const dry = await planWavCopies({ files: [source], songs, state: {}, proofs: { files: [] }, downloadDir: s.cfg.downloadDir, outDir: s.outDir });
    assert.equal(dry.plan.length, 1);
    assert.equal(path.basename(dry.plan[0].target), 'Twin.wav');

    const result = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(result.ok, true);
    assert.equal(result.copied, 1);
    assert.deepEqual(names(s.outDir), ['Twin.wav']);
    assert.ok(fs.existsSync(source), '來源檔必須保留');
    assert.deepEqual(names(s.wavDir), ['Twin [aabbcc11].wav'], '來源檔名不可以被改');
});

test('wav-copies：每次生成兩首同名歌 → 依 created_at 分 (2)(3)，兩份都複製', async () => {
    const s = sandbox();
    const a = s.wav('Take A [aabbcc11].wav', 64);
    const b = s.wav('Take B [aabbcc22].wav', 128);
    const songs = [song('so_1111aabbcc11', 'Twin', 2), song('so_2222aabbcc22', 'Twin', 1)];
    const result = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(result.copied, 2);
    assert.deepEqual(names(s.outDir), ['Twin (2).wav', 'Twin.wav']);
    // created_at 較早的 task 拿 Twin.wav
    assert.equal(fs.statSync(path.join(s.outDir, 'Twin.wav')).size, fs.statSync(b).size);
    assert.equal(fs.statSync(path.join(s.outDir, 'Twin (2).wav')).size, fs.statSync(a).size);
    assert.deepEqual(names(s.wavDir).sort(), ['Take A [aabbcc11].wav', 'Take B [aabbcc22].wav']);
});

test('wav-copies：重跑只跳過，不重複複製；內容不同的同名不會被覆寫', async () => {
    const s = sandbox();
    s.wav('Twin [aabbcc11].wav', 64);
    const songs = [song('so_1111aabbcc11', 'Twin')];
    const first = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(first.copied, 1);
    const second = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(second.copied, 0);
    assert.equal(second.already, 1);
    assert.deepEqual(names(s.outDir), ['Twin.wav']);
    // 使用者把副本改成別的內容 → 下一次仍然保留它，不會覆寫
    const copy = path.join(s.outDir, 'Twin.wav');
    fs.writeFileSync(copy, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(32)]));
    const third = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(third.copied, 1, '不會覆寫既有副本，改用下一個編號');
    assert.equal(fs.statSync(copy).size, 36, '既有副本不能被覆寫');
    assert.ok(fs.existsSync(path.join(s.outDir, 'Twin (2).wav')));
});

test('wav-copies：沒有證據或兩個 task 都認領 → 不複製', async () => {
    const s = sandbox();
    const mine = s.wav('My own take.wav');
    const shared = s.wav('Shared.wav');
    const songs = [song('so_1111aabbcc11', 'Alpha'), song('so_2222aabbcc22', 'Beta')];
    const state = { history: {
        so_1111aabbcc11: { files: { wav: { absolute: shared } } },
        so_2222aabbcc22: { files: { wav: { absolute: shared } } },
    } };
    const plan = planWavCopies({ files: [mine, shared], songs, state, proofs: { files: [] }, downloadDir: s.cfg.downloadDir, outDir: s.outDir });
    assert.equal(plan.plan.length, 0);
    assert.equal(plan.loose.length, 2);
    const result = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(result.copied, 0);
    assert.equal(fs.existsSync(s.outDir), false);
});

test('wav-copies：history 與 verified 驗證紀錄都可當歸屬證據', async () => {
    const s = sandbox();
    const fromHistory = s.wav('Messy name.wav', 64);
    const fromProof = s.wav('Another name.wav', 96);
    const songs = [song('so_1111aabbcc11', 'Alpha'), song('so_2222aabbcc22', 'Beta')];
    const plan = planWavCopies({
        files: [fromHistory, fromProof],
        songs,
        state: { history: { so_1111aabbcc11: { files: { wav: { absolute: fromHistory } } } } },
        proofs: { files: [{ task_id: 'so_2222aabbcc22', kind: 'wav', absolute: fromProof }] },
        downloadDir: s.cfg.downloadDir,
        outDir: s.outDir,
    });
    assert.deepEqual(plan.plan.map((item) => path.basename(item.target)).sort(), ['Alpha.wav', 'Beta.wav']);
    assert.equal(plan.loose.length, 0);
});

test('wav-copies：dry-run 只回計畫，不建輸出資料夾', async () => {
    const s = sandbox();
    s.wav('Twin [aabbcc11].wav');
    const songs = [song('so_1111aabbcc11', 'Twin')];
    const result = await copyCollectedWavs({ cfg: s.cfg, songs, dryRun: true });
    assert.equal(result.planned, 1);
    assert.equal(result.copied, 0);
    assert.equal(fs.existsSync(s.outDir), false);
    assert.deepEqual(result.items.map((item) => item.to), ['Twin.wav']);
});

const sameSizeWav = (s, name, marker) => {
    const file = path.join(s.wavDir, name);
    const data = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64)]);
    data[20] = marker; // 同大小、不同內容（同一次生成的兩首常見）
    fs.writeFileSync(file, data);
    return file;
};

test('wav-copies：同一次生成的兩首「大小相同、內容不同」→ 兩首都複製，不會誤判成已複製', async () => {
    const s = sandbox();
    sameSizeWav(s, 'A [aabbcc11].wav', 1);
    sameSizeWav(s, 'B [aabbcc22].wav', 2);
    const songs = [song('so_1111aabbcc11', 'Pair', 1), song('so_2222aabbcc22', 'Pair', 2)];
    const result = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(result.copied, 2, JSON.stringify(result));
    assert.deepEqual(names(s.outDir), ['Pair (2).wav', 'Pair.wav']);
    assert.equal(fs.readFileSync(path.join(s.outDir, 'Pair.wav'))[20], 1);
    assert.equal(fs.readFileSync(path.join(s.outDir, 'Pair (2).wav'))[20], 2);
    const again = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(again.copied, 0);
    assert.equal(again.already, 2);
});

test('wav-copies：對照表讓名字跨次執行保持穩定；後來出現的同名歌不搶既有名字', async () => {
    const s = sandbox();
    sameSizeWav(s, 'B [aabbcc22].wav', 2);
    const later = [song('so_2222aabbcc22', 'Stable', 5)];
    await copyCollectedWavs({ cfg: s.cfg, songs: later });
    assert.deepEqual(names(s.outDir), ['Stable.wav']);
    const map = JSON.parse(fs.readFileSync(path.join(s.outDir, '_對照表.json'), 'utf8'));
    assert.equal(map.items.so_2222aabbcc22.name, 'Stable.wav');
    // 一首 created_at 更早的同名歌後來才下載 → 拿新的編號，不把既有的 Stable.wav 換掉
    sameSizeWav(s, 'A [aabbcc11].wav', 1);
    const result = await copyCollectedWavs({ cfg: s.cfg, songs: [song('so_1111aabbcc11', 'Stable', 1), ...later] });
    assert.equal(result.copied, 1);
    assert.equal(fs.readFileSync(path.join(s.outDir, 'Stable.wav'))[20], 2, '既有名字仍指向原本那首');
    assert.equal(fs.readFileSync(path.join(s.outDir, 'Stable (2).wav'))[20], 1);
});

test('wav-copies：來源後來變了（例如清除指紋）→ 沒被動過的副本原地更新；使用者改過的副本保留', async () => {
    const s = sandbox();
    const source = sameSizeWav(s, 'Song [aabbcc11].wav', 1);
    const other = sameSizeWav(s, 'Other [aabbcc22].wav', 2);
    const songs = [song('so_1111aabbcc11', 'Fresh', 1), song('so_2222aabbcc22', 'Edited', 2)];
    await copyCollectedWavs({ cfg: s.cfg, songs });
    // 兩個來源都就地改變（同長度）
    for (const [file, marker] of [[source, 9], [other, 8]]) { const data = fs.readFileSync(file); data[30] = marker; fs.writeFileSync(file, data); }
    // 使用者改了 Edited.wav
    fs.writeFileSync(path.join(s.outDir, 'Edited.wav'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(10)]));
    const result = await copyCollectedWavs({ cfg: s.cfg, songs });
    assert.equal(result.replaced, 1, '只更新自己沒被動過的副本');
    assert.equal(fs.readFileSync(path.join(s.outDir, 'Fresh.wav'))[30], 9, 'Fresh.wav 換成新內容');
    assert.equal(fs.statSync(path.join(s.outDir, 'Edited.wav')).size, 14, '使用者改過的副本不覆寫');
    assert.equal(fs.readFileSync(path.join(s.outDir, 'Edited (2).wav'))[30], 8, '這首改用下一個編號');
    assert.ok(fs.existsSync(path.join(s.cfg.stateDir, 'organize-backups')), '被更新的舊副本先歸檔');
});

test('wav-copies：本機索引的歸屬證據可補上沒有尾碼／紀錄的 WAV；索引把同一檔指給兩首時仍不複製', () => {
    const s = sandbox();
    const plain = s.wav('No Evidence.wav', 64);
    const shared = s.wav('Shared.wav', 96);
    const songs = [song('so_aaaa00000001', 'Indexed', 1), song('so_bbbb00000002', 'Other', 2)];
    const base = { files: [plain, shared], songs, state: {}, proofs: { files: [] }, downloadDir: s.cfg.downloadDir, outDir: s.outDir };
    assert.equal(planWavCopies(base).loose.length, 2, '沒有索引時兩個都沒證據');
    const withIndex = planWavCopies({ ...base, indexClaims: [[plain, 'so_aaaa00000001'], [shared, 'so_aaaa00000001'], [shared, 'so_bbbb00000002']] });
    assert.deepEqual(withIndex.plan.map((item) => [path.basename(item.file), item.taskId, path.basename(item.target)]), [['No Evidence.wav', 'so_aaaa00000001', 'Indexed.wav']]);
    assert.deepEqual(withIndex.loose.map((file) => path.basename(file)), ['Shared.wav'], '兩首都主張的檔不複製');
});
