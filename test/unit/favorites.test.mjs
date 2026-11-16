// favorites：站點點讚 ∪ 面板愛心 → ai音樂/收藏/<歌名>/（複製，不動原檔）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFavorites, readFavoriteTargets } from '../../agent/lib/favorites.mjs';

function mp3(fill = 0) {
    const data = Buffer.alloc(417);
    Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(data);
    data[100] = fill;
    return data;
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

test('favorites: 站點點讚 ∪ 面板愛心，整首歌的檔案複製進 收藏/，原檔不動', async () => {
    const a = song('so_a', 'Alpha');
    const b = song('so_b', 'Beta');
    const c = song('so_c', 'Gamma'); // 有喜歡但沒下載
    const f = fixture([a, b, c]);
    const aMp3 = f.write('成品MP3/Alpha.mp3', mp3(1));
    const aCover = f.write('封面/Alpha - Cover.jpg', jpg());
    const aStem = f.write('採樣包/Drums/Alpha - Drums.mp3', mp3(2));
    const aMidi = f.write('MIDI/Alpha - MIDI.mid', midi());
    const bMp3 = f.write('成品MP3/Beta.mp3', mp3(3));
    recordDownloads(f, [
        { taskId: 'so_a', files: { mp3: aMp3, cover: aCover, 'stem:s1': aStem, midi: aMidi } },
        { taskId: 'so_b', files: { mp3: bMp3 } },
    ]);
    f.json(path.join(f.stateDir, 'site-likes.json'), {
        schema: 'ace_site_likes_v1', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', revision: 'r1',
        likes: [
            { task_id: 'so_a', title: 'Alpha', created_at: 2 },
            { task_id: 'so_c', title: 'Gamma', created_at: 3 },
            { task_id: 'so_zzz', title: 'Not In Library', created_at: 4 },
        ],
    });
    f.json(path.join(f.stateDir, 'page-favorites.json'), {
        savedAt: 1,
        favorites: [{ task_id: 'so_b', title: 'Beta', at: 5 }, { task_id: 'so_a', title: 'Alpha', at: 4 }],
    });

    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.total, 4, '兩邊的聯集，同一首只算一次');
    assert.equal(result.copied, 5);
    assert.equal(result.missing, 1);
    assert.equal(result.unknown, 1);
    assert.deepEqual(result.failed, []);

    const favRoot = path.join(f.root, '收藏');
    assert.ok(fs.existsSync(path.join(favRoot, 'Alpha', 'Alpha.mp3')));
    assert.ok(fs.existsSync(path.join(favRoot, 'Alpha', 'Alpha - Drums.mp3')));
    assert.ok(fs.existsSync(path.join(favRoot, 'Alpha', 'Alpha - Cover.jpg')));
    assert.ok(fs.existsSync(path.join(favRoot, 'Alpha', 'Alpha - MIDI.mid')));
    assert.ok(fs.existsSync(path.join(favRoot, 'Beta', 'Beta.mp3')));
    assert.equal(fs.existsSync(path.join(favRoot, 'Gamma')), false, '沒下載的歌不建空資料夾');

    // 複製不是搬移：原檔全部還在
    for (const file of [aMp3, aCover, aStem, aMidi, bMp3]) assert.ok(fs.existsSync(file), '原檔不能被搬走');

    const manifest = readManifest(f);
    assert.equal(manifest.schema, 'ace_favorites_manifest_v1');
    assert.equal(manifest.items.find((item) => item.task_id === 'so_a').dir, 'Alpha');
    assert.equal(manifest.items.find((item) => item.task_id === 'so_b').dir, 'Beta');
});

test('favorites: 再跑一次只跳過，不重複複製、不改動已存在的檔', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aMp3 = f.write('成品MP3/Alpha.mp3', mp3(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { mp3: aMp3 } }]);
    f.json(path.join(f.stateDir, 'site-likes.json'), {
        schema: 'ace_site_likes_v1', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', revision: 'r1',
        likes: [{ task_id: 'so_a', title: 'Alpha', created_at: 1 }],
    });
    const first = await collectFavorites({ cfg: f.cfg });
    assert.equal(first.copied, 1);
    const copy = path.join(f.root, '收藏', 'Alpha', 'Alpha.mp3');
    const before = fs.statSync(copy).mtimeMs;
    const second = await collectFavorites({ cfg: f.cfg });
    assert.equal(second.copied, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.conflicts, 0);
    assert.equal(fs.statSync(copy).mtimeMs, before, '內容相同就不應該重寫');
});

test('favorites: 同名不同內容保留使用者的檔（force 才覆寫，舊檔先歸檔）', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aMp3 = f.write('成品MP3/Alpha.mp3', mp3(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { mp3: aMp3 } }]);
    f.json(path.join(f.stateDir, 'site-likes.json'), {
        schema: 'ace_site_likes_v1', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', revision: 'r1',
        likes: [{ task_id: 'so_a', title: 'Alpha', created_at: 1 }],
    });
    await collectFavorites({ cfg: f.cfg });
    const copy = path.join(f.root, '收藏', 'Alpha', 'Alpha.mp3');
    fs.writeFileSync(copy, mp3(99)); // 使用者自己動過

    const conflicted = await collectFavorites({ cfg: f.cfg });
    assert.equal(conflicted.conflicts, 1);
    assert.equal(conflicted.copied, 0);
    assert.deepEqual(fs.readFileSync(copy), mp3(99), '預設不覆寫使用者的檔');

    const forced = await collectFavorites({ cfg: f.cfg, force: true });
    assert.equal(forced.copied, 1);
    assert.deepEqual(fs.readFileSync(copy), mp3(1), 'force 才覆寫成來源內容');
    const backups = fs.readdirSync(path.join(f.cfg.stateDir, 'organize-backups'));
    assert.ok(backups.length >= 1, '覆寫前要先歸檔舊檔');
});

