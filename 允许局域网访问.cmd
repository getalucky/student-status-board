@echo off
setlocal
title Allow LAN Access
cd /d "%~dp0"
chcp 65001 >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\allow-lan-firewall.ps1" -Port 3210
if errorlevel 1 pause
