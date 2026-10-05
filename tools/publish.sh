#!/bin/bash
# 把构建出来的安装文件收进 dist/，并且**只保留最近两个版本**。
#
# 为什么要有这个：
#   - Android 构建产物的名字是 app-release.apk 这种，看不出是哪个版本；
#     侧载到电视盒子上时根本分不清。这里统一成带版本号的规范名。
#   - 每次构建都留一份，目录会无限膨胀；安装文件只留最近两个版本就够回滚了。
#
# 命名（与 fpk 的 mediaiptv_all_v1.5.0.fpk 保持一致）：
#   dist/mediaiptv_all_v1.5.0.fpk     fnOS 安装包
#   dist/mediaiptv_v1.5.0.apk         Android 安装包（通用包，已签名）
#
# 只发布**一个** APK：不按 ABI 拆分（build.gradle.kts 里已关掉 abi splits）、
# 不收 debug 包。侧载永远只用这一个，多出来的只会让人发错包。
#
# 用法：
#   bash tools/publish.sh                 # 收集 + 清理，保留最近 2 个版本
#   bash tools/publish.sh --keep 3        # 保留 3 个版本
#   bash tools/publish.sh --dry-run       # 只打印要做什么，不动文件
#   bash tools/publish.sh --list          # 只看 dist/ 现状
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
MANIFEST="$ROOT/fpk/package/manifest"
DIST="$ROOT/dist"
APK_DIR="$ROOT/android/app/build/outputs/apk"
FPK_DIR="$ROOT/fpk"

KEEP=2
DRY=0
LIST=0
while [ $# -gt 0 ]; do
    case "$1" in
        --keep) KEEP="${2:-2}"; shift 2 ;;
        --dry-run) DRY=1; shift ;;
        --list) LIST=1; shift ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "未知参数：$1" >&2; exit 2 ;;
    esac
done

say() { echo "$*"; }
act() { [ "$DRY" = "1" ] && echo "  [dry-run] $*" || eval "$*"; }

[ -f "$MANIFEST" ] || { echo "找不到 $MANIFEST" >&2; exit 1; }
VERSION="$(grep -E '^version[[:space:]]*=' "$MANIFEST" | head -1 | cut -d= -f2- | tr -d ' \r')"
[ -n "$VERSION" ] || { echo "$MANIFEST 里没有 version" >&2; exit 1; }

# 从文件名里抠出版本号：mediaiptv_all_v1.3.0.fpk / mediaiptv_v1.3.0_universal.apk
file_version() { printf '%s' "$1" | sed -n 's/.*_v\([0-9][0-9.]*[0-9]\).*/\1/p'; }

