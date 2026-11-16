# ACE Music 批量下載器 — 說明文檔

> 適用版本 1.7.x｜Chrome／Edge MV3 擴充功能＋本機 Agent 中樞（CLI／MCP／Hub）

## 1. 這是什麼

在 [acemusic.ai](https://acemusic.ai/create/) 上製作 AI 歌曲後，這個插件會：

1. **自動取得**你帳號裡歌曲的所有可下載資源：分軌（stems）、MIDI、MusicXML、完整 MP3、完整 WAV、封面。
2. **自動命名、按檔案屬性分類**到 `下載\ai音樂\` 底下（成品MP3／成品WAV／採樣包／MIDI／MusicXML／封面…）。
3. **不重複下載**，並如實顯示每首歌缺什麼（例如站點不提供 MIDI 時標「MIDI 不可用」）。
4. 把「歌單、狀態、檔案在哪」**即時交給本機 agent**：CLI、MCP 工具、常駐 Hub 毫秒級回答「最新那首歌在哪個資料夾、有哪些檔」。

它只用你自己的登入 session 操作你自己的歌曲；不下載他人內容，也不繞過站點方案限制。

## 2. 三個角色

```
 網頁（已登入的 acemusic.ai/create 分頁）        本機中樞                         Agent
 ┌───────────────────────────────┐   native   ┌──────────────────────────┐  HTTP  ┌──────────────┐
 │ 面板（Shadow DOM）               │ messaging │ %LOCALAPPDATA%\AceMusicDL │ ─────▶ │ CLI           │
 │ • 讀歌單／站點檔案 API             │ ────────▶ │ • page-songs.json 歌單快照 │        │ MCP（stdio） │
 │ • chrome.downloads 下載           │           │ • agent-state.json 狀態    │ ◀───── │ 其他 agent    │
 │ • 送歌單快照／不可用紀錄給本機       │           │ • Hub 127.0.0.1:8788      │  SSE   └──────────────┘
 └───────────────────────────────┘           │   記憶體快照＋job 佇列        │
                                              │ • watcher 背景整理           │
                                              └──────────────────────────┘
```

| 角色 | 負責 | 為什麼這樣分 |
|---|---|---|
| **網頁面板** | 看得到登入後的歌單、呼叫站點 API、用瀏覽器下載 | 只有網頁擁有有效登入；session 不必常駐本機 |
| **本機中樞**（native host＋Hub＋watcher） | 改名／搬檔／分類、保存狀態、回答查詢 | 檔案系統操作與毫秒級查詢 |
| **Agent 介面**（CLI／MCP） | 給 agent 下指令、拿路徑 | 標準化、免瀏覽器 |

## 3. 下載內容與分類規則

### 3.1 每首歌可下載的資源

| 資源 | 來源 | 備註 |
|---|---|---|
| 分軌（Vocals、Drums、Bass…） | 站點已分離的 stems（MP3 128 kbps） | 需該歌已做分軌；站點目前沒有 WAV 分軌 |
| MIDI | 站點生成（`POST download`，等待後取得） | 部分歌站點回 `no_download`（沒有）；有速率限制；**生成可能扣 credit** |
| MusicXML | 同上 | 同上 |
| 完整 MP3 | 歌曲音檔 | 一定有 |
| 完整 WAV | 站點 file API | 只有部分模型（如 `acemusic-v1.1`）提供；48 kHz／16-bit |
| 封面 | 歌曲封面圖 | |

### 3.2 下載後的位置（一鍵整理後）

| 類型 | 資料夾 | 檔名範例 |
|---|---|---|
| 完整 MP3 | `ai音樂\成品MP3\` | `歌名.mp3` |
| 完整 WAV | `ai音樂\成品WAV\` | `歌名.wav` |
| MP3 分軌 | `ai音樂\採樣包\<樂器>\` | `採樣包\Vocals\歌名 - Vocals.mp3` |
| WAV 分軌 | `ai音樂\採樣包WAV\<樂器>\` | （站點開放後才會有） |
| MIDI | `ai音樂\MIDI\` | `歌名 - MIDI.mid` |
| MusicXML | `ai音樂\MusicXML\` | `歌名 - MusicXML.musicxml` |
| 封面 | `ai音樂\封面\` | `歌名 - Cover.jpg` |
| 壓縮檔／其他 | `ai音樂\壓縮檔\`、`ai音樂\其他\` | |
| 音頻屬性檢視 | `ai音樂\音頻分類\{完整歌曲,分軌,其他音檔}\{BPM,Key,Energy,類型}\` | **hardlink**，不佔額外空間 |

- 樂器資料夾：Vocals、Backing vocals、Drums、Percussion、Bass、Guitar、Keys、Strings、Brass、Woodwinds、Synth、FX、Instrumental、Other。
- BPM 每 5 一格（`120-125`）；Key 用 Camelot（`8A`、`11B`）；Energy 分 `Low／Mid／High`。
- 同名不同 take：`歌名 (2)`、`歌名 (3)`，各自獨立，不當重複。

### 3.3 一鍵整理流程

`舊檔改名 → 成品MP3 → 成品WAV → 採樣包／採樣包WAV → 檔案分類（MIDI／MusicXML／封面／壓縮檔／其他）→ 內容去重 → 空殼清理 → 音頻屬性分類（hardlink）`

- **內容去重**：相同內容（size→sha256）只留一份，其餘搬到 `%LOCALAPPDATA%\AceMusicDL\organize-backups\`（不直接刪）。
- **hardlink 不是重複**：`音頻分類` 的檔案與原檔是同一份資料，刪了也省不到空間，還會讓 BPM／Key 檢視缺檔。

## 4. 狀態怎麼讀

面板每首歌的徽章：

| 顯示 | 意思 |
|---|---|
| `已下載` | 該歌所有應有項目都在（分軌每軌＋MIDI＋MusicXML＋封面） |
| `部分 x/y` | y 項中有 x 項；滑過徽章看是哪項缺 |
| `未下載` | 都還沒有 |
| `MIDI 不可用` | 站點對這首回 `no_download`，不計入 y，也不會再請求 |
| `MP3`／`WAV` 徽章 | 獨立顯示，不計入 y |

## 5. 安裝

1. `chrome://extensions` → 開發人員模式 → 「載入未封裝項目」→ 選 repo 根目錄。
2. （建議）安裝本機工具：`pwsh -File native\install-host.ps1` — 改名／整理／agent 通道都靠它。
3. 開 <https://acemusic.ai/create/> 並登入，右下角「批量下載」。
4. 給 agent 用：面板按「同步 Agent」；常駐 Hub：`node agent\cli.mjs hub --background`。

改了 `src/` 要到擴充功能頁按「重新載入」並重新整理站點分頁；改了 `agent/` 要重跑 `install-host.ps1` 並重啟 Hub。

## 6. 使用

### 6.1 面板
勾類型 → 選歌（或全選、只看未下載）→「下載選中」。完成後可「一鍵整理」或開「下載完自動整理」。

**即時同步**：面板訂閱站點的歌單推送（SSE），歌一完成就出現在清單（實測約 50 ms），不再每 8 秒全量重抓；推送斷線才退回輪詢。

**新歌自動下載**（選項「新歌自動下載」，預設關）：
- 只處理**開啟之後**完成的新歌，不會回頭掃舊歌。
- 下載上方勾選的類型；分軌會等分離完成，之後才出現的分軌會再補抓（已存在的檔案自動跳過）。
- **MIDI／MusicXML 預設不自動下載**：站點即時生成，可能扣 credit；要的話另勾「自動含 MIDI／MusicXML」。
- 下完若開了「下載完自動整理」，會接著分類。需要開著 acemusic.ai/create 分頁。

### 6.2 CLI（`node agent\cli.mjs …`）

| 指令 | 用途 |
|---|---|
| `doctor` | 登入、紀錄、頁面快照健康度 |
| `status [--json]` | 曲庫摘要（<100 ms） |
| `locate [--latest N\|--query 字\|--song id] [--views]` | **歌曲 → 本機真實目錄與檔案** |
| `list [--query] [--undownloaded] [--json]` | 歌單＋下載進度 |
| `download --all\|--song id [--types stems,midi,musicxml,mp3,wav,cover] [--dry-run] [--force]` | 下載 |
| `tidy-all` | 一鍵整理 |
| `dedupe-content [--commit]` | 內容去重（預設預覽） |
| `classify-audio` | 音頻屬性分類 |
| `hub --background\|--status\|--stop` | 常駐中樞 |
| `watch --background\|--status\|--stop` | 背景自動整理 |
| `cache [status\|clear] [--all]` | 快取（clear 預設保留音頻分析） |
| `library [--sizes]` | 曲庫分類總覽（每類資料夾、檔數、大小） |
| `events [--since seq] [--type t]` | 中樞事件（新歌、自動下載、下載完成） |
| `wait [--timeout 秒]` | 等下一首新歌（需 Hub＋站點分頁） |
| `probe` | 站點健康（唯讀：登入、方案、模型） |
| `backups [--keep-days 7] [--keep-last 1] [--max-mb N] [--prune --commit]` | 整理備份清單；預設只預覽，`--prune --commit` 才刪 |
| `masters` | 母帶清單（唯讀） |

開機自動啟動 Hub＋watcher（工作排程，可移除）：`pwsh -File scripts\install-autostart.ps1 [-DryRun|-Uninstall]`。

### 6.3 MCP（`node agent\mcp.mjs`，stdio）— agent 中樞

| 想做的事 | 工具 |
|---|---|
| 開場看狀態 | `ace_overview` |
| 最新那首歌的檔案在哪 | `ace_locate`（預設最新一首；`query`／`song_id`／`latest`） |
| 等我做完下一首、下載好給我路徑 | `ace_wait_new_song { wait_download: true }` |
| 最近發生什麼 | `ace_events` |
| 曲庫每類有多少 | `ace_library` |
| 把剛做好的歌全部抓下來 | `ace_download { latest: 1, types: ["all"] }` → `ace_job_status` → `ace_tidy { wait: true }` |
| 下載／整理 | `ace_download`（`song_ids`／`query`／`latest`／`all`）→ `ace_job_status`；`ace_tidy`；`ace_organize` |
| 維運 | `ace_backups`（只預覽）、`ace_masters`、`ace_probe`、`ace_hub_status` |

Hub 在跑時自動走 Hub（p50：overview 1.2 ms、locate 2.7 ms、list 0.5 ms）；不在時回落本地。

### 6.4 Hub API（`127.0.0.1:8788`）
`GET /health /capabilities /overview /songs /locate /library /page /page/events /wait /jobs/:id /events(SSE)`；`POST /download /tidy /dedupe /organize /warm /jobs/:id/cancel /shutdown`。詳見 `agent/HUB.md`。

**其他擴充功能／agent 接入**：先讀 `GET /capabilities`（`apiVersion` 判斷相容）；擴充功能要在自己的 manifest 加 `host_permissions: ["http://127.0.0.1:8788/*"]`，由 service worker 呼叫。一般網站的請求會被拒（403）。規範見 [CONVENTIONS.md](CONVENTIONS.md)。

## 7. 網頁 ↔ agent 怎麼「高速搬運」

- 站點 → 面板：訂閱 `/api/songs/events` 推送，版本變了才抓 `/api/songs/changes` 增量。
- 面板 → 本機：精簡歌單寫 `page-songs.json`（變動時＋每 5 分鐘心跳）；站點回 `no_download` 時寫 `page-unavailable.json`；新歌／自動下載／下載完成寫 `page-events.json`。
- 本機 → agent：Hub 監看這三個檔，一變就重建記憶體快照、推 SSE、喚醒 `/wait` 長輪詢——agent 不必等 TTL、不必連網、不需要 session。
- 登入過期或離線時，唯讀查詢（list／overview／locate）自動改用「頁面快照或舊快取」中較新的一份；下載仍需有效 session。

## 8. 常見問題

| 問題 | 原因／處理 |
|---|---|
| 「部分 2/3」 | 三項（MIDI＋MusicXML＋封面）缺一，通常是 MIDI；若站點不提供，下次請求後會變「MIDI 不可用」 |
| WAV 沒下載 | 該歌模型不提供 WAV，自動跳過 |
| agent 說登入過期 | 面板按「同步 Agent」（開著站點分頁時每 30 分鐘自動同步） |
| 一次很多 MIDI 失敗 | 站點限流（429），插件會等待重試，仍限流就停止並提示 |
| 想刪 `音頻分類` 的「重複」 | 不要；那是 hardlink |
| Hub 起不來 | 已有一個 Hub 在跑（`hub.lock`）或 8788 被佔用 |

## 9. 資料與隱私

- 狀態：`chrome.storage.local`、`%LOCALAPPDATA%\AceMusicDL\`（session.json、history.json、agent-state.json、page-*.json、cache\）。
- 不連第三方伺服器；Hub 只綁 `127.0.0.1`。
