# Changelog

## 未發布 — 整合 HuaiDJ 創作中樞（2026-11-17）

- 合併 `feat/huaidj-music-agent`（9b29ecf）到 1.7.5：Hub 同時提供下載索引／播放器與 `/music/*`、`/create-api/*`；MCP 共 74 個工具。`feat/v11-direct-generation-z` 是同一 v1.1 直接生成的較早版本，已由此分支涵蓋，不另行合併。
- 站點請求保留 1.7.5 的 Cookie 只送原站與手動轉址檢查，再加上受控模式：未在有限授權內的舊轉譜等站點寫入一律在發出 HTTP 前拒絕。
- 即時歌單由「自動更新、新歌自動下載、分軌完成自動下載」任一開啟決定；本機 host 不再能強制開啟已關閉的同步。
- Mixdesk 保留 1.7.5 的可注入工廠結構，改用非阻塞、有上限的分析佇列與逾時；首次索引在背景執行。
- 面板加入 HuaiDJ 創作中樞入口；獨立播放器沿用 1.7.5，不再內嵌電臺。
- 播放器新增「網站點讚」：讀取 acemusic.ai 歌曲卡片的拇指向上（`meta.rating === "good"`），唯讀抓取全部分頁，完整才替換 `site-likes.json`；失敗保留上次資料並顯示原因。未下載的點讚歌也列出。原「收藏」改名「本機收藏」，兩者分開。新增 CLI `site-likes [--sync]` 與 MCP `ace_site_likes`。

## 1.7.5 — 2026-11-16（本機審計修復版）

- 統一面板、CLI、Hub 與播放器的本機檔案索引；按 task／來源／搬移紀錄判斷，不借用同名歌曲的歷史。區分缺檔、待核對、格式損壞與不提供。
- 修正分類搬移後面板仍顯示未下載；整理保留逐檔來源並刷新索引及已核驗音訊路徑。只看未下載、全選與實際工作範圍一致。
- 原始 WAV 不再被當作 MP3；內容去重依格式及 SHA-256，同名同大小但內容不同的檔案保留，覆寫／去重原件先歸檔並記錄用途與雜湊。
- 獨立 HuaiDJ 播放器：搜尋、本機檔案、MP3／WAV／分軌狀態、佇列、播放清單、收藏、歷史、seek、隨機／循環、音量及媒體鍵；選曲不自動播放，下載面板不再內嵌電臺。
- 老歌後來新增／更新分軌也能自動補檔；首次只建立基線。MIDI／MusicXML 每次提交前重驗這首歌的分軌資格與授權；WAV 另行下載，不購買分軌。
- 修正啟動工作的重入、同 URL 下載串名、事件游標 0、watcher 錯誤被心跳洗掉、JSON 寫入失敗後持續失效等問題。
- CLI／Hub／MCP 共用跨程序檔案寫入鎖；已提交但結果未知的寫入不再走第二路重送。下載紀錄增量合併，保留未知欄位與既有證據。
- 站點 Cookie 限原始 origin；CDN 直連與跨站重新導向不帶帳戶 Cookie。Native 更新使用來源雜湊命名的 EXE，保留執行中的舊程序。
- 提示詞套用時重驗模型、模式、詞典版本與當前上限；不截斷、不覆寫不相容草稿、不按 Generate。隨機 Idea 內含歌名仍列後續計劃。

## 1.7.4 — 2026-11-16（本機修復版）

- 後臺補檔後自動刷新本機狀態，無需重新整理頁面；浮鈕顯示檔案類型、短曲名及完成數。
- 六種下載類型預設全選，下載設定預設收合；選擇/篩選與曲庫工具分區，維護動作放入更多工具。
- MIDI/MusicXML 僅排入已主動要求分軌的歌曲；可用 WAV 獨立補齊，包含已有原始 WAV 的上傳曲。
- 歌單、下載與模型資訊共用 API 請求入口，統一逾時及診斷，不自動重送不確定是否提交成功的生成請求。

