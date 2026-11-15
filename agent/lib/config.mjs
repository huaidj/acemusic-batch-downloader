// config.mjs — 路徑、環境變數與檔案工具
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

export function config() {
    const stateDir = process.env.ACE_STATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AceMusicDL');
    const downloadDir = process.env.ACE_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads');
    const baseUrl = (process.env.ACE_BASE_URL || 'https://acemusic.ai').replace(/\/+$/, '');
    return {
        stateDir,
        downloadDir,
        baseUrl,
        ua: process.env.ACE_UA || DEFAULT_UA,
        sessionFile: path.join(stateDir, 'session.json'),
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
    await fsp.rename(tmp, file);
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

export function writeJson(file, value) {
    // 序列化寫入，避免多個並行 worker 同時寫同一個 state 檔造成 race
    writeChain = writeChain.then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
        await fsp.rename(tmp, file);
    });
    return writeChain;
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

export async function appendLog(line) {
    const cfg = config();
    try {
        await fsp.mkdir(cfg.stateDir, { recursive: true });
        const stamp = new Date().toISOString();
        await fsp.appendFile(cfg.logFile, `${stamp} ${line}\n`, 'utf8');
    } catch {
        /* ignore */
    }
}
