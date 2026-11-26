<#
.SYNOPSIS
    学生状态管理系统 · Windows 一键部署（管理员）。

.DESCRIPTION
    一条命令装完一台新电脑：
      1. 检查管理员权限，没有就自动弹 UAC 提权
      2. 检测 Node.js >= 22；没有就从 npmmirror 下载 v24.22.1 免安装 zip 解到 runtime\node 并使用
      3. node_modules 缺失才 npm.cmd ci --omit=dev --ignore-scripts，并自检 better-sqlite3 能加载
      4. 首次运行（data\config.json 不存在）时跑 scripts/init.js 设登录密码
      5. 在桌面创建「学生状态管理系统」快捷方式：双击 = 主启动器（0.0.0.0 + COOKIE_SECURE=auto）
         —— 默认不注册开机自启服务；需要 Windows 服务时显式加 -InstallService
      6. 检测 Tailscale 并执行 tailscale serve --bg http://127.0.0.1:3210
      7. 注册每日 03:00 备份任务：node scripts\backup.js --keep 7
      8. 冒烟检查 /api/healthz，打印手机 HTTPS 地址

    幂等：重复执行 = 重新配置，不会重复建快捷方式/服务/任务，也不会重置已有密码和数据。

.PARAMETER ProjectRoot
    项目根目录，默认本脚本上一级（deploy\install.ps1 → 项目根）。

.PARAMETER ServiceName
    Windows 服务名，默认 StudentBoard（只在 -InstallService 时使用）。

.PARAMETER Port
    监听端口，默认 3210（需求固定端口）。

.PARAMETER ListenHost
    监听地址，默认 0.0.0.0（回环 + 局域网，配合 COOKIE_SECURE=auto）。
    只给 Tailscale 反代用时可传 127.0.0.1。

.PARAMETER NodePath
    指定 node.exe；不填则按 runtime\node → PATH → 常见安装目录 → 下载 的顺序找。

.PARAMETER NssmPath
    指定 nssm.exe；不填则按 deploy\nssm.exe → PATH → 常见目录 → 自动下载 的顺序找。

.PARAMETER NodeVersion
    缺失时下载的 Node 版本，默认 24.22.1。

.PARAMETER NodeMirror
    Node 下载镜像，默认 https://npmmirror.com/mirrors/node。

.PARAMETER Password
    首次初始化密码（至少 6 位）。不填则交互输入；已有 data\config.json 时忽略。

.PARAMETER HealthTimeoutSec
    启动后等待 /api/healthz 的秒数，默认 30。

.PARAMETER SkipNodeInstall
    禁止下载 Node（只接受本机已有的 >= 22）。

.PARAMETER SkipDeps
    跳过 node_modules 安装（已经装好时用）。

.PARAMETER InstallService
    额外注册 Windows 服务（手动启动，不设开机自启）。日常使用不需要，桌面快捷方式即可。

.PARAMETER SkipService
    兼容旧参数：不注册 Windows 服务（现在默认就不注册，保留此开关无副作用）。

.PARAMETER SkipShortcut
    不创建桌面快捷方式。

.PARAMETER SkipTailscale
    不配置 tailscale serve。

.PARAMETER SkipBackupTask
    不注册每日备份任务。

.PARAMETER DryRun
    只检查并打印计划，不做任何写入（不下载、不初始化、不注册快捷方式/服务/任务）。

.PARAMETER NoElevate
    无管理员权限时不自动提权（测试用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\install.ps1 -Password "你的密码" -SkipTailscale

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\install.ps1 -InstallService
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$ServiceName = 'StudentBoard',
    [int]$Port = 3210,
    [string]$ListenHost = '0.0.0.0',
    [string]$NodePath,
    [string]$NssmPath,
    [string]$NodeVersion = '24.22.1',
    [string]$NodeMirror = 'https://npmmirror.com/mirrors/node',
    [string]$Password,
    [int]$HealthTimeoutSec = 30,
    [switch]$SkipNodeInstall,
    [switch]$SkipDeps,
    [switch]$InstallService,
    [switch]$SkipService,
    [switch]$SkipShortcut,
    [switch]$SkipTailscale,
    [switch]$SkipBackupTask,
    [switch]$DryRun,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

