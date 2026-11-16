#!/usr/bin/env node
// mcp.mjs — MCP (Model Context Protocol) stdio server：把 ACE Music 批量下載器接給 agent
// 傳輸：stdio，一行一個 JSON-RPC 訊息（MCP stdio transport）。
import * as ACE from './lib/ace.mjs';
import { randomUUID } from 'node:crypto';
import { config, readJson, exists } from './lib/config.mjs';
import { hubJson, hubRequest, canFallbackHubWrite, HUB_URL } from './lib/hubclient.mjs';
import { MUSIC_CONTRACT, MUSIC_TOOLS, validateMusicInput } from './lib/music-contract.mjs';
import { CREATE_CONTRACT, CREATE_TOOLS } from './lib/create-tools.mjs';

const SERVER = { name: 'ace-music-downloader', version: '1.8.5' };
const jobs = new Map();
let jobSeq = 0;
const hubJobs = new Set();
let hubDownUntil = 0;

async function hubCall(pathname, { method = 'GET', body, timeoutMs = 2000 } = {}) {
    // 讀取可沿用短暫斷線快取；寫入必須親自嘗試連線，不能把舊讀取失敗當作「本次尚未送出」。
    if ((method === 'GET' || method === 'HEAD') && Date.now() < hubDownUntil) throw new Error('hub recently unavailable');
    try {
        const data = await hubJson(pathname, { method, body, timeoutMs });
        hubDownUntil = 0;
        return data;
    } catch (err) {
        // 只有「連不上」才暫停 30 秒走本地；Hub 回的業務錯誤（例如登入過期）不算 Hub 掛掉
        if (/ECONNREFUSED|ECONNRESET|HUB_TIMEOUT|hub timeout|EHOSTUNREACH/i.test(String((err && (err.code || err.message)) || ''))) hubDownUntil = Date.now() + 30000;
        throw err;
    }
}

function hubWriteFailure(error, { idempotencyKey, jobId } = {}) {
    if (error?.hubResponseReceived && error.status >= 400 && error.status < 500 && error.status !== 408) {
        if (idempotencyKey) error.idempotencyKey = idempotencyKey;
        error.submissionStatus = 'rejected';
        return error;
    }
    const keyHint = idempotencyKey ? ` idempotency_key=${idempotencyKey}。` : '';
    return Object.assign(new Error(`Hub 提交狀態待查，禁止自動重送或改走本機；先檢查 Hub 工作佇列。${keyHint} ${String(error?.message || error)}`), {
        code: 'HUB_SUBMISSION_UNKNOWN', submissionStatus: 'unknown',
        ...(idempotencyKey ? { idempotencyKey } : {}), ...(jobId || error?.jobId ? { jobId: jobId || error.jobId } : {}),
    });
}

async function tryHubWrite(pathname, options = {}) {
    try {
        const started = await hubCall(pathname, options);
        if (!started?.jobId) throw new Error('Hub 已回應，但未提供工作 ID');
        hubJobs.add(started.jobId);
        return started;
    } catch (error) {
        if (canFallbackHubWrite(error)) return null;
        throw hubWriteFailure(error, { idempotencyKey: options.body?.idempotency_key });
    }
}

async function waitAcceptedHubJob(jobId, timeoutMs) {
    try { return await hubWaitJob(jobId, timeoutMs); }
    catch (error) {
        error.jobId = jobId;
        error.submissionStatus = 'accepted';
        throw error;
    }
}

async function hubWaitJob(jobId, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const data = await hubCall('/jobs/' + encodeURIComponent(jobId), { timeoutMs: 1500 });
        const job = data.job || {};
        if (['done', 'failed', 'cancelled', 'interrupted', 'unresolved'].includes(job.status)) return job;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('hub job 逾時');
}

