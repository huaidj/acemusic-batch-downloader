#!/usr/bin/env node
// cli.mjs — ACE Music 批量下載器 CLI（給 agent / 終端機使用）
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as ACE from './lib/ace.mjs';
import * as Official from './lib/official.mjs';
import { config, readJson, writeJson, exists } from './lib/config.mjs';
import { hubJson, hubRequest } from './lib/hubclient.mjs';
import fs from 'node:fs/promises';
import { MUSIC_CONTRACT, validateMusicInput } from './lib/music-contract.mjs';
import { CREATE_CONTRACT } from './lib/create-tools.mjs';

let hubSkipUntil = 0;

/** 嘗試走 Agent Hub；不可用時 30 秒內直接回落本地（回傳 null） */
async function hubTry(pathname, { method = 'GET', body, timeoutMs = 1200 } = {}) {
    if (Date.now() < hubSkipUntil) return null;
    try {
        return await hubJson(pathname, { method, body, timeoutMs });
    } catch {
        hubSkipUntil = Date.now() + 30000;
        return null;
    }
}
function usage() {
    console.log(`ACE Music 批量下載器 CLI  v1.10.0

用法：
  node cli.mjs create capabilities            Create 頁面完整 API 參數契約
  node cli.mjs create prepare --input file.json  驗證所有參數，不讀登入、不扣費
  node cli.mjs create preview --input file.json  唯讀核對即時模型/報價
  node cli.mjs music capabilities             音樂 Agent 能力與授權狀態（需此分支 Hub）
  node cli.mjs music prompt_compile --input plan.json   從 JSON 產生並保存預覽
  node cli.mjs music state                    本機提示詞、批次與任務
  node cli.mjs music <action> --input file.json  其他操作見 agent/MUSIC-AGENT.md
  node cli.mjs doctor                         檢查登入狀態與環境
  node cli.mjs locate [--latest N|--query 字|--song id] [--views] [--json]  歌曲 → 本機真實目錄（預設最新一首）
  node cli.mjs prompt [--model id] [--mode idea|custom] [--seed N] [--lock-a A07] [--lock-b B03] [--count 6]  隨機提示詞（依模型＋模式選詞典）
  node cli.mjs library [--sizes] [--json]      曲庫分類總覽（成品MP3/WAV、採樣包各樂器、MIDI…）
  node cli.mjs local-index [--root 名稱] [--full] [--json] 按歌曲ID核對真實檔案，不猜同名
  node cli.mjs site-likes [--sync]   ACE 網頁原生拇指點讚快照；--sync 唯讀抓取全部分頁，不改網站上的讚
  node cli.mjs liked-folder [--dry-run] [--no-ai] [--budget 0.5]  點讚歌的成品 MP3／WAV 複製到 已點讚，DeepSeek 雙語命名（費用上限預設 US$0.50）
  node cli.mjs player [--background] [--json] 啟動獨立本機播放器
  node cli.mjs player --restart [--force]    升級後把執行中的舊播放器服務換成新版（會中斷目前播放；--force 版本號相同也重啟）
  node cli.mjs player --tray [--show]        播放器只留托盤圖示（預設隱藏視窗；右鍵托盤可調整參數）
  node cli.mjs events [--since seq] [--type t]  中樞事件（新歌、自動下載、下載完成）
  node cli.mjs wait [--timeout 秒]             等待下一首新歌（需 Hub＋開著站點分頁）
  node cli.mjs probe                           站點健康（唯讀）
  node cli.mjs official status                 官方遠端 MCP 授權狀態（OAuth，站點 session 失效時的兜底）
  node cli.mjs official login [--no-open]      授權官方 MCP（瀏覽器按一次同意；token 存 <stateDir>\\official-auth.json）
  node cli.mjs official list [--limit N]       官方歌單（不需要瀏覽器 session）
  node cli.mjs official download --song <id> [--format mp3|wav|midi|midi_full]  官方下載連結
  node cli.mjs official get --ids a,b [--score] / create --input x.json / skill --name lyrics
  node cli.mjs official test                   授權＋額度＋歌單煙霧測試
  node cli.mjs generate --request song.json [--json]  預覽 v1.1 提示詞與費用（預設不生成）
  node cli.mjs generate --request song.json --commit --confirm-credit-spend --max-credits 4 --idempotency-key <key>  單次生成（需 Hub）
  node cli.mjs generation-status --task-ids id1,id2 [--song <task_id>] [--json]  唯讀查生成結果
  node cli.mjs backups [--keep-days 7] [--keep-last 1] [--max-mb N] [--prune --commit]  整理備份清單／清理（預設只預覽）
  node cli.mjs masters                         母帶清單（俱樂部版／舊版對照，唯讀）
  node cli.mjs list [--query 關鍵字] [--undownloaded] [--json] 列出可下載歌曲
  node cli.mjs fill-missing [--types mp3,wav,cover] [--commit]  依索引補齊缺的免費檔（預設預覽；不碰 MIDI／MusicXML）
  node cli.mjs download --all [選項]           下載全部歌曲
  node cli.mjs download --song <task_id> ...   下載指定歌曲（可重複）
  node cli.mjs download --latest N [--types all] 下載最新 N 首（types 可用 all）
  node cli.mjs organize [--commit]             整理 Downloads 內已下載的檔案（預設 dry-run）
  node cli.mjs extract-mp3 [選項]              把所有歌曲的成品 MP3 集中到 ai音樂\\成品MP3\\（會自動補齊漏掉的）
  node cli.mjs extract-samples                 把分軌/採樣集中到 ai音樂\\採樣包\\（按樂器類型分資料夾）
  node cli.mjs favorites [--dry-run] [--force] [--sync]  把站點點讚／面板愛心的歌 → ai音樂\\收藏\\<歌名>.wav（平鋪母帶）
  node cli.mjs wav-names [--dry-run]  成品WAV 分類後把乾淨名字複製到 整理輸出\\（來源檔不動）
  node cli.mjs export-aiff [--liked] [--root 名稱] [--artist 名稱] [--force] [--dry-run]  成品WAV（或已點讚）→ AIFF，嵌入封面、藝人預設 VooDooBoys
  node cli.mjs named-copy [--force] [--dry-run] [--json]  詞庫命名 → 改名WAV（複製式，寫 _命名日誌.json 可倒查）
  node cli.mjs named-lookup "<新名字或中文名>"  用新名字倒查原本是哪個檔
  node cli.mjs hardlink-dedupe [--commit] [--json]  收藏／已點讚 內同內容副本改硬連結（省硬碟，預設 dry-run）
  node cli.mjs strip-fingerprints [--dry-run|--restore]  就地抹掉既有檔案裡的 ACE metadata 指紋（檔長、inode 不變）
  node cli.mjs classify-files [--copy]         依檔案屬性分類 MIDI/MusicXML/封面/壓縮檔/其他（預設搬移，--copy 保留原檔）
  node cli.mjs dedupe-songs [--commit]         歌名資料夾內與分類庫相同的副本（預設預覽）
  node cli.mjs dedupe-content [--commit]       內容去重：全庫相同內容只留一份（預設預覽，--commit 才搬移）
  node cli.mjs dedupe-folders [--commit]       清空資料夾＋移除分類庫已有相同內容的副本（預設預覽）
  node cli.mjs status                          快速摘要（本地快照＋登入狀態，通常 <100ms）
  node cli.mjs hub [--background|--status|--stop] [--port 8788]  常駐快速響應中樞（agent 共用、job 佇列、SSE）
  node cli.mjs warm                            預熱本地快取（登入／歌單／檔案索引／曲庫快照）
  node cli.mjs watch [--background|--status|--stop] 靜默背景監看：有新檔案自動整理分類
  node cli.mjs classify-audio                   依音頻屬性分類（BPM/調性/能量/樂器類型，hardlink 不佔空間）
  node cli.mjs tidy-all [--background|--status] 一鍵自動整理：舊檔→成品MP3→採樣包→檔案分類
  node cli.mjs cache [status|clear]            查看/清除快取（歌單、檔案索引）
  node cli.mjs extract-mp3 --status            查看背景補齊進度

download 選項：
  --types stems,midi,musicxml,mp3,wav,cover 要下載的類型（預設 stems,midi,cover,wav；樂譜只排已要求分軌的歌；WAV 獨立補齊）
  --root <資料夾>                        最上層資料夾（預設 ai音樂）
  --force                                已下載過的也重新下載
  --concurrency <1-6>                    並行下載數（預設 4）
  --type-folders                         依類型分層（Stems/MIDI/Audio）
  --dry-run                              只印出清單，不實際下載
  --json                                 以 JSON 輸出

organize 選項：
  --commit        真的移動檔案（預設只列出）
  --root <資料夾> 最上層資料夾（預設 ai音樂）
  --json          以 JSON 輸出

extract-mp3 選項：
  --folder <名稱>  成品資料夾（預設 成品MP3，位於 ai音樂 底下）
  --force          已存在也重新下載/複製
  --concurrency    並行數 1-6（預設 4）
  --background     背景執行（會寫入狀態檔，面板按鈕用）
  --status         讀取背景執行進度
  --json           以 JSON 輸出

favorites 選項：
  --sync     先唯讀同步站點點讚（保留上次快照；失敗不影響收藏夾）
  --dry-run  只列出會複製哪些檔，不動檔案
  --force    同名不同內容也覆寫（舊檔先歸檔到 organize-backups）
  --folder <名稱>  收藏資料夾（預設 收藏，位於 ai音樂 底下）
  --root <資料夾>  最上層資料夾（預設 ai音樂）
  --json     以 JSON 輸出
  註：只收每首歌的 WAV 母帶（站的成品 WAV），平鋪成 <歌名>.wav；只有 MP3 的歌不收（noWav）。
      舊版 收藏/<歌名>/ 子資料夾與其中的 MP3／分軌／封面會在下次執行時清掉（只刪我們放的、大小沒變的檔）。

strip-fingerprints 選項：
  --dry-run  只列出命中哪些檔案／frame，不改檔
  --restore  用最近一次備份把指紋原 bytes 寫回（同一份備份只還原一次）
  --root <資料夾>  最上層資料夾（預設 ai音樂）
  --json     以 JSON 輸出

wav-names 選項：
  --dry-run  只列出會複製成什麼名字，不動檔案
  --out <名稱>  輸出資料夾（預設 整理輸出，位於 ai音樂 底下）
  --folder <名稱>  來源資料夾（預設 成品WAV）
  --root <資料夾>  最上層資料夾（預設 ai音樂）
  --json     以 JSON 輸出

登入狀態：擴充功能面板按「同步登入狀態給 Agent」，會寫入
  %LOCALAPPDATA%\\AceMusicDL\\session.json
`);
}

