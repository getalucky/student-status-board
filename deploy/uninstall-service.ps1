<#
.SYNOPSIS
    卸载 StudentBoard Windows 服务（停止 + 从服务表移除）。

.DESCRIPTION
    只删服务，不动数据：data\ 里的 SQLite、logs\ 里的日志都原样保留。
    默认要输入 yes 确认；加 -Force 跳过确认（适合脚本里调）。

.PARAMETER ServiceName
    服务名，默认 StudentBoard，要和安装时一致。

.PARAMETER NssmPath
    nssm.exe 路径，默认 Get-Command nssm / deploy\nssm.exe / 常见安装目录。

.PARAMETER Force
    跳过交互确认。

.PARAMETER RemoveLogs
    顺带删掉 logs\ 目录（默认保留）。

.EXAMPLE
    .\deploy\uninstall-service.ps1

.EXAMPLE
    .\deploy\uninstall-service.ps1 -Force -RemoveLogs
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ServiceName = 'StudentBoard',
    [string]$NssmPath,
    [string]$ProjectRoot,
    [switch]$Force,
    [switch]$RemoveLogs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  ok  $Text" -ForegroundColor Green }
function Write-Warn2 { param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }

function Invoke-Nssm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $script:Nssm @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "nssm $($Arguments -join ' ') 执行失败，退出码 $LASTEXITCODE" }
}

# 管理员
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '删除系统服务需要管理员权限：开始菜单搜索 PowerShell → 右键「以管理员身份运行」→ 再执行本脚本。'
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }

# 服务在不在
Write-Step "检查服务 $ServiceName"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Warn2 "服务 $ServiceName 不存在，可能已经卸载过了。"
    return
}
Write-Ok "当前状态：$($svc.Status)"

if (-not $Force) {
    $answer = Read-Host "确认卸载服务 $ServiceName ？数据文件不会删。输入 yes 继续"
    if ($answer -ne 'yes') { Write-Host '已取消。' -ForegroundColor DarkGray; return }
}

# nssm
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
    throw '找不到 nssm.exe：用 -NssmPath 指定，或改用 sc.exe delete ' + $ServiceName
}
$NssmPath = (Resolve-Path -LiteralPath $NssmPath).Path
$script:Nssm = $NssmPath

# 停止
Write-Step '停止服务'
if ($svc.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceName -Force
    (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}
Write-Ok '已停止'

# 删除
Write-Step '从服务表移除'
Invoke-Nssm remove $ServiceName confirm
Start-Sleep -Milliseconds 800

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Warn2 "服务仍在。可能被其他进程占用，重开「服务」管理器确认，或用 sc.exe delete $ServiceName"
}
else {
    Write-Ok "服务 $ServiceName 已删除"
}

if ($RemoveLogs) {
    $logDir = Join-Path $ProjectRoot 'logs'
    if (Test-Path -LiteralPath $logDir) {
        Remove-Item -LiteralPath $logDir -Recurse -Force
        Write-Ok "已删除日志目录 $logDir"
    }
}

Write-Host ''
Write-Host '数据保留在 data\ 里；要彻底清干净再手动删 data\。' -ForegroundColor DarkGray
