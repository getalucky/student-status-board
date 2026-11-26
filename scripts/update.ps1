<#
.SYNOPSIS
    检查并安装「学生状态管理系统」更新（手动触发，不静默）。

.DESCRIPTION
    流程（技术方案 §12.3）：
      0. 读本地 version.json、deploy\release.json（repo / api_base / allow_local_updates）
      1. 查 GitHub latest release 的 version.json；semver 比较，不新就退出
         —— GitHub 不可达时，回退到 updates\ 目录里手动放的 zip + version.json
      2. 下载/取包 → sha256 校验 → 解压到临时目录 → 再按包内 version.json 的 files_sha256 逐文件校验
      3. 停 NSSM 服务 → 把当前程序目录备份到 backups\app-<旧版本>\
      4. 只替换 server/ shared/ scripts/ deploy/ web/dist/ node_modules/ package.json 等程序文件，
         保留 data\、logs\、updates\、backups\
      5. 有 scripts\migrate.js 就跑迁移（没有就跳过，server/db.js 启动时会自动补表）
      6. 起服务，30 秒内 /api/healthz 不通或进程退出 → 停服、回滚、重起
      7. 每一步写 logs\update.log

    手动触发，绝不静默升级。双击根目录「检查更新.cmd」即可。

.PARAMETER ProjectRoot
    要更新的安装目录，默认本脚本上一级。

.PARAMETER ServiceName
    Windows 服务名，默认 StudentBoard。

.PARAMETER Port
    健康检查端口，默认 3210。

.PARAMETER PackagePath
    直接指定本地 zip（跳过 GitHub / updates\ 扫描）。配合 -VersionFile 指定清单。

.PARAMETER VersionFile
    配合 -PackagePath 的 release version.json（含 zip.sha256）。

.PARAMETER LocalOnly
    只从 updates\ 本地包更新，不访问 GitHub。

.PARAMETER CheckOnly
    只检查版本，不下载、不安装。

.PARAMETER DryRun
    完整走 下载→sha256→解压→文件校验，但不改任何文件、不碰服务。

.PARAMETER Force
    同版本/降级也强制安装；version.json 缺 zip.sha256 时也允许继续（会警告）。

.PARAMETER NoService
    不碰 Windows 服务：用直接起 node 进程的方式做探活（便携/自测用）。

.PARAMETER StopAfterCheck
    NoService 模式下探活通过后停掉测试进程（自测用）。

.PARAMETER HealthTimeoutSec
    启动后等待 /api/healthz 的秒数，默认 30。

.PARAMETER NssmPath
    nssm.exe 路径（保留参数，便于排障）。

.PARAMETER NodePath
    node.exe 路径，默认 runtime\node → PATH。

.PARAMETER SelfTest
    只跑内置单元测试（semver 比较、包根识别），不联网、不改文件。

.PARAMETER NoElevate
    无管理员权限时不自动提权（自测用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 -CheckOnly

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 -PackagePath .\updates\student-status-board-1.0.1.zip

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 -DryRun
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [string]$ServiceName = 'StudentBoard',
    [int]$Port = 3210,
    [string]$PackagePath,
    [string]$VersionFile,
    [switch]$LocalOnly,
    [switch]$CheckOnly,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$NoService,
    [switch]$StopAfterCheck,
    [int]$HealthTimeoutSec = 30,
    [string]$NssmPath,
    [string]$NodePath,
    [switch]$SelfTest,
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$LASTEXITCODE = 0

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$script:Root = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
$script:LogFile = Join-Path (Join-Path $script:Root 'logs') 'update.log'

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