test('favorites: dry-run 只回計畫，不建資料夾、不寫清單', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aMp3 = f.write('成品MP3/Alpha.mp3', mp3(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { mp3: aMp3 } }]);
    f.json(path.join(f.stateDir, 'site-likes.json'), {
        schema: 'ace_site_likes_v1', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', revision: 'r1',
        likes: [{ task_id: 'so_a', title: 'Alpha', created_at: 1 }],
    });
    const planned = await collectFavorites({ cfg: f.cfg, dryRun: true });
    assert.equal(planned.dryRun, true);
    assert.equal(planned.copied, 0);
    assert.equal(fs.existsSync(path.join(f.root, '收藏')), false);
});

test('favorites: 兩首同名歌各自一個資料夾，不混檔', async () => {
    const a = song('so_a', 'Twin');
    const b = song('so_b', 'Twin');
    const f = fixture([a, b]);
    const aMp3 = f.write('成品MP3/Twin.mp3', mp3(1));
    const bMp3 = f.write('成品MP3/Twin (2).mp3', mp3(2));
    recordDownloads(f, [
        { taskId: 'so_a', files: { mp3: aMp3 } },
        { taskId: 'so_b', files: { mp3: bMp3 } },
    ]);
    f.json(path.join(f.stateDir, 'site-likes.json'), {
        schema: 'ace_site_likes_v1', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', revision: 'r1',
        likes: [{ task_id: 'so_a', title: 'Twin', created_at: 2 }, { task_id: 'so_b', title: 'Twin', created_at: 1 }],
    });
    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.copied, 2);
    const dirs = fs.readdirSync(path.join(f.root, '收藏')).filter((name) => fs.statSync(path.join(f.root, '收藏', name)).isDirectory()).sort();
    assert.deepEqual(dirs, ['Twin', 'Twin (2)']);
    const one = fs.readdirSync(path.join(f.root, '收藏', 'Twin'));
    const two = fs.readdirSync(path.join(f.root, '收藏', 'Twin (2)'));
    assert.deepEqual(one, ['Twin.mp3']);
    assert.deepEqual(two, ['Twin (2).mp3']);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '收藏', 'Twin', 'Twin.mp3')), mp3(1));
    assert.deepEqual(fs.readFileSync(path.join(f.root, '收藏', 'Twin (2)', 'Twin (2).mp3')), mp3(2));
});

test('favorites: 沒有任何喜歡的歌時不收檔，也不建空資料夾', async () => {
    const f = fixture([song('so_a', 'Alpha')]);
    const targets = await readFavoriteTargets(f.cfg);
    assert.equal(targets.total, 0);
    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.total, 0);
    assert.equal(result.copied, 0);
    assert.equal(fs.existsSync(path.join(f.root, '收藏')), false);
});

test('favorites: 收藏 不進歌曲索引與檔案索引，同一首歌不會被算成兩份', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aMp3 = f.write('成品MP3/Alpha.mp3', mp3(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { mp3: aMp3 } }]);
    f.json(path.join(f.stateDir, 'site-likes.json'), {
        schema: 'ace_site_likes_v1', complete: true, fetchedAt: '2026-01-01T00:00:00.000Z', revision: 'r1',
        likes: [{ task_id: 'so_a', title: 'Alpha', created_at: 1 }],
    });
    await collectFavorites({ cfg: f.cfg });
    const { buildLocalDownloadIndex } = await import('../../agent/lib/local-index.mjs');
    const index = await buildLocalDownloadIndex({ cfg: f.cfg, root: 'ai音樂' });
    assert.equal(index.physicalFiles.some((file) => file.absolutePath.includes('收藏')), false, '複本不該進歌曲索引');
    assert.equal(index.byTask.so_a.files.filter((file) => file.kind === 'mp3').length, 1, '同一首歌只能有一份 mp3 歸屬');
    const { collectDownloadIndex } = await import('../../agent/lib/ace.mjs');
    const fsIndex = await collectDownloadIndex(f.cfg, { refresh: true });
    assert.equal(fsIndex.files.some((file) => file.includes('收藏')), false, '複本不該進 locate／曲庫總覽用的檔案索引');
});

test('favorites: 站點快照壞掉不影響面板愛心', async () => {
    const a = song('so_a', 'Alpha');
    const f = fixture([a]);
    const aMp3 = f.write('成品MP3/Alpha.mp3', mp3(1));
    recordDownloads(f, [{ taskId: 'so_a', files: { mp3: aMp3 } }]);
    fs.writeFileSync(path.join(f.stateDir, 'site-likes.json'), '{not json');
    f.json(path.join(f.stateDir, 'page-favorites.json'), { savedAt: 1, favorites: [{ task_id: 'so_a', title: 'Alpha', at: 1 }] });
    const targets = await readFavoriteTargets(f.cfg);
    assert.equal(targets.site.present, false);
    assert.equal(targets.panel.present, true);
    const result = await collectFavorites({ cfg: f.cfg });
    assert.equal(result.total, 1);
    assert.equal(result.copied, 1);
});
