<#
.SYNOPSIS
    发布包 / 更新链路自测（不碰真实 data，不注册服务）。

.DESCRIPTION
    跑这些检查：
      1. 调 scripts\package-release.ps1 生成 release 包（-SkipPackage 可跳过）
      2. 校验 release\version.json 里 zip 的 sha256、大小
      3. 解压 zip，逐文件核对 version.json 的 files_sha256；确认没有 data\ / logs\
      4. scripts\update.ps1 -SelfTest（semver 比较、包根识别）
      5. 端到端：把发布包复制到临时目录当“旧版本 0.9.0”，构造 1.1.0 更新包，
         用 update.ps1 -NoService 跑完整替换，检查版本、data 保留、备份目录
      6. 回滚：构造一个能通过 hash 校验但启动即退出的 1.1.1 包，
         期望 update.ps1 退出码 1 且程序回滚到 1.1.0
      7. 篡改拦截：给 zip 配一个错误的 sha256，期望更新在落盘前被拒绝

    全部在 %TEMP% 下的临时目录里做，不写真实 data、不动 Windows 服务。

.PARAMETER SkipPackage
    跳过重新打包（直接拿现有 release 目录测）。

.PARAMETER KeepTemp
    保留临时目录，方便看现场。

.PARAMETER HealthTimeoutSec
    每次探活等待秒数，默认 20。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\deploy\self-test.ps1
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipPackage,
    [switch]$KeepTemp,
    [int]$HealthTimeoutSec = 20
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

$Root = Split-Path -Parent $PSScriptRoot
$script:Fail = 0
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step { param([string]$Text) Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Assert-True {
    param([bool]$Condition, [string]$Name)
    if ($Condition) { Write-Host "  [PASS] $Name" -ForegroundColor Green }
    else { $script:Fail++; Write-Host "  [FAIL] $Name" -ForegroundColor Red }
}
function Get-Sha256 { param([string]$Path) return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Invoke-Robocopy {
    param([string]$Source, [string]$Destination)
    & robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（$LASTEXITCODE）：$Source → $Destination" }
    $global:LASTEXITCODE = 0
}

function Get-FreePort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $p = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $p
}

function Get-FileHashMap {
    param([string]$PkgRoot)
    $base = [System.IO.Path]::GetFullPath($PkgRoot).TrimEnd('\') + '\'
    $nm = [System.IO.Path]::GetFullPath((Join-Path $PkgRoot 'node_modules')).TrimEnd('\') + '\'
    $map = [ordered]@{}
    $files = Get-ChildItem -LiteralPath $PkgRoot -Recurse -File | Where-Object {
        (-not $_.FullName.StartsWith($nm, [System.StringComparison]::OrdinalIgnoreCase)) -and ($_.Name -ne 'version.json')
    }
    foreach ($f in ($files | Sort-Object FullName)) {
        $rel = $f.FullName.Substring($base.Length).Replace('\', '/')
        $map[$rel] = Get-Sha256 $f.FullName
    }
    return $map
}

function Set-PackageVersion {
    param([string]$PkgRoot, [string]$Version, [switch]$RecalcHashes)
    $path = Join-Path $PkgRoot 'version.json'
    $obj = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $obj.version = $Version
    $obj.built_at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    if ($RecalcHashes) { $obj.files_sha256 = Get-FileHashMap -PkgRoot $PkgRoot }
    $json = $obj | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($path, $json, $utf8NoBom)
}

function New-PackageZip {
    param([string]$SourceDir, [string]$ZipPath)
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($SourceDir, $ZipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
}

function New-ReleaseManifest {
    param([string]$ZipPath, [string]$Version, [string]$OutPath)
    $item = Get-Item -LiteralPath $ZipPath
    $manifest = [ordered]@{
        name     = 'student-status-board'
        version  = $Version
        node     = '>=22'
        built_at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        zip      = [ordered]@{
            file   = $item.Name
            size   = $item.Length
            sha256 = (Get-Sha256 $ZipPath)
        }
    }
    [System.IO.File]::WriteAllText($OutPath, ($manifest | ConvertTo-Json -Depth 5), $utf8NoBom)
}

function Invoke-UpdateScript {
    param(
        [string]$ProjectRoot,
        [string]$Package,
        [string]$VersionFile,
        [int]$Port,
        [switch]$Force,
        [switch]$LocalOnly
    )
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'scripts\update.ps1'),
        '-ProjectRoot', $ProjectRoot, '-NoService', '-StopAfterCheck', '-Port', $Port, '-HealthTimeoutSec', $HealthTimeoutSec)
    if ($Package) { $argList += @('-PackagePath', $Package) }
    if ($VersionFile) { $argList += @('-VersionFile', $VersionFile) }
    if ($Force) { $argList += '-Force' }
    if ($LocalOnly) { $argList += '-LocalOnly' }
    & powershell.exe @argList | Out-Host
    return $LASTEXITCODE
}

Write-Host '学生状态管理系统 · 发布/更新自测' -ForegroundColor Cyan
Write-Host "项目根：$Root"

# ================================================================ 1. 打包
Write-Step '1. 生成发布包'
if (-not $SkipPackage) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\package-release.ps1')
    Assert-True ($LASTEXITCODE -eq 0) 'package-release.ps1 退出码 0'
} else {
    Write-Host '  跳过打包（-SkipPackage）'
}

# ================================================================ 2. release 清单
Write-Step '2. release\version.json 与 zip'
$relDir = Join-Path $Root 'release'
$manifestPath = Join-Path $relDir 'version.json'
Assert-True (Test-Path -LiteralPath $manifestPath) 'release\version.json 存在'
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Host '没有发布清单，后续测试跳过' -ForegroundColor Red; exit 1 }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$zipPath = Join-Path $relDir ([string]$manifest.zip.file)
Assert-True (Test-Path -LiteralPath $zipPath) '发布 zip 存在'
Assert-True ((Get-Sha256 $zipPath) -eq [string]$manifest.zip.sha256) 'zip sha256 与清单一致'
Assert-True ((Get-Item -LiteralPath $zipPath).Length -eq [long]$manifest.zip.size) 'zip 大小与清单一致'
Write-Host ("  版本 {0}，zip {1:N1} MB" -f $manifest.version, ((Get-Item $zipPath).Length / 1MB))

# ================================================================ 3. 解压校验
Write-Step '3. 解压并核对 files_sha256'
$T = Join-Path $env:TEMP ('ssb-selftest-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $T -Force | Out-Null
$extract = Join-Path $T 'extract'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extract, [System.Text.Encoding]::UTF8)
$pkgRoot = $null
foreach ($d in (Get-ChildItem -LiteralPath $extract -Directory)) {
    if ((Test-Path (Join-Path $d.FullName 'version.json')) -and (Test-Path (Join-Path $d.FullName 'server\index.js'))) { $pkgRoot = $d.FullName; break }
}
if ($null -eq $pkgRoot -and (Test-Path (Join-Path $extract 'version.json'))) { $pkgRoot = $extract }
Assert-True ($null -ne $pkgRoot) 'zip 内找到包根（version.json + server\index.js）'
$inner = Get-Content -LiteralPath (Join-Path $pkgRoot 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$badCount = 0
$total = 0
foreach ($prop in $inner.files_sha256.PSObject.Properties) {
    $total++
    $file = Join-Path $pkgRoot ([string]$prop.Name).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $file)) { $badCount++; continue }
    if ((Get-Sha256 $file) -ne ([string]$prop.Value).ToLowerInvariant()) { $badCount++ }
}
Assert-True ($total -gt 0) ("files_sha256 非空（{0} 个文件）" -f $total)
Assert-True ($badCount -eq 0) '逐文件 sha256 全部匹配'
Assert-True (Test-Path (Join-Path $pkgRoot 'web\dist\index.html')) '包含 web\dist\index.html'
Assert-True (-not (Test-Path (Join-Path $pkgRoot 'data'))) '不包含 data\'
Assert-True (-not (Test-Path (Join-Path $pkgRoot 'logs'))) '不包含 logs\'
Assert-True (Test-Path (Join-Path $pkgRoot 'node_modules\better-sqlite3')) '包含生产依赖 better-sqlite3'
Assert-True (-not (Test-Path (Join-Path $pkgRoot 'node_modules\vite'))) '不含 dev 依赖 vite'

