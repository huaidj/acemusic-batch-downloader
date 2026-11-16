param([switch]$DryRun, [string]$BackupDirectory = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $here
$installDir = if ($env:ACE_STATE_DIR) { [IO.Path]::GetFullPath($env:ACE_STATE_DIR) } else { Join-Path $env:LOCALAPPDATA 'AceMusicDL' }
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json).version
if (-not $BackupDirectory) {
    # 有 F:\DevData 的開發機沿用原備份位置；其他電腦放在本機應用資料夾，不再要求 F: 槽。
    $backupBase = if ($env:ACE_BACKUP_DIR) { $env:ACE_BACKUP_DIR } elseif (Test-Path -LiteralPath 'F:\DevData') { 'F:\DevData\Backups' } else { Join-Path $env:LOCALAPPDATA 'AceMusicDL-backups' }
    $BackupDirectory = Join-Path $backupBase ('ACE-Downloader-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
}
$backupRoot = [IO.Path]::GetFullPath($BackupDirectory)
if ($DryRun) { [ordered]@{version=$version;installDirectory=$installDir;backupDirectory=$backupRoot;preserveRuntimeData=$true;stopActiveProcesses=$false} | ConvertTo-Json; return }
if (-not (Test-Path -LiteralPath ([IO.Path]::GetPathRoot($backupRoot)))) { throw 'Backup drive is not available; nothing was changed.' }
if (Test-Path -LiteralPath $backupRoot) { throw 'Backup directory exists; it has been preserved.' }

$hub = $null
try { $capabilities = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/capabilities' -TimeoutSec 3; if ($capabilities.name -eq 'ace-agent-hub') { $hub = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/health' -TimeoutSec 3 } } catch { }
if ($hub -and (($hub.jobs.running -gt 0) -or ($hub.jobs.queued -gt 0))) { throw 'The downloader still has active jobs. They were preserved; update after they finish.' }
$leasePath = Join-Path $installDir 'library-write.lock'
if (Test-Path -LiteralPath $leasePath) {
    try { $lease = Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json } catch { throw 'A library write lease cannot be read. It was preserved; do not update while its owner is unknown.' }
    if (-not $lease.pid -or (Get-Process -Id $lease.pid -ErrorAction SilentlyContinue)) { throw 'A library writer is still active. It was preserved; update after it finishes.' }
}
$watchPath = Join-Path $installDir 'watch-status.json'
if (Test-Path -LiteralPath $watchPath) {
    $watch = Get-Content -LiteralPath $watchPath -Raw | ConvertFrom-Json
    if ($watch.pid -and $watch.phase -in @('starting','idle','running') -and (Get-Process -Id $watch.pid -ErrorAction SilentlyContinue)) { throw 'The background organizer is still running. Its work was preserved; stop it before updating.' }
}
$cliPathPattern = [regex]::Escape((Join-Path $installDir 'agent\cli.mjs'))
$legacyWriters = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $cliPathPattern -and $_.CommandLine -match '\s(download|tidy-all|extract-mp3|extract-samples|classify-files|classify-audio|dedupe-content|dedupe-folders|organize)\b' -and $_.CommandLine -notmatch '\s--(status|dry-run)\b' })
if ($legacyWriters.Count) { throw 'A local CLI file operation is still running. It was preserved; update after it finishes.' }
New-Item -ItemType Directory -Path $backupRoot | Out-Null
$records = @()
$sourceVersion = 'unknown'
try { $sourceVersion = (Get-Content -LiteralPath (Join-Path $installDir 'manifest.json') -Raw | ConvertFrom-Json).version } catch { }
foreach ($part in @('agent','src','player','design','manifest.json','host-manifest.json','host-build.json')) {
    $original = Join-Path $installDir $part
    if (-not (Test-Path -LiteralPath $original)) { continue }
    Copy-Item -LiteralPath $original -Destination $backupRoot -Recurse
    $files = if ((Get-Item -LiteralPath $original).PSIsContainer) { Get-ChildItem -LiteralPath $original -File -Recurse } else { Get-Item -LiteralPath $original }
    foreach ($item in $files) {
        $relative = $item.FullName.Substring($installDir.Length).TrimStart('\')
        $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
        if ($hash -ne (Get-FileHash -LiteralPath (Join-Path $backupRoot $relative) -Algorithm SHA256).Hash) { throw ('Backup mismatch: ' + $relative) }
        $records += [ordered]@{path=$relative;sha256=$hash;bytes=$item.Length}
    }
}
[ordered]@{purpose='Rollback of downloader code and host registration';source=$installDir;sourceVersion=$sourceVersion;targetVersion=$version;owner='local Codex deployment';createdAt=[DateTime]::UtcNow.ToString('o');retention='Keep until the user accepts this version; never auto-delete';files=$records} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupRoot '_backup.json') -Encoding UTF8
if ($hub) {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8788/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
    for ($attempt=0; $attempt -lt 30; $attempt++) { try { Invoke-RestMethod -Uri 'http://127.0.0.1:8788/health' -TimeoutSec 1 | Out-Null; Start-Sleep -Milliseconds 100 } catch { break } }
    if ($attempt -eq 30) { throw 'Hub has not shut down yet. Existing code and processes were preserved; retry after it exits.' }
}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
foreach ($part in @('agent','src','player','design','manifest.json')) {
    $source = Join-Path $projectRoot $part
    if (-not (Test-Path -LiteralPath $source)) { continue }
    Copy-Item -LiteralPath $source -Destination $installDir -Recurse -Force
    $files = if ((Get-Item -LiteralPath $source).PSIsContainer) { Get-ChildItem -LiteralPath $source -File -Recurse } else { Get-Item -LiteralPath $source }
    foreach ($item in $files) {
        $relative = $item.FullName.Substring($projectRoot.Length).TrimStart('\')
        if ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $installDir $relative) -Algorithm SHA256).Hash) { throw ('Installed source mismatch: ' + $relative) }
    }
}
& (Join-Path $here 'build-host.ps1') -OutputDirectory $installDir
$build = Get-Content -LiteralPath (Join-Path $installDir 'host-build.json') -Raw | ConvertFrom-Json
$manifestPath = Join-Path $installDir 'host-manifest.json'
[ordered]@{name='com.acemusic.batchdownloader';description='ACE Music local file tools';path=$build.executable;type='stdio';allowed_origins=@('chrome-extension://abiaielnlhijedekadfkfonbpdaajkhf/')} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
foreach ($base in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts','HKCU:\Software\Microsoft\Edge\NativeMessagingHosts')) {
    $key = Join-Path $base 'com.acemusic.batchdownloader'
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
}
# 研究授權：憑據只從環境變數來。安裝器若在沒有這些變數的 shell 裡執行，
# 從使用者／機器環境補回，避免更新後 Hub 失去 DeepSeek 研究能力。
if (-not $env:DEEPSEEK_API_KEY) {
    $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'Machine')
    if (-not $env:DEEPSEEK_API_KEY) { $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') }
}
if (-not $env:ACE_RESEARCH_CONFIG_FILE) {
    $env:ACE_RESEARCH_CONFIG_FILE = [Environment]::GetEnvironmentVariable('ACE_RESEARCH_CONFIG_FILE', 'User')
}
& node (Join-Path $installDir 'agent\cli.mjs') hub --background
if ($LASTEXITCODE -ne 0) { throw 'Hub did not start; rollback backup is preserved.' }
Write-Host ('Updated ' + $version + '. Reload the extension and refresh the ACE page.')
Write-Host ('Verified rollback backup: ' + $backupRoot)
