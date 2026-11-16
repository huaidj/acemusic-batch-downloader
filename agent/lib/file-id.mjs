// Stable physical identity, shared by filesystem mutations and the local player index.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const integer = (value) => {
    try {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
        return BigInt(value);
    } catch { return null; }
};
export const legacyPathFileId = (absolutePath) => 'audio_' + digest(path.resolve(absolutePath).toLowerCase());
export function physicalFileKey(stat, absolutePath) {
    const dev = integer(stat?.dev), ino = integer(stat?.ino);
    return dev !== null && ino !== null && dev !== 0n && ino !== 0n
        ? 'inode-v1:' + dev.toString() + ':' + ino.toString()
        : 'path-v1:' + path.resolve(absolutePath).toLowerCase();
}
export function fileIdFromStat(stat, absolutePath) {
    const key = physicalFileKey(stat, absolutePath);
    return key.startsWith('path-v1:') ? legacyPathFileId(absolutePath) : 'audio_' + digest(key);
}
export async function fileIdForPath(absolutePath) {
    const stat = await fsp.lstat(absolutePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('File identity requires a regular file.'), { code: 'FILE_NOT_REGULAR' });
    return fileIdFromStat(stat, absolutePath);
}
