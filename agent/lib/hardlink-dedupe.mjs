// hardlink-dedupe.mjs — 把複本資料夾裡「內容完全相同」的檔案換成硬連結
//
// 為什麼：收藏／已點讚 都是複製出來的（每份 5~6 GB），但內容跟 成品WAV／成品MP3 一模一樣。
// 同一個磁碟上改用硬連結，外觀、檔名、播放、大小統計全都不變，實際只佔一份。
//
// 安全規則：
//   * 只在同一個磁碟（same drive）做；跨碟或找不到來源就跳過
//   * 先比大小、再比 sha256，完全相同才動手
//   * 已經是硬連結（nlink > 1）的不重複處理
//   * 預設只預覽，--commit 才真的換
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, localSettings } from './config.mjs';

export const DEFAULT_LINK_FOLDERS = ['收藏', '已點讚'];
export const DEFAULT_SOURCE_FOLDERS = ['成品WAV', '成品MP3', '俱樂部版'];

export function hardlinkSettings(cfg = config()) {
    const raw = (localSettings(cfg.stateDir) || {}).hardlinks;
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        enabled: s.enabled !== false,
        folders: Array.isArray(s.folders) && s.folders.length ? s.folders.map(String) : DEFAULT_LINK_FOLDERS,
        sources: Array.isArray(s.sources) && s.sources.length ? s.sources.map(String) : DEFAULT_SOURCE_FOLDERS,
    };
}

async function sha256(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 22 })) hash.update(chunk);
    return hash.digest('hex');
}

function walkAudios(dir) {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { out.push(...walkAudios(full)); continue; }
        if (/\.(wav|mp3|aiff?|flac)$/i.test(entry.name)) out.push(full);
    }
    return out;
}

/** @returns {{ok:boolean,dryRun:boolean,scanned:number,linked:number,alreadyLink:number,noMatch:number,crossVolume:number,bytesSaved:number,failed:Array}} */
export async function hardlinkDedupe({ root, cfg = config(), commit = false } = {}) {
    const s = hardlinkSettings(cfg);
    const rootDir = root || path.join(cfg.downloadDir, 'ai音樂');
    const report = { ok: true, dryRun: !commit, scanned: 0, linked: 0, alreadyLink: 0, noMatch: 0, crossVolume: 0, bytesSaved: 0, failed: [] };
    if (!s.enabled) { report.ok = false; report.error = 'config.json 的 hardlinks.enabled=false'; return report; }

    const bySize = new Map();
    for (const folder of s.sources) {
        for (const file of walkAudios(path.join(rootDir, folder))) {
            let st; try { st = fs.statSync(file); } catch { continue; }
            if (!bySize.has(st.size)) bySize.set(st.size, []);
            bySize.get(st.size).push(file);
        }
    }

    for (const folder of s.folders) {
        const dir = path.join(rootDir, folder);
        for (const file of walkAudios(dir)) {
            report.scanned++;
            let st; try { st = fs.statSync(file); } catch { continue; }
            if (st.nlink > 1) { report.alreadyLink++; continue; }
            const candidates = (bySize.get(st.size) || []).filter((c) => c !== file);
            if (!candidates.length) { report.noMatch++; continue; }
            if (path.parse(candidates[0]).root.toLowerCase() !== path.parse(file).root.toLowerCase()) { report.crossVolume++; continue; }
            let match = null;
            const hash = await sha256(file);
            for (const candidate of candidates) {
                if (await sha256(candidate) === hash) { match = candidate; break; }
            }
            if (!match) { report.noMatch++; continue; }
            if (!commit) { report.linked++; report.bytesSaved += st.size; continue; }
            try {
                fs.unlinkSync(file);
                fs.linkSync(match, file);
                report.linked++;
                report.bytesSaved += st.size;
            } catch (error) {
                report.failed.push({ file: path.relative(rootDir, file), error: String(error.message || error).slice(0, 200) });
            }
        }
    }
    report.ok = report.failed.length === 0;
    return report;
}