# ---------------------------------------------------------------- 路径与日志
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$script:Root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
$script:LogFile = Join-Path (Join-Path $script:Root 'logs') 'install.log'

# 默认只做桌面一键启动；Windows 服务是可选能力（手动启动，不设开机自启）
$skipService = -not $InstallService

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
        $logDir = Split-Path -Parent $script:LogFile
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Test-IsAdmin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-FreePort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $p = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $p
}

Write-Log '================ install 开始 ================'
Write-Log "项目根：$script:Root"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------- 管理员
if (-not (Test-IsAdmin)) {
    if ($DryRun -or $NoElevate) {
        Write-Log '当前不是管理员：dry-run / NoElevate 下继续，但服务与备份任务注册会跳过。' 'WARN'
    } else {
        Write-Log '注册 Windows 服务需要管理员权限，正在请求提权…'
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
        foreach ($key in $PSBoundParameters.Keys) {
            $value = $PSBoundParameters[$key]
            if ($value -is [System.Management.Automation.SwitchParameter]) {
                if ($value.IsPresent) { $argList += ('-' + $key) }
            } else {
                $argList += ('-' + $key)
                $argList += ('"' + [string]$value + '"')
            }
        }
        try {
            $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList ($argList -join ' ') -Verb RunAs -PassThru
        } catch {
            throw '提权被取消或失败：请右键「以管理员身份运行」PowerShell，再执行本脚本。'
        }
        if ($elevated) {
            $elevated.WaitForExit()
            if ($elevated.ExitCode -eq 0) { Write-Host '安装完成（详见 logs\install.log）' -ForegroundColor Green }
            else { Write-Host '安装未完成（详见 logs\install.log）' -ForegroundColor Red }
            exit $elevated.ExitCode
        }
        exit 1
    }
} else {
    Write-Log '管理员权限：OK' 'OK'
}

# ---------------------------------------------------------------- 项目文件检查
$entry = Join-Path $script:Root 'server\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw "找不到服务入口 $entry —— 确认在发布包/项目根里运行。" }
$distIndex = Join-Path $script:Root 'web\dist\index.html'
if (-not (Test-Path -LiteralPath $distIndex)) { throw "找不到前端产物 $distIndex —— 发布包里应自带 web\dist。" }
Write-Log "服务入口：$entry"

# ---------------------------------------------------------------- Node
function Get-NodeMajor {
    param([string]$Exe)
    $v = (& $Exe -v) -join ''
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
}

function Install-NodeRuntime {
    param([string]$Root, [string]$Version, [string]$Mirror)
    $runtimeDir = Join-Path $Root 'runtime'
    $nodeDir = Join-Path $runtimeDir 'node'
    $zipPath = Join-Path $runtimeDir ("node-v{0}-win-x64.zip" -f $Version)
    $extractDir = Join-Path $runtimeDir '_node-extract'
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $url = ('{0}/v{1}/node-v{1}-win-x64.zip' -f $Mirror.TrimEnd('/'), $Version)
    Write-Log "下载 Node：$url"
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 900
    } finally {
        $ProgressPreference = $oldProgress
    }
    if (-not (Test-Path -LiteralPath $zipPath)) { throw "Node 下载失败：$url" }
    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
    Write-Log '解压 Node…'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $inner = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $inner) { throw "Node zip 结构异常：$zipPath" }
    if (Test-Path -LiteralPath $nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force }
    Move-Item -LiteralPath $inner.FullName -Destination $nodeDir
    Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    $exe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "Node 解压后找不到 node.exe：$nodeDir" }
    return $exe
}

Write-Log '检测 Node.js（要求 >= 22）'
$nodeExe = $null
$candidates = New-Object System.Collections.ArrayList
if (-not [string]::IsNullOrWhiteSpace($NodePath)) { [void]$candidates.Add($NodePath) }
[void]$candidates.Add((Join-Path $script:Root 'runtime\node\node.exe'))
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { [void]$candidates.Add($nodeCmd.Source) }
foreach ($c in @('C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe')) { [void]$candidates.Add($c) }

