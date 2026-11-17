// favorites：站點點讚 ∪ 面板愛心 → ai音樂/收藏/<歌名>.wav（平鋪一層、只放無損母帶；複製、不動原檔）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFavorites, readFavoriteTargets, pickFavoriteWav } from '../../agent/lib/favorites.mjs';

function mp3(fill = 0) {
    const data = Buffer.alloc(417);
    Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(data);
    data[100] = fill;
    return data;
}

/** 最小可解析的 PCM WAV（RIFF／fmt／data），索引會判定 validity=valid、format=wav。 */
function wav(fill = 0) {
    const data = Buffer.alloc(8 + fill % 7);
    data.fill(0x80);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

const jpg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const midi = () => Buffer.from('MThd fixture', 'utf8');

const song = (id, title, extra = {}) => ({
    task_id: id, status: 'succeeded', capability: 'music_generate', model: 'acemusic-v1.1',
    local_audio: '/data/' + id + '.mp3', meta: { title }, ...extra,
});

function fixture(songs) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acedl-favorites-'));
    const stateDir = path.join(base, 'state');
    const downloadDir = path.join(base, 'downloads');
    const root = path.join(downloadDir, 'ai音樂');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const cfg = {
        stateDir, downloadDir, root,
        stateFile: path.join(stateDir, 'agent-state.json'),
        historyFile: path.join(stateDir, 'history.json'),
        baseUrl: 'https://example.test',
    };
    const write = (rel, value) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
        return file;
    };
    const json = (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
        return file;
    };
    json(path.join(stateDir, 'page-songs.json'), { songs });
    return { base, cfg, root, stateDir, write, json };
}

/** 把「已下載」寫進 agent-state.json 的 history，索引才會有歸屬證據。 */
function recordDownloads(f, entries) {
    const history = {};
    for (const entry of entries) {
        const files = {};
        for (const [key, absolute] of Object.entries(entry.files)) {
            files[key] = { absolute, bytes: fs.statSync(absolute).size };
        }
        history[entry.taskId] = { files };
    }
    f.json(f.cfg.stateFile, { history });
}

const readManifest = (f) => JSON.parse(fs.readFileSync(path.join(f.root, '收藏', '_收藏清單.json'), 'utf8'));
const favDir = (f) => path.join(f.root, '收藏');
const like = (f, likes) => f.json(path.join(f.stateDir, 'site-likes.json'), {
    schema: 'ace_site_likes_v1', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', revision: 'r1',
    likes: likes.map(([task_id, title, created_at = 1]) => ({ task_id, title, created_at })),
});

test('favorites: 一首歌只複製一個 WAV 母帶到 收藏/<歌名>.wav，MP3／分軌／封面都不收', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aWav = f.write('成品WAV/Alpha.wav', wav(1));
    const aMp3 = f.write('成品MP3/Alpha.mp3', mp3(1));
    const aCover = f.write('封面/Alpha - Cover.jpg', jpg());
    const aStem = f.write('採樣包/Drums/Alpha - Drums.mp3', mp3(2));
    const aMidi = f.write('MIDI/Alpha - MIDI.mid', midi());
    recordDownloads(f, [{ taskId: 'so_a', files: { wav: aWav, mp3: aMp3, cover: aCover, 'stem:s1': aStem, midi: aMidi } }]);
    like(f, [['so_a', 'Alpha', 2]]);

    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.total, 1);
    assert.equal(result.copied, 1);
    assert.equal(result.noWav, 0);
    assert.equal(result.pruned, 0);
    assert.deepEqual(result.failed, []);

    const files = fs.readdirSync(favDir(f)).sort();
    assert.deepEqual(files, ['Alpha.wav', '_收藏清單.json'], '收藏根目錄只有母帶與清單');
    assert.deepEqual(fs.readFileSync(path.join(favDir(f), 'Alpha.wav')), wav(1));
    for (const file of [aWav, aMp3, aCover, aStem, aMidi]) assert.ok(fs.existsSync(file), '原檔不能被搬走');

    const manifest = readManifest(f);
    assert.equal(manifest.schema, 'ace_favorites_manifest_v2');
    assert.equal(manifest.layout, 'flat-wav');
    assert.equal(manifest.items.find((item) => item.task_id === 'so_a').file, 'Alpha.wav');
});

