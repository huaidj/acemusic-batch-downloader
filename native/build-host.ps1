# build-host.ps1 — 編譯 ACE Music 本機整理工具（native messaging host）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA 'AceMusicDL'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '找不到 .NET Framework 的 csc.exe（Windows 內建，應在 C:\Windows\Microsoft.NET\Framework64\v4.0.30319\）' }

$out = Join-Path $installDir 'acemusic_host.exe'
$outNew = Join-Path $installDir 'acemusic_host.new.exe'
if (Test-Path $outNew) { Remove-Item $outNew -Force -ErrorAction SilentlyContinue }
& $csc /nologo /target:exe /optimize+ /out:"$outNew" /r:System.Web.Extensions.dll (Join-Path $here 'host.cs')
if ($LASTEXITCODE -ne 0) { throw "編譯失敗（exit $LASTEXITCODE）" }

# 舊的 host 可能還被 Chrome 擴充功能的 native messaging 連線持有，先結束再替換（重試幾次）
for ($i = 0; $i -lt 5; $i++) {
    Get-Process acemusic_host -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    try {
        Move-Item $outNew $out -Force
        Copy-Item (Join-Path $here 'host.cs') $installDir -Force
        Write-Host "已編譯：$out"
        return
    } catch {
        if ($i -eq 4) { throw "無法替換 host.exe（可能仍被使用）：$($_.Exception.Message)" }
    }
}
