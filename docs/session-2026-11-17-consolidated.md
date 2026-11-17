# 2026-11-17 一輪指令的統整（零碎指令 → 定案）

這份把這一輪所有「零碎命令」收斂成一份可執行的定案：每一句原始要求 → 最後落在哪 → 證據。
所有一次性腳本都已收進插件 CLI，不用再記那些臨時指令。

## 1. 原始指令對照

| # | 原始要求（照時間） | 最後處置 | 證據／位置 |
| --- | --- | --- | --- |
| 1 | 用插件的改名器改 `成品WAV`，成品放進 ai音樂（改名 wav 資料夾） | 命名爐引擎升級＋批量改名，輸出 `改名WAV` | `naming/corpus.js`、`agent/lib/named-copy.mjs` |
| 2 | 大量 `(2)` 重複名字的問題，用插件能力解決 | `(2)` 是不同 take 不是重複檔；改由命名爐給每首獨立名字；`整理輸出` 的複製式改名步驟關閉 | sha256 278 檔全不同；`wavnames.enabled=false` |
| 3 | 匯入 rekordbox 沒有封面 | WAV 改 AIFF（rekordbox 不讀 WAV 封面），嵌 `APIC` + `ID3v2.4` | 278/278 有封面；Pioneer metadata 表＋Lexicon 手冊 |
| 4 | 打算訂閱 DJ.Studio，自研 mixset 引擎不造輪子 | 只做決策與資料核實（無官方 MCP、原生 addon 可離線用），未動工 | 見 §6 |
| 5 | DJ.Studio 有 MCP 嗎？逆向一個 | 已逆向到可呼叫的 API（詳 §6），MCP 尚未建 | `naming` 無關；`/tmp` 探測結果 |
| 6 | 修改插件默認下載位置、遷移已下載檔 | 曲庫搬到 `E:\ai音樂`；插件讀 `<stateDir>\config.json` 的 `downloadDir` | `agent/lib/config.mjs` `localSettings()` |
| 7 | 複製到 `E:\ai音樂` 根目錄 | robocopy 完成 → 抽樣 sha256 26/26 相同 → 刪 C: 原檔（不保留 junction） | E: 39.26 GB 實體 |
| 8 | 用 1.9.0 完成實際操作 | 全部改用 CLI 指令跑（`local-index`、`favorites`、`tidy-all`…），不靠一次性腳本 | 本文件 §3 |
| 9 | 解決歷史問題、更新插件、更新緩存 | `整理輸出` 已刪、索引重建、`wavnames` 關閉、版本升 1.9.1 | `cache/fs-index` 重建、`local-index --full` |
| 10 | 保持原名，只換盤儲存，用硬連結 | 曲庫在 E:（真實資料夾）；同一磁碟的複本改用硬連結 | `收藏`/`已點讚` 383 檔全連結 |
| 11 | 不用重命名了 | 一度刪掉改名版；後來改為「用詞庫命名並複製一份到 `改名WAV`」，原始 WAV 不動 | `改名WAV` 278 首 |
| 12 | 轉 AIFF、補封面與藝人（VooDooBoys）、洗去 AI 指紋 | 全部落地；`-map_metadata -1`，指紋字串 0 命中 | 抽驗 12/12 PCM MD5 相同 |
| 13 | 插件默認把 WAV 轉成帶封面的 AIFF | `aiff` 步驟加入一鍵整理；後被 `named-copy` 取代（`aiff.enabled=false`，避免中間產物） | `agent/lib/aiff-export.mjs` |
| 14 | 整合進自動後臺整理 | `tidyAll` 已插步驟並用 `config.json` 開關；`wavnames` 可關 | `agent/lib/ace.mjs` |
| 15 | 英文名看不懂，看兩本書升級取名器 | 從《夜城人物事典》《靈感電子百科大全》抽詞庫 → 中文＋英文組合 | `naming/build-corpus.mjs`、`corpus-lexicon.json` |
| 16 | 隨機排列組合有意義的名字，且要能倒查 | 6 種組合模板 + 命名日誌（新名字 → 原檔） | `_命名日誌.json`、`named-lookup` |
| 17 | 全量修復成目標格式和名字（改名後也是複製一份） | 278 首 AIFF 複製到 `改名WAV`，來源不動 | 10 秒完成、0 失敗 |
| 18 | 名字後面加生成時間 | 尾綴 `YYYY-MM-DD HHMM`（站點 `created_at`，找不到用 mtime） | 例：`人偶館黑牆 (Blackwall) 2026-11-17 0946.aiff` |
| 19 | 已點讚的 WAV 也轉 AIFF 帶封面，放 `改名WAV\已點讚`，直接放名字 | 118 首完成，名字原樣 | `改名WAV\已點讚\_對照表.json` |
| 20 | 巧妙節省硬碟 | 硬連結 383 檔（-11.15 GB）＋刪中間產物 `成品AIFF`（-12.46 GB） | 實際 36.2 GB／邏輯 50.9 GB |
| 21 | 先完成任務→記經驗→後期建可重複機制 | 任務完成、經驗已寫入記憶與本文件、機制設計見 `ai-aiff-naming-and-space.md` | — |
| 22 | 中和所有零碎命令 | 本文件；臨時腳本全部由 CLI 取代 | 本文件 §4 |

