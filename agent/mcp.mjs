#!/usr/bin/env node
// mcp.mjs — MCP (Model Context Protocol) stdio server：把 ACE Music 批量下載器接給 agent
// 傳輸：stdio，一行一個 JSON-RPC 訊息（MCP stdio transport）。
import * as ACE from './lib/ace.mjs';
import { config, readJson, exists } from './lib/config.mjs';

const SERVER = { name: 'ace-music-downloader', version: '1.6.2' };
const jobs = new Map();
let jobSeq = 0;
const HUB_URL = process.env.ACE_HUB_URL || 'http://127.0.0.1:8788';
const hubJobs = new Set();
let hubDownUntil = 0;

async function hubCall(pathname, { method = 'GET', body, timeoutMs = 2000 } = {}) {
    if (Date.now() < hubDownUntil) throw new Error('hub recently unavailable');
    try {
        const response = await fetch(HUB_URL + pathname, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || data.ok === false) throw new Error((data && data.error) || 'HTTP ' + response.status);
        return data;
    } catch (err) {
        hubDownUntil = Date.now() + 30000;
        throw err;
    }
}

async function hubWaitJob(jobId, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const data = await hubCall('/jobs/' + encodeURIComponent(jobId), { timeoutMs: 1500 });
        const job = data.job || {};
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('hub job 逾時');
}

