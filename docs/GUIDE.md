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
| 完整 MP3 | 歌曲音檔 | 生成歌曲提供；原始上傳不是 MP3 時，不另改副檔名冒充 MP3 |
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
| 收藏（喜歡的歌） | `ai音樂\收藏\<歌名>\` | 整首歌的檔案複製一份（站點點讚 ∪ 面板愛心）；只複製、原檔不動 |

- 樂器資料夾：Vocals、Backing vocals、Drums、Percussion、Bass、Guitar、Keys、Strings、Brass、Woodwinds、Synth、FX、Instrumental、Other。
- BPM 每 5 一格（`120-125`）；Key 用 Camelot（`8A`、`11B`）；Energy 分 `Low／Mid／High`。
- 同名不同 take：`歌名 (2)`、`歌名 (3)`，各自獨立，不當重複。

### 3.3 一鍵整理流程

`舊檔改名 → 成品MP3 → 成品WAV（乾淨名字複製到 整理輸出\成品WAV\，來源不動）→ 採樣包／採樣包WAV → 檔案分類（MIDI／MusicXML／封面／壓縮檔／其他）→ 內容去重 → 空殼清理 → 音頻屬性分類（hardlink）→ 收藏夾 → 指紋清除 → 已點讚`

- **不會重複跑**：連續觸發（下載完自動整理、面板按鈕、CLI、Hub、MCP 同時來）會合併成一輪。跑的那一輪持有 `%LOCALAPPDATA%\AceMusicDL\tidy-run.lock`；其他觸發只寫 `tidy-pending.json`，不會排隊等租約再跑一次完整管線，而是在那一輪結束後最多補跑一輪。持有者行程已結束留下的過期鎖會自動清掉。合併掉的那次不寫 `tidy-status.json` 的 `done`，面板進度條仍跟著真正在跑的那一輪。

- **內容去重**：相同內容（size→sha256）只留一份，其餘搬到 `%LOCALAPPDATA%\AceMusicDL\organize-backups\`（不直接刪）。
- **hardlink 不是重複**：`音頻分類` 的檔案與原檔是同一份資料，刪了也省不到空間，還會讓 BPM／Key 檢視缺檔。
- **收藏夾**：把 acemusic.ai 上按過拇指向上（`meta.rating === "good"`）與面板播放器按過愛心的歌，每首取一個**成品 WAV 母帶**複製成 `ai音樂\收藏\<歌名>.wav`（平鋪一層，不建子資料夾）。站點只有 MP3 的歌沒有母帶可收，計入 `noWav`（檔案仍在 `成品MP3`／`已點讚`）。只複製、不搬原檔；內容相同就跳過，同名不同內容不覆寫（`favorites --force` 才覆寫，舊檔先歸檔）。清單在 `收藏\_收藏清單.json`；未被喜歡的歌不會被收進來，取消喜歡後已複製的檔也不會自動刪除。1.8.9 起舊版 `收藏\<歌名>\` 子資料夾與其中的 MP3／分軌／封面會在整理時清掉（只刪我們放的、大小沒變的檔，使用者改過的一律保留）。整理流程（含「下載完自動整理」）每次都會補齊；也可單獨跑 `node agent\cli.mjs favorites [--dry-run]`。
- **指紋清除**：把既有檔案裡的 ACE metadata 就地抹掉——WAV 的 `LIST/INFO`（IART／ICMT／ISFT…）、`id3`／`bext`／`iXML`／`XMP`，MP3 的 `TSSE`／`TENC`、含 `ACE Music` 的 `COMM`、指向 `acemusic.ai` 的 `WOAS`；標題、藝人、專輯、BPM、調性、封面、歌詞保留。就地覆寫不改變檔案長度與 inode（硬連結的音頻分類檢視同步），原 bytes 存 `%LOCALAPPDATA%\AceMusicDL\fingerprint-backups\`，`strip-fingerprints --restore` 可還原。新下載的檔案會自動清，舊檔用一次整理或 `node agent\cli.mjs strip-fingerprints` 補齊。

### 3.4 維護功能一覽：指紋、分類、命名

| 功能 | 自動時機 | 手動入口 | 產物／紀錄 |
|---|---|---|---|
| 指紋清除 | 下載寫檔前（WAV＋MP3）；一鍵整理最後一步 | 面板「維護 → 指紋清除」、`cli.mjs strip-fingerprints [--dry-run\|--restore]` | 就地抹掉 ACE metadata；`fingerprint-backups\` 可還原；已驗證音檔的 sha256 同步更新 |
| 自動分類 | 一鍵整理、下載完自動整理、背景自動整理 | 面板「維護」內各按鈕；`extract-mp3`／`extract-samples`／`classify-files`／`classify-audio` | 成品MP3／WAV（WAV 分類後把乾淨名字複製到 `整理輸出\成品WAV\`，來源不動、兩首同名依 task 編號 `(2)(3)`）、採樣包（按樂器）、MIDI／MusicXML／封面、音頻分類（hardlink，不佔空間） |
| 命名（命名爐） | 下載時只套標準檔名（`<歌名> - Vocals.mp3`）；命名爐本身要人工「採用」 | 面板「維護 → 命名爐」 | 同組分軌／版本一個雙語名（銘／儀／並／抽）；改名紀錄 `_命名爐改名紀錄.json`，套用後自動重建本機索引並通知面板 |

三個功能的分工：**命名爐**決定歌怎麼叫、**分類**決定檔案放哪裡、**指紋清除**決定檔案裡留下什麼。命名爐在擴充功能頁面套用改名後會自動重建索引（檔案模式仍提示回面板「維護 → 一鍵整理」）。

## 4. 狀態怎麼讀

面板每首歌的徽章：

| 顯示 | 意思 |
|---|---|
| `已下載` | 目前勾選且適用的類型都在，包含 MP3／WAV；只按該歌曲自己的來源證據判斷 |
| `部分 x/y` | y 項中有 x 項；滑過徽章看是哪項缺 |
| `缺 MP3／WAV…` | 已完成本機核對，缺少列出的類型 |
| `待核對 MP3…` | 有候選檔案但來源對應不夠明確；不當作確定缺檔 |
| `本機核對未就緒` | 本機工具尚未提供索引；未知不等於沒有檔案 |
| `MIDI 不可用` | 站點對這首回 `no_download`，不計入 y，也不會再請求 |
| `MP3`／`WAV` 徽章 | 分別顯示；目前有勾選時也計入 y |

## 5. 安裝

1. `chrome://extensions` → 開發人員模式 → 「載入未封裝項目」→ 選 repo 根目錄。
2. （建議）安裝本機工具：`pwsh -File native\install-host.ps1` — 改名／整理／agent 通道都靠它。
3. 開 <https://acemusic.ai/create/> 並登入，右下角「批量下載」。
4. 給 agent 用：面板按「同步 Agent」；常駐 Hub：`node agent\cli.mjs hub --background`。

