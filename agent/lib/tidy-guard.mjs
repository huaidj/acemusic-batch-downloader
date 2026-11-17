// tidy-guard.mjs — 讓「一鍵整理」在被連續觸發時合併成一輪，而不是每個觸發各自跑完整管線。
//
// 實測問題（2026-11-17）：同一次下載完成後 1 分鐘內來了 3 個 tidy-all，靠 library-write 租約排隊，
// 三個都跑完整管線（每個約 5 分鐘），並因此重複產生 (2)…(8) 同名副本。
//
// 契約：
//   * 只有拿到 <state>/tidy-run.lock 的人才跑管線；鎖檔記錄 pid/token/startedAt/root。
//   * 鎖被活著的行程持有時，新的觸發不排隊、不重跑，只寫 <state>/tidy-pending.json（要求時間）。
//   * 跑完的行程看到「這一輪開始之後」才出現的 pending，最多再補跑一輪（避免無限循環）。
//   * 釋放時比對 token，不會刪掉別人的鎖；持有者行程已消失（pid 不存在）視為過期鎖，清掉重取。
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const TIDY_LOCK_FILE = 'tidy-run.lock';
export const TIDY_PENDING_FILE = 'tidy-pending.json';

function pidAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code !== 'ESRCH';
    }
}

async function readOwner(lockFile) {
    try {
        const raw = await fsp.readFile(lockFile, 'utf8');
        const owner = JSON.parse(raw);
        return owner && typeof owner === 'object' ? owner : null;
    } catch {
        return null;
    }
}

/** 讀目前這一輪整理的持有者；行程已經結束的回 null（視同沒有在跑）。 */
export async function peekTidyRun(cfg) {
    const lockFile = path.join(cfg.stateDir, TIDY_LOCK_FILE);
    const owner = await readOwner(lockFile);
    if (!owner) return null;
    if (!pidAlive(Number(owner.pid))) return null;
    return owner;
}

/** 已經有一輪在跑：只登記「結束後再跑一輪」，回傳寫入的內容。 */
export async function markTidyPending(cfg, { root = 'ai音樂', requestedAt = new Date().toISOString() } = {}) {
    const pendingFile = path.join(cfg.stateDir, TIDY_PENDING_FILE);
    await fsp.mkdir(cfg.stateDir, { recursive: true });
    const payload = { requestedAt, root, by: process.pid };
    await fsp.writeFile(pendingFile, JSON.stringify(payload)).catch(() => {});
    return payload;
}

/**
 * 取得整理權。回傳 { acquired: true, token, startedAt, lockFile } 或
 * { acquired: false, coalesced: true, owner, startedAt }（代表已有一輪在跑）。
 */
export async function acquireTidyRun(cfg, { root = 'ai音樂', now = () => new Date().toISOString() } = {}) {
    const lockFile = path.join(cfg.stateDir, TIDY_LOCK_FILE);
    await fsp.mkdir(cfg.stateDir, { recursive: true });
    const token = crypto.randomUUID();
    const startedAt = now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let handle = null;
        try {
            handle = await fsp.open(lockFile, 'wx');
            await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt, root }));
            await handle.close();
            handle = null;
            return { acquired: true, token, startedAt, lockFile, root };
        } catch (error) {
            if (handle) {
                await handle.close().catch(() => {});
                handle = null;
            }
            if (error.code !== 'EEXIST') throw error;
            const owner = await readOwner(lockFile);
            if (owner && pidAlive(Number(owner.pid))) {
                return { acquired: false, coalesced: true, owner, startedAt, lockFile, root };
            }
            // 過期鎖（持有者已結束或鎖檔壞掉）：只清自己看到的那一份
            const again = await readOwner(lockFile);
            if ((again && !pidAlive(Number(again.pid))) || !again) await fsp.rm(lockFile, { force: true }).catch(() => {});
        }
    }
    const owner = await readOwner(lockFile);
    return { acquired: false, coalesced: true, owner, startedAt, lockFile, root };
}

/** 這一輪跑完才呼叫：只有自己持有的鎖才移除。 */
export async function releaseTidyRun(guard) {
    if (!guard || !guard.acquired) return false;
    const owner = await readOwner(guard.lockFile);
    if (owner && owner.token === guard.token) {
        await fsp.rm(guard.lockFile, { force: true }).catch(() => {});
        return true;
    }
    return false;
}

/** 這一輪執行期間有沒有新的觸發進來？有就把 pending 吃掉並回 true（最多補跑一輪）。 */
export async function takePendingTidyRun(guard) {
    if (!guard || !guard.acquired) return false;
    const pendingFile = path.join(path.dirname(guard.lockFile), TIDY_PENDING_FILE);
    const pending = await readOwner(pendingFile);
    if (!pending || typeof pending.requestedAt !== 'string') return false;
    // 這一輪開始前就存在的要求，已經被這一輪涵蓋
    if (pending.requestedAt < guard.startedAt) {
        await fsp.rm(pendingFile, { force: true }).catch(() => {});
        return false;
    }
    await fsp.rm(pendingFile, { force: true }).catch(() => {});
    return true;
}