- 擴充功能更新後的舊分頁會立即停止下載並提示刷新，不再把同一個連線故障累積成數百個檔案失敗。
- 下載前檢查連線；取消會停止後續 MIDI/MusicXML 排程，站點請求設逾時，不再無限停在準備階段。
- 修正限流後所有準備 worker 提前退出、遺留檔案永遠等待的問題（可重現卡在 67%）。
- 修正 MIDI 的 API 類型實際為 `full` 卻未套用間隔的問題；站點生成改單一佇列，檔案下載仍可並行。
- 「只看未下載」「全選」「下載選中」共用可見範圍；狀態依勾選類型計算，包含 MP3/WAV，不再只顯示缺 MIDI。
- 同名不同歌曲按歌曲 ID 區分；不再用模糊檔名複製其他 take，也不再靠舊 alias 跳過未取得的音檔。
- WAV 的暫時 400/404 保留待補；本機音檔檢查可辨識截斷 WAV 及音訊副檔名錯配。
- 新增只處理 WAV 的修復腳本：以歌曲 ID 命名、檢查來源大小/首尾/RIFF、保存驗證紀錄，保留舊原檔。
- 新增「複製診斷」、分頁持久診斷與本機 `download-log.json`；記錄階段、等待、錯誤及計數，移除秘密與完整網址。
- 本版不包含尚未驗收的獨立播放器；也不會自動按 Generate 或自動補生成 MIDI/MusicXML。

## 1.7.3 — 2026-11-16

### 新增：電臺播放器
- 面板頂部播放器：播放／暫停、上一首／下一首、進度拖動、音量、隨機、循環（清單／單曲／不循環）、收藏、來源（全部／只聽收藏）。
- 每首歌右側有播放與愛心；封面點一下即播；「只看收藏」過濾；正在播的歌高亮。
- 系統媒體鍵與鎖定畫面資訊（Media Session：播放／暫停／上下首／拖動）。
- 播放失敗（音檔失效、未登入）自動跳下一首，整個佇列都失敗才停並提示，不會無限跳。
- 設定與收藏存在 `aceRadio`／`aceFavorites`；收藏也交給本機（`page-favorites.json`）供 agent 使用。

### 新增：隨機提示詞（接入 ACE 的 Idea／Custom 介面，並區分模型）
- 面板新增「隨機提示詞」：12×12 風格矩陣（144 格，已用 `scripts/verify-matrix.mjs` 驗證都能編譯、長度 746–764、固定約束都在）。可鎖 A 軸或 B 軸只變另一軸，保留最近 12 組。
- **區分模型與模式**：從頁面自己的資料讀目前模式（`createMode`／`#ideaMode`）與模型（`aceModel`，並與模型按鈕上的名稱交叉核對；名稱互為子字串時取最長者），再選詞典與欄位：Idea→自然語言框 `#prompt`（v1.1 上限 2000）、Custom→Style 框 `#caption`（v1.1 上限 1000）。字數上限來自站點 `/api/status`。
- 目前只有 **ACE Music v1.1 Preview** 有驗證過的詞典；ACE Music v1、ACE-Step v1.5 XL（Style 上限 512）顯示原因並只提供說明，不自動填入、不硬截斷。
- 填入用原生 setter＋input 事件（頁面字數計數會更新）並讀回核對；**絕不按 Generate、不動 Lyrics**。產生後若你在頁面切了模型或模式，舊結果會被拒絕套用。
- agent 同步支援：CLI `prompt`、MCP `ace_random_prompt`、Hub `GET /prompts/random`（只產生文字，不提交生成）。
- 本地 seed 只復現「抽到哪一格」，不保證站點生成相同音訊。

### 修正：為什麼只下載了一部分、為什麼很多 WAV 沒下載
- **站點限流（429）不再停掉整個工作。** 以前 MIDI／MusicXML 一被限流就把整個下載中止（顯示「已停止」），後面的 WAV、MP3、分軌都沒機會下載，自動整理也被跳過。現在只停「站點生成」那條佇列：等 60 秒重試（最多 2 次），仍限流才略過剩下的 MIDI／MusicXML，其他檔案照常下載，進度顯示「限流略過 N」，補齊只要再按一次下載。
- **WAV 排在 MIDI 後面被拖住。** 檔案網址（WAV／MP3）與站點生成（MIDI／MusicXML）改為兩條獨立準備佇列，WAV 不再等 MIDI 的 2.5 秒間隔與限流。
- **WAV 判斷改用站點規則**：模型在 `/api/status` 標 `lossy`（ACE-Step 系列，來源 m4a）就沒有 WAV；其餘模型（含日後新模型）都會排 WAV。面板與 agent 共用（`lossyModels`），讀不到時用後備規則。
- **「部分 1/3、2/3」現在直接寫缺什麼**：例如「部分 2/3 · 缺 MIDI」。原因是這些歌的 MIDI／MusicXML 還沒請求成功（上述中止），不是站點沒有。
- 歌單上限 400 → 2000 首（舊值會默默截斷）。

