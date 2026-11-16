// site-likes.mjs — ACE 網頁原生「拇指向上」點讚的唯讀快照。
//
// 來源：站點 /api/songs 每首歌的 meta.rating；站點前端以 "good" 表示 liked、"bad" 表示 disliked，
// 其他值（缺少、null）為未評分。這裡只讀，不會送出任何讚／倒讚。
//
// 完整性規則：所有分頁都成功、游標沒有重複、沒有碰到頁數上限，才替換 likes。
// 任一頁失敗時保留上一次成功的 likes，只更新 lastAttempt；絕不以空陣列覆蓋既有點讚。
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJson } from './config.mjs';

export const SITE_LIKES_FILE = 'site-likes.json';
export const SITE_LIKES_SCHEMA = 'ace_site_likes_v1';
export const SITE_LIKES_SOURCE = 'acemusic.ai /api/songs meta.rating === "good"';
const MAX_LIKES = 20000;

export function siteLikesFile(cfg) {
    return path.join(cfg.stateDir, SITE_LIKES_FILE);
}

/** 站點前端的語意：good → liked、bad → disliked、其他 → unrated。 */
export function siteRating(song) {
    const rating = song && song.meta ? song.meta.rating : undefined;
    return rating === 'good' ? 'liked' : rating === 'bad' ? 'disliked' : 'unrated';
}

function failure(code, message, extra = {}) {
    return Object.assign(new Error(message), { code, ...extra });
}

function likeEntry(song) {
    const title = typeof song.meta?.title === 'string' ? song.meta.title.slice(0, 300) : '';
    return {
        task_id: song.task_id,
        title,
        model: typeof song.model === 'string' ? song.model : null,
        created_at: Number.isFinite(Number(song.created_at)) ? Number(song.created_at) : null,
    };
}

/**
 * 走完所有分頁收集點讚。fetchPage(after) 必須回傳 { status, data }；
 * 任何非 200、格式錯誤、游標重複或頁數上限都會丟出錯誤（呼叫者據此保留舊快照）。
 */
export async function collectSiteLikes(fetchPage, { maxPages = 200 } = {}) {
    if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
    const likes = new Map();
    const seen = new Set();
    const cursors = new Set();
    let after = '';
    let pages = 0;
    let disliked = 0;
    for (;;) {
        if (pages >= maxPages) throw failure('PAGE_LIMIT', `站點歌單超過 ${maxPages} 頁仍未結束，點讚快照視為不完整`, { pages });
        const { status, data } = await fetchPage(after);
        pages += 1;
        if (status === 401 || status === 403) throw failure('AUTH_EXPIRED', `登入已過期（HTTP ${status}），請在擴充功能面板按「同步登入狀態給 Agent」`, { pages });
        if (status !== 200) throw failure('HTTP_ERROR', `站點歌單第 ${pages} 頁讀取失敗（HTTP ${status}）`, { pages, status });
        if (!data || !Array.isArray(data.items)) throw failure('BAD_RESPONSE', `站點歌單第 ${pages} 頁格式不正確`, { pages });
        for (const song of data.items) {
            if (!song || typeof song.task_id !== 'string' || !song.task_id) continue;
            seen.add(song.task_id);
            const rating = siteRating(song);
            if (rating === 'liked') likes.set(song.task_id, likeEntry(song));
            else if (rating === 'disliked') disliked += 1;
        }
        const next = typeof data.next === 'string' ? data.next : '';
        // 空頁但仍有游標時照游標繼續（重複游標與頁數上限會擋住無限循環），不能把它當成清單結束。
        if (!next) break;
        if (cursors.has(next)) throw failure('CURSOR_LOOP', '站點分頁游標重複，點讚快照視為不完整', { pages });
        cursors.add(next);
        after = next;
    }
    if (likes.size > MAX_LIKES) throw failure('TOO_MANY', `網站點讚超過 ${MAX_LIKES} 首上限`, { pages });
    const sorted = [...likes.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || a.task_id.localeCompare(b.task_id));
    return { pages, scanned: seen.size, disliked, likes: sorted };
}

