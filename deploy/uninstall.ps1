<#
.SYNOPSIS
    卸载「学生状态管理系统」Windows 服务：停服务 → nssm remove → 保留 data。

.DESCRIPTION
    默认只删服务和自启项，不碰数据：
      - 停止并删除 NSSM 服务 StudentBoard
      - 默认顺带删除每日备份任务 StudentBoard-Backup（-KeepBackupTask 可保留）
      - data\ 永远保留（要连同数据一起删，必须显式 -PurgeData 并输入 DELETE）
      - logs\ 默认保留，-RemoveLogs 才删
      - runtime\ 默认保留，-RemoveRuntime 才删（下次安装会复用）
      - Tailscale serve 规则默认不动，-ResetTailscale 才清

    需要管理员权限；没有会自动请求提权。

.PARAMETER ServiceName
    服务名，默认 StudentBoard。

.PARAMETER NssmPath
    nssm.exe 路径；找不到时退回 sc.exe delete。

.PARAMETER ProjectRoot
    项目根目录，默认本脚本上一级。

.PARAMETER Force
    不再交互确认（适合脚本调用）。

.PARAMETER KeepBackupTask
    保留每日备份任务。

.PARAMETER RemoveLogs
    删掉 logs\ 目录。

.PARAMETER RemoveRuntime
    删掉 runtime\（安装时下载的 Node）。

.PARAMETER ResetTailscale
    执行 tailscale serve reset，清掉本机所有 serve 规则。

.PARAMETER PurgeData
    连 data\ 一起删（全量学生数据 + 密码哈希），会二次确认。

.PARAMETER NoElevate
    无管理员权限时不自动提权（测试用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\uninstall.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\uninstall.ps1 -Force -RemoveLogs
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ServiceName = 'StudentBoard',
    [string]$NssmPath,
    [string]$ProjectRoot,
    [switch]$Force,
    [switch]$KeepBackupTask,
    [switch]$RemoveLogs,
    [switch]$RemoveRuntime,
    [switch]$ResetTailscale,
    [switch]$PurgeData,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  ok  $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "  ..  $Text" -ForegroundColor DarkGray }
function Write-Warn2 { param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 管理员
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($NoElevate) {
        Write-Warn2 '当前不是管理员（-NoElevate）：删除服务会失败，仅继续处理文件/任务。'
    } else {
        Write-Step '需要管理员权限，正在请求提权'
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
            throw '提权被取消：请右键「以管理员身份运行」PowerShell 后重试。'
        }
        if ($elevated) { $elevated.WaitForExit(); exit $elevated.ExitCode }
        exit 1
    }
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
Write-Step "项目根：$ProjectRoot"

if (-not $Force) {
    Write-Host ''
    Write-Host '将执行：停止并删除服务、删除每日备份任务；data\ 数据会保留。' -ForegroundColor Yellow
    $answer = Read-Host '确认卸载？输入 yes 继续'
    if ($answer -ne 'yes') { Write-Host '已取消。' -ForegroundColor DarkGray; return }
}

# ---------------------------------------------------------------- 停止服务
Write-Step "停止服务 $ServiceName"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
        try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { }
        Write-Ok '已停止'
    } else { Write-Ok '服务本来就是停止状态' }
} else {
    Write-Warn2 "服务 $ServiceName 不存在（可能已卸载）"
}

# ---------------------------------------------------------------- 删除服务
Write-Step '从服务表移除'
$nssmExe = $null
if (-not [string]::IsNullOrWhiteSpace($NssmPath)) {
    if (Test-Path -LiteralPath $NssmPath) { $nssmExe = (Resolve-Path -LiteralPath $NssmPath).Path }
} else {
    $cmd = Get-Command nssm -ErrorAction SilentlyContinue
    if ($cmd) { $nssmExe = $cmd.Source }
    if ($null -eq $nssmExe) {
        foreach ($c in @((Join-Path $PSScriptRoot 'nssm.exe'), 'C:\Program Files\nssm\nssm.exe', 'C:\Program Files (x86)\nssm\nssm.exe', 'C:\nssm\nssm.exe', 'E:\nssm\nssm.exe')) {
            if (Test-Path -LiteralPath $c) { $nssmExe = (Resolve-Path -LiteralPath $c).Path; break }
        }
    }
}