test('favorites: 站點只有 MP3 的歌沒有母帶可收，計入 noWav 且不建檔', async () => {
    const b = song('so_b', 'Beta');
    const f = fixture([b]);
    const bMp3 = f.write('成品MP3/Beta.mp3', mp3(3));
    const bCover = f.write('封面/Beta - Cover.jpg', jpg());
    recordDownloads(f, [{ taskId: 'so_b', files: { mp3: bMp3, cover: bCover } }]);
    like(f, [['so_b', 'Beta']]);

    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.total, 1);
    assert.equal(result.copied, 0);
    assert.equal(result.noWav, 1);
    assert.equal(fs.existsSync(path.join(favDir(f), 'Beta.wav')), false);
    assert.equal(fs.existsSync(path.join(favDir(f), 'Beta.mp3')), false, 'MP3 不再複製進收藏');
});

test('favorites: 兩首同名歌各自一個 WAV，不互相覆寫', async () => {
    const a = song('so_a', 'Twin');
    const b = song('so_b', 'Twin');
    const f = fixture([a, b]);
    const aWav = f.write('成品WAV/Twin.wav', wav(1));
    const bWav = f.write('成品WAV/Twin (2).wav', wav(2));
    recordDownloads(f, [
        { taskId: 'so_a', files: { wav: aWav } },
        { taskId: 'so_b', files: { wav: bWav } },
    ]);
    like(f, [['so_a', 'Twin', 2], ['so_b', 'Twin', 1]]);

    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.copied, 2);
    const files = fs.readdirSync(favDir(f)).filter((name) => name.endsWith('.wav')).sort();
    assert.deepEqual(files, ['Twin (2).wav', 'Twin.wav']);
    assert.deepEqual(fs.readFileSync(path.join(favDir(f), 'Twin.wav')), wav(1));
    assert.deepEqual(fs.readFileSync(path.join(favDir(f), 'Twin (2).wav')), wav(2));
});

test('favorites: 再跑一次只跳過，不重寫既有母帶', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aWav = f.write('成品WAV/Alpha.wav', wav(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { wav: aWav } }]);
    like(f, [['so_a', 'Alpha']]);
    const first = await collectFavorites({ cfg: f.cfg });
    assert.equal(first.copied, 1);
    const copy = path.join(favDir(f), 'Alpha.wav');
    const before = fs.statSync(copy).mtimeMs;
    const second = await collectFavorites({ cfg: f.cfg });
    assert.equal(second.copied, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.conflicts, 0);
    assert.equal(fs.statSync(copy).mtimeMs, before, '內容相同就不應該重寫');
});

test('favorites: 舊版 收藏/<歌名>/ 佈局會被清掉，只剩平的 WAV', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aWav = f.write('成品WAV/Alpha.wav', wav(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { wav: aWav } }]);
    like(f, [['so_a', 'Alpha']]);
    // 舊版留下的子資料夾與檔案（含 MP3、封面、分軌）
    const legacyMp3 = f.write('收藏/Alpha/Alpha.mp3', mp3(9));
    const legacyCover = f.write('收藏/Alpha/Alpha - Cover.jpg', jpg());
    f.write('收藏/Alpha/Alpha - Drums.mp3', mp3(8));
    f.json(path.join(favDir(f), '_收藏清單.json'), {
        schema: 'ace_favorites_manifest_v1',
        items: [{
            task_id: 'so_a', title: 'Alpha', dir: 'Alpha', sources: ['site'],
            files: [
                { name: 'Alpha.mp3', kind: 'mp3', bytes: fs.statSync(legacyMp3).size, source: '成品MP3/Alpha.mp3' },
                { name: 'Alpha - Cover.jpg', kind: 'cover', bytes: fs.statSync(legacyCover).size, source: '封面/Alpha - Cover.jpg' },
                { name: 'Alpha - Drums.mp3', kind: 'stems', bytes: mp3(8).length, source: '採樣包/Drums/Alpha - Drums.mp3' },
            ],
        }],
    });

    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.pruned, 3);
    assert.equal(result.prunedDirs, 1);
    assert.equal(fs.existsSync(path.join(favDir(f), 'Alpha')), false, '舊資料夾要被移除');
    assert.deepEqual(fs.readdirSync(favDir(f)).sort(), ['Alpha.wav', '_收藏清單.json']);
});

