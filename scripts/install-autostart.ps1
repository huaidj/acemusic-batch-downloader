<#
.SYNOPSIS
  登入 Windows 時自動啟動 ACE Agent Hub（127.0.0.1:8788）與背景整理 watcher。

.DESCRIPTION
  建立一個「工作排程器」工作（目前使用者、登入時觸發、不需系統管理員）：
    node <agent>\cli.mjs hub --background
    node <agent>\cli.mjs watch --background
  兩者本身都有單一實例保護（hub.lock／watch 狀態），重複觸發不會開第二個。

.PARAMETER DryRun
  只顯示將要建立的工作內容，不做任何變更。

.PARAMETER Uninstall
  移除工作。

.PARAMETER NoWatch
  只啟動 Hub，不啟動 watcher。

.PARAMETER AgentDir
  agent 目錄；預設用已部署的 %LOCALAPPDATA%\AceMusicDL\agent（install-host.ps1 會複製），不存在則用 repo 內的 agent。

.EXAMPLE
  pwsh -File scripts\install-autostart.ps1 -DryRun
  pwsh -File scripts\install-autostart.ps1
  pwsh -File scripts\install-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$NoWatch,
    [string]$AgentDir = ''
)
$ErrorActionPreference = 'Stop'
$TaskName = 'AceMusicDL Agent Hub'

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) { Write-Host "沒有工作「$TaskName」，不需移除。"; return }
    if ($DryRun) { Write-Host "[DryRun] 將移除工作「$TaskName」"; return }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已移除工作「$TaskName」。"
    return
}

if (-not $AgentDir) {
    $deployed = Join-Path $env:LOCALAPPDATA 'AceMusicDL\agent'
    $repoAgent = Join-Path (Split-Path -Parent $PSScriptRoot) 'agent'
    $AgentDir = if (Test-Path (Join-Path $deployed 'cli.mjs')) { $deployed } else { $repoAgent }
}
$cli = Join-Path $AgentDir 'cli.mjs'
if (-not (Test-Path $cli)) { throw "找不到 $cli（先跑 native\install-host.ps1，或用 -AgentDir 指定）" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node.exe（請先安裝 Node.js）' }

# 用 cmd /c 串兩個背景啟動；兩者各自 --background 後立即返回
$commands = @("`"$node`" `"$cli`" hub --background")
if (-not $NoWatch) { $commands += "`"$node`" `"$cli`" watch --background" }
# /s /c "…"：cmd 只剝掉最外層引號，內部多個帶引號的路徑不會被拆壞
$cmdLine = '/s /c "' + ($commands -join ' & ') + '"'

Write-Host "工作名稱：$TaskName"
Write-Host "觸發：目前使用者登入時（$env:USERDOMAIN\$env:USERNAME），延遲 30 秒"
Write-Host "執行：cmd.exe $cmdLine"

if ($DryRun) { Write-Host '[DryRun] 未做任何變更。'; return }

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdLine -WorkingDirectory $AgentDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'ACE Music 批量下載器：登入時啟動 Agent Hub 與背景整理' -Force | Out-Null
Write-Host "已建立工作「$TaskName」。立即測試：Start-ScheduledTask -TaskName '$TaskName'"
