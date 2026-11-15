#!/usr/bin/env node
// cli.mjs — ACE Music 批量下載器 CLI（給 agent / 終端機使用）
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ACE from './lib/ace.mjs';
import { config, readJson, writeJson, exists } from './lib/config.mjs';

const HUB_URL = process.env.ACE_HUB_URL || 'http://127.0.0.1:8788';
let hubSkipUntil = 0;

/** 嘗試走 Agent Hub；不可用時 30 秒內直接回落本地（回傳 null） */
async function hubTry(pathname, { method = 'GET', body, timeoutMs = 1200 } = {}) {
    if (Date.now() < hubSkipUntil) return null;
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
    } catch {
        hubSkipUntil = Date.now() + 30000;
        return null;
    }
}

function usage() {
    console.log(`ACE Music 批量下載器 CLI  v1.6.2

用法：
  node cli.mjs doctor                         檢查登入狀態與環境
  node cli.mjs list [--query 關鍵字] [--undownloaded] [--json] 列出可下載歌曲
  node cli.mjs download --all [選項]           下載全部歌曲
  node cli.mjs download --song <task_id> ...   下載指定歌曲（可重複）
  node cli.mjs organize [--commit]             整理 Downloads 內已下載的檔案（預設 dry-run）
  node cli.mjs extract-mp3 [選項]              把所有歌曲的成品 MP3 集中到 ai音樂\\成品MP3\\（會自動補齊漏掉的）
  node cli.mjs extract-samples                 把分軌/採樣集中到 ai音樂\\採樣包\\（按樂器類型分資料夾）
  node cli.mjs classify-files [--copy]         依檔案屬性分類 MIDI/MusicXML/封面/壓縮檔/其他（預設搬移，--copy 保留原檔）
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
  --types stems,midi,musicxml,mp3,wav,cover 要下載的類型（預設 stems,midi,cover；WAV 需模型支援，不支援會自動跳過）
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
            if (key === 'all' || key === 'force' || key === 'json' || key === 'type-folders' || key === 'dry-run' || key === 'commit' || key === 'background' || key === 'status' || key === 'move' || key === 'refresh' || key === 'copy') {
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

    if (!cmd || cmd === 'help' || cmd === '--help') return usage();

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
                const health = await (await fetch(base + '/health', { signal: AbortSignal.timeout(2500) })).json();
                const overview = await (await fetch(base + '/overview', { signal: AbortSignal.timeout(2500) })).json();
                const payload = { ok: true, url: base, hub: health, counts: overview.counts };
                if (args.flags.json) return printJson(payload);
                console.log(`Hub 運行中：${base}（v${health.version}，pid ${health.pid}，${Math.round(health.uptimeMs / 1000)}s）`);
                console.log(`  歌曲 ${overview.counts.songs}（已下載 ${overview.counts.downloaded}／未下載 ${overview.counts.undownloaded}）`);
                return;
            } catch (err) {
                if (args.flags.json) return printJson({ ok: false, error: String((err && err.message) || err) });
                console.log('Hub 沒有在執行（' + String((err && err.message) || err) + '）');
                return;
            }
        }
        if (args.flags.stop) {
            try {
                await fetch(base + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(2500) });
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
        const action = args._[1] || 'status';
        if (action === 'clear') {
            ACE.cacheClear(null, cfgNow);
            return console.log('已清除快取。');
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
        await writeJson(statusFile, { phase: 'done', ...result }).catch(() => {});
        if (args.flags.json) return printJson(result);
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
            if (data && data.pid) {
                const { spawnSync } = await import('node:child_process');
                spawnSync('taskkill', ['/PID', String(data.pid), '/T', '/F'], { stdio: 'ignore' });
            }
            await writeJson(statusFile, { phase: 'stopped', stoppedAt: new Date().toISOString(), reason: 'cli-stop' }).catch(() => {});
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
            const detail = (d.detail || []).map((item) => (item.total > 1 ? `${item.label} ${item.have}/${item.total}` : `${item.label}${item.done ? '✓' : '✗'}`)).join('、');
            const status = d.allDone ? '已下載' : d.any ? `部分 ${d.have}/${d.total}` : '未下載';
            console.log(`     下載：${status}${detail ? '（' + detail + '）' : ''}`);
        }
        return;
    }

    if (cmd === 'download') {
        let songs = await ACE.listSongs(cfg);
        if (args.multi.song && args.multi.song.length) {
            const want = new Set(args.multi.song);
            songs = songs.filter((song) => want.has(song.task_id));
            if (!songs.length) throw new Error('找不到指定的 task_id：' + [...want].join(', '));
        } else if (!args.flags.all && args.flags.query) {
            const q = String(args.flags.query).toLowerCase();
            songs = songs.filter((s) => ((s.meta && s.meta.title) || '').toLowerCase().includes(q));
        } else if (!args.flags.all) {
            throw new Error('請指定 --all 或 --song <task_id>（可先用 list 查詢）');
        }
        const types = args.flags.types ? String(args.flags.types).split(',').map((s) => s.trim()).filter(Boolean) : ['stems', 'midi', 'cover'];
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
    process.exit(1);
});