if [ "$LIST" = "1" ]; then
    say "dist/ 现状（当前版本 $VERSION，保留最近 $KEEP 个版本）："
    [ -d "$DIST" ] || { say "  （还没有 dist/）"; exit 0; }
    for f in "$DIST"/*; do
        [ -f "$f" ] || continue
        printf '  %-46s v%s  %s\n' "$(basename "$f")" "$(file_version "$(basename "$f")")" "$(du -h "$f" | cut -f1)"
    done
    exit 0
fi

say "版本号（来自 fpk/package/manifest）：$VERSION"
mkdir -p "$DIST"

# ---------------------------------------------------------------- 1. 收集 APK
added=0
# 从 APK 里读出真实版本号（复用服务端那份解析器，避免维护第二份 AXML 解析代码）。
# 为什么要读真实值而不是按 manifest 版本硬改名：构建输出目录里会残留上一次的产物
# （比如上次是未签名的 1.3.0、这次是签名的 1.4.0，文件名不同所以同时存在），
# 硬改名会把旧包贴上"1.4.0"的标签发出去 —— 这个坑已经踩过一次。
APK_PARSER="$ROOT/server/src/services/apk.js"
apk_info() {
    node -e '
      try {
        const i = require(process.argv[1]).readApkInfo(process.argv[2]);
        process.stdout.write([i.versionCode, i.versionName, i.packageName].join("|"));
      } catch (e) { process.stdout.write(""); }
    ' "$APK_PARSER" "$1" 2>/dev/null
}

# 是否已签名。未签名的 APK 在 Android 上**装不上**，收进 dist/ 或当更新包发出去
# 都是纯粹的误导（踩过一次：1.3.0 的三个 release 包未签名却躺在发布目录里）。
apk_signed() {
    node -e '
      try {
        process.stdout.write(require(process.argv[1]).isApkSigned(process.argv[2]) ? "yes" : "no");
      } catch (e) { process.stdout.write("no"); }
    ' "$APK_PARSER" "$1" 2>/dev/null
}

declare -A chosen=()   # target -> 源文件（同一目标优先取已签名的）
# 只收 release 一个变体：不分 ABI（build.gradle.kts 里已关掉 abi splits），
# 也不收 debug 包 —— 侧载永远只用这一个，多出来的只会让发布目录难以分辨。
for variant in release; do
    d="$APK_DIR/$variant"
    [ -d "$d" ] || continue
    for f in "$d"/*.apk; do
        [ -f "$f" ] || continue
        fname="$(basename "$f")"
        # app-release.apk / app-release-unsigned.apk（旧版按 ABI 拆分的产物不再收）
        case "$fname" in
            app-release.apk|app-release-unsigned.apk) ;;
            *) say "  ! 跳过（不再按 ABI 发布）：$fname"; continue ;;
        esac

        info="$(apk_info "$f")"
        if [ -z "$info" ]; then
            say "  ! 跳过（读不出 APK 信息）：$fname"
            continue
        fi
        IFS='|' read -r code name pkg <<<"$info"
        # 只收正式包：debug 变体（包名以 .debug 结尾）不再发布
        case "$pkg" in
            *.debug)
                say "  ! 跳过 debug 包：$fname（包名 $pkg）"
                continue
                ;;
        esac

        if [ "$name" != "$VERSION" ]; then
            say "  ! 跳过旧版本产物：$fname（实际 v$name / code=$code，当前版本 v$VERSION）"
            say "    构建输出目录里混了旧产物，建议跑一次 android/build-on-nas.sh --clean"
            continue
        fi

        # 未签名的包装不上，直接不收 —— 与其发布一个装不上的文件，不如在这里拦下来
        if [ "$(apk_signed "$f")" != "yes" ]; then
            say "  ! 跳过未签名的 APK：$fname"
            say "    未签名的 APK 在 Android 上装不上。检查 android/release.jks 是否存在、"
            say "    android/gradle.properties 里的 RELEASE_KEY_ALIAS / 密码是否正确。"
            continue
        fi

        chosen["mediaiptv_v${name}.apk"]="$f"
    done
done

for target in $(printf '%s\n' "${!chosen[@]}" | sort); do
    act "cp -f '${chosen[$target]}' '$DIST/$target'"
    say "  + $target"
    added=$((added + 1))
done
[ "$added" -gt 0 ] || say "  （没找到当前版本的 APK 产物，先跑 android/build-on-nas.sh）"

# ---------------------------------------------------------------- 2. 收集 FPK
fpk_src="$FPK_DIR/mediaiptv_all_v${VERSION}.fpk"
if [ -f "$fpk_src" ]; then
    act "cp -f '$fpk_src' '$DIST/mediaiptv_all_v${VERSION}.fpk'"
    say "  + mediaiptv_all_v${VERSION}.fpk"
else
    say "  （没找到 $fpk_src，先跑 fpk/build.sh）"
fi

# ---------------------------------------------------------------- 3. 只留最近 N 个版本
say ""
say "清理：只保留最近 $KEEP 个版本"
mapfile -t versions < <(
    for f in "$DIST"/*; do
        [ -f "$f" ] || continue
        # 必须带换行：file_version 用 printf '%s' 返回不带换行的值，
        # 直接拼给 sort 会把所有版本挤成一行，mapfile 就只拿到 1 个元素。
        printf '%s\n' "$(file_version "$(basename "$f")")"
    done | grep -E '^[0-9]' | sort -uV
)
if [ "${#versions[@]}" -le "$KEEP" ]; then
    say "  当前只有 ${#versions[@]} 个版本，不用删"
else
    keep_from=$(( ${#versions[@]} - KEEP ))
    declare -A keep=()
    for ((i = keep_from; i < ${#versions[@]}; i++)); do keep["${versions[$i]}"]=1; done
    say "  保留：${!keep[*]}"
    removed=0
    for f in "$DIST"/*; do
        [ -f "$f" ] || continue
        v="$(file_version "$(basename "$f")")"
        if [ -z "${keep[$v]:-}" ]; then
            act "rm -f '$f'"
            say "  - 删除旧版本 $(basename "$f")"
            removed=$((removed + 1))
        fi
    done
    [ "$removed" -gt 0 ] || say "  没有需要删的"
fi

say ""
say "dist/ 里现有："
for f in "$DIST"/*; do
    [ -f "$f" ] || continue
    printf '  %-46s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