foreach ($c in $candidates) {
    if ([string]::IsNullOrWhiteSpace($c)) { continue }
    if (-not (Test-Path -LiteralPath $c)) { continue }
    $major = Get-NodeMajor -Exe $c
    if ($major -ge 22) { $nodeExe = (Resolve-Path -LiteralPath $c).Path; break }
    Write-Log "跳过 Node $c（版本低于 22）" 'WARN'
}

if ($null -eq $nodeExe) {
    if ($SkipNodeInstall) { throw '本机没有 >= 22 的 Node，且指定了 -SkipNodeInstall。' }
    if ($DryRun) {
        Write-Log ('[dry-run] 将下载 Node v{0} 到 {1}\runtime\node' -f $NodeVersion, $script:Root)
        $nodeExe = Join-Path $script:Root 'runtime\node\node.exe'
    } else {
        $nodeExe = Install-NodeRuntime -Root $script:Root -Version $NodeVersion -Mirror $NodeMirror
    }
}
$nodeVersionText = if (Test-Path -LiteralPath $nodeExe) { (& $nodeExe -v) -join '' } else { '(待下载)' }
Write-Log "Node：$nodeExe ($nodeVersionText)" 'OK'

$nodeDir = Split-Path -Parent $nodeExe
if ($env:PATH -notlike ('*' + $nodeDir + '*')) { $env:PATH = $nodeDir + ';' + $env:PATH }

$npmCmd = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path -LiteralPath $npmCmd)) {
    $npmCmdCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCmdCmd) { $npmCmd = $npmCmdCmd.Source } else { $npmCmd = $null }
}
if ($null -ne $npmCmd) { Write-Log "npm ：$npmCmd" } else { Write-Log '找不到 npm.cmd（依赖安装会失败）' 'WARN' }

# ---------------------------------------------------------------- 依赖
Write-Log '检查生产依赖 node_modules'
$bsq = Join-Path $script:Root 'node_modules\better-sqlite3'
$needInstall = -not (Test-Path -LiteralPath $bsq)
if (-not $needInstall) {
    if (-not $DryRun) {
        Push-Location $script:Root
        try { & $nodeExe -e "const D=require('better-sqlite3');new D(':memory:').close();require('@node-rs/argon2').hash('x').then(()=>process.exit(0))" 2>$null }
        finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) {
            Write-Log '现有 node_modules 加载 better-sqlite3 失败，重新安装' 'WARN'
            $needInstall = $true
        }
    }
}

if ($SkipDeps) {
    Write-Log '跳过依赖安装（-SkipDeps）' 'WARN'
} elseif ($needInstall) {
    if ($null -eq $npmCmd) { throw '需要安装依赖但找不到 npm.cmd。' }
    if ($DryRun) {
        Write-Log '[dry-run] 将执行 npm.cmd ci --omit=dev --ignore-scripts'
    } else {
        Write-Log '安装生产依赖：npm.cmd ci --omit=dev --ignore-scripts'
        Push-Location $script:Root
        try {
            & $npmCmd ci --omit=dev --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                Write-Log '带 --ignore-scripts 安装失败，去掉它重试（可能触发本地编译）' 'WARN'
                & $npmCmd ci --omit=dev --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（退出码 $LASTEXITCODE）" }
            }
        } finally { Pop-Location }
        Push-Location $script:Root
        try { & $nodeExe -e "const D=require('better-sqlite3');new D(':memory:').close()" }
        finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw '依赖装完但 better-sqlite3 加载失败：确认用的是 Windows x64 Node 22+。' }
        Write-Log '生产依赖安装完成，better-sqlite3 可用' 'OK'
    }
} else {
    Write-Log 'node_modules 已存在且可用，跳过安装' 'OK'
}