const TOOLS = [
    {
        name: 'ace_session_status',
        description: '檢查 ACE Music 登入狀態（擴充功能是否已「同步登入狀態給 Agent」、session 是否有效）。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'ace_overview',
        description: '一次回傳登入狀態＋曲庫統計（走本地快照，通常 <50ms）。agent 開場優先用這個，不要連續呼叫 session_status＋list。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'ace_list_songs',
        description: '列出 ACE Music 已完成的歌曲（含分軌數、MIDI 可用、長度、以及「已下載/部分/未下載」狀態與每種類型進度）。預設回傳精簡欄位（速度快）；需要完整 detail 時傳 compact=false。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '歌名或 task_id 關鍵字（可省略）' },
                limit: { type: 'number', description: '最多回傳幾首（預設 50；0 表示全部）' },
                only_undownloaded: { type: 'boolean', description: '只列出還沒下載完的歌曲（預設 false）' },
                compact: { type: 'boolean', description: '精簡欄位（預設 true；false 回傳完整下載細節）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_warm',
        description: '預熱本地快取（登入狀態／歌單／檔案索引／曲庫快照）。之後的 list/overview 會明顯更快；需要最新站點資料時才加 refresh_session。',
        inputSchema: {
            type: 'object',
            properties: { refresh_session: { type: 'boolean', description: '連站點重新驗證登入（約 1s）' } },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_hub_status',
        description: '檢查本機 Agent Hub（127.0.0.1:8788）是否在跑：版本、pid、快照時間、job 統計。hub 在時其他工具會自動走 hub。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'ace_download',
        description: '批次下載歌曲的分軌/MIDI/MusicXML/MP3/WAV 到「下載/ai音樂/<歌名>/」並自動改名。會回傳 jobId，請用 ace_job_status 查進度。',
        inputSchema: {
            type: 'object',
            properties: {
                song_ids: { type: 'array', items: { type: 'string' }, description: '指定 task_id；省略且 all=true 表示全部歌曲' },
                all: { type: 'boolean', description: '下載所有已完成歌曲' },
                query: { type: 'string', description: '用歌名關鍵字挑歌（與 all 類似但先過濾）' },
                types: {
                    type: 'array',
                    items: { type: 'string', enum: ['stems', 'midi', 'musicxml', 'mp3', 'wav', 'cover'] },
                    description: '要下載的類型（預設 ["stems","midi","cover"]；WAV 僅部分模型支援，如 amusic-v1.1，不支援會自動跳過）',
                },
                root: { type: 'string', description: '最上層資料夾名稱（預設 ai音樂）' },
                force: { type: 'boolean', description: '已下載過的也重新下載' },
                concurrency: { type: 'number', description: '並行下載數 1-6（預設 4）' },
                type_folders: { type: 'boolean', description: '依類型分層（Stems/MIDI/Audio）' },
                dry_run: { type: 'boolean', description: '只回傳下載清單，不實際下載' },
                idempotency_key: { type: 'string', description: '同一 key 重送時 hub 會回同一個 job，避免重複下載（走 hub 時有效）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_job_status',
        description: '查詢 ace_download 的進度與結果。',
        inputSchema: {
            type: 'object',
            properties: { job_id: { type: 'string' } },
            required: ['job_id'],
            additionalProperties: false,
        },
    },
    {
        name: 'ace_job_cancel',
        description: '取消正在執行的下載 job（已完成的檔案保留）。',
        inputSchema: {
            type: 'object',
            properties: { job_id: { type: 'string' } },
            required: ['job_id'],
            additionalProperties: false,
        },
    },
    {
        name: 'ace_organize',
        description: '整理 Downloads 內已下載的 ACE Music 檔案：依歌曲改名並搬到「下載/ai音樂/<歌名>/」。預設只預覽（dry_run=true），確認後再用 commit=true 實際移動。',
        inputSchema: {
            type: 'object',
            properties: {
                dry_run: { type: 'boolean', description: '預設 true（只預覽）' },
                commit: { type: 'boolean', description: 'true 才真的移動（等於 dry_run=false）' },
                root: { type: 'string', description: '最上層資料夾（預設 ai音樂）' },
                type_folders: { type: 'boolean', description: '依類型分層' },
            },
            additionalProperties: false,
        },
    },
];

function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function result(id, value) {
    send({ jsonrpc: '2.0', id, result: value });
}

function errorResult(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textContent(value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

async function callTool(name, args) {
    switch (name) {
        case 'ace_session_status': {
            const status = await ACE.sessionStatus();
            return { ...status, hint: status.authenticated ? '已可下載' : '請在擴充功能面板按「同步登入狀態給 Agent」' };
        }
        case 'ace_overview': {
            try {
                const data = await hubCall('/overview', { timeoutMs: 1200 });
                return { ...data, hub: true };
            } catch {
                const [snapshot, session] = await Promise.all([ACE.getLibrarySnapshot(), ACE.sessionStatus()]);
                return {
                    authenticated: !!session.authenticated,
                    sessionError: session.error || '',
                    counts: snapshot.counts,
                    builtAt: snapshot.builtAt,
                    cached: !!snapshot.cached,
                    ageMs: snapshot.ageMs,
                    hub: false,
                };
            }
        }
        case 'ace_hub_status': {
            try {
                const health = await hubCall('/health', { timeoutMs: 1200 });
                return { connected: true, ...health };
            } catch (err) {
                return { connected: false, error: String((err && err.message) || err), url: HUB_URL };
            }
        }
        case 'ace_warm': {
            try {
                const started = await hubCall('/warm', { method: 'POST', body: { refresh_session: !!args.refresh_session }, timeoutMs: 1500 });
                const job = await hubWaitJob(started.jobId, 20000);
                return { hub: true, ...(job.result || { status: job.status }) };
            } catch {
                return await ACE.warmCaches(undefined, { refreshSession: !!args.refresh_session });
            }
        }
        case 'ace_list_songs': {
            const limit = args.limit === 0 ? 0 : Number(args.limit) || 50;
            const params = new URLSearchParams({ limit: String(limit) });
            if (args.query) params.set('q', String(args.query));
            if (args.only_undownloaded) params.set('undownloaded', '1');
            if (args.compact === false) params.set('compact', '0');
            try {
                const data = await hubCall('/songs?' + params.toString(), { timeoutMs: 1200 });
                return data.songs;
            } catch {
                const snapshot = await ACE.getLibrarySnapshot();
                let rows = snapshot.songs.slice();
                const q = String(args.query || '').toLowerCase();
                if (q) rows = rows.filter((s) => s.title.toLowerCase().includes(q) || s.task_id.includes(q));
                if (args.only_undownloaded) rows = rows.filter((s) => !(s.downloaded && s.downloaded.allDone));
                if (limit > 0) rows = rows.slice(0, limit);
                if (args.compact === false) return rows;
                return rows.map((row) => ({
                    id: row.task_id,
                    title: row.title,
                    stems: row.stems ? row.stems.count : 0,
                    midi: row.midi_available,
                    cover: row.cover,
                    dur: row.duration_sec,
                    dl: row.downloaded ? row.downloaded.have + '/' + row.downloaded.total : null,
                    done: row.downloaded ? row.downloaded.allDone : false,
                }));
            }
        }
        case 'ace_download': {
            let hubStarted = null;
            try {
                const body = {
                    song_ids: args.song_ids,
                    all: !!args.all,
                    query: args.query,
                    types: args.types,
                    root: args.root,
                    type_folders: !!args.type_folders,
                    force: !!args.force,
                    concurrency: args.concurrency,
                    dry_run: !!args.dry_run,
                };
                if (args.idempotency_key) body.idempotency_key = String(args.idempotency_key);
                hubStarted = await hubCall('/download', { method: 'POST', body, timeoutMs: 2500 });
            } catch {
                hubStarted = null;
            }
            if (hubStarted) {
                if (args.dry_run) {
                    const job = await hubWaitJob(hubStarted.jobId, 20000);
                    if (job.status === 'failed') throw new Error(job.error || 'hub dry-run 失敗');
                    return { hub: true, ...job.result };
                }
                hubJobs.add(hubStarted.jobId);
                return { jobId: hubStarted.jobId, status: 'queued', hub: true, hint: '用 ace_job_status 查進度（hub job）' };
            }
            const songs = await ACE.listSongs();
            let picked = songs;
            if (Array.isArray(args.song_ids) && args.song_ids.length) {
                const want = new Set(args.song_ids);
                picked = songs.filter((s) => want.has(s.task_id));
                if (!picked.length) throw new Error('找不到指定的 song_ids');
            } else if (args.query) {
                const q = String(args.query).toLowerCase();
                picked = songs.filter((s) => ((s.meta && s.meta.title) || '').toLowerCase().includes(q));
            } else if (!args.all) {
                throw new Error('請指定 song_ids、query 或 all=true');
            }
            const options = {
                types: Array.isArray(args.types) && args.types.length ? args.types : ['stems', 'midi', 'cover'],
                root: args.root || 'ai音樂',
                force: !!args.force,
                typeFolders: !!args.type_folders,
            };
            if (args.dry_run) {
                const { plan, state } = await ACE.buildPlanForSongs(undefined, picked, options);
                const localSkipped = await ACE.applyLocalSkips(undefined, plan, state);
                const files = [];
                for (const task of plan.tasks) for (const file of task.files) files.push({ song: task.title, skipped: file.skip, path: file.path });
                return { dryRun: true, songs: picked.length, total: plan.total, toDownload: plan.toDownload, skipped: plan.skipped, localSkipped, files };
            }
            const jobId = 'job-' + ++jobSeq;
            const job = {
                id: jobId,
                status: 'running',
                startedAt: new Date().toISOString(),
                options,
                songs: picked.length,
                progress: { done: 0, failed: 0, total: 0, skipped: 0, current: '' },
                cancel: false,
                result: null,
                error: null,
            };
            jobs.set(jobId, job);
            const cfg = config();
            ACE.runDownload({
                songs: picked,
                options,
                concurrency: Number(args.concurrency) || 4,
                onProgress: (p) => {
                    job.progress = p;
                    job.cancelled = job.cancel;
                },
                isCancelled: () => job.cancel,
                cfg,
            })
                .then((res) => {
                    job.status = job.cancel ? 'cancelled' : res.failed ? 'finished-with-errors' : 'completed';
                    job.result = res;
                })
                .catch((err) => {
                    job.status = 'failed';
                    job.error = String((err && err.message) || err);
                });
            return { jobId, status: 'running', songs: picked.length, hint: '用 ace_job_status 查進度' };
        }
        case 'ace_job_status': {
            const jobId = String(args.job_id || '');
            if (hubJobs.has(jobId)) {
                try {
                    const data = await hubCall('/jobs/' + encodeURIComponent(jobId), { timeoutMs: 1500 });
                    return { hub: true, ...data.job };
                } catch (err) {
                    return { hub: true, jobId, status: 'unreachable', error: String((err && err.message) || err) };
                }
            }
            const job = jobs.get(jobId);
            if (!job) throw new Error('找不到 job：' + args.job_id);
            return {
                jobId: job.id,
                status: job.status,
                songs: job.songs,
                progress: job.progress,
                result: job.result,
                error: job.error,
                startedAt: job.startedAt,
            };
        }
        case 'ace_job_cancel': {
            const jobId = String(args.job_id || '');
            if (hubJobs.has(jobId)) {
                try {
                    const data = await hubCall('/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST', timeoutMs: 1500 });
                    return { hub: true, jobId, cancelRequested: true };
                } catch (err) {
                    return { hub: true, jobId, cancelRequested: false, error: String((err && err.message) || err) };
                }
            }
            const job = jobs.get(jobId);
            if (!job) throw new Error('找不到 job：' + args.job_id);
            job.cancel = true;
            return { jobId: job.id, cancelRequested: true };
        }
        case 'ace_organize': {
            const dryRun = args.commit ? false : args.dry_run !== false;
            return ACE.organize({
                dryRun,
                root: args.root || 'ai音樂',
                typeFolders: !!args.type_folders,
                conflict: args.conflict || 'skip',
            });
        }
        default:
            throw new Error('未知工具：' + name);
    }
}

async function handleMessage(message) {
    const { id, method, params } = message;
    if (method === 'initialize') {
        return result(id, {
            protocolVersion: (params && params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: SERVER,
            instructions: 'ACE Music 批量下載器 MCP。先用 ace_session_status 確認登入，再用 ace_list_songs / ace_download 下載，ace_organize 整理舊檔。',
        });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools: TOOLS });
    if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
            const value = await callTool(name, args);
            return result(id, { content: textContent(value), isError: false });
        } catch (err) {
            return result(id, { content: textContent('錯誤：' + ((err && err.message) || err)), isError: true });
        }
    }
    if (method === 'resources/list') return result(id, { resources: [] });
    if (method === 'prompts/list') return result(id, { prompts: [] });
    if (id != null) return errorResult(id, -32601, 'Method not found: ' + method);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
            message = JSON.parse(line);
        } catch (err) {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            continue;
        }
        Promise.resolve()
            .then(() => handleMessage(message))
            .catch((err) => {
                if (message && message.id != null) errorResult(message.id, -32603, String((err && err.message) || err));
            });
    }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`[ace-mcp] ${SERVER.name} v${SERVER.version} ready\n`);












