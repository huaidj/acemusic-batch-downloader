@echo off
REM ACE MIX DESK 啟動：開電台混音台（預設 http://127.0.0.1:8777）
cd /d "%~dp0.."
echo 啟動 ACE MIX DESK…
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8777"
node mixdesk\server.mjs
pause
