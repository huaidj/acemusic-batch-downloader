# ACE Music 批量下載器 — Agent 接入（CLI / MCP / Skill）

給 AI agent（Claude Code、Codex、DSH、Cursor…）用的無頭介面。agent 可以直接：

此隔離分支新增音樂準備與完整 Create API，沿用此 MCP／CLI 與 Hub。預設不提交生成；權限、單輪及整批預算由伺服器的獨立有限授權檔控制。[創作工作台](MUSIC-AGENT.md) · [完整 Create 參數](CREATE-API.md)。

| 工具 | 用途 |
|---|---|
| `music_capabilities` | 創作詞典與三模型文件能力 |
| `music_dictionary_query` | 版本化中英詞條 |
| `music_reference_register` | 本機連結登記，Spotify AI 路徑關閉 |
| `music_intent_prepare` | 音樂方向／來源檢查 |
| `music_prompt_compile` | 可重現提示詞與版本快照 |
| `music_session_create` | 有限本機準備批次 |
| `music_generation_prepare` | 審閱後登記待授權任務 |
| `music_generation_submit` | 產物閉環未串接，固定 unsupported |
| `music_job_status` | 準備任務狀態 |
| `music_events` | 持久事件與游標 |
| `music_session_stop` | 停止本機批次 |
| `music_assets_query` | 本流程已核驗的音訊產物 |
| `music_feedback_record` | 無實際產物則拒絕人類試聽評分 |
| `music_state` | 共用本機狀態 |
| `ace_create_capabilities` | 完整前端參數與條件契約 |
| `ace_create_prepare` | 純本機組裝 HTTP 請求 |
| `ace_create_preview` | 只 GET 即時模型、限制、報價 |
| `ace_create_submit` | 伺服器有限授權及預留後單次提交 |
| `ace_create_authority` | 授權／預留／支出摘要 |
| `ace_create_task_status` | 三模型通用遠端狀態，非產物驗收 |
| `ace_create_receipt` | 持久幂等收據 |
| `ace_create_stop` | 停止新提交，保留未知結果預留 |

- 列出使用者 ACE Music 帳號裡「已完成」的歌曲
- 一次下載整首歌的分軌（stems）、MIDI、MusicXML、MP3、封面圖
- 下載前自動比對本機檔案與 Chrome 下載紀錄，已下載過的不會重複下載
- 依「歌名 / 分軌名」自動改名、分類到 `下載/ai音樂/<歌名>/`
- 整理之前用站點按鈕下載、散落在 Downloads 的檔案（改名＋搬到正確資料夾）

```
agent/
  cli.mjs                 CLI 主程式（node agent/cli.mjs …）
  ace-dl.cmd              Windows CLI 啟動器
  mcp.mjs                 MCP stdio server（node agent/mcp.mjs）
  start-mcp.cmd           Windows MCP 啟動器
  mcp-config.example.json MCP 宿主組態範例
  SKILL.md                agent skill 說明（DSH/Claude Skill 格式）
  lib/
    ace.mjs               ACE API / 下載 / 整理核心
    config.mjs            路徑、環境變數
    shared.mjs            載入擴充功能的 naming.js / planner.js
```

## 0. 先決條件：匯出登入狀態

CLI/MCP 直接呼叫 acemusic.ai 的 API，需要使用者瀏覽器的登入 Cookie：

1. Chrome 開 <https://acemusic.ai/create/>（登入狀態）
2. 右下角「批量下載」面板 → 按「**同步 Agent**」
3. 擴充功能會透過本機工具寫出：
   - `%LOCALAPPDATA%\AceMusicDL\session.json`（Cookie）
   - `%LOCALAPPDATA%\AceMusicDL\history.json`（Chrome 下載紀錄，整理舊檔用）
4. 之後擴充功能每 30 分鐘自動重新匯出；登入過期時再按一次即可

> session.json 等同登入憑證，只留在本機；不要外傳或貼進對話。

## 1. CLI

```powershell
$cli = "<專案根目錄>\agent\cli.mjs"

node $cli doctor                      # 環境 / 登入檢查
node $cli list                        # 歌曲列表（含已下載/部分/未下載）
node $cli list --undownloaded         # 只列還沒下載完的歌
node $cli list --query "薩滿" --json  # 搜尋（JSON 給 agent 解析）
node $cli download --all              # 全部：分軌 + MIDI（預設）
node $cli download --song so_xxx --types stems,midi,musicxml,mp3,cover
node $cli download --all --dry-run    # 只看會下載哪些檔案
node $cli organize                    # 預覽整理（改名＋移動）
node $cli organize --commit           # 實際整理
```

