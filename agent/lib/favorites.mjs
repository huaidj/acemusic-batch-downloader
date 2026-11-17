// favorites.mjs — 把「我點贊／收藏」的歌另外複製成一份無損母帶資料夾（複製，不動原檔）。
//
// 來源：兩份本機快照的聯集
//   * site-likes.json     站點拇指向上（/api/songs 的 meta.rating === 'good'，見 site-likes.mjs）
//   * page-favorites.json 面板播放器的愛心收藏
// 任何一邊標記為喜歡就收；同一首歌（task_id）只複製一份。
//
// 目標（使用者 2026-11-17 指定）：<downloadDir>/<root>/收藏/<歌名>.wav —— 平鋪一層，
// 每首歌一個 WAV 母帶，檔名直接用歌名。不再一首一個子資料夾、不再複製 MP3／分軌／MIDI／
// MusicXML／封面；本站沒有 WAV 的歌（部分模型只出 MP3）不收，計入 noWav。
// 只複製「本機索引裡確實屬於這首歌」的檔案；內容相同就跳過，同名不同內容絕不覆寫（force 才會覆寫，
// 舊檔先歸檔到 organize-backups）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, readJson, writeJson, exists, toWin } from './config.mjs';
import { loadShared } from './shared.mjs';
import { hasLibraryWriteLease, withLibraryWriteLease } from './library-lease.mjs';

const { N } = loadShared();

export const DEFAULT_FAVORITES_FOLDER = '收藏';
export const FAVORITES_MANIFEST = '_收藏清單.json';
export const FAVORITES_SCHEMA = 'ace_favorites_manifest_v2';
export const FAVORITES_KINDS = Object.freeze(['wav']);
const SITE_LIKES_SCHEMA = 'ace_site_likes_v1';
const TITLE_LIMIT = 80;
const KIND_ORDER = { wav: 1, mp3: 0, cover: 2, stems: 3, midi: 4, musicxml: 5, audio: 6 };
const AUDIO_KINDS = new Set(['mp3', 'wav', 'audio', 'stems']);
// 分軌資料夾（採樣包／Stems）裡的音檔不是整首母帶。
const STEMS_PATH = /(^|[\\/])(採樣包|stems?)([\\/]|$)/i;
// 舊版（v1）會複製整首歌的所有檔案到 收藏/<歌名>/；改版後那些檔案要清掉。
const PREVIOUS_SCHEMAS = new Set([FAVORITES_SCHEMA, 'ace_favorites_manifest_v1']);

function usableForCopy(item) {
    if (!item || typeof item.absolute !== 'string' || !item.absolute) return false;
    // 不確定的歸屬（例如從別的 task 複製過來）不進收藏夾：寧可少收，也不收錯歌。
    if (item.confidence === 'uncertain') return false;
    if (item.validity === 'damaged') return false;
    if (AUDIO_KINDS.has(item.kind) && item.validity !== 'valid') return false;
    return true;
}

