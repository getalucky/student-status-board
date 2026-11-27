<#
.SYNOPSIS
    打「学生状态管理系统」Windows 发布包（目录 + zip + release/version.json）。

.DESCRIPTION
    一次跑完：
      1. 构建前端（TEMP/TMP 指到 .tmp-build，绕开 esbuild 清临时文件被拦的坑）
      2. 在 release\student-status-board-<ver>\ 组装发布目录：
         server/  shared/  scripts/  tools/  deploy/  web/dist/  package.json  package-lock.json
         version.json  README.md  学生状态管理系统.cmd  tools\
      3. 装生产依赖：默认复制本机已验证的 node_modules 再 npm prune --omit=dev 剔除 dev；
         -FreshInstall 时改用 npm.cmd ci --omit=dev --ignore-scripts 全新安装。
         两条路都会在装完后真实 require 一次 better-sqlite3 / @node-rs/argon2 做自检。
      4. 写 version.json 的 files_sha256（不含 node_modules 与 version.json 自身）
      5. 冒烟：用发布目录起一次 server/index.js（DATA_DIR 指临时目录），请求 /api/healthz
      6. 压缩成 release\student-status-board-<ver>.zip（zip 内顶层目录 = 包名）
      7. 生成 release\version.json：版本 / 最低 Node / zip 的 sha256+大小 / 文件清单

    发布包不包含 data\、logs\、node_modules 里的 dev 包、.git、tests\ 等。

.PARAMETER Version
    版本号，默认取 version.json，其次 package.json。必须是 x.y.z。

.PARAMETER OutDir
    输出目录，默认 <项目根>\release。

.PARAMETER NodePath
    node.exe 路径，默认 PATH 里的 node，其次常见安装目录。

.PARAMETER SkipBuild
    跳过前端构建（web\dist 已是最新时用）。

.PARAMETER SkipInstall
    跳过依赖安装（release 目录里已经放好 node_modules 时用）。

.PARAMETER FreshInstall
    不复制本机 node_modules，改用 npm.cmd ci --omit=dev --ignore-scripts 全新安装。

.PARAMETER KeepAllPrebuilds
    保留 better-sqlite3 的所有平台预编译（默认只留 win32-x64 / win32-arm64，省 12MB+）。

.PARAMETER SkipVerify
    跳过原生模块自检与冒烟测试（不建议）。

