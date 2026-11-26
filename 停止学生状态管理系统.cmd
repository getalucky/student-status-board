@echo off
setlocal
title Stop Student Board
cd /d "%~dp0"
chcp 65001 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" -Port 3210
if errorlevel 1 pause