改了 `src/` 要到擴充功能頁按「重新載入」並重新整理站點分頁；改了 `agent/` 要重跑 `install-host.ps1` 並重啟 Hub。

## 6. 使用

### 6.1 面板
勾類型 → 選歌（或全選、只看未下載）→「下載選中」。完成後可「一鍵整理」或開「下載完自動整理」。

**擺放與透明度**：拖標題列移動面板、直接拖右下角「批量下載」按鈕換位置（點一下才開面板）；標題列「透明」滑桿調 40–100%；雙擊標題列回到預設位置。設定都會記住。

**即時同步**：面板訂閱站點的歌單推送（SSE），新完成的歌以增量更新，推送斷線才退回輪詢。本機驗證紀錄另外檢查版本；後臺補好 MP3/WAV 後，自動更新對應歌曲與待補篩選，無需刷新整個頁面。

**下載設定與範圍**：六種類型預設勾選，設定區預設收合，保留你後來手動儲存的選擇。MIDI/MusicXML 只排入這首歌已主動要求分軌的情況；沒有分軌紀錄的歌曲不會因缺樂譜被列為待補。WAV 與樂譜分開處理，可用 WAV 獨立下載，包含上傳的原始 WAV。

**老歌新增分軌**：自動下載分軌開啟後，先建立現有曲庫基線；日後某首老歌的分軌就緒或版本更新，便自動下載可取得的軌道。此功能不替你購買分軌，重新整理頁面也不會重送已提交的樂譜生成。

**獨立播放器**：按面板「獨立播放器」或歌曲播放鍵，開啟可拖動／調整大小的視窗。歌曲播放鍵先定位該歌，不立即出聲；在播放器按播放才開始。搜尋、本機檔案、佇列、播放清單、收藏、歷史及下載狀態見 [播放器說明](../player/README.md)。

**新歌自動下載**（選項「新歌自動下載」，預設關）：
- 只處理**開啟之後**完成的新歌，不會回頭掃舊歌。
- 下載上方勾選的類型；分軌會等分離完成，之後才出現的分軌會再補抓（已存在的檔案自動跳過）。
- **MIDI／MusicXML 預設不自動下載**：站點即時生成，可能扣 credit；要的話另勾「自動含 MIDI／MusicXML」。
- 下完若開了「下載完自動整理」，會接著分類。需要開著 acemusic.ai/create 分頁。