function legalFileName(value) {
    return typeof value === 'string' && !!value && value === value.trim() && !['.', '..'].includes(value)
        && !/[<>:"/\\|?*\u0000-\u001f]/.test(value) && !value.endsWith('.') && path.basename(value) === value;
}

/**
 * 讀取喜歡的歌（站點點讚 ∪ 面板愛心）。只讀快照，不打網路、不寫檔。
 * 兩邊都缺／壞掉時回空清單，而不是假裝 0 首。
 */
export async function readFavoriteTargets(cfg = config()) {
    const sitePath = path.join(cfg.stateDir, 'site-likes.json');
    const panelPath = path.join(cfg.stateDir, 'page-favorites.json');
    const siteRaw = await readJson(sitePath, null);
    const panelRaw = await readJson(panelPath, null);
    const site = siteRaw && siteRaw.schema === SITE_LIKES_SCHEMA && Array.isArray(siteRaw.likes) ? siteRaw : null;
    const panel = panelRaw && Array.isArray(panelRaw.favorites) ? panelRaw : null;
    const targets = new Map();
    const add = (taskId, title, source, at) => {
        if (typeof taskId !== 'string' || !taskId) return;
        const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 300) : '';
        const entry = targets.get(taskId) || { task_id: taskId, title: cleanTitle, sources: [], at: 0 };
        if (!entry.title && cleanTitle) entry.title = cleanTitle;
        if (!entry.sources.includes(source)) entry.sources.push(source);
        entry.at = Math.max(Number(entry.at) || 0, Number(at) || 0);
        targets.set(taskId, entry);
    };
    if (site) for (const like of site.likes) if (like && like.task_id) add(like.task_id, like.title, 'site', like.created_at);
    if (panel) for (const fav of panel.favorites) if (fav && fav.task_id) add(fav.task_id, fav.title, 'panel', fav.at);
    const list = [...targets.values()].sort((a, b) => (b.at || 0) - (a.at || 0) || a.title.localeCompare(b.title) || a.task_id.localeCompare(b.task_id));
    return {
        targets: list,
        site: {
            present: !!site,
            complete: !!(site && site.complete === true),
            synced: !!(site && site.fetchedAt),
            revision: (site && site.revision) || '',
            fetchedAt: (site && site.fetchedAt) || null,
            count: site ? site.likes.length : 0,
            path: sitePath,
        },
        panel: { present: !!panel, count: panel ? panel.favorites.length : 0, savedAt: panel && panel.savedAt ? new Date(panel.savedAt).toISOString() : null, path: panelPath },
        total: list.length,
    };
}

/** 一首歌只收一個 WAV：verified 優先、再來 recorded，路徑短的同分優先；不收分軌與損壞檔。 */
export function pickFavoriteWav(row) {
    if (!row || !Array.isArray(row.files)) return null;
    const rank = { verified: 0, recorded: 1 };
    const wavs = row.files
        .filter((file) => file && file.kind === 'wav' && usableForCopy(file) && rank[file.confidence] !== undefined)
        // 分軌（採樣包）不是整首母帶；索引正常時它們是 kind=stems，這裡再擋一次標錯的舊資料。
        .filter((file) => !STEMS_PATH.test(String(file.absolute || '')))
        .sort((a, b) => rank[a.confidence] - rank[b.confidence] || String(a.absolute).length - String(b.absolute).length);
    return wavs[0] || null;
}

/** 決定這首歌的檔名（不含副檔名）：沿用上次清單的名字，否則用歌名並避開別首已佔用的名字。 */
function chooseBaseName({ taskId, title, outDir, previousBase, taken }) {
    if (previousBase && legalFileName(previousBase)) return previousBase;
    const base = N.sanitizeComponent(title || '', TITLE_LIMIT) || 'Untitled';
    for (let number = 1; ; number++) {
        const candidate = number === 1 ? base : `${base} (${number})`;
        if (taken.has(candidate.toLowerCase())) continue;
        // 已經存在同名檔案但不是清單裡的（使用者自己的東西）→ 不覆寫，換下一個名字
        if (exists(path.join(outDir, candidate + '.wav'))) continue;
        return candidate;
    }
}