export function likesRevision(likes) {
    const ids = likes.map((item) => item.task_id).sort();
    return crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 24);
}

/** 讀取既有快照；不存在回 null，損毀時丟錯（不自動覆蓋以免抹掉證據）。 */
export async function readSiteLikes(cfg) {
    let text;
    try {
        text = await fsp.readFile(siteLikesFile(cfg), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    let value;
    try { value = JSON.parse(text); } catch { throw failure('SNAPSHOT_UNREADABLE', '網站點讚快照無法解析，原檔已保留'); }
    if (!value || value.schema !== SITE_LIKES_SCHEMA || !Array.isArray(value.likes)) throw failure('SNAPSHOT_UNREADABLE', '網站點讚快照格式不正確，原檔已保留');
    return value;
}

/** 對外摘要：沒有快照時也回一個明確的「尚未同步」狀態，而不是空清單冒充 0 個讚。 */
export function siteLikesView(snapshot) {
    if (!snapshot) return { ok: true, synced: false, complete: false, revision: '', count: 0, likes: [], fetchedAt: null, lastAttempt: null, source: SITE_LIKES_SOURCE };
    return {
        ok: true,
        synced: !!snapshot.fetchedAt,
        complete: snapshot.complete === true,
        revision: snapshot.revision || '',
        count: snapshot.likes.length,
        likes: snapshot.likes,
        fetchedAt: snapshot.fetchedAt || null,
        pages: snapshot.pages ?? null,
        scanned: snapshot.scanned ?? null,
        disliked: snapshot.disliked ?? null,
        lastAttempt: snapshot.lastAttempt || null,
        source: snapshot.source || SITE_LIKES_SOURCE,
    };
}

let syncChain = Promise.resolve();

/**
 * 同步一次：成功才替換 likes；失敗只記 lastAttempt 並保留舊 likes，然後把錯誤回傳在結果中（不丟出）。
 * 同一程序內序列化，避免兩次同步交錯寫檔。
 */
export function syncSiteLikes(cfg, fetchPage, { maxPages = 200, now = () => new Date() } = {}) {
    const task = syncChain.then(async () => {
        const startedAt = now().toISOString();
        let previous = null;
        try { previous = await readSiteLikes(cfg); } catch (err) {
            return { ...siteLikesView(null), ok: false, error: err.message, code: err.code || 'SNAPSHOT_UNREADABLE' };
        }
        try {
            const result = await collectSiteLikes(fetchPage, { maxPages });
            // 站點完全沒回任何歌曲時，不能用它抹掉既有點讚（多半是站點或帳戶切換異常）。
            if (result.scanned === 0 && previous && previous.likes.length) throw failure('EMPTY_LIBRARY', '站點歌單回傳 0 首歌曲，保留上次的網站點讚');
            const snapshot = {
                schema: SITE_LIKES_SCHEMA,
                source: SITE_LIKES_SOURCE,
                complete: true,
                fetchedAt: now().toISOString(),
                pages: result.pages,
                scanned: result.scanned,
                disliked: result.disliked,
                revision: likesRevision(result.likes),
                likes: result.likes,
                lastAttempt: { at: startedAt, ok: true },
            };
            await writeJson(siteLikesFile(cfg), snapshot);
            return { ...siteLikesView(snapshot), changed: !previous || previous.revision !== snapshot.revision };
        } catch (err) {
            const lastAttempt = { at: startedAt, ok: false, code: err.code || 'SYNC_FAILED', error: String(err.message || err).slice(0, 300) };
            const kept = previous
                ? { ...previous, lastAttempt }
                : { schema: SITE_LIKES_SCHEMA, source: SITE_LIKES_SOURCE, complete: false, fetchedAt: null, revision: '', likes: [], lastAttempt };
            await writeJson(siteLikesFile(cfg), kept).catch(() => {});
            return { ...siteLikesView(kept), ok: false, code: lastAttempt.code, error: lastAttempt.error, changed: false };
        }
    });
    syncChain = task.catch(() => {});
    return task;
}
