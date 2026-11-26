@echo off
setlocal
title Student Board
cd /d "%~dp0"
chcp 65001 >nul

rem 双模式：同一进程监听 0.0.0.0，局域网走 HTTP，Tailscale 走 HTTPS
rem Cookie 的 Secure 属性由服务端按请求协议自动判断
set "HOST=0.0.0.0"
set "COOKIE_SECURE=auto"
set "PORT=3210"

set "NODE_EXE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE (
  echo Node.js not found. Install Node.js 22 or newer first.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0scripts\launch.mjs"
if errorlevel 1 pause