function Read-JsonFile {
    param([string]$Path)
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-JsonValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ---------------------------------------------------------------- semver
function ConvertTo-SemVer {
    param([string]$Text)
    $t = $Text.Trim()
    if ($t.StartsWith('v') -or $t.StartsWith('V')) { $t = $t.Substring(1) }
    $plus = $t.IndexOf('+')
    if ($plus -ge 0) { $t = $t.Substring(0, $plus) }
    $pre = ''
    $dash = $t.IndexOf('-')
    if ($dash -ge 0) { $pre = $t.Substring($dash + 1); $t = $t.Substring(0, $dash) }
    $parts = $t.Split('.')
    $nums = @(0, 0, 0)
    for ($i = 0; $i -lt 3 -and $i -lt $parts.Count; $i++) {
        $n = 0
        if (-not [int]::TryParse($parts[$i], [ref]$n)) { throw "版本号不合法：$Text" }
        $nums[$i] = $n
    }
    return [pscustomobject]@{ Major = $nums[0]; Minor = $nums[1]; Patch = $nums[2]; Pre = $pre }
}

function Compare-SemVer {
    param([string]$A, [string]$B)
    $va = ConvertTo-SemVer $A
    $vb = ConvertTo-SemVer $B
    if ($va.Major -lt $vb.Major) { return -1 }
    if ($va.Major -gt $vb.Major) { return 1 }
    if ($va.Minor -lt $vb.Minor) { return -1 }
    if ($va.Minor -gt $vb.Minor) { return 1 }
    if ($va.Patch -lt $vb.Patch) { return -1 }
    if ($va.Patch -gt $vb.Patch) { return 1 }
    if ($va.Pre -eq $vb.Pre) { return 0 }
    if ($va.Pre -eq '') { return 1 }
    if ($vb.Pre -eq '') { return -1 }
    $pa = $va.Pre.Split('.')
    $pb = $vb.Pre.Split('.')
    $n = [Math]::Min($pa.Count, $pb.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $x = $pa[$i]; $y = $pb[$i]
        $xn = 0; $yn = 0
        $xi = [int]::TryParse($x, [ref]$xn)
        $yi = [int]::TryParse($y, [ref]$yn)
        if ($xi -and $yi) {
            if ($xn -lt $yn) { return -1 }
            if ($xn -gt $yn) { return 1 }
        } elseif ($xi -and (-not $yi)) { return -1 }
        elseif ((-not $xi) -and $yi) { return 1 }
        else {
            $c = [string]::Compare($x, $y, [System.StringComparison]::OrdinalIgnoreCase)
            if ($c -lt 0) { return -1 }
            if ($c -gt 0) { return 1 }
        }
    }
    if ($pa.Count -lt $pb.Count) { return -1 }
    if ($pa.Count -gt $pb.Count) { return 1 }
    return 0
}

# ---------------------------------------------------------------- zip / 包
function Get-ManifestFromZip {
    param([string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $entries = @($zip.Entries | Where-Object { $_.FullName -match '(^|/)version\.json$' })
        if ($entries.Count -eq 0) { return $null }
        $entry = $entries | Sort-Object { $_.FullName.Split('/').Count } | Select-Object -First 1
        $stream = $entry.Open()
        try {
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
        return ($text | ConvertFrom-Json)
    } finally { $zip.Dispose() }
}

function Get-PackageRoot {
    param([string]$ExtractDir)
    if ((Test-Path -LiteralPath (Join-Path $ExtractDir 'version.json')) -and (Test-Path -LiteralPath (Join-Path $ExtractDir 'server\index.js'))) {
        return $ExtractDir
    }
    foreach ($d in (Get-ChildItem -LiteralPath $ExtractDir -Directory)) {
        if ((Test-Path -LiteralPath (Join-Path $d.FullName 'version.json')) -and (Test-Path -LiteralPath (Join-Path $d.FullName 'server\index.js'))) {
            return $d.FullName
        }
    }
    $hit = Get-ChildItem -LiteralPath $ExtractDir -Recurse -File -Filter 'version.json' | Where-Object { $_.DirectoryName -ne $ExtractDir } | Select-Object -First 1
    if ($hit) { return $hit.DirectoryName }
    return $null
}

function Get-LocalCandidate {
    param([string]$Root)
    $dir = Join-Path $Root 'updates'
    if (-not (Test-Path -LiteralPath $dir)) { return $null }
    $candidates = New-Object System.Collections.ArrayList
    $vj = Join-Path $dir 'version.json'
    if (Test-Path -LiteralPath $vj) {
        try { $m = Read-JsonFile $vj } catch { $m = $null }
        if ($null -ne $m -and (Get-JsonValue $m 'version')) {
            $zipInfo = Get-JsonValue $m 'zip'
            $zipName = Get-JsonValue $zipInfo 'file'
            $zip = $null
            if ($zipName) { $zip = Join-Path $dir ([string]$zipName) }
            if ((-not $zip) -or (-not (Test-Path -LiteralPath $zip))) {
                $zip = Get-ChildItem -LiteralPath $dir -Filter '*.zip' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
            }
            if ($zip -and (Test-Path -LiteralPath $zip)) {
                [void]$candidates.Add([pscustomobject]@{
                        Version  = [string]$m.version
                        ZipPath  = $zip
                        ZipUrl   = $null
                        ZipName  = $null
                        Manifest = $m
                        Sha256   = $(if ($zipInfo -and (Get-JsonValue $zipInfo 'sha256')) { [string](Get-JsonValue $zipInfo 'sha256') } else { $null })
                        Headers  = $null
                        Source   = 'updates\version.json'
                    })
            }
        }
    }
    foreach ($z in (Get-ChildItem -LiteralPath $dir -Filter '*.zip' -File)) {
        $m = $null
        try { $m = Get-ManifestFromZip $z.FullName } catch { }
        if ($null -ne $m -and (Get-JsonValue $m 'version')) {
            [void]$candidates.Add([pscustomobject]@{
                    Version  = [string]$m.version
                    ZipPath  = $z.FullName
                    ZipUrl   = $null
                    ZipName  = $null
                    Manifest = $m
                    Sha256   = $null
                    Headers  = $null
                    Source   = $z.Name
                })
        }
    }
    if ($candidates.Count -eq 0) { return $null }
    $best = $candidates[0]
    foreach ($c in $candidates) {
        if ((Compare-SemVer $c.Version $best.Version) -gt 0) { $best = $c }
    }
    return $best
}

function Resolve-NodeExe {
    param([string]$Preferred, [string]$Root)
    $candidates = New-Object System.Collections.ArrayList
    if (-not [string]::IsNullOrWhiteSpace($Preferred)) { [void]$candidates.Add($Preferred) }
    [void]$candidates.Add((Join-Path $Root 'runtime\node\node.exe'))
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { [void]$candidates.Add($cmd.Source) }
    foreach ($c in @('C:\Program Files\nodejs\node.exe')) { [void]$candidates.Add($c) }
    foreach ($c in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($c) -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
    }
    throw '找不到 node.exe（runtime\node 或 PATH）。'
}

function Invoke-RobocopyCopy {
    param([string]$Source, [string]$Destination)
    & robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（$LASTEXITCODE）：$Source → $Destination" }
    $global:LASTEXITCODE = 0
}

function Wait-Health {
    param([int]$Port, [int]$TimeoutSec, $Process)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800
        if ($null -ne $Process) {
            if ($Process.HasExited) { return $false }
        }
        try {
            $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/healthz" -f $Port) -TimeoutSec 2
            if ($r.ok) { return $true }
        } catch { }
    }
    return $false
}

# ---------------------------------------------------------------- 自测
function Invoke-SelfTest {
    $cases = @(
        @('1.0.0', '1.0.1', -1),
        @('1.0.1', '1.0.0', 1),
        @('1.0.0', '1.0.0', 0),
        @('1.2.10', '1.2.9', 1),
        @('2.0.0', '10.0.0', -1),
        @('1.0.0-beta', '1.0.0', -1),
        @('1.0.0', '1.0.0-beta', 1),
        @('v1.1.0', '1.1.0', 0)
    )
    $fail = 0
    foreach ($c in $cases) {
        $got = Compare-SemVer $c[0] $c[1]
        if ($got -ne $c[2]) {
            $fail++
            Write-Host ("FAIL  compare({0}, {1}) = {2}，期望 {3}" -f $c[0], $c[1], $got, $c[2]) -ForegroundColor Red
        } else {
            Write-Host ("ok    compare({0}, {1}) = {2}" -f $c[0], $c[1], $got) -ForegroundColor Green
        }
    }
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('ssb-selftest-' + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path (Join-Path $tmp 'student-status-board-9.9.9\server') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $tmp 'student-status-board-9.9.9\version.json') -Value '{"version":"9.9.9"}' -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $tmp 'student-status-board-9.9.9\server\index.js') -Value '//x' -Encoding UTF8
        $rootHit = Get-PackageRoot $tmp
        if ($rootHit -and (Test-Path (Join-Path $rootHit 'version.json'))) { Write-Host 'ok    Get-PackageRoot 识别包根' -ForegroundColor Green }
        else { $fail++; Write-Host 'FAIL  Get-PackageRoot 未识别包根' -ForegroundColor Red }
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($fail -gt 0) { Write-Host ("自测失败：{0} 项" -f $fail) -ForegroundColor Red; return $false }
    Write-Host '自测全部通过' -ForegroundColor Green
    return $true
}

if ($SelfTest) {
    $ok = Invoke-SelfTest
    if (-not $ok) { exit 1 }
    exit 0
}

# ---------------------------------------------------------------- 管理员（服务模式才需要）
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not ($DryRun -or $NoService -or $CheckOnly)) {
    if ($NoElevate) {
        Write-Log '不是管理员：停/起服务会失败（-NoElevate）。' 'WARN'
    } else {
        Write-Log '更新需要停止 Windows 服务，正在请求提权…'
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
            throw '提权被取消：请用管理员 PowerShell 再执行。'
        }
        if ($elevated) {
            $elevated.WaitForExit()
            if ($elevated.ExitCode -eq 0) { Write-Host '更新完成（详见 logs\update.log）' -ForegroundColor Green }
            else { Write-Host '更新失败（详见 logs\update.log）' -ForegroundColor Red }
            exit $elevated.ExitCode
        }
        exit 1
    }
}

