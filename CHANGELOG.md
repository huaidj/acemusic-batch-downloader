# Changelog

## 1.9.4 — 2026-11-17（取名器 v3：讀書語料＋句法，不是隨機拼字）

- 取名器改成「依音樂特徵挑詞、依語料關係組句」：
  - 用 DJ.Studio／整理管線的音頻分析（BPM、Camelot、能量）決定語意傾向（慢→沉／暗、快→機械、能量低→靜）。
  - 詞與詞之間要有來源關係才配對（共同的 tag、同勢力、裝置主題相符）；沒有關係的組合不會出現。
  - 兩本書平衡：夜城類超過 45% 會壓低權重、電子百科類超過 55% 也會壓低，避免整批都是同一個世界觀。
- 加入四位「靈感子代理」讀《靈感電子百科大全》各章後產出的語料（`naming/inspiration/`）：
  抽象詞 54、具體意象 66、已成形短語 55、荒謬並置 53、句法模板 8 組、動詞 20 個、荒謬配對 16 組。
  例：〈夜海的下潛〉〈雨中的第二層光〉〈掌聲比末日響〉〈低周波的投訴〉〈義體的童年〉。
- 加入句法層：`{抽象}的{具體}`、`在{具體}裡{動詞}`、`把{抽象}{動詞}成{具體}`、`{抽象}是{具體}`、`給{抽象}的{具體}`、`沒有{具體}的{抽象}`、`{數字}{單位}的{抽象}`、`{具體}在{動詞}`。
- 同一個歌名家族（同名不同 take／版本）共用基底名，成員加變體標記（原檔名的描述或 II／III），改名後仍看得出是同一首的變體；檔名唯一性由程式保證。
- 取不到合適組合時用「概念＋音樂尾詞」輪替補位，不會整批同一個名字。

## 1.9.3 — 2026-11-17（面板重新命名這批＋白話日誌＋播放器托盤）

- 面板「維護」新增 **重新命名這批**：背景跑 `named-copy`，只回一句摘要（新寫／已存在／失敗／日誌筆數），不擋操作。
- 新增 **日誌摘要**（預設收起，只留入口與「打開摘要檔」按鈕）：每輪整理寫成一頁白話 Markdown 放在曲庫根目錄 `_整理摘要.md`（最新在最上面，保留 20 輪）；機器用的完整紀錄在 `%LOCALAPPDATA%\AceMusicDL\logs\activity.jsonl`（append-only，不刪）。
- 一鍵整理完成訊息改成一句話（「整理完成（細節在『日誌摘要』）」），下載、分類、複製、改名全部在背景安靜跑完。
- CLI 新增 `activity [--json] [--open] [--limit N]`；native host 升到 1.2.1，新增 `named-copy`／`activity`／`open-file`（只允許曲庫或 Downloads 內的 .md／.json／.txt）。
- **獨立播放器改成托盤**：`player\start.ps1` 預設只留系統匣圖示（視窗隱藏），右鍵圖示可「調整參數…」（視窗大小、啟動時隱藏）／顯示、隱藏、重新啟動；`node cli.mjs player --tray [--show]` 同效果。

## 1.9.2 — 2026-11-17（一鍵整理接上改名WAV與硬連結、證據修補）

- 一鍵整理新增兩步：`namedcopy`（詞庫命名 → `改名WAV`，複製式、寫 `_命名日誌.json`）與 `hardlinks`（`收藏`／`已點讚` 內同內容副本改硬連結）。兩步都受 `config.json` 的 `naming.enabled`／`hardlinks.enabled` 控制，預設開啟、冪等（已存在就跳過）。
- 新增 CLI `repair-evidence [--commit]`：把實際存在的 `成品WAV` 用「`[8hex]` 尾碼 → task_id」或「唯一歌名」補回 `agent-state.json` 的 WAV 證據（搬庫後 `收藏` 出現 `noWav` 的修補用）；預設 dry-run，commit 前自動備份。
- 本機索引新增「檔名證據」補強：沒有下載紀錄歸屬的 WAV，若尾碼或歌名能唯一對到 task，就以 `recorded` 等級收進索引（不改檔、不改 state）。
- 修正：CLI 版本字串改由 manifest 驅動的測試守門（banner 固定 1.9.2、MCP server 同步），全套單元測試 553/553。

