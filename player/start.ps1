$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$output = & node (Join-Path $projectRoot 'agent\cli.mjs') player --background --json
if ($LASTEXITCODE -ne 0) { throw 'The player service did not start.' }
$result = ($output -join "`n") | ConvertFrom-Json
if (-not $result.ok -or $result.url -notmatch '^http://127\.0\.0\.1:\d{1,5}/?$') { throw 'Unexpected player service response.' }
$browsers = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$browser = $browsers | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge is required to open the independent player window.' }
Start-Process -FilePath $browser -ArgumentList @(('--app=' + $result.url), '--window-size=1100,780') -WindowStyle Normal
