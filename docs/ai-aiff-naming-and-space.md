# 成品 AIFF／命名／省硬碟：現況與可重複機制設計

> 2026-11-17 定案。這份文件同時是「這次怎麼做完」的紀錄，也是「之後怎麼自動重跑」的設計。

## 1. 目標

1. 曲庫在 **E:\ai音樂**（原 C:\Users\win\Downloads\ai音樂，已驗證搬移後刪除，不保留 junction）。
2. 交付格式 **AIFF**：PCM 不重算（`pcm_s16le → pcm_s16be`）、嵌入封面（`ID3v2.4 APIC`）、藝人 `VooDooBoys`、**不搬來源 metadata**（`-map_metadata -1`，ACE 指紋不會跟過去）。
3. 名字由《夜城人物事典》《靈感電子百科大全》詞庫組合，**中文 + 英文**，名字後面加**生成時間**。
4. 任何改名都要留**日誌**，可以用新名字倒查原本是哪個檔。
5. 盡量用**硬連結**省硬碟，但不得讓任何一份檔案變成唯一副本。

## 2. 現在的目錄長相（E:\ai音樂）

| 資料夾 | 內容 | 硬碟策略 |
| --- | --- | --- |
| `成品WAV` | 278 首 WAV 母帶（站點原始檔名） | 唯一實體，其他資料夾用硬連結指回這裡 |
| `改名WAV` | 278 首 AIFF（詞庫新名 + 時間戳 + 封面 + 藝人） | 交付用；`_命名日誌.json` 可倒查 |
| `改名WAV\已點讚` | 118 首 AIFF（原名字直接用） | 交付用；`_對照表.json` |
| `已點讚` | 266 檔（MP3+WAV，AI 雙語名） | 已全部換成硬連結 → 指向 成品WAV／成品MP3 |
| `收藏` | 118 首 WAV 母帶（平鋪） | 已全部換成硬連結 → 指向 成品WAV |
| `成品MP3` | 418 檔 | 實體 |
| `音頻分類` | 3988 檔分類檢視 | hardlink，不佔額外空間 |
| `成品AIFF` | **已刪除**（中間產物，可 10 秒重生） | — |

硬連結感知用量：**實際 36.2 GB**（邏輯 47.35 GB，其中 11.15 GB 是硬連結共用）。
這輪省下：硬連結 11.15 GB ＋ 刪掉中間產物 12.46 GB。

## 3. 命名引擎（`naming/`）

- `build-corpus.mjs`：從兩份 HTML 抽詞庫 → `corpus-lexicon.json`（places 12／concepts 14／weapons 124／devices 26／themes 30／tags 143）。
- `corpus.js`：6 種組合模板（場所+概念、武器+尾詞、標籤+概念、頭詞+概念、概念+尾詞、短名），輸出 `{zh, en, display, pattern}`；**seed = 檔名|大小**，同一個檔永遠得到同一個名字。
- 去重：全域 `used` 集合 + 檔名唯一檢查 + 最多 40 次重擲。
- 檔名尾綴：生成時間 `YYYY-MM-DD HHMM`（來源：站點快照 `created_at`，找不到才用檔案 mtime）。

## 4. 命名日誌（可倒查）

`E:\ai音樂\改名WAV\_命名日誌.json`，schema `vdb_naming_journal_v1`，每筆：

```json
{ "batch": "...", "at": "...", "from": "成品WAV\\原檔名.wav", "to": "新名字 (English) 2026-11-17 0740.aiff",
  "title": "新名字 (English) 2026-11-17 0740", "zh": "...", "en": "...", "artist": "VooDooBoys",
  "pattern": "place+concept", "seed": "原檔名|大小", "cover": "...jpg", "bytes": 123, "generatedAt": "ISO" }
```

倒查：`lookupNamed({ name })`（比對 `to`／`title`／`zh`）→ 回傳原始 `from`。已點讚那份用 `_對照表.json`（`vdb_liked_aiff_v1`）。

## 5. 這次怎麼做的（可照抄）