## 1.9.1 — 2026-11-17（改名WAV 交付：詞庫命名、封面、藝人、硬連結省硬碟）

- 新增 `成品AIFF`：一鍵整理與背景整理會在 `成品WAV` 之後多跑一步，把每首 WAV 轉成 AIFF（`pcm_s16be`，樣本不重算、大小不變），原檔名不變。
- 每首嵌入 `成品WAV` 對應的 `<root>/封面/<歌名> - Cover.jpg`（JPEG，`APIC`，ID3v2.4），並寫入藝人（預設 `VooDooBoys`）；`-map_metadata -1` 不搬任何來源 metadata，ACE 指紋不會跟著過去。
- 為什麼是 AIFF：rekordbox 不顯示 WAV 的封面（Pioneer 把 WAV 歸在 RIFF INFO 文字欄位），AIFF 是同樣 PCM 但吃 ID3v2.4。
- 設定在 `<stateDir>/config.json` 的 `aiff`：`{ "enabled": true, "artist": "VooDooBoys", "concurrency": 3 }`；`enabled: false` 可關閉。
- 新增 CLI `export-aiff [--root 名稱] [--artist 名稱] [--force] [--dry-run]`；輸出 `成品AIFF/_對照表.json`（原檔名 → AIFF、標題、藝人、封面、大小）。已存在就跳過，重跑零成本。
- 同時新增 `<stateDir>/config.json` 的 `downloadDir`：可以把整個曲庫指到別的磁碟（例如 `"downloadDir": "E:\\"`），環境變數 `ACE_DOWNLOAD_DIR` 仍優先。

- 新增 `named-copy`：用《夜城人物事典》《靈感電子百科大全》抽出的詞庫（`naming/corpus-lexicon.json`）組合中文＋英文名，輸出到 `改名WAV`（複製式、來源 WAV 不動），名字尾綴生成時間（`YYYY-MM-DD HHMM`）。
- 新增 `named-lookup "<新名字或中文名>"`：從 `改名WAV/_命名日誌.json`（`vdb_naming_journal_v1`）倒查原本是哪個檔、用哪個版型、哪個 seed。
- 新增 `hardlink-dedupe [--commit]`：`收藏`／`已點讚` 內與 `成品WAV`／`成品MP3` 內容完全相同（大小＋sha256）的檔案改為硬連結，同碟才做、跨碟退回複製；預設 dry-run。
- `export-aiff --liked`：把 `已點讚/*.wav` 轉成 `改名WAV/已點讚/*.aiff`（原名字直接用、封面、藝人）。
- 文件：`docs/session-2026-11-17-consolidated.md`（這一輪所有零碎要求的定案與衝突裁決）、`docs/ai-aiff-naming-and-space.md`（可重複機制設計）。

## 1.9.0 — 2026-11-17（獨立播放器全功能化）

- **BPM／調性／能量**：播放器新增 `/api/analysis`，把整理管線的分析快取（`cache/audio-analysis.json`）對到實際音檔；曲庫表格新增 BPM、Camelot 調性兩欄（可點標題排序），右側詳細面板顯示 BPM／調性／能量。新增 BPM 區間與調性篩選；沒資料顯示「—」與「未分析」。播放器只讀快取，不觸發分析。實測只回前端看得到的檔案 ID（988/1266），別名與 hardlink 不多送（原本會回 10,824 筆）。
- **播放佇列操作**：每首歌可按「下一首播放」（插到目前曲目後面、不重複）、在佇列上下移動、單獨移除；順序照舊保存。
- **M3U8 匯出／匯入**：`GET /api/playlists/<id>/m3u`、`POST /api/playlists/import`。匯出含絕對路徑（Rekordbox／Serato／Mixxx 可直接載入），檔名用清單名；匯入先比對絕對路徑、路徑失效才用唯一檔名（同名不同資料夾不猜），不在曲庫的路徑逐條回報，且匯入本身走版本遞增，不與其他視窗的 CAS 衝突。
- **鍵盤快捷鍵**：新增 `J`／`L` 前後 5 秒、`M` 靜音、`F` 收藏、`Q` 開關佇列、`/` 搜尋、`?` 快捷鍵說明；修正事件來源不是元素時 `closest` 會拋錯的問題。
- **睡眠計時**：15／30／60／90 分鐘，到時自動暫停並提示，可隨時取消。
- 單元測試 553/553（新增 player 分析／M3U 3 個）；另用隔離服務＋headless Chrome CDP 做互動冒煙（排序、調性篩選、`?`、睡眠、佇列、M3U 按鈕）7/7 通過。

