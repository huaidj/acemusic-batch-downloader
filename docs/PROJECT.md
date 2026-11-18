# 項目介紹：ACE Music 批量下載器（完整功能）

> 這份文件是**功能總覽**（介紹所有能力）；現行狀態與維護事實請看 [SSOT.md](SSOT.md)。
> 英文摘要見文末 [English summary](#english-summary)。

---

## 1. 這是什麼

在 [acemusic.ai](https://acemusic.ai/create/) 製作 AI 歌曲後，這個專案把「下載 → 命名 → 分類 → 給 agent 用」整條流程自動化：

1. **下載**：抓取你自己帳號裡每首歌的所有可下載資源——分軌（stems）、MIDI、MusicXML、完整 MP3、完整 WAV、封面。
2. **命名分類**：自動改名、依類型分到 `ai音樂\` 底下（成品MP3／成品WAV／採樣包／MIDI／MusicXML／封面…），硬連結建立 BPM／調性／能量檢視。
3. **不重複、不假裝**：已存在就跳過；站點不提供的項目標「不可用」，不拿別的格式冒充。
4. **交給 agent**：CLI、MCP（本地 stdio 與官方遠端兜底）、常駐 Hub 毫秒級回答「最新那首歌在哪、有哪些檔」。

只在自己登入的 session 下操作自己的歌曲；不下載他人內容、不改站點資料、不繞過方案限制。

## 2. 三種接入方式

| 方式 | 入口 | 適合 |
| --- | --- | --- |
| **ACE 網站面板** | Chrome／Edge MV3 擴充功能，在 `acemusic.ai/create` 右下角 | 人手操作：勾選下載、一鍵整理、命名爐、播放器 |
| **MCP** | 本機 `node agent\mcp.mjs`（stdio）；官方遠端 MCP 兜底（OAuth 2.1） | Claude／Codex／DSH 等 agent 直接呼叫工具 |
| **CLI + Hub** | `node agent\cli.mjs …`；常駐 Hub `127.0.0.1:8788` | 腳本、排程、多 agent 共用、非同步 job 佇列 |

三者共用同一份本機狀態（`%LOCALAPPDATA%\AceMusicDL\`）與同一把整理鎖，不會互相踩。

## 3. 可下載的資源

| 資源 | 來源 | 備註 |
| --- | --- | --- |
| 分軌（Vocals／Drums／Bass…） | 站點已分離的 stems（MP3 128 kbps） | 需該歌已做分軌；站點目前沒有 WAV 分軌 |
| MIDI | 站點生成（`POST download`，等待後取得） | 部分歌回 `no_download`；有速率限制；**生成可能扣 credit** |
| MusicXML | 同上 | 同上 |
| 完整 MP3 | 歌曲音檔 | 原始上傳不是 MP3 時不改副檔名冒充 |
| 完整 WAV | 站點 file API | 只有部分模型（如 `acemusic-v1.1`）提供；48 kHz／16-bit |
| 封面 | 歌曲封面圖 | |

**FLAC 特別處理**：以 FLAC 儲存的歌，站點與官方 MCP 都回 FLAC；下載器判定 `WAV_UNSUPPORTED` 跳過，不會把 FLAC 存成 `.wav`。

### 3.1 能力矩陣（站點 session ↔ 官方 MCP）

| 能力 | 站點 session | 官方 MCP 兜底 | 兩邊都沒有時 |
| --- | --- | --- | --- |
| 歌單／單曲狀態 | ✅ | ✅ | 頁面快照／舊快取，仍失敗才報錯 |
| mp3／wav／midi／封面 | ✅ | ✅ | 該項失敗並記原因 |
| 分軌（stems） | ✅ | ❌ | 標「需要站點 session」 |
| MusicXML | ✅ | ❌ | 同上 |
| 生成（v1.1） | ✅ | ✅（`official create`） | — |

官方通道可用 `ACE_OFFICIAL=0` 關閉。

## 4. 命名與分類規則

### 4.1 下載後的位置（一鍵整理後）

| 類型 | 資料夾 | 檔名範例 |
| --- | --- | --- |
| 完整 MP3 | `ai音樂\成品MP3\` | `歌名.mp3` |
| 完整 WAV | `ai音樂\成品WAV\` | `歌名.wav` |
| MP3 分軌 | `ai音樂\採樣包\<樂器>\` | `歌名 - Vocals.mp3` |
| WAV 分軌 | `ai音樂\採樣包WAV\<樂器>\` | （站點開放後才有） |
| MIDI | `ai音樂\MIDI\` | `歌名 - MIDI.mid` |
| MusicXML | `ai音樂\MusicXML\` | `歌名 - MusicXML.musicxml` |
| 封面 | `ai音樂\封面\` | `歌名 - Cover.jpg` |
| 壓縮檔／其他 | `ai音樂\壓縮檔\`、`ai音樂\其他\` | |
| 音頻屬性檢視 | `ai音樂\音頻分類\{完整歌曲,分軌,其他音檔}\{BPM,Key,Energy,類型}\` | **hardlink**，不佔額外空間 |
| 收藏 | `ai音樂\收藏\<歌名>.wav` | 一首一個無損母帶，平鋪一層 |

- 樂器資料夾：Vocals、Backing vocals、Drums、Percussion、Bass、Guitar、Keys、Strings、Brass、Woodwinds、Synth、FX、Instrumental、Other。
- BPM 每 5 一格（`120-125`）；Key 用 Camelot（`8A`／`11B`）；Energy 分 `Low／Mid／High`。
- 同名不同 take：`歌名 (2)`、`歌名 (3)`，各自獨立，不當重複。
- `音頻分類` 是 hardlink 檢視：刪了省不到空間，還會讓 BPM／Key 檢視缺檔。

## 5. 一鍵整理（完整管線）

`舊檔改名 → 成品MP3 → 成品WAV → 採樣包／採樣包WAV → 檔案分類（MIDI／MusicXML／封面／壓縮檔／其他）→ 內容去重 → 空殼清理 → 音頻屬性分類（hardlink）→ 收藏夾 → 指紋清除 → 已點讚`

- **不會疊羅漢**：連續觸發（下載完自動整理、面板按鈕、CLI、Hub、MCP 同時來）合併成一輪。跑的那輪持有 `tidy-run.lock`；其他觸發只寫 `tidy-pending.json`，結束後最多補跑一輪。過期鎖自動清掉。
- **成品WAV**：分類後把乾淨名字**複製**到 `整理輸出\成品WAV\`，來源不動；同名的兩首依 task 編號 `(2)(3)`。
- **內容去重**：相同內容（size→sha256）只留一份，其餘搬到 `%LOCALAPPDATA%\AceMusicDL\organize-backups\`（預設不刪；`backups --prune --commit` 才清）。
- **收藏夾**：站點拇指點讚 ∪ 面板愛心，每首取一個成品 WAV 母帶 → `收藏\<歌名>.wav`；只有 MP3 的歌沒有母帶可收（計入 `noWav`）；內容相同跳過、同名不覆寫（`--force` 才覆寫且先歸檔）。
- **指紋清除**：就地抹掉 ACE metadata（WAV `LIST/INFO`、`id3`、`bext`、`iXML`、`XMP`；MP3 `TSSE`／`TENC`、含 `ACE Music` 的 `COMM`、`WOAS`），標題／藝人／專輯／BPM／調性／封面／歌詞保留；檔長與 inode 不變，原 bytes 存 `fingerprint-backups\`，`--restore` 可還原。
- **已點讚**：把點讚歌的成品檔案（MP3／WAV）複製到 `已點讚\`，可選 AI 雙語命名（有預算上限、重跑不重複付費）。
- **節目資料夾受保護**：`節目\`（電臺母帶）與 `收藏`／`整理輸出`／`已點讚` 一樣列為受保護，歸檔／分類／去重／索引／音頻分析全部跳過（1.9.5 起）。

## 6. 狀態怎麼讀（面板徽章）

| 顯示 | 意思 |
| --- | --- |
| `已下載` | 目前勾選且適用的類型都在，含 MP3／WAV；只按該歌自己的來源證據判斷 |
| `部分 x/y` | y 項中有 x 項；滑過徽章看缺哪項 |
| `缺 MP3／WAV…` | 已完成本機核對，缺少列出的類型 |
| `待核對 MP3…` | 有候選檔案但來源對應不夠明確，不當確定缺檔 |
| `本機核對未就緒` | 本機工具尚未提供索引；未知不等於沒有檔案 |
| `MIDI 不可用` | 站點回 `no_download`，不計入 y，也不會再請求 |
| `MP3`／`WAV` 徽章 | 分別顯示；有勾選時也計入 y |

## 7. 面板功能

- **擺放與透明度**：拖標題列移動、拖右下角按鈕換位置、透明度 40–100%、雙擊標題列回預設；設定會記住。
- **即時同步**：訂閱站點歌單推送（SSE），新歌以增量更新，斷線退回輪詢；本機補檔後自動更新對應歌曲。
- **下載設定**：六種類型預設勾選；設定區預設收合並保留手動選擇；MIDI／MusicXML 只排入該歌已主動要求分軌的情況。
- **新歌自動下載**：只處理開啟後完成的新歌；分軌等分離完成再補抓；MIDI／MusicXML 預設不自動（可能扣 credit）。
- **老歌新增分軌**：建立基線後，偵測既有歌曲新增／更新的就緒分軌並下載；不主動購買。
- **複製診斷**：最近 200 筆工作紀錄（UTC 時間、階段、數量、清理過的錯誤，不含網址／Cookie／權杖）；本機工具可用時節流寫 `download-log.json`。
- **卡住處理**：重新載入擴充功能後必須刷新 ACE 分頁；診斷可在連線失效時使用。

## 8. 獨立播放器

- 可拖動、可調整大小的獨立視窗；先定位歌曲，按播放才出聲。
- 曲庫：BPM／Camelot 欄位與篩選、排序、搜尋、本機檔案、下載狀態。
- 佇列（下一首播放、排序）、播放清單（M3U8 匯出／匯入）。
- 收藏、歷史、睡眠計時。
- 鍵盤快捷鍵：`Space`、`Alt+←/→`、`J/L`、`M`、`F`、`Q`、`/`、`?`（開說明）與系統媒體鍵。
- 托盤模式：`player --tray`；升級換版：`player --restart`。

## 9. 命名爐

面板「維護 → 命名爐」開新分頁：

1. 「連接 ai音樂」授權資料夾（Chrome 記住，只需一次）。
2. 讀 `音頻分類\_manifest.json` 與 `成品MP3\_manifest.json`，同首的分軌／版本分成一組。
3. 預設「每組一首」；`R` 重擲、`↵` 採用會套用整組。
4. 體裁：自動／銘／儀／並／抽（抽象：`X 的 Y` / `The Y of X`）。
5. 「套用改名」直接改本機檔名（保留 ` - Bass`、`(2)` 等後綴）。
6. 每次改名寫入 `_命名爐改名紀錄.json`（舊路徑→新路徑、時間、大小），索引視為搬移，改名後仍算已下載；紀錄無法讀取時停止改名。

命名爐只讀授權資料夾、不上傳，不影響下載流程。

## 10. CLI（`node agent\cli.mjs …`）

| 指令 | 用途 |
| --- | --- |
| `doctor` | 登入、紀錄、頁面快照健康度（含官方 MCP 狀態） |
| `status [--json]` | 曲庫摘要 |
| `locate [--latest N\|--query 字\|--song id] [--views]` | 歌曲 → 本機真實目錄與檔案 |
| `local-index [--root 名稱] [--full] [--json]` | 只讀本機下載證據索引，不連站點 |
| `library [--sizes] [--json]` | 曲庫分類總覽（每類資料夾、檔數、大小） |
| `list [--query] [--undownloaded] [--json]` | 歌單＋下載進度 |
| `download --all\|--song id [--types …] [--dry-run] [--force]` | 下載 |
| `tidy-all [--json]` | 一鍵整理 |
| `favorites [--dry-run] [--force] [--sync]` | 點讚／愛心歌 → `ai音樂\收藏\` |
| `liked-folder [--dry-run] [--no-ai] [--budget N]` | 點讚歌 → `已點讚\`（AI 雙語命名） |
| `strip-fingerprints [--dry-run\|--restore]` | 就地抹 ACE metadata |
| `wav-names [--dry-run]` | 成品WAV 乾淨名字複製到 `整理輸出\` |
| `dedupe-content [--commit]` | 內容去重（預設預覽） |
| `classify-audio` | 音頻屬性分類（hardlink） |
| `backups [--keep-days N --keep-last N --max-mb N] [--prune --commit]` | 整理備份清單／清理（預設只預覽） |
| `masters` | 母帶清單（俱樂部版／舊版對照） |
| `hub --background\|--status\|--stop` | 常駐中樞 |
| `watch --background\|--status\|--stop` | 背景自動整理 |
| `cache [status\|clear] [--all]` | 快取（clear 預設保留音頻分析） |
| `events [--since seq] [--type t]` | 中樞事件（新歌／自動下載／下載完成） |
| `wait [--timeout 秒]` | 等下一首新歌（需 Hub＋站點分頁） |
| `probe` | 站點健康（唯讀：登入、方案、模型） |
| `generate --request x.json [--json]` | v1.1 生成預覽；提交需 `--commit --confirm-credit-spend --max-credits N --idempotency-key K` |
| `generation-status --task-ids …` | 生成狀態（唯讀） |
| `prompt [--model --mode --seed --lock-a --lock-b --count]` | 隨機提示詞（12×12 風格矩陣） |
| `official status\|login\|logout\|refresh\|list\|get\|download\|create\|skill\|test` | 官方遠端 MCP 通道 |

### 10.1 維護備份

`backups` 預設只預覽；規則：保留最近 `--keep-last` 個（預設 1），其餘超過 `--keep-days`（預設 7）或總量超過 `--max-mb` 才列為可刪；加 `--prune --commit` 才真的刪。

## 11. MCP（本地 stdio）

`node agent\mcp.mjs`

| 想做的事 | 工具 |
| --- | --- |
| 開場看狀態 | `ace_overview`（登入＋曲庫統計，走本機快照通常 <50 ms） |
| 歌單／進度 | `ace_list_songs`、`ace_download_index` |
| 最新那首歌的檔案在哪 | `ace_locate`（預設最新一首；`query`／`song_id`／`latest`） |
| 下載 | `ace_download`（`song_ids`／`query`／`latest`／`all`；`types` 可 `all`）→ `ace_job_status`／`ace_job_cancel` |
| 等一下一首新歌 | `ace_wait_new_song`（`wait_download: true` 連下載完成一起等） |
| 事件 | `ace_events` |
| 整理 | `ace_tidy`、`ace_organize` |
| 曲庫 | `ace_library`、`ace_masters`、`ace_backups` |
| 收藏／點讚 | `ace_favorites`、`ace_site_likes`、`ace_collect_favorites`、`ace_liked_folder` |
| 播放器 | `ace_player` |
| 站點狀態 | `ace_session_status`、`ace_probe`、`ace_hub_status`、`ace_warm` |
| 提示詞 | `ace_random_prompt` |
| 生成（v1.1） | `ace_generate`（預設只預覽）、`ace_generation_status` |
| 創作中樞 | `music_*`、`ace_create_*`（見第 14 節） |

Hub 在跑時自動走 Hub；讀取可本地回落；**寫入不重送**（提交後結果未知時查 job ID，不換一路重送）。付費生成只允許經支援生成的 Hub 提交。

## 12. 官方遠端 MCP（兜底通道）

站點 session 失效時，能走的改走 [官方遠端 MCP](https://acemusic.ai/mcp)：

- OAuth 2.1（Dynamic Client Registration + PKCE S256 + 127.0.0.1 回呼），授權一次後自動續約。
- token 存 `<stateDir>\official-auth.json`（只在本機）。
- 命令：`official status/login/logout/refresh/list/get/download/create/skill/test`。

## 13. Hub API（`127.0.0.1:8788`）

- `GET`：`/health`、`/capabilities`、`/overview`、`/songs`、`/locate`、`/library`、`/download-index`、`/page`、`/page/events`、`/wait`、`/jobs/:id`、`/events`（SSE）
- `POST`：`/download`、`/tidy`、`/dedupe`、`/organize`、`/warm`、`/jobs/:id/cancel`、`/shutdown`
- 其他擴充功能／agent 接入：先讀 `GET /capabilities`（`apiVersion` 判斷相容）；擴充功能需在自己的 manifest 加 `host_permissions: ["http://127.0.0.1:8788/*"]`，一般網站請求會被拒（403）。
- v1.10.1 起 `/library`、`/download-index` 有 4 秒短效快取（任何 POST／新事件立即失效）。

## 14. HuaiDJ 創作中樞（可選子系統）

- `music_intent_prepare`／`music_prompt_compile`：把自然語言整理成可重現的模型提示詞（詞典版本化、可審閱）。
- `music_session_*`、`music_generation_prepare/submit/poll`、`music_job_status`：有限授權的生成流程（預設不提交付費生成）。
- `music_research_*`：公開文字證據卡與研究候選（DeepSeek 分析、需審閱才進詞典）。
- `music_loop_*`、`music_feedback_record`、`music_next_iteration`：有限循環與人類回饋。
- `music_performance_*`：演出 manifest／待審佇列（不自動播放）。
- `ace_create_*`：原生 Create API 參數驗證與提交（需獨立授權與 Hub 支援）。

原則：預設只用本機準備與唯讀報價；任何付費／生成／公開動作都需要明確授權。

## 15. 本機工具（選用）

- `native\install-host.ps1`：native messaging host（C#），負責改名／搬檔／叫用 CLI。
- `scripts\install-autostart.ps1 [-DryRun|-Uninstall]`：開機自動啟動 Hub＋watcher（Windows 工作排程）。
- `更新本機工具.cmd`：從完整包同步 Hub／Native／播放器（先備份並驗證雜湊，不強停下載）。

## 16. 效能（v1.10.1 實測）

| 項目 | 數字 |
| --- | --- |
| CLI `status --json` | 190–250 ms（1.10.0 約 290 ms） |
| Hub `/library` 首次 / 重複 | 593 ms / **9–35 ms** |
| Hub `/download-index` | 35–85 ms（4 秒快取內） |
| Hub 熱路徑（overview／locate／list） | 1.2 ms ／ 2.7 ms ／ 0.5 ms（p50，面板文件數據） |
| 測試 | 單元 563/563、e2e 31/31 |

## 17. 隱私與授權

- 只在 `acemusic.ai` 頁面執行；只讀自己的歌曲與登入 Cookie。
- 不連第三方伺服器、不外傳歌單或 Cookie；Hub 只綁 `127.0.0.1`。
- 狀態與紀錄在 `chrome.storage.local` 與 `%LOCALAPPDATA%\AceMusicDL\`。
- MIT License；與 ACE Music／ACE Studio 無隸屬關係，非官方工具。

---

## English summary

**ACE Music Batch Downloader** adds a batch-download panel to [acemusic.ai](https://acemusic.ai/create/) and gives agents three ways in: the browser panel, an MCP server (local stdio + official remote fallback), and a CLI with a resident local Hub.

**Downloads**: stems, MIDI, MusicXML, full MP3/WAV and covers — only for your own songs, only under your own session. Missing items are reported as unavailable; FLAC-stored songs are never renamed to `.wav`.

**Organization**: one-click tidy runs rename → MP3 output → WAV output → sample packs → file classification → content dedupe → empty-folder cleanup → audio classification (BPM/key/energy as hardlink views) → favorites → fingerprint stripping → liked songs. Concurrent triggers collapse into one run plus at most one rerun.

**Panel**: draggable/resizable, opacity, live song sync over SSE, per-type download options, auto-download for new songs, new stems for existing songs, copy-diagnostics for stuck jobs.

**Player**: BPM/Camelot filters, queue, M3U8 import/export, favorites, history, sleep timer, keyboard shortcuts, media keys, tray mode.

**Naming furnace**: groups variants of the same song, offers bilingual names (銘/儀/並/抽), applies renames in place and journals every move so renamed songs stay "downloaded".

**MCP**: `ace_overview`, `ace_list_songs`, `ace_download`, `ace_job_status`, `ace_locate`, `ace_wait_new_song`, `ace_events`, `ace_tidy`, `ace_organize`, `ace_library`, `ace_favorites`, `ace_site_likes`, `ace_player`, `ace_backups`, `ace_masters`, `ace_generate`, `ace_generation_status`, plus the HuaiDJ creation family (`music_*`, `ace_create_*`). The official remote MCP (OAuth 2.1) covers song lists and mp3/wav/midi/cover when the site session expires; stems and MusicXML still require the site session and say so explicitly.

**Hub**: `127.0.0.1:8788`, read APIs, SSE events, long-poll wait, async jobs, single writer, short-lived cache from v1.10.1.

**Performance (v1.10.1)**: `status --json` 190–250 ms; `/library` 593 ms first, 9–35 ms cached; tests 563/563 unit, 31/31 e2e.

**Privacy**: runs only on acemusic.ai, no third-party servers, local-only state. MIT licensed, unofficial.
