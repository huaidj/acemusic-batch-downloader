# 隱私政策／Privacy Policy

**最後更新：2026-11-16**

ACE Music 批量下載器（以下稱「本擴充功能」）只在使用者自己的瀏覽器內運作，處理使用者自己在 [acemusic.ai](https://acemusic.ai/) 的歌曲與登入狀態。

## 收集與使用

- **登入狀態（Cookie）**：本擴充功能讀取 `acemusic.ai` 的登入 Cookie，用於代表使用者呼叫站點自己的 API（列出歌曲、產生 MIDI/MusicXML、下載檔案）。Cookie 只存在本機 `chrome.storage.local`，以及在按下「同步 Agent」時寫入本機檔案 `%LOCALAPPDATA%\AceMusicDL\session.json` 供本機 CLI／MCP 使用。
- **歌曲資料**：歌名、分軌、時長、封面網址等，只用來在面板顯示與建立下載清單，儲存在本機快取。
- **下載紀錄**：已下載的檔案路徑與狀態，存在 `chrome.storage.local` 與 `%LOCALAPPDATA%\AceMusicDL\`，用於避免重複下載與整理。

## 傳輸對象

- 只與 `acemusic.ai`（以及 `www.acemusic.ai`）通訊，這是使用者正在使用的站點。
- **不**連接任何第三方伺服器、分析服務或廣告網路。
- 不販售、不分享、不用於信用評估或與核心功能無關的用途。

## 本機檔案

- 下載的檔案寫入使用者的 Downloads 資料夾。
- 選用的本機整理工具（native messaging host）只會在使用者按下整理按鈕時，於 Downloads 目錄內移動／改名檔案。
- Agent 匯出的登入狀態只存放在本機 `%LOCALAPPDATA%\AceMusicDL\`，不會上傳。

## 資料刪除

- 移除擴充功能即清除其 `chrome.storage.local` 資料。
- 可手動刪除 `%LOCALAPPDATA%\AceMusicDL\` 與 `Downloads\ai音樂\`。

## 聯絡

有隱私相關問題請開 GitHub Issue：<https://github.com/huaidj/acemusic-batch-downloader/issues>
