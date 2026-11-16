# 1.7.5 程式邏輯審計

本次針對下載失敗、進度停滯、歷史誤判、同名音檔、分類與播放器逐條追查並修正。範圍包含 `src/`、`agent/`、`native/`、`player/`、舊 `mixdesk/` 及封裝／啟動／註冊／矩陣驗證腳本。舊程式圖譜未涵蓋的新檔與已變動檔案，以目前原始碼補讀。這是程式正確性審計與針對性安全修復，不能代表未來沒有其他問題。

## 核心約束

- 檔案屬於哪首歌，以 task ID、來源、實存檔案、驗證及安全搬移紀錄判斷。標題、`(2)` 編號及歌曲 alias 不構成完成證據。
- 只下載已就緒分軌，不購買分軌。MIDI／MusicXML 必須是該 task 已主動要求分軌，且符合當前提交授權；WAV 獨立處理。
- 下載成功、狀態保存、分類、啟動及人工聽感是不同結果。未知／待核對與確定缺檔分開。
- 保留不同內容的原件。相同副檔名、相同大小只作候選，必須比較內容；去重原件歸檔並保留 SHA、來源與保留條件。
- 已提交而結果未知的寫入不能換入口重送。測試使用隔離曲庫及模擬端點，不觸發帳戶付費提交。

## 已修正的問題與驗證入口

| 區域 | 問題及修正 | 回歸驗證 |
|---|---|---|
| 下載生命週期 | 舊分頁連線失效與準備 worker 提早退出造成大量失敗／永久等待；停止排程並提供持久診斷，音檔與樂譜分開 | e2e S11、S14、S22–23 |
| 篩選與全選 | 三處範圍不一致；篩選、選取與下載共用可見集合，未知不當作沒有 | selection-status、e2e S29 |
| 本機索引 | 搬檔後歷史失效、同名跨 task 誤判；共用來源索引、穩定實體 ID、已驗證搬移 alias、非音訊完成 key | local-index、local-index-service、exact-download-runtime |
| 傳輸 | 完整曲庫索引可能超過 Chrome Native 回應上限；Native 專用 gzip envelope、有界解壓及通用 frame 上限，HTTP 保留完整索引 | local-index-service、native-integrity |
| 音檔保全 | 原 WAV 冒充 MP3、跨格式去重、同名同大小刪除不同內容；驗格式、流式 SHA、安全唯一檔名與可回溯歸檔 | mutation-safety、file-ops、dedupe |
| 音檔檢查 | 大封面 ID3 標籤讓合法 MP3 被當未知；有界定位音訊起點，驗標籤／footer／完整 MPEG frame，不再重下載正常檔 | audio-library |
| 狀態與寫權 | 多入口並寫、失敗後寫入佇列失效、Windows 暫鎖、歷史匯出截斷；跨程序 lease、原子替換有限重試、增量合併及未知欄位保留 | library-lease、backend-safety、native-integrity |
| 計數與停止 | 狀態寫入或畫面 callback 失敗被當成音檔失敗；分開保存結果，Native 逾時保留程序並回報結果未知，watch 停止採協作式 | mutation-safety、watch-state、native-integrity |
| 老歌分軌 | 只監看新歌，漏掉老歌新增／更新的軌道；首次基線、ready fingerprint、持久 pending、恢復只補 GET | e2e S24–26 |
| 站點請求 | 跨來源 CDN／轉址帶帳戶 Cookie；逐跳限制原始 origin，不把跨站寫入當安全重試 | mutation-safety |
| 工作與事件 | 開始工作重入、同 URL 串名、游標 0／不同來源時鐘混用、watch 心跳洗掉錯誤 | browser-downloads、event-cursor、watch-state、e2e S27 |
| 提示詞 | 套用時模型、模式、上限或詞典可能已變；套用前重驗，不截斷或覆寫不相容草稿 | prompts、e2e S28 |
| 分類 | `Artist - Song` 被判分軌，同名異內容 link 被略過；明確路徑／role 判斷及安全 link/copy | audio-classification |
| 分析與快取 | 音高索引與 C 起點偏移；修正換算並使用新版算法標記，舊快取保留而不當正確調性復用 | legacy-regressions、audio-classification |
| 獨立播放器 | Range／路徑邊界、狀態 CAS、多視窗草稿、搬移 ID、隨機結束及選曲不打斷播放；後臺補檔自然刷新，編輯中延後 | player-server、browser-downloads、隔離 UI 流程、player-quiet-refresh |
| 舊工具 | mixdesk 狀態讀取失敗覆寫原件、寫入佇列、跨站寫入、動態 HTML、Range、切歌及 MCP 錯誤回報；註冊腳本空設定寫壞 JSON、benchmark 永久等待、矩陣 NaN 假通過 | legacy-regressions |

## 驗收界線

自動測試通過不等於真人聽感、音樂分類準確率、商店審核或公開發布通過。本機部署、實體曲庫核對與真實視窗操作另有當次記錄；私有曲庫、帳戶狀態、診斷原件及交接文檔不放進公開程式包。

隨機 Idea 連同歌名寫入提示詞保留在後續計劃，本版不擴充生成工作台或第三方帳戶整合。
