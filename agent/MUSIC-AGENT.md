# HuaiDJ 創作工作台（離線準備版）

這個分支將自然語言、詞典、有限生成、回收、人類回饋、公開文字研究與演出準備加入既有 ACE Hub。預設隔離預覽，所有供應商費用與自動繼續由獨立伺服器授權控制；不把提示詞或 mock 當成真實音樂產物。完整操作見 [WORKFLOW.md](WORKFLOW.md)。

## 開啟隔離預覽

需要 Windows、Node.js 24.18 或更新版本；不需要安裝 npm 依賴。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-music-preview.ps1
```

開啟 <http://127.0.0.1:18788/music>。啟動器使用 F 槽的獨立 state/downloads，ACE 網路目的地限制為 loopback，不讀取原登入或真實曲庫，也不重啟原 8788 Hub。

1. 輸入方向，選擇三個模型之一及 Idea/Custom。
2. 必要時調整詞條權重、鎖定項與探索種子，再產生預覽。
3. 檢查實際欄位。未知中文保留原文並標示待核對，不會冒充已完成翻譯。
4. 核對後建立待授權任務；相同幂等鍵不會多建任務。停止批次會取消尚未送出的準備任務。
5. 已保存的方向可作下一代父代。字典與能力 hash 固定在原計畫中，不改寫舊紀錄。

Spotify 連結可以登記作導覽；不抓取內容、不送入 AI。來源權利未知或 AI 許可不為真正 boolean `true` 的參考會被編譯器阻擋。Advanced 尚未核對帳戶控件，暫時拒絕。

```powershell
# 停止這個預覽，保留紀錄
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-music-preview.ps1 -Stop
```

## CLI 與 MCP

指向同一個預覽 Hub：

```powershell
$env:ACE_HUB_URL = 'http://127.0.0.1:18788'
node agent\cli.mjs music capabilities
node agent\cli.mjs music prompt_compile --input intent.json
node agent\cli.mjs music state
```

`intent.json` 範例：

```json
{
  "natural_language": "重 sub 壓力、微搖擺、交錯打擊、克制變化、前後景深，無人聲",
  "model": "acemusic-v1.1",
  "mode": "idea",
  "seed": 11,
  "locked_term_ids": ["voice.instrumental"]
}
```

MCP 沿用 `node agent/mcp.mjs` stdio；設定 `ACE_HUB_URL` 即可。新增工具都以 `music_` 開頭，讀取 `music_capabilities` 後用 `music_prompt_compile`、`music_session_create`、`music_generation_prepare`、`music_job_status`、`music_session_stop` 等。未修改任何宿主 MCP 設定；舊 `ace_*` 介面保留。

所有新寫操作只交給 Hub；Hub 失聯會報 `hub_required`，不另開本機寫入者。HTTP 能力契約在 `/capabilities`，新工作區在 `/music`。持久事件 `/music/events?since=…` 可跨重啟續讀；同時提供既有 SSE 的 `music` 事件。

紀錄位於指定 `ACE_STATE_DIR/music-agent/`，使用 SQLite 交易保存任務、產物、人評、研究、幂等鍵、版本、預留與停止狀態。SQLite 的 WAL/SHM 仍在使用時不要搬移整個 state。

## 真實生成與尚未驗收

`music_generation_submit` 已接入同一個 Create adapter、獨立有限授權及背景回收。沒有 `createApi` 的嵌入模式仍回 unsupported；正常 Hub 未配置有效 grant 時回待授權。另一分支的 v1.1 adapter 已復用並修正邊界。

真實驗收分開核對：遠端 task ID、實際模型、對應音檔、SHA-256/解碼、人類試聽與下一輪。程式、mock、真站提交、實際產物、聽感及現場設備各自記錄。當輪實測及尚未驗收項以本機 CONTROL 與交付報告為準。

## 測試與回退

```powershell
# 大量測試請先把 TEMP/TMP 指向 F:\DevData\Temp 下的獨立目錄
npm run test:unit
```

測試包含原有下載器回歸、詞典/來源/模型契約、SQLite 重啟與停止，以及 Mixdesk 的非同步分析。UI 與協議驗證使用隔離資料，不等於音樂聽感或演出驗收。

本次只改獨立分支。停止預覽後即可回到原主工作樹；不刪除 SQLite、原始音樂或其他服務。預覽紀錄預設保留，刪除需另行指定明確範圍。
