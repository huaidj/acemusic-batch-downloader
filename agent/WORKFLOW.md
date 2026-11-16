# HuaiDJ 中樞工作流程

所有操作共用既有 Hub。瀏覽器工作台、CLI、MCP 和擴充功能入口讀寫同一份狀態；耗時生成、研究、下載與解碼在背景處理。

## 創作到回收

1. 輸入中文方向，選模型與 Idea／Custom，調整詞條或鎖定項，再產生預覽。
2. 核對原意、實際欄位與適用的 Step／HD 控件。陌生中文、衝突、過長欄位或模型變更會阻擋提交。
3. 建立有限 session 與 generation job。準備不會扣費；送出還須獨立伺服器 grant。
4. `music_generation_submit` 短回任務。背景以原幂等鍵核對 receipt、精確遠端 ID、實際模型及音訊狀態。
5. 音檔回收到指定派生目錄，驗證大小、格式、SHA-256、ffprobe 與完整 ffmpeg 解碼；不覆寫原曲。
6. 狀態到 `awaiting_listen` 才顯示實際候選。音量、靜音或 peak 是技術資料，沒有自動品味分數。

同一 job 重複送出只回原紀錄；POST 結果未知保留原 key 與額度預留，不盲目重送。停止 session 只停止後續提交；已受理的遠端工作可能繼續，仍可回收。

受控啟動器會設 `ACE_MUSIC_CONTROLLED_RUN=true`，阻擋舊下載接入中可能額外扣額度的轉譜 POST；原始 MIDI／MusicXML 產生不會因開啟新中樞而自動獲准。MCP 客戶端範例也保留這個設定，避免 Hub 失聯時回落到未受控的舊寫入。

## 人類回饋與下一代

候選庫用手動音訊控制試聽。接受、拒絕、0–5 評分與維度評語各自保存；0 分是有效評分，空值表示沒有評分。新評語或撤回不刪除舊紀錄。

`music_next_iteration` 僅從人工接受的錨點提出新預覽，保留模型、硬約束、父代與版本。維度評語只提議小幅權重變化，不寫成永久偏好，也不自動提交。

有限 loop 需人工接受的錨點、有限任務／代數／失敗上限，且伺服器 grant 必須明確 `allow_auto_continue:true`。預設為 false。每一代等待人評；未知結果、重複音訊、模型變更、預算、期限與使用者停止都會阻止新增提交。`completed` 只表示有限流程停在既定條件，不代表聽感通過。

## 公開文字研究與詞典

研究輸入與創作原文分開，避免自動把私人方向、曲庫或音訊送出去。先準備 Search／Fetch 任務，再依獨立的 DeepSeek 金額、請求數及期限授權執行。

來源卡保存 URL、取得時間、摘要 hash、版本與允許用途。Search 結果預設只供來源導航與審閱；未獲允許的內容不能當詞條證據。非空 API 回應若沒有可用來源，顯示 `no_usable_sources`，費用估算仍保留。

研究詞條先成候選，使用者審閱後另行啟用新詞典。新版本保留舊版；歷史 plan 用自己的 snapshot、編譯器與模型映射，不靜默改寫。長期口味不自動更新。

## 演出準備

只有完整解碼、且人工接受的候選可加入主佇列或備用庫存。時長、目標或生成 P95 未知就保留未知；完整曲長加總不冒充過渡後的有效演出長度。

本分支只讀既有 BadDJ MixCore 的 `/api/status` 並準備待人審的 manifest。暫停、接管、恢復與停止管理本機 metadata，不啟動其他引擎、不寫入它的曲庫、不自動播放。現場設備、目標場次、過渡與聽感另行驗收。

## 三種執行方式

- 隔離預覽：`scripts/start-music-preview.ps1`，不掛登入、不啟用費用。
- 本機已授權驗證：`scripts/start-music-validation.ps1`，使用獨立 state 和已存在的有限授權檔；啟動器不新建或擴大授權。
- 便攜包：`scripts/portable-start.ps1`，使用包內 Node／FFmpeg，預設隔離預覽。`-ConnectAccount` 只讀既有本機登入；費用還需 `-GrantFile`，研究另需 `-ResearchConfig`。

原生 API、上傳及輔助端點的範圍見 [CREATE-API.md](CREATE-API.md)。素材上傳目前仍關閉；參數契約不等於實際上傳與三模型生成已全部驗收。MCP 工具以 `music_*` 和 `ace_create_*` 開頭；同樣可用 CLI `music <action> --input file.json` 呼叫。
