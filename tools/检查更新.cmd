@echo off
setlocal
title 学生状态管理系统 - 检查更新
cd /d "%~dp0.."
chcp 65001 >nul
rem 从统一菜单调用时不再单独 pause（菜单自己会停住）
set "SSB_PAUSE="
if not defined SSB_NO_PAUSE set "SSB_PAUSE=1"
echo.
echo === 学生状态管理系统：检查更新 ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\update.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" echo [ 成功 ] 已完成。
if not "%RC%"=="0" echo [ 失败 ] 详见 logs\update.log
if defined SSB_PAUSE pause
exit /b %RC%