**卡住時複製診斷**：面板底部按「複製診斷」，取得最近最多 200 筆工作紀錄；包含 UTC 時間、工作階段、準備／下載數量及經清理的錯誤，不含完整網址、Cookie 或權杖。擴充功能重新載入後，舊 ACE 分頁必須刷新；連線失效時仍可複製診斷，剪貼簿不可用則會提供可選取的文字。紀錄先保存在同分頁的 `sessionStorage`；本機工具可用時，會節流寫入 `%LOCALAPPDATA%\AceMusicDL\download-log.json`，下載期間每 30 秒記一次心跳。此功能必須載入新版後才開始記錄，無法還原先前卡住工作的詳細日誌。

CLI／Hub／MCP 的下載另外在 `%LOCALAPPDATA%\AceMusicDL\agent.log` 保存同一 run ID 的開始、逐檔完成／略過／錯誤代碼與結束計數；樂譜提交記 task ID／類型／次數，不記 Cookie 或完整檔案網址。音檔成功與狀態保存失敗分開回報。

維護者手動核對（尚未驗收）：在隔離工作中確認開始／停止／錯誤及心跳有紀錄；重新載入擴充功能後確認舊頁會停止並仍能複製診斷；刷新原分頁後確認舊紀錄保留，且安裝本機工具時可寫入 `download-log.json`。不得為測試診斷觸發付費 MIDI／MusicXML 生成。

### 6.2 CLI（`node agent\cli.mjs …`）

