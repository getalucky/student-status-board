@echo off
setlocal
title Bind Tailscale
cd /d "%~dp0"
chcp 65001 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\tailscale-bind.ps1" -Install
echo.
pause