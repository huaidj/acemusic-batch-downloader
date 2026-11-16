@echo off
where pwsh >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -File "%~dp0native\install-host.ps1"
) else (
  pwsh -NoProfile -File "%~dp0native\install-host.ps1"
)
if errorlevel 1 pause