# ================================================================ 4. update 自测
Write-Step '4. update.ps1 -SelfTest（semver / 包根）'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\update.ps1') -SelfTest
Assert-True ($LASTEXITCODE -eq 0) 'SelfTest 退出码 0'

# ================================================================ 5. 端到端更新
Write-Step '5. 端到端：0.9.0 → 1.1.0 正常更新'
$sandbox = Join-Path $T 'app'
Invoke-Robocopy -Source $pkgRoot -Destination $sandbox
Set-PackageVersion -PkgRoot $sandbox -Version '0.9.0'
New-Item -ItemType Directory -Path (Join-Path $sandbox 'data') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $sandbox 'data\marker.txt') -Value 'KEEP-ME' -Encoding UTF8
New-Item -ItemType Directory -Path (Join-Path $sandbox 'logs') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $sandbox 'logs\marker.log') -Value 'KEEP-LOG' -Encoding UTF8

$newPkgDir = Join-Path $T 'newpkg\student-status-board-1.1.0'
Invoke-Robocopy -Source $pkgRoot -Destination $newPkgDir
Set-PackageVersion -PkgRoot $newPkgDir -Version '1.1.0'
$newZip = Join-Path $T 'student-status-board-1.1.0.zip'
New-PackageZip -SourceDir $newPkgDir -ZipPath $newZip
$newManifest = Join-Path $T 'new-version.json'
New-ReleaseManifest -ZipPath $newZip -Version '1.1.0' -OutPath $newManifest

