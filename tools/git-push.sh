#!/bin/bash
# 把项目初始化成 git 仓库并推送到 GitHub。
#
# 为什么单独做成一个脚本、而不是我直接建好仓库：
#   DSH 沙箱（就是平时跑构建的那个环境）里 git 用不了 —— 它把工作区里**新建的文件**
#   呈现成 mode 000，git 连自己刚写的 .git/config 都读不回来（报
#   "could not set 'core.filemode'"，然后 "not a git repository"）。
#   在普通终端里（你自己 SSH 上去，或在你自己的电脑上）没有这个问题。
#
# 用法：
#   bash tools/git-push.sh https://github.com/你的用户名/mediaiptv.git
#   bash tools/git-push.sh                      # 已经配过 remote 时，只提交并推送
#
# 推送时会要用户名 + 密码，密码处填 Personal Access Token（勾 repo 权限），不是账号密码。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT" || exit 1

REMOTE="${1:-}"
BRANCH="main"

die() { echo "错误：$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "没装 git"

# ---- 初始化 ----
if [ ! -d .git ]; then
    echo "==> 初始化本地仓库"
    git init -q || die "git init 失败（如果你在 DSH 沙箱里跑，请换到普通终端）"
    git branch -M "$BRANCH" 2>/dev/null || true
    git config user.name  "$(git config --global user.name  || echo MediaIptv)"
    git config user.email "$(git config --global user.email || echo mediaiptv@users.noreply.github.com)"
else
    echo "==> 已有本地仓库，跳过 init"
fi

if [ -n "$REMOTE" ]; then
    if git remote get-url origin >/dev/null 2>&1; then
        git remote set-url origin "$REMOTE"
    else
        git remote add origin "$REMOTE"
    fi
    echo "==> remote origin = $REMOTE"
fi

# ---- 安全检查：敏感文件绝不能被跟踪 ----
echo "==> 暂存所有改动"
git add -A

# ---- 可读性预检 ----
# 工作区里有相当一部分文件是 root 拥有、权限 000（在 DSH 沙箱里由挂载层呈现）。
# 以普通用户跑 git 时它们**读不到**，而 git 遇到读不了的文件只会警告一句就跳过 ——
# 结果是仓库里静默缺文件，clone 下来才发现构建不了。所以先查一遍，让人有选择权。
echo "==> 可读性预检"
UNREAD="$(find . -path ./.git -prune -o -path ./node_modules -prune -o \
    -path ./server/node_modules -prune -o -type f ! -readable -print 2>/dev/null | head -8)"
if [ -n "$UNREAD" ]; then
    echo "   以下文件当前用户读不了，git 会跳过它们："
    printf '     %s\n' $UNREAD
    echo "   解决（在项目根目录执行）："
    echo "     sudo chown -R \$(id -u):\$(id -g) . && chmod -R u+rwX ."
    echo "   然后重新跑本脚本。"
    exit 1
fi
echo "   OK   所有需要提交的文件都可读"

echo "==> 安全检查（下面每项都应该是「无」）"
BAD=0
for pat in '\.jks$' 'signing\.env$' 'github\.env$' '^server/data/' '^dist/' '^fpk/\.cache/' 'node_modules/' '^android/app/build/' 'local\.properties$' '\.keystore$' '\.p12$'; do
    hits="$(git diff --cached --name-only | grep -E "$pat" | head -3)"
    if [ -z "$hits" ]; then
        printf "   OK   %-22s 无\n" "$pat"
    else
        printf "   !!!  %-22s 有：%s\n" "$pat" "$hits"
        BAD=1
    fi
done
if [ "$BAD" = "1" ]; then
    die "有敏感文件被暂存了。检查 .gitignore 后重来（不要 push！）"
fi

# ---- 提交 ----
if git diff --cached --quiet; then
    echo "==> 没有需要提交的改动"
else
    COUNT="$(git diff --cached --name-only | wc -l)"
    echo "==> 提交 $COUNT 个文件"
    git commit -q -m "MediaIptv: 初始提交（客户端 + 服务端 + fnOS 打包 + 构建脚本）" || die "提交失败"
fi

# ---- 推送 ----
if ! git remote get-url origin >/dev/null 2>&1; then
    echo
    echo "还没配远端。建好 GitHub 仓库后执行："
    echo "    bash tools/git-push.sh https://github.com/你的用户名/mediaiptv.git"
    exit 0
fi

echo "==> 推送到 origin/$BRANCH（用户名填 GitHub 账号，密码处填 Personal Access Token）"
git push -u origin "$BRANCH" || die "推送失败（token 权限？仓库名？网络？）"

echo
echo "==> 完成：$(git remote get-url origin)"
echo "    下一步：按 GITHUB_SETUP.md 第 3 步在后台填仓库名，第 4 步发布第一个 Release。"
