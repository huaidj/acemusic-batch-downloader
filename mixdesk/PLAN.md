# ACE MIX DESK — 集成 Agent 的 AI 生成音樂混音台／數據路由中心

> 目標：把「下載回來的成品 MP3 庫」變成一台**可持續運轉的 AI 電台／混音台**。Agent 在每首歌進入電台前先「預先監聽」做決策：這首歌放電台哪個位置、下一段提示詞從哪裡來、要不要推薦為目標生成歌、要選哪三首參考曲；提示詞寫完後丟進生成管線，新歌回流電台，形成閉環。

---

## 1. 系統定位

三個角色：

| 角色 | 職責 |
| --- | --- |
| **混音台（Mixer）** | 播放器 + 電台時段（slot）+ 隊列 + crossfade，把歌曲按能量曲線排進節目 |
| **Agent 路由器（Agent Router）** | 對每首歌做「預先監聽」分析，回傳結構化決策（放哪、推薦誰、參考哪三首、提示詞） |
| **數據路由中心（Data Hub）** | 持久化歌曲特徵、決策、提示詞、參考曲、生成任務與事件日誌；提供 HTTP/MCP 給外部 Agent |

### 核心閉環

```
成品MP3 庫
   │ 索引 + 音訊分析（BPM/調性/能量/長度）
   ▼
預先監聽任務 ──► Agent（本機 DSH agent 或 LLM adapter）
   │                  │
   │                  ▼
   │       決策 JSON：fitSlot / promptSource / targetRecommendation
   │                  / prompt / references[≤3]
   ▼
路由中心寫入 ──► 電台排程（slot 曲線）
   │                  │
   │                  ▼
   │             提示詞庫 ──► 生成任務（ACE 生成 / 人工 / 未來自動）
   │                  │
   └──────────── 新歌回流 ◄──┘
```

---

## 2. 資料模型

### Track（曲目）
```json
{
  "id": "t_0001", "file": "%USERPROFILE%/Downloads/ai音樂/成品MP3/xxx.mp3",
  "title": "xxx", "duration": 213.4,
  "bpm": 104.2, "key": "G:minor", "camelot": "6A", "energy": 0.164,
  "tags": ["dark", "tribal"], "analyzedAt": "...",
  "slot": "build",            // opening|build|peak|cooldown|transition
  "decisionId": "d_0001",
  "recommended": true          // 是否被 Agent 選為目標推薦曲
}
```

### PreListenDecision（預先監聽決策）
```json
{
  "id": "d_0001", "trackId": "t_0001", "status": "pending|done",
  "createdAt": "...", "decidedBy": "agent|heuristic|llm",
  "analysis": { "bpm": 104.2, "key": "G:minor", "energy": 0.164, "duration": 213.4 },
  "fitSlot": "build",
  "slotReason": "BPM 比現正播放快 6、能量 +0.02，適合推到 build 段",
  "promptSource": "上一首 A 的 peak 段過渡 + 目前 slot 的 energy 曲線",
  "targetRecommendation": { "selected": true, "reason": "調性與 BPM 都接近下一個 slot，適合作為下一首生成目標" },
  "prompt": "deep tribal techno, 104 BPM, G minor, ...",
  "references": [
    { "trackId": "t_0007", "title": "...", "role": "anchor", "why": "BPM 102、6A 同調" },
    { "trackId": "t_0012", "title": "...", "role": "texture", "why": "能量接近、打擊樂質感" },
    { "trackId": "t_0031", "title": "...", "role": "transition", "why": "提供過渡段參考" }
  ],
  "nextPromptHint": "從 cocooldown 段落再生成一首同調但能量低 10% 的過渡曲"
}
```

### 提示詞（PromptDraft）
```json
{
  "id": "p_0001", "trackId": "t_0001", "decisionId": "d_0001",
  "prompt": "...", "references": ["t_0007","t_0012","t_0031"],
  "status": "draft|queued|generating|done",
  "createdAt": "...", "generatedTaskId": null
}
```

