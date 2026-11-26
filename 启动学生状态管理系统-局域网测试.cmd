@echo off
setlocal
title Student Board - LAN Test
cd /d "%~dp0"
chcp 65001 >nul

set "HOST=0.0.0.0"
set "COOKIE_SECURE=false"
set "PORT=3210"

set "NODE_EXE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  echo Node.js not found. Install Node.js 22 or newer first.
  pause
  exit /b 1
)

echo.
echo 局域网测试模式：只建议在同一个 Wi-Fi 下临时使用。
echo 手机访问前，先双击「允许局域网访问.cmd」放行防火墙（需要管理员确认一次）。
echo.

"%NODE_EXE%" "%~dp0scripts\launch.mjs"
if errorlevel 1 pause
