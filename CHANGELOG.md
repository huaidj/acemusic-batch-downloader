# Changelog

## 1.7.0 — 2026-11-16

### 新增
- **即時同步**：面板訂閱站點 `/api/songs/events`，版本變動才抓 `/api/songs/changes` 增量；新歌約 50 ms 出現在面板，不再每 8 秒全量重抓（推送斷線才退回輪詢）。
- **新歌自動下載**（選項，預設關）：開啟後完成的新歌自動下載勾選類型；分軌等分離完成、之後出現的分軌會補抓；MIDI／MusicXML 需另勾（站點生成可能扣 credit）。
- **網頁 → agent 通道**：面板把精簡歌單、不可用紀錄、事件寫到本機（`page-songs.json`／`page-unavailable.json`／`page-events.json`）；Hub 監看後立即更新並推送。agent 查詢免網路、免 session。
- **Agent 中樞**：
  - `locate`：歌曲 → 本機真實目錄與檔案（CLI `locate`、MCP `ace_locate`、Hub `/locate`）；同名 take 正確區分、預設排除 hardlink 檢視。
  - `ace_wait_new_song`／`cli wait`／Hub `/wait`：等下一首新歌（可再等自動下載完成並回路徑）。
  - `ace_events`／`cli events`／Hub `/page/events`：新歌、自動下載、下載完成事件。
  - `ace_library`／`cli library`：曲庫分類總覽。
  - `ace_probe`／`cli probe`：站點健康（唯讀）。
  - `ace_backups`／`cli backups`：整理備份清單與清理（預設只預覽，`--prune --commit` 才刪）。
  - `ace_masters`／`cli masters`：母帶清單（WAV 取樣率／位元深度／長度，唯讀）。
- **MIDI 不可用**：站點回 `no_download` 後記住，不再請求；狀態顯示「MIDI 不可用」而非「部分 2/3」（面板與 agent 共用紀錄）。
- `scripts/install-autostart.ps1`：登入時啟動 Hub＋watcher（`-DryRun`／`-Uninstall`）。
- `scripts/bench.mjs`：Hub／CLI／MCP 延遲基準。
- `docs/GUIDE.md`：完整說明文檔。

### 改善
- Hub 讀取改為真正的 stale-while-revalidate：不再因快照過期而等站點回應。
- CLI／MCP 連 Hub 改用 node:http keep-alive：每次呼叫 15 ms → 0.3–2 ms。
- 面板與 agent 的下載狀態改用檔名索引（一次解析、每首 O(1)），結果與舊 regex 完全一致。
- 登入過期／離線時，list／overview／locate 改用頁面快照或舊快取，不再整個失敗。

### 修正
- CLI 錯誤結束時 Node 24（Windows）libuv assertion 崩潰（0xC0000409）。
- `cache clear` 原本無作用；現在清可重建快取、保留音頻分析（`--all` 才全清）。
- `hub --status` 在 overview 出錯時崩潰並誤報 Hub 未執行。
- 歌單快取過期重抓時 `known` 被清空。
- `listSongs` 分頁迴圈變數遮蔽。

## 1.6.4 及更早
見 GitHub Releases。
