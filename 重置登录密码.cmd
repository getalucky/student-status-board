@echo off
setlocal
title Reset Student Board Password
cd /d "%~dp0"
chcp 65001 >nul

set "NODE_EXE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  echo Node.js not found. Install Node.js 22 or newer first.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0scripts\reset-password.js"
echo.
pause
