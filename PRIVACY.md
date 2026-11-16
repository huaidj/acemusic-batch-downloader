# 隱私政策／Privacy Policy

**最後更新：2026-11-17**

ACE Music 批量下載器（以下稱「本擴充功能」）只在使用者自己的瀏覽器內運作，處理使用者自己在 [acemusic.ai](https://acemusic.ai/) 的歌曲與登入狀態。

## 收集與使用

- **登入狀態（Cookie）**：本擴充功能讀取 `acemusic.ai` 的登入 Cookie，用於代表使用者呼叫站點自己的 API（列出歌曲、產生 MIDI/MusicXML、下載檔案）。Cookie 只存在本機 `chrome.storage.local`，以及在按下「同步 Agent」時寫入本機檔案 `%LOCALAPPDATA%\AceMusicDL\session.json` 供本機 CLI／MCP 使用。
- **歌曲資料**：歌名、分軌、時長、封面網址等，只用來在面板顯示與建立下載清單，儲存在本機快取。
- **下載紀錄**：已下載的檔案路徑與狀態，存在 `chrome.storage.local` 與 `%LOCALAPPDATA%\AceMusicDL\`，用於避免重複下載與整理。
- **中樞入口**：擴充功能只保存使用者選定的 `127.0.0.1` 中樞網址。生成、研究、產物與預算的業務狀態留在同一個本機 Hub。

## 傳輸對象

- 下載與生成使用 `acemusic.ai`（以及 `www.acemusic.ai`）。官方音訊端點重新導向到明確允許的儲存 CDN 時，後續下載不附 ACE Cookie 或登入標頭；簽名下載網址不寫入紀錄。
- 使用者另行啟用公開文字研究時，本機 Hub 會向 `api.deepseek.com` 發送已審閱的搜尋文字及來源網址（搜尋／抓頁），或使用者提供的公開文字提示（思考模式 `deepseek-flash`）。DeepSeek API key 只用於該官方 API 的授權標頭；ACE Cookie、私人音訊與本機路徑不送給 DeepSeek。思考模式的模型輸出只留在本機 Hub 的稽核紀錄，不傳給其他對象。
- 中樞可讀取已配置的本機 BadDJ MixCore 狀態；不因此啟動引擎、修改它的曲庫或自動播放。
- 不連接廣告或行為分析網路。
- 不販售、不分享、不用於信用評估或與核心功能無關的用途。

## 本機檔案

- 下載的檔案寫入使用者的 Downloads 資料夾。
- 選用的本機整理工具（native messaging host）只會在使用者按下整理按鈕時，於 Downloads 目錄內移動／改名檔案。
- Agent 匯出的登入狀態只存放在本機 `%LOCALAPPDATA%\AceMusicDL\`，不會上傳。
- **命名爐**：只有在你按下「連接 ai音樂」並授權本機資料夾後，才會讀取該資料夾的檔名與 `_manifest.json`；改名也只在你按下「套用改名」時發生。資料不離開本機、不上傳。可隨時在 Chrome 的網站資料設定撤銷資料夾權限。

## 資料刪除

- 移除擴充功能即清除其 `chrome.storage.local` 資料。
- 解除安裝不會刪除音樂、母帶或生成證據。移除狀態與音樂是不同動作，需另行指定範圍；沒有自動清理原始音樂的流程。

## 聯絡

有隱私相關問題請開 GitHub Issue：<https://github.com/huaidj/acemusic-batch-downloader/issues>

## 可選的生成與研究功能（本機中樞）

本機準備詞典與 HTTP JSON 不對外傳輸。使用者明確啟用受限生成後，音樂描述、Style、Lyrics、選定的模型與控件會直接傳至 ACE Music；Cookie 僅用於官方同源請求，不交給第三方代理。參考及上傳仍預設關閉，Spotify 來源內容不得進 AI 請求。DeepSeek 研究需要獨立有限預算、請求數與期限，預設關閉；搜尋／抓頁按次計費，思考模式按 token 用量計費。來源內容是資料，不會改變工具權限。密鑰不寫進程式、SQLite、提示詞、頁面或交付包；打包流程會掃描發佈物，命中金鑰樣式或私密狀態檔就中止。
