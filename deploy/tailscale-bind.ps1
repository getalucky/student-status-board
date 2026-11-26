<#
.SYNOPSIS
    把本机 Tailscale 一次绑好：安装 → 用 auth key 加入 tailnet → 配 tailscale serve。

.DESCRIPTION
    三种情况都处理：
      1. 没装：-Install 时静默安装（winget 优先，没有就下官方 MSI）
      2. 装了没登录：用 auth key 执行 tailscale up，无人值守加入 tailnet
      3. 已登录：直接 tailscale serve --bg http://127.0.0.1:<Port>

    auth key 只在内存里用于一次 tailscale up，不写文件、不进日志。
    tailnet 需已开启 HTTPS Certificates，否则 serve 拿不到证书。

.PARAMETER AuthKey
    tskey-auth-...；不传则读环境变量 TS_AUTHKEY，再没有就交互输入（不回显）。

.PARAMETER Hostname
    这台机器在 tailnet 里的名字，默认保持系统计算机名。

.PARAMETER Port
    本地服务端口，默认 3210。

.PARAMETER ListenHost
    serve 反代到的本地地址，默认 127.0.0.1。

.PARAMETER Install
    没装 Tailscale 时自动静默安装。

.PARAMETER NoServe
    只绑定 tailnet，不配 serve。

.PARAMETER StatusOnly
    只看状态，不改任何东西。

.PARAMETER DryRun
    只打印将要执行的命令，不安装、不登录、不改 serve。

.PARAMETER AllowEphemeral
    允许使用 ephemeral auth key（默认拒绝：设备离线后会被自动移除）。

.PARAMETER NoElevate
    需要管理员权限时不自动提权（测试用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\tailscale-bind.ps1 -AuthKey tskey-auth-xxx -Install

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\tailscale-bind.ps1 -StatusOnly
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AuthKey,
    [string]$Hostname,
    [int]$Port = 3210,
    [string]$ListenHost = '127.0.0.1',
    [switch]$Install,
    [switch]$NoServe,
    [switch]$StatusOnly,
    [switch]$DryRun,
    [switch]$AllowEphemeral,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

$script:Root = Split-Path -Parent $PSScriptRoot
$script:LogFile = Join-Path (Join-Path $script:Root 'logs') 'tailscale.log'
$script:TsExe = $null

