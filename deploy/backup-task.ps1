<#
.SYNOPSIS
    注册 Windows 任务计划：每天 03:00 备份 SQLite，保留最近 7 份。

.DESCRIPTION
    为什么要任务计划而不是服务内置定时：备份要能独立于 Node 进程运行，服务挂了照样有备份；
    任务计划程序还能「错过了补跑」（StartWhenAvailable）。

    实际动作（写成一条 cmd 命令行，输出追加到 logs\backup.log）：
        "<npm.cmd>" run backup [-- --keep N --out "<备份目录>"] >> "<项目根>\logs\backup.log" 2>&1

    默认就是 `npm run backup`（package.json 里 backup = `node scripts/backup.js --keep 7`）；
    只有 -Keep 不是 7 或指定了 -BackupDir 时，才在 `--` 后面把参数透传给 scripts/backup.js。
    用 npm.cmd 而不是 npm：本机执行策略会拦 npm.ps1；任务里走 cmd /c 绕开。

    备份文件默认写到 data\backups\（可用 -BackupDir 改），走 SQLite 在线备份 API，
    WAL 模式下也是安全一致的快照，不用停服务。

    任务以当前用户 S4U 身份运行：不保存密码，也不需要一直登录着桌面；注册需要管理员权限。

.PARAMETER TaskName
    任务名，默认 StudentBoard-Backup。

.PARAMETER Time
    每天几点跑，24 小时制 HH:mm，默认 03:00。

.PARAMETER ProjectRoot
    项目根目录，默认本脚本的上一级。任务的工作目录就是它。

.PARAMETER Keep
    保留份数，默认 7，透传给 backup.js 的 --keep。

.PARAMETER BackupDir
    备份输出目录，透传给 --out。默认不传，用 backup.js 自己的默认值（data\backups）。
    建议指向第二块盘，跟系统盘分开。

.PARAMETER NpmPath
    npm.cmd 完整路径，默认 Get-Command npm.cmd，其次 node 同目录下的 npm.cmd。

.PARAMETER Unregister
    反过来，删掉这个任务计划。

.PARAMETER RunNow
    注册完立刻跑一次，验证能备份成功。

.EXAMPLE
    .\deploy\backup-task.ps1

.EXAMPLE
    .\deploy\backup-task.ps1 -Time 03:30 -Keep 7 -RunNow

.EXAMPLE
    .\deploy\backup-task.ps1 -Keep 14 -BackupDir "E:\studentboard-backup"

.EXAMPLE
    .\deploy\backup-task.ps1 -Unregister
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$TaskName = 'StudentBoard-Backup',
    [string]$Time = '03:00',
    [string]$ProjectRoot,
    [int]$Keep = 7,
    [string]$BackupDir,
    [string]$NpmPath,
    [switch]$Unregister,
    [switch]$RunNow
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  ok  $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "  ..  $Text" -ForegroundColor DarkGray }
function Write-Warn2{ param([string]$Text) Write-Host "  !!  $Text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 管理员（S4U + Highest 需要）
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warn2 '当前不是管理员：任务会退化成普通权限（S4U 需要管理员）。建议右键「以管理员身份运行」重跑。'
}

# ---------------------------------------------------------------- 项目根
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
Write-Step "项目根：$ProjectRoot"

# ---------------------------------------------------------------- 卸载
if ($Unregister) {
    Write-Step "删除任务计划 $TaskName"
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Warn2 "任务 $TaskName 不存在"; return }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok '已删除（已生成的备份文件不删）'
    return
}

# ---------------------------------------------------------------- 备份脚本存在性
$backupScript = Join-Path $ProjectRoot 'scripts\backup.js'
if (-not (Test-Path -LiteralPath $backupScript)) {
    Write-Warn2 "找不到 $backupScript —— 任务照样注册，但今晚跑之前要有这个文件，否则任务会失败。"
}