export async function collectFavorites({
    root = 'ai音樂',
    folder = DEFAULT_FAVORITES_FOLDER,
    dryRun = false,
    force = false,
    index = null,
    cfg = config(),
    onProgress = null,
} = {}) {
    if (!dryRun && !hasLibraryWriteLease(cfg)) return withLibraryWriteLease(cfg, () => collectFavorites(...arguments));
    const { copyFileSafely } = await import('./file-ops.mjs');
    const sources = await readFavoriteTargets(cfg);
    const rootDir = path.join(cfg.downloadDir, toWin(root));
    const outDir = path.join(rootDir, folder);
    const manifestPath = path.join(outDir, FAVORITES_MANIFEST);
    const previous = await readJson(manifestPath, null);
    const prevItems = previous && PREVIOUS_SCHEMAS.has(previous.schema) && Array.isArray(previous.items)
        ? previous.items.filter((item) => item && item.task_id)
        : [];
    const report = {
        ok: true,
        dryRun: !!dryRun,
        root,
        folder: outDir,
        manifestPath,
        kinds: [...FAVORITES_KINDS],
        total: sources.total,
        copied: 0,
        skipped: 0,
        renamed: 0,
        refreshed: 0,
        pruned: 0,
        prunedDirs: 0,
        conflicts: 0,
        missing: 0,
        noWav: 0,
        unknown: 0,
        planned: 0,
        plannedBytes: 0,
        bytes: 0,
        failed: [],
        items: [],
        sources: { site: sources.site, panel: sources.panel },
    };
    if (!sources.total) {
        report.finishedAt = new Date().toISOString();
        return report;
    }
    const library = index || (await (await import('./local-index.mjs')).buildLocalDownloadIndex({ cfg, root }));
    const prevByTask = new Map();
    for (const item of prevItems) prevByTask.set(item.task_id, item);
    const taken = new Set();
    for (const item of prevItems) {
        const base = typeof item.file === 'string' ? item.file.replace(/\.wav$/i, '') : (legacyDirBase(item) || '');
        if (base && legalFileName(base)) taken.add(base.toLowerCase());
    }
    let progress = 0;
    for (const target of sources.targets) {
        progress += 1;
        if (typeof onProgress === 'function') {
            try { onProgress({ done: progress, total: sources.total, current: target.title || target.task_id }); } catch { /* ignore */ }
        }
        const title = target.title || '';
        const row = library.byTask ? library.byTask[target.task_id] : null;
        const entry = { task_id: target.task_id, title, sources: target.sources, file: null };
        if (!row) {
            report.unknown += 1;
            entry.state = 'unknown';
            report.items.push(entry);
            continue;
        }
        const wav = pickFavoriteWav(row);
        if (!wav) {
            // 站點只有 MP3／分軌的歌沒有無損母帶可收；留在 成品MP3、已點讚，不算失敗。
            report.noWav += 1;
            entry.state = 'no-wav';
            report.items.push(entry);
            continue;
        }
        const previousItem = prevByTask.get(target.task_id) || null;
        const previousBase = previousItem ? (typeof previousItem.file === 'string' ? previousItem.file.replace(/\.wav$/i, '') : legacyDirBase(previousItem)) : '';
        const base = previousBase && legalFileName(previousBase) ? previousBase : chooseBaseName({ taskId: target.task_id, title, outDir, previousBase, taken });
        taken.add(base.toLowerCase());
        const wanted = base + '.wav';
        entry.file = wanted;
        const source = wav.absolute;
        const record = { name: wanted, kind: 'wav', bytes: wav.bytes || null, fileId: wav.fileId || null, source };
        if (dryRun) {
            const targetPath = path.join(outDir, wanted);
            record.action = exists(targetPath) ? 'keep-or-skip' : 'copy';
            if (!exists(targetPath)) {
                report.planned += 1;
                report.plannedBytes += Number(wav.bytes) || 0;
            }
            entry.files = [record];
            report.items.push(entry);
            continue;
        }
        try {
            await fsp.mkdir(outDir, { recursive: true });
            const to = path.join(outDir, wanted);
            // 歌名變了：把我們自己沒被改過的舊副本改名，不重複複製
            if (previousBase && previousBase !== base && !exists(to)) {
                const prevPath = path.join(outDir, previousBase + '.wav');
                const prevStat = await fsp.stat(prevPath).catch(() => null);
                const ours = !!prevStat && Number(previousItem?.size) === prevStat.size;
                if (prevStat && prevStat.isFile() && ours) {
                    if (await fsp.rename(prevPath, to).then(() => true, () => false)) report.renamed += 1;
                }
            }
            const targetStat = await fsp.stat(to).catch(() => null);
            let conflict = 'unique';
            let refreshed = false;
            if (targetStat) {
                const identical = await copyFileSafely(cfg, source, to, { conflict: 'skip', reason: 'favorites_copy' });
                if (identical.skipped && identical.contentVerified) {
                    record.action = 'unchanged';
                    report.skipped += 1;
                    entry.files = [record];
                    report.items.push(entry);
                    continue;
                }
                // 內容不同：只有「我們放的那一份、大小沒變」或 --force 才覆寫；使用者改過的改用下一個名字
                const ours = Number(previousItem?.size) === targetStat.size;
                conflict = force || ours ? 'overwrite' : 'unique';
                refreshed = conflict === 'overwrite';
            }
            const result = await copyFileSafely(cfg, source, to, { conflict, reason: 'favorites_copy' });
            const written = result.to || to;
            record.name = path.basename(written);
            record.fileId = result.toFileId || record.fileId;
            if (result.copied) {
                const writtenStat = await fsp.stat(written).catch(() => null);
                record.bytes = writtenStat ? Number(writtenStat.size) : Number(record.bytes) || 0;
                record.action = refreshed ? 'refreshed' : 'copied';
                if (refreshed) report.refreshed += 1; else report.copied += 1;
                report.bytes += record.bytes;
            } else if (result.skipped && result.contentVerified) {
                record.action = 'unchanged';
                report.skipped += 1;
            } else if (result.skipped) {
                // 同名但內容不同：使用者的檔案優先，絕不覆寫
                record.action = 'conflict-kept-existing';
                report.conflicts += 1;
            } else {
                record.action = 'skipped';
                report.skipped += 1;
            }
            entry.file = record.name;
            entry.files = [record];
            report.items.push(entry);
        } catch (error) {
            const failure = { task_id: target.task_id, title, file: source, error: String((error && error.message) || error).slice(0, 300) };
            report.failed.push(failure);
            entry.files = [{ ...record, action: 'failed', error: failure.error }];
            report.items.push(entry);
        }
    }
    if (!dryRun) {
        // 舊版留下來的 收藏/<歌名>/ 資料夾與其中的 MP3／分軌／MIDI／封面：只刪我們放的、大小沒變的檔，
        // 使用者自己改過或自己放的一律保留；資料夾空了才移除。
        for (const item of prevItems) {
            const dirName = typeof item.dir === 'string' ? item.dir : '';
            if (!legalFileName(dirName)) continue;
            const dirPath = path.join(outDir, dirName);
            if (!exists(dirPath)) continue;
            for (const file of Array.isArray(item.files) ? item.files : []) {
                const name = file && typeof file.name === 'string' ? path.basename(file.name) : '';
                if (!name) continue;
                const target = path.join(dirPath, name);
                const st = await fsp.stat(target).catch(() => null);
                if (!st || !st.isFile()) continue;
                if (file.bytes && Number(file.bytes) !== st.size) continue;
                if (await fsp.unlink(target).then(() => true, () => false)) report.pruned += 1;
            }
            const left = await fsp.readdir(dirPath).catch(() => null);
            if (Array.isArray(left) && left.length === 0) {
                if (await fsp.rmdir(dirPath).then(() => true, () => false)) report.prunedDirs += 1;
            }
        }
        const nextItems = report.items.filter((item) => item.file).map((item) => ({
            task_id: item.task_id, title: item.title, file: item.file, sources: item.sources,
            size: item.files && item.files[0] ? item.files[0].bytes : null,
            mtimeMs: null,
            at: new Date().toISOString(),
        }));
        // 保留這次沒出現的舊項目：檔名留在清單裡，同名新歌才不會搶走既有檔案。
        const current = new Set(nextItems.map((item) => item.task_id));
        for (const item of prevItems) {
            if (current.has(item.task_id)) continue;
            // v1（一首一資料夾）的舊紀錄已經清掉，不再保留；只留平鋪母帶的紀錄。
            if (typeof item.file !== 'string' || !item.file) continue;
            nextItems.push({ ...item, retained: true });
        }
        await writeJson(manifestPath, {
            schema: FAVORITES_SCHEMA,
            generatedAt: new Date().toISOString(),
            root,
            folder,
            layout: 'flat-wav',
            sources: {
                site: { revision: sources.site.revision, fetchedAt: sources.site.fetchedAt, count: sources.site.count },
                panel: { savedAt: sources.panel.savedAt, count: sources.panel.count },
            },
            total: report.total,
            noWav: report.noWav,
            items: nextItems,
        });
    }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    return report;
}

/** 舊清單（v1）用資料夾名當檔名基礎；新清單（v2）直接用檔名。 */
function legacyDirBase(item) {
    return item && typeof item.dir === 'string' && legalFileName(item.dir) ? item.dir : '';
}
