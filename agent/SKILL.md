---
name: ace-music-downloader
description: 用 CLI/MCP 批次下載 ACE Music（acemusic.ai）歌曲的所有分軌、MIDI、MusicXML、MP3/WAV 並自動改名分類，或整理已下載的檔案。用於使用者要求「下載 ACE/acemusic 的某首歌所有音軌、分軌、MIDI」「整理/改名 Downloads 裡的 ACE 檔案」時。
---

# ACE Music 批量下載器（Agent 版）

工具位置：專案內的 `agent/`（CLI：`cli.mjs`／MCP：`mcp.mjs`）。

## 前置：登入狀態

CLI/MCP 用的是使用者瀏覽器已登入 ACE Music 的 Cookie，需先匯出：

1. Chrome 開 <https://acemusic.ai/create/>
2. 右下角「批量下載」面板 → 按「**同步 Agent**」
3. 會寫入 `%LOCALAPPDATA%\AceMusicDL\session.json`（及 `history.json` 下載紀錄）
4. 擴充功能每 30 分鐘自動重新匯出一次；若 CLI 說登入過期，請再按一次

## CLI（在 PowerShell 執行）

```powershell
$cli = "<專案根目錄>\agent\cli.mjs"

node $cli doctor                                  # 檢查登入/環境
node $cli list                                    # 列出歌曲（含已下載/未下載）
node $cli list --undownloaded                     # 只列還沒下載完的
node $cli list --query "歌名" --json              # 搜尋（JSON 輸出）
node $cli download --all                          # 全部歌曲：分軌 + MIDI + 封面（預設）
node $cli download --song <task_id> --types stems,midi,musicxml,mp3,cover
node $cli download --all --dry-run --json         # 只預覽要下載的檔案清單
node $cli organize --json                         # 預覽整理（改名+移動）
node $cli organize --commit                       # 實際整理
```

檔案會落在「Downloads\ai音樂\<歌名>\<歌名> - Vocals.mp3」這種結構。
常用旗標：`--root <資料夾>`、`--force`（重下）、`--concurrency <1-6>`、`--type-folders`、`--json`。

## MCP

組態（Claude Code / Claude Desktop / Cursor 等支援 mcpServers 的宿主）：

```json
{
  "mcpServers": {
    "ace-music-downloader": {
      "command": "node",
      "args": ["<專案根目錄>\\agent\\mcp.mjs"]
    }
  }
}
```

MCP 工具：`ace_session_status`、`ace_overview`、`ace_hub_status`、`ace_list_songs`、`ace_download`（回 jobId，用 `ace_job_status` 查進度、`ace_job_cancel` 取消）、`ace_organize`（預設只預覽，`commit=true` 才移動）、`ace_warm`。

## 面板

使用者在瀏覽器面板按「整理舊檔」可預覽/執行；agent 用 CLI `organize` 效果相同。

## 注意

- 只在已授權的使用者機器上執行；session.json 含登入 Cookie，不要外傳或貼到對話。
- 下載會消耗 ACE 站點額度；大量下載前先用 `--dry-run` 或 `list` 確認。
- 站點 API 若變更，`doctor` / `list` 會回 HTTP 錯誤，需更新 `agent/lib/ace.mjs`。

