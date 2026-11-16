// Content-checked local transfers. No account/session access and no implicit state writes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson } from './config.mjs';
import { fileIdFromStat, fileIdForPath, legacyPathFileId } from './file-id.mjs';

const problem = (code, message) => Object.assign(new Error(message), { code });
const snapshot = (stat) => ({ dev: stat.dev, ino: stat.ino, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs),
    mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() });
const pathStat = async (file) => snapshot(await fsp.lstat(file, { bigint: true }));
const handleStat = async (handle) => snapshot(await handle.stat({ bigint: true }));
const sameSnapshot = (a, b, ignoreCtime = false) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.mtimeNs === b.mtimeNs && (ignoreCtime || (a.ctimeMs === b.ctimeMs && a.ctimeNs === b.ctimeNs));
const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const keyOf = (file) => path.resolve(file).toLowerCase();

async function hashHandle(handle) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
}

export async function sameFileContent(a, b) {
    let left, right;
    try {
        const [beforeA, beforeB] = await Promise.all([pathStat(a), pathStat(b)]);
        if (beforeA.isSymbolicLink() || beforeB.isSymbolicLink()) throw problem('FILE_SYMLINK', 'Symbolic links are not supported.');
        if (!beforeA.isFile() || !beforeB.isFile() || beforeA.size !== beforeB.size) return false;
        [left, right] = await Promise.all([fsp.open(a, 'r'), fsp.open(b, 'r')]);
        const [openedA, openedB] = await Promise.all([handleStat(left), handleStat(right)]);
        if (!sameSnapshot(beforeA, openedA) || !sameSnapshot(beforeB, openedB)) return false;
        const hashA = await hashHandle(left);
        const sameInode = openedA.dev !== 0n && openedA.ino !== 0n && openedA.dev === openedB.dev && openedA.ino === openedB.ino;
        const hashB = sameInode ? hashA : await hashHandle(right);
        const [afterA, afterB, pathA, pathB] = await Promise.all([handleStat(left), handleStat(right), pathStat(a), pathStat(b)]);
        return hashA === hashB && !pathA.isSymbolicLink() && !pathB.isSymbolicLink() && sameSnapshot(openedA, afterA) && sameSnapshot(openedB, afterB) && sameSnapshot(afterA, pathA) && sameSnapshot(afterB, pathB);
    } catch (error) {
        if (error.code === 'FILE_SYMLINK') throw error;
        return false;
    } finally {
        await Promise.all([left?.close(), right?.close()]);
    }
}

async function safePath(root, requested, { required = false } = {}) {
    const base = path.resolve(root), full = path.resolve(requested);
    if (!within(base, full)) throw problem('FILE_OUTSIDE_ROOT', 'File operation is outside its configured root.');
    const components = [base];
    let current = base;
    for (const component of path.relative(base, full).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        components.push(current);
    }
    for (const item of components) {
        try {
            const stat = await fsp.lstat(item);
            if (stat.isSymbolicLink()) throw problem('FILE_SYMLINK', 'Symbolic links are not supported.');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (required) throw error;
            break;
        }
    }
    return full;
}