function Write-Log {
    param([string]$Text, [string]$Level = 'INFO')
    $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Text
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN'  { Write-Host $line -ForegroundColor Yellow }
        'OK'    { Write-Host $line -ForegroundColor Green }
        default { Write-Host $line }
    }
    try {
        $dir = Split-Path -Parent $script:LogFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Write-Step { param([string]$Text) Write-Host ''; Write-Host ("== " + $Text) -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host ("   " + $Text) -ForegroundColor Green }
function Write-Warn2 { param([string]$Text) Write-Host ("   " + $Text) -ForegroundColor Yellow }
function Write-Note { param([string]$Text) Write-Host ("   " + $Text) -ForegroundColor DarkGray }

function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-TsExe {
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @('C:\Program Files\Tailscale\tailscale.exe', 'C:\Program Files (x86)\Tailscale\tailscale.exe')) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Get-TsJson {
    if (-not $script:TsExe) { return $null }
    $raw = (& $script:TsExe status --json 2>$null | Out-String)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Get-BackendState {
    $json = Get-TsJson
    if ($null -eq $json) { return $null }
    $prop = $json.PSObject.Properties['BackendState']
    if ($null -eq $prop) { return $null }
    return [string]$prop.Value
}

function Get-DnsName {
    $json = Get-TsJson
    if ($null -eq $json) { return $null }
    $self = $json.PSObject.Properties['Self']
    if ($null -eq $self -or $null -eq $self.Value) { return $null }
    $dns = $self.Value.PSObject.Properties['DNSName']
    if ($null -eq $dns -or [string]::IsNullOrWhiteSpace([string]$dns.Value)) { return $null }
    return ([string]$dns.Value).TrimEnd('.')
}

function Format-KeyHint {
    param([string]$Key)
    if ([string]::IsNullOrWhiteSpace($Key)) { return '(空)' }
    if ($Key.Length -le 16) { return 'tskey-****' }
    return $Key.Substring(0, 12) + '****' + $Key.Substring($Key.Length - 4)
}

function Read-AuthKey {
    if (-not [Environment]::UserInteractive) {
        throw '当前没有交互窗口，无法输入 auth key。改用 -AuthKey 或先设置环境变量 TS_AUTHKEY。'
    }
    $sec = Read-Host -Prompt '粘贴 Tailscale auth key（tskey-auth-...，输入不回显）' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Install-Tailscale {
    $arch = 'amd64'
    $pa = [string]$env:PROCESSOR_ARCHITECTURE
    if ($pa -eq 'ARM64') { $arch = 'arm64' }
    elseif ($pa -eq 'x86' -and [string]$env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Step '用 winget 静默安装 Tailscale'
        & $winget.Source install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-Host
        if ($LASTEXITCODE -eq 0) { Write-Ok 'winget 安装完成'; return }
        Write-Warn2 ("winget 失败（退出码 {0}），改用官方 MSI" -f $LASTEXITCODE)
    }

    $url = "https://pkgs.tailscale.com/stable/tailscale-setup-latest-$arch.msi"
    $msi = Join-Path $env:TEMP "tailscale-setup-latest-$arch.msi"
    Write-Step "下载官方安装包（$arch）"
    Write-Note $url
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
    Write-Ok ("已下载 {0:N1} MB" -f ((Get-Item -LiteralPath $msi).Length / 1MB))

    Write-Step '静默安装'
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart') -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        throw ("msiexec 安装失败（退出码 {0}）。可手动装：https://tailscale.com/download/windows" -f $p.ExitCode)
    }
    Write-Ok '安装完成'
}

function Wait-ForTailscale {
    param([int]$TimeoutSec = 90)
    for ($i = 0; $i -lt $TimeoutSec; $i++) {
        $exe = Get-TsExe
        if ($exe) {
            # 服务刚装好时 CLI 可能还连不上 tailscaled，再等状态可读
            $script:TsExe = $exe
            if ($null -ne (Get-TsJson)) { return $exe }
        }
        Start-Sleep -Seconds 1
    }
    return $null
}

Write-Log '===== tailscale-bind 开始 ====='

# ---------------------------------------------------------------- 只看状态
if ($StatusOnly) {
    $script:TsExe = Get-TsExe
    if (-not $script:TsExe) {
        Write-Warn2 '没有安装 Tailscale'
        return
    }
    Write-Step 'tailscale status'
    & $script:TsExe status | Out-Host
    Write-Step 'tailscale serve status'
    & $script:TsExe serve status | Out-Host
    $dns = Get-DnsName
    if ($dns) {
        Write-Host ''
        Write-Host ("  https://" + $dns) -ForegroundColor Green
    }
    $urlFile = Join-Path (Join-Path $script:Root 'logs') 'tailscale-url.txt'
    if (Test-Path -LiteralPath $urlFile) {
        Write-Note ("启动器读取的地址文件：" + (Get-Content -LiteralPath $urlFile -Raw).Trim())
    }
    return
}

function Invoke-Elevate {
    if ($NoElevate) { throw '需要管理员权限：右键「以管理员身份运行」PowerShell，再执行本脚本。' }
    # key 走环境变量传给提权后的进程，不放在命令行里
    if (-not [string]::IsNullOrWhiteSpace($AuthKey)) { $env:TS_AUTHKEY = $AuthKey }
    Write-Log '需要管理员权限，正在请求提权…'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"' + $PSCommandPath + '"'), '-Port', [string]$Port, '-ListenHost', $ListenHost)
    if ($Install) { $argList += '-Install' }
    if ($NoServe) { $argList += '-NoServe' }
    if ($AllowEphemeral) { $argList += '-AllowEphemeral' }
    if (-not [string]::IsNullOrWhiteSpace($Hostname)) { $argList += @('-Hostname', ('"' + $Hostname + '"')) }
    Start-Process -FilePath 'powershell.exe' -ArgumentList ($argList -join ' ') -Verb RunAs | Out-Null
    Write-Note '已在新窗口继续；本窗口可以关掉。'
}

# ---------------------------------------------------------------- 找 tailscale
Write-Step '定位 tailscale.exe'
$script:TsExe = Get-TsExe
if (-not $script:TsExe) {
    if (-not $Install) {
        throw '没有装 Tailscale。加 -Install 自动安装，或去 https://tailscale.com/download/windows 手动装。'
    }
    if ($DryRun) {
        Write-Log '[dry-run] 静默安装 Tailscale'
    } else {
        if (-not (Test-Admin)) { Invoke-Elevate; return }
        Install-Tailscale
        $script:TsExe = Wait-ForTailscale
        if (-not $script:TsExe) { throw '安装完成但找不到 tailscale.exe，或 tailscaled 服务没起来。' }
    }
}
if ($script:TsExe) { Write-Ok $script:TsExe }

# ---------------------------------------------------------------- 登录 tailnet
$state = $null
if (-not $DryRun) { $state = Get-BackendState }
Write-Step '检查 tailnet 登录状态'
Write-Note ("BackendState = " + $(if ($null -eq $state) { '(未知)' } else { $state }))

if ($state -eq 'Running') {
    Write-Ok '已登录，跳过 tailscale up'
} else {
    $key = $AuthKey
    if ([string]::IsNullOrWhiteSpace($key)) { $key = [string]$env:TS_AUTHKEY }
    if ([string]::IsNullOrWhiteSpace($key) -and -not $DryRun) { $key = Read-AuthKey }

    if ([string]::IsNullOrWhiteSpace($key)) {
        if ($DryRun) {
            Write-Log '[dry-run] tailscale up --authkey <未提供，运行时会提示输入>'
        } else {
            throw '没有 auth key。去 https://login.tailscale.com/admin/settings/keys 生成（Reusable + Pre-approved，别选 Ephemeral），再重跑。'
        }
    } else {
        if ($key -notmatch '^tskey-') { Write-Warn2 '这个 key 不像 tailscale auth key（应以 tskey- 开头），继续尝试。' }
        if ($key -match '^tskey-ephemeral-' -and -not $AllowEphemeral) {
            throw 'ephemeral key 会在设备离线后被自动移除，不适合长期跑的服务；请生成 Reusable + Pre-approved 的 auth key（-AllowEphemeral 可强行放行）。'
        }
        Write-Note ('使用 auth key：' + (Format-KeyHint $key))

        if (-not $DryRun -and -not (Test-Admin)) {
            if (-not [string]::IsNullOrWhiteSpace($key)) { $env:TS_AUTHKEY = $key }
            Invoke-Elevate
            return
        }

        if ($DryRun) {
            Write-Log '[dry-run] tailscale up --authkey=****'
        } else {
            $upArgs = @('up', ("--authkey=" + $key))
            if (-not [string]::IsNullOrWhiteSpace($Hostname)) { $upArgs += ("--hostname=" + $Hostname) }
            Write-Step '加入 tailnet'
            & $script:TsExe @upArgs 2>&1 | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw ("tailscale up 失败（退出码 {0}）：key 过期/已用过/被撤销，或这台机器被 tailnet 策略拦住。" -f $LASTEXITCODE)
            }
            $state = $null
            for ($i = 0; $i -lt 90; $i++) {
                Start-Sleep -Seconds 1
                $state = Get-BackendState
                if ($state -eq 'Running') { break }
            }
            if ($state -eq 'NeedsMachineAuth') {
                throw '设备已加入但等待管理员批准：去 https://login.tailscale.com/admin/machines 通过这台机器后重跑。'
            }
            if ($state -ne 'Running') {
                throw ("tailscale up 后状态是 {0}，不是 Running。看 logs\tailscale.log 或 tailscale status。" -f $state)
            }
            Write-Ok '已加入 tailnet'
        }
    }
}

# ---------------------------------------------------------------- serve
$dns = $null
if (-not $NoServe) {
    $target = "http://${ListenHost}:${Port}"
    Write-Step "配置 tailscale serve：$target"
    if ($DryRun) {
        Write-Log ("[dry-run] tailscale serve --bg {0}" -f $target)
    } else {
        & $script:TsExe serve --bg $target | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw 'tailscale serve 失败。最常见原因：tailnet 没开 HTTPS Certificates → https://login.tailscale.com/admin/dns 打开后重试。'
        }
        Write-Ok 'serve 已后台常驻'
        $dns = Get-DnsName
    }
} else {
    Write-Note '跳过 serve（-NoServe）'
    if (-not $DryRun) { $dns = Get-DnsName }
}