test('favorites: 使用者自己放的同名 WAV 不被覆寫，改用下一個名字', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aWav = f.write('成品WAV/Alpha.wav', wav(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { wav: aWav } }]);
    like(f, [['so_a', 'Alpha']]);
    const userFile = f.write('收藏/Alpha.wav', wav(99));

    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.copied, 1);
    assert.deepEqual(fs.readFileSync(userFile), wav(99), '使用者的檔不動');
    assert.deepEqual(fs.readFileSync(path.join(favDir(f), 'Alpha (2).wav')), wav(1));
});

test('favorites: dry-run 只回計畫，不建檔、不寫清單', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aWav = f.write('成品WAV/Alpha.wav', wav(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { wav: aWav } }]);
    like(f, [['so_a', 'Alpha']]);
    const planned = await collectFavorites({ cfg: f.cfg, dryRun: true });
    assert.equal(planned.dryRun, true);
    assert.equal(planned.copied, 0);
    assert.equal(planned.planned, 1);
    assert.equal(fs.existsSync(favDir(f)), false);
});

test('favorites: 沒有任何喜歡的歌時不收檔，也不建資料夾', async () => {
    const f = fixture([song('so_a', 'Alpha')]);
    const targets = await readFavoriteTargets(f.cfg);
    assert.equal(targets.total, 0);
    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.total, 0);
    assert.equal(result.copied, 0);
    assert.equal(fs.existsSync(favDir(f)), false);
});

test('favorites: 站點快照壞掉不影響面板愛心', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aWav = f.write('成品WAV/Alpha.wav', wav(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { wav: aWav } }]);
    fs.writeFileSync(path.join(f.stateDir, 'site-likes.json'), '{not json');
    f.json(path.join(f.stateDir, 'page-favorites.json'), { savedAt: 1, favorites: [{ task_id: 'so_a', title: 'Alpha', at: 1 }] });
    const targets = await readFavoriteTargets(f.cfg);
    assert.equal(targets.site.present, false);
    assert.equal(targets.panel.present, true);
    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.total, 1);
    assert.equal(result.copied, 1);
    assert.ok(fs.existsSync(path.join(favDir(f), 'Alpha.wav')));
});

test('favorites: pickFavoriteWav 只挑成品 WAV，不挑分軌或損壞檔', () => {
    const row = {
        files: [
            { kind: 'wav', absolute: 'F:/x/stems/Alpha - Drums.wav', confidence: 'verified', validity: 'valid', bytes: 10 },
            { kind: 'wav', absolute: 'F:/x/成品WAV/Alpha.wav', confidence: 'recorded', validity: 'valid', bytes: 20 },
            { kind: 'wav', absolute: 'F:/x/成品WAV/Broken.wav', confidence: 'recorded', validity: 'damaged', bytes: 30 },
            { kind: 'wav', absolute: 'F:/x/成品WAV/Uncertain.wav', confidence: 'uncertain', validity: 'valid', bytes: 40 },
            { kind: 'mp3', absolute: 'F:/x/成品MP3/Alpha.mp3', confidence: 'verified', validity: 'valid', bytes: 5 },
        ],
    };
    const picked = pickFavoriteWav(row);
    assert.equal(picked.absolute, 'F:/x/成品WAV/Alpha.wav');
    assert.equal(pickFavoriteWav({ files: [{ kind: 'mp3', absolute: 'a.mp3', confidence: 'verified', validity: 'valid' }] }), null);
});

test('favorites: 收藏 的母帶不進歌曲索引與檔案索引，同一首歌不會被算成兩份', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aWav = f.write('成品WAV/Alpha.wav', wav(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { wav: aWav } }]);
    like(f, [['so_a', 'Alpha']]);
    await collectFavorites({ cfg: f.cfg });
    const { buildLocalDownloadIndex } = await import('../../agent/lib/local-index.mjs');
    const index = await buildLocalDownloadIndex({ cfg: f.cfg, root: 'ai音樂' });
    assert.equal(index.physicalFiles.some((file) => file.absolutePath.includes('收藏')), false, '複本不該進歌曲索引');
    assert.equal(index.byTask.so_a.files.filter((file) => file.kind === 'wav').length, 1, '同一首歌只能有一份 wav 歸屬');
    const { collectDownloadIndex } = await import('../../agent/lib/ace.mjs');
    const fsIndex = await collectDownloadIndex(f.cfg, { refresh: true });
    assert.equal(fsIndex.files.some((file) => file.includes('收藏')), false, '複本不該進 locate／曲庫總覽用的檔案索引');
});