常用參數：

| 參數 | 說明 |
| --- | --- |
| `--types stems,midi,musicxml,mp3,cover` | 要下載的類型（預設 `stems,midi,cover`）；WAV 站點大多沒有，不提供 |
| `--root ai音樂` | 最上層資料夾 |
| `--force` | 已下載過也重下 |
| `--concurrency 1-6` | 並行數（預設 4，MIDI 生成會與分軌下載重疊） |
| `--type-folders` | 依類型分層 `Stems/ MIDI/ Audio/` |
| `--dry-run` | 只輸出清單 |
| `--json` | 機器可讀輸出 |
| `--conflict skip\|unique\|overwrite` | 整理時同名檔處理（預設 skip） |

環境變數（測試／換站點用）：`ACE_BASE_URL`、`ACE_STATE_DIR`、`ACE_DOWNLOAD_DIR`、`ACE_UA`。

## 2. MCP

### Claude Code

```powershell
claude mcp add ace-music-downloader -- node "<專案根目錄>\agent\mcp.mjs"
```

### 通用 mcpServers JSON（Claude Desktop / Cursor / 其他）

```json
{
  "mcpServers": {
    "ace-music-downloader": {
      "command": "node",
      "args": ["F:\\code\\acemusic-batch-downloader\\agent\\mcp.mjs"]
    }
  }
}
```

### Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.ace-music-downloader]
command = "node"
args = ["F:\\code\\acemusic-batch-downloader\\agent\\mcp.mjs"]
```

### 工具

| 工具 | 說明 |
| --- | --- |
| `ace_session_status` | 登入狀態 / session 匯出時間 |
| `ace_list_songs` | 列出歌曲（`query` 過濾、`only_undownloaded` 只看未下載；含 `downloaded` 進度） |
| `ace_download` | 建立下載 job；`song_ids`／`query`／`all`、`types`、`force`、`dry_run` |
| `ace_job_status` | 查 job 進度與結果 |
| `ace_job_cancel` | 取消 job（已完成檔案保留） |
| `ace_organize` | 整理舊檔：`dry_run`（預設 true）、`commit=true` 才移動 |
| `ace_overview` | 登入＋曲庫統計（開場首選，Hub 下約 1 ms） |
| `ace_locate` | **歌曲 → 本機真實目錄與檔案絕對路徑**；預設最新一首，`query`／`song_id`／`latest`；免網路、免登入 |
| `ace_wait_new_song` | 等下一首新歌完成；`wait_download:true` 再等自動下載完成並回 locate 結果（需 Hub＋開著站點分頁） |
| `ace_events` | 中樞事件：`song_new`、`auto_download`、`download_done`；`since`（seq）增量 |
| `ace_library` | 曲庫分類總覽（成品MP3／WAV、採樣包各樂器、MIDI、MusicXML、封面…），`sizes:true` 算大小 |
| `ace_favorites` | 面板電臺裡收藏的歌曲清單（新 → 舊）；要路徑再用 `ace_locate { song_id }` |
| `ace_random_prompt` | 隨機提示詞（12×12 風格矩陣）：依「音樂模型＋模式」選詞典與字數上限（Idea→自然語言框、Custom→Style 框）；回傳文字＋追溯（格子、seed、詞典版本、字數／上限）。只有 acemusic-v1.1 有驗證過的詞典，其他模型回 `no_dictionary`（不硬截斷、不亂填）；只產生文字，不提交生成 |
| `ace_tidy` | 一鍵整理（成品MP3／WAV、採樣包、檔案分類、去重、音頻分類）；`wait:true` 等完成 |
| `ace_backups` | 整理備份清單＋依規則可刪預覽（MCP 只預覽，不刪） |
| `ace_masters` | 母帶清單（俱樂部版／舊版對照；WAV 取樣率／位元深度／長度，唯讀） |
| `ace_probe` | 站點健康（唯讀 `/api/status`：是否登入、方案、模型；不回個資） |
| `ace_generate` | 直接使用本機登入生成 ACE Music v1.1；預設只預覽。實際生成需明確額度上限、確認與防重送 key；必須有支援生成的 Hub |
| `ace_generation_status` | 依指定 `task_ids` 唯讀查詢生成進度、實際模型與音訊是否可用 |
| `ace_warm`／`ace_hub_status`／`ace_session_status` | 預熱快取／Hub 狀態／登入＋頁面通道狀態 |

典型「拿最新歌曲路徑」流程：`ace_locate {}` → 直接得到 `songs[0].dirs[].dir` 與 `files[].path`。
典型「把剛做好的歌全部抓下來」：`ace_download { latest: 1, types: ["all"] }` → `ace_job_status` → `ace_tidy { wait: true }` → `ace_locate {}`。
選歌參數（`song_ids`／`query`／`latest`／`all`）在 `ace_download`、CLI `download`、Hub `/download` 完全相同；沒有任何條件且 `all` 不是 true 時不會選任何歌。
其他插件接入：先讀 Hub `GET /capabilities`（見 `docs/CONVENTIONS.md` §6）。
直接生成的參數、費用及逾時處理見 [DIRECT-GENERATION.md](DIRECT-GENERATION.md)。
典型「做完歌自動拿檔」流程：使用者在面板開「新歌自動下載」→ `ace_wait_new_song { wait_download: true }`。

範例 agent 對話流程：

1. `ace_session_status` → 若未登入，請使用者按擴充功能「同步 Agent」
2. `ace_list_songs` → 讓使用者挑歌
3. `ace_download { song_ids: [...], types: ["stems","midi"] }` → `jobId`
4. 每 3~5 秒 `ace_job_status` 直到 `completed`
5. 需要清舊檔時 `ace_organize { dry_run: true }` 給使用者確認 → `{ commit: true }`

## 3. Skill

`agent/SKILL.md` 是 skill 格式說明，可直接放到宿主的 skills 目錄（本機已安裝在
`<你的技能目錄>\ace-music-downloader\SKILL.md`）。DSH 的 skill watcher 會熱載入。

## 4. 面板「整理舊檔」按鈕

擴充功能面板的「整理舊檔」按鈕會透過本機工具執行同一套 `organize`（預覽→執行），效果與 `node agent/cli.mjs organize --commit` 相同，不需要開終端機。

## 5. 與擴充功能的關係

- **下載引擎（擴充功能）**：使用者在頁面上操作時用 `chrome.downloads`；若 Chrome 沒採用指定檔名，會用已安裝的「本機整理工具」自動改名/移動（面板可關閉「自動修正檔名」）。
- **Agent 引擎（CLI/MCP）**：Node 直接呼叫站點 API 並寫檔，不需要開著頁面；登入狀態由擴充功能匯出。
- 兩者共用同一份 `%LOCALAPPDATA%\AceMusicDL\agent-state.json`（已下載紀錄、資料夾指派），所以不會重複下載、同名歌不會撞資料夾。

## 5. 除錯

```powershell
node agent/cli.mjs doctor --json
# 常見錯誤
# NO_SESSION / 找不到登入狀態 → 到擴充功能按「同步 Agent」
# AUTH_EXPIRED（HTTP 401）→ 重新登入 ACE 後再按一次「同步 Agent」
# 本機工具未安裝 → 執行 native\install-host.ps1
```

日誌：`%LOCALAPPDATA%\AceMusicDL\agent.log`（若啟用appendLog）與 CLI stderr。

## 6. 效能與本地快取（v1.3.0）

**核心：`library-snapshot`**（`%LOCALAPPDATA%\AceMusicDL\cache\library-snapshot.json`）一次算好歌單＋下載狀態，TTL 60s；`warm` 可預熱，下載／整理／去重後自動失效。

| 操作 | 之後 | 說明 |
| --- | --- | --- |
| `status` | **52–58ms** | 讀快照＋session 快取 |
| `list --json --compact` | **51ms / 20KB** | 精簡欄位 |
| `list --json`（完整） | **57ms / 95KB** | 需要細節才用 |
| `warm`（熱） | **64ms** | 冷啟動需重建快照（約 2–4s，含站點 API） |
| MCP `ace_overview` | **3ms** | 登入＋曲庫統計，開場首選 |
| MCP `ace_list_songs` | **1ms / 9KB** | 預設 50 筆＋精簡 |
| MCP `ace_warm` | **34ms**（熱） | 預熱；`refresh_session:true` 才連站點 |
| `classify-audio`（熱） | **0.2s** | 只重用成功分析 |
| `tidy-all`（熱） | **13–22s** | 含內容去重＋資料夾清理 |

可調環境變數：`ACE_SESSION_TTL_MS`（120000）、`ACE_FS_INDEX_TTL_MS`（180000）、`ACE_SNAPSHOT_TTL_MS`（60000）。
效能要點：查詢用 `--compact`／`--limit`；要最新站點資料才加 `--refresh`（約 2.5s）。

重複清理（歷史遺留）：

```powershell
node agent/cli.mjs dedupe-content            # 預覽：全庫相同內容（size→sha256），keeper 優先 成品WAV＝成品MP3 > 採樣包 > 歌名資料夾
node agent/cli.mjs dedupe-content --commit    # 搬移副本到 %LOCALAPPDATA%\AceMusicDL\organize-backups\content-*
node agent/cli.mjs dedupe-folders --commit    # 移除空資料夾
```

## 7. 已知行為（v1.3.0）

- `classify-audio`：只把「成功」的分析結果寫進快取；暫時失敗的檔案下次會重新分析。真的解不出音訊的檔案會列在 `音頻分類\_manifest.json` 的 `unanalyzable`（含原因），**不會**讓整趟整理變成失敗，也不會重試到天荒地老。
- `tidy-all` 的步驟新增 `wav`：歌名資料夾內的 WAV 會搬到 `成品WAV/`（`俱樂部版`／`sample` 等自訂資料夾不動），之後才做內容去重與空殼清理。`n- `tidy-all`／`watch`：`ok:false` 現在只代表有步驟發生「管線級」錯誤（例如 python 起不來）；單純幾首歌分析不了不算失敗。`watch --status` 會回 `alive`／`stale`／`running` 三個判定欄位，`stale:true` 就是上次中斷留下的紀錄。
- `mixdesk` 是獨立子系統（電台混音台），不屬於擴充功能；生成閉環預設只支援 `adapter=mock`，ACE 付費生成會明確拒絕，不會偷呼叫付費 API。
- 下載索引上限已提高到 200,000 筆（舊版 4,000 在 Downloads 長大後會截斷，導致誤判未下載而重複下載）。若你手動搬動大量檔案，可 `node agent/cli.mjs cache clear` 讓索引重建。
- `dedupe-folders` 只處理「內容完全相同」的副本與空資料夾；同名不同內容的歌不會被合併。
- `dedupe-content` 會把被移除的路徑記到 `agent-state.json` 的 `removedPaths`（有 history 的歌再加 `aliases`），所以下次批次下載會跳過、不會把去重掉的檔案抓回來。`--include-custom` 可把 `sample`／`WAI`／`WAMI` 等自訂資料夾一起納入（預設不動）。
- 快照 TTL 60s：`status`／`list` 可能落後最多 1 分鐘；要立即反映剛下載的檔案，先 `node agent/cli.mjs warm`（或加 `--refresh`）。


## 8. Agent Hub（v1.5.0）

```powershell
node agent\cli.mjs hub --background   # 啟動常駐（127.0.0.1:8788）
node agent\cli.mjs hub --status       # 查狀態
node agent\cli.mjs hub --stop         # 關閉
```

| 路徑 | 用途 |
| --- | --- |
| `GET /overview` | 快照摘要（2–9ms） |
| `GET /songs?limit=&q=&undownloaded=1&compact=1` | 歌單（2ms） |
| `POST /download` | 202 + jobId；支援 `idempotency_key`、`dry_run` |
| `GET /jobs/:id` / `POST /jobs/:id/cancel` | job 進度／取消 |
| `POST /tidy`、`/dedupe`、`/organize`、`/warm` | 背景 job |
| `GET /events` | SSE 事件流 |
 
MCP 工具會自動偵測 hub（`ACE_HUB_URL`），偵測不到就本地回落；`ace_hub_status` 可查是否連上。
`ACE_HUB_PORT`、`ACE_HUB_TOKEN`（選用）、`ACE_HUB_SNAPSHOT_TTL_MS` 可調。



