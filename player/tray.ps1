# tray.ps1 — 播放器托盤：平時藏在系統匣，右鍵調整參數
#
# 用法：
#   pwsh -File player\tray.ps1            # 隱藏視窗啟動（預設）
#   pwsh -File player\tray.ps1 -Show      # 直接顯示播放器
#   pwsh -File player\tray.ps1 -Test      # 不開視窗，只檢查服務／設定，印出摘要（給自動化測）
param(
    [switch]$Show,
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AceTrayWin32 {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$projectRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $projectRoot 'agent\cli.mjs'
$stateDir = Join-Path $env:LOCALAPPDATA 'AceMusicDL'
$configPath = Join-Path $stateDir 'config.json'
$windowTitle = '壞 DJ · 播放器'

function Get-PlayerConfig {
    $defaults = [ordered]@{
        windowSize = '1100x780'
        startHidden = $true
    }
    if (-not (Test-Path -LiteralPath $configPath)) { return [pscustomobject]$defaults }
    try {
        $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { return [pscustomobject]$defaults }
    $player = $raw.player
    return [pscustomobject]@{
        windowSize = if ($player -and $player.windowSize) { [string]$player.windowSize } else { $defaults.windowSize }
        startHidden = if ($player -and $null -ne $player.startHidden) { [bool]$player.startHidden } else { $defaults.startHidden }
    }
}

function Save-PlayerConfig([string]$windowSize, [bool]$startHidden) {
    $raw = [ordered]@{}
    if (Test-Path -LiteralPath $configPath) {
        try {
            $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $existing.PSObject.Properties) { $raw[$p.Name] = $p.Value }
        } catch { }
    }
    $player = [ordered]@{}
    if ($raw.Contains('player') -and $raw['player']) {
        foreach ($p in $raw['player'].PSObject.Properties) { $player[$p.Name] = $p.Value }
    }
    $player['windowSize'] = $windowSize
    $player['startHidden'] = $startHidden
    $raw['player'] = $player
    $json = ($raw | ConvertTo-Json -Depth 12)
    Set-Content -LiteralPath $configPath -Value $json -Encoding UTF8
}

function Get-PlayerUrl {
    $output = & node $cli player --background --json
    if ($LASTEXITCODE -ne 0) { throw '播放器服務沒有回應' }
    $result = ($output -join "`n") | ConvertFrom-Json
    if (-not $result.ok -or $result.url -notmatch '^http://127\.0\.0\.1:\d{1,5}/?$') { throw '播放器服務回傳不正確' }
    return [string]$result.url
}

function Find-Browser {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Get-PlayerWindow {
    Get-Process chrome, msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq $windowTitle } |
        Select-Object -First 1
}

function Show-Player {
    $window = Get-PlayerWindow
    if ($window) {
        [AceTrayWin32]::ShowWindow($window.MainWindowHandle, 5) | Out-Null
        [AceTrayWin32]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
        return
    }
    $url = Get-PlayerUrl
    $browser = Find-Browser
    if (-not $browser) { throw '需要 Chrome 或 Edge 才能開播放器' }
    $cfg = Get-PlayerConfig
    Start-Process -FilePath $browser -ArgumentList @(('--app=' + $url), ('--window-size=' + $cfg.windowSize)) -WindowStyle Normal
    Start-Sleep -Milliseconds 1200
    $window = Get-PlayerWindow
    if ($window -and $cfg.startHidden -and -not $Show) { [AceTrayWin32]::ShowWindow($window.MainWindowHandle, 0) | Out-Null }
}

function Hide-Player {
    $window = Get-PlayerWindow
    if ($window) { [AceTrayWin32]::ShowWindow($window.MainWindowHandle, 0) | Out-Null }
}

function Open-SettingsDialog {
    $cfg = Get-PlayerConfig
    $form = New-Object System.Windows.Forms.Form
    $form.Text = '播放器參數'
    $form.Width = 430
    $form.Height = 250
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false

    $labelSize = New-Object System.Windows.Forms.Label
    $labelSize.Text = '視窗大小（例：1100x780）'
    $labelSize.Left = 16; $labelSize.Top = 18; $labelSize.Width = 380
    $txtSize = New-Object System.Windows.Forms.TextBox
    $txtSize.Left = 16; $txtSize.Top = 42; $txtSize.Width = 380; $txtSize.Text = $cfg.windowSize

    $chkHidden = New-Object System.Windows.Forms.CheckBox
    $chkHidden.Text = '啟動時只留托盤圖示（不顯示視窗）'
    $chkHidden.Left = 16; $chkHidden.Top = 78; $chkHidden.Width = 380; $chkHidden.Checked = $cfg.startHidden

    $chkAuto = New-Object System.Windows.Forms.CheckBox
    $chkAuto.Text = '下載完成後自動在背景整理（安靜模式）'
    $chkAuto.Left = 16; $chkAuto.Top = 104; $chkAuto.Width = 380; $chkAuto.Checked = $true

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '儲存'; $btnOk.Left = 236; $btnOk.Top = 150; $btnOk.Width = 76
    $btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消'; $btnCancel.Left = 320; $btnCancel.Top = 150; $btnCancel.Width = 76
    $btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

    $form.Controls.AddRange(@($labelSize, $txtSize, $chkHidden, $chkAuto, $btnOk, $btnCancel))
    $form.AcceptButton = $btnOk
    $form.CancelButton = $btnCancel

    if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $size = $txtSize.Text.Trim()
        if ($size -notmatch '^\d{3,4}x\d{3,4}$') { $size = $cfg.windowSize }
        Save-PlayerConfig -windowSize $size -startHidden ([bool]$chkHidden.Checked)
        [System.Windows.Forms.MessageBox]::Show('已儲存，下次開啟播放器生效。', '播放器參數') | Out-Null
    }
    $form.Dispose()
}

# ---- 測試模式 ----
if ($Test) {
    $cfg = Get-PlayerConfig
    $url = Get-PlayerUrl
    $window = Get-PlayerWindow
    [pscustomobject]@{
        ok = $true
        url = $url
        windowSize = $cfg.windowSize
        startHidden = $cfg.startHidden
        windowOpen = [bool]$window
        configPath = $configPath
    } | ConvertTo-Json
    exit 0
}

# ---- 托盤 ----
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = '壞 DJ · 播放器（右鍵調整參數）'
$icon.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemShow = $menu.Items.Add('顯示播放器')
$itemHide = $menu.Items.Add('隱藏播放器')
$menu.Items.Add('-') | Out-Null
$itemSettings = $menu.Items.Add('調整參數…')
$itemRestart = $menu.Items.Add('重新啟動播放器')
$menu.Items.Add('-') | Out-Null
$itemExit = $menu.Items.Add('離開托盤（播放器繼續在後台）')
$icon.ContextMenuStrip = $menu

$itemShow.Add_Click({ try { Show-Player } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '播放器') | Out-Null } })
$itemHide.Add_Click({ Hide-Player })
$itemSettings.Add_Click({ try { Open-SettingsDialog } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '參數') | Out-Null } })
$itemRestart.Add_Click({
    try {
        Hide-Player
        & node $cli player --restart --force *> $null
        Start-Sleep -Milliseconds 800
        Show-Player
    } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '播放器') | Out-Null }
})
$itemExit.Add_Click({ $icon.Visible = $false; $icon.Dispose(); [System.Windows.Forms.Application]::Exit() })
$icon.Add_DoubleClick({ try { Show-Player } catch { } })

try { Show-Player } catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '播放器') | Out-Null }
[System.Windows.Forms.Application]::Run()