# 走真实的手动更新通道：把 zip + version.json 放进 updates\，用 -LocalOnly
$sandboxUpdates = Join-Path $sandbox 'updates'
New-Item -ItemType Directory -Path $sandboxUpdates -Force | Out-Null
Copy-Item -LiteralPath $newZip -Destination (Join-Path $sandboxUpdates 'student-status-board-1.1.0.zip') -Force
Copy-Item -LiteralPath $newManifest -Destination (Join-Path $sandboxUpdates 'version.json') -Force

$port1 = Get-FreePort
$code = Invoke-UpdateScript -ProjectRoot $sandbox -Port $port1 -LocalOnly
Assert-True ($code -eq 0) "update.ps1 正常更新退出码 0（实际 $code）"
$afterV = (Get-Content -LiteralPath (Join-Path $sandbox 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Assert-True ([string]$afterV -eq '1.1.0') "版本已变为 1.1.0（实际 $afterV）"
Assert-True ((Test-Path (Join-Path $sandbox 'data\marker.txt')) -and ((Get-Content -LiteralPath (Join-Path $sandbox 'data\marker.txt') -Raw) -match 'KEEP-ME')) 'data\ 未被更新影响'
Assert-True (Test-Path (Join-Path $sandbox 'logs\marker.log')) 'logs\ 未被更新影响'
$backupDirs = @(Get-ChildItem -LiteralPath (Join-Path $sandbox 'backups') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'app-0.9.0*' })
Assert-True ($backupDirs.Count -ge 1) '生成了 backups\app-0.9.0 备份'

# ================================================================ 6. 回滚
Write-Step '6. 回滚：1.1.0 → 坏的 1.1.1（启动即退出）'
$badDir = Join-Path $T 'badpkg\student-status-board-1.1.1'
Invoke-Robocopy -Source $pkgRoot -Destination $badDir
Set-PackageVersion -PkgRoot $badDir -Version '1.1.1'
Set-Content -LiteralPath (Join-Path $badDir 'server\index.js') -Value "console.error('intentional boot failure'); process.exit(7);" -Encoding UTF8
$badObj = Get-Content -LiteralPath (Join-Path $badDir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$badObj.version = '1.1.1'
$badObj.files_sha256 = Get-FileHashMap -PkgRoot $badDir
[System.IO.File]::WriteAllText((Join-Path $badDir 'version.json'), ($badObj | ConvertTo-Json -Depth 6), $utf8NoBom)
$badZip = Join-Path $T 'student-status-board-1.1.1.zip'
New-PackageZip -SourceDir $badDir -ZipPath $badZip
$badManifest = Join-Path $T 'bad-version.json'
New-ReleaseManifest -ZipPath $badZip -Version '1.1.1' -OutPath $badManifest

$port2 = Get-FreePort
$code2 = Invoke-UpdateScript -ProjectRoot $sandbox -Package $badZip -VersionFile $badManifest -Port $port2
Assert-True ($code2 -eq 1) "坏包更新退出码 1（实际 $code2）"
$afterV2 = (Get-Content -LiteralPath (Join-Path $sandbox 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Assert-True ([string]$afterV2 -eq '1.1.0') "回滚后版本回到 1.1.0（实际 $afterV2）"
Assert-True (Test-Path (Join-Path $sandbox 'data\marker.txt')) '回滚后 data\ 仍在'
$rbLog = Get-Content -LiteralPath (Join-Path $sandbox 'logs\update.log') -Raw -Encoding UTF8
Assert-True ($rbLog -match '开始回滚') 'update.log 记录了回滚'

# ================================================================ 7. sha256 拦截
Write-Step '7. sha256 不匹配必须拒绝'
$tamperManifest = Join-Path $T 'tamper-version.json'
$obj = [ordered]@{
    name     = 'student-status-board'
    version  = '1.1.2'
    node     = '>=22'
    built_at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    zip      = [ordered]@{ file = (Split-Path -Leaf $newZip); size = (Get-Item $newZip).Length; sha256 = ('0' * 64) }
}
[System.IO.File]::WriteAllText($tamperManifest, ($obj | ConvertTo-Json -Depth 5), $utf8NoBom)
$port3 = Get-FreePort
$code3 = Invoke-UpdateScript -ProjectRoot $sandbox -Package $newZip -VersionFile $tamperManifest -Port $port3 -Force
Assert-True ($code3 -eq 1) "sha256 不匹配退出码 1（实际 $code3）"
$afterV3 = (Get-Content -LiteralPath (Join-Path $sandbox 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Assert-True ([string]$afterV3 -eq '1.1.0') 'sha256 拦截后版本未变'

# ================================================================ 结果
Write-Host ''
if ($script:Fail -eq 0) {
    Write-Host '自测全部通过' -ForegroundColor Green
} else {
    Write-Host ("自测失败：{0} 项" -f $script:Fail) -ForegroundColor Red
}
Write-Host "临时目录：$T"
if (-not $KeepTemp) { Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host '（-KeepTemp 保留）' }
if ($script:Fail -gt 0) { exit 1 }
exit 0
