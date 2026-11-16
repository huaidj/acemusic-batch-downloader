# ACE Agent Hub — 快速響應中樞（設計）

> 狀態：**v1.5.0 已實作並驗證**（2026-11-16）。目的：讓任何 agent（DSH／Claude Code／Codex／MCP 宿主）用**一個常駐本地服務**拿到 sub-10ms 的讀取、可追蹤的下載 job、以及跨宿主共用的單一狀態。

## 1. 動機（現況缺口）

| 現況 | 問題 |
| --- | --- |
| 每個宿主各自 spawn `mcp.mjs` | 快取各算各的；同時下載會互撞 `agent-state.json` |
| job 存在 MCP 進程的 Map | MCP 重啟＝job 消失，其他 agent 查不到 |
| CLI 每次冷啟 | 讀取約 50ms（可接受，但無法共享快照） |
| 只能輪詢 | 沒有事件流，agent 只能 sleep＋poll |

## 2. 拓撲

```
agent / CLI / MCP ──HTTP──► agent/hub.mjs (127.0.0.1:8788)
                                  │
                                  ├─ 記憶體 snapshot（TTL 60s）
                                  ├─ 單一寫入佇列（下載/整理/去重/分類）
                                  ├─ job 表（記憶體＋狀態檔快照）
                                  └─ SSE /events
```

- **單一寫入者**：`%LOCALAPPDATA%\AceMusicDL\hub.lock` 記錄 pid；已有活著的 hub 就拒絕啟動（exit 2）。
- **讀取**：直接讀記憶體 snapshot，不碰磁碟、不打站點。
- **寫入**：一律進佇列，序列執行；完成後 `clearFsCaches` 並刷新 snapshot。
- **回落**：既有下載／查詢功能可回落本地。付費生成只能由支援 `/generate` 的 Hub 提交；連線錯誤或提交逾時不改走本地重送。

