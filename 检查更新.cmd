@echo off
setlocal
title Student Board - Check Update
cd /d "%~dp0"
chcp 65001 >nul
echo.
echo === Student Status Board : check for updates ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" echo [ OK ] done.
if not "%RC%"=="0" echo [FAIL] update failed, see logs\update.log
echo.
pause
exit /b %RC%
