# 開發規範（CONVENTIONS）

> 目的：保持可擴展、讓之後接入其他插件／agent 時不必改核心。**有測試把關的規則標 🔒**（`test/unit/conventions.test.mjs`），違反會讓測試失敗。

## 1. 分層（誰可以依賴誰）

```
src/naming.js、src/planner.js   純函式（瀏覽器與 Node 共用；不碰 DOM／fs／網路）
        ▲                       └─ agent 透過 agent/lib/shared.mjs 以 vm 載入
agent/lib/ace.mjs               核心：站點 API、下載、整理、選歌器、locate、維運（唯一實作處）
agent/lib/config.mjs            路徑、快取、檔案工具
agent/lib/hubclient.mjs         連 Hub 的 HTTP 客戶端（node:http keep-alive）
        ▲
agent/hub.mjs  agent/cli.mjs  agent/mcp.mjs     薄轉接層：解析參數 → 呼叫 ace.mjs → 輸出
src/content.js（面板）  src/background.js（SW）   瀏覽器端
```

- **規則 1.1**：業務邏輯只寫在 `ace.mjs`（Node 端）或 `planner.js`／`naming.js`（兩端共用）。hub／cli／mcp **不得**各自實作選歌、類型展開、檔案比對。
- **規則 1.2**：面板與 agent 都需要的判斷（例如「站點不提供」、檔名索引、狀態項目）放 `planner.js`。
- **規則 1.3**：`planner.js`／`naming.js` 保持純函式：輸入 → 輸出，不改傳入物件（回傳新物件）。

## 2. 檔案類型與分類

- 🔒 **單一清單**：檔案類型 = `FILE_TYPES`（`stems, midi, musicxml, mp3, wav, cover`）。面板（`src/content.js`）與 agent（`ace.mjs`）必須一致；`all` 只是入口別名，由 `normalizeTypes` 展開。
- **新增一種可下載資源**：
  1. `naming.js`：檔名規則（`fileNamesFor`）、`TYPE_DIRS`
  2. `planner.js`：`buildDownloadPlan` 產生檔案項目（含 `kind`、`source`、`key`）
  3. `ace.mjs`：`FILE_TYPES`、URL 取得（如需）、`tidyAll` 分類目的資料夾、`songDownloadSummary` 狀態
  4. `content.js`：`FILE_TYPES`、面板勾選框
  5. 文件：`docs/GUIDE.md` §3 分類表；測試：planner 單元＋e2e 一個情境
- 分類資料夾名稱（`成品MP3`、`成品WAV`、`採樣包/<樂器>`、`採樣包WAV`、`MIDI`、`MusicXML`、`封面`、`壓縮檔`、`其他`、`音頻分類`）是對使用者的契約，改名必須提供遷移。

## 3. 選歌器（Selector）

- 🔒 唯一實作：`ACE.selectSongs(songs, selector)`、`ACE.normalizeSelector`。
- 形狀：`{ song_ids?: string[], query?: string, latest?: number, all?: boolean }`；條件可疊加（ids → query → 最新 N 首）。
- **沒有任何條件且 `all !== true` → 不選任何歌**（防止誤下載全部）。
- 新增條件（例如 `since`、`model`）：只改 `normalizeSelector`＋`selectSongs`＋本節文件，三個入口自動支援。

## 4. 新增一個 agent 功能（工具）

每個能力要有三個入口，參數名一致（snake_case 對外）：

| 層 | 做法 |
|---|---|
| 核心 | `ace.mjs` 匯出 `async function xxx(cfg = config(), opts)`；回傳 JSON 可序列化物件，含 `ok` |
| Hub | `hub.mjs` 加路由；**同時登記到 `ENDPOINTS`**（🔒 會被 `/capabilities` 輸出、並與 `agent/HUB.md` 比對） |
| MCP | `mcp.mjs` 的 `TOOLS` 加定義（`name` 以 `ace_` 開頭、`description` 說清楚何時用、`additionalProperties: false`）＋`callTool` case；Hub 在就走 Hub、不在回落本地 |
| CLI | `cli.mjs` 加指令＋`usage()` 一行 |
| 文件 | 🔒 `agent/README-AGENT.md` 工具表要列出每個 MCP 工具；`docs/GUIDE.md` CLI／MCP 表 |

## 5. 網頁 ↔ 本機通道

