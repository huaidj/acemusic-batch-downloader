// config.mjs — 路徑、環境變數與檔案工具
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

/**
 * 使用者層級設定檔：<stateDir>/config.json。
 * 只為了讓「下載資料夾」可以指到別的磁碟（例如把曲庫搬到 E:\），
 * 不改動其他使用者的預設行為；讀不到或格式錯誤一律當作沒設定。
 */
export function localSettings(stateDir) {
    try {
        const json = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
        return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
    } catch {
        return {};
    }
}

export function config() {
    const stateDir = process.env.ACE_STATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AceMusicDL');
    const settings = localSettings(stateDir);
    const configured = typeof settings.downloadDir === 'string' && settings.downloadDir.trim() ? settings.downloadDir.trim() : '';
    // 優先序：環境變數 > <stateDir>/config.json 的 downloadDir > 使用者 Downloads
    const downloadDir = process.env.ACE_DOWNLOAD_DIR || configured || path.join(os.homedir(), 'Downloads');
    const baseUrl = (process.env.ACE_BASE_URL || 'https://acemusic.ai').replace(/\/+$/, '');
    return {
        stateDir,
        downloadDir,
        baseUrl,
        ua: process.env.ACE_UA || DEFAULT_UA,
        controlledRun: process.env.ACE_MUSIC_CONTROLLED_RUN === 'true',
        sessionFile: process.env.ACE_SESSION_FILE || path.join(stateDir, 'session.json'),
        historyFile: path.join(stateDir, 'history.json'),
        stateFile: path.join(stateDir, 'agent-state.json'),
        logFile: path.join(stateDir, 'agent.log'),
    };
}

export async function readJson(file, fallback = null) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
        return fallback;
    }
}

export function cacheDir(cfg = config()) {
    return path.join(cfg.stateDir, 'cache');
}

export async function cacheRead(name, { maxAgeMs = Infinity, cfg = config() } = {}) {
    try {
        const data = JSON.parse(await fsp.readFile(path.join(cacheDir(cfg), name + '.json'), 'utf8'));
        if (maxAgeMs !== Infinity && Date.now() - Number(data.cachedAt || 0) > maxAgeMs) return null;
        return data;
    } catch {
        return null;
    }
}

export async function cacheWrite(name, payload, cfg = config()) {
    const dir = cacheDir(cfg);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, name + '.json');
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ cachedAt: Date.now(), ...payload }, null, 2), 'utf8');
    await replaceFileAtomic(tmp, file);
    return file;
}

/** 讀快取並回報新鮮度（不因過期而丟棄，供 stale-while-revalidate 用） */
export async function cachePeek(name, { ttlMs = Infinity, cfg = config() } = {}) {
    try {
        const data = JSON.parse(await fsp.readFile(path.join(cacheDir(cfg), name + '.json'), 'utf8'));
        const ageMs = Date.now() - Number(data.cachedAt || 0);
        return { data, ageMs, fresh: ageMs <= ttlMs, exists: true };
    } catch {
        return { data: null, ageMs: Infinity, fresh: false, exists: false };
    }
}

export function cacheClear(name, cfg = config()) {
    const dir = cacheDir(cfg);
    try {
        if (name) fs.rmSync(path.join(dir, name + '.json'), { force: true });
        else fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

let writeChain = Promise.resolve();

// Windows readers and scanners can briefly deny replacement. Retry only the
// rename of the already-written temp file; never remove the destination first.
export async function replaceFileAtomic(from, to, { rename = fsp.rename } = {}) {
    for (let attempt = 0; ; attempt++) {
        try { return await rename(from, to); }
        catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
            await sleep(Math.min(200, 10 * 2 ** attempt));
        }
    }
}

export function writeJson(file, value) {
    // 序列化寫入，避免多個並行 worker 同時寫同一個 state 檔造成 race
    const task = writeChain.then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
            await fsp.writeFile(tmp, JSON.stringify(value, null, 2), {encoding:'utf8',flag:'wx'});
            await replaceFileAtomic(tmp, file);
        } finally { await fsp.unlink(tmp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    });
    // 呼叫者仍收到這次 I/O 錯誤；內部佇列恢復，不能把之後所有狀態寫入一起毒死。
    writeChain = task.catch(() => {});
    return task;
}

export function exists(file) {
    try {
        fs.accessSync(file);
        return true;
    } catch {
        return false;
    }
}

export function toWin(rel) {
    return rel.split('/').join(path.sep);
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function appendLog(line, cfgArg) {
    const cfg = cfgArg || config();
    try {
        const stateDir = path.resolve(cfg.stateDir);
        const configured = cfg.logFile ? path.resolve(cfg.logFile) : path.join(stateDir, 'agent.log');
        const parent = path.dirname(configured);
        const sameDirectory = process.platform === 'win32' ? parent.toLowerCase() === stateDir.toLowerCase() : parent === stateDir;
        // Spreading config() and overriding stateDir must never retain the old
        // production log target outside that state directory.
        const logFile = sameDirectory ? configured : path.join(stateDir, 'agent.log');
        await fsp.mkdir(stateDir, { recursive: true });
        const stamp = new Date().toISOString();
        await fsp.appendFile(logFile, `${stamp} ${line}\n`, 'utf8');
    } catch {
        /* ignore */
    }
}
