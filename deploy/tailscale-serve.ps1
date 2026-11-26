<#
.SYNOPSIS
    用 tailscale serve 把本机 127.0.0.1:3210 暴露成私网 HTTPS 地址（*.ts.net），手机/电脑跨网访问。

.DESCRIPTION
    做的就是这个：
        tailscale serve --bg http://127.0.0.1:3210

    - 证书由 Tailscale 自动签发（Let's Encrypt，DNS-01），不用域名、不用开公网端口
    - 只有登录同一个 tailnet 的设备能访问，设备列表即白名单
    - --bg 表示后台常驻，退出终端也不影响；重启电脑后 tailscaled 起来会自己恢复
    - 需要本机已安装 Tailscale 并登录

    不需要管理员权限（tailscale serve 走当前用户登录态）。

.PARAMETER Port
    本机后端端口，默认 3210，要和 install-service.ps1 的 -Port 一致。

.PARAMETER ListenHost
    本机后端地址，默认 127.0.0.1。别填 0.0.0.0。

.PARAMETER TailscalePath
    tailscale.exe 路径。默认 Get-Command tailscale，其次 Program Files\Tailscale\tailscale.exe。

.PARAMETER Reset
    先执行 tailscale serve reset 清掉所有 serve 规则，再按本脚本重新配。

.PARAMETER StatusOnly
    只看当前状态，不改配置。

.EXAMPLE
    .\deploy\tailscale-serve.ps1

.EXAMPLE
    .\deploy\tailscale-serve.ps1 -Port 3210 -Reset

.EXAMPLE
    .\deploy\tailscale-serve.ps1 -StatusOnly
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [int]$Port = 3210,
    [string]$ListenHost = '127.0.0.1',
    [string]$TailscalePath,
    [switch]$Reset,
    [switch]$StatusOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  ok  $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "  ..  $Text" -ForegroundColor DarkGray }
function Write-Warn2 { param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- tailscale.exe
Write-Step '定位 tailscale.exe'
if ([string]::IsNullOrWhiteSpace($TailscalePath)) {
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { $TailscalePath = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($TailscalePath)) {
    foreach ($candidate in @(
            'C:\Program Files\Tailscale\tailscale.exe',
            'C:\Program Files (x86)\Tailscale\tailscale.exe'
        )) {
        if (Test-Path -LiteralPath $candidate) { $TailscalePath = $candidate; break }
    }
}
if ([string]::IsNullOrWhiteSpace($TailscalePath) -or -not (Test-Path -LiteralPath $TailscalePath)) {
    throw @'
找不到 tailscale.exe。先装 Tailscale：
  官网 https://tailscale.com/download/windows 下载安装，登录你的 tailnet；
  装完重开一个 PowerShell 再跑本脚本（PATH 才会刷新）。
'@
}
$TailscalePath = (Resolve-Path -LiteralPath $TailscalePath).Path
Write-Ok $TailscalePath

# ---------------------------------------------------------------- 登录状态
Write-Step '检查 Tailscale 登录状态'
$statusText = (& $TailscalePath status 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $statusText -match 'Logged out|not logged in|NeedsLogin') {
    Write-Warn2 '当前未登录或 tailscaled 未运行：'
    Write-Host $statusText.Trim() -ForegroundColor DarkGray
    throw '先执行 tailscale up 并完成浏览器登录，再重跑本脚本。'
}
Write-Ok '已登录'

# ---------------------------------------------------------------- 只看状态
if ($StatusOnly) {
    Write-Host ''
    Write-Host '---- tailscale serve status ----' -ForegroundColor Cyan
    & $TailscalePath serve status
    Write-Host ''
    Write-Host '---- tailscale status ----' -ForegroundColor Cyan
    & $TailscalePath status
    return
}

# ---------------------------------------------------------------- 重置
if ($Reset) {
    Write-Step '重置已有 serve 规则'
    & $TailscalePath serve reset
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "serve reset 退出码 $LASTEXITCODE（没有规则时也非 0，忽略）" }
    else { Write-Ok '已清空' }
}

# ---------------------------------------------------------------- 配置 serve
$target = "http://${ListenHost}:${Port}"
Write-Step "配置 serve：$target"
& $TailscalePath serve --bg $target
if ($LASTEXITCODE -ne 0) {
    throw "tailscale serve 失败（退出码 $LASTEXITCODE）。常见原因：HTTPS 未在 tailnet 开启 → 去 https://login.tailscale.com/admin/dns 打开 HTTPS Certificates。"
}
Write-Ok '已后台常驻'

# 本机端口是否在听
Write-Step "检查本机 $ListenHost`:$Port"
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Write-Ok '端口正在监听'
}
else {
    Write-Warn2 '端口没在听 —— 先确认服务已启动（Get-Service StudentBoard / npm start），否则手机打开会 502。'
}

# ---------------------------------------------------------------- 输出地址
Write-Step '服务地址'
$dnsName = $null
try {
    $json = & $TailscalePath status --json | Out-String | ConvertFrom-Json
    $dnsName = $json.Self.DNSName
}
catch {
    Write-Note "解析 DNS 名失败：$($_.Exception.Message)"
}
if ($dnsName) {
    $url = 'https://' + $dnsName.TrimEnd('.')
    Write-Host ''
    Write-Host "  $url" -ForegroundColor Green
    Write-Host ''
    Write-Host '  手机：装 Tailscale → 登录同一个 tailnet → Safari/Chrome 打开上面地址' -ForegroundColor DarkGray
    try {
        $logDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs'
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText((Join-Path $logDir 'tailscale-url.txt'), $url + "`n", $utf8NoBom)
        Write-Host '  启动器会读取 logs\tailscale-url.txt 显示这个地址' -ForegroundColor DarkGray
    } catch { }
}
else {
    Write-Host '  在 https://login.tailscale.com/admin/machines 看这台机器的 DNSName' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '---- tailscale serve status ----' -ForegroundColor Cyan
& $TailscalePath serve status | Out-Host

Write-Host ''
Write-Host '想看是否直连（direct 比 relay 快）：' -ForegroundColor DarkGray
Write-Host "  & `"$TailscalePath`" ping <手机设备名>" -ForegroundColor DarkGray
