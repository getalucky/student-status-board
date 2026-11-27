<#
.SYNOPSIS
    一键部署的交互层：检查目录 → 确认 → 提权 → 调 install.ps1 → 问要不要启动。

.DESCRIPTION
    被根目录的 一键部署.cmd 调用。放成 .ps1 而不是全写在 .cmd 里，是因为
    .cmd 在英文/沙盒系统上会被 chcp 65001 + 多字节字符搞乱解析（cmd 按字节读批处理，
    中途切代码页会让后面的行错位，冒出 "The filename, directory name, or volume label syntax is incorrect."）。
    PowerShell 读 UTF-8 BOM 文件不依赖控制台代码页，稳。

.PARAMETER AuthKey / 其余参数
    原样转给 deploy\install.ps1。
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$InstallArgs = @()
)

$ErrorActionPreference = 'Stop'
$script:Root = Split-Path -Parent $PSScriptRoot
$script:InstallScript = Join-Path $PSScriptRoot 'install.ps1'

function Write-Banner {
    param([string]$Text)
    Write-Host ''
    Write-Host ('   ' + ('=' * 46))
    Write-Host ('      ' + $Text)
    Write-Host ('   ' + ('=' * 46))
}

function Write-Line {
    param([string]$Text)
    Write-Host ('    ' + $Text)
}

function Test-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-YesNo {
    param([string]$Prompt, [bool]$DefaultYes = $true)
    $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $raw = Read-Host ('   ' + $Prompt + ' ' + $hint)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultYes }
        $v = $raw.Trim().ToLowerInvariant()
        if ($v -eq 'y' -or $v -eq 'yes') { return $true }
        if ($v -eq 'n' -or $v -eq 'no') { return $false }
        Write-Host '   请输入 Y 或 N。' -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------- 控制台编码
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }
try { & cmd /c 'chcp 65001 >nul' | Out-Null } catch { }

# ---------------------------------------------------------------- 1. 目录检查
if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'server\index.js'))) {
    Write-Host ''
    Write-Host '   [ 错误 ] 找不到程序文件（server\index.js）。' -ForegroundColor Red
    Write-Host ''
    Write-Line '你大概是在压缩包里直接双击的。请先：'
    Write-Line '  1. 右键 zip 文件 → 全部解压缩'
    Write-Line '  2. 进解压出来的文件夹，再双击 一键部署.cmd'
    Write-Host ''
    Write-Line '不要放在 OneDrive / 坚果云等同步目录里。'
    Write-Host ''
    exit 1
}

# 参数里带了 -DryRun / -NoElevate 就跳过提权（测试用）
$direct = $InstallArgs.Count -gt 0
$skipElevate = $false
foreach ($a in $InstallArgs) {
    if ($a -match '^-(DryRun|NoElevate)$') { $skipElevate = $true }
}

# ---------------------------------------------------------------- 2. 确认
if (-not $direct -and -not $skipElevate -and -not $env:SSB_CONFIRMED) {
    Write-Banner '学生状态管理系统 · 一键部署'
    if (Test-Path -LiteralPath (Join-Path $script:Root 'data\config.json')) {
        Write-Line '检测到已经部署过，本次按「修复 / 重新配置」处理。'
        Write-Line '已有数据、登录密码都不会被改动。'
    } else {
        Write-Line '首次部署：装依赖、设登录密码、建桌面快捷方式。'
        Write-Line '这台电脑没有 Node.js 时会先下载（约 30 MB，1-2 分钟）。'
    }
    Write-Host ('   ' + ('=' * 46))
    Write-Host ''
    if (-not (Read-YesNo -Prompt '开始部署？' -DefaultYes $true)) {
        Write-Host ''
        Write-Line '已取消，什么都没改。'
        Write-Host ''
        exit 1
    }
    # 提权后的子进程继承环境变量，别再问第二遍
    $env:SSB_CONFIRMED = '1'
    Write-Host ''
}

# ---------------------------------------------------------------- 3. 提权
if (-not $skipElevate -and -not (Test-Admin)) {
    Write-Line '需要管理员权限（装依赖、放行防火墙、注册备份任务）。'
    Write-Line '马上会弹 UAC 确认框，请点「是」。'
    Write-Host ''
    try {
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
        if ($direct) { $argList += $InstallArgs }
        Start-Process -FilePath 'powershell.exe' -ArgumentList ($argList -join ' ') -Verb RunAs | Out-Null
        exit 0
    } catch {
        Write-Host '   [ 失败 ] 提权被取消。也可以右键这个文件 →「以管理员身份运行」。' -ForegroundColor Red
        Write-Host ''
        exit 1
    }
}

# ---------------------------------------------------------------- 4. 干活
$installArgs2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $script:InstallScript + '"'))
if ($direct) { $installArgs2 += $InstallArgs }
& powershell.exe @installArgs2
$rc = $LASTEXITCODE

Write-Host ''
if ($rc -ne 0) {
    Write-Host ("   [ 失败 ] 部署没完成（退出码 {0}）。" -f $rc) -ForegroundColor Red
    Write-Line ("详细日志：" + (Join-Path $script:Root 'logs\install.log'))
    Write-Host ''
    exit $rc
}

Write-Host '   [ 成功 ] 部署完成。' -ForegroundColor Green
if ($direct) { exit 0 }
Write-Host ''

# ---------------------------------------------------------------- 5. 顺手启动
if (Read-YesNo -Prompt '现在启动服务？' -DefaultYes $true) {
    $env:SSB_NO_PAUSE = '1'
    & cmd.exe /c ('"' + (Join-Path $script:Root '学生状态管理系统.cmd') + '" /start')
    Write-Host ''
}

Write-Host ''
Write-Line '以后双击桌面「学生状态管理系统」就能用；'
Write-Line '也可以双击本目录的 学生状态管理系统.cmd 打开菜单。'
Write-Host ''
exit 0
