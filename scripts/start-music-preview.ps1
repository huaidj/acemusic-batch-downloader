param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$previewRoot = 'F:\DevData\Runtime\HuaiDJ-ACE-Agent-20261116'
$previewState = Join-Path $previewRoot 'preview-state'
$previewPort = 18788
$previewUrl = "http://127.0.0.1:$previewPort"
if (-not (Test-Path -LiteralPath 'F:\DevData')) { throw 'F:\DevData is required; no fallback to C:.' }
$lockPath = Join-Path $previewState 'hub.lock'
$running = $false
if (Test-Path -LiteralPath $lockPath) {
    $record = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $running = $null -ne (Get-Process -Id $record.pid -ErrorAction SilentlyContinue)
}
if ($Stop) {
    if ($running) {
        Invoke-RestMethod -Uri "$previewUrl/shutdown" -Method Post -ContentType 'application/json' -Body '{}' | Out-Null
        Write-Output 'Preview stop requested; saved plans are retained.'
    } else { Write-Output 'Preview is not running.' }
    return
}
if ($running) { Write-Output "$previewUrl/music"; return }
if (Get-NetTCPConnection -LocalPort $previewPort -State Listen -ErrorAction SilentlyContinue) { throw "Port $previewPort is occupied. Existing service was left running." }
$previewCache = Join-Path $previewState 'cache'
New-Item -ItemType Directory -Path $previewCache,(Join-Path $previewRoot 'downloads'),(Join-Path $previewRoot 'logs') -Force | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
@{ cachedAt=$stamp; songs=@(); known=@() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $previewCache 'songs.json') -Encoding utf8
@{ cachedAt=$stamp; files=@(); rel=@(); names=@() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $previewCache 'fs-index.json') -Encoding utf8
@{ cachedAt=$stamp; ttlMs=120000; sessionMtimeMs=0; status=@{ authenticated=$false } } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $previewCache 'session-status.json') -Encoding utf8
$env:ACE_STATE_DIR = $previewState
$env:ACE_DOWNLOAD_DIR = Join-Path $previewRoot 'downloads'
$env:ACE_BASE_URL = 'http://127.0.0.1:9'
$env:ACE_HUB_PORT = [string]$previewPort
$env:ACE_HUB_HOST = '127.0.0.1'
$env:ACE_HUB_TOKEN = ''
$env:ACE_HUB_URL = $previewUrl
$env:ACE_DIRECT_GENERATION_ENABLED = 'false'
$env:ACE_GENERATION_GRANT_FILE = ''
$env:ACE_RESEARCH_CONFIG_FILE = ''
$env:ACE_SESSION_FILE = ''
$env:ACE_MUSIC_RUNTIME_CONFIG = ''
$env:ACE_MUSIC_ARTIFACTS_DIR = Join-Path $previewRoot 'preview-artifacts'
# This is an isolated development preview using the same Hub, not a deployment.
$nodePath = (Get-Command node).Source
Start-Process -FilePath $nodePath -ArgumentList @((Join-Path $repoRoot 'agent\hub.mjs')) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $previewRoot 'logs\hub.log') -RedirectStandardError (Join-Path $previewRoot 'logs\hub-error.log') | Out-Null
for ($attempt=0; $attempt -lt 40; $attempt++) {
    try { $null = Invoke-RestMethod -Uri "$previewUrl/music/capabilities" -TimeoutSec 1; Write-Output "$previewUrl/music"; return } catch { Start-Sleep -Milliseconds 150 }
}
throw 'Preview did not become ready; inspect its isolated logs.'