function parseArgs(argv) {
    const out = { _: [], flags: {}, multi: {} };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (key === 'all' || key === 'force' || key === 'json' || key === 'type-folders' || key === 'dry-run' || key === 'commit' || key === 'background' || key === 'status' || key === 'move' || key === 'refresh' || key === 'copy' || key === 'confirm-credit-spend') {
                out.flags[key] = true;
            } else if (key === 'song') {
                (out.multi.song = out.multi.song || []).push(next);
                i += 1;
            } else if (next != null && !next.startsWith('--')) {
                out.flags[key] = next;
                i += 1;
            } else {
                out.flags[key] = true;
            }
        } else {
            out._.push(token);
        }
    }
    return out;
}

function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const args = parseArgs(argv.slice(1));
    const cfg = config();
    if (cmd === 'local-index') {
        try {
            if (args.flags.native && args.flags.full) throw new Error('native 模式只提供 compact 索引；完整資料請使用 Hub API');
            const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
            const cached = await hubTry('/download-index?root=' + encodeURIComponent(root) + (args.flags.full ? '&full=1' : ''));
            const index = cached || await ACE.localDownloadIndex(cfg, { root, full: !!args.flags.full, refresh: !!args.flags.refresh });
            if (!args.flags.native) return printJson(index);
            const { nativeIndexPayload } = await import('./lib/local-index-service.mjs');
            return printJson(nativeIndexPayload(index));
        } catch (err) {
            if (!args.flags.native) throw err;
            process.exitCode = 1;
            return printJson({ ok: false, code: err.code || 'LOCAL_INDEX_ERROR', error: err.message || '本機索引未就緒' });
        }
    }
    if (cmd === 'site-likes') return printJson(args.flags.sync ? await ACE.syncSiteLikesFromSite(cfg) : await ACE.siteLikes(cfg));
    if (cmd === 'player' && args.flags.tray) {
        const { spawn } = await import('node:child_process');
        const trayScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'player', 'tray.ps1');
        const shell = process.env.ACE_PWSH || 'pwsh';
        const child = spawn(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', trayScript, ...(args.flags.show ? ['-Show'] : [])], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return printJson({ ok: true, tray: true, script: trayScript });
    }
    if (cmd === 'player' && args.flags.restart) { const { restartPlayer } = await import('./lib/player-process.mjs'); return printJson(await restartPlayer(cfg, { force: !!args.flags.force })); }
    if (cmd === 'player') return printJson(await ACE.startPlayer(cfg, { songId: args.flags['focus-id'] ? decodeURIComponent(String(args.flags['focus-id'])) : '' }));

    if (!cmd || cmd === 'help' || cmd === '--help') return usage();

    if (cmd === 'create') {
        const action = args._[0] || 'capabilities';
        const route = CREATE_CONTRACT.find(item => item.action === action);
        if (!route) throw new Error('未知 Create API 操作。');
        const input = args.flags.input ? JSON.parse(await fs.readFile(String(args.flags.input), 'utf8')) : {};
        const { status, data } = await hubRequest(route.path, { method: route.method, body: route.method === 'POST' ? input : undefined, timeoutMs: ['preview', 'submit', 'tasks'].includes(action) ? 50000 : 5000 });
        printJson(data || { ok: false, status: 'unsupported', error: '此 Hub 未支援完整 Create API。' });
        if (status >= 400 || data?.ok === false) process.exitCode = 1;
        return;
    }

    if (cmd === 'music') {
        const action = args._[0] || 'capabilities';
        const contract = MUSIC_CONTRACT.find(item => item.action === action || item.name === action);
        if (!contract) throw new Error('未知音樂操作；可用：' + MUSIC_CONTRACT.map(item => item.action).join(', '));
        const input = args.flags.input ? JSON.parse(await fs.readFile(String(args.flags.input), 'utf8')) : {};
        const error = validateMusicInput(input, contract.inputSchema);
        if (error) throw new Error(error);
        const query = contract.method === 'GET' ? '?' + new URLSearchParams(Object.entries(input).map(([k,v]) => [k, String(v)])).toString() : '';
        // 思考模式（reasoner）一次可能跑數十秒；其他音樂操作仍是短呼叫。
        const timeoutMs = action === 'research_analyze' ? 180000 : 5000;
        const { status, data } = await hubRequest(contract.path + query, { method: contract.method, body: contract.method === 'POST' ? input : undefined, timeoutMs });
        printJson(data || { ok: false, status: 'unsupported', error: '此 Hub 不支援音樂準備介面。', http: status });
        if (status >= 400 || data?.ok === false) process.exitCode = 1;
        return;
    }

    if (cmd === 'generate') {
        let body = {};
        if (args.flags.request) {
            if (typeof args.flags.request !== 'string') throw new Error('--request 必須提供 JSON 檔路徑');
            body = await readJson(path.resolve(args.flags.request), null);
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('無法讀取生成請求 JSON');
        }
        for (const field of ['mode', 'model', 'prompt', 'style', 'lyrics', 'title']) {
            if (args.flags[field] !== undefined) body[field] = args.flags[field];
        }
        for (const field of ['style_influence', 'max_credits']) {
            const flag = field.replaceAll('_', '-');
            if (args.flags[flag] !== undefined) body[field] = Number(args.flags[flag]);
        }
        if (args.flags['idempotency-key'] !== undefined) body.idempotency_key = args.flags['idempotency-key'];
        if (Object.hasOwn(body, 'request_created_at')) throw new Error('request_created_at 是內部收據欄位，請從請求 JSON 移除。');
        body.dry_run = args.flags.commit !== true || args.flags['dry-run'] === true;
        body.confirm_credit_spend = args.flags['confirm-credit-spend'] === true;
        let capable = false;
        try {
            const caps = await hubJson('/capabilities', { timeoutMs: 2000 });
            capable = Array.isArray(caps.endpoints) && caps.endpoints.some((entry) => entry.method === 'POST' && entry.path === '/generate');
        } catch { /* 唯讀 preflight */ }
        if (!capable) {
            if (!body.dry_run) throw new Error('Hub 未啟動或尚未支援生成；未送出站點生成請求。');
            return printJson({ ...(await ACE.generateSong(cfg, body)), hub: false });
        }
        // 實際 POST 失敗不回落：使用固定 key 查收據，避免重複扣額度。
        return printJson({ ...(await hubJson('/generate', { method: 'POST', body, timeoutMs: 15000 })), hub: true });
    }

    if (cmd === 'generation-status') {
        if (args.flags['task-ids'] !== undefined && typeof args.flags['task-ids'] !== 'string') throw new Error('--task-ids 必須提供逗號分隔的任務 ID');
        const task_ids = [...(args.multi.song || []), ...String(args.flags['task-ids'] || '').split(',').map((id) => id.trim()).filter(Boolean)];
        const query = new URLSearchParams({ task_ids: task_ids.join(',') });
        let result;
        try { result = { ...(await hubJson('/generation-status?' + query.toString(), { timeoutMs: 15000 })), hub: true }; }
        catch { result = { ...(await ACE.generationStatus(cfg, { task_ids })), hub: false }; }
        return printJson(result);
    }

    if (cmd === 'official') {
        const action = args._[0] || 'status';
        const json = !!args.flags.json;
        const ids = [...(args.multi.song || []), ...String(args.flags.ids || args.flags.song || '').split(',').map((value) => value.trim()).filter(Boolean)];
        if (action === 'status') {
            const status = await Official.officialStatus(cfg);
            if (status.authenticated) status.account = await Official.officialAccount(cfg).catch((err) => ({ error: String(err.code || err.message) }));
            if (json) return printJson(status);
            console.log('ACE Music 官方 MCP（' + status.url + '）');
            console.log('  通道            :', !status.enabled ? '已關閉（ACE_OFFICIAL=0）' : status.authenticated ? '✅ 已授權' : '⚠️ 未授權 — node cli.mjs official login');
            console.log('  授權檔          :', status.authFile);
            if (status.hasToken) console.log('  Access token    :', status.expiresAt ? `到 ${status.expiresAt}` : '無到期時間', status.hasRefreshToken ? '（有 refresh_token，快到期會自動續約）' : '（沒有 refresh_token，過期要重新登入）');
            if (status.account && !status.account.error) console.log('  方案／額度      :', status.account.plan_name || status.account.plan || '-', status.account.credits ?? '-', 'credits');
            if (status.account && status.account.error) console.log('  額度查詢        :', status.account.error);
            return;
        }
        if (action === 'login') {
            const result = await Official.officialLogin(cfg, { open: args.flags['no-open'] !== true });
            const status = await Official.officialStatus(cfg);
            if (json) return printJson({ ok: true, ...result, status });
            console.log('✅ 官方 MCP 已授權');
            console.log('  授權檔          :', status.authFile);
            console.log('  有效期          :', result.expiresInSeconds ? Math.round(result.expiresInSeconds / 60) + ' 分鐘（之後自動續約）' : '未知');
            return;
        }
        if (action === 'logout') return printJson({ ok: await Official.officialLogout(cfg) });
        if (action === 'refresh') return printJson({ ok: true, token: await Official.officialRefresh(cfg) });
        if (action === 'list') {
            const limit = Number(args.flags.limit || 20);
            const songs = [];
            let cursor = '';
            for (let page = 0; page < 20 && songs.length < limit; page += 1) {
                const data = await Official.officialListSongs(cfg, { limit: Math.min(30, limit - songs.length), cursor });
                songs.push(...data.songs);
                cursor = data.nextCursor;
                if (!cursor) break;
            }
            const rows = Official.officialRowsToSongs(songs);
            if (json) return printJson({ count: rows.length, songs: rows });
            for (const song of rows) console.log(`${song.task_id}  ${song.status === 'succeeded' ? '完成' : song.status}  ${song.meta.title}  ${song.result.duration_sec ? song.result.duration_sec + 's' : ''}  ${song.model || ''}`);
            return;
        }
        if (action === 'get') {
            if (!ids.length) throw new Error('official get 需要 --ids a,b 或 --song <id>');
            return printJson(await Official.officialGetSongs(cfg, ids, { includeScore: args.flags.score === true }));
        }
        if (action === 'download') {
            if (!ids.length) throw new Error('official download 需要 --song <id>');
            const format = String(args.flags.format || 'mp3');
            const result = await Official.officialDownloadUrl(cfg, ids[0], format, { waitMs: Number(args.flags.wait || 90) * 1000 });
            if (json) return printJson(result);
            console.log(result.url);
            return;
        }
        if (action === 'create') {
            if (!args.flags.input) throw new Error('official create 需要 --input file.json（style 必填）');
            const body = JSON.parse(await fs.readFile(String(args.flags.input), 'utf8'));
            return printJson(await Official.officialCreateSong(cfg, body));
        }
        if (action === 'skill') {
            const name = String(args.flags.name || args._[1] || 'lyrics');
            const text = await Official.officialSkill(cfg, name);
            if (json) return printJson({ name, text });
            console.log(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
            return;
        }
        if (action === 'test') {
            const status = await Official.officialStatus(cfg);
            if (!status.authenticated) throw new Error('官方 MCP 尚未授權：node cli.mjs official login');
            const account = await Official.officialAccount(cfg, { fresh: true });
            const list = await Official.officialListSongs(cfg, { limit: 1 });
            return printJson({ ok: true, url: status.url, plan: account.plan_name || account.plan, credits: account.credits, sample: list.songs[0] ? Official.officialSongToSite(list.songs[0]) : null });
        }
        throw new Error('未知 official 操作；可用：status, login, logout, refresh, list, get, download, create, skill, test');
    }

    if (cmd === 'doctor') {
        const status = await ACE.sessionStatus(cfg, { force: !!args.flags.refresh });
        const history = await readJson(cfg.historyFile, null);
        const state = await ACE.loadState(cfg);
        const report = {
            node: process.version,
            baseUrl: cfg.baseUrl,
            downloadDir: cfg.downloadDir,
            stateDir: cfg.stateDir,
            sessionFile: { path: cfg.sessionFile, exists: exists(cfg.sessionFile) },
            historyFile: { path: cfg.historyFile, exists: exists(cfg.historyFile), records: history && history.items ? history.items.length : 0 },
            session: { authenticated: status.authenticated, exportedAt: status.exportedAt, error: status.error },
            rememberedSongs: Object.keys(state.folderByTask).length,
            rememberedFiles: Object.values(state.history).reduce((n, item) => n + Object.keys((item && item.files) || {}).length, 0),
            page: await ACE.pageChannelStatus(cfg),
            official: await Official.officialStatus(cfg),
        };
        if (args.flags.json) return printJson(report);
        console.log('ACE Music 批量下載器 CLI — 環境檢查');
        console.log('  Node            :', report.node);
        console.log('  站點            :', report.baseUrl);
        console.log('  下載資料夾      :', report.downloadDir);
        console.log('  登入狀態檔      :', report.sessionFile.path, report.sessionFile.exists ? '（存在）' : '（不存在）');
        console.log('  登入有效        :', report.session.authenticated ? '✅ 可以下載' : '❌ ' + (report.session.error || '尚未匯出'));
        if (report.session.exportedAt) console.log('  匯出時間        :', report.session.exportedAt);
        console.log('  下載紀錄        :', report.historyFile.path, report.historyFile.exists ? `（${report.historyFile.records} 筆）` : '（未匯出）');
        console.log('  已記住歌曲/檔案 :', report.rememberedSongs, '/', report.rememberedFiles);
        const pg = report.page;
        console.log('  頁面快照        :', pg.savedAt ? ` 首，${pg.savedAt}（${pg.fresh ? '新鮮' : '過舊，開一次 acemusic.ai/create 頁面即可更新'}）；不可用紀錄 ${pg.unavailable}` : '尚未收到（開 acemusic.ai/create 頁面，面板會自動送出）');
        console.log('  官方 MCP        :', report.official.enabled ? (report.official.authenticated ? '✅ 已授權（站點失效時兜底歌單／mp3-wav-midi）' : '⚠️ 未授權 — node cli.mjs official login') : '已關閉（ACE_OFFICIAL=0）');
        return;
    }

    if (cmd === 'library') {
        const viaHub = args.flags.local ? null : await hubTry('/library' + (args.flags.sizes ? '?sizes=1' : ''), { timeoutMs: 15000 });
        const result = viaHub || (await ACE.libraryOverview(cfg, { withSizes: !!args.flags.sizes }));
        if (args.flags.json) return printJson(result);
        console.log('曲庫：' + result.root);
        for (const c of result.categories) {
            const label = c.sub ? `${c.category}／${c.sub}` : c.category;
            console.log(`  ${label.padEnd(18)} ${String(c.files).padStart(5)} 檔${c.bytes != null ? `　${(c.bytes / 1048576).toFixed(1)} MB` : ''}`);
        }
        if (result.otherFolderCount) console.log(`  （另有 ${result.otherFolderCount} 個未分類資料夾，例如歌名資料夾）`);
        return;
    }

    if (cmd === 'backups') {
        // 預設只預覽；--prune --commit 才刪。規則：保留最近 --keep-last 個（1），其餘超過 --keep-days 天（7）或總量超過 --max-mb 才刪
        const result = await ACE.pruneBackups(cfg, {
            keepDays: args.flags['keep-days'] != null ? Number(args.flags['keep-days']) : 7,
            keepLast: args.flags['keep-last'] != null ? Number(args.flags['keep-last']) : 1,
            maxBytes: args.flags['max-mb'] ? Number(args.flags['max-mb']) * 1048576 : 0,
            commit: !!(args.flags.prune && args.flags.commit),
        });
        if (args.flags.json) return printJson(result);
        const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
        if (!result.exists) return console.log('沒有備份資料夾：' + result.root);
        console.log(`備份：${result.backups.length} 個，共 ${mb(result.bytesTotal)}（${result.root}）`);
        for (const b of result.backups) console.log(`  ${result.prune.some((p) => p.name === b.name) ? '✂' : ' '} ${b.name.padEnd(44)} ${String(b.files).padStart(4)} 檔 ${mb(b.bytes).padStart(10)}  ${b.ageDays} 天`);
        if (result.committed) console.log(`已刪除 ${result.removed.length} 個，釋放 ${mb(result.bytesReclaimable)}${result.failed.length ? `；失敗 ${result.failed.length}` : ''}`);
        else console.log(`依規則可刪 ${result.prune.length} 個（✂），可釋放 ${mb(result.bytesReclaimable)}。確認後加 --prune --commit 執行。`);
        return;
    }

    if (cmd === 'masters') {
        const result = await ACE.listMasters(cfg);
        if (args.flags.json) return printJson(result);
        if (!result.total) return console.log('沒有母帶檔（俱樂部版／舊版對照）');
        for (const m of result.masters) {
            const w = m.wav ? `　${m.wav.sampleRate / 1000}kHz/${m.wav.bitsPerSample}bit ${m.wav.codec}${m.wav.durationSec ? ' ' + m.wav.durationSec + 's' : ''}` : '';
            console.log(`  [${m.folder}] ${m.name}　${(m.bytes / 1048576).toFixed(1)} MB${w}`);
        }
        console.log(result.note);
        return;
    }

    if (cmd === 'probe') {
        const result = await ACE.probeSite(cfg);
        if (args.flags.json) return printJson(result);
        const st = result.status || {};
        console.log(`站點 ${result.baseUrl}：HTTP ${st.http || '—'}（${result.elapsedMs} ms）`);
        console.log(`  登入：${st.loggedIn ? '是' : '否'}${st.plan ? '　方案：' + st.plan : ''}`);
        if (st.models) console.log('  模型：' + st.models.join('、'));
        if (st.error) console.log('  錯誤：' + st.error);
        const official = result.official || {};
        if (official.authenticated) official.account = await Official.officialAccount(cfg).catch(() => null);
        console.log(`  官方 MCP：${official.enabled === false ? '已關閉' : official.authenticated ? '✅ 已授權' + (official.account ? `（${official.account.plan_name || official.account.plan || '-'}，${official.account.credits ?? '-'} credits）` : '') : '⚠️ 未授權 — node cli.mjs official login'}`);
        return;
    }

    if (cmd === 'events' || cmd === 'wait') {
        if (cmd === 'events') {
            const q = new URLSearchParams();
            if (args.flags.since) q.set('since', String(args.flags.since));
            if (args.flags.type && args.flags.type !== true) q.set('type', String(args.flags.type));
            const viaHub = await hubTry('/page/events?' + q.toString(), { timeoutMs: 2000 });
            const result = viaHub || { ok: true, hub: false, events: await ACE.readPageEvents(cfg) };
            if (args.flags.json) return printJson(result);
            if (!result.events.length) return console.log('（沒有事件；開著 acemusic.ai/create 分頁時才會產生）');
            for (const e of result.events) console.log(`${new Date(e.at).toLocaleString()}  ${e.seq != null ? '#' + e.seq + ' ' : ''}${e.type}  ${e.title || e.task_id || (e.task_ids || []).join(',')}${e.type === 'download_done' ? `（完成 ${e.done}／失敗 ${e.failed}）` : ''}`);
            return;
        }
        const timeoutSec = Number(args.flags.timeout) || 120;
        const head = await hubTry('/page/events?limit=1', { timeoutMs: 2000 });
        if (!head) throw new Error('Hub 未啟動：node agent\\cli.mjs hub --background');
        if (!args.flags.json) console.log(`等待新歌（最多 ${timeoutSec} 秒）…`);
        const got = await hubTry(`/wait?type=song_new&since=${head.lastSeq || 0}&timeout=${timeoutSec * 1000}`, { timeoutMs: timeoutSec * 1000 + 5000 });
        if (args.flags.json) return printJson(got || { ok: false });
        if (!got || !got.event) return console.log('逾時，沒有新歌');
        console.log(`新歌：${got.event.title || ''}　[${got.event.task_id}]`);
        return;
    }

    if (cmd === 'prompt') {
        // 隨機提示詞：node cli.mjs prompt [--model acemusic-v1.1] [--mode idea|custom] [--seed N] [--lock-a A07] [--lock-b B03] [--count 6] [--json]
        const result = await ACE.randomPrompt(cfg, {
            model: args.flags.model && args.flags.model !== true ? String(args.flags.model) : 'acemusic-v1.1',
            mode: args.flags.mode && args.flags.mode !== true ? String(args.flags.mode) : 'custom',
            seed: args.flags.seed,
            lockA: args.flags['lock-a'] && args.flags['lock-a'] !== true ? String(args.flags['lock-a']) : undefined,
            lockB: args.flags['lock-b'] && args.flags['lock-b'] !== true ? String(args.flags['lock-b']) : undefined,
            count: args.flags.count,
        });
        if (args.flags.json) return printJson(result);
        for (const r of result.prompts) {
            if (!r.ok) {
                console.log('✖ ' + (r.reason || r.status));
                continue;
            }
            console.log(`[${r.cell}] ${r.a.name_zh} × ${r.b.name_zh} · ${r.length}/${r.limit} 字 · seed ${r.seed} · ${r.modelName}／${r.mode}`);
            console.log(r.text + '\n');
        }
        return;
    }

    if (cmd === 'locate') {
        // 歌曲 → 本機真實目錄；預設最新一首。Hub 在跑就走 Hub（記憶體／ms 級）
        const q = new URLSearchParams();
        const songId = (args.multi.song && args.multi.song[0]) || '';
        if (songId) q.set('song', songId);
        if (args.flags.query && args.flags.query !== true) q.set('q', String(args.flags.query));
        if (args.flags.latest) q.set('latest', String(args.flags.latest === true ? 1 : args.flags.latest));
        if (args.flags.views) q.set('views', '1');
        const viaHub = args.flags.local ? null : await hubTry('/locate?' + q.toString(), { timeoutMs: 5000 });
        const result = viaHub || (await ACE.locateSongs(cfg, {
            songId,
            query: q.get('q') || '',
            latest: Number(q.get('latest') || 0),
            includeViews: !!args.flags.views,
        }));
        if (args.flags.json) return printJson(result);
        if (!result.songs.length) return console.log('找不到符合的歌曲');
        for (const song of result.songs) {
            console.log(`　[${song.task_id}]　${song.created_at || ''}`);
            if (!song.fileCount) {
                console.log('   （本機還沒有這首歌的檔案）');
                continue;
            }
            for (const d of song.dirs) console.log(`   ${d.dir}　（${d.count}：${d.kinds.join('、')}）`);
        }
        return;
    }

    if (cmd === 'extract-mp3') {
        const statusFile = cfg.stateDir ? path.join(cfg.stateDir, 'extract-status.json') : '';
        if (args.flags.status) {
            const data = await readJson(statusFile, null);
            if (args.flags.json) return printJson(data || { exists: false, statusFile });
            console.log(data ? JSON.stringify(data, null, 2) : '（沒有進行中的成品 MP3 工作）');
            return;
        }
        const folder = args.flags.folder ? String(args.flags.folder) : ACE.DEFAULT_MP3_FOLDER;
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const force = !!args.flags.force;
        const concurrency = Math.max(1, Math.min(6, Number(args.flags.concurrency) || 4));
        if (args.flags.background) {
            const { spawn } = await import('node:child_process');
            const script = path.resolve(process.argv[1]);
            const child = spawn(
                process.execPath,
                [script, 'extract-mp3', '--json', '--root', root, '--folder', folder, '--concurrency', String(concurrency), ...(force ? ['--force'] : [])],
                { detached: true, stdio: 'ignore', cwd: process.cwd(), windowsHide: true },
            );
            child.unref();
            const initial = {
                phase: 'starting',
                pid: child.pid,
                folder: path.join(cfg.downloadDir, root, folder),
                total: 0,
                done: 0,
                failed: [],
                startedAt: new Date().toISOString(),
            };
            await writeJson(statusFile, initial);
            return printJson({ ok: true, background: true, pid: child.pid, statusFile, folder: initial.folder });
        }
        const startedAt = Date.now();
        let lastWrite = 0;
        const result = await ACE.extractFullMp3s({
            root,
            folder,
            force,
            limit: Number(args.flags.limit) || 0,
            concurrency,
            onProgress: (progress) => {
                const now = Date.now();
                if (now - lastWrite < 600 && progress.done !== progress.total) return;
                lastWrite = now;
                const phase = progress.done >= progress.total && progress.total > 0 ? 'finishing' : 'running';
                writeJson(statusFile, { phase, ...progress }).catch(() => {});
            },
        });
        await writeJson(statusFile, { phase: 'done', ...result }).catch(() => {});
        if (args.flags.json) return printJson(result);
        console.log(`成品 MP3：共 ${result.total} 首（${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
        console.log(`  已存在 ${result.skipped}、從歌曲資料夾複製 ${result.copied}、下載補齊 ${result.downloaded}、失敗 ${result.failed.length}`);
        console.log(`  資料夾：${result.folder}`);
        console.log(`  清單  ：${result.manifestPath}`);
        if (result.failed.length) {
            for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.title}：${fail.error}`);
        }
        return;
    }

    if (cmd === 'extract-samples') {
        const folder = args.flags.folder ? String(args.flags.folder) : '採樣包';
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const result = await ACE.collectSamples({ root, folder, cfg });
        if (args.flags.json) return printJson(result);
        console.log(`採樣：共 ${result.total} 個`);
        console.log(`  已存在 ${result.skipped}、複製 ${result.copied}、失敗 ${result.failed.length}`);
        console.log(`  資料夾：${result.folder}`);
        console.log(`  清單  ：${result.manifestPath}`);
        if (result.failed.length) {
            for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
        }
        return;
    }

    if (cmd === 'liked-folder' || cmd === 'liked') {
        const capUsd = args.flags.budget !== undefined ? Number(args.flags.budget) : undefined;
        if (capUsd !== undefined && !(capUsd >= 0 && capUsd <= 5)) throw new Error('--budget 需介於 0 到 5（USD）');
        const result = await ACE.collectLikedSongs({ cfg, root: args.flags.root || 'ai音樂', dryRun: !!args.flags['dry-run'], ai: !args.flags['no-ai'], ...(capUsd !== undefined ? { capUsd } : {}) });
        if (args.flags.json) return printJson(result);
        if (result.error) { console.log('已點讚：' + result.error); process.exitCode = 1; return; }
        const cost = result.dryRun ? `預估 AI 費用 US$${result.estimatedUsd ?? 0}` : `AI 命名 ${result.aiNamed}、用網站歌名 ${result.titleNamed}；累計花費 US$${result.spentUsd}／上限 US$${result.capUsd}`;
        console.log(`已點讚：${result.dryRun ? '預覽' : '完成'}（${result.folder}）`);
        console.log(`  點讚 ${result.liked} 首；需要命名 ${result.needsNaming}；${cost}`);
        if (!result.dryRun) console.log(`  複製 ${result.copied}、已存在 ${result.already}、改名 ${result.renamed}、更新 ${result.refreshed}、取消點讚移出 ${result.unlikedMoved}；沒有本機成品音檔 ${result.missingAudio.length} 首${result.aiStopped ? '；AI 停止原因：' + result.aiStopped : ''}`);
        for (const item of (result.items || []).slice(0, 10)) console.log(`  - ${item.name}  [${item.files.join('/')}]`);
        for (const f of result.failed.slice(0, 10)) console.log(`  ✗ ${f.task_id || ''} ${f.error}`);
        return;
    }

    if (cmd === 'favorites' || cmd === 'collect-favorites') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const folder = args.flags.folder ? String(args.flags.folder) : ACE.DEFAULT_FAVORITES_FOLDER;
        if (args.flags.sync) {
            const synced = await ACE.syncSiteLikesFromSite(cfg);
            if (!args.flags.json) {
                console.log(synced.ok
                    ? `站點點讚已同步：${synced.count} 首（${synced.complete ? '完整' : '不完整'}）`
                    : `站點點讚同步失敗，沿用上次快照：${synced.error || synced.code || '未知錯誤'}`);
            }
        }
        const result = await ACE.collectFavorites({ root, folder, dryRun: !!args.flags['dry-run'], force: !!args.flags.force, cfg });
        if (args.flags.json) return printJson(result);
        console.log(`收藏夾：喜歡 ${result.total} 首（站點點讚 ${result.sources.site.count}、面板愛心 ${result.sources.panel.count}）`);
        console.log(`  複製 ${result.copied}、已存在 ${result.skipped}、更新 ${result.refreshed}、改名 ${result.renamed}、同名保留原檔 ${result.conflicts}、沒有 WAV ${result.noWav}、未下載 ${result.missing}、清單外 ${result.unknown}、失敗 ${result.failed.length}`);
        if (!result.dryRun) console.log(`  清掉舊版雜檔 ${result.pruned} 個（空資料夾 ${result.prunedDirs} 個）`);
        if (result.dryRun) {
            const mb = Math.round((result.plannedBytes || 0) / 1048576);
            console.log(`  預計複製 ${result.planned || 0} 個檔（約 ${mb} MB）`);
        }
        console.log(`  資料夾：${result.folder}`);
        console.log(`  清單  ：${result.manifestPath}`);
        if (result.dryRun) console.log('  （dry-run：只列計畫，沒有複製任何檔案）');
        if (result.failed.length) {
            for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.title || fail.task_id}：${fail.error}`);
        }
        return;
    }

    if (cmd === 'wav-names') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const folder = args.flags.folder ? String(args.flags.folder) : '成品WAV';
        const outFolder = args.flags.out ? String(args.flags.out) : '整理輸出';
        const result = await ACE.copyCollectedWavs({ root, folder, outFolder, dryRun: !!args.flags['dry-run'], cfg });
        if (args.flags.json) return printJson(result);
        const headline = result.dryRun ? `預計複製 ${result.planned}` : `複製 ${result.copied}`;
        console.log(`WAV 整理輸出：掃 ${result.total} 檔、${headline}、上次已複製 ${result.already}、無證據保留 ${result.loose}、失敗 ${result.failed.length}`);
        console.log(`  來源：${result.folder}`);
        console.log(`  輸出：${result.outDir}`);
        if (result.dryRun) {
            for (const item of result.items.slice(0, 10)) console.log(`  ${item.from} → ${item.to}`);
            console.log('  （dry-run：沒有複製任何檔案）');
        }
        if (result.failed.length) for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
        return;
    }

    if (cmd === 'activity') {
        const { readActivity } = await import('./lib/activity-log.mjs');
        const result = await readActivity({ cfg: config(), limit: args.flags.limit ? Number(args.flags.limit) : 5 });
        if (args.flags.json) return printJson(result);
        console.log(`摘要檔：${result.summaryPath}${result.exists ? '' : '（還沒有紀錄）'}`);
        for (const block of result.entries) console.log(block);
        if (args.flags.open && result.exists) {
            const { spawn } = await import('node:child_process');
            spawn('explorer.exe', [result.summaryPath], { detached: true, stdio: 'ignore' }).unref();
            console.log('已開啟摘要');
        }
        return;
    }

    if (cmd === 'repair-evidence') {
        const { repairWavEvidence } = await import('./lib/evidence-repair.mjs');
        const result = await repairWavEvidence({ cfg: config(), commit: !!args.flags.commit });
        if (args.flags.json) return printJson(result);
        console.log(`WAV 證據修補：掃 ${result.scanned} 檔，已對 ${result.already}、可補 ${result.repaired}、認不出 ${result.unresolved}`);
        for (const sample of result.samples.slice(0, 6)) console.log(`  ${sample.file}  →  ${sample.task_id}`);
        if (result.dryRun) console.log('  （dry-run：加 --commit 才會寫進 agent-state.json，會先備份）');
        return;
    }

    if (cmd === 'named-copy' || cmd === 'rename-copy') {
        const { applyNamedCopies } = await import('./lib/named-copy.mjs');
        const rootFlag = args.flags.root ? String(args.flags.root) : '';
        const result = await applyNamedCopies({
            root: rootFlag ? (path.isAbsolute(rootFlag) ? rootFlag : path.join(config().downloadDir, rootFlag)) : undefined,
            force: !!args.flags.force,
            dryRun: !!args.flags['dry-run'],
            cfg: config(),
        });
        if (args.flags.json) return printJson(result);
        console.log(`改名WAV：${result.out}`);
        console.log(`  寫出 ${result.written}、已存在 ${result.skipped}、沒有封面 ${result.noCover}、失敗 ${result.failed.length}（藝人 ${result.artist}）`);
        if (result.journal) console.log(`  命名日誌：${result.journal}（${result.journalEntries || 0} 筆，可倒查）`);
        if (result.dryRun) {
            console.log('  （dry-run：沒有寫任何檔案）');
            for (const sample of result.samples || []) console.log(`  ${sample.to}  ←  ${sample.from}`);
        }
        if (result.failed.length) for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
        return;
    }

    if (cmd === 'named-lookup') {
        const wanted = args._[0];
        if (!wanted) throw new Error('用法：node cli.mjs named-lookup "<新名字或檔名>"');
        const { lookupNamed } = await import('./lib/named-copy.mjs');
        const found = await lookupNamed({ name: wanted, cfg: config() });
        if (args.flags.json) return printJson(found || { found: false });
        if (!found) { console.log(`找不到「${wanted}」的命名紀錄`); return; }
        console.log(`新名字：${found.to}`);
        console.log(`原檔案：${found.from}`);
        console.log(`中文／英文：${found.zh}${found.en ? ' / ' + found.en : ''}｜版型 ${found.pattern}｜封面 ${found.cover || '—'}｜seed ${found.seed}`);
        return;
    }

    if (cmd === 'hardlink-dedupe' || cmd === 'linkdup') {
        const { hardlinkDedupe } = await import('./lib/hardlink-dedupe.mjs');
        const result = await hardlinkDedupe({ cfg: config(), commit: !!args.flags.commit });
        if (args.flags.json) return printJson(result);
        console.log(`硬連結整理：掃 ${result.scanned} 個副本，可換 ${result.linked}、已是連結 ${result.alreadyLink}、找不到同內容 ${result.noMatch}`);
        console.log(`  可省 ${(result.bytesSaved / 1e9).toFixed(2)} GB`);
        if (result.dryRun) console.log('  （dry-run：加 --commit 才會真的換）');
        if (result.failed.length) for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
        return;
    }

    if (cmd === 'export-aiff' || cmd === 'aiff') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const { exportAiffs, exportLikedAiffs } = await import('./lib/aiff-export.mjs');
        if (args.flags.liked) {
            const liked = await exportLikedAiffs({
                root: args.flags.root && path.isAbsolute(String(args.flags.root)) ? String(args.flags.root) : undefined,
                artist: args.flags.artist ? String(args.flags.artist) : undefined,
                force: !!args.flags.force,
                dryRun: !!args.flags['dry-run'],
                cfg: config(),
            });
            if (args.flags.json) return printJson(liked);
            console.log(`已點讚 AIFF：${liked.out}`);
            console.log(`  來源 ${liked.total} 首；轉出 ${liked.converted}、已存在 ${liked.skipped}、沒有封面 ${liked.noCover}、失敗 ${liked.failed.length}`);
            if (liked.dryRun) console.log('  （dry-run：沒有寫任何檔案）');
            return;
        }
        const result = await exportAiffs({
            root: path.isAbsolute(root) ? root : path.join(config().downloadDir, root),
            artist: args.flags.artist ? String(args.flags.artist) : undefined,
            force: !!args.flags.force,
            dryRun: !!args.flags['dry-run'],
            concurrency: args.flags.concurrency ? Number(args.flags.concurrency) : undefined,
            cfg: config(),
        });
        if (args.flags.json) return printJson(result);
        console.log(`成品AIFF：${result.out}`);
        console.log(`  來源 ${result.total} 首；轉出 ${result.converted}、已存在 ${result.skipped}、沒有封面 ${result.noCover}、失敗 ${result.failed.length}（藝人 ${result.artist}）`);
        if (result.dryRun) console.log('  （dry-run：沒有寫任何檔案）');
        if (result.failed.length) for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
        return;
    }

    if (cmd === 'strip-fingerprints' || cmd === 'fingerprints') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        if (args.flags.restore) {
            const restored = await ACE.restoreFingerprints({ cfg });
            if (args.flags.json) return printJson(restored);
            console.log(`指紋還原：${restored.restored} 個區段（備份 ${restored.backup}）`);
            if (restored.skipped) console.log(`  跳過 ${restored.skipped}（檔案長度已變，無法原位還原）`);
            if (restored.failed.length) for (const fail of restored.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
            return;
        }
        const result = await ACE.stripFingerprints({ root, dryRun: !!args.flags['dry-run'], cfg });
        if (args.flags.json) return printJson(result);
        console.log(`指紋清除：掃 ${result.scanned} 個實體音檔，命中 ${result.targets} 個`);
        console.log(`  清除 ${result.cleaned} 個檔（MP3 ${result.mp3}、WAV ${result.wav}）；抹掉 ${result.framesRemoved} 個 frame、${result.chunksNeutralized} 個 chunk，約 ${(result.bytesNeutralized / 1024).toFixed(1)} KB`);
        console.log(`  已驗證紀錄更新 ${result.proofsUpdated || 0} 筆`);
        if (result.backup) console.log(`  備份（可 --restore 還原）：${result.backup}`);
        if (result.dryRun) console.log('  （dry-run：沒有改任何檔案）');
        if (result.failed.length) for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
        return;
    }

    if (cmd === 'warm') {
        const result = await ACE.warmCaches(cfg, { refreshSession: !!args.flags['refresh-session'], refresh: !!args.flags.refresh });
        if (args.flags.json) return printJson(result);
        console.log(`快取預熱完成 ${result.elapsedMs}ms（登入 ${result.timings.sessionMs}ms／快照 ${result.timings.snapshotMs}ms）`);
        console.log(`  歌曲 ${result.counts.songs}（已下載 ${result.counts.downloaded}／部分 ${result.counts.partial}／未下載 ${result.counts.undownloaded}）`);
        return;
    }

    if (cmd === 'status') {
        const hub = args.flags.local ? null : await hubTry('/overview');
        if (hub) {
            const payload = { via: 'hub', generatedAt: hub.builtAt, cached: !!hub.cached, ageMs: hub.ageMs || 0, authenticated: hub.authenticated, counts: hub.counts };
            if (args.flags.json) return printJson(payload);
            const auth = hub.authenticated === null ? '登入狀態未快取' : hub.authenticated ? '已登入' : '未登入';
            console.log(`ACE（hub）：${auth}　歌曲 ${hub.counts.songs}（已下載 ${hub.counts.downloaded}／部分 ${hub.counts.partial}／未下載 ${hub.counts.undownloaded}）`);
            console.log(`  快照：${hub.builtAt}（${hub.cached ? '快取命中' : '剛建立'}）`);
            return;
        }
        const snapshot = await ACE.getLibrarySnapshot(cfg);
        const session = await ACE.sessionStatus(cfg);
        const payload = { via: 'local', generatedAt: snapshot.builtAt, cached: !!snapshot.cached, ageMs: snapshot.ageMs, authenticated: !!session.authenticated, counts: snapshot.counts };
        if (args.flags.json) return printJson(payload);
        console.log(`ACE：${payload.authenticated ? '已登入' : '未登入'}　歌曲 ${payload.counts.songs}（已下載 ${payload.counts.downloaded}／部分 ${payload.counts.partial}／未下載 ${payload.counts.undownloaded}）`);
        console.log(`  快照：${payload.cached ? '快取命中' : '剛建立'}（${payload.generatedAt}）`);
        return;
    }

    if (cmd === 'hub') {
        const port = Number(args.flags.port) || Number(process.env.ACE_HUB_PORT) || 8788;
        const base = `http://127.0.0.1:${port}`;
        const hubScript = path.resolve(path.dirname(process.argv[1]), 'hub.mjs');
        if (args.flags.status) {
            try {
                const health = (await hubRequest('/health', { base, timeoutMs: 2500 })).data;
                // health 有回應就是「在跑」；overview 慢（剛啟動、首次快照建立中）不代表 Hub 沒在跑
                let overview = null;
                let overviewErr = '';
                try {
                    overview = (await hubRequest('/overview', { base, timeoutMs: 2500 })).data;
                } catch (err) {
                    overviewErr = /timeout/i.test(String(err && err.message)) ? '首次快照建立中，稍後再查' : String((err && err.message) || err);
                }
                const counts = (overview && overview.counts) || (health && health.counts);
                const payload = { ok: true, url: base, hub: health, counts: counts || null, overviewError: counts ? undefined : overviewErr || (overview && overview.error) || 'overview 無資料' };
                if (args.flags.json) return printJson(payload);
                console.log(`Hub 運行中：${base}（v${health.version}，pid ${health.pid}，${Math.round(health.uptimeMs / 1000)}s）`);
                if (counts) console.log(`  歌曲 ${counts.songs}（已下載 ${counts.downloaded}／部分 ${counts.partial}／未下載 ${counts.undownloaded}）`);
                else console.log('  曲庫概覽不可用：' + payload.overviewError);
                return;
            } catch (err) {
                if (args.flags.json) return printJson({ ok: false, error: String((err && err.message) || err) });
                console.log('Hub 沒有在執行（' + String((err && err.message) || err) + '）');
                return;
            }
        }
        if (args.flags.stop) {
            try {
                await hubRequest('/shutdown', { base, method: 'POST', timeoutMs: 2500 });
                console.log('已要求 hub 關閉');
            } catch (err) {
                console.log('Hub 沒有在執行或無法連線：' + String((err && err.message) || err));
            }
            return;
        }
        const { spawn, spawnSync } = await import('node:child_process');
        if (args.flags.background) {
            const child = spawn(process.execPath, [hubScript], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ACE_HUB_PORT: String(port) } });
            child.unref();
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                try {
                    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
                    if (res.ok) {
                        const health = await res.json();
                        return printJson({ ok: true, background: true, pid: child.pid, port, url: base, version: health.version });
                    }
                } catch {
                    /* retry */
                }
            }
            return printJson({ ok: false, error: 'hub 啟動逾時', pid: child.pid, port });
        }
        const result = spawnSync(process.execPath, [hubScript], { stdio: 'inherit', env: { ...process.env, ACE_HUB_PORT: String(port) } });
        process.exit(result.status || 0);
    }

    if (cmd === 'dedupe-content') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const result = await ACE.dedupeContent({ root, commit: !!args.flags.commit, includeCustom: !!args.flags['include-custom'], cfg });
        if (args.flags.json) return printJson({ ...result, groups: result.groups.slice(0, 50), duplicateFiles: result.duplicateFiles.slice(0, 200) });
        const mode = result.commit ? '實際執行' : '預覽（加 --commit 才真的搬移）';
        console.log(`內容去重：${mode}`);
        console.log(`  掃描 ${result.scanned} 檔，找到 ${result.groupCount} 組相同內容、${result.duplicateCount} 個重複檔（可回收 ${Math.round(result.bytesReclaimable / 1048576)} MB）`);
        if (result.commit) console.log(`  已搬移 ${result.moved} 個到 ${path.join(cfg.stateDir, 'organize-backups')}，回收 ${Math.round(result.bytesReclaimed / 1048576)} MB，alias ${Object.keys(result.aliases || {}).length} 筆`);
        for (const group of result.groups.slice(0, 10)) console.log(`  - ${group.count} 份 ${Math.round(group.size / 1048576)}MB：保留 ${group.keeper}`);
        for (const err of result.errors.slice(0, 10)) console.log(`  ✗ ${err.file}：${err.error}`);
        return;
    }

    if (cmd === 'dedupe-songs') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const result = await ACE.dedupeSongCopies({ root, commit: !!args.flags.commit, cfg });
        if (args.flags.json) return printJson({ ...result, candidates: result.candidates.slice(0, 200) });
        console.log(`歌名資料夾副本去重：${result.commit ? '實際執行' : '預覽（加 --commit 才真的歸檔）'}`);
        console.log(`  掃描 ${result.scanned} 檔；${result.commit ? '已歸檔 ' + result.archived : '可歸檔 ' + result.candidateCount} 個與分類庫內容相同的副本`);
        for (const item of result.candidates.slice(0, 10)) console.log(`  - ${item.file} → 保留 ${item.keep}`);
        for (const err of result.failed.slice(0, 10)) console.log(`  ✗ ${err.file}：${err.error}`);
        return;
    }

    if (cmd === 'dedupe-folders') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const result = await ACE.dedupeFolders({ root, commit: !!args.flags.commit, includeCustom: !!args.flags['include-custom'], cfg });
        if (args.flags.json) return printJson(result);
        const mode = result.commit ? '實際執行' : '預覽（加 --commit 才真的搬移）';
        console.log(`重複／空資料夾清理：${mode}`);
        console.log(`  空資料夾 ${result.emptyFolders.length} 個`);
        console.log(`  重複檔案 ${result.duplicateFiles.length} 個（可回收 ${Math.round(result.bytesReclaimable / 1048576)} MB）`);
        if (result.commit) console.log(`  已搬移 ${result.moved} 個到 ${path.join(cfg.stateDir, 'organize-backups')}，回收 ${Math.round(result.bytesReclaimed / 1048576)} MB`);
        for (const item of result.duplicateFiles.slice(0, 12)) console.log(`  - ${path.relative(result.root, item.file)}（保留 ${path.relative(result.root, item.keep)}）`);
        for (const dir of result.emptyFolders.slice(0, 12)) console.log(`  · 空：${dir.replace(result.root + path.sep, '')}`);
        for (const err of result.errors.slice(0, 10)) console.log(`  ✗ ${err.file || err.dir}：${err.error}`);
        return;
    }

    if (cmd === 'classify-audio') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const folder = args.flags.folder ? String(args.flags.folder) : '音頻分類';
        const result = await ACE.classifyByAudio({ root, folder, linkMode: args.flags.copy ? 'copy' : 'hardlink', limit: Number(args.flags.limit) || 0, refresh: !!args.flags.refresh, cfg });
        if (args.flags.json) return printJson(result);
        console.log(`音頻分類：共 ${result.total} 個音檔（分析 ${result.analyzed}、快取 ${result.cached}、建立分類連結 ${result.linked}、跳過 ${result.skipped}、失敗 ${result.failed.length}）`);
        console.log('  資料夾：' + result.folder);
        console.log('  能量門檻：low<' + result.thresholds.low + '，high>=' + result.thresholds.high);
        for (const fail of result.failed.slice(0, 10)) console.log('  ✗ ' + fail.file + '：' + fail.error);
        return;
    }

    if (cmd === 'classify-files') {
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        const result = await ACE.classifyByAttributes({ root, move: !args.flags.copy, cfg });
        if (args.flags.json) return printJson(result);
        console.log(`檔案分類：共 ${result.total} 個（複製 ${result.copied}、搬移 ${result.moved}、已存在 ${result.skipped}、失敗 ${result.failed.length}）`);
        for (const [name, count] of Object.entries(result.categories)) console.log(`  ${name}：${count}`);
        for (const fail of result.failed.slice(0, 10)) console.log(`  ✗ ${fail.file}：${fail.error}`);
        return;
    }

    if (cmd === 'cache') {
        const cfgNow = config();
        const status = {
            cacheDir: path.join(cfgNow.stateDir, 'cache'),
            songs: await ACE.cacheRead('songs', { cfg: cfgNow }),
            fsIndex: await ACE.cacheRead('fs-index', { cfg: cfgNow }),
        };
        const action = args._[0] || 'status';
        if (action === 'clear') {
            // 預設只清可快速重建的快取；音頻分析（重算很久）要 --all 才清
            const names = args.flags.all ? [null] : ['songs', 'fs-index', 'library-snapshot', 'session-status'];
            for (const name of names) ACE.cacheClear(name, cfgNow);
            return console.log(args.flags.all ? '已清除全部快取（含音頻分析）。' : '已清除歌單／檔案索引／曲庫快照／登入狀態快取（音頻分析保留，--all 才清）。');
        }
        const report = {
            cacheDir: status.cacheDir,
            songs: status.songs ? { cachedAt: status.songs.cachedAt, fresh: status.songs.songs ? status.songs.songs.length : 0, known: status.songs.known ? status.songs.known.length : 0 } : null,
            fsIndex: status.fsIndex ? { cachedAt: status.fsIndex.cachedAt, files: (status.fsIndex.files || []).length } : null,
        };
        if (args.flags.json) return printJson(report);
        console.log('快取資料夾：' + report.cacheDir);
        console.log('  歌單：' + (report.songs ? `${report.songs.fresh} 首（已知 ${report.songs.known} 首）` : '（無）'));
        console.log('  檔案索引：' + (report.fsIndex ? `${report.fsIndex.files} 個檔案` : '（無）'));
        return;
    }

    if (cmd === 'tidy-all') {
        const statusFile = path.join(cfg.stateDir, 'tidy-status.json');
        if (args.flags.status) {
            const data = await readJson(statusFile, null);
            if (args.flags.json) return printJson(data || { exists: false, statusFile });
            console.log(data ? JSON.stringify(data, null, 2) : '（沒有進行中的整理工作）');
            return;
        }
        const root = args.flags.root ? String(args.flags.root) : 'ai音樂';
        if (args.flags.background) {
            const { peekTidyRun, markTidyPending } = await import('./lib/tidy-guard.mjs');
            const running = await peekTidyRun(cfg);
            if (running) {
                // 已有一輪在跑：不另外開一個行程重跑整條管線，只登記「結束後補一輪」
                const pending = await markTidyPending(cfg, { root });
                return printJson({ ok: true, coalesced: true, background: false, runningPid: running.pid, pending, statusFile });
            }
            const { spawn } = await import('node:child_process');
            const script = path.resolve(process.argv[1]);
            const child = spawn(process.execPath, [script, 'tidy-all', '--json', '--root', root], {
                detached: true,
                stdio: 'ignore',
                cwd: process.cwd(),
                windowsHide: true,
            });
            child.unref();
            await writeJson(statusFile, { phase: 'starting', pid: child.pid, startedAt: new Date().toISOString() });
            return printJson({ ok: true, background: true, pid: child.pid, statusFile });
        }
        let lastWrite = 0;
        const result = await ACE.tidyAll({
            root,
            onProgress: (progress) => {
                const now = Date.now();
                if (now - lastWrite < 700) return;
                lastWrite = now;
                writeJson(statusFile, { phase: progress.phase, ...progress }).catch(() => {});
            },
        });
        // 合併掉的那次不要寫 done：正在跑的那一輪還在更新同一個狀態檔
        if (!result.coalesced) await writeJson(statusFile, { phase: 'done', ...result }).catch(() => {});
        if (args.flags.json) return printJson(result);
        if (result.coalesced) {
            console.log('已有一輪整理在跑（pid ' + (result.runningPid || '?') + '）；這次只登記，會在那一輪結束後補跑一輪。');
            return;
        }
        console.log('一鍵整理完成：');
        for (const step of result.steps) console.log('  ' + JSON.stringify(step));
        return;
    }

    if (cmd === 'watch') {
        const statusFile = path.join(cfg.stateDir, 'watch-status.json');
        const pidAlive = (pid) => {
            if (!pid) return false;
            try { process.kill(pid, 0); return true; } catch { return false; }
        };
        const ACTIVE_PHASES = new Set(['starting', 'running', 'idle']);
        if (args.flags.status) {
            const data = await readJson(statusFile, null);
            if (!data) {
                if (args.flags.json) return printJson({ exists: false, statusFile });
                console.log('（背景整理沒有在執行）');
                return;
            }
            const alive = pidAlive(data.pid);
            const stale = !alive && ACTIVE_PHASES.has(String(data.phase || ''));
            const report = { ...data, alive, stale, running: alive && ACTIVE_PHASES.has(String(data.phase || '')) };
            if (args.flags.json) return printJson(report);
            console.log(JSON.stringify(report, null, 2));
            if (stale) console.log('（pid ' + data.pid + ' 已不存在：這是上次中斷留下的紀錄，背景整理沒有在執行）');
            else if (!alive) console.log('（背景整理已停止）');
            return;
        }
        if (args.flags.stop) {
            const data = await readJson(statusFile, null);
            if (data?.pid && pidAlive(data.pid)) {
                await writeJson(path.join(cfg.stateDir, 'watch-stop.json'), { pid: data.pid, requestedAt: new Date().toISOString(), reason: 'cli-stop' });
                return printJson({ ok: true, stopRequested: true, stopped: false, pid: data.pid, message: '正在等本輪整理完成，不會強停檔案寫入' });
            }
            await writeJson(statusFile, { ...data, phase: 'stopped', stoppedAt: new Date().toISOString(), reason: 'cli-stop' }).catch(() => {});
            return printJson({ ok: true, stopped: true });
        }
        if (args.flags.background) {
            const existing = await readJson(statusFile, null);
            if (existing && existing.pid && pidAlive(existing.pid)) {
                return printJson({ ok: true, background: true, alreadyRunning: true, pid: existing.pid, statusFile });
            }
            const { spawn } = await import('node:child_process');
            const watcher = path.resolve(path.dirname(process.argv[1]), 'watch.mjs');
            const child = spawn(process.execPath, [watcher], { detached: true, stdio: 'ignore', cwd: process.cwd(), windowsHide: true });
            child.unref();
            await writeJson(statusFile, { phase: 'starting', pid: child.pid, startedAt: new Date().toISOString() });
            return printJson({ ok: true, background: true, pid: child.pid, statusFile, replacedStale: !!(existing && existing.pid) });
        }
        const { spawnSync } = await import('node:child_process');
        const watcher = path.resolve(path.dirname(process.argv[1]), 'watch.mjs');
        const result = spawnSync(process.execPath, [watcher, '--once'], { stdio: 'inherit' });
        process.exit(result.status || 0);
    }

    if (cmd === 'session') {
        const status = await ACE.sessionStatus(cfg);
        if (args.flags.json) return printJson(status);
        console.log(JSON.stringify(status, null, 2));
        return;
    }

    if (cmd === 'list') {
        const params = new URLSearchParams();
        if (args.flags.query) params.set('q', String(args.flags.query));
        if (args.flags.undownloaded) params.set('undownloaded', '1');
        if (args.flags.limit) params.set('limit', String(args.flags.limit));
        params.set('compact', '0');
        const hub = !args.flags.refresh && !args.flags.local ? await hubTry('/songs?' + params.toString()) : null;
        let rows;
        if (hub) {
            rows = hub.songs;
        } else {
            const snapshot = await ACE.getLibrarySnapshot(cfg, { refresh: !!args.flags.refresh });
            const query = args.flags.query ? String(args.flags.query).toLowerCase() : '';
            rows = snapshot.songs.slice();
            if (query) rows = rows.filter((s) => s.title.toLowerCase().includes(query) || s.task_id.includes(query));
            if (args.flags.undownloaded) rows = rows.filter((s) => !(s.downloaded && s.downloaded.allDone));
            const limit = Number(args.flags.limit) || 200;
            rows = rows.slice(0, limit);
        }
        if (args.flags.json) {
            if (args.flags.compact) {
                return printJson(rows.map((row) => ({
                    id: row.task_id,
                    title: row.title,
                    stems: row.stems ? row.stems.count : 0,
                    midi: row.midi_available,
                    cover: row.cover,
                    dur: row.duration_sec,
                    dl: row.downloaded ? row.downloaded.have + '/' + row.downloaded.total : null,
                    done: row.downloaded ? row.downloaded.allDone : false,
                })));
            }
            return printJson(rows);
        }
        if (!rows.length) return console.log('沒有符合的歌曲。');
        console.log(`共 ${rows.length} 首：`);
        for (const song of rows) {
            console.log(`  ${song.task_id}  ${song.title}`);
            console.log(`     分軌：${song.stems ? song.stems.count + ' 軌（mode ' + song.stems.mode + '：' + song.stems.types.join(', ') + '）' : '無'}  MIDI：${song.midi_available ? '有' : '無'}  封面：${song.cover ? '有' : '無'}`);
            const d = song.downloaded || { have: 0, total: 0, detail: [] };
            const detail = (d.detail || []).map((item) => (item.na ? `${item.label} 不可用` : item.total > 1 ? `${item.label} ${item.have}/${item.total}` : `${item.label}${item.done ? '✓' : '✗'}`)).join('、');
            const status = d.allDone ? '已下載' : d.any ? `部分 ${d.have}/${d.total}` : '未下載';
            console.log(`     下載：${status}${detail ? '（' + detail + '）' : ''}`);
        }
        return;
    }

    if (cmd === 'fill-missing') {
        const result = await ACE.fillMissing(cfg, {
            types: args.flags.types ? String(args.flags.types) : ACE.FILL_TYPES,
            root: args.flags.root || 'ai音樂',
            dryRun: !args.flags.commit,
            onProgress: (p) => { if (!args.flags.json) process.stderr.write(`\r補齊中 ${p.done + p.failed}/${p.total}            `); },
        });
        if (!args.flags.json && !result.dryRun) process.stderr.write('\n');
        if (args.flags.json) return printJson(result);
        console.log(`補齊（${result.types.join('、')}）：${result.dryRun ? '預覽（加 --commit 才下載）' : '實際下載'}`);
        console.log(`  掃描 ${result.songsScanned} 首；有缺口 ${result.songsWithGaps} 首；需下載 ${result.toDownload} 個檔${result.noSource?.length ? '；站點沒有來源 ' + result.noSource.length + ' 首（不算失敗）' : ''}`);
        for (const file of (result.files || []).slice(0, 20)) console.log(`  [${result.dryRun ? '將下載' : '下載'}] ${file.path}`);
        if (!result.dryRun) console.log(`完成：下載 ${result.done}、跳過 ${result.skipped}、失敗 ${result.failed}`);
        return;
    }

    if (cmd === 'download') {
        // 選歌／類型規則與 Hub、MCP 共用（ACE.selectSongs／normalizeTypes）
        const songs = ACE.selectSongs(await ACE.listSongs(cfg), {
            song_ids: args.multi.song || [],
            query: args.flags.query,
            latest: args.flags.latest,
            all: !!args.flags.all,
        });
        if (!songs.length) throw new Error('沒有選到歌：請指定 --song <task_id>、--query 字、--latest N 或 --all');
        const types = ACE.normalizeTypes(args.flags.types);
        const options = {
            types,
            root: args.flags.root || 'ai音樂',
            typeFolders: !!args.flags['type-folders'],
            force: !!args.flags.force,
        };
        if (args.flags['dry-run']) {
            const { plan, state } = await ACE.buildPlanForSongs(cfg, songs, options);
            const localSkipped = await ACE.applyLocalSkips(cfg, plan, state);
            const rows = [];
            for (const task of plan.tasks) for (const file of task.files) rows.push({ song: task.title, skip: file.skip, path: file.path });
            if (args.flags.json) return printJson({ total: plan.total, toDownload: plan.toDownload, skipped: plan.skipped, localSkipped, files: rows });
            console.log(`共 ${plan.total} 個檔案，需下載 ${plan.toDownload}、已存在跳過 ${plan.skipped}：`);
            for (const row of rows) console.log(`  ${row.skip ? '[跳過]' : '[下載]'} ${row.path}`);
            return;
        }
        const result = await ACE.runDownload({
            songs,
            options,
            concurrency: Number(args.flags.concurrency) || 4,
            onProgress: (p) => {
                if (!args.flags.json) process.stderr.write(`\r下載中 ${p.done + p.failed}/${p.total}  (${p.current})            `);
            },
            cfg,
        });
        if (!args.flags.json) process.stderr.write('\n');
        if (args.flags.json) return printJson(result);
        console.log(`完成：下載 ${result.done}、跳過 ${result.skipped}、失敗 ${result.failed}（共 ${result.total}）`);
        if (result.failedList && result.failedList.length) {
            console.log('失敗清單：');
            for (const item of result.failedList) console.log(`  ${item.name} — ${item.error}`);
        }
        return;
    }

    if (cmd === 'organize') {
        const result = await ACE.organize({
            dryRun: !args.flags.commit,
            root: args.flags.root || 'ai音樂',
            typeFolders: !!args.flags['type-folders'],
            conflict: args.flags.conflict || 'skip',
            cfg,
        });
        if (args.flags.json) return printJson(result);
        if (!result.movesFound) {
            console.log('沒有找到需要整理的檔案。');
        } else {
            console.log((result.dryRun ? '（預覽）' : '（已執行）') + `可整理 ${result.movesFound} 個檔案：`);
            for (const move of result.moves.slice(0, 50)) console.log(`  ${move.from}\n      → ${move.to}`);
            if (result.moves.length > 50) console.log(`  …另有 ${result.moves.length - 50} 筆`);
            if (result.dryRun) console.log('\n加上 --commit 才會真的移動檔案（可用 --conflict unique|overwrite|skip 處理同名檔）。');
            else {
                console.log(`\n已移動 ${result.movedCount}、重複刪除 ${result.dedupedCount}、同名跳過 ${result.conflictCount || 0}、失敗 ${result.failedCount}`);
            }
        }
        if (result.unmatchedCount) console.log(`另有 ${result.unmatchedCount} 個 hash 檔名檔案無法自動對應（需要擴充功能的下載紀錄匯出）。`);
        return;
    }

    throw new Error('未知指令：' + cmd + '（可用 doctor / list / download / organize）');
}

main().catch((err) => {
    console.error('錯誤：' + ((err && err.message) || err));
    // 不直接 process.exit：Node 24 on Windows 在 fetch socket 關閉中強制退出會 libuv assertion（0xC0000409）。
    // 設 exitCode 讓事件迴圈自然結束；萬一有殘留 handle，1.5 秒後再強制退出。
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1500).unref();
});

