async function exists(file) { try { await fsp.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
const nextName = (file, number) => path.join(path.dirname(file), path.basename(file, path.extname(file)) + ' (' + number + ')' + path.extname(file));

async function archiveFile(cfg, source, reason, archiveOptions = {}) {
    const from = await safePath(cfg.downloadDir, source, { required: true });
    const stat = await pathStat(from);
    const stateRoot = path.resolve(cfg.stateDir);
    const archiveRoot = path.join(stateRoot, 'organize-backups');
    await safePath(stateRoot, archiveRoot);
    const prefix = archiveOptions.prefix === 'audit-damaged' ? 'audit-damaged' : 'file-ops';
    const batch = prefix + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
    const target = await safePath(stateRoot, path.join(archiveRoot, batch, path.relative(path.resolve(cfg.downloadDir), from)));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await safePath(stateRoot, target);
    if (!sameSnapshot(stat, await pathStat(from))) throw problem('SOURCE_CHANGED', 'Source changed before archival.');
    try {
        await fsp.rename(from, target);
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fsp.copyFile(from, target, fs.constants.COPYFILE_EXCL);
        if (!await sameFileContent(from, target) || !sameSnapshot(stat, await pathStat(from))) throw problem('SOURCE_CHANGED', 'Archive copy was not verified; source was preserved.');
        await fsp.unlink(from);
    }
    const archived = await fsp.open(target, 'r');
    let sha256;
    try {
        const before = await handleStat(archived);
        sha256 = await hashHandle(archived);
        if (!sameSnapshot(before, await handleStat(archived))) throw problem('ARCHIVE_CHANGED', 'Archived file changed while its hash was recorded.');
    } finally { await archived.close(); }
    await writeJson(path.join(archiveRoot, batch, '_operation.json'), {
        schema: 'ace-file-operation-backup-v1', at: new Date().toISOString(),
        reason: String(reason || 'file_operation').slice(0, 120), from, backup: target, bytes: stat.size, sha256,
        owner: { tool: 'ACE Music local file operations', pid: process.pid },
        retention: archiveOptions.retention || 'Retain for rollback; removal follows the user-authorized backup cleanup policy.',
    });
    return target;
}

async function transfer(cfg, requestedFrom, requestedTo, { conflict = 'unique', reason = 'file_operation' } = {}, move) {
    if (!['skip', 'unique', 'overwrite'].includes(conflict)) throw problem('INVALID_CONFLICT', 'Unsupported conflict policy.');
    const from = await safePath(cfg.downloadDir, requestedFrom, { required: true });
    const desired = await safePath(cfg.downloadDir, requestedTo);
    const initial = await pathStat(from);
    const fromFileId = fileIdFromStat(initial, from);
    if (!initial.isFile()) throw problem('FILE_NOT_REGULAR', 'Source must be a regular file.');
    const audioExtensions = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.aif', '.aiff', '.aifc']);
    const fromExt = path.extname(from).toLowerCase(), toExt = path.extname(desired).toLowerCase();
    if (audioExtensions.has(fromExt) && audioExtensions.has(toExt) && fromExt !== toExt) throw problem('FILE_FORMAT_MISMATCH', 'Moving or copying cannot convert an audio file format.');
    if (keyOf(from) === keyOf(desired)) return { from, to: desired, fromFileId, toFileId: fromFileId, moved: false, copied: false, deduped: false, skipped: true };
    await fsp.mkdir(path.dirname(desired), { recursive: true });
    let target = desired, backup = null;
    for (let number = 2; ; number++) {
        await safePath(cfg.downloadDir, target);
        if (await exists(target)) {
            const sameExtension = path.extname(from).toLowerCase() === path.extname(target).toLowerCase();
            if (sameExtension && await sameFileContent(from, target)) {
                if (!sameSnapshot(initial, await pathStat(from))) throw problem('SOURCE_CHANGED', 'Source changed during comparison.');
                const toFileId = await fileIdForPath(target);
                if (!move) return { from, to: target, fromFileId, toFileId, contentVerified: true, moved: false, copied: false, deduped: false, skipped: true };
                const archived = await archiveFile(cfg, from, reason + ':identical');
                return { from, to: target, fromFileId, toFileId, contentVerified: true, moved: false, copied: false, deduped: true, skipped: false, backup: archived };
            }
            if (conflict === 'skip') return { from, to: target, fromFileId, toFileId: await fileIdForPath(target), moved: false, copied: false, deduped: false, skipped: true };
            if (conflict === 'overwrite') { backup = await archiveFile(cfg, target, reason + ':overwrite'); }
            else { target = nextName(desired, number); continue; }
        }
        let linked = false;
        try {
            if (move) {
                try { await fsp.link(from, target); linked = true; }
                catch (error) {
                    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(error.code)) throw error;
                    await fsp.copyFile(from, target, fs.constants.COPYFILE_EXCL);
                }
            } else await fsp.copyFile(from, target, fs.constants.COPYFILE_EXCL);
        } catch (error) {
            if (error.code === 'EEXIST' && conflict === 'unique') { target = nextName(desired, number); continue; }
            if (backup) error.backup = backup;
            throw error;
        }
        const unchanged = sameSnapshot(initial, await pathStat(from), linked);
        if (!unchanged || !await sameFileContent(from, target)) {
            const error = problem('SOURCE_CHANGED', 'Transfer was not verified; source was preserved.');
            error.createdPath = target;
            if (backup) error.backup = backup;
            throw error;
        }
        if (move) {
            if (!sameSnapshot(initial, await pathStat(from), linked)) throw problem('SOURCE_CHANGED', 'Source changed before removal and was preserved.');
            await fsp.unlink(from);
        }
        return { from, to: target, fromFileId, toFileId: await fileIdForPath(target), contentVerified: true, moved: !!move, copied: !move, deduped: false, skipped: false, ...(backup ? { backup } : {}) };
    }
}

export function moveFileSafely(cfg, from, to, options = {}) { return transfer(cfg, from, to, options, true); }
export function copyFileSafely(cfg, from, to, options = {}) { return transfer(cfg, from, to, options, false); }
export async function archiveLibraryFile(cfg, source, { reason = 'user_authorized_damaged_audio_archive' } = {}) {
    const backup = await archiveFile(cfg, source, reason, { prefix: 'audit-damaged', retention: 'Retain until explicit user acceptance; do not delete automatically.' });
    return { from: path.resolve(source), backup, archived: true };
}

let relocationWrites = Promise.resolve();
export function recordRelocations(cfg, moves) {
    const operation = relocationWrites.catch(() => {}).then(async () => {
        const effective = (moves || []).filter((move) => move && (move.moved || move.deduped) && move.from && move.to && keyOf(move.from) !== keyOf(move.to));
        if (!effective.length) return { recorded: 0, historyUpdated: 0 };
        for (const move of effective) {
            await safePath(cfg.downloadDir, move.from);
            await safePath(cfg.downloadDir, move.to, { required: true });
        }
        const stateFile = cfg.stateFile || path.join(cfg.stateDir, 'agent-state.json');
        await safePath(cfg.stateDir, stateFile);
        const state = await readJson(stateFile, {});
        const paths = { ...(state.removedPaths || {}) };
        const fileIdAliases = { ...(state.fileIdAliases || {}) };
        for (const move of effective) paths[keyOf(move.from)] = path.resolve(move.to);
        let fileAliasesRecorded = 0;
        for (const move of effective) {
            if (!move.contentVerified || !move.fromFileId || !move.toFileId || await fileIdForPath(move.to) !== move.toFileId) continue;
            for (const oldId of new Set([move.fromFileId, legacyPathFileId(move.from)])) {
                if (oldId === move.toFileId) continue;
                fileIdAliases[oldId] = move.toFileId;
                fileAliasesRecorded++;
            }
        }
        const resolve = (file) => {
            let current = path.resolve(file);
            const seen = new Set();
            for (let i = 0; i < 64; i++) {
                const key = keyOf(current);
                if (seen.has(key) || !paths[key]) break;
                seen.add(key);
                current = path.resolve(paths[key]);
            }
            return current;
        };
        let historyUpdated = 0;
        for (const item of Object.values(state.history || {})) for (const entry of Object.values((item && item.files) || {})) {
            const original = entry.absolute || (entry.path && path.resolve(cfg.downloadDir, String(entry.path).replace(/[\\/]/g, path.sep)));
            if (!original) continue;
            const target = resolve(original);
            if (keyOf(original) === keyOf(target) || !within(path.resolve(cfg.downloadDir), target)) continue;
            entry.absolute = target;
            entry.path = path.relative(cfg.downloadDir, target).split(path.sep).join('/');
            entry.filename = path.basename(target);
            historyUpdated++;
        }
        state.removedPaths = paths;
        state.fileIdAliases = fileIdAliases;
        await writeJson(stateFile, state);
        return { recorded: effective.length, historyUpdated, fileAliasesRecorded };
    });
    relocationWrites = operation;
    return operation;
}
