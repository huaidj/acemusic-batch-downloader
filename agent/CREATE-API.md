# Create API 完整參數契約

本分支使用官方網站同源 HTTP 介面，沿用本機登入，不經第三方代理服務。網站內部介面不是穩定公開 API；完整的意思是本次公開 Create 前端已觀察到的生成參數，不包含猜測的隱藏欄位。參數契約、真實服務接受、音檔回收、聽感各自驗收。

## 入口

- 工作台：`http://127.0.0.1:18788/music`；完整參數頁：`http://127.0.0.1:18788/music/api`。
- MCP：`ace_create_capabilities` → `ace_create_prepare` → `ace_create_preview`。
- CLI：`node agent/cli.mjs create capabilities`、`create prepare --input request.json`、`create preview --input request.json`。設定 `ACE_HUB_URL` 指向同一個隔離 Hub。
- HTTP：`GET /create-api/capabilities`、`POST /create-api/prepare`、`POST /create-api/preview`。

`prepare` 純本機，不讀取登入或帳本、不呼叫站點；`preview` 只讀 `/api/status`，核對目前模型、文字限制與費用。三個公開模型為 `acemusic-v1`、`acemusic-v1.1`、`ace-step-1.5-xl`。另外發現的隱藏 Step 變種列為 discovered，未核對其個別工作流，不假借 XL 參數啟用。

## 參數範圍

| 範圍 | 已核對的原生欄位 |
|---|---|
| Idea `/api/idea` | `prompt`、`created_at`、`references`、`model`、`analytics`、`covers`、`media` |
| Custom `/api/custom` | `mode`、`references`、`style`、`lyrics`、`lyricsMode`、`title`、`audio_influence`、`style_influence`、`created_at`、`model`、`analytics`、`step`、`hd` |
| Step Standard | `mode:standard`、`duration_sec`、`bpm`、`time_signature`、`key`、`negative`、`thinking`，以及經來源門禁的參考 |
| Step Cover | UI Cover 對應 `step.mode:remix`；`key`、`cover`、`remix`，以及參考 |
| Step Edit | `step.mode:edit`、`start_sec`、`end_sec`，以及參考 |
| Step 額外參考 | `ref_url` 或 `ref_song`，可隨 `ref_song_of`；透過 `step_reference` 權利包裝組裝 |
| v1 HD | `hd.duration_sec`、`hd.negative`；限 v1 Custom，無參考與 Assistant |
| 旋律／譜面 | `ref`、`libId`、`stemId`、`stemOf`、`contextId`、`songSlug`、`score`；score 包含 tempo、meter、key、chord、section、note/tuplet 與 vocal/ins 軌 |
| 視覺與封面 | Idea `media` 的既有 file ID 或公開連結；兩張既有 cover ID |

Create 前端的上傳協定、Style/Lyrics/Compose/Chords 輔助端點也列在能力快照中。它們目前只是契約登記，尚未實作執行器。沒有任意 URL 或任意 HTTP method 轉送工具。

保留名稱與實際條件，不能把所有控件混傳。Idea 不送 Custom 控件；Step 不送兩種 influence 或 hd；v1 參考／旋律／譜面可能需要 v1.1，此時回 `needs_recompile`，不靜默換模型。未觀察到音訊生成 seed；不把內部抽樣 seed 或數字詞條權重送進生成 API。

## 範例

```json
{
  "mode": "custom",
  "model": "ace-step-1.5-xl",
  "style": "Weighty sub-bass, micro-swing, interlocking percussion, sparse distant echoes. Instrumental.",
  "lyrics": "",
  "step": {
    "mode": "standard",
    "duration_sec": 180,
    "bpm": 120,
    "time_signature": "4/4",
    "key": "D minor",
    "negative": "lead vocals, humming, chanting",
    "thinking": 70
  }
}
```

輸入可用上述語義格式；亦可使用 `{surface:"custom",payload:{mode:"cover",...}}` 原生格式。`custom_mode` 對應 API 的 `mode`，與 Step 的 `step.mode` 分開。明確的 `created_at` 保留並綁定 hash；省略時由執行器以持久收據的建立時刻填入，另外保存實際提交 hash。