## 3. API（全部 JSON；只綁 127.0.0.1）

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/health` | 版本、`apiVersion`、pid、uptime、counts、jobs 統計 |
| GET | `/capabilities` | 整合契約（機器可讀）：apiVersion、endpoints、events、sse、fileTypes、selector、pageFiles、auth（v1.7.1） |
| GET | `/overview` | 快照摘要（歌曲數／已下載／未下載／MIDI 可用） |
| GET | `/songs?undownloaded=1&q=&limit=50&compact=1` | 歌單（讀快照；`compact=0` 回完整） |
| POST | `/download` | `{song_ids?, all?, query?, types?, root?, type_folders?, force?, concurrency?, dry_run?, idempotency_key?}` → `202 {jobId}` |
| POST | `/generate` | v1.1 直接生成；預設 `dry_run:true` 只讀成本及模型。實際請求需 `confirm_credit_spend:true`、`max_credits`、`idempotency_key`，回生成提交 job |
| GET | `/generation-status` | `task_ids=id1,id2` 精確查詢站點生成狀態（唯讀，不觸發生成） |
| POST | `/tidy` | `{root?}` → job（`tidyAll`） |
| POST | `/dedupe` | `{kind:"content"\|"folders", commit?, include_custom?}` → job |
| POST | `/organize` | `{commit?, root?, type_folders?}` → job |
| POST | `/warm` | `{refresh?, refresh_session?}` → job |
| GET | `/jobs` | 最近 job 摘要 |
| GET | `/jobs/:id` | job 詳情（status／progress／result／error） |
| POST | `/jobs/:id/cancel` | 合作式取消（下載支援；其他 job 標記） |
| GET | `/events` | SSE：`job`、`progress`、`snapshot`、`page`（頁面檔更新）、`event`（中樞事件）|
| GET | `/locate?latest=&q=&song=&views=1` | 歌曲 → 本機真實目錄／檔案（v1.7.0） |
| GET | `/favorites` | 面板的收藏清單（新 → 舊；page-favorites.json）（v1.7.3） |
| GET | `/prompts/random?model=&mode=&seed=&lock_a=&lock_b=&count=` | 隨機提示詞（依模型＋模式選詞典；只產生文字，不提交生成；缺詞典回 422）（v1.7.3） |
| GET | `/library?sizes=1` | 曲庫分類總覽（v1.7.0） |
| GET | `/page` | 頁面通道健康度（page-songs 快照時間、筆數、新鮮度、不可用紀錄數） |
| GET | `/page/events?since=&type=&limit=` | 事件環（最近 200）：`song_new`（頁面或歌單差異）、`auto_download`、`download_done` |
| GET | `/wait?type=song_new&task_id=&since=&timeout=` | 長輪詢：等下一個符合的事件；`since` 之後已發生則立即回 |
| POST | `/shutdown` | 關閉 hub（只接受 loopback） |

### job 狀態機

`queued → running → done | failed | cancelled`

- `progress`：`{done,total,current,phase,...}`，下載時節流 500ms 廣播。
- `result`：下載完成回傳 `{ok,total,done,skipped,failed,...}`；`dry_run` 回 `{dryRun:true,total,toDownload,skipped,localSkipped}`。
- `idempotency_key`：同一 key 重送會回同一個 `jobId`（避免 agent 重試造成重複下載）。

## 4. 快照與失效

### 音樂 Agent 與完整 Create API（此隔離分支）

沿用同一 Hub 寫入者與來源限制。`/music` 是本機方向預覽；`/music/api` 是 Create 參數對照。下列端點均回 JSON，完整 schema 由 `/create-api/capabilities` 與 MCP tool schema 提供。

| Method | Path | 說明 |
|---|---|---|
| GET | `/music/capabilities` | 詞典編譯能力與授權邊界 |
| GET | `/music/dictionary` | 中英詞條與版本 |
| POST | `/music/references` | 本機登記引用，不抓取 |
| POST | `/music/intent/prepare` | 檢查原意與來源 |
| POST | `/music/prompts/compile` | 編譯並固定預覽版本 |
| POST | `/music/sessions` | 建立有限本機批次 |
| POST | `/music/generations/prepare` | 審閱後準備待授權任務 |
| POST | `/music/generations/submit` | 尚未串接產物閉環，固定 unsupported |
| GET | `/music/job` | 準備任務狀態 |
| GET | `/music/events` | SQLite 持久事件游標 |
| POST | `/music/sessions/stop` | 停止本機後續準備 |
| GET | `/music/assets` | 本流程實際驗證的產物（目前空） |
| POST | `/music/feedback` | 沒有實際產物時拒絕試聽評分 |
| GET | `/music/state` | 本機方向、批次、任務 |
| GET | `/create-api/capabilities` | Create 前端所有已觀察的參數、上傳及輔助端點契約 |
| POST | `/create-api/prepare` | 純本機組裝原生 JSON，不讀登入或帳本 |
| POST | `/create-api/preview` | 唯讀核對即時模型、價格與限制 |
| POST | `/create-api/submit` | 獨立有限授權 → 額度預留 → 單次排入 Hub |
| GET | `/create-api/authority` | 授權與預留摘要，不含路徑或秘密 |
| POST | `/create-api/tasks` | 三模型精確遠端 ID 狀態，不下載 |
| POST | `/create-api/receipt` | 原幂等鍵查持久收據，不重送 |
| POST | `/create-api/stop` | 停止授權批次；未知結果仍保留預留 |

新生成任務需伺服器程序指定的 `ACE_GENERATION_GRANT_FILE`；請求不能自行設定授權、預算或上傳許可。預設無授權，會在讀取登入與站點前拒絕提交。只有 loopback 契約測試可走舊 `/generate` 的實際提交路徑；真站使用完整 Create API 的獨立帳本。預覽與遠端提交完成都不代表產物、聽感或演出已驗收。參見 [CREATE-API.md](CREATE-API.md) 與 [MUSIC-AGENT.md](MUSIC-AGENT.md)。

`music` SSE 事件通知新方向、批次與準備任務；可用 `/music/events` 游標跨重啟補讀。生成收據與保留費用記於獨立 authority SQLite，由同一 Hub 執行者管理，沒有第二個排程服務。

- hub 啟動時 `warmCaches()` 預熱；之後每 60s 或寫入 job 完成後刷新。
- 讀取路徑不等待刷新：先回目前 snapshot，必要時背景更新（stale-while-revalidate）。
- `ACE_HUB_SNAPSHOT_TTL_MS` 可調。

### 4.1 頁面通道（v1.7.0）

- 面板把精簡歌單寫 `page-songs.json`（變動時＋每 5 分鐘心跳）、不可用紀錄寫 `page-unavailable.json`、事件寫 `page-events.json`（都經 native host 的 `export`，背景執行）。
- Hub 以 `fs.watch` 監看 state 目錄：歌單／不可用檔變動 → 立即重建快照（不等 TTL）並推 `page`；事件檔變動 → 匯入事件環並推 `event`、喚醒 `/wait`。
- 讀取一律 stale-while-revalidate：有舊快照就立刻回，背景重算；Hub 熱路徑 p50：`/health` 0.3 ms、`/overview` 0.9 ms、`/locate` 1.7 ms（`scripts/bench.mjs`）。
- 客戶端（CLI／MCP）用 `agent/lib/hubclient.mjs`（node:http keep-alive）；Node 內建 fetch 在 Windows 對 localhost 每次約 15 ms。

## 5. 安全

- 只綁 `127.0.0.1`；不開放區網。
- 可選 `ACE_HUB_TOKEN`：設定後要求 `x-hub-token` 標頭。
- 生成沿用既有本機 session／Cookie；只向 ACE Music 同源 API 發送，不使用第三方代理。生成預設預覽，費用由即時 `/api/status` 取得。
- `generation-receipts.json` 在送出前保存請求指紋、時間戳與 job 紀錄；同 key 不重送，Hub 重啟後仍保留結果不明的紀錄。它不是伺服器提供的冪等保證。

## 6. 失敗模式

| 情況 | 行為 |
| --- | --- |
| 已有 hub | 新 hub 啟動失敗（exit 2），訊息含現有 pid/port |
| port 被佔 | 啟動失敗（exit 3） |
| 站點未登入 | job `failed`，error 帶 `NO_SESSION` 說明；讀取仍可用快取 |
| hub 掛掉 | MCP/CLI 30s 內不再嘗試，直接本地模式；不影響下載 |
| job 重送 | idempotency key 回同 job，不重複下載 |

## 7. 驗收（可重跑，v1.5.0 實測）

1. `node agent/hub.mjs` 起來後：`GET /health` 200、`/overview` <10ms（快取命中）。
2. `POST /download {dry_run:true}` 回 job，`/jobs/:id` 完成且數字與 CLI dry-run 一致。
3. 同 `idempotency_key` 連送兩次 → 同一個 jobId。
4. 第二個 hub（同 state dir）→ exit 2。
5. MCP：hub 開著時 `ace_overview`/`ace_list_songs` 走 hub；hub 關掉後仍可用（本地回落）。
6. 單元測試：`test/unit/hub.test.mjs` 全綠；全套 **38/38**。
7. 實測：`/overview` 2–9ms、`/songs` 2ms、dry-run job 185ms；hub 關閉後 MCP `overview` 仍可用（hub:false）。
8. 同 state dir 的第二個 hub exit 2（實測）。

## 8. 非目標

- 不做跨機器／區網共享。
- 不接管 mixdesk（它有自己的 port 8777）。
- 不自動重送失敗的下載（需 agent 明確呼叫）。


## 9. v1.5.1 追加

- CLI `status`／`list` 也走 hub（`hubTry`，失敗 30 秒內回落；`--local` 強制本地、`--refresh` 走本地刷新）。
- `/overview` 回傳 `authenticated`（只讀 session-status 快取，避免即時打站點）。
- SSE 測試：`/events` 收到 `hello` 與 `job`／`progress`／`snapshot` 事件。
- 實測：CLI hub 路徑 76–87ms（含 node 冷啟）；hub 關閉後 `via:local`。