# ---------------------------------------------------------------- 初始化密码
$configPath = Join-Path $script:Root 'data\config.json'
Write-Log '检查登录密码（data\config.json）'
if (Test-Path -LiteralPath $configPath) {
    Write-Log '已初始化过密码，保留不动' 'OK'
} elseif ($DryRun) {
    Write-Log '[dry-run] 将运行 node scripts\init.js 设置登录密码'
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'data'))) {
        New-Item -ItemType Directory -Path (Join-Path $script:Root 'data') -Force | Out-Null
    }
    Push-Location $script:Root
    try {
        if (-not [string]::IsNullOrWhiteSpace($Password)) {
            $env:INIT_PASSWORD = $Password
            try { & $nodeExe 'scripts\init.js' } finally { Remove-Item Env:INIT_PASSWORD -ErrorAction SilentlyContinue }
        } else {
            & $nodeExe 'scripts\init.js'
        }
        if ($LASTEXITCODE -ne 0) { throw "scripts/init.js 失败（退出码 $LASTEXITCODE）" }
    } finally { Pop-Location }
    Write-Log '登录密码已设置' 'OK'
}

# ---------------------------------------------------------------- 桌面快捷方式
function New-DesktopShortcut {
    param([string]$Root, [string]$Name = '学生状态管理系统')
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { throw '找不到当前用户的桌面目录' }
    $target = Join-Path $Root '启动学生状态管理系统.cmd'
    if (-not (Test-Path -LiteralPath $target)) { throw "找不到启动器：$target" }
    $lnk = Join-Path $desktop ($Name + '.lnk')
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($lnk)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $Root
    $shortcut.Description = '学生状态管理系统 · 双击启动'
    $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',220'
    $shortcut.Save()
    return $lnk
}

if ($SkipShortcut) {
    Write-Log '跳过桌面快捷方式（-SkipShortcut）' 'WARN'
} elseif ($DryRun) {
    Write-Log '[dry-run] 将在桌面创建「学生状态管理系统」快捷方式 → 启动学生状态管理系统.cmd'
} else {
    try {
        $lnk = New-DesktopShortcut -Root $script:Root
        Write-Log "桌面快捷方式已创建：$lnk" 'OK'
    } catch {
        Write-Log ("桌面快捷方式创建失败：{0}，手动把 启动学生状态管理系统.cmd 发到桌面即可" -f $_.Exception.Message) 'WARN'
    }
}