.PARAMETER NoZip
    只生成目录，不压 zip、不生成 release\version.json。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1 -Version 1.0.1 -FreshInstall
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutDir,
    [string]$NodePath,
    [switch]$SkipBuild,
    [switch]$SkipInstall,
    [switch]$FreshInstall,
    [switch]$KeepAllPrebuilds,
    [switch]$SkipVerify,
    [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

$script:Root = Split-Path -Parent $PSScriptRoot
$script:LogFile = Join-Path (Join-Path $script:Root 'logs') 'package-release.log'

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

function Get-RelPath {
    param([string]$Base, [string]$FullPath)
    $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
    $full = [System.IO.Path]::GetFullPath($FullPath)
    if ($full.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $full.Substring($baseFull.Length).Replace('\', '/')
    }
    throw "路径不在基准目录下：$FullPath"
}

function Invoke-Robocopy {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$ExcludeDirs = @(),
        [string[]]$ExcludeFiles = @()
    )
    if (-not (Test-Path -LiteralPath $Source)) { throw "源目录不存在：$Source" }
    $rcArgs = @($Source, $Destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
    if ($ExcludeDirs.Count -gt 0) { $rcArgs += '/XD'; $rcArgs += $ExcludeDirs }
    if ($ExcludeFiles.Count -gt 0) { $rcArgs += '/XF'; $rcArgs += $ExcludeFiles }
    & robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）：$Source → $Destination" }
    $global:LASTEXITCODE = 0
}

function Get-NodeExe {
    param([string]$Preferred)
    $candidates = New-Object System.Collections.ArrayList
    if (-not [string]::IsNullOrWhiteSpace($Preferred)) { [void]$candidates.Add($Preferred) }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { [void]$candidates.Add($cmd.Source) }
    foreach ($c in @('C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe')) {
        [void]$candidates.Add($c)
    }
    foreach ($c in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($c) -and (Test-Path -LiteralPath $c)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    throw '找不到 node.exe：装 Node.js 22+ 或用 -NodePath 指定。'
}

function Get-NpmCmd {
    param([string]$NodeExe)
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $sibling = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
    if (Test-Path -LiteralPath $sibling) { return $sibling }
    throw '找不到 npm.cmd：确认 Node.js 安装完整，或用官方安装包重装。'
}

function New-FreePort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

function Restore-EnvVar {
    param([string]$Name, $Value)
    if ($null -eq $Value) { Remove-Item -Path ("Env:" + $Name) -ErrorAction SilentlyContinue }
    else { Set-Item -Path ("Env:" + $Name) -Value $Value }
}

function Invoke-PackageSmokeTest {
    param([string]$PackageDir, [string]$NodeExe)
    $port = New-FreePort
    $dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ('ssb-smoke-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $outLog = Join-Path $dataDir 'stdout.log'
    $errLog = Join-Path $dataDir 'stderr.log'
    $oldPort = $env:PORT; $oldHost = $env:HOST; $oldData = $env:DATA_DIR; $oldSecure = $env:COOKIE_SECURE
    $proc = $null
    try {
        $env:PORT = "$port"
        $env:HOST = '127.0.0.1'
        $env:DATA_DIR = $dataDir
        $env:COOKIE_SECURE = 'false'
        $proc = Start-Process -FilePath $NodeExe -ArgumentList 'server/index.js' -WorkingDirectory $PackageDir -PassThru -NoNewWindow -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        $ok = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Milliseconds 250
            if ($proc.HasExited) { break }
            try {
                $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/healthz" -f $port) -TimeoutSec 2
                if ($r.ok) { $ok = $true; break }
            } catch { }
        }
        if (-not $ok) {
            $errText = ''
            if (Test-Path -LiteralPath $errLog) { $errText = Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue }
            $outText = ''
            if (Test-Path -LiteralPath $outLog) { $outText = Get-Content -LiteralPath $outLog -Raw -ErrorAction SilentlyContinue }
            throw ("冒烟测试失败：服务未在 /api/healthz 就绪。`n--- stdout ---`n{0}`n--- stderr ---`n{1}" -f $outText, $errText)
        }
    } finally {
        if ($null -ne $proc -and -not $proc.HasExited) {
            try { $proc.Kill(); $proc.WaitForExit(5000) | Out-Null } catch { }
        }
        Restore-EnvVar 'PORT' $oldPort
        Restore-EnvVar 'HOST' $oldHost
        Restore-EnvVar 'DATA_DIR' $oldData
        Restore-EnvVar 'COOKIE_SECURE' $oldSecure
        Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ================================================================ 0. 预检
Write-Log '========== package-release 开始 =========='
$root = $script:Root
Write-Log "项目根：$root"

$nodeExe = Get-NodeExe -Preferred $NodePath
$nodeVersion = (& $nodeExe -v) -join ''
if ($nodeVersion -notmatch '^v(\d+)\.') { throw "无法识别 node 版本：$nodeVersion" }
if ([int]$Matches[1] -lt 22) { throw "当前 Node $nodeVersion 低于 22，先升级 Node。" }
$npmCmd = Get-NpmCmd -NodeExe $nodeExe
Write-Log "node：$nodeExe ($nodeVersion)"
Write-Log "npm ：$npmCmd"

$packageJsonPath = Join-Path $root 'package.json'
$localVersionPath = Join-Path $root 'version.json'
if (-not (Test-Path -LiteralPath $packageJsonPath)) { throw "找不到 $packageJsonPath" }
$pkg = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($Version)) {
    if (Test-Path -LiteralPath $localVersionPath) {
        $vj = Get-Content -LiteralPath $localVersionPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Version = [string]$vj.version
    }
    if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]$pkg.version }
}
$Version = $Version.Trim()
if ($Version -notmatch '^\d+\.\d+\.\d+([\-+][0-9A-Za-z\.\-]+)?$') { throw "版本号不合法：$Version（要 x.y.z）" }
if ([string]$pkg.version -ne $Version) {
    Write-Log ("注意：package.json 版本是 {0}，本次按 -Version/version.json 的 {1} 打包。" -f $pkg.version, $Version) 'WARN'
}
Write-Log "打包版本：$Version"

if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $root 'release' }
elseif (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $root $OutDir }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

# ================================================================ 1. 构建前端
if (-not $SkipBuild) {
    $viteConfig = Join-Path $root 'web\vite.config.ts'
    if (-not (Test-Path -LiteralPath $viteConfig)) { throw "找不到 $viteConfig，无法构建前端。" }
    $tmpBuild = Join-Path $root '.tmp-build'
    New-Item -ItemType Directory -Path $tmpBuild -Force | Out-Null
    $oldTemp = $env:TEMP; $oldTmp = $env:TMP
    try {
        $env:TEMP = $tmpBuild
        $env:TMP = $tmpBuild
        Write-Log "构建前端（TEMP=$tmpBuild）"
        Push-Location $root
        try {
            & $npmCmd run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build 失败（退出码 $LASTEXITCODE）" }
        } finally { Pop-Location }
    } finally {
        $env:TEMP = $oldTemp
        $env:TMP = $oldTmp
        Remove-Item -LiteralPath $tmpBuild -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Log '跳过前端构建（-SkipBuild）' 'WARN'
}
$distIndex = Join-Path $root 'web\dist\index.html'
if (-not (Test-Path -LiteralPath $distIndex)) { throw "web\dist\index.html 不存在：前端没构建成功？" }
Write-Log ("前端产物：{0}（{1} 个文件）" -f $distIndex, (Get-ChildItem (Join-Path $root 'web\dist') -Recurse -File).Count) 'OK'

# ================================================================ 2. 组装目录
$pkgName = "student-status-board-$Version"
$stage = Join-Path $OutDir $pkgName
if (Test-Path -LiteralPath $stage) {
    Write-Log "清理旧目录：$stage"
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Log '复制程序文件'
Invoke-Robocopy (Join-Path $root 'server') (Join-Path $stage 'server')
Invoke-Robocopy (Join-Path $root 'shared') (Join-Path $stage 'shared')
Invoke-Robocopy (Join-Path $root 'scripts') (Join-Path $stage 'scripts')
Invoke-Robocopy (Join-Path $root 'tools') (Join-Path $stage 'tools')
Invoke-Robocopy (Join-Path $root 'deploy') (Join-Path $stage 'deploy') -ExcludeFiles @('nssm.exe', '*.log')
Invoke-Robocopy (Join-Path $root 'web\dist') (Join-Path $stage 'web\dist')

foreach ($f in @('package.json', 'package-lock.json', 'README.md')) {
    $src = Join-Path $root $f
    if (-not (Test-Path -LiteralPath $src)) { throw "缺少根文件：$f" }
    Copy-Item -LiteralPath $src -Destination (Join-Path $stage $f) -Force
}
$deployGuide = Join-Path $root 'docs\部署说明.md'
if (Test-Path -LiteralPath $deployGuide) {
    Copy-Item -LiteralPath $deployGuide -Destination (Join-Path $stage '部署说明.md') -Force
} else {
    Write-Log '警告：docs\部署说明.md 不存在，发布包将不带部署说明。' 'WARN'
}
$cmdFiles = @(Get-ChildItem -LiteralPath $root -Filter '*.cmd' -File)
if ($cmdFiles.Count -eq 0) {
    Write-Log '警告：根目录没有 .cmd 入口，发布包将不带双击启动/停止/重置密码。' 'WARN'
} else {
    foreach ($cmd in $cmdFiles) {
        Copy-Item -LiteralPath $cmd.FullName -Destination (Join-Path $stage $cmd.Name) -Force
    }
}
Write-Log ("已复制：server / shared / scripts / tools / deploy / web/dist / package.json / package-lock.json / README.md / 部署说明.md / {0} 个 .cmd" -f $cmdFiles.Count)

# ================================================================ 3. 生产依赖
$stageNodeModules = Join-Path $stage 'node_modules'
if (-not $SkipInstall) {
    $localNodeModules = Join-Path $root 'node_modules'
    $useLocalCopy = (-not $FreshInstall) -and (Test-Path -LiteralPath (Join-Path $localNodeModules 'better-sqlite3'))
    if ($useLocalCopy) {
        Write-Log '复制本机已验证的 node_modules（robocopy，约 30 秒）'
        Invoke-Robocopy $localNodeModules $stageNodeModules
        Write-Log 'npm prune --omit=dev 剔除 dev 包'
        Push-Location $stage
        try {
            & $npmCmd prune --omit=dev --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm prune 失败（退出码 $LASTEXITCODE）" }
        } finally { Pop-Location }
    } else {
        Write-Log 'npm.cmd ci --omit=dev --ignore-scripts 全新安装生产依赖'
        Push-Location $stage
        try {
            & $npmCmd ci --omit=dev --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（退出码 $LASTEXITCODE）" }
        } finally { Pop-Location }
    }
} else {
    Write-Log '跳过依赖安装（-SkipInstall）' 'WARN'
}

if (Test-Path -LiteralPath (Join-Path $stageNodeModules 'better-sqlite3')) {
    if (-not $KeepAllPrebuilds) {
        $prebuildDir = Join-Path $stageNodeModules 'better-sqlite3\prebuilds'
        if (Test-Path -LiteralPath $prebuildDir) {
            $keep = @('win32-x64.node', 'win32-arm64.node')
            $removed = 0
            Get-ChildItem -LiteralPath $prebuildDir -File | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Force
                $removed++
            }
            Write-Log ("精简 better-sqlite3 预编译：移除 {0} 个非 Windows 平台 .node" -f $removed)
        }
    }
} elseif (-not $SkipInstall) {
    throw 'node_modules 里没有 better-sqlite3，发布包会起不来。'
}

# ================================================================ 4. 自检
if (-not $SkipVerify) {
    Write-Log '原生模块自检（better-sqlite3 / @node-rs/argon2）'
    $checkJs = "const D=require('better-sqlite3');const db=new D(':memory:');if(!db.prepare('select 1 as x').get()){process.exit(2)};db.close();require('@node-rs/argon2').hash('package-check').then(()=>{console.log('NATIVE_OK')}).catch(e=>{console.error(e);process.exit(3)})"
    Push-Location $stage
    try {
        $out = (& $nodeExe -e $checkJs) 2>&1
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -ne 0 -or (($out -join "`n") -notmatch 'NATIVE_OK')) {
        throw ("原生模块自检失败（退出码 {0}）：`n{1}" -f $code, ($out -join "`n"))
    }
    Write-Log '原生模块自检通过' 'OK'

    Write-Log '启动冒烟测试（临时 DATA_DIR + 随机端口）'
    Invoke-PackageSmokeTest -PackageDir $stage -NodeExe $nodeExe
    Write-Log '/api/healthz 冒烟通过' 'OK'
} else {
    Write-Log '跳过自检（-SkipVerify）' 'WARN'
}

# ================================================================ 5. 写 version.json + files_sha256
Write-Log '计算 files_sha256'
$nmPrefix = [System.IO.Path]::GetFullPath($stageNodeModules).TrimEnd('\') + '\'
$allFiles = Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
    (-not $_.FullName.StartsWith($nmPrefix, [System.StringComparison]::OrdinalIgnoreCase)) -and ($_.Name -ne 'version.json')
}
$hashes = [ordered]@{}
$fileEntries = New-Object System.Collections.ArrayList
foreach ($f in ($allFiles | Sort-Object FullName)) {
    $rel = Get-RelPath -Base $stage -FullPath $f.FullName
    $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashes[$rel] = $hash
    [void]$fileEntries.Add([ordered]@{ path = $rel; size = $f.Length; sha256 = $hash })
}
$builtAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$versionObj = [ordered]@{
    name         = 'student-status-board'
    version      = $Version
    built_at     = $builtAt
    node         = '>=22'
    files_sha256 = $hashes
}
$versionJson = ($versionObj | ConvertTo-Json -Depth 6).Replace('\u003e', '>').Replace('\u003c', '<')
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage 'version.json'), $versionJson, $utf8NoBom)
Write-Log ("version.json 写入完成：{0} 个文件有 sha256" -f $hashes.Count) 'OK'

