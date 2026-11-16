# ACE Music v1.1 直接生成

> 此文件保留上游 v1.1 adapter 的契約證據。本整合分支的真站 `ace_generate` 只供預覽；以下舊提交範例不會啟用真站付費。所有新提交改走 [完整 Create API](CREATE-API.md)，需要伺服器獨立有限批次授權與累計預留。上游原分支不受此整合變更影響。

使用擴充功能已同步到本機的登入狀態，直接呼叫 `https://acemusic.ai` 的網頁內部 API。不需要 useapi 帳戶、訂閱或第三方代管登入。

目前範圍是 v1.1 的 Idea 文字生成與 Custom 歌詞／風格生成。音訊參考、MIDI 上傳、Mashup 與 Songwriting Assistant 尚未接入。內部 API 沒有公開穩定契約，站點變更後應重新核對。

## 先預覽

MCP `ace_generate` 預設 `dry_run:true`，只讀即時模型、費用與餘額，回傳準備送出的內容，不生成歌曲：

```json
{
  "mode": "custom",
  "style": "Hypnotic tribal house, 124 BPM, deep rounded bass, layered congas and shakers, sparse plucked melody. Instrumental, no singing or spoken words.",
  "lyrics": "",
  "title": "Percussion Study",
  "style_influence": 80
}
```

Idea 改用 `{"mode":"idea","prompt":"歌曲描述"}`；不能與 Style／Lyrics 混傳。模型固定為 `acemusic-v1.1`。

CLI 可以把同一物件存成 `request.json`，執行：

```powershell
node agent/cli.mjs generate --request request.json --json
```

字數按去掉首尾空白後的 Unicode code points 計算。Prompt／Style／Lyrics 的本機上限為 2000／1000／5000，並採用即時模型規格中較小的限制；Title 本機保守限制 80。Style influence 為 0–100。速度、調性與段落描述是生成引導。

## 明確提交一次

確認音樂內容與預覽費用後，在同一請求加上：

```json
{
  "dry_run": false,
  "confirm_credit_spend": true,
  "max_credits": 4,
  "idempotency_key": "percussion-study-take-001"
}
```

這四個欄位必須與原有 prompt 或 style 等內容一起送出。`max_credits` 是本次上限；站點報價提高、餘額不足、模型不可用或無法讀到費用時停止。不可把預覽視為已授權生成。

CLI 對應：

```powershell
node agent/cli.mjs generate --request request.json --commit --confirm-credit-spend --max-credits 4 --idempotency-key percussion-study-take-001 --json
```

實際提交必須有支援生成的 Hub。舊 Hub／無 Hub 只允許預覽及唯讀狀態查詢。不要因逾時改用另一個 key 重試。

## 區分提交與完成

`ace_generate` 回本機 `jobId`；先用 `ace_job_status` 取得 `task_ids`，再用：

```json
{"task_ids":["站點任務ID1","站點任務ID2"]}
```

呼叫 `ace_generation_status`。CLI 為 `generation-status --task-ids ID1,ID2 --json`。`planning/scoring/queued/running` 仍在生成；`succeeded` 且音訊已可用才列為成功，`failed/interrupted` 是失敗。各歌曲的 `model` 才是實際生成模型。

狀態回傳把 `requested_model` 與實際 `actual_models` 分開。`complete` 表示任務都已終止，`audio_complete` 表示都已成功且有音訊，`v11_complete` 還要求每首的實際模型都確認為 v1.1。`model_mismatch_task_ids`／`model_unknown_task_ids` 非空時，不當作 v1.1 驗收通過，也不重新提交已受理的請求。

Hub 的生成 job 完成，只代表站點提交階段已結束。它不代表音訊已完成，更不代表聽感驗收。工具不自動下載、分軌、轉譜或整理。完成後可用現有下載工具，按明確任務 ID 取得檔案。

## 逾時與重送

網站沒有在此整合中證實的伺服器冪等 key。Hub 在發送前保存本機收據：同 key、同內容回原 job；同 key、不同內容拒絕。重啟後不重新執行未確定的付費請求。

若收到 `submission_state:unresolved` 或 `GENERATION_SUBMISSION_UNKNOWN`，代表不知道站點是否已建立歌曲。保留原 key、jobId 與 `created_at`，到歌庫核對；沒有查到也不能當作未扣額度。當回應沒有可辨識 task ID 時，目前需要人工對帳，不會猜測 ID 或自動補發。

本機 job 在這類情況回 `status:unresolved`、`submission_unknown:true`；若 Hub 重啟時原提交尚未完成記錄，則回 `status:interrupted` 及 `GENERATION_HUB_INTERRUPTED`。兩者都不能解讀為站點已拒絕。查回原收據不依賴當前登入或剩餘 Credits。

登入 Cookie 僅由本機 session 載入，不出現在請求預覽、收據、錯誤或 repo；重導不會攜帶登入資訊前往其他網站。預覽會回自己的音樂文字，分享預覽前自行移除不想公開的內容。

## 驗證邊界

本功能先以模擬站點驗證提交、防重送、重啟恢復及 MCP/CLI/Hub 流程，再用既有登入做真站唯讀預覽。真站付費 POST、實際音訊完成及聽感需要另行驗證；不能以 Mock 通過宣稱已生成成功。

## 網頁契約來源

核對日期：2026-11-16。資料來自官方公開的 [app.js](https://acemusic.ai/public/app.js)、[text-limit.js](https://acemusic.ai/public/text-limit.js) 與 [library-view.js](https://acemusic.ai/public/library-view.js)。當次 app.js SHA-256：`60bc8a5bc638ee6c71e3a07a98fb9740b1f6e03ef63e838d3bd7f5f545ff7bf1`。

| 站點端點 | 本機用途 |
|---|---|
| `GET /api/status` | 當前帳戶模型、文字上限、成本與餘額；只回傳所需非秘密欄位 |
| `POST /api/idea` | `prompt, references:[], model, media:[], created_at` |
| `POST /api/custom` | `mode:"cover", references:[], style, lyrics, lyricsMode:"own", style_influence, title?, model, created_at` |
| `GET /api/songs?ids=...` | 精確 task ID 查詢；不生成、不轉譜 |

無參考素材的 Custom 在目前網頁中仍送 `mode:"cover"`。兩個生成端點沿用 Cookie、User-Agent、正確 Origin 與 Referer；不需要第三方 API Key。前端不消費完整的生成回應 ID 結構，因此真站付費 POST 的回應仍是未測部分；解析不明時停止自動化重送。
