# Chrome Web Store Listing — ACE Music 批量下載器

> Last Updated: 2026-11-16

## Store Listing

**Extension Name** [REQUIRED]

ACE Music 批量下載器

**Short Description** [REQUIRED]

在自己的 ACE Music 歌曲庫一次下載分軌、MIDI、MusicXML、MP3 與封面，自動改名並分類到本機資料夾。

**Detailed Description** [REQUIRED]

在 acemusic.ai 的 Create 歌曲庫頁面加入一個下載面板，把你自己的歌曲一次抓齊。

功能：
• 批次下載分軌（Vocals、Drums、Bass、Guitar、Keys…）、MIDI、MusicXML、MP3、WAV 與封面
• 自動命名與分資料夾，例如「歌名/歌名 - Vocals.mp3」「歌名/歌名 - MIDI.mid」
• 每首歌顯示已下載／部分／未下載，可只看未下載
• 一鍵整理：舊檔改名、成品 MP3／成品 WAV 集中、採樣包依樂器分類、依檔案類型分類、內容去重、音頻屬性分類（BPM／調性／能量）
• 不會重複下載已存在的檔案；可選「強制重下」
• 可選的本機整理工具，用於修正檔名與移動檔案；不安裝也能正常下載
• 命名爐：替同一首歌的分軌／版本產生雙語名字，經你授權資料夾後才改本機檔名，並留下可復原的改名紀錄
• 進階：可連接你電腦上的本機中樞（127.0.0.1），讓本機播放器、CLI／MCP 使用同一份下載資料

使用方式：
1. 安裝後開 https://acemusic.ai/create/ 並登入
2. 右下角點「批量下載」開啟面板
3. 選擇歌曲與檔案類型，按「下載選中」
4. 到「下載/ai音樂」資料夾取檔

隱私：
本擴充功能只在你自己的瀏覽器與你自己的 acemusic.ai 帳號運作；不連接任何第三方伺服器、不收集分析資料、不販售或分享資料。登入狀態與下載紀錄只存在本機。唯一的其他連線是你自己電腦上的本機中樞（127.0.0.1），未啟動時不使用。命名爐只讀寫你明確授權的資料夾。

支援：
遇到問題請到 GitHub Issues 回報（連結見下方）。

注意：分軌、MIDI 等屬於 ACE Music 的付費功能，需要你自己的方案支援；WAV 僅部分模型提供（例如 amusic-v1.1），模型不支援時會自動跳過、不列為失敗。本擴充功能與 ACE Music 無隸屬關係。

**Category** [REQUIRED]

Productivity

**Single Purpose** [REQUIRED]

在 acemusic.ai 頁面批次下載使用者自己歌曲的分軌與樂譜檔案，並整理到本機資料夾。

**Primary Language** [REQUIRED]

Chinese (Traditional)

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | icons/icon-128.png |
| Screenshot 1 [REQUIRED] | 1280×800 | ✅ Ready | store-assets/screenshot-1.png |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ✅ Ready | store-assets/screenshot-2.png |
| Screenshot 3 [RECOMMENDED] | 1280×800 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

### Screenshot Notes

1. `screenshot-1.png`：Create 頁面 + 面板歌曲列表（顯示已下載狀態與選項）。
2. `screenshot-2.png`：下載／整理進度或分類結果示意。

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| downloads | permissions | 儲存使用者選擇下載的分軌、MIDI、MusicXML、MP3、封面到 Downloads 資料夾。 |
| storage | permissions | 記住使用者的選項、已下載紀錄與歌名資料夾指派，避免重複下載。 |
| nativeMessaging | permissions | 選用的本機整理工具：當 Chrome 未採用指定檔名時自動修正，以及在使用者按「整理舊檔」時於 Downloads 內移動／改名檔案。未安裝工具時此權限不使用。 |
| cookies | permissions | 讀取使用者自己 acemusic.ai 的登入 Cookie，用來呼叫站點自己的 API（列歌、產生 MIDI／MusicXML、下載檔案）。Cookie 只存在本機。 |
| alarms | permissions | 每 30 分鐘重新匯出一次登入狀態給本機 CLI／MCP，避免使用者頻繁手動同步。 |
| https://acemusic.ai/* | host_permissions | 在 Create 頁面注入下載面板並呼叫同源 API。 |
| https://www.acemusic.ai/* | host_permissions | 站點會使用 www 網域，需同樣支援。 |
| http://127.0.0.1/* | host_permissions | 只連接使用者自己電腦上的本機中樞（HuaiDJ Hub／本機播放器），用來讀取本機下載索引、開啟本機播放器與使用者自行啟動的中樞工作台。網址限定 127.0.0.1，不連任何外部伺服器；中樞未啟動時完全不使用。 |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?**

No data is sent to the developer or third parties. Locally processed data is listed below.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | — | No |
| Health info | No | No | — | No |
| Financial info | No | No | — | No |
| Authentication info | Yes (local only) | No (only sent to acemusic.ai as part of the user's own requests) | 代表使用者呼叫站點 API | No |
| Personal communications | No | No | — | No |
| Location | No | No | — | No |
| Web history | No | No | — | No |
| User activity | No | No | — | No |
| Website content | Yes (local only) | No | 顯示歌單、建立下載清單、去重 | No |

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]

https://huaidj.github.io/acemusic-batch-downloader/privacy.html

（原始文件：[PRIVACY.md](../PRIVACY.md)）

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]

yutianyu111602-glitch

**Contact Email** [REQUIRED]

yutianyu111602@users.noreply.github.com

**Support URL / Email** [RECOMMENDED]

https://github.com/huaidj/acemusic-batch-downloader/issues

**Homepage URL** [RECOMMENDED]

https://github.com/huaidj/acemusic-batch-downloader

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.8.0 | 2026-11-17 | 整合版：1.7.4／1.7.5 下載完整性修復、命名爐（雙語命名＋可復原改名紀錄）、本機中樞入口（新增 http://127.0.0.1/* 權限，見 Permissions Justification）、隨機 Idea 內含歌名、按停止時剛完成的下載正確計入、ZIP 路徑修正。 | Ready to submit |
| 1.6.4 | 2026-11-16 | 登入過期／429 限流清楚提示並中止、MIDI 生成降速重試、站點不提供檔案改為跳過（不再顯示 [object Object]）、WAV 分軌不進成品WAV、去重報表區分 hardlink。 | Draft |

## Review Notes

### Known Issues / Limitations

- 分軌／MIDI／MusicXML 需要使用者自己的 ACE Music 付費方案；Free 方案會顯示站點回傳的錯誤。
- nativeMessaging 為選用功能；未安裝本機工具時擴充功能仍可下載，只是不會自動修正檔名或整理。
- 只在 acemusic.ai 的 Create 歌曲庫頁（含語言前綴路徑）顯示面板。
- 沒有遠端程式碼、沒有 eval、沒有第三方分析。

### Rejection History

（尚無）






