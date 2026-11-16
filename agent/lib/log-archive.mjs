// log-archive.mjs — 把面板的 download-log.json（只保留最近 200 筆的環狀緩衝）逐筆累積到每日 JSONL。
// 環狀緩衝本身不改；這裡只追加尚未封存的事件，所以舊的大工作明細不會再被洗掉。
// 事件在寫入面板前已去除網址、Cookie、權杖與本機路徑；這裡不重新讀取任何帳戶資料。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const keyOf = (event) => [event.at, event.event, event.taskId || '', event.kind || '', event.filename || '', event.phase || '', event.errorCode || ''].join('|');

let chain = Promise.resolve();

/** 追加新事件；回傳 { appended, files }。同一程序內序列化，重複呼叫不會重複寫入。 */
export function archiveDownloadLog(cfg) {
    const task = chain.then(() => archiveOnce(cfg));
    chain = task.catch(() => {});
    return task;
}

async function archiveOnce(cfg) {
    const source = path.join(cfg.stateDir, 'download-log.json');
    const dir = path.join(cfg.stateDir, 'logs');
    const cursorFile = path.join(dir, 'download-log.cursor.json');
    let snapshot;
    try { snapshot = JSON.parse(await fsp.readFile(source, 'utf8')); } catch { return { appended: 0, files: [] }; }
    const events = Array.isArray(snapshot?.events) ? snapshot.events.filter((event) => event && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))) : [];
    let cursor = { lastAt: '', boundaryKeys: [] };
    try { cursor = { ...cursor, ...JSON.parse(await fsp.readFile(cursorFile, 'utf8')) }; } catch { /* first run */ }
    const boundary = new Set(cursor.boundaryKeys || []);
    const fresh = events.filter((event) => event.at > cursor.lastAt || (event.at === cursor.lastAt && !boundary.has(keyOf(event))));
    if (!fresh.length) return { appended: 0, files: [] };
    await fsp.mkdir(dir, { recursive: true });
    const byDay = new Map();
    for (const event of fresh) {
        const day = event.at.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(JSON.stringify(event));
    }
    const files = [];
    for (const [day, lines] of byDay) {
        const file = path.join(dir, `download-log-${day}.jsonl`);
        await fsp.appendFile(file, lines.join('\n') + '\n', 'utf8');
        files.push(file);
    }
    const lastAt = fresh.reduce((max, event) => (event.at > max ? event.at : max), cursor.lastAt);
    const boundaryKeys = events.filter((event) => event.at === lastAt).map(keyOf);
    const temp = cursorFile + '.' + process.pid + '.tmp';
    await fsp.writeFile(temp, JSON.stringify({ lastAt, boundaryKeys, updatedAt: new Date().toISOString() }));
    await fsp.rename(temp, cursorFile);
    return { appended: fresh.length, files };
}

export function downloadLogArchiveDir(cfg) {
    return path.join(cfg.stateDir, 'logs');
}

export function hasDownloadLog(cfg) {
    return fs.existsSync(path.join(cfg.stateDir, 'download-log.json'));
}
