param(
    [switch]$Stop,
    [switch]$ConnectAccount,
    [ValidateRange(1024,65535)][int]$Port=18792,
    [string]$DataRoot='F:\DevData\Runtime\HuaiDJ-ACE-Portable',
    [string]$GrantFile='',
    [string]$ResearchConfig='',
    [string]$RuntimeConfig=''
)
$ErrorActionPreference='Stop'
$packageRoot=Split-Path -Parent $PSScriptRoot
$packageItem=Get-Item -LiteralPath $packageRoot -Force
if ($packageItem.LinkType -in @('Junction','SymbolicLink') -and @($packageItem.Target).Count -eq 1) { $packageRoot=[string]@($packageItem.Target)[0] }
$nodePath=Join-Path $packageRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Bundled runtime is missing. Use the complete portable folder.' }
if (-not [IO.Path]::IsPathRooted($DataRoot) -or $DataRoot -notmatch '^[EF]:\\') { throw 'Choose an absolute data folder on E: or F:.' }
$statePath=Join-Path $DataRoot 'state'
$url="http://127.0.0.1:$Port"
$lockPath=Join-Path $statePath 'hub.lock'
$running=$false
if (Test-Path -LiteralPath $lockPath) {
    $lock=Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $ownedProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($lock.pid)" -ErrorAction SilentlyContinue
    if ($ownedProcess) {
        if ($ownedProcess.ExecutablePath -ne $nodePath -or $lock.port -ne $Port) { throw 'The data folder is owned by another running process. It was left unchanged.' }
        $running=$true
    }
}
if ($Stop) {
    if ($running) { Invoke-RestMethod -Uri "$url/shutdown" -Method Post -ContentType 'application/json' -Body '{}' | Out-Null }
    Write-Output 'Portable Hub stop requested; all saved state retained.'
    return
}
if ($running) { Write-Output "$url/music"; return }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Port is occupied; no existing process was stopped.' }
New-Item -ItemType Directory -Path $statePath,(Join-Path $DataRoot 'downloads'),(Join-Path $DataRoot 'logs'),(Join-Path $DataRoot 'artifacts') -Force | Out-Null
$env:ACE_STATE_DIR=$statePath
$env:ACE_DOWNLOAD_DIR=Join-Path $DataRoot 'downloads'
$env:ACE_MUSIC_ARTIFACTS_DIR=Join-Path $DataRoot 'artifacts'
$env:ACE_BASE_URL=if ($ConnectAccount) { 'https://acemusic.ai' } else { 'http://127.0.0.1:9' }
$env:ACE_SESSION_FILE=if ($ConnectAccount) { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AceMusicDL\session.json' } else { '' }
$env:ACE_HUB_HOST='127.0.0.1'
$env:ACE_HUB_PORT=[string]$Port
$env:ACE_HUB_URL=$url
$env:ACE_HUB_TOKEN=''
$env:ACE_MUSIC_CONTROLLED_RUN='true'
$env:ACE_GENERATION_GRANT_FILE=$GrantFile
$env:ACE_RESEARCH_CONFIG_FILE=$ResearchConfig
$env:ACE_MUSIC_RUNTIME_CONFIG=$RuntimeConfig
$env:PATH=(Join-Path $packageRoot 'runtime')+';'+$env:PATH
Start-Process -FilePath $nodePath -ArgumentList @('"'+(Join-Path $packageRoot 'agent\hub.mjs')+'"') -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $DataRoot 'logs\hub.log') -RedirectStandardError (Join-Path $DataRoot 'logs\hub-error.log') | Out-Null
for ($attempt=0;$attempt -lt 40;$attempt++) {
    try { $null=Invoke-RestMethod -Uri "$url/music/capabilities" -TimeoutSec 1; Write-Output "$url/music"; return } catch { Start-Sleep -Milliseconds 150 }
}
throw 'Portable Hub did not become ready; inspect its local data/logs folder.'
