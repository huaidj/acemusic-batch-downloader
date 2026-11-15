# ACE Music 批量下載器

在 [acemusic.ai](https://acemusic.ai/create/) 的 Create 歌曲庫頁面加入一個面板，把一首或全部歌曲的**分軌（stems）、MIDI、MusicXML、MP3、WAV、封面**一次下載完，自動改名、分類；另外提供 CLI／MCP／常駐 Hub 給 agent 使用。

[GitHub Releases](https://github.com/yutianyu111602-glitch/acemusic-batch-downloader/releases) · [隱私政策](https://yutianyu111602-glitch.github.io/acemusic-batch-downloader/privacy.html) · [MIT License](LICENSE)

> 只在使用者自己的登入 session 下操作自己的歌曲，不下載他人內容、不改站點資料。

## 功能

- **批次下載**：分軌、MIDI、MusicXML、MP3、WAV、封面；可全選或單曲下載
- **自動命名／分資料夾**：`<歌名>/<歌名> - Vocals.mp3`、`<歌名> - MIDI.mid`、`<歌名> - MusicXML.musicxml`\n- **WAV**：僅部分模型提供（例如 `acemusic-v1.1`）；模型不支援時自動跳過、不算失敗
- **一鍵整理**：舊檔整理 → 成品 MP3 → 採樣包（依樂器）→ 檔案分類 → 內容去重 → 空殼清理 → 音頻屬性分類（BPM／調性／能量）
- **不重複下載**：比對本機檔案、下載紀錄、去重紀錄；已存在的自動跳過
- **狀態顯示**：每首歌顯示已下載／部分／未下載；「只看未下載」過濾
- **Agent 接入**：CLI、MCP（14 個工具）、常駐 Agent Hub（127.0.0.1:8788）
- **可選本機工具**：native messaging host 負責改名／搬檔／叫用 CLI（不裝也能下載）

## 安裝

### 方式 A：Chrome 線上應用程式商店

（上架流程準備中；上架後會更新此段。）

### 方式 B：載入未封裝（開發版）

1. 下載或 clone 此 repo
2. Chrome／Edge 開 `chrome://extensions`（Edge：`edge://extensions`）
3. 開啟「開發人員模式」
4. 「載入未封裝項目」→ 選 **repo 根目錄**（含 `manifest.json` 的那一層）
5. 開 <https://acemusic.ai/create/> 並登入；右下角會出現「批量下載」按鈕

> 更新版本後到 `chrome://extensions` 按「重新載入」，並重新整理站點分頁。

## 使用

1. 面板勾選要的檔案類型（分軌／MIDI／MusicXML／MP3／封面），選歌或全選
2. 按「下載選中」；面板顯示目前檔案與完成／跳過／失敗數
3. 完成後檔案在 `%USERPROFILE%\Downloads\ai音樂\<歌名>\`

進階選項：強制重下、依類型分層、根資料夾、下載完自動整理、背景自動整理、只看未下載、清自訂重複。

## Agent 接入（CLI／MCP／Hub）

```powershell
# 先讓面板按「同步 Agent」匯出登入狀態（%LOCALAPPDATA%\AceMusicDL\session.json）
node agent\cli.mjs doctor
node agent\cli.mjs list --undownloaded
node agent\cli.mjs download --all --types stems,midi,cover
node agent\cli.mjs tidy-all
```

MCP（stdio）：`node <repo>\agent\mcp.mjs`，工具包含 `ace_overview`、`ace_list_songs`、`ace_download`、`ace_job_status`、`ace_organize`、`ace_warm`、`ace_hub_status` 等。

常駐 Hub（多 agent 共用、單一寫入者、job 佇列、SSE）：

```powershell
node agent\cli.mjs hub --background   # http://127.0.0.1:8788
node agent\cli.mjs hub --status
node agent\cli.mjs hub --stop
```

設計與 API：[agent/HUB.md](agent/HUB.md)；Agent 詳細文件：[agent/README-AGENT.md](agent/README-AGENT.md)。

## 開發

```
src/naming.js      命名純函式
src/planner.js     下載清單純函式
src/content.js     面板 UI／站點 API／排程
src/background.js  service worker（chrome.downloads）
agent/             CLI／MCP／Hub／watcher／音訊分析
native/            native messaging host（C#，選用）
mixdesk/           AI 電台混音台（獨立子系統）
test/              單元測試＋Playwright e2e（mock 站）
```

```powershell
npm i -D playwright          # e2e 需要（或設定 PLAYWRIGHT_PATH 指向既有安裝）
npm run test:unit
npm run test:e2e             # 會開一個測試用 Chromium 視窗
npm run pack                 # 產生 dist/ store 與完整包
```

## 隱私

- 只在 `acemusic.ai` 頁面執行；只讀取自己的歌曲與登入 Cookie
- 不連任何第三方伺服器、不外傳歌單或 Cookie（詳見 [PRIVACY.md](PRIVACY.md)）
- 設定與紀錄存在 `chrome.storage.local` 與 `%LOCALAPPDATA%\AceMusicDL\`

## 授權

[MIT](LICENSE)。本專案與 ACE Music／ACE Studio 無隸屬關係，為非官方工具；使用時請遵守站點服務條款。

