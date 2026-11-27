@echo off
setlocal EnableExtensions
title 学生状态管理系统 - 一键部署
cd /d "%~dp0"
chcp 65001 >nul

rem 额外参数原样转给 deploy\install.ps1，例如：
rem   一键部署.cmd -SkipTailscale -SkipBackupTask
rem   一键部署.cmd -DryRun -NoElevate
if not "%~1"=="" set "SSB_DIRECT=1"

rem ---------- 1. 必须在解压后的目录里跑 ----------
if not exist "%~dp0server\index.js" goto err_not_extracted
if not exist "%~dp0deploy\install.ps1" goto err_not_extracted

rem ---------- 2. 先确认，再提权（避免 UAC 一闪就装） ----------
if defined SSB_CONFIRMED goto check_admin
if defined SSB_DIRECT goto check_admin

echo.
echo    ==============================================
echo       学生状态管理系统 · 一键部署
echo    ==============================================
if exist "%~dp0data\config.json" (
  echo    检测到已经部署过，本次按「修复 / 重新配置」处理。
  echo    已有数据、登录密码都不会被改动。
) else (
  echo    首次部署：装依赖、设登录密码、建桌面快捷方式。
  echo    这台电脑没有 Node.js 时会先下载（约 30 MB，1-2 分钟）。
)
echo    ==============================================
echo.
choice /c YN /n /m "   开始部署？[Y 开始 / N 取消]: "
if errorlevel 2 goto cancelled
echo.
set "SSB_CONFIRMED=1"

rem ---------- 3. 管理员：没有就提权重开自己 ----------
:check_admin
set "SSB_SKIP_UAC="
for %%A in (%*) do (
  if /i "%%~A"=="-DryRun" set "SSB_SKIP_UAC=1"
  if /i "%%~A"=="-NoElevate" set "SSB_SKIP_UAC=1"
)
if defined SSB_SKIP_UAC goto is_admin
fltmc >nul 2>&1
if not errorlevel 1 goto is_admin

echo   需要管理员权限（装依赖、放行防火墙、注册备份任务）。
echo   马上会弹 UAC 确认框，请点「是」。
echo.
set "SSB_SELF=%~f0"
set "SSB_ARGS=%*"
if not defined SSB_ARGS goto elev_plain
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:SSB_SELF -ArgumentList $env:SSB_ARGS -Verb RunAs } catch { exit 1 }"
goto elev_done

:elev_plain
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:SSB_SELF -Verb RunAs } catch { exit 1 }"

:elev_done
if not errorlevel 1 exit /b 0
echo   [ 失败 ] 提权被取消。也可以右键这个文件 →「以管理员身份运行」。
echo.
pause
exit /b 1

rem ---------- 4. 干活 ----------
:is_admin
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\install.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" goto deployed
echo    [ 失败 ] 部署没完成（退出码 %RC%）。
echo    详细日志：%~dp0logs\install.log
if defined SSB_DIRECT exit /b %RC%
echo.
pause
exit /b %RC%

:deployed
echo    [ 成功 ] 部署完成。
if defined SSB_DIRECT exit /b 0
echo.

rem ---------- 5. 顺手启动 ----------
choice /c YN /n /m "   现在启动服务？[Y 启动 / N 稍后]: "
if errorlevel 2 goto finished
set "SSB_NO_PAUSE=1"
call "%~dp0学生状态管理系统.cmd" /start
echo.
goto finished

:finished
echo.
echo    以后双击桌面「学生状态管理系统」就能用；
echo    也可以双击本目录的 学生状态管理系统.cmd 打开菜单。
if defined SSB_NO_PAUSE exit /b 0
echo.
pause
exit /b 0

:cancelled
echo.
echo    已取消，什么都没改。
if defined SSB_NO_PAUSE exit /b 1
echo.
pause
exit /b 1

:err_not_extracted
echo.
echo    [ 错误 ] 找不到程序文件（server\index.js）。
echo.
echo    你大概是在压缩包里直接双击的。请先：
echo      1. 右键 zip 文件 → 全部解压缩
echo      2. 进解压出来的文件夹，再双击这个文件
echo.
echo    不要放在 OneDrive / 坚果云等同步目录里。
if defined SSB_NO_PAUSE exit /b 1
echo.
pause
exit /b 1