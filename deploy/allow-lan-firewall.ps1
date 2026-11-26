param(
  [int]$Port = 3210
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $scriptPath = $MyInvocation.MyCommand.Path
  Write-Host '需要管理员权限，正在弹出 UAC 确认…'
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$scriptPath`"",
    '-Port', $Port
  )
  exit 0
}

$ruleName = "学生状态管理系统 LAN TCP $Port"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Any `
  -RemoteAddress LocalSubnet `
  -Description '允许同一局域网设备访问学生状态管理系统（仅本地子网）' | Out-Null

Write-Host "已放行防火墙：TCP $Port，仅限本地子网。"
Write-Host '现在可以用手机访问电脑的局域网地址了。'
Read-Host '按回车关闭'
