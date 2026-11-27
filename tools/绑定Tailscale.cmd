@echo off
chcp 65001 >nul
setlocal
title 学生状态管理系统 - 绑定 Tailscale
cd /d "%~dp0.."
rem 从统一菜单调用时不再单独 pause（菜单自己会停住）
set "SSB_PAUSE="
if not defined SSB_NO_PAUSE set "SSB_PAUSE=1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\deploy\tailscale-bind.ps1" -Install
if defined SSB_PAUSE pause