$removed = $false
if ($svc -and $null -ne $nssmExe) {
    & $nssmExe remove $ServiceName confirm | Out-Host
    if ($LASTEXITCODE -eq 0) { $removed = $true } else { Write-Warn2 "nssm remove 退出码 $LASTEXITCODE，改用 sc.exe" }
}
if ($svc -and -not $removed) {
    & sc.exe delete $ServiceName | Out-Host
    if ($LASTEXITCODE -eq 0) { $removed = $true } else { Write-Warn2 "sc.exe delete 退出码 $LASTEXITCODE" }
}
Start-Sleep -Milliseconds 800
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Warn2 "服务仍在，请在「服务」管理器确认，或重启后再试。"
} elseif ($svc) {
    Write-Ok "服务 $ServiceName 已删除"
}

# ---------------------------------------------------------------- 备份任务
if (-not $KeepBackupTask) {
    Write-Step '删除每日备份任务 StudentBoard-Backup'
    $task = Get-ScheduledTask -TaskName 'StudentBoard-Backup' -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName 'StudentBoard-Backup' -Confirm:$false
        Write-Ok '已删除（已生成的备份文件不删）'
    } else { Write-Note '任务不存在，跳过' }
} else { Write-Note '保留备份任务（-KeepBackupTask）' }

# ---------------------------------------------------------------- Tailscale
if ($ResetTailscale) {
    Write-Step '清理 tailscale serve 规则'
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
        & $ts.Source serve reset | Out-Host
        Write-Ok '已 reset'
    } else { Write-Warn2 '找不到 tailscale.exe' }
} else { Write-Note 'Tailscale serve 规则未动（要清用 -ResetTailscale）' }

# ---------------------------------------------------------------- 桌面快捷方式
Write-Step '删除桌面快捷方式'
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '学生状态管理系统.lnk'
if (Test-Path -LiteralPath $desktopLnk) {
    Remove-Item -LiteralPath $desktopLnk -Force
    Write-Ok "已删除 $desktopLnk"
} else { Write-Note '快捷方式不存在，跳过' }

# ---------------------------------------------------------------- 可选删除
if ($RemoveLogs) {
    $logDir = Join-Path $ProjectRoot 'logs'
    if (Test-Path -LiteralPath $logDir) { Remove-Item -LiteralPath $logDir -Recurse -Force; Write-Ok "已删除 $logDir" }
}
if ($RemoveRuntime) {
    $runtimeDir = Join-Path $ProjectRoot 'runtime'
    if (Test-Path -LiteralPath $runtimeDir) { Remove-Item -LiteralPath $runtimeDir -Recurse -Force; Write-Ok "已删除 $runtimeDir" }
}

if ($PurgeData) {
    Write-Host ''
    Write-Host '!!! -PurgeData：会永久删除 data\（全部学生数据 + 密码哈希）' -ForegroundColor Red
    $answer2 = Read-Host '输入 DELETE 确认'
    if ($answer2 -eq 'DELETE') {
        $dataDir = Join-Path $ProjectRoot 'data'
        if (Test-Path -LiteralPath $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force; Write-Ok "已删除 $dataDir" }
    } else {
        Write-Warn2 '输入不匹配，数据未删除'
    }
} else {
    Write-Step '保留数据目录'
    Write-Ok ('data\ 原样保留：' + (Join-Path $ProjectRoot 'data'))
}

Write-Host ''
Write-Host '卸载完成。程序文件还在，要彻底清理直接删整个目录即可（先确认 data\ 已备份）。' -ForegroundColor DarkGray
exit 0
