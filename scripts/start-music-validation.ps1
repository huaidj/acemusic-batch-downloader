param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$validationRoot = 'F:\DevData\Runtime\HuaiDJ-ACE-Agent-20261116\phase2'
$validationState = Join-Path $validationRoot 'state'
$port = 18791
$url = "http://127.0.0.1:$port"
$lockFile = Join-Path $validationState 'hub.lock'
$running = $false
if (Test-Path -LiteralPath $lockFile) {
    $lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
    $running = $null -ne (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue)
}
if ($Stop) {
    if ($running) { Invoke-RestMethod -Uri "$url/shutdown" -Method Post -ContentType 'application/json' -Body '{}' | Out-Null }
    Write-Output 'Validation Hub stop requested; state and remote receipts retained.'
    return
}
if ($running) { Write-Output "$url/music"; return }
if (-not (Test-Path -LiteralPath $validationRoot)) { throw 'Validation configuration is not provisioned.' }
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw 'Validation port is occupied; existing process retained.' }
$grantFile = Join-Path $validationRoot 'ace-zero-credit-authorized.json'
$researchFile = Join-Path $validationRoot 'research-authorized.json'
$runtimeFile = Join-Path $validationRoot 'runtime.json'
# Restarting never creates or expands an authorization grant.
if (-not (Test-Path -LiteralPath $grantFile)) { throw 'Missing finite ACE grant; this launcher does not create authorization.' }
New-Item -ItemType Directory -Path $validationState,(Join-Path $validationRoot 'downloads'),(Join-Path $validationRoot 'logs') -Force | Out-Null
$env:ACE_STATE_DIR = $validationState
$env:ACE_DOWNLOAD_DIR = Join-Path $validationRoot 'downloads'
$env:ACE_BASE_URL = 'https://acemusic.ai'
$env:ACE_SESSION_FILE = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AceMusicDL\session.json'
$env:ACE_HUB_HOST = '127.0.0.1'
$env:ACE_HUB_PORT = [string]$port
$env:ACE_HUB_URL = $url
$env:ACE_HUB_TOKEN = ''
$env:ACE_MUSIC_CONTROLLED_RUN = 'true'
$env:ACE_GENERATION_GRANT_FILE = $grantFile
$env:ACE_RESEARCH_CONFIG_FILE = if (Test-Path -LiteralPath $researchFile) { $researchFile } else { '' }
$env:ACE_MUSIC_RUNTIME_CONFIG = $runtimeFile
$env:ACE_MUSIC_ARTIFACTS_DIR = Join-Path $validationRoot 'artifacts'
$nodePath = (Get-Command node).Source
Start-Process -FilePath $nodePath -ArgumentList @((Join-Path $repoRoot 'agent\hub.mjs')) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $validationRoot 'logs\hub.log') -RedirectStandardError (Join-Path $validationRoot 'logs\hub-error.log') | Out-Null
for ($attempt=0; $attempt -lt 40; $attempt++) {
    try { $null = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 1; Write-Output "$url/music"; return } catch { Start-Sleep -Milliseconds 150 }
}
throw 'Validation Hub did not become ready; inspect its local logs.'
