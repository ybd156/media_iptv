#!/bin/bash
# 清理构建产物与打包暂存（不碰源码与运行时数据）
# 用法: ./clean.sh [--include-data] [--dry-run]
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
INCLUDE_DATA=0
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --include-data) INCLUDE_DATA=1 ;;
        --dry-run) DRY_RUN=1 ;;
    esac
done

rm_target() {
    [ -e "$1" ] || return 0
    if [ "$DRY_RUN" = "1" ]; then
        echo "  [dry-run] 将删除 $2"
        return 0
    fi
    rm -rf "$1" 2>/dev/null || true
    if [ -e "$1" ]; then echo "  [!] 未能删除 $2"; else echo "  已删除 $2"; fi
}

echo "==> 清理 Android 构建产物"
rm_target "${ROOT}/android/app/build" "android/app/build"
rm_target "${ROOT}/android/build" "android/build"
rm_target "${ROOT}/android/.gradle" "android/.gradle"

echo "==> 清理 FPK 打包暂存与产物"
rm_target "${ROOT}/fpk/package/app/server" "fpk/package/app/server"
rm_target "${ROOT}/fpk/.cache" "fpk/.cache"
for f in "${ROOT}"/fpk/*.fpk; do
    [ -e "$f" ] || continue
    if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] 将删除 $(basename "$f")"; continue; fi
    rm -f "$f" && echo "  已删除 $(basename "$f")"
done
[ "$DRY_RUN" = "1" ] || rm -f "${ROOT}/fpk/package/.app.tgz.tmp"

echo "==> 清理服务端依赖"
rm_target "${ROOT}/server/node_modules" "server/node_modules"

if [ "$INCLUDE_DATA" = "1" ]; then
    echo "==> 清理运行时数据（--include-data）"
    rm_target "${ROOT}/server/data" "server/data"
else
    echo "==> 保留 server/data（数据库/录像/日志）；如需一并删除请加 --include-data"
fi

echo "==> 完成"