# ---------------------------------------------------------------- 局域网防火墙
if ($ListenHost -ne '0.0.0.0') {
    Write-Log "监听 $ListenHost，不需要局域网防火墙规则" 'OK'
} elseif ($DryRun) {
    Write-Log ("[dry-run] 放行防火墙 TCP {0}（仅 LocalSubnet）" -f $Port)
} elseif (-not (Test-IsAdmin)) {
    Write-Log '不是管理员，跳过局域网防火墙；需要时手动运行 deploy\allow-lan-firewall.ps1' 'WARN'
} else {
    try {
        $ruleName = "学生状态管理系统 LAN TCP $Port"
        Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $Port -Profile Any -RemoteAddress LocalSubnet `
            -Description '允许同一局域网设备访问学生状态管理系统（仅本地子网）' | Out-Null
        Write-Log "防火墙已放行 TCP $Port（仅 LocalSubnet）" 'OK'
    } catch {
        Write-Log ("防火墙规则失败：{0}" -f $_.Exception.Message) 'WARN'
    }
}

# ---------------------------------------------------------------- NSSM + 服务
function Resolve-NssmPath {
    param([string]$Preferred, [string]$Root, [switch]$NoDownload)
    if (-not [string]::IsNullOrWhiteSpace($Preferred)) {
        if (Test-Path -LiteralPath $Preferred) { return (Resolve-Path -LiteralPath $Preferred).Path }
        throw "指定的 nssm.exe 不存在：$Preferred"
    }
    $cmd = Get-Command nssm -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @(
            (Join-Path $Root 'deploy\nssm.exe'),
            'C:\Program Files\nssm\nssm.exe',
            'C:\Program Files (x86)\nssm\nssm.exe',
            'C:\nssm\nssm.exe',
            'E:\nssm\nssm.exe'
        )) {
        if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path }
    }
    if ($NoDownload) { return $null }
    $zipPath = Join-Path $env:TEMP 'nssm-2.24.zip'
    $extractDir = Join-Path $env:TEMP 'nssm-2.24-extract'
    Write-Log '本机没有 nssm.exe，尝试从 nssm.cc 下载 2.24…' 'WARN'
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
        if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
        $candidate = Join-Path $extractDir 'nssm-2.24\win64\nssm.exe'
        if (-not (Test-Path -LiteralPath $candidate)) { $candidate = (Get-ChildItem -LiteralPath $extractDir -Recurse -Filter 'nssm.exe' | Where-Object { $_.FullName -like '*win64*' } | Select-Object -First 1).FullName }
        $dest = Join-Path $Root 'deploy\nssm.exe'
        Copy-Item -LiteralPath $candidate -Destination $dest -Force
        Write-Log "nssm 已放到 $dest" 'OK'
        return $dest
    } catch {
        Write-Log ("自动下载 nssm 失败：{0}" -f $_.Exception.Message) 'WARN'
        return $null
    } finally {
        $ProgressPreference = $oldProgress
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Nssm {
    param([string]$Nssm, [string[]]$Arguments)
    & $Nssm @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "nssm $($Arguments -join ' ') 失败（退出码 $LASTEXITCODE）" }
    $global:LASTEXITCODE = 0
}

if ($skipService) {
    Write-Log '未注册 Windows 服务（默认桌面一键启动；需要服务时加 -InstallService）' 'WARN'
} else {
    Write-Log "配置 NSSM 服务 $ServiceName"
    $nssmExe = Resolve-NssmPath -Preferred $NssmPath -Root $script:Root -NoDownload:$DryRun
    if ($null -eq $nssmExe) {
        if ($DryRun) {
            Write-Log '[dry-run] 未找到 nssm.exe，实际运行时会先尝试自动下载'
        } else {
            throw @'
找不到 nssm.exe，自动下载也失败。二选一后重跑：
  winget install --id NSSM.NSSM -e
  或手动下载 https://nssm.cc/download ，把 win64\nssm.exe 放到 deploy\nssm.exe
'@
        }
    } else {
        Write-Log "nssm：$nssmExe" 'OK'
    }

    $logDir = Join-Path $script:Root 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $outLog = Join-Path $logDir 'service.out.log'
    $errLog = Join-Path $logDir 'service.err.log'

    if ($DryRun) {
        Write-Log ("[dry-run] nssm install {0} `"{1}`"" -f $ServiceName, $nodeExe)
        Write-Log ("[dry-run] AppParameters=`"{0}`" AppDirectory=`"{1}`"" -f $entry, $script:Root)
        Write-Log ("[dry-run] 环境变量 NODE_ENV=production PORT={0} HOST={1} COOKIE_SECURE=auto" -f $Port, $ListenHost)
        Write-Log ("[dry-run] 日志 {0} / {1}，退出自动重启" -f $outLog, $errLog)
    } else {
        if ($null -eq $nssmExe) { throw '找不到 nssm.exe。' }
        $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Log "服务已存在（$($existing.Status)），重新配置"
            if ($existing.Status -ne 'Stopped') {
                Stop-Service -Name $ServiceName -Force
                $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
                Write-Log '旧实例已停止'
            }
            Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'Application', $nodeExe)
        } else {
            Invoke-Nssm -Nssm $nssmExe -Arguments @('install', $ServiceName, $nodeExe)
            Write-Log '服务已创建'
        }
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppParameters', ('"' + $entry + '"'))
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppDirectory', $script:Root)
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'DisplayName', '学生状态管理系统')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'Description', '学生状态管理系统：Fastify + SQLite，0.0.0.0 + COOKIE_SECURE=auto，手动启动。')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'Start', 'SERVICE_DEMAND_START')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppEnvironmentExtra', 'NODE_ENV=production', ('PORT=' + $Port), ('HOST=' + $ListenHost), 'COOKIE_SECURE=auto')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppStdout', $outLog)
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppStderr', $errLog)
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppRotateFiles', '1')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppRotateOnline', '1')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppRotateBytes', '10485760')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppRestartDelay', '3000')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppThrottle', '5000')
        Invoke-Nssm -Nssm $nssmExe -Arguments @('set', $ServiceName, 'AppStopMethodConsole', '15000')
        Write-Log '服务参数写入完成（自启 / 崩溃重启 / 日志轮转 / 环境变量）' 'OK'

        try {
            Start-Service -Name $ServiceName
            Write-Log "服务状态：$((Get-Service -Name $ServiceName).Status)" 'OK'
        } catch {
            Write-Log ("服务启动失败：{0}，看 {1}" -f $_.Exception.Message, $errLog) 'WARN'
        }
    }
}

