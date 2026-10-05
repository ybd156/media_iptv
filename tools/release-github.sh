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

# 元数据用 HTML 注释包起来。原因：更新说明里完全可能出现 `sha256: ...` 这种字眼
# （实测 1.11.16 的说明里就举了个例子），服务端整篇正则一抓就抓到示例、抓不到真值，
# 客户端下载后 sha256 校验失败、装不上。注释块让"哪几行是给机器读的"没有歧义。
BODY="$(printf '%s\n\n<!-- mediaiptv-meta\nversionCode: %s\nsha256: %s\nsize: %s\n-->\n' \
    "$BODY_NOTES" "$VER_CODE" "$SHA" "$SIZE")"

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

# 重试是必须的：fpk 有 90MB 上下，实测一次上传会被网络中途重置
# （curl: (56) Recv failure: Connection reset by peer），而这种失败重传一次就好了。
# 重试只针对瞬时错误（超时/连接重置），不会把 4xx 当成功。
GH() { curl -fsS --retry 3 --retry-delay 5 --retry-connrefused --connect-timeout 20 \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "User-Agent: MediaIptv-Release" "$@"; }

# ---- 取 Release：已存在就复用（补传缺失的资产），不存在才创建 ----
# 为什么允许复用而不是直接报错：fpk 有 90MB 上下，上传中途被网络重置是很常见的
# （实测一次就撞上）。这时候 Release 已经建好、APK 也传上去了，如果重跑只会报
# "tag 已存在"，人就得手工去网页上补传 —— 所以这里做成幂等：再跑一次补上缺的。
# 注意：已存在时**不覆盖**同名资产。覆盖会让已经装了那一版的客户端看到
# "同一个版本号、不同内容"的包，sha256 校验失败，比直接失败更难查。
REL_ID=""
EXISTING="$(GH "$API/repos/$GITHUB_REPO/releases/tags/$TAG" 2>/dev/null)" || EXISTING=""
if [ -n "$EXISTING" ]; then
    REL_ID="$(printf '%s' "$EXISTING" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).id||""))}catch(_){}})')"
fi

if [ -n "$REL_ID" ]; then
    echo "    $TAG 已存在（id=$REL_ID），本次只补传缺失的资产"
else
    # 用 node 组装 JSON（服务端本来就要 Node，不再多依赖 jq）
    JSON_BODY="$(node -e '
const [notes, tag, name] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ tag_name: tag, name, body: notes, draft: false, prerelease: false }));
' "$BODY" "$TAG" "$VERSION")" || die "组装 Release 请求体失败"

    RESP="$(GH -X POST "$API/repos/$GITHUB_REPO/releases" -d "$JSON_BODY")" || die "创建 Release 失败（token 权限或仓库名不对？）"
    REL_ID="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).id||""))}catch(_){}})')"
    [ -n "$REL_ID" ] || die "创建 Release 成功但读不到 id，响应：$RESP"
    echo "    已创建 Release id=$REL_ID"
fi

# 远端已有资产：输出 "id<TAB>name<TAB>size<TAB>state"
# **不能只看名字**：上传中途被重置会在远端留下 state=starter 的半成品残骸，
# 只看名字的话脚本会以为"已经传过了"而跳过，Release 上就挂着一个坏包 ——
# 比没有更糟（用户下载后装不上，还以为是包本身有问题）。
HAVE="$(GH "$API/repos/$GITHUB_REPO/releases/$REL_ID/assets?per_page=100" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const a of JSON.parse(s))console.log([a.id,a.name,a.size,a.state].join("\t"))}catch(_){}})')"

# 上传单个资产。成功返回 0，失败返回 1（**不直接退出**）——
# 由调用方决定这个资产是不是"非有不可"：APK 是客户端更新的必需品，失败必须中止；
# fpk 有 90MB+，网络差时传不上去是常事，不该把已经传好的 APK 一起判死刑。
upload_asset() {
    local file="$1" ctype="$2" name want line id size state
    name="$(basename "$file")"
    want="$(stat -c %s "$file")"
    line="$(printf '%s\n' "$HAVE" | awk -F'\t' -v n="$name" '$2==n{print; exit}')"
    if [ -n "$line" ]; then
        id="$(printf '%s' "$line" | cut -f1)"
        size="$(printf '%s' "$line" | cut -f3)"
        state="$(printf '%s' "$line" | cut -f4)"
        if [ "$state" = "uploaded" ] && [ "$size" = "$want" ]; then
            echo "    跳过 $name（远端已传完，${size} 字节）"
            return 0
        fi
        echo "    远端 $name 是半成品（state=$state / size=$size，本地是 $want），先删掉残骸"
        GH -X DELETE "$API/repos/$GITHUB_REPO/releases/assets/$id" >/dev/null || return 1
    fi
    echo "==> 上传 $name（$(numfmt --to=iec "$want" 2>/dev/null || echo "${want}B")）..."
    if GH -X POST "$UPLOAD/repos/$GITHUB_REPO/releases/$REL_ID/assets?name=$name" \
          -H "Content-Type: $ctype" \
          --data-binary @"$file" >/dev/null; then
        echo "    上传完成"
        return 0
    fi
    echo "    上传中断"
    return 1
}

upload_asset "$APK" "application/vnd.android.package-archive" \
    || die "APK 上传失败 —— 客户端更新依赖它，必须成功。网络恢复后重跑本脚本即可（会接着补传）"

# 同版本的服务端安装包（fpk）一并挂上去：GitHub Release 就是完整的发布记录，
# 换机器重装时不用再回头找构建产物。
# **失败只警告，不中止**：fpk 有 90MB 上下，实测在受限网络里每次传到 60MB 左右就被重置
# （限速到 1MB/s 也一样）。它不影响客户端更新，没必要把已经传好的 APK 一起判死刑。
FPK="$DIST/mediaiptv_all_v${VERSION}.fpk"
if [ -f "$FPK" ]; then
    if ! upload_asset "$FPK" "application/octet-stream"; then
        echo
        echo "    ⚠️ 服务端安装包没能传上去（$(numfmt --to=iec "$(stat -c %s "$FPK")" 2>/dev/null || echo "大文件")）。"
        echo "       APK 已经传好，客户端更新不受影响。服务端安装包可以直接用本地 dist/ 里的那个，"
        echo "       或者换到网络稳定的环境重跑本脚本（会只补传缺的这个，不会重复传 APK）。"
    fi
else
    echo "    （dist/ 里没有 mediaiptv_all_v${VERSION}.fpk，只发了 APK）"
fi

echo
echo "==> 发布完成：https://github.com/$GITHUB_REPO/releases/tag/$TAG"
echo "    服务端后台填仓库名后，客户端「检查更新」就会读到这个版本。"
echo "    提示：如果服务端已经读过一次 GitHub（缓存 30 分钟），保存一次配置即可立即刷新。"