const TOOLS = [
    ...CREATE_TOOLS,
    ...MUSIC_TOOLS,
    {
        name: 'ace_download_index',
        description: '按歌曲ID、來源及實際檔案核對下載狀態；區分已下載、待核對與缺檔，唯讀且不提交生成。',
        inputSchema: { type: 'object', properties: { root: { type: 'string' }, full: { type: 'boolean' } }, additionalProperties: false },
    },
    {
        name: 'ace_site_likes',
        description: '讀取 ACE 網頁原生「拇指向上」點讚（meta.rating=good）快照；sync=true 時唯讀抓取全部分頁，完整才替換，不修改網站上的讚。與面板心形收藏、播放器本機收藏不同。',
        inputSchema: { type: 'object', properties: { sync: { type: 'boolean' } }, additionalProperties: false },
    },
    {
        name: 'ace_player',
        description: '啟動獨立本機播放器服務並回傳入口；song_id可定位歌曲，不自動播放、不下載或生成。',
        inputSchema: { type: 'object', properties: { song_id: { type: 'string' } }, additionalProperties: false },
    },
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
        name: 'ace_locate',
        description: '歌曲 → 本機真實目錄與檔案絕對路徑（成品MP3/WAV、採樣包、MIDI、MusicXML、封面）。預設回最新製作的一首；也可用 query 或 song_id。走 Hub 記憶體快照、免網路；不含「音頻分類」hardlink 檢視（include_views=true 才帶）。',
        inputSchema: {
            type: 'object',
            properties: {
                latest: { type: 'number', description: '最新的 N 首（預設 1）' },
                query: { type: 'string', description: '歌名關鍵字' },
                song_id: { type: 'string', description: 'task_id' },
                include_views: { type: 'boolean', description: '包含 音頻分類 hardlink 檢視路徑（預設 false）' },
                files: { type: 'boolean', description: '回傳每個檔案路徑（預設 true；false 只回目錄）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_wait_new_song',
        description: '等待下一首「新完成」的歌（站點即時推送 → 面板 → Hub）。wait_download=true 時再等它被自動下載完成並回傳真實路徑。需要開著 acemusic.ai/create 分頁與 Hub。',
        inputSchema: {
            type: 'object',
            properties: {
                timeout_sec: { type: 'number', description: '最長等待秒數（預設 120，上限 1800）' },
                wait_download: { type: 'boolean', description: '等自動下載完成後回傳 locate 結果（預設 false）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_events',
        description: '最近的中樞事件：song_new（新歌完成）、auto_download（開始自動下載）、download_done（下載完成，含完成/失敗數）。用 since（seq）只拿新的。',
        inputSchema: {
            type: 'object',
            properties: {
                since: { type: 'number', description: '只回 seq 大於此值的事件' },
                type: { type: 'string', description: 'song_new / auto_download / download_done' },
                limit: { type: 'number', description: '最多幾筆（預設 50）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_library',
        description: '曲庫分類總覽：成品MP3、成品WAV、採樣包（各樂器）、MIDI、MusicXML、封面、壓縮檔、其他、音頻分類 各自的資料夾路徑與檔案數（sizes=true 另算大小）。',
        inputSchema: {
            type: 'object',
            properties: { sizes: { type: 'boolean', description: '計算大小（較慢）' } },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_favorites',
        description: '面板電臺裡收藏的歌曲清單（新 → 舊）。要拿檔案路徑再用 ace_locate { song_id }。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'ace_collect_favorites',
        description: '把「站點點讚 ∪ 面板愛心」的歌複製到 ai音樂/收藏/<歌名>/（整首歌的檔案：成品 MP3/WAV、分軌、MIDI、MusicXML、封面）。只複製、不動原檔；內容相同跳過，同名不同內容不覆寫（force 才覆寫）。dry_run=true 只回計畫。',
        inputSchema: {
            type: 'object',
            properties: {
                dry_run: { type: 'boolean', description: '只回計畫，不實際複製（預設 false）' },
                force: { type: 'boolean', description: '同名不同內容也覆寫（舊檔先歸檔，預設 false）' },
                root: { type: 'string', description: '最上層資料夾（預設 ai音樂）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_random_prompt',
        description: '隨機提示詞（12×12 風格矩陣，依「音樂模型＋模式」選詞典與字數上限）。回傳文字＋追溯資訊（格子、seed、詞典版本、字數／上限）。目前只有 acemusic-v1.1 有驗證過的詞典；其他模型回 no_dictionary（不硬截斷、不亂填）。只產生文字，不提交生成、不扣 credit。',
        inputSchema: {
            type: 'object',
            properties: {
                model: { type: 'string', description: '音樂模型 id：acemusic-v1.1（預設）、acemusic-v1、ace-step-1.5-xl…' },
                mode: { type: 'string', enum: ['idea', 'custom'], description: 'idea＝自然語言框（上限看模型，v1.1 為 2000）；custom＝Style 框（v1.1 為 1000）。預設 custom' },
                seed: { type: 'number', description: '本地隨機種子；同 seed＋同詞典版本可復現（不保證供應商生成相同音訊）' },
                lock_a: { type: 'string', description: '固定 A 軸格子 id（A01–A12），只變 B 軸' },
                lock_b: { type: 'string', description: '固定 B 軸格子 id（B01–B12），只變 A 軸' },
                count: { type: 'number', description: '一次要幾組（1–24，彼此不同格子；預設 1）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_tidy',
        description: '一鍵整理：成品MP3／成品WAV／採樣包（各樂器）／檔案分類／內容去重／空殼清理／音頻屬性分類（hardlink）。走 Hub job；wait=true 時等完成（最多 timeout_sec）。',
        inputSchema: {
            type: 'object',
            properties: {
                wait: { type: 'boolean', description: '等整理完成再回（預設 false，回 jobId）' },
                timeout_sec: { type: 'number', description: 'wait=true 時最長等待秒數（預設 120）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_backups',
        description: '整理備份（organize-backups）清單與「依規則可刪」預覽（唯讀；實際刪除請使用者用 CLI：backups --prune --commit）。',
        inputSchema: {
            type: 'object',
            properties: {
                keep_days: { type: 'number', description: '超過幾天可刪（預設 7）' },
                keep_last: { type: 'number', description: '至少保留最近幾個（預設 1）' },
                max_mb: { type: 'number', description: '總量上限 MB（超過由舊到新列為可刪）' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_masters',
        description: '母帶清單（俱樂部版／舊版對照）：每個版本的格式、取樣率、位元深度、長度。唯讀；不同版本不是重複。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'ace_probe',
        description: '站點健康（唯讀、不扣額度）：/api/status 是否可連、是否登入、方案、可用模型。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'ace_generate',
        description: '沿用本機登入直接呼叫 ACE Music v1.1 Preview；預設只預覽提示詞與即時費用。實際送出須 dry_run=false、confirm_credit_spend=true、max_credits 與唯一 idempotency_key，且 Hub 必須支援生成；失敗後不可換 key 自動重送。',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                mode: { type: 'string', enum: ['idea', 'custom'], description: '省略時由 prompt 或 style 推斷' },
                model: { type: 'string', enum: ['acemusic-v1.1'], default: 'acemusic-v1.1' },
                prompt: { type: 'string', maxLength: 2000, description: 'Idea 模式描述（不可與 style／lyrics 混用）' },
                style: { type: 'string', maxLength: 1000, description: 'Custom 模式的曲風與聲音方向' },
                lyrics: { type: 'string', maxLength: 5000, description: 'Custom 歌詞；純器樂可留空' },
                title: { type: 'string', maxLength: 80 },
                style_influence: { type: 'number', minimum: 0, maximum: 100 },
                dry_run: { type: 'boolean', default: true, description: '預設 true，不送生成請求、不扣額度' },
                confirm_credit_spend: { type: 'boolean', description: '明確同意消耗站點 Credits 才設 true' },
                max_credits: { type: 'number', minimum: 0, description: '本次允許的最高站點費用；低於即時成本即拒絕' },
                idempotency_key: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: '一次生成固定使用同一 key；逾時亦不可自動換 key' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'ace_generation_status',
        description: '以送出結果中的精確 task_ids 查 v1.1 生成狀態、實際模型與音訊連結；唯讀，不以最新歌曲猜測結果。',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
            type: 'object',
            properties: { task_ids: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_-]+$' } } },
            required: ['task_ids'],
            additionalProperties: false,
        },
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
                latest: { type: 'number', description: '最新的 N 首（可與 query 疊加）；例如 latest=1 表示剛做好的那首' },
                types: {
                    type: 'array',
                    items: { type: 'string', enum: ['all', 'stems', 'midi', 'musicxml', 'mp3', 'wav', 'cover'] },
                    description: '要下載的類型（預設全部六種：stems,midi,musicxml,mp3,wav,cover）；MIDI/MusicXML 僅限該歌已要求分軌且獲授權時提交，可能扣 credit；WAV 不支援時跳過。',
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
    const create = CREATE_CONTRACT.find(item => item.name === name);
    if (create) {
        try { const { data } = await hubRequest(create.path, { method: create.method, body: create.method === 'POST' ? args : undefined, timeoutMs: ['preview', 'submit', 'tasks'].includes(create.action) ? 50000 : 5000 }); return data || { ok: false, status: 'unsupported', error: '此 Hub 未支援完整 Create API。' }; }
        catch { return { ok: false, status: 'hub_required', error: '需要完整 Create API 分支的 Hub；不會建立另一個寫入者。' }; }
    }
    const music = MUSIC_CONTRACT.find(item => item.name === name);
    if (music) {
        const error = validateMusicInput(args, music.inputSchema);
        if (error) return { ok: false, status: 'invalid', error };
        const query = music.method === 'GET' ? '?' + new URLSearchParams(Object.entries(args).map(([k,v]) => [k, String(v)])).toString() : '';
        try {
            const { status, data } = await hubRequest(music.path + query, { method: music.method, body: music.method === 'POST' ? args : undefined, timeoutMs: 5000 });
            return data || { ok: false, status: 'unsupported', error: '此 Hub 尚未支援音樂 Agent 準備功能。', http: status };
        } catch {
            return { ok: false, status: 'hub_required', error: '需要此分支的 Hub；未回落為第二個寫入者，請用隔離啟動器。' };
        }
    }
    switch (name) {
        case 'ace_download_index': {
            const options = { root: args.root || 'ai音樂', full: !!args.full };
            try { return await hubCall('/download-index?root=' + encodeURIComponent(options.root) + (options.full ? '&full=1' : ''), { timeoutMs: 30000 }); }
            catch { return ACE.localDownloadIndex(config(), options); }
        }
        case 'ace_site_likes': return args.sync ? ACE.syncSiteLikesFromSite(config()) : ACE.siteLikes(config());
        case 'ace_player': return ACE.startPlayer(config(), { songId: args.song_id || '' });
        case 'ace_session_status': {
            const [status, page] = await Promise.all([ACE.sessionStatus(), ACE.pageChannelStatus()]);
            return { ...status, page, hint: status.authenticated ? '已可下載' : '請在擴充功能面板按「同步登入狀態給 Agent」' };
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
        case 'ace_generate': {
            if (Object.hasOwn(args, 'request_created_at')) throw new Error('request_created_at 是內部收據欄位，不能由工具輸入指定。');
            const dryRun = args.dry_run !== false;
            let capable = false;
            try {
                const caps = await hubCall('/capabilities', { timeoutMs: 2000 });
                capable = Array.isArray(caps.endpoints) && caps.endpoints.some((entry) => entry.method === 'POST' && entry.path === '/generate');
            } catch { /* 唯讀 preflight 失敗可回落預覽；付費送出必須有 Hub */ }
            if (!capable) {
                if (dryRun) return { ...(await ACE.generateSong(undefined, { ...args, dry_run: true })), hub: false };
                throw new Error('Hub 未啟動或尚未支援生成；請先更新並啟動 Hub。未送出站點生成請求。');
            }
            // POST 後沒有本地 fallback；逾時可能已入列，用同 key 查原收據。
            const submitted = await hubCall('/generate', { method: 'POST', body: { ...args, dry_run: dryRun }, timeoutMs: 15000 });
            if (submitted.jobId) hubJobs.add(submitted.jobId);
            return { ...submitted, hub: true };
        }
        case 'ace_generation_status': {
            const query = new URLSearchParams({ task_ids: Array.isArray(args.task_ids) ? args.task_ids.join(',') : '' });
            try {
                return { ...(await hubCall('/generation-status?' + query.toString(), { timeoutMs: 15000 })), hub: true };
            } catch {
                return { ...(await ACE.generationStatus(undefined, { task_ids: args.task_ids })), hub: false };
            }
        }
        case 'ace_warm': {
            const started = await tryHubWrite('/warm', { method: 'POST', body: { refresh_session: !!args.refresh_session }, timeoutMs: 1500 });
            if (!started) return await ACE.warmCaches(undefined, { refreshSession: !!args.refresh_session });
            const job = await waitAcceptedHubJob(started.jobId, 20000);
            return { hub: true, jobId: started.jobId, ...(job.result || { status: job.status }) };
        }
        case 'ace_locate': {
            const params = new URLSearchParams();
            if (args.song_id) params.set('song', String(args.song_id));
            if (args.query) params.set('q', String(args.query));
            if (args.latest) params.set('latest', String(args.latest));
            if (args.include_views) params.set('views', '1');
            let result;
            try {
                result = { ...(await hubCall('/locate?' + params.toString(), { timeoutMs: 3000 })), hub: true };
            } catch {
                result = await ACE.locateSongs(undefined, {
                    songId: args.song_id || '',
                    query: args.query || '',
                    latest: Number(args.latest || 0),
                    includeViews: !!args.include_views,
                });
            }
            if (args.files === false) result.songs = result.songs.map(({ files, ...rest }) => rest);
            return result;
        }
        case 'ace_wait_new_song': {
            const timeoutMs = Math.min(1800, Math.max(1, Number(args.timeout_sec) || 120)) * 1000;
            const deadline = Date.now() + timeoutMs;
            let head;
            try {
                head = await hubCall('/page/events?limit=1', { timeoutMs: 1500 });
            } catch (err) {
                return { ok: false, error: 'Hub 未啟動：先執行 node agent\\cli.mjs hub --background，並開著 acemusic.ai/create 分頁', detail: String((err && err.message) || err) };
            }
            const since = head.lastSeq || 0;
            const got = await hubCall(`/wait?type=song_new&since=${since}&timeout=${timeoutMs}`, { timeoutMs: timeoutMs + 5000 });
            if (!got.event) return { ok: true, timedOut: true };
            const result = { ok: true, timedOut: false, song: got.event };
            if (args.wait_download) {
                const left = Math.max(1000, deadline - Date.now());
                const done = await hubCall(`/wait?type=download_done&task_id=${encodeURIComponent(got.event.task_id)}&since=${got.event.seq}&timeout=${left}`, { timeoutMs: left + 5000 });
                result.download = done.event || null;
                result.downloadTimedOut = !done.event;
                if (done.event) result.locate = await hubCall('/locate?song=' + encodeURIComponent(got.event.task_id), { timeoutMs: 5000 }).catch(() => null);
            }
            return result;
        }
        case 'ace_events': {
            const params = new URLSearchParams();
            if (args.since != null) params.set('since', String(args.since));
            if (args.type) params.set('type', String(args.type));
            if (args.limit) params.set('limit', String(args.limit));
            try {
                return { ...(await hubCall('/page/events?' + params.toString(), { timeoutMs: 1500 })), hub: true };
            } catch {
                // since 是 Hub 的 seq，不能假裝是頁面檔的 at 時間戳（包含 seq=0）。
                if (args.since != null) {
                    const err = new Error('目前無法查詢 Hub 事件序號；since（seq）不能轉成本機 at 時間。請等 Hub 恢復，或省略 since 重新讀取最新本機事件。');
                    err.code = 'EVENT_CURSOR_UNAVAILABLE';
                    throw err;
                }
                const local = await ACE.readPageEvents(undefined, {});
                const filtered = args.type ? local.filter((event) => event.type === args.type) : local;
                const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
                const events = filtered.slice(-limit);
                return { ok: true, hub: false, events, cursor: { kind: 'timestamp', field: 'at', lastAt: events.length ? events[events.length - 1].at : null } };
            }
        }
        case 'ace_library': {
            try {
                return { ...(await hubCall('/library' + (args.sizes ? '?sizes=1' : ''), { timeoutMs: 15000 })), hub: true };
            } catch {
                return await ACE.libraryOverview(undefined, { withSizes: !!args.sizes });
            }
        }
        case 'ace_favorites': {
            try {
                return { ...(await hubCall('/favorites', { timeoutMs: 1500 })), hub: true };
            } catch {
                return await ACE.readFavorites();
            }
        }
        case 'ace_collect_favorites': {
            return await ACE.collectFavorites({
                root: args.root ? String(args.root) : 'ai音樂',
                dryRun: !!args.dry_run,
                force: !!args.force,
            });
        }
        case 'ace_random_prompt': {
            const params = new URLSearchParams();
            for (const [k, v] of [['model', args.model], ['mode', args.mode], ['seed', args.seed], ['lock_a', args.lock_a], ['lock_b', args.lock_b], ['count', args.count]]) if (v != null && v !== '') params.set(k, String(v));
            try {
                const { status, data } = await hubRequest('/prompts/random?' + params.toString(), { timeoutMs: 8000 });
                if (data) return { ...data, hub: true };
            } catch {
                /* 沒有 Hub：本地算 */
            }
            return await ACE.randomPrompt(undefined, { model: args.model, mode: args.mode, seed: args.seed, lockA: args.lock_a, lockB: args.lock_b, count: args.count });
        }
        case 'ace_tidy': {
            const started = await tryHubWrite('/tidy', { method: 'POST', body: {}, timeoutMs: 2500 });
            if (!started) {
                // 沒有 Hub：本地直接跑（會花 10–30 秒）
                const result = await ACE.tidyAll({ cfg: config() });
                return { hub: false, ...result };
            }
            if (!args.wait) return { hub: true, jobId: started.jobId, status: 'queued', hint: '用 ace_job_status 查進度' };
            const job = await waitAcceptedHubJob(started.jobId, Math.min(1800, Number(args.timeout_sec) || 120) * 1000);
            return { hub: true, jobId: started.jobId, status: job.status, result: job.result, error: job.error };
        }
        case 'ace_backups': {
            return await ACE.pruneBackups(undefined, {
                keepDays: args.keep_days != null ? Number(args.keep_days) : 7,
                keepLast: args.keep_last != null ? Number(args.keep_last) : 1,
                maxBytes: args.max_mb ? Number(args.max_mb) * 1048576 : 0,
                commit: false, // MCP 只預覽；刪除留給使用者
            });
        }
        case 'ace_masters': {
            return await ACE.listMasters();
        }
        case 'ace_probe': {
            return await ACE.probeSite();
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
            const idempotencyKey = args.idempotency_key ? String(args.idempotency_key) : 'mcp-download-' + randomUUID();
            const body = {
                    song_ids: args.song_ids,
                    all: !!args.all,
                    query: args.query,
                    latest: args.latest,
                    types: args.types,
                    root: args.root,
                    type_folders: !!args.type_folders,
                    force: !!args.force,
                    concurrency: args.concurrency,
                    dry_run: !!args.dry_run,
                    idempotency_key: idempotencyKey,
                };
            const hubStarted = await tryHubWrite('/download', { method: 'POST', body, timeoutMs: 2500 });
            if (hubStarted) {
                if (args.dry_run) {
                    const job = await waitAcceptedHubJob(hubStarted.jobId, 20000);
                    if (job.status === 'failed') throw new Error(job.error || 'hub dry-run 失敗');
                    return { hub: true, ...job.result };
                }
                hubJobs.add(hubStarted.jobId);
                return { jobId: hubStarted.jobId, status: 'queued', hub: true, idempotency_key: idempotencyKey, hint: '用 ace_job_status 查進度（hub job）' };
            }
            // 與 Hub、CLI 共用選歌／類型規則
            const picked = ACE.selectSongs(await ACE.listSongs(), args);
            if (!picked.length) throw new Error('沒有選到歌：請給 song_ids、query、latest 或 all=true');
            const options = {
                types: ACE.normalizeTypes(args.types),
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
            if (hubJobs.has(jobId) || /^job_[A-Za-z0-9_]+$/.test(jobId)) {
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
            if (hubJobs.has(jobId) || /^job_[A-Za-z0-9_]+$/.test(jobId)) {
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
            instructions: 'HuaiDJ／ACE 本機中樞。創作先讀 music_capabilities；以 music_prompt_compile、music_generation_prepare 審閱後交給 music_generation_submit，長工作短回 job ID，再查 music_job_status／music_events。實際費用依獨立有限伺服器授權；不能由請求旗標擴大。結果未知保留原 key／job，不重送。試聽接受、評分與詞典審閱只能記錄使用者明確回饋。有限 loop 另需 auto_continue 授權；不自動播放。ace_create_* 提供完整原生參數；ace_* 保留下載接入，路徑用 ace_locate。受控設定會阻擋未批准的舊轉譜寫入。',
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
            return result(id, { content: textContent(value), isError: (name?.startsWith('music_') || name?.startsWith('ace_create_')) && value?.ok === false });
        } catch (err) {
            const detail = [
                '錯誤：' + ((err && err.message) || err),
                err?.jobId ? 'job_id=' + err.jobId : '',
                err?.idempotencyKey && !String(err.message).includes('idempotency_key=') ? 'idempotency_key=' + err.idempotencyKey : '',
                err?.submissionStatus ? 'submission_status=' + err.submissionStatus : '',
            ].filter(Boolean).join('\n');
            return result(id, { content: textContent(detail), isError: true });
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