Write-Log '================ update 开始 ================'
Write-Log "安装目录：$script:Root"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------- 版本
$localVersionFile = Join-Path $script:Root 'version.json'
if (-not (Test-Path -LiteralPath $localVersionFile)) { throw "找不到 $localVersionFile —— 不是有效的安装目录。" }
$localManifest = Read-JsonFile $localVersionFile
$oldVersion = [string](Get-JsonValue $localManifest 'version')
if ([string]::IsNullOrWhiteSpace($oldVersion)) { throw '本地 version.json 缺 version 字段。' }
Write-Log "当前版本：$oldVersion"

$releaseConfigPath = Join-Path $script:Root 'deploy\release.json'
$releaseConfig = $null
if (Test-Path -LiteralPath $releaseConfigPath) {
    try { $releaseConfig = Read-JsonFile $releaseConfigPath } catch { Write-Log "release.json 解析失败：$($_.Exception.Message)" 'WARN' }
} else {
    Write-Log 'deploy\release.json 不存在：本次只能用 updates\ 本地包更新。' 'WARN'
}
$repo = [string](Get-JsonValue $releaseConfig 'repo')
$apiBase = [string](Get-JsonValue $releaseConfig 'api_base')
if ([string]::IsNullOrWhiteSpace($apiBase)) { $apiBase = 'https://api.github.com' }
$allowLocal = $true
$allowLocalRaw = Get-JsonValue $releaseConfig 'allow_local_updates'
if ($null -ne $allowLocalRaw) { $allowLocal = [bool]$allowLocalRaw }
$repoConfigured = ($repo -match '^[^/]+/[^/]+$') -and ($repo -notmatch '^(owner/name|OWNER/|CHANGE_ME)')

