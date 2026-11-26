param(
  [int]$Port = 3210
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'logs\server.pid'

function Stop-ServerProcess {
  param([int]$TargetPid, [string]$Reason)
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction SilentlyContinue
  if ($proc -and $proc.CommandLine -match 'server[\\/]index\.js') {
    Stop-Process -Id $TargetPid -Force
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host "服务已停止（PID $TargetPid，$Reason）。"
    exit 0
  }
  return $false
}

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $result = Stop-ServerProcess -TargetPid ([int]$conn.OwningProcess) -Reason "端口 $Port"
  if ($result -eq $false) {
    Write-Host "端口 $Port 被其他程序占用，没有执行停止操作。"
    exit 1
  }
}

if (Test-Path -LiteralPath $pidFile) {
  $pidText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($pidText -match '^\d+$') {
    $result = Stop-ServerProcess -TargetPid ([int]$pidText) -Reason '记录的后台进程'
    if ($result -eq $false) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
  } else {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "服务没有在运行（端口 $Port 空闲）。"
exit 1
