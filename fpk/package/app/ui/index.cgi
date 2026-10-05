#!/bin/bash
# 桌面图标点击入口：跳转到管理后台
set -u

# 与 cmd/* 保持一致地解析 TRIM_PKGVAR。原实现硬编码 /var/apps/mediaiptv/var，
# 非默认布局下读不到 server_port，图标会指向错误端口。
if [ -z "${TRIM_PKGVAR:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
    if [ -d "${APP_ROOT}/var" ]; then
        TRIM_PKGVAR="${APP_ROOT}/var"
    else
        TRIM_PKGVAR="/var/apps/mediaiptv/var"
    fi
fi

PORT="9527"
if [ -f "${TRIM_PKGVAR}/server_port" ]; then
    PORT=$(tr -d '\r\n' <"${TRIM_PKGVAR}/server_port")
fi
case "${PORT}" in
    ''|*[!0-9]*) PORT="9527" ;;
esac

# HOST 来自客户端可控的 HTTP_HOST，必须过滤后再拼进响应头：
# 原实现直接 echo 进 Location，可被 CR/LF 注入额外响应头，也是开放重定向。
HOST=$(echo "${HTTP_HOST:-}" | cut -d: -f1 | tr -cd 'A-Za-z0-9.\-')
[ -z "${HOST}" ] && HOST="127.0.0.1"

echo "Status: 302 Found"
echo "Location: http://${HOST}:${PORT}/admin"
echo ""
exit 0
