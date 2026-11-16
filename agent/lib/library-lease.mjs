// Cross-process, reentrant lease for mutations of one local music library.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
const identity = (cfg) => path.resolve(cfg.stateDir).toLowerCase();
export const hasLibraryWriteLease = (cfg) => context.getStore()?.key === identity(cfg);

export async function withLibraryWriteLease(cfg, work, { isCancelled = null, maxWaitMs = 15 * 60 * 1000 } = {}) {
  if (hasLibraryWriteLease(cfg)) return work();
  await fs.mkdir(cfg.stateDir, { recursive: true });
  const lockFile = path.join(cfg.stateDir, 'library-write.lock');
  const token = crypto.randomUUID();
  const started = Date.now();
  let handle;
  while (!handle) {
    if (isCancelled?.()) throw Object.assign(new Error('工作已在取得檔案寫權前取消'), { code: 'JOB_CANCELLED' });
    try {
      handle = await fs.open(lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
    } catch (error) {
      if (handle) {
        const owned = await handle.stat();
        await handle.close();
        handle = null;
        const current = await fs.stat(lockFile).catch(() => null);
        if (current?.ino === owned.ino && current?.dev === owned.dev) await fs.unlink(lockFile).catch(() => {});
      }
      if (error.code !== 'EEXIST') throw error;
      try {
        const raw = await fs.readFile(lockFile, 'utf8');
        const owner = JSON.parse(raw);
        let alive = true;
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') {
          try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
          if (!alive && await fs.readFile(lockFile, 'utf8') === raw) { await fs.unlink(lockFile); continue; }
        }
      } catch { /* Unknown or concurrently changing locks are never assumed safe to remove. */ }
      if (Date.now() - started >= maxWaitMs) throw Object.assign(new Error('曲庫仍由另一個工作處理，請稍後重試'), { code: 'LIBRARY_BUSY' });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await context.run({ key: identity(cfg), token }, work);
  } finally {
    await handle.close();
    try {
      const current = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      if (current.token === token && current.pid === process.pid) await fs.unlink(lockFile);
    } catch { /* Do not remove another owner's lock. */ }
  }
}
