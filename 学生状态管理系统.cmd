@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title 学生状态管理系统
cd /d "%~dp0"

rem 统一入口。不带参数 = 菜单；带参数 = 直接执行某一项后退出
if /i "%~1"=="/start"     set "SSB_DIRECT=1" & goto do_start
if /i "%~1"=="/stop"      set "SSB_DIRECT=1" & goto do_stop
if /i "%~1"=="/reset"     set "SSB_DIRECT=1" & goto do_reset
if /i "%~1"=="/tailscale" set "SSB_DIRECT=1" & goto do_tailscale
if /i "%~1"=="/lan"       set "SSB_DIRECT=1" & goto do_lan
if /i "%~1"=="/update"    set "SSB_DIRECT=1" & goto do_update
if /i "%~1"=="/lantest"   set "SSB_DIRECT=1" & goto do_lantest
if /i "%~1"=="/deploy"    goto deploy_passthru
if not "%~1"=="" (
  echo 未知参数：%~1
  echo 可用：/start /stop /reset /tailscale /lan /update /lantest /deploy
  if not defined SSB_NO_PAUSE pause
  exit /b 1
)

:menu
rem 菜单模式：子脚本不再各自 pause，由这里统一停住
set "SSB_NO_PAUSE=1"
set "STATUS=未运行"
for /f "delims=" %%A in ('netstat -ano -p tcp ^| findstr ":3210 " ^| findstr "LISTENING"') do set "STATUS=运行中"
cls
echo.
echo    ==============================================
echo        学生状态管理系统
echo    ==============================================
echo        服务：!STATUS!        http://127.0.0.1:3210
echo    ----------------------------------------------
echo        1   启动 / 打开界面
echo        2   停止服务
echo        3   重置登录密码
echo        4   绑定 Tailscale（跨网访问）
echo        5   允许局域网访问（防火墙）
echo        6   检查更新
echo        7   局域网测试模式
echo        8   一键部署 / 修复安装
echo        0   退出
echo    ==============================================
echo.
choice /c 123456780 /n /m "   请选择 [1-8, 0 退出]: "
if errorlevel 9 goto do_exit
if errorlevel 8 goto do_deploy
if errorlevel 7 goto do_lantest
if errorlevel 6 goto do_update
if errorlevel 5 goto do_lan
if errorlevel 4 goto do_tailscale
if errorlevel 3 goto do_reset
if errorlevel 2 goto do_stop
if errorlevel 1 goto do_start
goto menu

:do_start
cls
call "%~dp0tools\启动服务.cmd"
goto done

:do_stop
cls
call "%~dp0tools\停止服务.cmd"
goto done

:do_reset
cls
call "%~dp0tools\重置登录密码.cmd"
goto done

:do_tailscale
cls
call "%~dp0tools\绑定Tailscale.cmd"
goto done

:do_lan
cls
call "%~dp0tools\允许局域网访问.cmd"
goto done

:do_update
cls
call "%~dp0tools\检查更新.cmd"
goto done

:do_lantest
cls
call "%~dp0tools\局域网测试模式.cmd"
goto done

:do_deploy
cls
call "%~dp0一键部署.cmd"
goto done

:deploy_passthru
rem /deploy 后面跟的参数原样转给 一键部署.cmd（最多 8 个）
set "SSB_NO_PAUSE="
set "SSB_DPARGS=%~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9"
call "%~dp0一键部署.cmd" %SSB_DPARGS%
set "SSB_RC=%ERRORLEVEL%"
set "SSB_DPARGS="
exit /b %SSB_RC%

:done
if defined SSB_DIRECT (
  endlocal
  exit /b 0
)
echo.
echo   按任意键返回菜单…
pause >nul
goto menu

:do_exit
endlocal
exit /b 0