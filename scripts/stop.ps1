param(
  [int]$Port = 3210
)

$ErrorActionPreference = 'SilentlyContinue'

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Write-Host "服务没有在运行（端口 $Port 空闲）。"
  exit 1
}

$targetPid = $conn.OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
if ($proc -and $proc.CommandLine -match 'server[\\/]index\.js') {
  Stop-Process -Id $targetPid -Force
  Write-Host "服务已停止（PID $targetPid）。"
  exit 0
}

Write-Host "端口 $Port 被其他程序占用，没有执行停止操作。"
exit 1