# ---------------------------------------------------------------- 状态变量（catch/finally 里要用，先初始化）
$candidate = $null
$backupDir = $null
$extractDir = $null
$startedProcess = $null
$serviceExisted = $false
$githubFailed = $false
$preserved = @{}
$items = @('server', 'shared', 'scripts', 'deploy', 'web\dist', 'node_modules', 'package.json', 'package-lock.json', 'version.json', 'README.md', '检查更新.cmd', '绑定Tailscale.cmd')
$tempFiles = New-Object System.Collections.ArrayList

try {
    # ------------------------------------------------------------ 找更新
    if (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
        $zipFull = (Resolve-Path -LiteralPath $PackagePath).Path
        $manifest = $null
        if (-not [string]::IsNullOrWhiteSpace($VersionFile)) {
            $manifest = Read-JsonFile (Resolve-Path -LiteralPath $VersionFile).Path
        } else {
            $manifest = Get-ManifestFromZip $zipFull
        }
        if ($null -eq $manifest -or -not (Get-JsonValue $manifest 'version')) { throw "无法从 $zipFull 或 -VersionFile 读到 version.json。" }
        $zipInfo = Get-JsonValue $manifest 'zip'
        $sha = Get-JsonValue $zipInfo 'sha256'
        if (-not $sha) { $sha = Get-JsonValue $manifest 'sha256' }
        $candidate = [pscustomobject]@{
            Version  = [string](Get-JsonValue $manifest 'version')
            ZipPath  = $zipFull
            ZipUrl   = $null
            ZipName  = $null
            Manifest = $manifest
            Sha256   = $(if ($sha) { [string]$sha } else { $null })
            Headers  = $null
            Source   = $zipFull
        }
    }

    if ($null -eq $candidate -and (-not $LocalOnly)) {
        if (-not $repoConfigured) {
            Write-Log "deploy\release.json 里的 repo 还是占位符（$repo），跳过 GitHub，改用 updates\ 本地包。" 'WARN'
        } else {
            Write-Log "查询 GitHub Release：$repo"
            try {
                $headers = @{ 'User-Agent' = 'student-status-board-updater'; 'Accept' = 'application/vnd.github+json' }
                if ($env:GITHUB_TOKEN) { $headers['Authorization'] = 'Bearer ' + $env:GITHUB_TOKEN }
                $release = Invoke-RestMethod -Uri ($apiBase.TrimEnd('/') + '/repos/' + $repo + '/releases/latest') -Headers $headers -TimeoutSec 20
                $assets = @($release.assets)
                $manifestAsset = $assets | Where-Object { $_.name -ieq 'version.json' } | Select-Object -First 1
                if ($null -eq $manifestAsset) {
                    Write-Log 'latest release 没有 version.json 资产，跳过 GitHub。' 'WARN'
                } else {
                    $tmpManifest = Join-Path ([System.IO.Path]::GetTempPath()) ('ssb-manifest-' + [Guid]::NewGuid().ToString('N') + '.json')
                    [void]$tempFiles.Add($tmpManifest)
                    Invoke-WebRequest -Uri $manifestAsset.browser_download_url -OutFile $tmpManifest -UseBasicParsing -Headers $headers -TimeoutSec 30
                    $manifest = Read-JsonFile $tmpManifest
                    $zipInfo = Get-JsonValue $manifest 'zip'
                    $zipName = Get-JsonValue $zipInfo 'file'
                    $zipAsset = $null
                    if ($zipName) { $zipAsset = $assets | Where-Object { $_.name -ieq [string]$zipName } | Select-Object -First 1 }
                    if ($null -eq $zipAsset) { $zipAsset = $assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1 }
                    if ($null -eq $zipAsset) {
                        Write-Log 'latest release 没有 zip 资产。' 'WARN'
                    } else {
                        $sha = Get-JsonValue $zipInfo 'sha256'
                        if (-not $sha) { $sha = Get-JsonValue $manifest 'sha256' }
                        $candidate = [pscustomobject]@{
                            Version  = [string](Get-JsonValue $manifest 'version')
                            ZipPath  = $null
                            ZipUrl   = $zipAsset.browser_download_url
                            ZipName  = $zipAsset.name
                            Manifest = $manifest
                            Sha256   = $(if ($sha) { [string]$sha } else { $null })
                            Headers  = $headers
                            Source   = 'github:' + $repo
                        }
                    }
                }
            } catch {
                $githubFailed = $true
                Write-Log ("GitHub 不可达或查询失败：{0}" -f $_.Exception.Message) 'WARN'
            }
        }
    }

    if ($null -eq $candidate -and $allowLocal) {
        Write-Log '查 updates\ 本地更新包'
        $localCand = Get-LocalCandidate -Root $script:Root
        if ($null -ne $localCand) {
            $candidate = $localCand
            Write-Log ("找到本地包：{0}（版本 {1}）" -f $localCand.Source, $localCand.Version)
        }
    }

    if ($null -eq $candidate) {
        if ($CheckOnly) {
            if ($githubFailed) { Write-Log '检查更新失败：GitHub 不可达，且 updates\ 里没有本地更新包。' 'ERROR'; exit 2 }
            Write-Log '检查更新失败：deploy\release.json 还没配置 repo（当前是占位符），updates\ 里也没有更新包。' 'ERROR'
            exit 2
        }
        throw '没有找到可用的更新：先把 deploy\release.json 的 repo 改成 owner/name，或把 zip + version.json 放进 updates\。'
    }

    Write-Log ("候选版本：{0}（来源：{1}）" -f $candidate.Version, $candidate.Source)
    $cmp = Compare-SemVer $candidate.Version $oldVersion
    if ($cmp -le 0 -and -not $Force) {
        Write-Log ("已是最新版本：本地 {0}，远端 {1}" -f $oldVersion, $candidate.Version) 'OK'
        exit 0
    }
    if ($cmp -le 0) { Write-Log ("强制安装同版本/旧版本：{0} → {1}" -f $oldVersion, $candidate.Version) 'WARN' }

    if ($CheckOnly) {
        Write-Log ("发现新版本：{0} → {1}" -f $oldVersion, $candidate.Version) 'OK'
        exit 0
    }

    # ------------------------------------------------------------ 取包
    $updatesDir = Join-Path $script:Root 'updates'
    if (-not (Test-Path -LiteralPath $updatesDir)) { New-Item -ItemType Directory -Path $updatesDir -Force | Out-Null }
    $targetZip = $null
    if ([string]::IsNullOrWhiteSpace($candidate.ZipPath)) {
        if ($DryRun) {
            $targetZip = Join-Path ([System.IO.Path]::GetTempPath()) ('ssb-dryrun-' + [Guid]::NewGuid().ToString('N') + '.zip')
            [void]$tempFiles.Add($targetZip)
        } else {
            $targetZip = Join-Path $updatesDir ($candidate.Version + '-' + $candidate.ZipName)
        }
        Write-Log ("下载更新包：{0}" -f $candidate.ZipUrl)
        $oldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $candidate.ZipUrl -OutFile $targetZip -UseBasicParsing -Headers $candidate.Headers -TimeoutSec 1800
        } finally { $ProgressPreference = $oldProgress }
        $candidate.ZipPath = $targetZip
        $candidate.Source = 'download'
    }
    $zipPath = $candidate.ZipPath
    if (-not (Test-Path -LiteralPath $zipPath)) { throw "更新包不存在：$zipPath" }

    $actualHash = Get-Sha256 $zipPath
    Write-Log ("zip sha256：{0}" -f $actualHash)
    if ([string]::IsNullOrWhiteSpace($candidate.Sha256)) {
        if (-not $Force) { throw 'version.json 里没有 zip.sha256，拒绝安装（确认可信可加 -Force）。' }
        Write-Log 'version.json 缺 zip.sha256，-Force 继续（未做 zip 校验）' 'WARN'
    } elseif ($actualHash -ne $candidate.Sha256.ToLowerInvariant()) {
        $deletedText = ''
        if ($candidate.Source -eq 'download' -and $targetZip) {
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
            $deletedText = '已删除下载包。'
        }
        throw ("sha256 校验失败：期望 {0}，实际 {1}。{2}" -f $candidate.Sha256, $actualHash, $deletedText)
    } else {
        Write-Log 'zip sha256 校验通过' 'OK'
    }

    # ------------------------------------------------------------ 解压 + 内容校验
    $extractBase = $updatesDir
    if ($DryRun) { $extractBase = [System.IO.Path]::GetTempPath() }
    $extractDir = Join-Path $extractBase ('_extract-' + $candidate.Version + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
    Write-Log "解压到 $extractDir"
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractDir, [System.Text.Encoding]::UTF8)
    $pkgRoot = Get-PackageRoot -ExtractDir $extractDir
    if ($null -eq $pkgRoot) { throw '解压后找不到包含 version.json + server\index.js 的包根目录。' }
    Write-Log "包根：$pkgRoot"

    $newManifest = Read-JsonFile (Join-Path $pkgRoot 'version.json')
    if ([string](Get-JsonValue $newManifest 'version') -ne [string]$candidate.Version) {
        throw ("包内版本 {0} 与清单 {1} 不一致。" -f (Get-JsonValue $newManifest 'version'), $candidate.Version)
    }
    $bad = New-Object System.Collections.ArrayList
    $fileHashMap = Get-JsonValue $newManifest 'files_sha256'
    $checkedFiles = 0
    if ($null -ne $fileHashMap) {
        foreach ($prop in $fileHashMap.PSObject.Properties) {
            $rel = [string]$prop.Name
            $expect = ([string]$prop.Value).ToLowerInvariant()
            $file = Join-Path $pkgRoot ($rel.Replace('/', '\'))
            if (-not (Test-Path -LiteralPath $file)) { [void]$bad.Add('缺失:' + $rel); continue }
            if ((Get-Sha256 $file) -ne $expect) { [void]$bad.Add('不一致:' + $rel) }
            $checkedFiles++
        }
    } else {
        Write-Log '包内 version.json 没有 files_sha256，跳过逐文件校验' 'WARN'
    }
    if ($bad.Count -gt 0) {
        throw ("包内容校验失败（{0} 项）：{1}" -f $bad.Count, (($bad | Select-Object -First 8) -join ', '))
    }
    Write-Log ("包内容校验通过（{0} 个文件）" -f $checkedFiles) 'OK'

    if ($DryRun) {
        Write-Log '[dry-run] 校验完成：将停止服务 → 备份 → 替换 server/shared/scripts/deploy/web\dist/node_modules/package.json/version.json'
        Write-Log '[dry-run] 不修改任何文件，退出'
        exit 0
    }

    # ------------------------------------------------------------ 停服务
    if (-not $NoService) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            $serviceExisted = $true
            Write-Log "停止服务 $ServiceName（当前 $($svc.Status)）"
            if ($svc.Status -ne 'Stopped') {
                Stop-Service -Name $ServiceName -Force
                try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { }
            }
            Write-Log '服务已停止' 'OK'
        } else {
            Write-Log "服务 $ServiceName 未注册：按无服务模式继续（只替换文件，不自动启动）。" 'WARN'
        }
    } else {
        Write-Log 'NoService：不操作 Windows 服务，用直接进程探活' 'WARN'
    }

    # ------------------------------------------------------------ 备份
    $backupBase = Join-Path $script:Root 'backups'
    if (-not (Test-Path -LiteralPath $backupBase)) { New-Item -ItemType Directory -Path $backupBase -Force | Out-Null }
    $backupDir = Join-Path $backupBase ('app-' + $oldVersion)
    if (Test-Path -LiteralPath $backupDir) { $backupDir = Join-Path $backupBase ('app-' + $oldVersion + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Write-Log "备份当前程序到 $backupDir"
    foreach ($item in $items) {
        $src = Join-Path $script:Root $item
        if (-not (Test-Path -LiteralPath $src)) { continue }
        $dst = Join-Path $backupDir $item
        $srcItem = Get-Item -LiteralPath $src -Force
        if ($srcItem.PSIsContainer) { Invoke-RobocopyCopy -Source $src -Destination $dst }
        else {
            $parent = Split-Path -Parent $dst
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath $src -Destination $dst -Force
        }
    }
    Write-Log '备份完成' 'OK'

    # 保留目标机自己的配置与 nssm
    foreach ($f in @('deploy\release.json', 'deploy\nssm.exe')) {
        $p = Join-Path $script:Root $f
        if (Test-Path -LiteralPath $p) { $preserved[$f] = [System.IO.File]::ReadAllBytes($p) }
    }

    # ------------------------------------------------------------ 替换
    Write-Log '替换程序文件（保留 data\ logs\ updates\ backups\ runtime\）'
    foreach ($item in $items) {
        $src = Join-Path $pkgRoot $item
        if (-not (Test-Path -LiteralPath $src)) { Write-Log "包内没有 $item，跳过" 'WARN'; continue }
        $target = Join-Path $script:Root $item
        $srcItem = Get-Item -LiteralPath $src -Force
        if ($srcItem.PSIsContainer) {
            if (Test-Path -LiteralPath $target) {
                $t = Get-Item -LiteralPath $target -Force
                if ($t.PSIsContainer) { Remove-Item -LiteralPath $target -Recurse -Force }
                else { Remove-Item -LiteralPath $target -Force }
            }
            Invoke-RobocopyCopy -Source $src -Destination $target
        } else {
            Copy-Item -LiteralPath $src -Destination $target -Force
        }
    }
    foreach ($f in $preserved.Keys) {
        $dest = Join-Path $script:Root $f
        $parent = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [System.IO.File]::WriteAllBytes($dest, $preserved[$f])
    }
    Write-Log '程序文件替换完成' 'OK'

    $nodeExe = Resolve-NodeExe -Preferred $NodePath -Root $script:Root
    Write-Log "node：$nodeExe"

    # ------------------------------------------------------------ 迁移
    $migrateJs = Join-Path $script:Root 'scripts\migrate.js'
    if (Test-Path -LiteralPath $migrateJs) {
        Write-Log '运行数据迁移 scripts\migrate.js'
        Push-Location $script:Root
        try {
            & $nodeExe 'scripts\migrate.js'
            if ($LASTEXITCODE -ne 0) { throw "迁移失败（退出码 $LASTEXITCODE）" }
        } finally { Pop-Location }
        Write-Log '迁移完成' 'OK'
    } else {
        Write-Log '没有 scripts\migrate.js，跳过迁移（server/db.js 启动时会自动补表）'
    }

    # ------------------------------------------------------------ 起服务 + 探活
    $healthOk = $false
    if ($serviceExisted) {
        Write-Log "启动服务 $ServiceName"
        Start-Service -Name $ServiceName
        $healthOk = Wait-Health -Port $Port -TimeoutSec $HealthTimeoutSec -Process $null
    } elseif ($NoService) {
        Write-Log 'NoService：直接启动 node server/index.js 探活'
        $logDir = Join-Path $script:Root 'logs'
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        $oldPort = $env:PORT; $oldHost = $env:HOST; $oldEnv = $env:NODE_ENV; $oldSecure = $env:COOKIE_SECURE
        $env:PORT = "$Port"; $env:HOST = '127.0.0.1'; $env:NODE_ENV = 'production'; $env:COOKIE_SECURE = 'false'
        try {
            $startedProcess = Start-Process -FilePath $nodeExe -ArgumentList 'server/index.js' -WorkingDirectory $script:Root -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $logDir 'update-run.out.log') -RedirectStandardError (Join-Path $logDir 'update-run.err.log')
        } finally {
            $env:PORT = $oldPort; $env:HOST = $oldHost; $env:NODE_ENV = $oldEnv; $env:COOKIE_SECURE = $oldSecure
        }
        $healthOk = Wait-Health -Port $Port -TimeoutSec $HealthTimeoutSec -Process $startedProcess
    } else {
        Write-Log '服务未注册：跳过启动与探活（只替换文件）' 'WARN'
        $healthOk = $true
    }

    if (-not $healthOk) { throw ("启动后 {0} 秒内 /api/healthz 未通过或进程退出" -f $HealthTimeoutSec) }    Write-Log "健康检查通过：http://127.0.0.1:$Port/api/healthz" 'OK'

    if ($StopAfterCheck -and $null -ne $startedProcess -and -not $startedProcess.HasExited) {
        $startedProcess.Kill()
        $startedProcess.WaitForExit(5000) | Out-Null
        Write-Log 'StopAfterCheck：测试进程已停止'
    }

    Write-Log ("更新完成：{0} → {1}" -f $oldVersion, $candidate.Version) 'OK'
    Write-Log '================ update 结束 ================' 'OK'
    Write-Host ''
    Write-Host ("更新完成：$oldVersion → $($candidate.Version)") -ForegroundColor Green
    exit 0
} catch {
    $errMsg = $_.Exception.Message
    Write-Log ("更新失败：$errMsg") 'ERROR'

    # ------------------------------------------------------------ 回滚
    if ($null -ne $backupDir -and (Test-Path -LiteralPath $backupDir)) {
        Write-Log "开始回滚：从 $backupDir 恢复" 'WARN'
        try {
            foreach ($item in $items) {
                $src = Join-Path $backupDir $item
                if (-not (Test-Path -LiteralPath $src)) { continue }
                $target = Join-Path $script:Root $item
                $srcItem = Get-Item -LiteralPath $src -Force
                if ($srcItem.PSIsContainer) {
                    if (Test-Path -LiteralPath $target) {
                        $t = Get-Item -LiteralPath $target -Force
                        if ($t.PSIsContainer) { Remove-Item -LiteralPath $target -Recurse -Force }
                        else { Remove-Item -LiteralPath $target -Force }
                    }
                    Invoke-RobocopyCopy -Source $src -Destination $target
                } else {
                    Copy-Item -LiteralPath $src -Destination $target -Force
                }
            }
            foreach ($f in $preserved.Keys) {
                $dest = Join-Path $script:Root $f
                $parent = Split-Path -Parent $dest
                if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
                [System.IO.File]::WriteAllBytes($dest, $preserved[$f])
            }
            Write-Log '程序文件已回滚' 'OK'

            if ($null -ne $startedProcess -and -not $startedProcess.HasExited) {
                try { $startedProcess.Kill(); $startedProcess.WaitForExit(5000) | Out-Null } catch { }
            }
            $rollbackOk = $false
            if ($serviceExisted) {
                $svcNow = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
                if ($svcNow -and $svcNow.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
                Start-Service -Name $ServiceName
                $rollbackOk = Wait-Health -Port $Port -TimeoutSec $HealthTimeoutSec -Process $null
            } elseif ($NoService) {
                $nodeExe2 = Resolve-NodeExe -Preferred $NodePath -Root $script:Root
                $oldPort = $env:PORT; $oldHost = $env:HOST; $oldEnv = $env:NODE_ENV; $oldSecure = $env:COOKIE_SECURE
                $env:PORT = "$Port"; $env:HOST = '127.0.0.1'; $env:NODE_ENV = 'production'; $env:COOKIE_SECURE = 'false'
                try {
                    $proc2 = Start-Process -FilePath $nodeExe2 -ArgumentList 'server/index.js' -WorkingDirectory $script:Root -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $script:Root 'logs\update-rollback.out.log') -RedirectStandardError (Join-Path $script:Root 'logs\update-rollback.err.log')
                } finally {
                    $env:PORT = $oldPort; $env:HOST = $oldHost; $env:NODE_ENV = $oldEnv; $env:COOKIE_SECURE = $oldSecure
                }
                $rollbackOk = Wait-Health -Port $Port -TimeoutSec $HealthTimeoutSec -Process $proc2
                if ($StopAfterCheck -and $null -ne $proc2 -and -not $proc2.HasExited) { $proc2.Kill(); $proc2.WaitForExit(5000) | Out-Null }
            } else {
                $rollbackOk = $true
            }
            if ($rollbackOk) { Write-Log '回滚完成，旧版本已重新启动并探活通过' 'OK' }
            else { Write-Log '回滚后旧版本仍未通过健康检查，请人工检查 logs\service.err.log' 'ERROR' }
        } catch {
            Write-Log ("回滚过程出错：{0}" -f $_.Exception.Message) 'ERROR'
        }
    } else {
        Write-Log '尚未开始替换文件，无需回滚' 'WARN'
    }

    exit 1
} finally {
    foreach ($tmp in $tempFiles) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if ($null -ne $extractDir -and (Test-Path -LiteralPath $extractDir)) {
        Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
