# install-host.ps1 — 安裝 ACE Music 本機整理工具（免管理員權限，只寫 HKCU）
# 功能：讓擴充功能可以「移動/改名」Downloads 內已下載的檔案（不必重新下載）。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA 'AceMusicDL'
$hostName = 'com.acemusic.batchdownloader'
$extensionId = 'abiaielnlhijedekadfkfonbpdaajkhf'

& (Join-Path $here 'build-host.ps1')
if ($LASTEXITCODE -ne 0) { throw 'build-host.ps1 失敗' }

$manifestPath = Join-Path $installDir 'host-manifest.json'
# 讓部署版 hub.mjs 也能讀到版本（它會找 <PROJECT>/manifest.json，部署時 PROJECT=installDir）
$projectManifest = Join-Path (Split-Path -Parent $here) 'manifest.json'
if (Test-Path $projectManifest) { Copy-Item $projectManifest (Join-Path $installDir 'manifest.json') -Force }
$manifest = [ordered]@{
    name            = $hostName
    description     = 'ACE Music 批量下載器 - 本機檔案整理工具'
    path            = (Join-Path $installDir 'acemusic_host.exe')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

foreach ($base in @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
)) {
    $key = Join-Path $base $hostName
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    Write-Host "registry: $key -> $manifestPath"
}

Write-Host ''
Write-Host '本機整理工具安裝完成。'
Write-Host "  程式：$(Join-Path $installDir 'acemusic_host.exe')"
Write-Host "  清單：$manifestPath"

# 複製 agent CLI，讓面板「整理舊檔」按鈕可以直接叫用（不用開終端機）
$projectRoot = Split-Path -Parent $here
$agentSrc = Join-Path $projectRoot 'agent'
$agentDst = Join-Path $installDir 'agent'
if (Test-Path $agentSrc) {
    if (Test-Path $agentDst) { Remove-Item $agentDst -Recurse -Force -ErrorAction SilentlyContinue }
    Copy-Item $agentSrc $agentDst -Recurse -Force
    # shared.mjs 需要專案根的 src/naming.js 與 src/planner.js
    $srcSrc = Join-Path $projectRoot 'src'
    $srcDst = Join-Path $installDir 'src'
    if (Test-Path $srcSrc) {
        if (Test-Path $srcDst) { Remove-Item $srcDst -Recurse -Force -ErrorAction SilentlyContinue }
        Copy-Item $srcSrc $srcDst -Recurse -Force
    }
    Write-Host "  Agent CLI：$agentDst"
} else {
    Write-Host '  （找不到 agent 目錄，面板「整理舊檔」按鈕將不可用）'
}
Write-Host '  測試：在擴充功能面板按「整理舊檔」可預覽/執行整理。'