# ---------------------------------------------------------------- Tailscale
function Get-TailscaleExe {
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @('C:\Program Files\Tailscale\tailscale.exe', 'C:\Program Files (x86)\Tailscale\tailscale.exe')) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

$phoneUrl = $null
if ($SkipTailscale) {
    Write-Log '跳过 Tailscale（-SkipTailscale）' 'WARN'
} else {
    Write-Log '检测 Tailscale'
    $tsExe = Get-TailscaleExe
    if ($null -eq $tsExe) {
        Write-Log '未安装 Tailscale：手机跨网访问会不可用。安装脚本不会自动下载/安装 Tailscale。' 'WARN'
        Write-Log '装好后再跑：https://tailscale.com/download/windows  然后 tailscale serve --bg http://127.0.0.1:3210' 'WARN'
    } elseif ($DryRun) {
        Write-Log ("[dry-run] tailscale serve --bg http://127.0.0.1:{0}" -f $Port)
    } else {
        $tsStatus = (& $tsExe status 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0 -or $tsStatus -match 'Logged out|not logged in|NeedsLogin') {
            Write-Log 'Tailscale 未登录：先执行 tailscale up 登录同一 tailnet，再跑本脚本。' 'WARN'
        } else {
            Write-Log '配置 tailscale serve'
            & $tsExe serve --bg ("http://127.0.0.1:{0}" -f $Port) | Out-Host
            $serveCode = $LASTEXITCODE
            if ($serveCode -ne 0) {
                Write-Log 'tailscale serve 失败：去 https://login.tailscale.com/admin/dns 开启 HTTPS Certificates 后重试。' 'WARN'
            } else {
                Write-Log 'tailscale serve 已后台常驻' 'OK'
            }
            try {
                $json = & $tsExe status --json | Out-String | ConvertFrom-Json
                if ($json.Self.DNSName) { $phoneUrl = 'https://' + ([string]$json.Self.DNSName).TrimEnd('.') }
            } catch { }
        }
    }
}

# ---------------------------------------------------------------- 备份任务
function Register-BackupTask {
    param([string]$Root, [string]$NodeExe, [string]$TaskName = 'StudentBoard-Backup')
    $backupJs = Join-Path $Root 'scripts\backup.js'
    if (-not (Test-Path -LiteralPath $backupJs)) { throw "找不到备份脚本：$backupJs" }
    $logDir = Join-Path $Root 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $logFile = Join-Path $logDir 'backup.log'
    $cmdArgs = '/c ""{0}" "{1}" --keep 7 >> "{2}" 2>&1"' -f $NodeExe, $backupJs, $logFile
    $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument $cmdArgs -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -Daily -At '03:00'
    $userId = "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    return (Get-ScheduledTaskInfo -TaskName $TaskName)
}

if ($SkipBackupTask) {
    Write-Log '跳过备份任务（-SkipBackupTask）' 'WARN'
} elseif ($DryRun) {
    Write-Log ('[dry-run] 注册任务计划 StudentBoard-Backup：每天 03:00 执行 `"{0}`" `"{1}`" --keep 7' -f $nodeExe, (Join-Path $script:Root 'scripts\backup.js'))
} else {
    if (-not (Test-IsAdmin)) {
        Write-Log '不是管理员，无法注册备份任务（S4U 需要管理员）' 'WARN'
    } else {
        try {
            $info = Register-BackupTask -Root $script:Root -NodeExe $nodeExe
            Write-Log ("备份任务已注册，下次运行：{0}" -f $info.NextRunTime) 'OK'
        } catch {
            Write-Log ("备份任务注册失败：{0}" -f $_.Exception.Message) 'WARN'
        }
    }
}

