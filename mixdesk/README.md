# ACE MIX DESK — AI 生成音樂混音台／數據路由中心

把下載回來的「成品 MP3 庫」變成一台可持續運轉的 AI 電台：每首歌進電台前先做**預先監聽決策**（放哪個時段、下一段提示詞從哪來、要不要推薦為生成目標、參考哪三首），提示詞再丟進生成管線，新歌回流曲庫，形成閉環。

> 設計與資料模型見 [PLAN.md](PLAN.md)。本檔案只寫「怎麼跑、怎麼接、目前到哪」。

## 啟動

```powershell
# 方式一：雙擊
mixdesk\start.cmd

# 方式二：前景執行（看 log）
node mixdesk\server.mjs
```

- 預設網址：<http://127.0.0.1:8777>
- 首次啟動會自動索引成品 MP3（預設 30 首；可在 UI 把數量改成 0 全量）。
- 曲庫：`%USERPROFILE%\Downloads\ai音樂\成品MP3`（可用 `ACE_MIX_LIBRARY` 覆寫）
- 狀態：`%LOCALAPPDATA%\AceMusicDL\mixdesk\state.json`
- mock 生成輸出：`%LOCALAPPDATA%\AceMusicDL\mixdesk\mock-library\`（**不會**污染你的成品 MP3 庫）

## 三個角色

| 角色 | 位置 | 做什麼 |
| --- | --- | --- |
| 混音台 | `public/index.html` | 播放器、slot 時段、隊列、下一首推薦、提示詞/生成面板 |
| Agent 路由 | HTTP + MCP | 預先監聽決策、提示詞、參考曲（≤3）、目標推薦 |
| 數據中心 | `server.mjs` + `state.json` | 曲目特徵、決策、提示詞、生成任務、事件日誌 |

## HTTP API（`http://127.0.0.1:8777`）

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/state` | 電台狀態、曲目、決策、提示詞、生成、事件 |
| POST | `/api/index` | 掃描＋分析曲庫（`{limit, refresh}`；`limit:0` = 全部） |
| GET | `/api/pending` | 待預先監聽的任務 |
| POST | `/api/prelisten` | `{trackId, auto}`；`auto:true` 用啟發式立即決策 |
| POST | `/api/decisions` | Agent 回傳決策（fitSlot / prompt / references≤3 / targetRecommendation） |
| POST | `/api/prompts` | 寫入提示詞草稿 |
| POST | `/api/generate` | `{promptId 或 trackId, adapter}` → 生成任務（`mock` 離線；`ace` 未接線） |
| GET | `/api/generations` | 最近 50 筆生成任務 |
| POST | `/api/closed-loop` | 跑一輪完整閉環（決策 → 提示詞 → 生成 → 回流） |
| GET | `/api/next` | 下一首推薦（slot 曲線＋BPM/調性/能量相似度） |
| POST | `/api/play` | 設定 nowPlaying |
| GET | `/media/:id` | 串流音檔（支援 Range） |
| GET | `/api/events` | 事件日誌 |

## MCP（`mixdesk/mcp.mjs`，stdio）

```json
{ "mcpServers": { "ace-mixdesk": { "command": "node", "args": ["<專案根目錄>\\mixdesk\\mcp.mjs"] } } }
```

10 個工具：`mixdesk_state`、`mixdesk_pending`、`mixdesk_prelisten`、`mixdesk_submit_prelisten`、`mixdesk_write_prompt`、`mixdesk_next`、`mixdesk_generate`、`mixdesk_generations`、`mixdesk_closed_loop`、`mixdesk_index`。

## P4 閉環怎麼運作

```
成品MP3 庫 ──index──► 曲目特徵（BPM/調性/能量/slot）
                            │
                  prelisten 決策（agent 或啟發式）
                            │  寫入 fitSlot / prompt / references / target
                            ▼
                       提示詞庫（draft）
                            │  /api/generate（adapter=mock）
                            ▼
              mock 生成 WAV → 回流索引 → 新曲目（mock:true）
                            │
                            └──► 可立即排進電台（/api/next）
```

- **mock adapter**：用 Node 直接寫一段 8 秒節拍 WAV（低頻 kick + pad），寫進 `mock-library`，再走同一個 `indexLibrary` 回流。全程離線、不收費、不動你的曲庫。
- **ace adapter**：ACE 生成要付費/額度授權，**尚未接線**。呼叫時會明確回 `status:"failed"`、`error:"ACE 生成需要付費/額度授權…"`，不會偷打付費 API。
- 參考曲上限 3 首，超出直接 400；參考曲必須存在於本機曲庫。
- 所有決策與生成都寫進 `state.events`，可追溯。

## 目前狀態（實測）

| 項目 | 結果 |
| --- | --- |
| P1 資料層 | 曲庫 99 首完成索引（BPM/調性/能量/slot），快取命中後 index 0.02s |
| P2 混音台 | 播放器、slot 時間軸、隊列、`/api/next` 可用；UI 載入無 console/page error |
| P3 Agent 路由 | MCP 10 工具可用；`mixdesk_state` 回 counts、`pending` 可取任務 |
| P4 閉環 | `/api/closed-loop` 跑通：`d_0005 → p_0005 → done（回流 t_0099）`；UI「跑一輪閉環」按鈕同樣成功 |
| P5 交付 | `start.cmd`、本文件、MCP 設定範例；錯誤/逾時皆有 JSON 回應 |

環境變數：`ACE_MIX_PORT`、`ACE_MIX_LIBRARY`、`ACE_MIX_STATE_DIR`、`ACE_MIX_MOCK_DIR`、`ACE_MIX_URL`（MCP 用）、`ACE_PYTHON`、`ACE_ANALYZER`。

## 清理測試資料

```powershell
# 只刪 mock 生成檔（曲目狀態仍會留著，下次索引會標成 analyzedAt 為空）
Remove-Item -Recurse "$env:LOCALAPPDATA\AceMusicDL\mixdesk\mock-library"
```

要完全重置電台：刪 `state.json` 後重啟 server。