# ---------------------------------------------------------------- 地址落地
if ($dns) {
    $url = 'https://' + $dns
    $logDir = Join-Path $script:Root 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $urlFile = Join-Path $logDir 'tailscale-url.txt'
    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($urlFile, $url + "`n", $utf8NoBom)
        Write-Log ("跨网地址已写入 {0}" -f $urlFile)
    } catch {
        Write-Log ("写 {0} 失败：{1}" -f $urlFile, $_.Exception.Message) 'WARN'
    }
    Write-Host ''
    Write-Host '---------------- 绑定结果 ----------------' -ForegroundColor Cyan
    Write-Host ("  跨网访问：{0}" -f $url) -ForegroundColor Green
    Write-Host '  手机/外面电脑：装 Tailscale，登录同一个 tailnet，打开上面地址' -ForegroundColor DarkGray
    Write-Host ("  本机反代：{0} -> http://{1}:{2}" -f $url, $ListenHost, $Port) -ForegroundColor DarkGray
    Write-Host '------------------------------------------' -ForegroundColor Cyan
} else {
    if (-not $DryRun) {
        Write-Warn2 '没拿到 ts.net 地址：确认 tailnet 开了 MagicDNS 和 HTTPS Certificates。'
    }
}

Write-Log '===== tailscale-bind 结束 =====' 'OK'