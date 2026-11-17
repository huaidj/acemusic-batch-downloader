# Build to an immutable, source-hashed filename. Never terminate an active host.
param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } elseif ($env:ACE_STATE_DIR) { [IO.Path]::GetFullPath($env:ACE_STATE_DIR) } else { Join-Path $env:LOCALAPPDATA 'AceMusicDL' }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '找不到 .NET Framework 的 csc.exe（Windows 內建，應在 C:\Windows\Microsoft.NET\Framework64\v4.0.30319\）' }

$source = Join-Path $here 'host.cs'
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$out = Join-Path $installDir ('acemusic_host-' + $sourceHash.Substring(0, 16) + '.exe')
$recordPath = Join-Path $installDir 'host-build.json'
$reusable = $false
if ((Test-Path -LiteralPath $out) -and (Test-Path -LiteralPath $recordPath)) {
    $previous = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $reusable = $previous.sourceHash -eq $sourceHash -and $previous.sha256 -eq (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant()
}
if (-not $reusable) {
    if (Test-Path -LiteralPath $out) { $out = Join-Path $installDir ('acemusic_host-' + $sourceHash.Substring(0, 16) + '-' + [guid]::NewGuid().ToString('N') + '.exe') }
    & $csc /nologo /target:exe /optimize+ (('/out:') + $out) /r:System.Web.Extensions.dll $source
    if ($LASTEXITCODE -ne 0) { throw "Native host compilation failed ($LASTEXITCODE). Active host was preserved." }
}
$record = [ordered]@{ executable=$out; sourceHash=$sourceHash; sha256=(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant(); builtAt=[DateTime]::UtcNow.ToString('o') }
$record | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
Write-Host ('Compiled without stopping an active host: ' + $out)
