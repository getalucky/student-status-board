@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Student Board - Deploy
cd /d "%~dp0"

rem This file is pure ASCII on purpose. cmd reads batch files byte by byte;
rem switching code page midway with chcp desyncs multi-byte lines and yields
rem "The filename, directory name, or volume label syntax is incorrect."
rem All Chinese UI text lives in deploy\deploy-ui.ps1.

if not exist "%~dp0server\index.js" goto err_not_extracted
if not exist "%~dp0deploy\install.ps1" goto err_not_extracted

set "SSB_PSARGS="
if not "%~1"=="" set "SSB_PSARGS=%*"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\deploy-ui.ps1" %SSB_PSARGS%
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0
if not "%~1"=="" exit /b %RC%
echo.
pause
exit /b %RC%

:err_not_extracted
echo.
echo    [ ERROR ] server\index.js not found.
echo.
echo    You probably double-clicked inside the zip. Please:
echo      1. Right-click the zip file -^> Extract All
echo      2. Open the extracted folder, then double-click this file again
echo.
echo    Do not put it in OneDrive / Dropbox and similar sync folders.
echo.
pause
exit /b 1