# ================================================================ 6. 压缩 zip
$zipPath = Join-Path $OutDir ($pkgName + '.zip')
if ($NoZip) {
    Write-Log '跳过 zip（-NoZip）' 'WARN'
} else {
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Write-Log "压缩 $pkgName.zip（文件较多，慢一点正常）"
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    $zipItem = Get-Item -LiteralPath $zipPath
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Log ("zip 完成：{0}（{1:N1} MB，sha256={2}）" -f $zipItem.FullName, ($zipItem.Length / 1MB), $zipHash) 'OK'

    # ============================================================ 7. release/version.json
    $manifest = [ordered]@{
        name         = 'student-status-board'
        version      = $Version
        node         = '>=22'
        built_at     = $builtAt
        zip          = [ordered]@{
            file   = $zipItem.Name
            size   = $zipItem.Length
            sha256 = $zipHash
        }
        file_count   = $fileEntries.Count
        files        = $fileEntries
    }
    $manifestJson = ($manifest | ConvertTo-Json -Depth 8).Replace('\u003e', '>').Replace('\u003c', '<')
    $manifestPath = Join-Path $OutDir 'version.json'
    [System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)
    Write-Log "发布清单：$manifestPath" 'OK'
}

Write-Log '========== package-release 完成 ==========' 'OK'
Write-Host ''
Write-Host "发布目录：$stage" -ForegroundColor Green
if (-not $NoZip) { Write-Host "发布 zip ：$zipPath" -ForegroundColor Green }
Write-Host "清单     ：$(Join-Path $OutDir 'version.json')" -ForegroundColor Green
exit 0
