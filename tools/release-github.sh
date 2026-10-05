#!/bin/bash
# 把 dist/ 里最新的 APK 发布到 GitHub Release。
#
# 为什么需要它：客户端更新改走 GitHub 之后，版本信息必须跟着 Release 一起发 ——
# 客户端判断「有没有新版」用的是 versionCode，而 GitHub 的 tag 里只有 v1.11.15
# 这种名字。所以本脚本把元数据写进 Release 正文：
#
#     versionCode: 71
#     sha256: f4209714...
#     size: 22569629
#
# 服务端（server/src/services/githubRelease.js）再从正文里解析出来下发给客户端。
#
# 用法：
#   bash tools/release-github.sh                  # 发布 dist/ 里最新的那个版本
#   bash tools/release-github.sh --dry-run        # 只打印要做什么，不发请求
#   bash tools/release-github.sh --version 1.11.15
#   bash tools/release-github.sh --notes-file my-notes.md
#
# 凭据（二选一，都不会进仓库）：
#   tools/github.env（推荐，模板见 tools/github.env.example）：
#       GITHUB_REPO=yourname/mediaiptv
#       GITHUB_TOKEN=ghp_xxxxxxxx
#   或者环境变量 GITHUB_REPO / GITHUB_TOKEN。
#
# token 需要 repo 权限（公开仓库用 classic token 的 public_repo 即可）。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
DIST="$ROOT/dist"
NOTES="$ROOT/RELEASE_NOTES.md"
API="https://api.github.com"
UPLOAD="https://uploads.github.com"

VERSION=""
DRY=0
NOTES_FILE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:-}"; shift 2 ;;
        --dry-run) DRY=1; shift ;;
        --notes-file) NOTES_FILE="${2:-}"; shift 2 ;;
        --repo) GITHUB_REPO="${2:-}"; shift 2 ;;
        --token) GITHUB_TOKEN="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
        *) echo "未知参数：$1" >&2; exit 2 ;;
    esac
done

die() { echo "错误：$*" >&2; exit 1; }

# 凭据：环境变量 > tools/github.env
if [ -f "$HERE/github.env" ]; then
    # shellcheck disable=SC1090
    set -a; . "$HERE/github.env"; set +a
fi
GITHUB_REPO="${GITHUB_REPO:-}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

