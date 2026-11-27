@echo off
chcp 65001 >nul
setlocal
title 学生状态管理系统 - 启动
cd /d "%~dp0.."
rem 从统一菜单调用时不再单独 pause（菜单自己会停住）
set "SSB_PAUSE="
if not defined SSB_NO_PAUSE set "SSB_PAUSE=1"

rem 双模式：同一进程监听 0.0.0.0，局域网走 HTTP，Tailscale 走 HTTPS
rem Cookie 的 Secure 属性由服务端按请求协议自动判断
set "HOST=0.0.0.0"
set "COOKIE_SECURE=auto"
set "PORT=3210"

rem 找 node：先 PATH，再装机时自带的 runtime\node
set "NODE_EXE="
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%~dp0..\runtime\node\node.exe" set "NODE_EXE=%~dp0..\runtime\node\node.exe"

if not defined NODE_EXE (
  echo 没找到 Node.js。先跑一次 deploy\install.ps1 让它自动装，或手动装 Node 22 以上。
  if defined SSB_PAUSE pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0..\scripts\launch.mjs"
if errorlevel 1 if defined SSB_PAUSE pause