## 2. 定案規格（之後照這個）

- **曲庫**：`E:\ai音樂`（真實資料夾，不能用 junction 當根目錄）。
- **母帶**：`成品WAV`（278）、`成品MP3`（418），永久保留，不改名不刪。
- **交付**：`改名WAV`（278 首 AIFF）＋ `改名WAV\已點讚`（118 首 AIFF）。
- **每檔**：`pcm_s16be`、`ID3v2.4` 的 `TIT2`＝顯示名（含時間戳）、`TPE1`＝`VooDooBoys`、`APIC`＝對應封面、無任何來源 metadata。
- **命名**：`naming/corpus.js`（詞庫組合）＋ `corpus-lexicon.json`（可用 `build-corpus.mjs` 重建）；seed＝`原檔名|大小`，同名同檔永遠同一個名字；全域去重。
- **日誌**：`改名WAV\_命名日誌.json`（`vdb_naming_journal_v1`，append-only），可用新名字／中文名／檔名倒查。
- **設定**：`%LOCALAPPDATA%\AceMusicDL\config.json`
  ```json
  { "downloadDir": "E:\\",
    "aiff": { "enabled": false },
    "naming": { "enabled": true, "artist": "VooDooBoys", "outFolder": "改名WAV", "stamp": "datetime", "paren": true },
    "wavnames": { "enabled": false },
    "hardlinks": { "enabled": true } }
  ```

## 3. 一鍵整理現在的樣子（實測）

`organize → mp3 → wav → wavnames(disabled) → aiff(disabled) → samples → classify → dedupe → content → folders → audio → index → favorites → fingerprints → liked`

- `wavnames`：`skipped: disabled`（不再長出 `整理輸出` 的 `(2)` 副本）
- `aiff`：`skipped: 278`（冪等，已存在不動）
- `audio`：992 首分析（240 新分析、752 快取）、`音頻分類` 檢視 3247 個硬連結重建
- `finished`：0 失敗

## 4. 取代所有一次性腳本的 CLI（單一入口）

```text
node cli.mjs export-aiff [--liked] [--force] [--dry-run] [--json]   # 成品WAV 或 已點讚 → AIFF（帶封面/藝人）
node cli.mjs named-copy [--force] [--dry-run] [--json]              # 詞庫命名 + 日誌 → 改名WAV（複製式）
node cli.mjs named-lookup "<新名字或中文名>"                          # 倒查原本是哪個檔
node cli.mjs hardlink-dedupe [--commit] [--json]                    # 收藏/已點讚 換硬連結（省空間）
node cli.mjs local-index --root ai音樂 --full                        # 重建本機索引
```

實測：
- `named-copy --dry-run` → `已存在 278、寫出 0`（冪等）
- `named-lookup 人偶館黑牆` → `成品WAV\Chamber of Skins and Sines.wav`
- `hardlink-dedupe` → `已是連結 383、可換 2`（tidy 之後新長的 2 個）
- `export-aiff --liked --dry-run` → `已存在 118`

## 5. 衝突與裁決（為什麼最後是這樣）

| 先前說法 | 後來說法 | 裁決 |
| --- | --- | --- |
| 用命名爐改名，成品放新資料夾 | 「不用重命名了」 | 原檔名不動；改名只在**複製出來的交付集**發生 |
| 保持原名、只要搬到 E: | 「轉 AIFF＋封面＋藝人＋洗指紋」 | 交付集才是 AIFF；母帶仍是原始 WAV、原名 |
| 插件默認產 `成品AIFF` | 「交付集放 `改名WAV`」 | 關掉 `aiff` 中間步驟，統一由 `named-copy` 產交付集 |
| 想用 junction 省空間 | 「用硬連結的方式」 | 硬連結只限同磁碟；跨磁碟一律複製，且驗 sha256 |

## 6. 尚未動工（等你點名）

- **DJ.Studio MCP**：官方沒有 MCP；5.0.11 的原生 addon（`harmonize`、`rekordbox` ANLZ/ppth、`audio-decoder`、`inference Worker`）可用系統 Node 直接載入，remote debugging 被 bootstrap 封鎖。做成 MCP 可行，尚未建。
- **一鍵整理接 `named-copy`／`hardlink-dedupe`**（目前只有 CLI 手動跑）。
- **面板按鈕**：「重新命名這批」＋顯示日誌批次摘要。
- **測試與發版** 1.9.2（GitHub Release＋Chrome Web Store）。
- **索引歸屬**：搬庫後 `favorites` 仍有 91 首 `noWav`（WAV 的 task 歸屬依賴舊 Chrome 下載紀錄），需要一次「重建 WAV 證據」的修復。
