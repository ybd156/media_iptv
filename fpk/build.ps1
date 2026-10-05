# MediaIptv fnOS FPK 打包脚本 (Windows)
# 用法: powershell -ExecutionPolicy Bypass -File build.ps1 [-Version 1.0.0] [-NodeVersion v24.9.0]
#
# 本脚本负责把服务端源码、Node 运行时与生产依赖准备到 package/app/server/，
# 然后调用 pack.js 生成 .fpk（pack.js 会在 Windows 上正确保留 Unix 可执行位；
# 原先走 fnpack.exe 分支时 cmd/* 的 mode 位来自 NTFS，装到 NAS 上会无法执行）。
#
# 与原实现的区别：
#   - 每个原生命令都检查 $LASTEXITCODE（$ErrorActionPreference 管不到原生命令退出码），
#     原实现 fnpack 失败时会把上一次构建残留的 .fpk 改名成本次版本号并打印 Done
#   - curl.exe 加 -f：原先 404 错误页会被写进缓存文件，之后一直被当成有效缓存
#   - Node 版本从 fpk/node-version 单一来源读取，与 build.sh 保持一致
param(
    [string]$Version = "",
    [string]$NodeVersion = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$FpkDir = $PSScriptRoot                            # fpk/
$PkgDir = Join-Path $FpkDir "package"              # fpk/package
$ServerSrc = Join-Path $Root "server"
$StageServer = Join-Path $PkgDir "app\server"

function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$What)
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（exit $LASTEXITCODE）" }
}

# 读取 manifest 版本
$manifestPath = Join-Path $PkgDir "manifest"
$manifest = Get-Content $manifestPath -Raw
if (-not $Version) {
    if ($manifest -match '(?m)^version\s*=\s*(\S+)') { $Version = $Matches[1].Trim() } else { $Version = "1.0.0" }
}

# Node 版本单一来源
if (-not $NodeVersion) {
    $nvFile = Join-Path $FpkDir "node-version"
    if (Test-Path $nvFile) { $NodeVersion = (Get-Content $nvFile -Raw).Trim() } else { $NodeVersion = "v24.9.0" }
}

Write-Host "==> Packaging mediaiptv v$Version (Node $NodeVersion)"

# 1. 拷贝服务端源码（排除 node_modules / data / 日志）
Write-Host "==> [1/4] Copying server source..."
if (Test-Path $StageServer) { Remove-Item -Recurse -Force $StageServer }
New-Item -ItemType Directory -Force "$StageServer\app" | Out-Null
$items = @("src", "public", "package.json")
foreach ($i in $items) {
    Copy-Item -Recurse -Force (Join-Path $ServerSrc $i) (Join-Path $StageServer "app\$i")
}
# 带上 lockfile 才能用 npm ci 装出可复现的依赖
$lock = Join-Path $ServerSrc "package-lock.json"
if (Test-Path $lock) { Copy-Item -Force $lock (Join-Path $StageServer "app\package-lock.json") }

# 2. 安装生产依赖（纯 JS 依赖可跨平台复用）
Write-Host "==> [2/4] Installing production dependencies..."
Push-Location "$StageServer\app"
try {
    if (Test-Path "package-lock.json") {
        Invoke-Native "npm" @("ci", "--omit=dev", "--no-audit", "--no-fund") "npm ci"
    } else {
        Invoke-Native "npm" @("install", "--omit=dev", "--no-audit", "--no-fund") "npm install"
    }
} finally {
    Pop-Location
}

# 3. 下载 Node.js Linux 运行时（x86_64 / aarch64）
Write-Host "==> [3/4] Downloading Node.js $NodeVersion linux runtimes..."
$tmp = Join-Path $env:TEMP "mediaiptv-node"
New-Item -ItemType Directory -Force $tmp | Out-Null

# 先取官方 SHA-256 清单用于校验
$shaFile = Join-Path $tmp "SHASUMS256.txt"
Invoke-Native "curl.exe" @("-fsSL", "-o", $shaFile, "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt") "下载 SHASUMS256.txt"
$shaMap = @{}
foreach ($line in Get-Content $shaFile) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') { $shaMap[$Matches[2]] = $Matches[1].ToLower() }
}

$targets = @(
    @{ Arch = "x64";   Out = "node_x86_64" },
    @{ Arch = "arm64"; Out = "node_aarch64" }
)
foreach ($t in $targets) {
    $tar = "node-$NodeVersion-linux-$($t.Arch).tar.gz"
    $tarPath = Join-Path $tmp $tar
    # -f：404 时不要让错误页落盘并被当成有效缓存
    Invoke-Native "curl.exe" @("-fsSL", "-o", $tarPath, "https://nodejs.org/dist/$NodeVersion/$tar") "下载 $tar"

    $expected = $shaMap[$tar]
    if (-not $expected) { throw "SHASUMS256.txt 中没有 $tar 的哈希" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tarPath).Hash.ToLower()
    if ($actual -ne $expected) { throw "$tar SHA-256 不匹配（期望 $expected，实际 $actual）" }

    $extractDir = Join-Path $tmp "extract-$($t.Arch)"
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    New-Item -ItemType Directory -Force $extractDir | Out-Null
    Invoke-Native "tar" @("-xzf", $tarPath, "-C", $extractDir) "解压 $tar"
    Copy-Item (Join-Path $extractDir "node-$NodeVersion-linux-$($t.Arch)\bin\node") (Join-Path $StageServer $t.Out) -Force
    Write-Host "    $($t.Out) -> $([math]::Round((Get-Item (Join-Path $StageServer $t.Out)).Length / 1MB,1)) MB (SHA-256 已校验)"
}

# 4. 用 pack.js 打包（Windows 上唯一能正确保留 Unix 可执行位的方式）
Write-Host "==> [4/4] Building .fpk via pack.js ..."
$out = Join-Path $FpkDir "mediaiptv_all_v$Version.fpk"
if (Test-Path $out) { Remove-Item -Force $out }
Invoke-Native "node" @((Join-Path $FpkDir "pack.js"), $PkgDir, $out) "pack.js"
if (-not (Test-Path $out)) { throw "未生成 $out" }
Write-Host "==> Done: $out"

# 清掉历史版本的 fpk：它们只是构建中间产物（.gitignore 已排除），正式产物在 dist/。
# 原脚本只在开头删"当前版本名"那一个，于是每构建一版就在 fpk/ 里永久留一份 92MB 的副本
# —— 实测攒到过 8 个版本、736MB。build.sh 有同样的清理，两边保持一致。
Get-ChildItem -Path $FpkDir -Filter "mediaiptv_all_v*.fpk" -File |
    Where-Object { $_.FullName -ne $out } |
    ForEach-Object {
        Remove-Item -Force $_.FullName
        Write-Host "    已清理历史构建产物: $($_.Name)"
    }
