# 清理构建产物与打包暂存（不碰源码与运行时数据）
# 用法: powershell -ExecutionPolicy Bypass -File clean.ps1 [-IncludeData] [-DryRun]
param([switch]$IncludeData, [switch]$DryRun)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

function Remove-Target {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path $Path)) { return }
    if ($DryRun) {
        $size = (Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
        Write-Host ("  [dry-run] 将删除 {0} ({1:N1} MB)" -f $Label, ($size / 1MB))
        return
    }
    Remove-Item -Recurse -Force $Path -ErrorAction SilentlyContinue
    if (Test-Path $Path) { Write-Host "  [!] 未能删除 $Label" -ForegroundColor Yellow }
    else { Write-Host "  已删除 $Label" }
}

Write-Host "==> 清理 Android 构建产物"
Remove-Target (Join-Path $Root "android\app\build") "android/app/build"
Remove-Target (Join-Path $Root "android\build") "android/build"
Remove-Target (Join-Path $Root "android\.gradle") "android/.gradle"

Write-Host "==> 清理 FPK 打包暂存与产物"
Remove-Target (Join-Path $Root "fpk\package\app\server") "fpk/package/app/server"
Remove-Target (Join-Path $Root "fpk\.cache") "fpk/.cache"
Get-ChildItem -Path (Join-Path $Root "fpk") -Filter "*.fpk" -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($DryRun) { Write-Host "  [dry-run] 将删除 $($_.Name)" }
    else { Remove-Item -Force $_.FullName; Write-Host "  已删除 $($_.Name)" }
}
if (-not $DryRun) { Remove-Item -Force (Join-Path $Root "fpk\package\.app.tgz.tmp") -ErrorAction SilentlyContinue }

Write-Host "==> 清理服务端依赖"
Remove-Target (Join-Path $Root "server\node_modules") "server/node_modules"

if ($IncludeData) {
    Write-Host "==> 清理运行时数据（-IncludeData）" -ForegroundColor Yellow
    Remove-Target (Join-Path $Root "server\data") "server/data"
} else {
    Write-Host "==> 保留 server\data（数据库/录像/日志）；如需一并删除请加 -IncludeData"
}

Write-Host "==> 完成"
