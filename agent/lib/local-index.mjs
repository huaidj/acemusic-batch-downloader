// One local, source-aware index for download status and playback. Never reads sessions.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, replaceFileAtomic } from './config.mjs';
import { loadShared } from './shared.mjs';
import { inspectAudioFile } from './audio-library.mjs';
import { fileIdFromStat, physicalFileKey, legacyPathFileId } from './file-id.mjs';
import { DEFAULT_FAVORITES_FOLDER } from './favorites.mjs';
import { OUTPUT_FOLDER } from './wav-names.mjs';

const { P } = loadShared();
const AUDIO = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'aif', 'aiff', 'aifc']);
const INDEXED = new Set([...AUDIO, 'mid', 'midi', 'musicxml', 'xml', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
const hashCache = new Map();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const lower = (value) => path.resolve(value).toLowerCase();
const slash = (value) => value.split(path.sep).join('/');
const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function sourceKey(raw, baseUrl) {
    if (!raw) return '';
    try {
        const url = new URL(raw, baseUrl);
        const origin = url.origin === 'https://www.acemusic.ai' ? 'https://acemusic.ai' : url.origin;
        return origin + url.pathname + (/\/api\/songs\/[^/]+\/(?:file|download)$/.test(url.pathname) ? '?kind=' + (url.searchParams.get('kind') || '') : '');
    } catch { return ''; }
}

export const NAMING_JOURNAL = '_命名爐改名紀錄.json';

/** 命名爐改名紀錄 → { 小寫舊絕對路徑: 新絕對路徑 }；只接受曲庫內的相對路徑。 */
export function namingJournalMoves(journal, root) {
    const moves = {};
    if (!journal || journal.schema !== 'ace_naming_journal_v1' || !Array.isArray(journal.entries)) return moves;
    for (const entry of journal.entries) {
        if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string' || !entry.from || !entry.to) continue;
        if ([entry.from, entry.to].some((rel) => rel.split('/').some((part) => !part || part === '.' || part === '..'))) continue;
        const from = path.resolve(root, ...entry.from.split('/')), to = path.resolve(root, ...entry.to.split('/'));
        if (!within(root, from) || !within(root, to) || lower(from) === lower(to)) continue;
        moves[lower(from)] = to;
    }
    return moves;
}

function resolveRecordedPath(file, state, root, byPath) {
    let current = path.resolve(file);
    const seen = new Set(), chain = [];
    for (let i = 0; i < 64; i++) {
        if (!within(root, current)) return { file: null, chain, reason: 'outside_library' };
        const existing = byPath.get(lower(current));
        if (existing) return { file: existing, chain };
        const key = lower(current);
        if (seen.has(key)) return { file: null, chain, reason: 'move_cycle' };
        seen.add(key);
        const next = state.removedPaths && state.removedPaths[key];
        if (!next || typeof next !== 'string') return { file: null, chain, reason: 'missing_path' };
        chain.push({ from: slash(path.relative(root, current)), to: within(root, path.resolve(next)) ? slash(path.relative(root, path.resolve(next))) : '[outside library]' });
        current = path.resolve(next);
    }
    return { file: null, chain, reason: 'move_limit' };
}

async function relocationHash(file) {
    const key = [file.absolutePath, file.bytes, file.mtimeNs, file.ctimeNs, file.inode].join('|');
    if (!hashCache.has(key)) {
        const pending = (async () => { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file.absolutePath)) hash.update(chunk); return hash.digest('hex'); })();
        hashCache.set(key, pending);
        if (hashCache.size > 512) hashCache.delete(hashCache.keys().next().value);
        pending.catch(() => hashCache.delete(key));
    }
    return hashCache.get(key);
}