參考、media、covers 與 step_reference 都需要包裝：

```json
{
  "payload": {"ref":"music", "libId":"EXISTING_AUTHORIZED_SONG_ID"},
  "source":"user_owned",
  "rights_status":"owned",
  "ai_ingestion_allowed":true
}
```

權利資料只供本機門禁，不送站點。Spotify 或其衍生來源、未知權利、字串形式的 `"true"`、憑據、原始本機路徑都拒絕。此版有限授權僅允許無參考、無上傳與手動單批操作；準備包含參考的 JSON 不會自行取得提交或上傳許可。

## 真實提交門禁與收據

`POST /create-api/submit`／`ace_create_submit` 接收：

```json
{
  "input": {"mode":"idea", "model":"acemusic-v1.1", "prompt":"User-reviewed direction"},
  "reviewed_request_hash":"HASH_FROM_PREPARE",
  "idempotency_key":"one-reviewed-take-001"
}
```

真實提交還需要 Hub 程序設定 `ACE_GENERATION_GRANT_FILE`，其內容只在使用者明確給定批次範圍後建立。缺檔、到期、變更、停止或額度不足時拒絕；請求裡加 confirm、grant、預算等欄位不能自行授權。舊 `ace_generate` 真站路徑保留唯讀預覽，新提交統一使用此獨立授權帳本。

授權格式（這是範例，不是本次批准）：

```json
{
  "grant_id":"SET_AFTER_USER_APPROVAL",
  "provider":"ace",
  "models":["acemusic-v1.1"],
  "modes":["idea"],
  "max_credits_per_request":4,
  "max_credits_total":4,
  "max_generations":1,
  "expires_at":"SET_ACTUAL_UTC_EXPIRY_AFTER_APPROVAL",
  "allow_upload":false,
  "allow_auto_continue":false
}
```

先即時估價，再交易預留全批額度及任務數；排程執行前再核對授權、價格與模型。POST 前先持久保存 `outcome_unknown`，只有首次原子取得提交權者可以送出一次。網路斷線、408、5xx、壞 JSON、沒有 task ID 或落盤失敗均不自動重試，預留保留。已送出不釋放預留；結算需核實實際費用，不能由文字生成模型自行證明。

`ace_create_receipt`／`POST /create-api/receipt` 用原幂等鍵查紀錄；服務重啟或授權失效後仍可讀。`ace_create_stop` 只停止新提交，不能宣稱已撤回遠端任務。`ace_create_task_status`／`POST /create-api/tasks` 以精確 ID 檢查三模型；遠端 `succeeded` 或音訊 URL 不代表完整音檔已下載、解碼或人類試聽通過。

## 來源與驗證邊界

來源包含官方公開 [app.js](https://acemusic.ai/public/app.js)、[text-limit.js](https://acemusic.ai/public/text-limit.js)、[upload.js](https://acemusic.ai/public/upload.js)、[midi-editor.js](https://acemusic.ai/public/midi-editor.js)、[play-flow.js](https://acemusic.ai/public/play-flow.js)。能力快照記錄已量測的 UTC、SHA-256 與程式行號；沒有量測的時間保留 unknown。

app.js SHA-256：`60bc8a5bc638ee6c71e3a07a98fb9740b1f6e03ef63e838d3bd7f5f545ff7bf1`。本次已用既有登入唯讀驗證 `/api/status` 的模型與限制。前端計價為實際模型 `free` 時基價 0，否則 `costs.song`；Idea 影片可另加費，此版本無法確定其總額時拒絕提交。不得把 0 基價泛化成整個請求免費。

所有付費提交測試使用 loopback mock。真站生成 POST、參考上傳、音檔完整性、聽感與演出仍未驗收；本次實際花費 0 Credits，DeepSeek 呼叫 0。API key 官方路線仍待已有 key／授權確認；不把網站內部介面稱為官方公開 API。
