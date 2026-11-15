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
- **回落**：hub 不在時，CLI/MCP 完全照舊（本地 in-process），功能不減。

## 3. API（全部 JSON；只綁 127.0.0.1）

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/health` | 版本、pid、uptime、counts、jobs 統計 |
| GET | `/overview` | 快照摘要（歌曲數／已下載／未下載／MIDI 可用） |
| GET | `/songs?undownloaded=1&q=&limit=50&compact=1` | 歌單（讀快照；`compact=0` 回完整） |
| POST | `/download` | `{song_ids?, all?, query?, types?, root?, type_folders?, force?, concurrency?, dry_run?, idempotency_key?}` → `202 {jobId}` |
| POST | `/tidy` | `{root?}` → job（`tidyAll`） |
| POST | `/dedupe` | `{kind:"content"\|"folders", commit?, include_custom?}` → job |
| POST | `/organize` | `{commit?, root?, type_folders?}` → job |
| POST | `/warm` | `{refresh?, refresh_session?}` → job |
| GET | `/jobs` | 最近 job 摘要 |
| GET | `/jobs/:id` | job 詳情（status／progress／result／error） |
| POST | `/jobs/:id/cancel` | 合作式取消（下載支援；其他 job 標記） |
| GET | `/events` | SSE：`job`、`progress`、`snapshot` 事件 |
| POST | `/shutdown` | 關閉 hub（只接受 loopback） |

### job 狀態機

`queued → running → done | failed | cancelled`

- `progress`：`{done,total,current,phase,...}`，下載時節流 500ms 廣播。
- `result`：下載完成回傳 `{ok,total,done,skipped,failed,...}`；`dry_run` 回 `{dryRun:true,total,toDownload,skipped,localSkipped}`。
- `idempotency_key`：同一 key 重送會回同一個 `jobId`（避免 agent 重試造成重複下載）。

## 4. 快照與失效

- hub 啟動時 `warmCaches()` 預熱；之後每 60s 或寫入 job 完成後刷新。
- 讀取路徑不等待刷新：先回目前 snapshot，必要時背景更新（stale-while-revalidate）。
- `ACE_HUB_SNAPSHOT_TTL_MS` 可調。

## 5. 安全

- 只綁 `127.0.0.1`；不開放區網。
- 可選 `ACE_HUB_TOKEN`：設定後要求 `x-hub-token` 標頭。
- 不新增任何站點 API 呼叫；沿用既有 session／cookie。

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