1. 搬庫：robocopy → 抽樣 sha256 驗證（26/26）→ 刪 C: → 無 junction。
2. 插件指路：`<stateDir>\config.json` → `{ "downloadDir": "E:\\" }`（環境變數優先）。
3. 重生索引：`node cli.mjs local-index --root ai音樂 --full`。
4. 轉 AIFF：`exportAiffs()`／`named-copy.mjs`（ffmpeg：`-map 0:a -map 1:v -c:v copy -disposition:v attached_pic -c:a pcm_s16be -map_metadata -1 -write_id3v2 1 -id3v2_version 4`）。
5. 已點讚：`exportLikedAiffs()`（用 `已點讚\_命名對照.json` 的 `copies.wav.source` 找封面）。
6. 省硬碟：`hardlink-dedupe`（size → sha256 完全一致才 `unlink` + `link`）套在 `收藏`、`已點讚`。
7. 驗證：檔案數、PCM md5 對來源、`title/artist`、`mjpeg` 封面、ACE 指紋字串 0。

## 6. 之後要建的可重複機制（設計）

### 6.1 CLI（一個入口做完）

```text
node cli.mjs export-aiff   [--liked] [--force] [--dry-run] [--json]   # 成品WAV 或 已點讚 → AIFF
node cli.mjs named-copy    [--force] [--dry-run] [--json]             # 詞庫命名 + 日誌（輸出 改名WAV）
node cli.mjs named-lookup  <新名字>                                    # 用新名字倒查原檔
node cli.mjs hardlink-dedupe [--commit] [--json]                      # 收藏/已點讚 換硬連結
```

### 6.2 設定（`<stateDir>\config.json`）

```json
{
  "downloadDir": "E:\\",
  "aiff":     { "enabled": false },
  "naming":   { "enabled": true, "artist": "VooDooBoys", "outFolder": "改名WAV", "stamp": "datetime", "paren": true, "concurrency": 3 },
  "wavnames": { "enabled": false },
  "hardlinks": { "enabled": true, "folders": ["收藏", "已點讚"] }
}
```

- `aiff.enabled=false`：不再產生中間資料夾 `成品AIFF`（改名WAV 已取代）。
- `naming.enabled=true`：一鍵整理最後一步自動生成 改名WAV（只補新的，已存在跳過）。
- `wavnames.enabled=false`：不再長出 `整理輸出` 的 `(2)` 副本。

### 6.3 一鍵整理的新步驟順序

`organize → mp3 → wav → aiff(named copy) → samples → classify → dedupe → content → folders → favorites → liked → fingerprints → hardlink-dedupe`

不變條件：
- **只增不改**：來源 WAV 永不刪改；新名字一律寫進日誌。
- **冪等**：目標檔已存在就跳過（`--force` 才重做），重跑成本≈0。
- **可回溯**：日誌 + 「新名字 → 原檔」查詢；日誌 append-only。
- **同碟才硬連結**：跨碟或 sha256 不同就退回複製，並在報告裡標記。
- **失敗不靜默**：ffmpeg 失敗留在 `failed[]`，不寫半成品。

### 6.4 驗證清單（每次跑完自動做）

1. 檔案數＝來源數（扣掉 skipped 的已存在）。
2. 抽樣 10% PCM md5 對來源相等。
3. 每檔 `title`／`artist` 有值；`mjpeg` attached_pic 存在。
4. `ace music|acemusic.ai` 字串 0 命中。
5. 日誌筆數＝實際輸出檔數（或已是舊批次的 superset）。
6. 硬連結感知用量變化寫進報告（可看出這輪省了多少）。

### 6.5 待辦（依序）

1. 把 `named-copy`／`named-lookup`／`export-aiff --liked`／`hardlink-dedupe` 接進 CLI 與一鍵整理。
2. 把 `成品AIFF` 步驟改成 `改名WAV`（或 `aiff.enabled=false` 直接關掉）。
3. 面板加一顆「重新命名這批」；顯示日誌最後一批的筆數與時間。
4. 單元測試：命名去重、時間戳、日誌倒查、硬連結退回複製、冪等。
5. 發版：1.9.2（GitHub Release＋Chrome Web Store，依專案既有流程）。
