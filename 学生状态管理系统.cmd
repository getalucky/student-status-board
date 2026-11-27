@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 学生状态管理系统
cd /d "%~dp0"
rem 无 BOM UTF-8（改编码会炸中文）；菜单模式设 SSB_NO_PAUSE=1，子脚本不各自 pause。
if not "%~1"=="" (
  if /i "%~1"=="/deploy" goto deploy_passthru
  set "SSB_DIRECT=1"
  for %%A in (start stop reset tailscale lan update lantest) do if /i "/%%A"=="%~1" goto do_%%A
  echo 未知参数：%~1
  echo 可用：/start /stop /reset /tailscale /lan /update /lantest /deploy
  if not defined SSB_NO_PAUSE pause
  exit /b 1
)
:menu
set "SSB_NO_PAUSE=1"
set "STATUS=未运行"
for /f "delims=" %%A in ('netstat -ano -p tcp ^| findstr ":3210 " ^| findstr "LISTENING"') do set "STATUS=运行中"
cls
echo   ===== 学生状态管理系统 =====   服务:!STATUS!  http://127.0.0.1:3210
echo   1 启动/打开界面   2 停止服务   3 更多功能   0 退出
echo.
choice /c 1230 /n /m "请选择 [1-3,0退出]: "
if errorlevel 4 goto do_exit
if errorlevel 3 goto menu_more
if errorlevel 2 goto do_stop
if errorlevel 1 goto do_start
goto menu
:menu_more
cls
echo   ===== 更多功能 =====
echo   1 重置登录密码  2 检查更新  3 允许局域网访问
echo   4 局域网测试    5 绑定Tailscale  6 一键部署  0 返回
echo.
choice /c 1234560 /n /m "请选择 [1-6,0返回]: "
if errorlevel 7 goto menu
if errorlevel 6 goto do_deploy
if errorlevel 5 goto do_tailscale
if errorlevel 4 goto do_lantest
if errorlevel 3 goto do_lan
if errorlevel 2 goto do_update
if errorlevel 1 goto do_reset
goto menu_more
:do_start
call "%~dp0tools\启动服务.cmd" & goto done
:do_stop
call "%~dp0tools\停止服务.cmd" & goto done
:do_reset
call "%~dp0tools\重置登录密码.cmd" & goto done
:do_tailscale
call "%~dp0tools\绑定Tailscale.cmd" & goto done
:do_lan
call "%~dp0tools\允许局域网访问.cmd" & goto done
:do_update
call "%~dp0tools\检查更新.cmd" & goto done
:do_lantest
call "%~dp0tools\局域网测试模式.cmd" & goto done
:do_deploy
call "%~dp0一键部署.cmd" & goto done
:deploy_passthru
call "%~dp0一键部署.cmd" %~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9
exit /b %ERRORLEVEL%
:done
if defined SSB_DIRECT exit /b 0
echo   按任意键返回菜单…
pause >nul
goto menu
:do_exit
exit /b 0
