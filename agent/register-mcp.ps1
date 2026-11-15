# register-mcp.ps1 — 把 ACE Music 批量下載器 MCP 註冊到本機各 AI 宿主
# 用法：pwsh -File agent\register-mcp.ps1
# 特性：可重複執行（已存在會跳過）、改檔前備份為 *.bak-<timestamp>
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# 專案根目錄＝本腳本的上層（agent/ 的上一層），不寫死本機路徑
$project = Split-Path -Parent $PSScriptRoot
$mcpScript = Join-Path $project 'agent\mcp.mjs'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
if (-not $node) {
    foreach ($candidate in @('C:\Program Files\nodejs\node.exe', "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $candidate) { $node = $candidate; break }
    }
}
if (-not $node) { throw '找不到 node.exe；請確認 Node.js 已安裝在 PATH' }
if (-not (Test-Path $mcpScript)) { throw "找不到 $mcpScript" }
$serverName = 'ace-music-downloader'
$results = @()

function Backup-File([string]$path) {
    if (Test-Path $path) {
        Copy-Item $path "$path.bak-$stamp" -Force
    }
}

# ---------------------------------------------------------------- 1) Claude Code
try {
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($claude) {
        $list = & claude mcp list 2>&1 | Out-String
        if ($list -match [regex]::Escape($serverName)) {
            $results += "Claude Code：已存在，略過"
        } else {
            & claude mcp add --scope user $serverName -- $node $mcpScript 2>&1 | ForEach-Object { Write-Host "  $_" }
            $check = & claude mcp list 2>&1 | Out-String
            if ($check -match [regex]::Escape($serverName)) { $results += "Claude Code：已註冊（user scope）" }
            else { $results += "Claude Code：註冊失敗（請手動執行 claude mcp add）" }
        }
    } else { $results += "Claude Code：未安裝，略過" }
} catch { $results += "Claude Code：錯誤 - $($_.Exception.Message)" }

# ---------------------------------------------------------------- 2) Codex
try {
    $codexConfig = Join-Path $env:USERPROFILE '.codex\config.toml'
    if (Test-Path $codexConfig) {
        $raw = Get-Content $codexConfig -Raw
        if ($raw -match "\[mcp_servers\.$([regex]::Escape($serverName))\]") {
            $results += "Codex：已存在，略過"
        } else {
            Backup-File $codexConfig
            $nodeToml = $node -replace '\\', '\\'
            $scriptToml = $mcpScript -replace '\\', '\\'
            $block = @"

[mcp_servers.$serverName]
command = "$nodeToml"
args = ["$scriptToml"]
startup_timeout_sec = 20
tool_timeout_sec = 600
"@
            Add-Content -Path $codexConfig -Value $block -Encoding UTF8
            $results += "Codex：已寫入 config.toml"
        }
    } else { $results += "Codex：找不到 ~/.codex/config.toml，略過" }
} catch { $results += "Codex：錯誤 - $($_.Exception.Message)" }

# ---------------------------------------------------------------- 3) Gemini CLI
try {
    $geminiConfig = Join-Path $env:USERPROFILE '.gemini\settings.json'
    if (Test-Path $geminiConfig) {
        $raw = Get-Content $geminiConfig -Raw
        if ($raw -match [regex]::Escape($serverName)) {
            $results += "Gemini CLI：已存在，略過"
        } else {
            Backup-File $geminiConfig
            $entry = @"
    "$serverName": {
      "command": "$($node -replace '\\','\\')",
      "args": ["$($mcpScript -replace '\\','\\')"]
    },

"@
            $anchor = '"mcpServers": {'
            $pos = $raw.IndexOf($anchor)
            if ($pos -ge 0) {
                $insertAt = $pos + $anchor.Length
                $newRaw = $raw.Substring(0, $insertAt) + "`r`n" + $entry.TrimEnd() + $raw.Substring($insertAt)
                Set-Content -Path $geminiConfig -Value $newRaw -Encoding UTF8
                $results += "Gemini CLI：已寫入 settings.json"
            } else {
                $results += "Gemini CLI：settings.json 沒有 mcpServers 區塊，未修改"
            }
        }
    } else { $results += "Gemini CLI：找不到 ~/.gemini/settings.json，略過" }
} catch { $results += "Gemini CLI：錯誤 - $($_.Exception.Message)" }

# ---------------------------------------------------------------- 4) OpenCode
try {
    $opencodeConfig = Join-Path $env:USERPROFILE '.config\opencode\opencode.json'
    if (Test-Path $opencodeConfig) {
        $json = Get-Content $opencodeConfig -Raw | ConvertFrom-Json
        if ($json.mcp -and $json.mcp.PSObject.Properties.Name -contains $serverName) {
            $results += "OpenCode：已存在，略過"
        } else {
            Backup-File $opencodeConfig
            if (-not $json.mcp) {
                $json | Add-Member -NotePropertyName mcp -NotePropertyValue ([pscustomobject]@{}) -Force
            }
            $entry = [pscustomobject]@{
                type    = 'local'
                command = @($node, $mcpScript)
                enabled = $true
            }
            $json.mcp | Add-Member -NotePropertyName $serverName -NotePropertyValue $entry -Force
            $json | ConvertTo-Json -Depth 20 | Set-Content $opencodeConfig -Encoding UTF8
            $results += "OpenCode：已寫入 opencode.json"
        }
    } else { $results += "OpenCode：找不到 ~/.config/opencode/opencode.json，略過" }
} catch { $results += "OpenCode：錯誤 - $($_.Exception.Message)" }

# ---------------------------------------------------------------- 5) DSH profiles
try {
    $dshHome = $env:DSH_HOME
    if (-not $dshHome) { $dshHome = Join-Path $env:LOCALAPPDATA 'DeepSeekHarness\home-official' }
    $profilesRoot = Join-Path $dshHome 'profiles'
    $yamlBlock = @"

# ACE Music 批量下載器 MCP：給 agent 用 CLI/MCP 下載 ACE 歌曲分軌/MIDI/封面、整理舊檔。
# 登入狀態由瀏覽器擴充功能面板「同步 Agent」匯出到 %LOCALAPPDATA%\AceMusicDL\session.json。
- insert:
    - id: ace-music-downloader-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: $serverName
        transport: stdio
        command: $node
        args:
          - $mcpScript
        toolCallTimeoutMs: 600000
        failOnStartupError: false
"@
    $foundProfiles = @()
    if (Test-Path $profilesRoot) {
        foreach ($profile in Get-ChildItem $profilesRoot -Directory) {
            $patch = Join-Path $profile.FullName 'cordis.patch.yml'
            if (Test-Path $patch) {
                $raw = Get-Content $patch -Raw
                if ($raw -match [regex]::Escape($serverName)) {
                    $foundProfiles += "$($profile.Name)(已有)"
                    continue
                }
                Backup-File $patch
                Add-Content -Path $patch -Value $yamlBlock -Encoding UTF8
                $foundProfiles += "$($profile.Name)(已寫入)"
            }
        }
    }
    if ($foundProfiles.Count) { $results += "DSH：" + ($foundProfiles -join ', ') + "（重啟 dsh web/desktop 後生效）" }
    else { $results += "DSH：找不到 profile 的 cordis.patch.yml，略過" }
} catch { $results += "DSH：錯誤 - $($_.Exception.Message)" }

# ---------------------------------------------------------------- 6) 未偵測到的宿主
$notFound = @()
foreach ($pair in @(
    @{ Name = 'Cursor'; Path = "$env:USERPROFILE\.cursor\mcp.json" },
    @{ Name = 'Windsurf'; Path = "$env:USERPROFILE\.windsurf\mcp_config.json" },
    @{ Name = 'Claude Desktop'; Path = "$env:APPDATA\Claude\claude_desktop_config.json" }
)) {
    if (-not (Test-Path $pair.Path)) { $notFound += $pair.Name }
}
if ($notFound.Count) { $results += "未安裝／未偵測：" + ($notFound -join '、') }

Write-Host ''
Write-Host '=== MCP 註冊結果 ==='
foreach ($line in $results) { Write-Host "  - $line" }
Write-Host ''
Write-Host "MCP server：$node `"$mcpScript`""
Write-Host "提醒：請先在擴充功能面板按「同步 Agent」，MCP 工具才會有登入狀態。"