## 1.8.10 — 2026-11-17（整理不重複跑、背景整理補上已點讚）

- **一鍵整理不再疊羅漢**：連續觸發（下載完自動整理、面板按鈕、CLI、Hub、MCP）會合併。跑的那一輪持有 `%LOCALAPPDATA%\AceMusicDL\tidy-run.lock`；其他觸發不排隊等曲庫租約、也不各自跑完整管線，只寫 `tidy-pending.json`，讓那一輪在結束後最多補跑一輪（`takePendingTidyRun` 只吃一次，避免無限循環）。持有者行程已死留下的過期鎖自動清除；釋放時比對 token，不會刪掉別人的鎖。
- 修正實測問題：同一次下載完成後 1 分鐘內來了 3 個 tidy-all，靠租約排隊各跑約 5 分鐘，並重複產生 `(2)…(8)` 同名副本。現在最多一輪＋一次補跑。
- `cli.mjs tidy-all --background` 也會先看有沒有人在跑：有就只登記、不另開行程；合併掉的那次不寫 `tidy-status.json` 的 `done`（面板進度條仍跟真正在跑的那一輪）。
- **背景整理 daemon（`watch.mjs`）補上「已點讚」步驟**：先前只做到收藏夾，取消點讚／新點讚的副本不會更新；現在管線是 … → 收藏 → 已點讚（AI 命名），狀態檔同步記錄 `liked` 步驟。
- 新增 6 個單元測試（`tidy-guard.test.mjs` 5 個＋watch 已點讚步驟 1 個），全套 550/550 通過。

## 1.8.9 — 2026-11-17（收藏夾改成平的 WAV 母帶）