[ -n "$GITHUB_REPO" ] || die "没有配置仓库。请把 tools/github.env.example 复制成 tools/github.env 并填好 GITHUB_REPO=owner/repo（或传 --repo）"
[ -n "$GITHUB_TOKEN" ] || die "没有配置 token。同上，填 GITHUB_TOKEN=ghp_xxx（或传 --token）"
case "$GITHUB_REPO" in */*) ;; *) die "GITHUB_REPO 要写成 owner/repo，现在是：$GITHUB_REPO" ;; esac

# ---- 找要发布的 APK ----
[ -d "$DIST" ] || die "dist/ 不存在，先构建：bash android/build-on-nas.sh"
if [ -z "$VERSION" ]; then
    APK="$(ls -t "$DIST"/mediaiptv_v*.apk 2>/dev/null | head -1)"
    [ -n "$APK" ] || die "dist/ 里没有 mediaiptv_v*.apk，先构建"
    VERSION="$(basename "$APK" | sed -E 's/^mediaiptv_v(.*)\.apk$/\1/')"
else
    APK="$DIST/mediaiptv_v${VERSION}.apk"
    [ -f "$APK" ] || die "找不到 $APK"
fi
[ -f "$APK" ] || die "找不到 APK：$APK"

# ---- 从 APK 里读 versionCode（不手填：手填迟早填错，而填错的后果是客户端要么永远提示更新、要么永远收不到）----
VER_CODE="$(node -e "
try {
  const { readApkInfo } = require('$ROOT/server/src/services/apk.js');
  const i = readApkInfo('$APK');
  process.stdout.write(String(i.versionCode || ''));
} catch (e) { process.stdout.write(''); }
" 2>/dev/null)"
[ -n "$VER_CODE" ] || die "读不出 APK 的 versionCode（$APK 是不是没构建完/不是 APK？）"

SIZE="$(stat -c %s "$APK")"
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
TAG="v${VERSION}"

# ---- 更新说明：优先 RELEASE_NOTES.md 里这一版的段落 ----
if [ -n "$NOTES_FILE" ]; then
    [ -f "$NOTES_FILE" ] || die "找不到说明文件：$NOTES_FILE"
    BODY_NOTES="$(cat "$NOTES_FILE")"
elif [ -f "$NOTES" ]; then
    # 从 "## 1.11.15（..." 起，到下一个顶格 --- 为止
    BODY_NOTES="$(awk -v ver="$VERSION" '
        $0 ~ "^## " ver "（" { found = 1 }
        found && /^---[[:space:]]*$/ { exit }
        found { print }
    ' "$NOTES")"
    [ -n "$BODY_NOTES" ] || BODY_NOTES="（RELEASE_NOTES.md 里没找到 $VERSION 的段落，只发元数据）"
else
    BODY_NOTES="（没有 RELEASE_NOTES.md，只发元数据）"
fi

BODY="$(printf '%s\n\n---\nversionCode: %s\nsha256: %s\nsize: %s\n' "$BODY_NOTES" "$VER_CODE" "$SHA" "$SIZE")"

echo "==> 发布到 GitHub Release"
echo "    仓库      : $GITHUB_REPO"
echo "    tag       : $TAG"
echo "    版本      : $VERSION (versionCode $VER_CODE)"
echo "    APK       : $(basename "$APK")  $(numfmt --to=iec "$SIZE" 2>/dev/null || echo "${SIZE}B")"
echo "    sha256    : $SHA"
echo "    说明长度  : ${#BODY_NOTES} 字符"

if [ "$DRY" = "1" ]; then
    echo
    echo "---- 将要提交的 Release 正文 ----"
    echo "$BODY"
    echo "--------------------------------"
    echo "（--dry-run：没有发任何请求）"
    exit 0
fi

GH() { curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "User-Agent: MediaIptv-Release" "$@"; }

# tag 已存在就直接报错：覆盖已发布的版本会让已经装了那一版的客户端
# 看到"同一个版本号、不同内容"的包，sha256 校验会失败，比直接失败更难查。
if GH "$API/repos/$GITHUB_REPO/releases/tags/$TAG" >/dev/null 2>&1; then
    die "$TAG 已经存在。要重发请先在 GitHub 上删掉这个 Release 和 tag。"
fi

# 用 jq 组装 JSON 更稳；没有 jq 就退回 node（服务端本来就要 Node）
JSON_BODY="$(node -e '
const [notes, tag, name] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ tag_name: tag, name, body: notes, draft: false, prerelease: false }));
' "$BODY" "$TAG" "$VERSION")" || die "组装 Release 请求体失败"

RESP="$(GH -X POST "$API/repos/$GITHUB_REPO/releases" -d "$JSON_BODY")" || die "创建 Release 失败（token 权限或仓库名不对？）"
REL_ID="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).id||""))}catch(_){}})')"
[ -n "$REL_ID" ] || die "创建 Release 成功但读不到 id，响应：$RESP"
echo "    已创建 Release id=$REL_ID"

echo "==> 上传 APK（${SIZE}B，可能要一会儿）..."
GH -X POST "$UPLOAD/repos/$GITHUB_REPO/releases/$REL_ID/assets?name=$(basename "$APK")" \
   -H "Content-Type: application/vnd.android.package-archive" \
   --data-binary @"$APK" >/dev/null || die "上传 APK 失败"
echo "    上传完成"

# 同版本的服务端安装包（fpk）一并挂上去：GitHub Release 就是完整的发布记录，
# 换机器重装时不用再回头找构建产物。没有就跳过，不影响客户端更新。
FPK="$DIST/mediaiptv_all_v${VERSION}.fpk"
if [ -f "$FPK" ]; then
    echo "==> 上传服务端安装包 $(basename "$FPK")（$(numfmt --to=iec "$(stat -c %s "$FPK")" 2>/dev/null || echo "?")）..."
    GH -X POST "$UPLOAD/repos/$GITHUB_REPO/releases/$REL_ID/assets?name=$(basename "$FPK")" \
       -H "Content-Type: application/octet-stream" \
       --data-binary @"$FPK" >/dev/null || die "上传 fpk 失败"
    echo "    上传完成"
else
    echo "    （dist/ 里没有 mediaiptv_all_v${VERSION}.fpk，只发了 APK）"
fi

echo
echo "==> 发布成功：https://github.com/$GITHUB_REPO/releases/tag/$TAG"
echo "    服务端后台填仓库名后，客户端「检查更新」就会读到这个版本。"
echo "    提示：如果服务端已经读过一次 GitHub（缓存 30 分钟），保存一次配置即可立即刷新。"