### 修正：歷史問題
- Chrome 下載紀錄為空時不再用空資料覆寫本機 `history.json`（曾被洗成 0 筆）。
- 備份清理的測試會寫進真正的 `agent.log`：`appendLog` 現在接受 cfg，沙盒不再污染。
- 自動整理只在工作未中止時執行，過去因限流中止而一直沒跑，造成散落檔案與 68 個空資料夾；中止原因已修正。
- 面板內有一個 `const CSS` 遮蔽了瀏覽器的全域 `CSS`，使用 `CSS.escape` 會當掉（新程式已改走 `window.CSS`）。

### 測試
- 單元 86、e2e 19（新增 S17 電臺、S18 隨機提示詞的模型／模式區分；S14 改為驗證限流時 WAV 仍下載）。

## 1.7.2 — 2026-11-16

### 介面
- **去 AI 味配色**：移除藍紫漸層與發光；改為暖石墨底＋單一低彩度琥珀強調色，狀態只用柔和綠／琥珀／紅。主按鈕、進度條改實色。
- **半透明面板**：背景模糊＋標題列「透明」滑桿（40–100%），記住設定。
- **可拖曳**：拖標題列移動面板；浮動按鈕也能拖（拖動不會誤開面板，點一下照常開）；位置記住、自動夾在視窗內、視窗縮放時重新夾；雙擊標題列回到預設位置。面板沒被單獨拖過時會貼著浮動按鈕開。
- 工具列按鈕不再把文字拆成兩行；停用的「下載選中」改為清楚的灰色。
- 支援 `prefers-reduced-motion`。

### 修正
- 未登入時不再訂閱站點推送（之前會一直 401 重連）；歌單成功載入後才開始即時同步。

### 測試
- e2e S16：拖曳面板、拖曳浮動按鈕不觸發開關、透明度套用、`aceUi` 保存（17/17）。

## 1.7.1 — 2026-11-16

### 新增
- **整合契約** `GET /capabilities`：apiVersion、端點、事件、檔案類型、選歌器、頁面檔、驗證方式；`/health` 加 `apiVersion`。供其他擴充功能／agent 接入時檢查相容性。
- **來源限制（CORS）**：Hub 只接受無 Origin（CLI／MCP）、擴充功能（`chrome-extension://`…）與本機頁面；一般網站 403（防跨站 POST 觸發下載）。`ACE_HUB_EXTENSIONS` 可只允許指定擴充功能 ID；支援 preflight 與 Private Network Access。
- `ace_download`／CLI `download`／Hub `/download` 支援 `latest: N` 與 `types: ["all"]`（例：「把剛做好的歌全部抓下來」＝`latest:1, types:["all"]`）。
- MCP `ace_tidy`（一鍵整理，可等完成）。
- 登入 Cookie 輪換時自動重新匯出給 agent（`chrome.cookies.onChanged`，2 秒 debounce），agent 不再因 Cookie 輪換而過期。
- `docs/CONVENTIONS.md` 開發規範；`test/unit/conventions.test.mjs` 把關（清單一致、文件涵蓋每個 MCP 工具與 Hub 端點、頁面檔白名單都被 Hub 監看、來源限制）。

### 改善
- 選歌與類型展開統一由 `ACE.selectSongs`／`normalizeTypes` 實作，Hub／CLI／MCP／locate 共用；未知類型會報錯而不是靜默忽略。

### 修正
- Hub `/download` 沒給任何條件時原本會選「全部歌曲」；現在需明確 `all: true`。

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