- 面板 → 本機只透過 native host 的 `export`，檔名白名單在 `src/background.js` 的 `PAGE_EXPORT_NAMES`。
- 🔒 白名單裡的每個檔都必須由 Hub 監看（`/capabilities.pageFiles`），否則 agent 收不到。
- 寫入一律背景、非阻塞、可失敗（失敗不得影響面板操作）；大量資料要節流（變動才送＋心跳）。
- 新增一種頁面資料：加白名單 → 面板 `emit`/`export` → Hub `PAGE_FILES` 處理 → `pageFiles` → 文件。

## 6. 對外整合（其他插件／agent 接入）

- **契約入口**：`GET /capabilities` → `{ apiVersion, endpoints, events, sse, fileTypes, selector, pageFiles, auth }`。整合方啟動時先讀它，用 `apiVersion` 判斷相容。
- **版本**：`apiVersion` 只在破壞性變更時 +1（移除／改名端點或欄位、改語義）；新增端點／欄位不 +1。擴充功能本身用語意化版本（manifest／package／CLI／MCP 四處同步）。
- **來源限制**：Hub 只綁 `127.0.0.1`。請求若帶 `Origin`，只接受 `chrome-extension://`（及 moz/edge）與本機頁面；一般網站一律 403（防 CSRF）。`ACE_HUB_EXTENSIONS=<id1>,<id2>` 可只允許指定擴充功能；`ACE_HUB_TOKEN` 可要求 `X-Hub-Token`。
- **其他擴充功能呼叫方式**：在它的 manifest 加 `host_permissions: ["http://127.0.0.1:8788/*"]`，由 service worker `fetch`（content script 不行：https 頁面不能打 http localhost）。
- **事件**：`{ type, at(ms), seq, source, task_id? | task_ids?, ... }`；新事件型別要加到 `EVENT_TYPES` 與本文件；消費方必須忽略不認得的型別與欄位。
- **業務寫入**由同一 Hub 管理：耗時生成、研究與回收進有限背景工作；短預覽、回饋與控制狀態使用交易寫入。整合方不要直接改 `%LOCALAPPDATA%\AceMusicDL\*.json` 或 SQLite。

## 7. 安全與成本

- **可能扣 credit 的站點動作**（MIDI／MusicXML 生成、任何寫入型 API）：自動流程預設不做，需使用者明確勾選或指令；新功能比照。
- **破壞性動作預設預覽**：刪除／搬移要 `commit`（CLI `--commit`）；MCP 工具對刪除只提供預覽（例：`ace_backups`）。
- 不刪 `音頻分類` hardlink、不自動刪母帶；搬走的檔案進 `organize-backups`。
- 不把 session／Cookie／個資寫進 repo、日誌、回應（`probe` 只回方案與模型）。

## 8. 效能預算（`node scripts/bench.mjs`）

| 項目 | 預算（p50） |
|---|---|
| Hub 讀取端點（health／overview／songs／events） | < 5 ms |
| Hub `/locate` | < 10 ms |
| MCP 工具呼叫（走 Hub） | < 10 ms |
| 新歌出現在面板（SSE） | < 1 s（e2e S12 斷言 < 3 s） |
| 面板操作 | 不得因背景同步／匯出而卡頓（一律非同步） |

- Hub 讀取走記憶體快照＋stale-while-revalidate，不得在請求路徑上等站點。
- 連 Hub 一律用 `hubclient.mjs`（不要用全域 `fetch`：Windows 上每次 ~15 ms）。

## 9. 測試要求

- 新的純函式 → `test/unit/*.test.mjs`；新的 Hub 端點／MCP 工具 → 單元測試起一個隔離 Hub（`ACE_STATE_DIR` 指向暫存目錄）。
- 面板行為 → `test/e2e.mjs` 情境（mock 站 `test/mock-server.mjs` 要先支援對應 API）。
- e2e 一次只跑一個；需要 `PLAYWRIGHT_PATH`。
- 發佈前：單元＋e2e 全綠、`npm run pack`、`install-host.ps1`、重啟 Hub、`bench.mjs` 不超預算。

## 10. 程式風格

- ESM（agent）／classic script（src，MV3 content script 限制）；不用 `eval`／`new Function`（e2e S0 檢查）。
- 註解寫「為什麼」（中文可），對外訊息用繁體中文、可直接給使用者看。
- 錯誤訊息要可行動（說清楚使用者下一步做什麼）。
