<#
.SYNOPSIS
    用 NSSM 把「学生状态管理系统」注册成 Windows 服务（手动启动 + 崩溃自动重启）。

.DESCRIPTION
    默认参数即可在项目根直接跑：
        powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1

    做的事：
      1. 校验管理员权限、node.exe、nssm.exe、server\index.js
      2. nssm install StudentBoard <node.exe>
      3. AppParameters 指向 server\index.js，AppDirectory 指向项目根
      4. 注入环境变量 NODE_ENV=production / PORT / HOST / COOKIE_SECURE=auto
      5. 标准输出、错误输出重定向到 logs\ 并按 10MB 轮转
      6. 启动类型手动（不开机自启）、退出码任意都重启（延迟 3s，5s 内重启过频则节流）
      7. 启动服务并等端口监听成功

    需要管理员权限。重复执行 = 重新配置（不会报「已存在」）。

.PARAMETER ServiceName
    服务名，默认 StudentBoard。改名一般没必要。

.PARAMETER NodePath
    node.exe 完整路径。默认 Get-Command node，其次探测 C:\Program Files\nodejs。

.PARAMETER NssmPath
    nssm.exe 完整路径。默认 Get-Command nssm，其次 deploy\nssm.exe、C:\Program Files\nssm\nssm.exe。

.PARAMETER ProjectRoot
    项目根目录，默认本脚本的上一级。

.PARAMETER Port
    监听端口，默认 3210。同时写进服务环境变量 PORT。

.PARAMETER ListenHost
    监听地址，默认 0.0.0.0（回环 + 局域网，配合 COOKIE_SECURE=auto）。
    只给 Tailscale 用时可传 127.0.0.1。

.PARAMETER LogDir
    日志目录，默认 <项目根>\logs。

.EXAMPLE
    .\deploy\install-service.ps1

.EXAMPLE
    .\deploy\install-service.ps1 -NodePath "C:\Program Files\nodejs\node.exe" -Port 3210 -NssmPath "D:\tools\nssm.exe"
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ServiceName = 'StudentBoard',
    [string]$NodePath,
    [string]$NssmPath,
    [string]$ProjectRoot,
    [int]$Port = 3210,
    [string]$ListenHost = '0.0.0.0',
    [string]$LogDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  ok  $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "  ..  $Text" -ForegroundColor DarkGray }
function Write-Warn2 { param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }

function Invoke-Nssm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $script:Nssm @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "nssm $($Arguments -join ' ') 执行失败，退出码 $LASTEXITCODE"
    }
}

# ---------------------------------------------------------------- 1. 管理员
Write-Step '检查管理员权限'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '注册系统服务需要管理员权限：开始菜单搜索 PowerShell → 右键「以管理员身份运行」→ 再执行本脚本。'
}
Write-Ok '已具备管理员权限'

# ---------------------------------------------------------------- 2. 项目根
Write-Step '定位项目根目录'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
$entry = Join-Path $ProjectRoot 'server\index.js'
if (-not (Test-Path -LiteralPath $entry)) {
    throw "找不到服务入口 $entry —— 先确认 server\index.js 已存在（或先用 -ProjectRoot 指定正确目录）。"
}
Write-Ok "项目根：$ProjectRoot"
Write-Ok "入口：  $entry"

