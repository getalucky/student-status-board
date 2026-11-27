@echo off
setlocal
title 学生状态管理系统 - 局域网测试模式
cd /d "%~dp0.."
chcp 65001 >nul
rem 从统一菜单调用时不再单独 pause（菜单自己会停住）
set "SSB_PAUSE="
if not defined SSB_NO_PAUSE set "SSB_PAUSE=1"

rem 只在排查局域网问题时用：COOKIE_SECURE=false，HTTP 下也写 Cookie
set "HOST=0.0.0.0"
set "COOKIE_SECURE=false"
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

echo.
echo 局域网测试模式：只建议在同一个 Wi-Fi 下临时使用。
echo 手机访问前，先跑一次「允许局域网访问」放行防火墙。
echo.

"%NODE_EXE%" "%~dp0..\scripts\launch.mjs"
if errorlevel 1 if defined SSB_PAUSE pause