### 電台時段（Slot 曲線）
`opening（暖場）→ build（推進）→ peak（高潮）→ cooldown（降溫）→ transition（過渡）→ 循環`
排程器依 energy/BPM 曲線與 slot 目標選下一首；Agent 決策優先於純數值排程。

---

## 3. 介面

### HTTP REST（`http://127.0.0.1:8777`）
| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/state` | 電台狀態、曲目、決策、待辦、提示詞、事件 |
| POST | `/api/index` | 掃描成品 MP3 + 分析（`{limit}`） |
| GET | `/api/pending` | Agent 待分析的預先監聽任務 |
| POST | `/api/prelisten` | 建立預先監聽任務（`{trackId, auto}`；auto=true 用啟發式/LLM 立即決策） |
| POST | `/api/decisions` | Agent 回傳決策（fitSlot / prompt / references≤3 / targetRecommendation） |
| POST | `/api/prompts` | 寫入提示詞草稿 |
| POST | `/api/queue` | 加入隊列 / 自動選下一首 |
| POST | `/api/play` | 設定 nowPlaying |
| GET | `/api/next` | 推薦下一首 |
| GET | `/media/:id` | 串流音檔（支援 Range，供電台播放） |
| GET | `/api/events` | SSE 事件流 |

### MCP（`mixdesk/mcp.mjs`，stdio）
- `mixdesk_state`：讀電台/決策/待辦摘要
- `mixdesk_pending`：取得待預先監聽的曲目
- `mixdesk_submit_prelisten`：提交決策（含 prompt、references、targetRecommendation）
- `mixdesk_write_prompt`：寫提示詞草稿
- `mixdesk_next`：取得下一首推薦
- `mixdesk_index`：索引/分析曲庫

### LLM adapter（可選）
`ACE_MIX_LLM_URL` + `ACE_MIX_LLM_KEY` + `ACE_MIX_LLM_MODEL` 指向 OpenAI 相容端點時，`/api/prelisten?auto=1` 會自動請 LLM 產出決策 JSON；沒有金鑰時走啟發式（BPM/調性/能量）並把任務留在 pending 給 DSH agent 接手。

---

## 4. 分階段實作

| 階段 | 內容 | 驗收 |
| --- | --- | --- |
| **P0 設計** | 本計劃 + 資料模型 + API/MCP 契約 | PLAN.md 完成 |
| **P1 資料層** | 曲庫索引（成品MP3）、BPM/調性/能量分析快取、slot 模型 | 81 首索引成功、分析快取寫入 |
| **P2 混音台 MVP** | 本地 server + 播放 UI + 隊列 + 時段時間軸 + 串流 | 瀏覽器可播、next 推薦可用 |
| **P3 Agent 路由** | 預先監聽任務 → 決策 JSON → 提示詞/參考曲（≤3）/目標推薦；MCP + HTTP | pending 可被 agent 取用、決策寫回成功 |
| **P4 自動閉環** | 自動 prelisten → 提示詞 → 生成任務（ACE/人工）→ 新歌回流；事件日誌/回放 | 一輪閉環跑通（可用 mock 生成） |
| **P5 穩定與交付** | 錯誤處理、快取失效、UI 打磨、文件、端口/開機啟動 | 文件 + 啟動腳本 + 驗收報告 |

### 當前進度（本輪）
- P0 完成（本文件）
- P1/P2/P3 MVP 開始：`mixdesk/server.mjs`、`public/index.html`、`mcp.mjs`
- 下一步：自動閉環 P4（生成任務接 ACE 或本地模型）

---

## 5. 安全與邊界
- 預設**不自動送出生成**：提示詞先進提示詞庫，經 UI/Agent 明確同意才排生成任務。
- 所有 Agent 決策寫入事件日誌，可追溯、可回滾（只影響排程/提示詞，不動音檔）。
- 參考曲上限 3 首，超出拒絕；參考只能選本機曲庫內的歌。
- 生成 API 付費/額度消耗需明確授權（沿用專案既有授權邊界）。