# ---------------------------------------------------------------- 3. node
Write-Step '定位 node.exe'
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodePath = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    foreach ($candidate in @(
            'C:\Program Files\nodejs\node.exe',
            'C:\Program Files (x86)\nodejs\node.exe'
        )) {
        if (Test-Path -LiteralPath $candidate) { $NodePath = $candidate; break }
    }
}
if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath)) {
    throw '找不到 node.exe：用 -NodePath "D:\path\to\node.exe" 显式指定。'
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$nodeVersion = (& $NodePath -v) -join ''
Write-Ok "$NodePath ($nodeVersion)"
if ($nodeVersion -notmatch '^v(2[4-9]|[3-9]\d)\.') {
    Write-Warn2 "当前 node 版本 $nodeVersion，方案要求 Node 24+（better-sqlite3 预编译包按版本区分）。"
}

# ---------------------------------------------------------------- 4. nssm
Write-Step '定位 nssm.exe'
if ([string]::IsNullOrWhiteSpace($NssmPath)) {
    $cmd = Get-Command nssm -ErrorAction SilentlyContinue
    if ($cmd) { $NssmPath = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($NssmPath)) {
    foreach ($candidate in @(
            (Join-Path $PSScriptRoot 'nssm.exe'),
            'C:\Program Files\nssm\nssm.exe',
            'C:\Program Files (x86)\nssm\nssm.exe',
            'C:\nssm\nssm.exe',
            'E:\nssm\nssm.exe'
        )) {
        if (Test-Path -LiteralPath $candidate) { $NssmPath = $candidate; break }
    }
}
if ([string]::IsNullOrWhiteSpace($NssmPath) -or -not (Test-Path -LiteralPath $NssmPath)) {
    throw @'
找不到 nssm.exe。二选一：
  winget install --id NSSM.NSSM -e
  或下载 https://nssm.cc/download 解压，把 win64\nssm.exe 复制到 deploy\nssm.exe，然后重跑本脚本。
'@
}
$NssmPath = (Resolve-Path -LiteralPath $NssmPath).Path
$script:Nssm = $NssmPath
Write-Ok $NssmPath

# ---------------------------------------------------------------- 5. 日志目录
Write-Step '准备日志目录'
if ([string]::IsNullOrWhiteSpace($LogDir)) { $LogDir = Join-Path $ProjectRoot 'logs' }
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogDir = (Resolve-Path -LiteralPath $LogDir).Path
$outLog = Join-Path $LogDir 'service.out.log'
$errLog = Join-Path $LogDir 'service.err.log'
Write-Ok $LogDir

# ---------------------------------------------------------------- 6. 注册 / 重配
Write-Step "注册服务 $ServiceName"
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Note "服务已存在（当前状态：$($existing.Status)），按新参数重新配置"
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
        Write-Ok '已停止旧实例'
    }
    Invoke-Nssm set $ServiceName Application $NodePath
}
else {
    Invoke-Nssm install $ServiceName $NodePath
    Write-Ok '服务已创建'
}

Invoke-Nssm set $ServiceName AppParameters "`"$entry`""
Invoke-Nssm set $ServiceName AppDirectory $ProjectRoot
Invoke-Nssm set $ServiceName DisplayName '学生状态管理系统'
Invoke-Nssm set $ServiceName Description '学生状态管理系统：Fastify + SQLite，0.0.0.0 + COOKIE_SECURE=auto，手动启动。'
Invoke-Nssm set $ServiceName Start SERVICE_DEMAND_START
Invoke-Nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production" "PORT=$Port" "HOST=$ListenHost" "COOKIE_SECURE=auto"
Invoke-Nssm set $ServiceName AppStdout $outLog
Invoke-Nssm set $ServiceName AppStderr $errLog
Invoke-Nssm set $ServiceName AppRotateFiles 1
Invoke-Nssm set $ServiceName AppRotateOnline 1
Invoke-Nssm set $ServiceName AppRotateBytes 10485760
Invoke-Nssm set $ServiceName AppExit Default Restart
Invoke-Nssm set $ServiceName AppRestartDelay 3000
Invoke-Nssm set $ServiceName AppThrottle 5000
Invoke-Nssm set $ServiceName AppStopMethodConsole 15000
Write-Ok '参数写入完成（自启 / 崩溃重启 / 日志轮转 / 环境变量）'

# ---------------------------------------------------------------- 7. 启动 + 验证
Write-Step '启动服务'
try {
    Start-Service -Name $ServiceName
    Write-Ok "服务状态：$((Get-Service -Name $ServiceName).Status)"
}
catch {
    Write-Warn2 "启动失败：$($_.Exception.Message)"
    Write-Host "    看日志：Get-Content -Tail 50 `"$errLog`"" -ForegroundColor DarkGray
}

Write-Step "等待 $ListenHost`:$Port 监听（最多 20 秒）"
$listening = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { $listening = $true; break }
    if ((Get-Service -Name $ServiceName).Status -ne 'Running') { break }
}
if ($listening) {
    Write-Ok "端口已监听：$ListenHost`:$Port"
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/healthz" -TimeoutSec 5
        Write-Ok "健康检查通过：$($health | ConvertTo-Json -Compress)"
    }
    catch {
        Write-Warn2 "健康检查 /api/healthz 未通过：$($_.Exception.Message)"
    }
}
else {
    Write-Warn2 '端口未监听。看日志：'
    Write-Host "    Get-Content -Tail 50 `"$outLog`"" -ForegroundColor DarkGray
    Write-Host "    Get-Content -Tail 50 `"$errLog`"" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '---------------- 下一步 ----------------' -ForegroundColor Cyan
Write-Host '  1) 本机自测：  start http://127.0.0.1:' -NoNewline; Write-Host "$Port"
Write-Host '  2) 开 Tailscale 访问：.\deploy\tailscale-serve.ps1'
Write-Host '  3) 注册每日备份：    .\deploy\backup-task.ps1'
Write-Host '  4) 卸载服务：        .\deploy\uninstall-service.ps1'
Write-Host '----------------------------------------' -ForegroundColor Cyan