| 指令 | 用途 |
|---|---|
| `doctor` | 登入、紀錄、頁面快照健康度 |
| `status [--json]` | 曲庫摘要（<100 ms） |
| `locate [--latest N\|--query 字\|--song id] [--views]` | **歌曲 → 本機真實目錄與檔案** |
| `local-index [--root 名稱] [--full] [--json]` | 只讀本機下載證據索引，不連站點 |
| `player [--background] [--json]` | 啟動獨立播放器服務；不提交生成或下載 |
| `list [--query] [--undownloaded] [--json]` | 歌單＋下載進度 |
| `download --all\|--song id [--types stems,midi,musicxml,mp3,wav,cover] [--dry-run] [--force]` | 下載 |
| `tidy-all` | 一鍵整理 |
| `favorites [--dry-run] [--force] [--sync]` | 站點點讚／面板愛心的歌複製到 `ai音樂\收藏\` |
| `strip-fingerprints [--dry-run\|--restore]` | 就地抹掉既有檔案裡的 ACE metadata 指紋 |
| `wav-names [--dry-run]` | 成品WAV 複製乾淨名字到 `整理輸出\`（來源不動） |
| `dedupe-content [--commit]` | 內容去重（預設預覽） |
| `classify-audio` | 音頻屬性分類 |
| `hub --background\|--status\|--stop` | 常駐中樞 |
| `watch --background\|--status\|--stop` | 背景自動整理（含收藏夾、已點讚） |
| `cache [status\|clear] [--all]` | 快取（clear 預設保留音頻分析） |
| `library [--sizes]` | 曲庫分類總覽（每類資料夾、檔數、大小） |
| `events [--since seq] [--type t]` | 中樞事件（新歌、自動下載、下載完成） |
| `wait [--timeout 秒]` | 等下一首新歌（需 Hub＋站點分頁） |
| `probe` | 站點健康（唯讀：登入、方案、模型） |
| `generate --request request.json [--json]` | v1.1 直接生成預覽；實際提交另需 `--commit --confirm-credit-spend --max-credits N --idempotency-key KEY` |
| `generation-status --task-ids id1,id2 [--json]` | 依任務 ID 唯讀查詢生成狀態 |
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
| 核對歌曲下載證據 | `ace_download_index` |
| 網站原生拇指點讚 | `ace_site_likes`（播放器「網站點讚」檢視同一來源） |
| 開啟播放器入口 | `ace_player` |
| 曲庫每類有多少 | `ace_library` |
| 把剛做好的歌全部抓下來 | `ace_download { latest: 1, types: ["all"] }` → `ace_job_status` → `ace_tidy { wait: true }` |
| 下載／整理 | `ace_download`（`song_ids`／`query`／`latest`／`all`）→ `ace_job_status`；`ace_tidy`；`ace_organize` |
| 維運 | `ace_backups`（只預覽）、`ace_masters`、`ace_probe`、`ace_hub_status` |
| 預覽／生成 v1.1 | `ace_generate`（預設只預覽；提交需確認、額度上限與防重送 key） |
| 查看生成進度 | `ace_generation_status { task_ids: ["任務ID"] }` |

Hub 在跑時自動走 Hub。讀取可本地回落；寫入只在確認沒有建立連線時回落，提交後結果未知不會換一路重送，應查 job ID。
Hub 在跑時自動走 Hub（p50：overview 1.2 ms、locate 2.7 ms、list 0.5 ms）；既有功能在 Hub 不可用時可回落本地。付費生成只允許經支援生成的 Hub 提交，避免逾時重送。詳細流程見 [直接生成說明](../agent/DIRECT-GENERATION.md)。

### 6.4 Hub API（`127.0.0.1:8788`）
`GET /health /capabilities /overview /songs /locate /library /page /page/events /wait /jobs/:id /events(SSE)`；`POST /download /tidy /dedupe /organize /warm /jobs/:id/cancel /shutdown`。詳見 `agent/HUB.md`。

**其他擴充功能／agent 接入**：先讀 `GET /capabilities`（`apiVersion` 判斷相容）；擴充功能要在自己的 manifest 加 `host_permissions: ["http://127.0.0.1:8788/*"]`，由 service worker 呼叫。一般網站的請求會被拒（403）。規範見 [CONVENTIONS.md](CONVENTIONS.md)。

### 6.5 命名爐

面板曲庫工具列有「命名爐」按鈕（預設顯示），按一下會開新分頁。

1. 按「連接 ai音樂」授權 `Downloads\ai音樂` 資料夾（Chrome 會記住；只需一次）。
2. 頁面讀取 `音頻分類\_manifest.json` 與 `成品MP3\_manifest.json`，把同一首歌的分軌／版本分成一組。
3. 預設「每組一首」：只列每組代表；按 `R` 重擲、`↵` 採用會套用到整組。
4. 體裁可選：自動／銘／儀／並／抽（抽象：`X 的 Y` / `The Y of X`）。
5. 按「套用改名」直接改本機檔名（保留 ` - Bass`、`(2)` 等後綴）。
6. 改完回面板按「一鍵整理」重建索引；再回命名爐重新連接，就會看到新檔名。

命名爐只讀你授權的資料夾，不上傳；不影響下載流程。

每次改名都會即時寫入曲庫根目錄的 `_命名爐改名紀錄.json`（舊路徑 → 新路徑、時間、大小）。本機索引把它當成搬移紀錄，所以改名後的歌曲仍算「已下載」，不會被當成缺檔重下；需要復原時也可依這份紀錄改回。若這份紀錄無法讀取，命名爐會停止改名，不會留下沒有紀錄的改名。

## 7. 網頁 ↔ agent 怎麼「高速搬運」

- 站點 → 面板：訂閱 `/api/songs/events` 推送，版本變了才抓 `/api/songs/changes` 增量。
- 面板 → 本機：精簡歌單寫 `page-songs.json`（變動時＋每 5 分鐘心跳）；站點回 `no_download` 時寫 `page-unavailable.json`；新歌／自動下載／下載完成寫 `page-events.json`。
- 本機 → agent：Hub 監看這三個檔，一變就重建記憶體快照、推 SSE、喚醒 `/wait` 長輪詢——agent 不必等 TTL、不必連網、不需要 session。
- 登入過期或離線時，唯讀查詢（list／overview／locate）自動改用「頁面快照或舊快取」中較新的一份；下載仍需有效 session。

## 8. 常見問題

| 問題 | 原因／處理 |
|---|---|
| 「部分」或「所選類型待補」 | 只計目前勾選的類型，包含 MP3/WAV；只勾 MP3 時不會因缺 MIDI 被列為未下載 |
| WAV 沒下載 | 先看模型能力、實際檔案及錯誤；ACE-Step 不提供 WAV，但 400/404/502 不代表其他歌曲永遠沒有 WAV |
| 卡在 55%／67% | 1.7.4 修復舊分頁連線失效及限流後佇列提前退出。重新載入擴充功能後，必須刷新 ACE 分頁；「複製診斷」可查看階段與原因 |
| agent 說登入過期 | 面板按「同步 Agent」（開著站點分頁時每 30 分鐘自動同步） |
| 一次很多 MIDI 失敗 | 站點限流（429），插件會等待重試，仍限流就停止並提示 |
| 想刪 `音頻分類` 的「重複」 | 不要；那是 hardlink |
| Hub 起不來 | 已有一個 Hub 在跑（`hub.lock`）或 8788 被佔用 |

## 9. 資料與隱私

- 狀態：`chrome.storage.local`、`%LOCALAPPDATA%\AceMusicDL\`（session.json、history.json、agent-state.json、page-*.json、cache\）。
- 不連第三方伺服器；Hub 只綁 `127.0.0.1`。