async function repairProofMetadata(cfg, changes, problems) {
    if (!changes.length) return null;
    const stateDir = path.resolve(cfg.stateDir), file = path.join(stateDir, 'verified-audio.json');
    const lockFile = path.join(stateDir, 'verified-audio.lock');
    const nonce = crypto.randomUUID();
    let lock, temp;
    try {
        lock = await fsp.open(lockFile, 'wx');
        await lock.writeFile(JSON.stringify({ pid: process.pid, nonce, operation: 'repair-local-audio-proof-paths', at: new Date().toISOString() }));
        const original = await fsp.readFile(file);
        const current = JSON.parse(original);
        let repaired = 0;
        for (const change of changes) {
            const entry = (current.files || []).find((item) => item.task_id === change.task_id && item.kind === change.kind && item.sha256 === change.sha256 && item.absolute && lower(item.absolute) === lower(change.previousAbsolute));
            if (!entry) continue; // A newer source verifier owns any entry that changed while we built the index.
            const stat = await fsp.lstat(change.absolute, { bigint: true });
            const checked = await inspectAudioFile(change.absolute);
            if (stat.isSymbolicLink() || Number(stat.size) !== change.bytes || String(stat.mtimeNs) !== change.mtimeNs || String(stat.ctimeNs) !== change.ctimeNs || checked.validity !== 'valid' || checked.format !== change.kind) continue;
            entry.absolute = change.absolute;
            entry.path = slash(path.relative(cfg.downloadDir, change.absolute));
            entry.previousAbsolute = change.previousAbsolute;
            entry.relocatedAt = new Date().toISOString();
            repaired++;
        }
        if (!repaired) return { repaired: 0 };
        const backupDir = path.join(stateDir, 'metadata-backups');
        await fsp.mkdir(backupDir, { recursive: true });
        const backup = path.join(backupDir, 'verified-audio.' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + nonce + '.json');
        await fsp.writeFile(backup, original, { flag: 'wx' });
        current.savedAt = new Date().toISOString();
        temp = path.join(stateDir, 'verified-audio.' + nonce + '.tmp');
        await fsp.writeFile(temp, JSON.stringify(current, null, 2) + '\n', { flag: 'wx' });
        await replaceFileAtomic(temp, file);
        temp = null;
        return { repaired, backup, backupSha256: digest(original) };
    } catch (error) {
        problems.push({ code: error.code === 'EEXIST' ? 'PROOF_REPAIR_LOCKED' : 'PROOF_REPAIR_FAILED', message: error.code === 'EEXIST' ? 'Another verifier holds verified-audio.lock.' : 'Proof metadata was not replaced.' });
        return { repaired: 0, errorCode: error.code || 'PROOF_REPAIR_FAILED' };
    } finally {
        if (temp) await fsp.unlink(temp).catch(() => {});
        if (lock) {
            await lock.close();
            const owner = readJson(lockFile, {});
            if (owner.nonce === nonce) await fsp.unlink(lockFile).catch(() => {});
        }
    }
}

