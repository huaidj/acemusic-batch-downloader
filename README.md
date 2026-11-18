# ACE Music 批量下載器 · ACE Music Batch Downloader

[中文](#中文) ｜ [English](#english)

把 [acemusic.ai](https://acemusic.ai/create/) 歌曲庫的歌**一次下載完**：分軌（stems）、MIDI、MusicXML、MP3、WAV、封面，自動改名與分類；同時提供 **CLI / MCP / 常駐 Hub** 給 agent 使用。

Chrome extension for batch-downloading your own [acemusic.ai](https://acemusic.ai/create/) library — stems, MIDI, MusicXML, MP3/WAV and covers — with auto-naming and organization, plus a CLI, MCP server and a local Agent Hub.

[Releases](https://github.com/huaidj/acemusic-batch-downloader/releases) · [完整功能介紹 Project guide](docs/PROJECT.md) · [隱私政策 / Privacy](https://huaidj.github.io/acemusic-batch-downloader/privacy.html) · [MIT License](LICENSE)

> 只在自己登入的 session 下操作自己的歌曲；不下載他人內容、不改站點資料。
> Operates only on your own songs under your own session. No third-party content, no site modification.

---

## 中文

### 這是什麼

在 ACE Music 的 Create 頁面（`https://acemusic.ai/create/`）右下角加入「批量下載」面板；勾選要的檔案類型後，一鍵下載整首或全部歌曲，並依類型改名分資料夾。另外提供三種給自動化／agent 的接入方式。

### 三種接入方式

| 方式 | 入口 | 適合 |
| --- | --- | --- |
| **① ACE 網站面板** | Chrome／Edge 擴充功能，`chrome://extensions` 載入未封裝 | 人手操作：勾選、下載、整理、命名爐、播放器 |
| **② MCP** | 本機 `node agent\mcp.mjs`（stdio）＋**官方遠端 MCP 兜底**（OAuth 2.1） | Claude／Codex／DSH 等 agent 直接呼叫工具 |
| **③ CLI + Hub** | `node agent\cli.mjs …`；常駐 Hub `127.0.0.1:8788` | 腳本、排程、多 agent 共用、非同步下載工作 |

### 重點功能

- **批次下載**：分軌、MIDI、MusicXML、MP3、WAV、封面；可全選或單曲
- **自動命名／分資料夾**：`<歌名>/<歌名> - Vocals.mp3`、`- MIDI.mid`、`- MusicXML.musicxml`
- **WAV 不冒充**：依站點模型能力與原始音源判斷；以 FLAC 儲存的歌判為 `WAV_UNSUPPORTED` 跳過，不會把 FLAC 存成 `.wav`
- **一鍵整理**：舊檔 → 成品 MP3 → 成品 WAV → 採樣包（MP3／WAV 分軌）→ 檔案分類 → 內容去重 → 空殼清理 → 音頻屬性分類（BPM／調性／能量）→ 收藏夾 → 指紋清除 → 已點讚（AI 命名）
- **整理不會疊羅漢**：連續觸發只跑一輪；跑動時的新觸發只登記「結束後補一輪」（`tidy-run.lock`／`tidy-pending.json`）
- **收藏夾**：站點拇指點讚與面板愛心，每首只留一個無損母帶，平鋪 `ai音樂\收藏\<歌名>.wav`
- **指紋清除**：就地抹掉 ACE metadata（WAV `LIST/INFO`、MP3 `TSSE`／`COMM`／`WOAS`）；檔長不變、可 `--restore` 還原
- **不重複下載**：比對本機檔案、下載紀錄、去重紀錄；同名歌曲互不繼承紀錄
- **即時同步＋新歌自動下載**：訂閱站點推送，新歌完成約 50 ms 出現
- **老歌新增分軌**：偵測既有歌曲新增／更新的就緒分軌並下載（不主動購買；MIDI／MusicXML 僅在已授權樂譜生成時）
- **獨立播放器**：BPM／Camelot 欄位與篩選、佇列、M3U8 匯出／匯入、收藏、歷史、睡眠計時、鍵盤快捷鍵、系統媒體鍵
- **命名爐（預設顯示）**：面板「維護 → 命名爐」，同首的分軌／版本共用一個名字，可直接套用改名並重建索引
- **HuaiDJ 創作中樞**：音樂意圖、版本化詞典、提示詞編譯、有限授權生成、產物回收與人評（`music_*`、`ace_create_*`；預設不提交付費生成）

### 最新版本 v1.10.2（商店包修正）

- `npm run pack` 的 store zip 現在會剝掉 manifest 的 `key`（Chrome Web Store 不接受含 `key` 的清單）；完整包保留固定 ID。

### v1.10.1（啟動與 Hub 快取優化）

- **CLI 啟動更快**：`create`／`music` 兩份大契約改為按需載入，一般命令（status／library／download／doctor…）不再付啟動成本；實測 `status --json` 由約 290 ms 降到 **190–250 ms**
- **Hub 短效快取**：`/library`、`/download-index` 4 秒內重複請求直接回上次結果；面板輪詢由每次 300–600 ms 降到 **9–35 ms**。任何 POST 或新事件立即清快取
- 測試：單元 **563/563**、e2e **31/31**

完整版本紀錄：[CHANGELOG.md](CHANGELOG.md)。

### 安裝

**方式 A：Chrome 線上應用程式商店**（上架流程準備中）

**方式 B：載入未封裝（開發版）**

1. Clone 或下載此 repo
2. Chrome／Edge 開 `chrome://extensions`（Edge：`edge://extensions`）
3. 開啟「開發人員模式」
4. 「載入未封裝項目」→ 選 **repo 根目錄**（含 `manifest.json` 的那一層）
5. 開 <https://acemusic.ai/create/> 並登入；右下角出現「批量下載」按鈕

> 更新版本後到 `chrome://extensions` 按「重新載入」，並重新整理站點分頁。
> 完整包可執行 `更新本機工具.cmd` 同步本機 Hub／Native／播放器（先備份並驗證雜湊，不強停下載）。

### 使用

1. 面板勾選檔案類型（分軌／MIDI／MusicXML／MP3／封面），選歌或全選
2. 按「下載選中」；面板顯示目前檔案與完成／跳過／失敗數
3. 檔案在 `<downloadDir>\ai音樂\<歌名>\`（預設 `%USERPROFILE%\Downloads`；可用 `<stateDir>\config.json` 的 `"downloadDir": "D:\\"` 指到別的磁碟，硬連結檢視也會建在同一顆碟）

### Agent 接入（CLI／MCP／Hub）

```powershell
# 先讓面板按「同步 Agent」匯出登入狀態（%LOCALAPPDATA%\AceMusicDL\session.json）
node agent\cli.mjs doctor
node agent\cli.mjs list --undownloaded
node agent\cli.mjs download --all --types stems,midi,cover
node agent\cli.mjs tidy-all
node agent\cli.mjs favorites --dry-run
```

**本機 MCP（stdio）**：`node <repo>\agent\mcp.mjs`

主要工具：`ace_overview`、`ace_list_songs`、`ace_download`、`ace_job_status`、`ace_download_index`、`ace_organize`、`ace_warm`、`ace_locate`、`ace_player`、`ace_wait_new_song`、`ace_events`、`ace_favorites`、`ace_site_likes`、`ace_tidy`、`ace_backups`、`ace_masters`、`ace_probe`、`ace_hub_status`、`ace_generate`、`ace_generation_status`，以及 HuaiDJ 創作中樞的 `music_*`／`ace_create_*` 系列。

**常駐 Hub**（多 agent 共用、單一寫入者、job 佇列、SSE）：

```powershell
node agent\cli.mjs hub --background   # http://127.0.0.1:8788
node agent\cli.mjs hub --status
node agent\cli.mjs hub --stop
```

設計與 API：[agent/HUB.md](agent/HUB.md)；Agent 詳細文件：[agent/README-AGENT.md](agent/README-AGENT.md)。

### MCP：官方遠端兜底（站點 session 失效時）

站點登入（面板「同步 Agent」匯出的 cookie）失效時，能走的改走 [官方遠端 MCP](https://acemusic.ai/mcp)：OAuth 2.1 授權一次，之後自動續約（token 在 `<stateDir>\official-auth.json`）。

```powershell
node agent\cli.mjs official login      # 瀏覽器按一次同意
node agent\cli.mjs official status     # 授權、方案、額度
node agent\cli.mjs official list       # 不用瀏覽器 session 也能列歌
node agent\cli.mjs official download --song so_xxx --format mp3
```

| 能力 | 站點 session | 官方 MCP | 兩邊都沒有時 |
| --- | --- | --- | --- |
| 歌單／單曲狀態 | ✅ | ✅（兜底） | 用頁面快照／舊快取，仍失敗才報錯 |
| mp3／wav／midi | ✅ | ✅（兜底） | 該項失敗並記原因 |
| 分軌（stems） | ✅ | ❌ | 明確標「需要站點 session」 |
| MusicXML | ✅ | ❌ | 同上 |
| 生成（v1.1） | ✅ | ✅（`official create`） | — |

官方通道可用 `ACE_OFFICIAL=0` 關閉。本機直接生成 v1.1：`ace_generate` 預設只預覽；實際提交需明確額度上限、防重送 key 與支援生成的 Hub；`ace_generation_status` 查詢實際模型與音訊進度。參數見 [agent/DIRECT-GENERATION.md](agent/DIRECT-GENERATION.md)。

### 開發

```
src/naming.js      命名純函式
src/planner.js     下載清單純函式
src/content.js     面板 UI／站點 API／排程
naming/            命名爐頁面
src/background.js  service worker（chrome.downloads）
agent/             CLI／MCP／Hub／watcher／音訊分析
native/            native messaging host（C#，選用）
test/              單元測試＋Playwright e2e（mock 站）
```

```powershell
npm i -D playwright          # 或設定 PLAYWRIGHT_PATH 指向既有安裝
npm run test:unit
npm run test:e2e             # 會開一個測試用 Chromium 視窗
npm run pack                 # 產生 dist/ store 與完整包
```

### 隱私

- 只在 `acemusic.ai` 頁面執行；只讀自己的歌曲與登入 Cookie
- 不連第三方伺服器、不外傳歌單或 Cookie（見 [PRIVACY.md](PRIVACY.md)）
- 設定與紀錄存在 `chrome.storage.local` 與 `%LOCALAPPDATA%\AceMusicDL\`

### 授權

[MIT](LICENSE)。本專案與 ACE Music／ACE Studio 無隸屬關係，為非官方工具。

---

## English

### What it is

A Chrome/Edge extension that adds a **batch download** panel to [acemusic.ai](https://acemusic.ai/create/): pick your own songs, choose file types, and download everything — then auto-rename and organize. Three ways to use it: the browser panel, an **MCP server** (local stdio, plus the official remote MCP as a fallback), and a **CLI + local Hub** for agents and scripts.

### Three ways to use it

| Way | Entry point | Best for |
| --- | --- | --- |
| **① ACE website panel** | Chrome/Edge extension loaded unpacked from this repo | Hands-on work: select, download, tidy, naming furnace, player |
| **② MCP** | Local `node agent\mcp.mjs` (stdio) + **official remote MCP fallback** (OAuth 2.1) | Claude / Codex / DSH agents calling tools |
| **③ CLI + Hub** | `node agent\cli.mjs …`; resident Hub at `127.0.0.1:8788` | Scripts, schedules, shared async download jobs |

### Highlights

- **Batch download**: stems, MIDI, MusicXML, MP3, WAV and covers — one song or all songs
- **Auto-naming / folders**: `<Song Title>/<Song Title> - Vocals.mp3`, `- MIDI.mid`, `- MusicXML.musicxml`
- **No fake WAVs**: respects site capabilities and source audio; songs stored as FLAC are reported as `WAV_UNSUPPORTED` and skipped
- **One-click tidy**: legacy files → MP3 output → WAV output → sample packs → file classification → content dedupe → empty-folder cleanup → audio classification (BPM/key/energy) → favorites → fingerprint stripping → liked songs (AI naming)
- **Tidy never stacks**: repeated triggers collapse into one run plus at most one queued rerun (`tidy-run.lock` / `tidy-pending.json`)
- **Favorites**: one lossless master per liked song, flattened as `ai音樂\收藏\<Song Title>.wav`
- **Fingerprint stripping**: removes ACE metadata in place (WAV `LIST/INFO`, MP3 `TSSE`/`COMM`/`WOAS`), file length unchanged, `--restore` supported
- **Resume-safe**: skips what already exists by comparing local files, download history and dedupe records
- **Live sync + auto-download**: subscribes to the site push; new songs appear in ~50 ms
- **New stems for existing songs**: downloads newly ready stems when auto-stem download is enabled (never purchases; MIDI/MusicXML only after score generation is authorized)
- **Standalone player**: BPM/Camelot columns and filters, queue, M3U8 import/export, favorites, history, sleep timer, keyboard shortcuts, media keys
- **Naming furnace**: bilingual naming device; variants of the same song share one name, apply-rename rebuilds the local index
- **HuaiDJ creation hub**: music intent, versioned dictionary, prompt compilation, bounded generation, artifact recovery and human feedback (`music_*`, `ace_create_*`; paid generation is never submitted by default)

### Latest: v1.10.2 (store package fix)

- The store zip produced by `npm run pack` now strips the manifest `key` (the Chrome Web Store rejects manifests containing it); the full package keeps the fixed ID.

### v1.10.1 (startup + Hub cache)

- **Faster CLI startup**: the large Create/Music contracts are now imported on demand; `status --json` dropped from ~290 ms to **190–250 ms**
- **Hub short-lived cache**: `/library` and `/download-index` reuse a result for 4 seconds; repeated panel polling went from 300–600 ms to **9–35 ms**. Any POST or new event invalidates immediately
- Tests: **563/563** unit, **31/31** e2e

Full history: [CHANGELOG.md](CHANGELOG.md).

### Install

**Option A: Chrome Web Store** (submission in progress)

**Option B: Load unpacked (development)**

1. Clone or download this repo
2. Open `chrome://extensions` (Edge: `edge://extensions`)
3. Enable **Developer mode**
4. **Load unpacked** → select the **repo root** (the folder containing `manifest.json`)
5. Open <https://acemusic.ai/create/>, sign in, and use the **Batch download** button at the bottom right

> After updating, press **Reload** on `chrome://extensions` and refresh the site tab.
> The full package ships `更新本機工具.cmd` to sync the local Hub/native host/player (backs up and verifies hashes first; never force-stops active downloads).

### Usage

1. Tick the file types in the panel (stems / MIDI / MusicXML / MP3 / covers), pick songs or select all
2. Click **Download selected**; the panel shows the current file and done/skipped/failed counts
3. Files land in `<downloadDir>\ai音樂\<Song Title>\` (default `%USERPROFILE%\Downloads`; set `"downloadDir": "D:\\"` in `<stateDir>\config.json` to use another drive — hardlink views are created on the same drive)

### Agent access (CLI / MCP / Hub)

```powershell
# First click "Sync Agent" in the panel to export the session (%LOCALAPPDATA%\AceMusicDL\session.json)
node agent\cli.mjs doctor
node agent\cli.mjs list --undownloaded
node agent\cli.mjs download --all --types stems,midi,cover
node agent\cli.mjs tidy-all
node agent\cli.mjs favorites --dry-run
```

**Local MCP (stdio)**: `node <repo>\agent\mcp.mjs`

Main tools: `ace_overview`, `ace_list_songs`, `ace_download`, `ace_job_status`, `ace_download_index`, `ace_organize`, `ace_warm`, `ace_locate`, `ace_player`, `ace_wait_new_song`, `ace_events`, `ace_favorites`, `ace_site_likes`, `ace_tidy`, `ace_backups`, `ace_masters`, `ace_probe`, `ace_hub_status`, `ace_generate`, `ace_generation_status`, plus the `music_*` / `ace_create_*` creation-hub family.

**Resident Hub** (shared by agents, single writer, job queue, SSE):

```powershell
node agent\cli.mjs hub --background   # http://127.0.0.1:8788
node agent\cli.mjs hub --status
node agent\cli.mjs hub --stop
```

Design and API: [agent/HUB.md](agent/HUB.md); agent docs: [agent/README-AGENT.md](agent/README-AGENT.md).

### MCP: official remote fallback (when the site session is gone)

When the exported site session expires, whatever can be served moves to the [official remote MCP](https://acemusic.ai/mcp): authorize once with OAuth 2.1, tokens refresh automatically (stored in `<stateDir>\official-auth.json`).

```powershell
node agent\cli.mjs official login      # approve once in the browser
node agent\cli.mjs official status     # authorization, plan, credits
node agent\cli.mjs official list       # list songs without a browser session
node agent\cli.mjs official download --song so_xxx --format mp3
```

| Capability | Site session | Official MCP | Neither available |
| --- | --- | --- | --- |
| Song list / status | ✅ | ✅ (fallback) | page snapshot / old cache, then error |
| mp3 / wav / midi | ✅ | ✅ (fallback) | that item fails with a reason |
| Stems | ✅ | ❌ | reported as "site session required" |
| MusicXML | ✅ | ❌ | same |
| Generation (v1.1) | ✅ | ✅ (`official create`) | — |

Disable the official channel with `ACE_OFFICIAL=0`. Local v1.1 generation: `ace_generate` previews by default; submission requires an explicit credit cap, an anti-resend key and a Hub that supports generation. See [agent/DIRECT-GENERATION.md](agent/DIRECT-GENERATION.md).

### Development

```
src/naming.js      naming pure functions
src/planner.js     download plan pure functions
src/content.js     panel UI / site API / scheduling
naming/            naming furnace page
src/background.js  service worker (chrome.downloads)
agent/             CLI / MCP / Hub / watcher / audio analysis
native/            native messaging host (C#, optional)
test/              unit tests + Playwright e2e (mock site)
```

```powershell
npm i -D playwright          # or set PLAYWRIGHT_PATH to an existing install
npm run test:unit
npm run test:e2e             # opens a test Chromium window
npm run pack                 # builds dist/ store and full packages
```

### Privacy

- Runs only on `acemusic.ai` pages; reads only your own songs and session cookie
- No third-party servers; no playlist or cookie upload (see [PRIVACY.md](PRIVACY.md))
- Settings and logs live in `chrome.storage.local` and `%LOCALAPPDATA%\AceMusicDL\`

### License

[MIT](LICENSE). Not affiliated with ACE Music / ACE Studio; unofficial tool.
