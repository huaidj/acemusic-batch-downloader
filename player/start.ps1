$ErrorActionPreference = 'Stop'
# 預設：只留托盤圖示（視窗隱藏）；需要看播放器時在工作列右下「隱藏圖示」裡右鍵選「顯示播放器」。
# 想直接開視窗：player\start.ps1 -Show
param([switch]$Show)
$tray = Join-Path $PSScriptRoot 'tray.ps1'
$argsList = @('-NoProfile', '-File', $tray)
if ($Show) { $argsList += '-Show' }
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell).Source }
Start-Process -FilePath $pwsh -ArgumentList $argsList -WindowStyle Hidden