# ---------------------------------------------------------------- npm.cmd
Write-Step '定位 npm.cmd'
if ([string]::IsNullOrWhiteSpace($NpmPath)) {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { $NpmPath = $cmd.Source }
}
if ([string]::IsNullOrWhiteSpace($NpmPath)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $candidate = Join-Path (Split-Path -Parent $nodeCmd.Source) 'npm.cmd'
        if (Test-Path -LiteralPath $candidate) { $NpmPath = $candidate }
    }
}
if ([string]::IsNullOrWhiteSpace($NpmPath) -or -not (Test-Path -LiteralPath $NpmPath)) {
    throw '找不到 npm.cmd：用 -NpmPath "C:\Program Files\nodejs\npm.cmd" 指定。'
}
$NpmPath = (Resolve-Path -LiteralPath $NpmPath).Path
Write-Ok $NpmPath

# ---------------------------------------------------------------- 参数校验
try {
    $at = [datetime]::ParseExact($Time, 'HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
}
catch {
    throw "时间格式不对：-Time 要 HH:mm（24 小时制），例如 03:00，收到的是 `"$Time`"。"
}
if ($Keep -lt 1 -or $Keep -gt 60) { throw "-Keep 取值 1~60，收到 $Keep。" }

# ---------------------------------------------------------------- 日志目录
$logDir = Join-Path $ProjectRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'backup.log'

# ---------------------------------------------------------------- 组装动作
$npmArgs = 'run backup'
$forward = @()
if ($Keep -ne 7) { $forward += "--keep $Keep" }
if (-not [string]::IsNullOrWhiteSpace($BackupDir)) { $forward += ('--out "{0}"' -f $BackupDir) }
if ($forward.Count -gt 0) { $npmArgs += ' -- ' + ($forward -join ' ') }
# cmd /c 的双引号规则：整条带引号，内层路径各自带引号
$cmdArgs = '/c ""{0}" {1} >> "{2}" 2>&1"' -f $NpmPath, $npmArgs, $logFile
Write-Step "动作：$env:ComSpec $cmdArgs"

$action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument $cmdArgs -WorkingDirectory $ProjectRoot

# ---------------------------------------------------------------- 触发器 / 身份 / 设置
$trigger = New-ScheduledTaskTrigger -Daily -At $at

$userId = "$env:USERDOMAIN\$env:USERNAME"
if ($isAdmin) {
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Highest
}
else {
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
}

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

# ---------------------------------------------------------------- 注册
Write-Step "注册任务计划 $TaskName（每天 $($at.ToString('HH:mm'))，保留 $Keep 份）"
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $taskPrincipal -Settings $settings -Force | Out-Null
Write-Ok '已注册'

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Ok "下次运行：$($info.NextRunTime)"
Write-Note "日志：$logFile"

# ---------------------------------------------------------------- 立刻验证
if ($RunNow) {
    Write-Step '立刻跑一次验证'
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddMinutes(3)
    do {
        Start-Sleep -Seconds 2
        $state = (Get-ScheduledTask -TaskName $TaskName).State
    } while ($state -eq 'Running' -and (Get-Date) -lt $deadline)

    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    if ($info.LastTaskResult -eq 0) {
        Write-Ok '备份成功（LastTaskResult=0）'
    }
    else {
        Write-Warn2 "备份失败：LastTaskResult=$($info.LastTaskResult)"
        Write-Host "    看日志：Get-Content -Tail 40 `"$logFile`"" -ForegroundColor DarkGray
    }
    $backupPath = if ([string]::IsNullOrWhiteSpace($BackupDir)) { Join-Path $ProjectRoot 'data\backups' } else { $BackupDir }
    if (Test-Path -LiteralPath $backupPath) {
        $files = Get-ChildItem -LiteralPath $backupPath -File | Sort-Object LastWriteTime -Descending
        if ($files) {
            Write-Host '  最近备份：' -ForegroundColor DarkGray
            $files | Select-Object -First 8 Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime |
                Format-Table -AutoSize | Out-String -Width 200 | Write-Host
        }
    }
}

Write-Host ''
Write-Host '---------------- 常用命令 ----------------' -ForegroundColor Cyan
Write-Host "  查看状态：Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "  手动跑：  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  看日志：  Get-Content -Tail 40 `"$logFile`""
Write-Host "  删任务：  .\deploy\backup-task.ps1 -Unregister"
Write-Host '------------------------------------------' -ForegroundColor Cyan