- 收藏夾改版（使用者指定）：不再 `收藏\<歌名>\` 一歌一資料夾、也不再複製 MP3／分軌／MIDI／MusicXML／封面，改成 **`ai音樂\收藏\<歌名>.wav` 平鋪一層**，每首歌只留一個成品 WAV 母帶（索引裡 verified 優先、再來 recorded；分軌與損壞檔不收）。
- 站點只有 MP3 的歌（例如 ace-step 產出的歌）沒有母帶可收，計入新欄位 `noWav`，不再退而放 MP3；檔案仍在 `成品MP3`／`已點讚`。
- 舊版 `收藏\<歌名>\` 子資料夾與其中的雜檔會在下次整理時清掉：只刪「清單記過、大小沒變」的我們放的副本，使用者自己改過或自己放的一律保留，資料夾空了才移除（回報 `pruned`／`prunedDirs`）。
- 清單升級 `ace_favorites_manifest_v2`（含 `layout: "flat-wav"` 與每首的 `file` 名）；歌名變更時會把我們沒被改過的舊副本原地改名，不重複複製。同名不同內容仍不覆寫（`--force` 才覆寫並先歸檔）。
- CLI `favorites` 摘要新增「更新／改名／沒有 WAV／清掉舊版雜檔」；MCP `ace_collect_favorites` 說明同步。

## 1.8.8 — 2026-11-17（已點讚資料夾）

- 新增「已點讚」：網站拇指點讚的歌，把成品 MP3／WAV 複製到 `ai音樂/已點讚/`（平鋪，只放成品音檔；來源檔不動）。一鍵整理新增 `liked` 步驟；CLI `liked-folder [--dry-run] [--no-ai] [--budget 0.5]`、MCP `ace_liked_folder`。
- 名字由 DeepSeek（deepseek-flash、非思考模式）取「中文 - English」雙語名；每次呼叫前先按最壞情況預留費用，累計上限預設 US$0.50；結果未知時照預留計費、不重試。名字與花費記在 `已點讚/_命名對照.json`，重跑不重複付費；沒有 API key 或超出上限時先用網站歌名，下次再補 AI 名並把我們的副本原地改名。
- 只送歌名與提示詞／風格文字（每首最多 280 字），不送音訊、Cookie、帳號或本機路徑（見 PRIVACY.md）。
- 點讚快照不完整時整步跳過；取消點讚的副本移到 `已點讚/_已取消點讚/`、不刪除；使用者改過的副本保留。
- `收藏`、`整理輸出`、`已點讚` 統一為複本資料夾（`copy-folders.mjs`），索引、去重、分類一律略過，不會把同一首歌算兩次。
- 實測：143 首點讚、257 個檔案，AI 命名 143 首，累計 US$0.0052。
## 1.8.7 — 2026-11-17（補齊、快取與複製改名）

- 新增「補齊」：CLI `fill-missing [--types mp3,wav,cover] [--commit]`、MCP `ace_fill_missing`。依可信本機索引找出每首歌**自己**缺的免費檔（MP3／WAV／封面），預設只預覽；不碰可能扣額度的 MIDI／MusicXML；站點沒有來源的歌列為 noSource、不算失敗。
- 本機索引建置快 3–4 倍（約 2 秒 → 0.6 秒）：掃描已跳過 symlink／junction 目錄，不再逐檔 realpath；新增測試確認曲庫內指向外部的 junction 仍不會被收錄。
- 播放器快取（stale-while-revalidate）：有快照就立即回應、背景重建；5 秒輪詢從 3.4 秒降到數毫秒。明確「刷新曲庫」會等到涵蓋這次請求的新結果（修正：原本可能拿到點擊前就開始的舊重建）。
- 複製改名（`wav-names`）：
  - 改用內容比對判斷「已複製」（舊版只比大小，同一次生成的兩首大小相同時會漏複製）。
  - 新增 `整理輸出/成品WAV/_對照表.json`：每首歌固定一個輸出名字，跨次執行穩定，後來出現的同名歌不搶既有名字。
  - 來源後來變了（修復、清除指紋）而副本沒被動過 → 原地更新（舊副本先歸檔）；使用者改過的副本保留、改用下一個編號。
  - 歸屬證據加入可信本機索引（只收 verified／recorded）：原本約半數 WAV 因「沒有證據」被跳過，現在只剩真正無主的檔。注意：下次一鍵整理會補複製這些 WAV（實測約 126 個、6.4 GB）。

## 1.8.6 — 2026-11-17（證據保全與可攜性）

- 指紋清除更新 `verified-audio.json` 時改為取得 `verified-audio.lock`（與 WAV 修復、索引 proof 修復同一把鎖）；被別的工作持有時不改 proof、回報 `proofsUpdatePending`，避免兩個寫者互相蓋掉證據。
- 指紋清除保留清除前的 `sourceSha256`／`sourceBytes`，仍可證明檔案原本就是站點提供的那一份。
- WAV 修復：已清除指紋、proof 已更新（`fingerprintStripAt` 且整檔 sha256 相符）的 WAV 直接沿用，不再因檔首 metadata 不同而重新下載；沒有清除紀錄的改動仍照舊換成來源檔。
- WAV 修復工作目錄不再限定 F 槽：只要求絕對路徑且不在下載資料夾內。
- 測試不再假設 `F:DevDataTemp` 存在：一律用 `ACE_TEST_TEMP` 或系統暫存；單元 517/517 在系統暫存下通過。
- 驗收測試補上 SUB RITUAL #11／#12／#15（填入讀回、Cover／純器樂欄位、雙曲分別驗收）。

## 1.8.5 — 2026-11-17（成品WAV 分類後複製整理輸出）

- 一鍵整理新增 `wavnames` 步驟：`成品WAV` 分類後，把乾淨名字**複製**到 `ai音樂/整理輸出/成品WAV/`；**來源檔永不移動、不改名**，插件與索引照樣讀得到原本路徑。
- 每次生成有兩首同名歌：用 task id 區分，依 `created_at` 依序 `<歌名>.wav`、`<歌名> (2).wav`、`(3)…`；同名但內容不同不覆寫（改用下一個編號）。
- 所有權只認證據、不猜同名檔：`agent-state.json` 的 wav 紀錄、`verified-audio.json` 的驗證紀錄、舊檔名尾碼 `[8hex]`（對到唯一 task id）。沒有證據、或兩個 task 都認領同一個檔，一律不複製。
- `整理輸出` 與 `收藏` 同級隔離：歌曲索引、`locate`／曲庫總覽用的檔案索引、內容去重、空殼清理、檔案分類、音頻屬性分類、`organize` 全部跳過，不會被去重搬走或算成第二份。
- 新增 CLI `wav-names [--dry-run] [--out 名稱] [--folder 名稱] [--root 名稱] [--json]`；重跑只跳過已複製的檔，耗時以 size 比對為主。
- 面板整理進度新增「WAV 整理輸出」步驟。
- 測試：`test/unit/wav-names.test.mjs` 6 個案例（尾碼／history／proof 歸屬、兩首同名編號、來源不動、重跑不重複、不覆寫既有副本、dry-run）。

## 1.8.4 — 2026-11-17（DeepSeek 研究上線：搜尋＋思考；面板維護整合）

## 1.8.4 — 2026-11-17（DeepSeek 研究上線：搜尋＋思考；面板維護整合）

- DeepSeek 研究正式可用：`/music/research` 由 `auth_required` 變成 `ready`；金鑰只從伺服器環境變數 `DEEPSEEK_API_KEY` 讀取，不寫入請求、狀態或 SQLite。授權為有限批次（$2／200 次／2026-12-17 到期，`allowed_kinds`＝search、fetch、analyze）。
- 新增 `research_analyze`（`POST /music/research/analyze`）：用 `deepseek-flash` 思考模式（`thinking:{type:enabled}`、`reasoning_effort` low/high/max）分析公開文字，回 `content`／`reasoning_content`／`usage`；依實際 token 用量以尖峰價結算，受同一份預算限制。reasoning 吃光 `max_output_tokens` 時回 `ANALYZE_OUTPUT_TRUNCATED`（附用量與 reasoning），不自動重送、不重複計費。
- `music-runtime`：新增 `DEEPSEEK_RESEARCH_BASE_URL`；共用的 `DEEPSEEK_BASE_URL` 若指向官方 origin 只取其 origin（避免 `/anthropic` 相容路徑讓研究被判非官方），非官方 origin 仍交給執行器拒絕。
- 安裝器 `install-update.ps1`：缺少時從使用者／機器環境補回 `DEEPSEEK_API_KEY` 與 `ACE_RESEARCH_CONFIG_FILE`，重跑更新不會讓 Hub 失去研究能力。
- 面板把「一鍵整理／成品MP3／開啟分類資料夾／命名爐／指紋清除／整理舊檔／背景自動整理／清自訂重複／同步 Agent」收進同一個「維護」折疊區；新增「指紋清除」按鈕（native host 新命令 `strip-fingerprints`）。
- 命名爐套用改名後會叫背景重建本機索引並通知開著的面板重畫；檔案模式仍提示回面板「維護 → 一鍵整理」。
- 文件：`docs/GUIDE.md` 新增「3.4 維護功能一覽：指紋、分類、命名」；`HUB.md`、`README-AGENT.md` 補上新端點與工具。
- 測試：`music-research.test.mjs` 新增 4 個 analyze 案例（思考參數、token 結算、範圍／預算／憑據門禁、401 不計費、reasoning 截斷）。
- 打包脫敏：新增 `agent/lib/secret-scan.mjs`，`npm run pack` 會先掃描發佈物（`sk-` 金鑰樣式、GitHub token、Bearer token、`session.json`／`*.sqlite` 等私密狀態檔），命中就中止打包；錯誤訊息只列檔名與規則，不輸出金鑰內容。`PRIVACY.md` 與 `docs/privacy.html` 補上思考模式的傳輸與計費說明。

## 1.8.3 — 2026-11-17（既有檔案指紋清除）

- 新增 `agent/lib/fingerprints.mjs` 與 CLI `strip-fingerprints [--dry-run|--restore]`：把**已經在磁碟上**的音檔裡殘留的 ACE metadata 就地抹掉。
  - WAV：`LIST/INFO`（IART／ICMT／ISFT…）、`id3 `／`bext`／`iXML`／`XMP ` chunk、`data` 尾端夾帶的 ID3；被截斷的 `data` chunk 後面接的完整 `id3 ` chunk 也處理。
  - MP3：`TSSE`／`TENC` 編碼器戳記、含 `ACE Music` 的 `COMM`、指向 `acemusic.ai` 的 `WOAS`（`TIT2`／`TPE1`／`TALB`／`BPM`／`KEY`／`APIC`／`USLT` 一律保留）。
  - 就地覆寫、**檔案長度與 inode 不變** → 硬連結的音頻分類檢視同步更新，`agent-state`／manifest／Chrome 下載紀錄的 size 與音頻分析快取都不失效；`mtime`／`atime` 還原。
  - 指紋原 bytes 存到 `%LOCALAPPDATA%\AceMusicDL\fingerprint-backups\`，`--restore` 可原位還原；已驗證音檔的 `sha256` 同步更新，索引不會誤判「待核對」。
- 下載路徑：MP3 也套用同一套等長清除（`stripMp3TagBuffer`），新下載的檔案不再帶 `TSSE`／`ACE COMM`／`WOAS`。
- 一鍵整理最後新增 `fingerprints` 步驟（面板進度顯示「指紋清除」），重複執行會自動跳過已清的檔案。
- 新增 `test/unit/fingerprints.test.mjs`：MP3 v2.3／v2.4、WAV LIST/INFO、硬連結、mtime 還原、備份還原、sha256 更新、下載緩衝區版、截斷檔尾端 id3、dry-run 共 10 個案例。

## 1.8.2 — 2026-11-17（收藏夾）

- 新增「收藏夾」：站點拇指點讚（`meta.rating === "good"`）與面板愛心收藏取聯集（同一首只算一次），把整首歌的檔案（成品 MP3／WAV、分軌、MIDI、MusicXML、封面）複製到 `ai音樂\收藏\<歌名>\`。
- 只複製不搬原檔；內容相同跳過、同名不同內容保留使用者的檔（`--force` 才覆寫，舊檔先歸檔到 `organize-backups`）；`收藏\_收藏清單.json` 固定每首歌的資料夾名，兩首同名歌各自一個資料夾、不混檔。
- 一鍵整理（含「下載完自動整理」）最後多一步 `favorites`；面板進度條與完成提示同步顯示「收藏夾」。
- 整理各步（成品 WAV、採樣包、檔案分類、內容去重、空殼清理、音頻屬性分類）都把 `收藏` 排除在外，複本不會被搬走或再去重。
- 新增 CLI `favorites [--dry-run] [--force] [--sync] [--root] [--folder] [--json]`、MCP `ace_collect_favorites`（`dry_run` 只回計畫）。
- 新增 `test/unit/favorites.test.mjs`：聯集、整首歌複製、重跑只跳過、改過的檔不覆寫（force 才覆寫並歸檔）、dry-run 不落地、同名歌分開、站點快照損壞時面板愛心仍可用。

## 1.8.1 — 2026-11-17（WAV 指紋清洗）

- 新增 `stripWavMetadata`：下載 WAV 時預設移除 RIFF `LIST/INFO`（`IART`／`ICMT`／`ISFT` 等 ACE 生成器與帳號指紋）與 `id3 `／`bext`／`iXML`／`XMP ` 等 metadata chunk；音頻樣本 bytes 不變，RIFF 長度重算。
- 部分 ACE 匯出會在 `data` chunk 尾端夾帶 ID3v2（`TSSE`／`COMM`，含 `Made with ACE Music; created=...; id=...`）；偵測到標籤結束於檔尾時直接截除，並同步修正 `data` 長度。
- `downloadToFile` 在寫檔前套用；下載回報的 `bytes` 改為清洗後大小。原始下載流程不變。
- 新增 `test/unit/wav-metadata.test.mjs`：涵蓋 LIST/INFO、尾端 ID3v2、乾淨 WAV 與損壞輸入。

## 1.8.0 — 2026-11-17（整合版：1.7.5 修復 ＋ HuaiDJ 創作中樞 ＋ 命名爐）

- 合併 `feat/huaidj-music-agent`（9b29ecf）到 1.7.5：Hub 同時提供下載索引／播放器與 `/music/*`、`/create-api/*`；MCP 共 74 個工具。`feat/v11-direct-generation-z` 是同一 v1.1 直接生成的較早版本，已由此分支涵蓋，不另行合併。
- 站點請求保留 1.7.5 的 Cookie 只送原站與手動轉址檢查，再加上受控模式：未在有限授權內的舊轉譜等站點寫入一律在發出 HTTP 前拒絕。
- 即時歌單由「自動更新、新歌自動下載、分軌完成自動下載」任一開啟決定；本機 host 不再能強制開啟已關閉的同步。
- Mixdesk 保留 1.7.5 的可注入工廠結構，改用非阻塞、有上限的分析佇列與逾時；首次索引在背景執行。
- 面板加入 HuaiDJ 創作中樞入口；獨立播放器沿用 1.7.5，不再內嵌電臺。
- 播放器新增「網站點讚」：讀取 acemusic.ai 歌曲卡片的拇指向上（`meta.rating === "good"`），唯讀抓取全部分頁，完整才替換 `site-likes.json`；失敗保留上次資料並顯示原因。未下載的點讚歌也列出。原「收藏」改名「本機收藏」，兩者分開。新增 CLI `site-likes [--sync]` 與 MCP `ace_site_likes`。
- 面板曲庫工具新增「命名爐」按鈕（預設顯示），開啟 `naming/index.html`。
- 新頁面：連接 `ai音樂` 資料夾（File System Access）、讀取 `_manifest.json`、自動把同組分軌／版本分成一組，一組只命名一次。
- 命名引擎含四種體裁：銘／儀／並／抽（抽象：`X 的 Y` / `The Y of X`）。
- 「套用改名」直接改本機檔名，保留分軌與版本後綴；改完回面板按「一鍵整理」重建索引。
- 命名爐不改下載流程、不新增 manifest 權限（由 DeepSeek 實作，Claude 接手整合）。

- 打包改用系統 bsdtar，ZIP 內一律正斜線路徑（Chrome Web Store 可接受）；含反斜線、絕對路徑或 .. 的包直接打包失敗。
- `dedupeSongCopies` 新增預覽模式（CLI `dedupe-songs`，預設只預覽、不取寫入鎖）；整理流程照舊執行。
- 音頻分類整理：去重遺留的過期 hardlink 檢視移到 organize-backups；沒有相同來源的唯一舊版本以 hardlink 補回 `_未對應/音頻分類找回/`，成為正常來源並可分析長度。
- 修正按「停止」時剛好完成的下載不計入、也不寫下載紀錄：已送出的下載會等背景回報真正結果（最多 10 秒）。
- 面板診斷 `download-log.json` 仍只留 200 筆，但 Hub 會把新事件逐筆累積到 `logs/download-log-日期.jsonl`，舊工作明細不再遺失。
- 隨機 Idea 內含歌名：同一 seed 產生同一歌名並寫入同一段提示詞（Custom 的 Style 不放歌名）；複製、填入與歷史保留歌名，不按 Generate。
- 播放器：歌曲清單預設與網站一致（最新在前），表頭可切換新／舊；MP3 長度改由音頻分析快取或所屬歌曲補上，不再整排 0:00。
- 播放器：Hub 狀態不再在建曲庫時誤報離線，並隨 5 秒輪詢更新；服務升級後（含同版號更新）頁面提示「重新啟動播放器服務」，CLI `player --restart [--force]`。
- 歌曲 MP3 證據：可用本曲網址重新下載並以 SHA-256 比對寫入驗證紀錄，修正同名歌曲 MP3 長期「待核對」。
- 可攜性：安裝器、可攜啟動器、測試不再寫死開發機路徑或要求 F: 槽。
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