export async function buildLocalDownloadIndex({ cfg = config(), root = 'ai音樂', songs = null, repairProofs = false } = {}) {
    const savedAt = new Date().toISOString(), problems = [];
    const downloadRoot = path.resolve(cfg.downloadDir), libraryRoot = path.resolve(downloadRoot, root);
    if (!within(downloadRoot, libraryRoot)) throw Object.assign(new Error('Library root must remain within the download directory.'), { code: 'INVALID_LIBRARY_ROOT' });
    const state = readJson(cfg.stateFile || path.join(cfg.stateDir, 'agent-state.json'), {});
    // 命名爐改名紀錄：與 removedPaths 同語意的搬移鏈；既有 removedPaths 優先，不覆蓋工具自己的紀錄。
    const namingJournal = readJson(path.join(libraryRoot, NAMING_JOURNAL), null);
    const journalMoves = namingJournalMoves(namingJournal, libraryRoot);
    if (Object.keys(journalMoves).length) state.removedPaths = { ...journalMoves, ...(state.removedPaths || {}) };
    const browserHistory = readJson(cfg.historyFile || path.join(cfg.stateDir, 'history.json'), { items: [] });
    const ownBrowserState = readJson(path.join(cfg.stateDir, 'browser-download-state.json'), { history: {} });
    const pageUnavailable = readJson(path.join(cfg.stateDir, 'page-unavailable.json'), { unavailable: {} });
    const proofs = readJson(path.join(cfg.stateDir, 'verified-audio.json'), { files: [] });
    const manifest = readJson(path.join(libraryRoot, '成品MP3', '_manifest.json'), { items: [] });
    const page = readJson(path.join(cfg.stateDir, 'page-songs.json'), {});
    const cache = songs || Array.isArray(page.songs) ? null : readJson(path.join(cfg.stateDir, 'cache', 'songs.json'), {});
    const rows = songs || page.songs || (cache && (cache.songs || cache.known)) || [];
    const songMap = new Map((Array.isArray(rows) ? rows : []).filter((song) => song && song.task_id).map((song) => [song.task_id, song]));
    const byTask = Object.fromEntries([...songMap].map(([id, song]) => [id, { files: [], downloaded: { mp3: false, wav: false, midi: false, musicxml: false, stems: 0, cover: false }, problems: [], notationRequested: P.notationRequested(song), wavSupported: P.supportsWav(song) }]));
    const rawFiles = [], groups = new Map(), byPath = new Map();
    let rootSafe = true;
    try { if (fs.lstatSync(libraryRoot).isSymbolicLink()) rootSafe = false; } catch { rootSafe = false; }
    const scan = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { problems.push({ code: 'DIRECTORY_UNREADABLE', path: slash(path.relative(libraryRoot, dir)) }); return; }
        for (const entry of entries) {
            const absolutePath = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) { problems.push({ code: 'SYMLINK_SKIPPED', path: slash(path.relative(libraryRoot, absolutePath)) }); continue; }
            if (entry.isDirectory()) {
                // 收藏 與 整理輸出 都是複本資料夾：不進歌曲索引，否則同一首歌會被算兩次
                if (dir === libraryRoot && (entry.name === DEFAULT_FAVORITES_FOLDER || entry.name === OUTPUT_FOLDER)) continue;
                scan(absolutePath); continue;
            }
            const extension = path.extname(entry.name).slice(1).toLowerCase();
            if (!entry.isFile() || !INDEXED.has(extension)) continue;
            try {
                // 掃描只沿非連結的目錄往下（上面已跳過 symlink／junction），根目錄也驗過不是連結，
                // 所以這裡的檔案一定在曲庫內；不再逐檔 realpath（每層路徑都要 stat，曾占建索引 2/3 時間）。
                const stat = fs.lstatSync(absolutePath, { bigint: true });
                if (!stat.isFile() || stat.isSymbolicLink()) continue;
                const file = { absolutePath, path: slash(path.relative(libraryRoot, absolutePath)), name: entry.name, extension, bytes: Number(stat.size), mtimeMs: Number(stat.mtimeNs) / 1e6, ctimeMs: Number(stat.ctimeNs) / 1e6, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), inode: physicalFileKey(stat, absolutePath), physicalId: fileIdFromStat(stat, absolutePath) };
                rawFiles.push(file);
                if (!groups.has(file.inode)) groups.set(file.inode, []);
                groups.get(file.inode).push(file);
            } catch { problems.push({ code: 'FILE_CHANGED_DURING_SCAN', path: slash(path.relative(libraryRoot, absolutePath)) }); }
        }
    };
    if (rootSafe) scan(libraryRoot);
    else problems.push({ code: 'LIBRARY_ROOT_MISSING_OR_SYMLINK' });
    const rankPath = (file) => file.path.startsWith('音頻分類/') ? 3 : /^成品WAV\//.test(file.path) ? 0 : /^成品MP3\//.test(file.path) ? 1 : 2;
    const physicalFiles = [...groups.values()].map((aliases) => {
        const chosen = [...aliases].sort((a, b) => rankPath(a) - rankPath(b) || a.path.localeCompare(b.path))[0];
        const file = { ...chosen, id: chosen.physicalId, aliases: aliases.map((item) => item.path), isAudio: AUDIO.has(chosen.extension), associations: [] };
        for (const alias of aliases) byPath.set(lower(alias.absolutePath), file);
        return file;
    });
    // MP3 檔頭不含長度；用音頻分析快取（同路徑且同大小才採用）補上，避免播放器整排顯示 0:00。
    const analysisCache = readJson(path.join(cfg.stateDir, 'cache', 'audio-analysis.json'), {});
    const analysisItems = (analysisCache && (analysisCache.items || analysisCache.data?.items)) || {};
    const analysedDuration = (file, aliases) => {
        for (const alias of aliases) {
            const item = analysisItems[path.resolve(alias.absolutePath)] || analysisItems[alias.absolutePath];
            if (item && item.ok !== false && Number(item.size) === file.bytes && Number(item.duration) > 0) return Number(item.duration);
        }
        return null;
    };
    const aliasesById = new Map([...groups.values()].map((aliases) => [aliases[0].physicalId, aliases]));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, physicalFiles.length) }, async () => {
        while (cursor < physicalFiles.length) {
            const file = physicalFiles[cursor++];
            const inspected = file.isAudio ? await inspectAudioFile(file.absolutePath) : { validity: file.bytes ? 'unknown' : 'damaged', format: file.extension, bytes: file.bytes, reason: file.bytes ? undefined : 'File is empty' };
            file.validity = inspected.validity;
            file.format = inspected.format;
            file.duration = inspected.duration || (inspected.validity !== 'damaged' ? analysedDuration(file, aliasesById.get(file.id) || []) : null) || null;
            file.inspection = inspected;
        }
    }));

    const refs = new Map(), pathOwners = new Map(), pathClaims = new Map(), pending = [];
    const addRef = (raw, ref) => { const key = sourceKey(raw, cfg.baseUrl); if (!key) return; if (!refs.has(key)) refs.set(key, []); if (!refs.get(key).some((item) => item.taskId === ref.taskId && item.key === ref.key)) refs.get(key).push(ref); };
    const ownedPath = (taskId, absolute) => { const key = lower(absolute); if (!pathOwners.has(key)) pathOwners.set(key, new Set()); pathOwners.get(key).add(taskId); };
    const absoluteOf = (value) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(downloadRoot, String(value).replace(/[\\/]/g, path.sep));
    for (const [taskId, song] of songMap) {
        const ext = String(song.local_audio || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
        const kind = ext === 'wav' ? 'wav' : ext && ext !== 'mp3' ? 'audio' : 'mp3';
        addRef(song.local_audio, { taskId, key: kind, kind });
        addRef(song.local_cover, { taskId, key: 'cover', kind: 'cover' });
        for (const audioKind of ['mp3', 'wav']) {
            addRef(`/data/${taskId}.${audioKind}`, { taskId, key: audioKind, kind: audioKind });
            addRef(`/api/songs/${encodeURIComponent(taskId)}/file?kind=${audioKind}`, { taskId, key: audioKind, kind: audioKind });
        }
        for (const [apiKind, kindName] of [['full', 'midi'], ['midi', 'midi'], ['musicxml', 'musicxml']]) addRef(`/api/songs/${encodeURIComponent(taskId)}/download?kind=${apiKind}`, { taskId, key: kindName, kind: kindName });
        addRef(`/data/${taskId}-parts-dl.mid`, { taskId, key: 'midi', kind: 'midi' });
        addRef(`/data/${taskId}-score.musicxml`, { taskId, key: 'musicxml', kind: 'musicxml' });
        for (const job of Object.values(song.stems || {})) for (const track of job && Array.isArray(job.tracks) ? job.tracks : []) {
            if (track && track.local_audio && !track.empty) addRef(track.local_audio, { taskId, key: 'stem:' + (track.id || digest(sourceKey(track.local_audio, cfg.baseUrl)).slice(0, 16)), kind: 'stems' });
        }
    }
    const claimPath = (ref, absolute) => {
        let current = path.resolve(absolute);
        const seen = new Set();
        let added = false;
        for (let depth = 0; depth < 64; depth++) {
            const key = lower(current);
            if (seen.has(key)) break;
            seen.add(key);
            ownedPath(ref.taskId, current);
            if (!pathClaims.has(key)) pathClaims.set(key, new Map());
            const claimKey = ref.taskId + '|' + ref.key;
            if (!pathClaims.get(key).has(claimKey)) { pathClaims.get(key).set(claimKey, ref); added = true; }
            const next = state.removedPaths && state.removedPaths[key];
            if (typeof next !== 'string' || !next) break;
            current = path.resolve(next);
        }
        return added;
    };
    const queue = (ref, absolute, evidence) => { if (!byTask[ref.taskId] || !absolute) return; claimPath(ref, absolute); pending.push({ ref, absolute, evidence }); };
    for (const item of Array.isArray(browserHistory.items) ? browserHistory.items : []) {
        if (item.state !== 'complete' || !item.filename) continue;
        const matches = [...new Map([...(refs.get(sourceKey(item.url, cfg.baseUrl)) || []), ...(refs.get(sourceKey(item.finalUrl, cfg.baseUrl)) || [])].map((ref) => [ref.taskId + '|' + ref.key, ref])).values()];
        const shared = new Set(matches.map((ref) => ref.taskId)).size > 1;
        for (const ref of matches) queue(ref, absoluteOf(item.filename), { source: 'chrome_history', downloadId: item.id, expectedBytes: item.fileSize, sharedSource: shared });
    }
    const queueTaskHistory = (historyMap, source) => {
        for (const [taskId, history] of Object.entries(historyMap || {})) for (const [key, record] of Object.entries((history && history.files) || {})) {
            const kind = key.startsWith('stem:') ? 'stems' : key;
            if (!['mp3', 'wav', 'midi', 'musicxml', 'cover', 'stems'].includes(kind)) continue;
            const absolute = record && (record.absolute || (record.path && absoluteOf(record.path)));
            if (absolute) queue({ taskId, key, kind }, absolute, { source, expectedBytes: record.bytes || record.size || null });
        }
    };
    queueTaskHistory(state.history, 'agent_history');
    queueTaskHistory(ownBrowserState.history, 'browser-download-state');
    const addProblem = (taskId, code, details = {}) => { const item = { code, ...details }; if (byTask[taskId]) byTask[taskId].problems.push(item); problems.push({ taskId, ...item }); };
    const attach = (ref, file, confidence, evidence) => {
        let validity = file.validity;
        if (Number(evidence.expectedBytes) > 0 && Number(evidence.expectedBytes) !== file.bytes) { validity = 'damaged'; confidence = 'uncertain'; addProblem(ref.taskId, 'RECORDED_SIZE_MISMATCH', { fileId: file.id, kind: ref.kind }); }
        if (evidence.sharedSource) confidence = 'uncertain';
        const association = { ...ref, physical: file, confidence, validity, evidence };
        file.associations.push(association);
        return association;
    };
    for (const item of pending) {
        const resolved = resolveRecordedPath(item.absolute, state, libraryRoot, byPath);
        if (!resolved.file) { addProblem(item.ref.taskId, 'RECORDED_PATH_MISSING', { kind: item.ref.kind, path: within(libraryRoot, item.absolute) ? slash(path.relative(libraryRoot, item.absolute)) : '[outside library]' }); continue; }
        const owners = pathOwners.get(lower(item.absolute));
        attach(item.ref, resolved.file, owners && owners.size === 1 && !item.evidence.sharedSource ? 'recorded' : 'uncertain', { ...item.evidence, moveChain: resolved.chain });
    }
    for (const entry of Array.isArray(manifest.items) ? manifest.items : []) {
        if (!byTask[entry.task_id] || typeof entry.file !== 'string' || path.basename(entry.file) !== entry.file) continue;
        const target = path.join(libraryRoot, '成品MP3', entry.file), resolved = resolveRecordedPath(target, state, libraryRoot, byPath);
        if (!resolved.file) { addProblem(entry.task_id, 'MP3_MANIFEST_TARGET_MISSING', { path: slash(path.relative(libraryRoot, target)) }); continue; }
        let owners = new Set();
        const source = String(entry.source || '');
        if (/^https?:|^\/(?:data|api|uploads?)\//i.test(source)) owners = new Set((refs.get(sourceKey(source, cfg.baseUrl)) || []).filter((ref) => ref.kind === 'mp3').map((ref) => ref.taskId));
        else if (source) owners = pathOwners.get(lower(absoluteOf(source))) || new Set();
        const owns = owners.size === 1 && owners.has(entry.task_id);
        if (!owns) addProblem(entry.task_id, owners.size && !owners.has(entry.task_id) ? 'COPIED_FROM_OTHER_TASK' : 'MP3_SOURCE_UNPROVEN', { fileId: resolved.file.id, sourceTaskIds: [...owners] });
        attach({ taskId: entry.task_id, key: 'mp3', kind: 'mp3' }, resolved.file, owns ? 'recorded' : 'uncertain', { source: 'mp3_manifest', mode: entry.mode || '', expectedBytes: entry.size, moveChain: resolved.chain, sourceTaskIds: [...owners] });
    }

    // Older classifiers did not write removedPaths. Their manifests still record an exact
    // previously-owned source path and an exact destination; titles/song labels are never identity.
    const classificationEntries = [], classificationFingerprint = [];
    const legalComponent = (value) => typeof value === 'string' && !!value && !['.', '..'].includes(value) && value === value.trim()
        && !/[<>:"/\\|?*\u0000-\u001f]/.test(value) && !value.endsWith('.') && path.basename(value) === value;
    const specs = [
        { folder: '封面', kind: 'cover', schema: 'ace_file_category_v1', extensions: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']) },
        { folder: 'MIDI', kind: 'midi', schema: 'ace_file_category_v1', extensions: new Set(['mid', 'midi']) },
        { folder: 'MusicXML', kind: 'musicxml', schema: 'ace_file_category_v1', extensions: new Set(['musicxml', 'xml']) },
        { folder: '採樣包', kind: 'stems', schema: 'ace_samples_manifest_v1', extensions: AUDIO },
    ];
    for (const spec of specs) {
        const folderPath = path.join(libraryRoot, spec.folder), filePath = path.join(folderPath, '_manifest.json');
        try {
            if (!rootSafe || fs.lstatSync(folderPath).isSymbolicLink() || !fs.lstatSync(filePath).isFile() || fs.lstatSync(filePath).isSymbolicLink()) continue;
        } catch { continue; }
        const document = readJson(filePath, null);
        if (!document || document.schema !== spec.schema || !Array.isArray(document.items)) continue;
        for (const entry of document.items) {
            const sources = [...new Set([entry?.source, ...(Array.isArray(entry?.sources) ? entry.sources : [])].filter((source) => typeof source === 'string' && path.isAbsolute(source)))];
            classificationFingerprint.push([spec.folder, entry?.file, entry?.type, entry?.container, entry?.size, sources.sort()]);
            if (!sources.length) continue;
            const extension = path.extname(String(entry.file || '')).slice(1).toLowerCase();
            if (!legalComponent(entry.file) || !spec.extensions.has(extension) || (spec.kind === 'stems' && !legalComponent(entry.type))) {
                problems.push({ code: 'CLASSIFICATION_TARGET_REJECTED', manifest: spec.folder + '/_manifest.json' });
                continue;
            }
            const destinationFolder = spec.kind === 'stems' ? (extension === 'wav' ? '採樣包WAV' : '採樣包') : spec.folder;
            const target = spec.kind === 'stems' ? path.join(libraryRoot, destinationFolder, entry.type, entry.file) : path.join(folderPath, entry.file);
            const physical = within(libraryRoot, target) ? byPath.get(lower(target)) : null;
            if (!physical) continue;
            classificationEntries.push({ spec, entry, sources, target, physical });
        }
    }
    const usedClassification = new Set(), classificationFiles = new Set();
    for (let pass = 0; pass < 8; pass++) {
        let extended = false;
        for (let number = 0; number < classificationEntries.length; number++) {
            const candidate = classificationEntries[number], claims = new Map();
            for (const source of candidate.sources) for (const [key, ref] of pathClaims.get(lower(source)) || []) claims.set(key, ref);
            for (const [claimKey, ref] of claims) {
                if (ref.kind !== candidate.spec.kind) continue;
                const key = number + '|' + claimKey;
                if (usedClassification.has(key)) continue;
                usedClassification.add(key);
                const validSize = Number(candidate.entry.size) > 0 && candidate.physical.bytes === Number(candidate.entry.size);
                const confidence = claims.size === 1 && validSize ? 'recorded' : 'uncertain';
                if (claims.size !== 1) addProblem(ref.taskId, 'CLASSIFICATION_SOURCE_CONFLICT', { fileId: candidate.physical.id, kind: ref.kind });
                attach(ref, candidate.physical, confidence, {
                    source: 'classification_manifest', manifest: candidate.spec.folder + '/_manifest.json',
                    expectedBytes: candidate.entry.size, sourceTaskIds: [...new Set([...claims.values()].map((item) => item.taskId))],
                    moveChain: candidate.sources.filter((source) => pathClaims.get(lower(source))?.has(claimKey)).map((source) => ({
                        from: within(libraryRoot, source) ? slash(path.relative(libraryRoot, source)) : '[outside library]',
                        to: slash(path.relative(libraryRoot, candidate.target)),
                    })),
                });
                classificationFiles.add(candidate.physical);
                if (validSize && claimPath(ref, candidate.target)) extended = true;
            }
        }
        if (!extended) break;
    }
    for (const file of classificationFiles) {
        const claims = new Set(file.associations.filter((item) => ['cover', 'midi', 'musicxml', 'stems'].includes(item.kind)).map((item) => item.taskId + '|' + item.key));
        if (claims.size <= 1) continue;
        for (const item of file.associations.filter((item) => ['cover', 'midi', 'musicxml', 'stems'].includes(item.kind))) {
            if (item.confidence !== 'verified') item.confidence = 'uncertain';
            addProblem(item.taskId, 'CLASSIFICATION_TARGET_SHARED_BY_TASKS', { fileId: file.id, kind: item.kind });
        }
    }

    const proofChanges = [], fileIdAliases = { ...(state.fileIdAliases || {}) };
    for (const file of physicalFiles) for (const alias of file.aliases) {
        const legacyId = legacyPathFileId(path.join(libraryRoot, alias));
        if (legacyId !== file.id) fileIdAliases[legacyId] = file.id;
    }
    for (const entry of Array.isArray(proofs.files) ? proofs.files : []) {
        if (!byTask[entry.task_id] || !entry.absolute || !entry.sha256 || !['mp3', 'wav'].includes(entry.kind)) continue;
        const resolved = resolveRecordedPath(entry.absolute, state, libraryRoot, byPath);
        if (!resolved.file) { addProblem(entry.task_id, 'VERIFIED_PATH_MISSING', { kind: entry.kind }); continue; }
        const file = resolved.file, sameBytes = file.bytes === Number(entry.bytes);
        let matched = false, relocated = resolved.chain.length > 0 || lower(file.absolutePath) !== lower(entry.absolute);
        if (sameBytes) {
            if (relocated || !(file.mtimeMs <= Date.parse(entry.relocatedAt || entry.verifiedAt) + 1000)) {
                try { matched = await relocationHash(file) === entry.sha256; } catch { addProblem(entry.task_id, 'RELOCATION_HASH_UNREADABLE', { fileId: file.id }); }
            } else matched = file.mtimeMs <= Date.parse(entry.relocatedAt || entry.verifiedAt) + 1000;
        }
        if (!matched) { addProblem(entry.task_id, 'VERIFIED_FILE_CHANGED', { fileId: file.id }); attach({ taskId: entry.task_id, key: entry.kind, kind: entry.kind }, file, 'uncertain', { source: 'stale_verified_audio', expectedBytes: entry.bytes }); continue; }
        const properFormat = file.format === entry.kind && file.extension === entry.kind && file.validity === 'valid';
        attach({ taskId: entry.task_id, key: entry.kind, kind: entry.kind }, file, 'verified', { source: 'verified_audio', expectedBytes: entry.bytes, sha256: entry.sha256, relocated, moveChain: resolved.chain });
        for (const previous of [entry.absolute, entry.previousAbsolute, ...resolved.chain.map((move) => path.join(libraryRoot, move.from))]) {
            if (typeof previous === 'string' && within(libraryRoot, path.resolve(previous)) && legacyPathFileId(previous) !== file.id) fileIdAliases[legacyPathFileId(previous)] = file.id;
        }
        if (!properFormat) addProblem(entry.task_id, 'VERIFIED_CONTENT_FORMAT_OR_EXTENSION_MISMATCH', { fileId: file.id, expectedKind: entry.kind, actualFormat: file.format, extension: file.extension });
        if (relocated && properFormat) {
            addProblem(entry.task_id, 'VERIFIED_PATH_RELOCATED', { fileId: file.id });
            proofChanges.push({ task_id: entry.task_id, kind: entry.kind, sha256: entry.sha256, previousAbsolute: entry.absolute, absolute: file.absolutePath, bytes: file.bytes, mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs });
        }
    }
    for (const file of physicalFiles) {
        const full = file.associations.filter((item) => ['mp3', 'wav', 'audio'].includes(item.kind));
        if (new Set(full.map((item) => item.taskId)).size > 1) for (const item of full) {
            if (item.confidence !== 'verified') item.confidence = 'uncertain';
            addProblem(item.taskId, 'PHYSICAL_AUDIO_SHARED_BY_TASKS', { fileId: file.id });
        }
        for (const item of file.associations) {
            const index = byTask[item.taskId];
            index.files.push({ key: item.key, kind: item.kind, absolute: file.absolutePath, path: 'ai音樂' === root ? root + '/' + file.path : slash(path.relative(downloadRoot, file.absolutePath)), bytes: file.bytes, fileId: file.id, confidence: item.confidence, validity: item.validity, format: file.format, evidence: item.evidence });
        }
    }
    const strength = { verified: 3, recorded: 2, uncertain: 1 };
    for (const [taskId, row] of Object.entries(byTask)) {
        const unique = new Map();
        for (const item of row.files) {
            const key = item.key + '|' + item.fileId, previous = unique.get(key);
            if (!previous || (item.validity === 'valid' ? 10 : 0) + strength[item.confidence] > (previous.validity === 'valid' ? 10 : 0) + strength[previous.confidence]) unique.set(key, item);
        }
        row.files = [...unique.values()];
        const usable = (item) => item.confidence !== 'uncertain' && item.validity !== 'damaged' && (!['mp3', 'wav', 'audio', 'stems'].includes(item.kind) || item.validity === 'valid') && (!['mp3', 'wav'].includes(item.kind) || (item.format === item.kind && path.extname(item.absolute).slice(1).toLowerCase() === item.kind));
        for (const kind of ['mp3', 'wav', 'midi', 'musicxml', 'cover']) row.downloaded[kind] = !['midi', 'musicxml'].includes(kind) || row.notationRequested ? row.files.some((item) => item.kind === kind && usable(item)) : false;
        const group = P.pickStemGroup(songMap.get(taskId).stems);
        const expected = new Set((group ? group.tracks : []).map((track) => 'stem:' + track.id));
        row.downloaded.stems = new Set(row.files.filter((item) => item.kind === 'stems' && expected.has(item.key) && usable(item)).map((item) => item.key)).size;
    }
    const metadataRepair = repairProofs ? await repairProofMetadata(cfg, proofChanges, problems) : null;
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const historyFingerprint = (historyMap) => Object.keys(historyMap || {}).sort().map((taskId) => [taskId,
        Object.entries(historyMap[taskId]?.files || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, entry?.absolute || '', entry?.path || '', entry?.at || 0, entry?.bytes || entry?.size || null])]);
    const chromeRecords = (Array.isArray(browserHistory.items) ? browserHistory.items : []).map((entry) => [
        entry.id, entry.state, entry.filename, entry.fileSize, sourceKey(entry.url, cfg.baseUrl), sourceKey(entry.finalUrl, cfg.baseUrl),
    ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const songMetadata = [...songMap.values()].map((song) => ({
        taskId: song.task_id, status: song.status, model: song.model, capability: song.capability,
        title: song.meta?.title || '', localAudio: sourceKey(song.local_audio, cfg.baseUrl),
        localCover: sourceKey(song.local_cover, cfg.baseUrl), duration: song.result?.duration_sec || song.result?.duration || null,
        stems: canonical(song.stems || {}),
    })).sort((a, b) => a.taskId.localeCompare(b.taskId));
    const revision = digest(JSON.stringify({
        rules: 'exact-task-v1.7.5',
        songs: songMetadata, files: physicalFiles.map((file) => [file.id, file.absolutePath, file.bytes, file.mtimeNs, file.validity, file.format, file.duration]),
        proof: (proofs.files || []).map((entry) => [entry.task_id, entry.absolute, entry.sha256]),
        chromeRecords, agentHistory: historyFingerprint(state.history), browserOwnHistory: historyFingerprint(ownBrowserState.history),
        removedPaths: canonical(state.removedPaths || {}), fileIdAliases: canonical(fileIdAliases), unavailable: canonical(P.mergeUnavailable(state.unavailable, pageUnavailable.unavailable)),
        classificationManifests: classificationFingerprint.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    })).slice(0, 24);
    const serializableFiles = physicalFiles.map(({ associations, ...file }) => ({ ...file, associations: associations.map(({ physical, ...item }) => item) }));
    const output = { savedAt, revision, byTask, summary: { songs: songMap.size, physicalFiles: physicalFiles.length, audioFiles: physicalFiles.filter((file) => file.isAudio).length, mp3: Object.values(byTask).filter((row) => row.downloaded.mp3).length, wav: Object.values(byTask).filter((row) => row.downloaded.wav).length, damaged: physicalFiles.filter((file) => file.validity === 'damaged').length, uncertain: Object.values(byTask).filter((row) => row.files.some((file) => file.confidence === 'uncertain')).length, proofPathRepairsAvailable: proofChanges.length, metadataRepair }, problems, physicalFiles: serializableFiles, fileIdAliases, root: libraryRoot };
    Object.defineProperty(output, '_songs', { value: [...songMap.values()], enumerable: false });
    return output;
}

export async function buildAudioLibrary(options = {}) {
    const index = await buildLocalDownloadIndex(options);
    const audio = index.physicalFiles.filter((file) => file.isAudio);
    const files = audio.map((file) => {
        const owners = [...new Set(file.associations.filter((item) => ['mp3', 'wav', 'audio', 'stems'].includes(item.kind)).map((item) => item.taskId))];
        const song = owners.length === 1 ? index._songs.find((song) => song.task_id === owners[0]) : null;
        const stem = file.associations.some((item) => item.kind === 'stems') || /(?:^|\/)(?:Stems|採樣包(?:WAV)?|分軌)(?:\/|$)/i.test(file.path);
        const full = file.associations.some((item) => ['mp3', 'wav', 'audio'].includes(item.kind)) || /^(?:成品MP3|成品WAV|俱樂部版)\//.test(file.path) || /(?:^|\/)完整歌曲\//.test(file.path);
        return { id: file.id, name: file.name, title: song?.meta?.title || path.basename(file.name, path.extname(file.name)), format: file.format, bytes: file.bytes, relativePath: file.path, folder: slash(path.dirname(file.path)), duration: file.duration || (owners.length === 1 && !stem && (song?.result?.duration_sec || song?.result?.duration)) || null, validity: file.validity, kind: stem ? 'stem' : full ? 'full' : 'other', ...(owners.length === 1 ? { songId: owners[0] } : {}) };
    });
    const publicById = new Map(files.map((file) => [file.id, file]));
    const filesById = new Map(audio.map((file) => [file.id, { absolutePath: file.absolutePath, ...publicById.get(file.id) }]));
    const fileAliases = Object.create(null);
    for (const alias of Object.keys(index.fileIdAliases || {})) {
        let current = alias;
        const seen = new Set();
        for (let depth = 0; depth < 64; depth++) {
            if (seen.has(current)) { current = null; break; }
            seen.add(current);
            const next = index.fileIdAliases[current];
            if (typeof next !== 'string' || !next) break;
            if (next === current) break;
            current = next;
            if (depth === 63) current = null;
        }
        if (!current || alias === current || !publicById.has(current)) continue;
        fileAliases[alias] = current;
        filesById.set(alias, filesById.get(current));
    }
    const formatStatus = (song, records, kind) => {
        const selected = records.filter((item) => item.kind === kind);
        const healthy = selected.filter((item) => item.validity === 'valid' && item.format === kind && path.extname(item.absolute).slice(1).toLowerCase() === kind);
        const status = healthy.some((item) => item.confidence === 'verified') ? 'verified' : healthy.some((item) => item.confidence === 'recorded') ? 'recorded' : selected.some((item) => item.validity !== 'damaged') ? 'uncertain' : selected.length ? 'damaged' : kind === 'wav' && !P.supportsWav(song) ? 'unsupported' : kind === 'mp3' && /\.wav$/i.test(String(song.local_audio || '').split(/[?#]/)[0]) ? 'unsupported' : 'missing';
        return { status, count: new Set(selected.map((item) => item.fileId)).size };
    };
    const tracks = index._songs.map((song) => {
        const row = index.byTask[song.task_id], full = row.files.filter((item) => ['mp3', 'wav', 'audio'].includes(item.kind));
        const candidates = [...new Map(full.map((item) => [item.fileId, item])).values()].filter((item) => publicById.has(item.fileId));
        const ranking = (item) => (item.validity === 'valid' ? 0 : 10) + ({ verified: 0, recorded: 1, uncertain: 2 })[item.confidence] + (item.kind === 'mp3' ? 0 : 0.1);
        const preferred = candidates.filter((item) => publicById.get(item.fileId).validity !== 'damaged').sort((a, b) => ranking(a) - ranking(b))[0];
        const stemRecords = row.files.filter((item) => item.kind === 'stems');
        const stemFiles = [...new Set(stemRecords.map((item) => item.fileId))].map((id) => publicById.get(id)).filter(Boolean);
        const group = P.pickStemGroup(song.stems);
        const stemStatus = stemRecords.some((item) => item.validity === 'valid' && item.confidence === 'verified') ? 'verified' : row.downloaded.stems > 0 ? 'recorded' : stemRecords.some((item) => item.validity !== 'damaged') ? 'uncertain' : stemRecords.length ? 'damaged' : group || P.notationRequested(song) ? 'missing' : 'unsupported';
        return { id: song.task_id, songId: song.task_id, title: song.meta?.title || 'Untitled', model: song.model || null, duration: song.result?.duration_sec || song.result?.duration || null, createdAt: Number.isFinite(Number(song.created_at)) ? Number(song.created_at) : null, coverUrl: null, files: candidates.map((item) => ({ ...publicById.get(item.fileId), confidence: item.confidence })), preferredFileId: preferred?.fileId || null, formats: { mp3: formatStatus(song, row.files, 'mp3'), wav: formatStatus(song, row.files, 'wav') }, stems: { status: stemStatus, count: row.downloaded.stems, files: stemFiles }, problems: row.problems };
    });
    return { library: { scannedAt: index.savedAt, revision: index.revision, root: options.root || 'ai音樂', hub: { online: false }, tracks, files, fileAliases, folders: [...new Set(files.map((file) => file.folder))].sort(), summary: { songs: tracks.length, files: files.length, mp3: files.filter((file) => file.format === 'mp3').length, wav: files.filter((file) => file.format === 'wav').length, damaged: files.filter((file) => file.validity === 'damaged').length, uncertain: tracks.filter((track) => ['uncertain', 'missing'].includes(track.formats.mp3.status) || track.formats.wav.status === 'uncertain').length } }, filesById };
}