# ---------------------------------------------------------------- 健康检查
if ($DryRun) {
    Write-Log '[dry-run] 跳过健康检查（没有真正启动服务）'
} elseif ($skipService) {
    # 没有服务：有现成实例就直接探活；没有就临时起一个进程冒烟，再关掉
    Write-Log "冒烟检查 /api/healthz（临时进程，最多 $HealthTimeoutSec 秒）"
    $healthy = $false
    try {
        $existing = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/healthz" -f $Port) -TimeoutSec 3
        if ($existing.ok) {
            $healthy = $true
            Write-Log '已有实例在运行，健康检查通过' 'OK'
        }
    } catch { }

    if (-not $healthy) {
        $smokeOut = Join-Path $script:Root 'logs\smoke.out.log'
        $smokeErr = Join-Path $script:Root 'logs\smoke.err.log'
        $env:HOST = $ListenHost
        $env:PORT = [string]$Port
        $env:COOKIE_SECURE = 'auto'
        $env:NODE_ENV = 'production'
        $proc = $null
        try {
            $proc = Start-Process -FilePath $nodeExe -ArgumentList 'server/index.js' `
                -WorkingDirectory $script:Root -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput $smokeOut -RedirectStandardError $smokeErr
            for ($i = 0; $i -lt $HealthTimeoutSec; $i++) {
                Start-Sleep -Seconds 1
                try {
                    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/healthz" -f $Port) -TimeoutSec 3
                    if ($health.ok) {
                        $healthy = $true
                        Write-Log ("冒烟检查通过：ok={0} db={1}" -f $health.ok, $health.db) 'OK'
                        break
                    }
                } catch { }
                if ($proc.HasExited) { break }
            }
        } catch {
            Write-Log ("临时进程启动失败：{0}" -f $_.Exception.Message) 'WARN'
        } finally {
            if ($proc -and -not $proc.HasExited) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                Write-Log '临时冒烟进程已停止' 'OK'
            }
        }
    }
    if (-not $healthy) {
        Write-Log ("冒烟检查未通过。看日志：{0}" -f (Join-Path $script:Root 'logs\smoke.err.log')) 'WARN'
    }
} else {
    Write-Log "健康检查 /api/healthz（最多 $HealthTimeoutSec 秒）"
    $healthy = $false
    for ($i = 0; $i -lt $HealthTimeoutSec; $i++) {
        Start-Sleep -Seconds 1
        try {
            $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/healthz" -f $Port) -TimeoutSec 3
            if ($health.ok) {
                $healthy = $true
                Write-Log ("健康检查通过：ok={0} db={1}" -f $health.ok, $health.db) 'OK'
                break
            }
        } catch { }
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Stopped') { Write-Log '服务已停止，健康检查放弃' 'WARN'; break }
    }
    if (-not $healthy) {
        Write-Log ("健康检查未通过。看日志：{0}" -f (Join-Path $script:Root 'logs\service.err.log')) 'WARN'
    }
}

# ---------------------------------------------------------------- 收尾
Write-Host ''
Write-Host '---------------- 部署结果 ----------------' -ForegroundColor Cyan
if ($skipService) { Write-Host '  启动  ：桌面「学生状态管理系统」快捷方式（双击启动，不开机自启）' }
else { Write-Host ("  服务名：{0}（手动启动，不开机自启）" -f $ServiceName) }
Write-Host ("  本机  ：http://127.0.0.1:{0}" -f $Port)
if ($ListenHost -eq '0.0.0.0') { Write-Host ("  局域网：http://<本机局域网IP>:{0}（同一 Wi-Fi 可用）" -f $Port) }
if ($phoneUrl) { Write-Host ("  手机  ：{0}" -f $phoneUrl) -ForegroundColor Green }
else { Write-Host '  手机  ：装 Tailscale 并登录后执行 deploy\tailscale-serve.ps1 获取地址' }
Write-Host ("  日志  ：{0}" -f (Join-Path $script:Root 'logs'))
$guidePath = Join-Path $script:Root '部署说明.md'
if (-not (Test-Path -LiteralPath $guidePath)) { $guidePath = Join-Path $script:Root 'docs\部署说明.md' }
if (Test-Path -LiteralPath $guidePath) { Write-Host ("  部署说明：{0}" -f $guidePath) }
Write-Host ("  安装日志：{0}" -f $script:LogFile)
Write-Host '------------------------------------------' -ForegroundColor Cyan
Write-Log '================ install 结束 ================' 'OK'
exit 0
