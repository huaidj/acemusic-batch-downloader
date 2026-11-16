// favorites.mjs — 把「我點贊／收藏」的歌另外複製到一個獨立資料夾（複製，不動原檔）。
//
// 來源：兩份本機快照的聯集
//   * site-likes.json     站點拇指向上（/api/songs 的 meta.rating === 'good'，見 site-likes.mjs）
//   * page-favorites.json 面板播放器的愛心收藏
// 任何一邊標記為喜歡就收；同一首歌（task_id）只複製一份。
//
// 目標：<downloadDir>/<root>/<folder>/<歌名>/<原檔名>
// 只複製「本機索引裡確實屬於這首歌」的檔案（成品 MP3／WAV、分軌、MIDI、MusicXML、封面）；
// 內容相同就跳過，同名不同內容絕不覆寫（force 才會覆寫，且舊檔先歸檔到 organize-backups）。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, readJson, writeJson, exists, toWin } from './config.mjs';
import { loadShared } from './shared.mjs';
import { hasLibraryWriteLease, withLibraryWriteLease } from './library-lease.mjs';

const { N } = loadShared();

export const DEFAULT_FAVORITES_FOLDER = '收藏';
export const FAVORITES_MANIFEST = '_收藏清單.json';
export const FAVORITES_SCHEMA = 'ace_favorites_manifest_v1';
const SITE_LIKES_SCHEMA = 'ace_site_likes_v1';
const TITLE_LIMIT = 80;

const KIND_ORDER = { mp3: 0, wav: 1, cover: 2, stems: 3, midi: 4, musicxml: 5, audio: 6 };
const AUDIO_KINDS = new Set(['mp3', 'wav', 'audio', 'stems']);

function usableForCopy(item) {
    if (!item || typeof item.absolute !== 'string' || !item.absolute) return false;
    // 不確定的歸屬（例如從別的 task 複製過來）不進收藏夾：寧可少收，也不收錯歌。
    if (item.confidence === 'uncertain') return false;
    if (item.validity === 'damaged') return false;
    if (AUDIO_KINDS.has(item.kind) && item.validity !== 'valid') return false;
    return true;
}

function legalDirName(value) {
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

/** 決定這首歌在收藏夾裡的資料夾名：沿用上次清單的命名，否則用歌名並避開別的 task 已佔用的名字。 */
function chooseDirName({ taskId, title, outDir, prevItems, taken }) {
    const previous = prevItems.find((item) => item && item.task_id === taskId && legalDirName(item.dir));
    if (previous) return previous.dir;
    const base = N.sanitizeComponent(title || '', TITLE_LIMIT) || 'Untitled';
    for (let number = 1; ; number++) {
        const candidate = number === 1 ? base : `${base} (${number})`;
        if (taken.has(candidate.toLowerCase())) continue;
        // 已經存在同名資料夾但不是清單裡的（使用者自己的東西）→ 不併入，換下一個名字
        if (exists(path.join(outDir, candidate))) continue;
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
    const prevItems = previous && Array.isArray(previous.items) ? previous.items.filter((item) => item && item.task_id) : [];
    const report = {
        ok: true,
        dryRun: !!dryRun,
        root,
        folder: outDir,
        manifestPath,
        total: sources.total,
        copied: 0,
        skipped: 0,
        conflicts: 0,
        missing: 0,
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
    const taken = new Set();
    for (const item of prevItems) if (legalDirName(item.dir)) taken.add(String(item.dir).toLowerCase());
    const outPrefix = outDir.toLowerCase() + path.sep;
    let progress = 0;
    for (const target of sources.targets) {
        progress += 1;
        if (typeof onProgress === 'function') {
            try { onProgress({ done: progress, total: sources.total, current: target.title || target.task_id }); } catch { /* ignore */ }
        }
        const title = target.title || '';
        const row = library.byTask ? library.byTask[target.task_id] : null;
        const entry = { task_id: target.task_id, title, sources: target.sources, dir: null, files: [] };
        if (!row) {
            report.unknown += 1;
            entry.state = 'unknown';
            report.items.push(entry);
            continue;
        }
        const files = [];
        const seen = new Set();
        for (const item of [...(row.files || [])].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || String(a.absolute).localeCompare(String(b.absolute)))) {
            if (!usableForCopy(item)) continue;
            const key = item.fileId || String(item.absolute).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            files.push(item);
        }
        if (!files.length) {
            report.missing += 1;
            entry.state = 'missing';
            report.items.push(entry);
            continue;
        }
        const dirName = chooseDirName({ taskId: target.task_id, title, outDir, prevItems, taken });
        taken.add(dirName.toLowerCase());
        entry.dir = dirName;
        if (!dryRun) await fsp.mkdir(path.join(outDir, dirName), { recursive: true });
        for (const item of files) {
            if (String(item.absolute).toLowerCase().startsWith(outPrefix)) continue;
            const name = path.basename(item.absolute);
            const to = path.join(outDir, dirName, name);
            const record = { name, kind: item.kind, bytes: item.bytes || null, fileId: item.fileId || null, source: item.absolute };
            if (dryRun) {
                const already = exists(to);
                record.action = already ? 'keep-or-skip' : 'copy';
                if (!already) {
                    report.planned += 1;
                    report.plannedBytes += Number(item.bytes) || 0;
                }
                entry.files.push(record);
                continue;
            }
            try {
                const result = await copyFileSafely(cfg, item.absolute, to, { conflict: force ? 'overwrite' : 'skip', reason: 'favorites_copy' });
                record.name = path.basename(result.to || to);
                record.fileId = result.toFileId || record.fileId;
                if (result.copied) {
                    const stat = await fsp.stat(result.to).catch(() => null);
                    const bytes = stat ? Number(stat.size) : Number(record.bytes) || 0;
                    record.bytes = bytes;
                    record.action = 'copied';
                    report.copied += 1;
                    report.bytes += bytes;
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
                entry.files.push(record);
            } catch (error) {
                const failure = { task_id: target.task_id, title, file: item.absolute, error: String((error && error.message) || error).slice(0, 300) };
                report.failed.push(failure);
                entry.files.push({ ...record, action: 'failed', error: failure.error });
            }
        }
        report.items.push(entry);
    }
    if (!dryRun) {
        const nextItems = report.items.filter((item) => item.dir).map((item) => ({
            task_id: item.task_id, title: item.title, dir: item.dir, sources: item.sources,
            files: item.files.map((file) => ({ name: file.name, kind: file.kind, bytes: file.bytes, fileId: file.fileId, source: file.source })),
            at: new Date().toISOString(),
        }));
        // 保留這次沒出現的舊項目：資料夾名字留在清單裡，同名新歌才不會併進別人的資料夾。
        const current = new Set(nextItems.map((item) => item.task_id));
        for (const item of prevItems) {
            if (current.has(item.task_id)) continue;
            nextItems.push({ ...item, retained: true });
        }
        await writeJson(manifestPath, {
            schema: FAVORITES_SCHEMA,
            generatedAt: new Date().toISOString(),
            root,
            folder,
            sources: {
                site: { revision: sources.site.revision, fetchedAt: sources.site.fetchedAt, count: sources.site.count },
                panel: { savedAt: sources.panel.savedAt, count: sources.panel.count },
            },
            total: report.total,
            items: nextItems,
        });
    }
    report.ok = report.failed.length === 0;
    report.finishedAt = new Date().toISOString();
    return report;
}
