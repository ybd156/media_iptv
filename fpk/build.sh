#!/bin/bash
# MediaIptv fnOS FPK 打包脚本 (Linux/macOS)
#
# 与原实现的区别：
#   - curl 一律加 -f：原先 404 的错误页会被当成 tarball 写入，直到 tar 才报出难懂的错
#   - 校验 Node 官方 SHA-256；下载的 fnpack 二进制会打印哈希供核对
#   - trap 清理临时目录；下载缓存到 .cache/，不再每次重下约 100MB
#   - 打包前显式设置 cmd/wizard/config/ui 的可执行位（fnOS 实际执行的是 cmd/*）
#   - 解析 manifest 时去掉 CR，避免产物名带上 \r 导致改名静默失败却仍打印成功
#   - 结尾校验产物真实存在，否则以非 0 退出
set -euo pipefail

WORKDIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$WORKDIR")"
PACKAGE_DIR="${WORKDIR}/package"
STAGE="${PACKAGE_DIR}/app/server"
NODE_VERSION="${NODE_VERSION:-$(tr -d '\r\n' <"${WORKDIR}/node-version" 2>/dev/null || echo v24.9.0)}"
# 默认两个架构都打；只要一个时可用 ARCHS="arm64" ./build.sh
ARCHS="${ARCHS:-x64 arm64}"
CACHE_DIR="${CACHE_DIR:-${WORKDIR}/.cache}"

# manifest 现在应当是 LF；这里仍然 tr 掉 CR，兼容手工编辑/Windows 检出
read_manifest() {
    grep -w "^$1" "${PACKAGE_DIR}/manifest" | head -n 1 | awk -F= '{print $2}' | tr -d '\r' | xargs
}
APPNAME=$(read_manifest appname)
VERSION=$(read_manifest version)
PLATFORM=$(read_manifest platform)
echo "==> Packaging: ${APPNAME} v${VERSION} [${PLATFORM}] arch=[${ARCHS}]"

TMP="$(mktemp -d)"
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

echo "==> [1/4] Copying server source..."
rm -rf "${STAGE}"
mkdir -p "${STAGE}/app"
cp -r "${ROOT}/server/src" "${ROOT}/server/public" "${ROOT}/server/package.json" "${STAGE}/app/"
# 带上 lockfile 才能用 npm ci 装出可复现的依赖
[ -f "${ROOT}/server/package-lock.json" ] && cp "${ROOT}/server/package-lock.json" "${STAGE}/app/"

echo "==> [2/4] Installing production dependencies..."
if [ -f "${STAGE}/app/package-lock.json" ]; then
    (cd "${STAGE}/app" && npm ci --omit=dev --no-audit --no-fund)
else
    (cd "${STAGE}/app" && npm install --omit=dev --no-audit --no-fund)
fi

echo "==> [3/4] Downloading Node.js ${NODE_VERSION} linux runtimes..."
mkdir -p "${CACHE_DIR}"
curl -fsSL -o "${TMP}/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
for arch in ${ARCHS}; do
    case "${arch}" in
        x64)   out="node_x86_64" ;;
        arm64) out="node_aarch64" ;;
        *) echo "不支持的架构: ${arch}"; exit 1 ;;
    esac
    tar="node-${NODE_VERSION}-linux-${arch}.tar.gz"
    if [ ! -f "${CACHE_DIR}/${tar}" ]; then
        curl -fsSL -o "${CACHE_DIR}/${tar}" "https://nodejs.org/dist/${NODE_VERSION}/${tar}"
    fi
    # 官方 SHA-256 校验：不校验就 chmod +x 执行一个网络下载的二进制，风险过大
    (cd "${CACHE_DIR}" && grep " ${tar}\$" "${TMP}/SHASUMS256.txt" | sha256sum -c -)
    tar -xzf "${CACHE_DIR}/${tar}" -C "${TMP}"
    cp "${TMP}/node-${NODE_VERSION}-linux-${arch}/bin/node" "${STAGE}/${out}"
    chmod 755 "${STAGE}/${out}"
    echo "    ${out} -> $(du -m "${STAGE}/${out}" | cut -f1) MB"
done

echo "==> [3.5/4] Setting executable bits..."
# fnOS 执行的是 cmd/* 与 app/ui/*.cgi；pack.js 在 Windows 侧会补偿，
# 但 fnpack 路径完全依赖磁盘 mode 位。
# wizard/ 与 config/ 是框架读取的 JSON 描述文件，保持 644。
chmod 755 "${PACKAGE_DIR}"/cmd/* 2>/dev/null || true
chmod 755 "${PACKAGE_DIR}"/app/ui/*.cgi 2>/dev/null || true
[ -x "${PACKAGE_DIR}/cmd/main" ] || { echo "cmd/main 不可执行，打包中止"; exit 1; }

echo "==> [4/4] Building .fpk ..."
cd "${WORKDIR}"
if command -v fnpack >/dev/null 2>&1; then
    FNPACK="$(command -v fnpack)"
elif [ -x "${WORKDIR}/fnpack" ]; then
    FNPACK="${WORKDIR}/fnpack"
else
    echo "fnpack 未找到，正在下载..."
    curl -fsSL -o "${WORKDIR}/fnpack" "https://static2.fnnas.com/fnpack/fnpack-1.0.4-linux-amd64"
    chmod +x "${WORKDIR}/fnpack"
    actual="$(sha256sum "${WORKDIR}/fnpack" | cut -d' ' -f1)"
    if [ -n "${FNPACK_SHA256:-}" ]; then
        [ "${actual}" = "${FNPACK_SHA256}" ] || { echo "fnpack SHA-256 不匹配（期望 ${FNPACK_SHA256}，实际 ${actual}）"; exit 1; }
        echo "    fnpack SHA-256 校验通过"
    else
        echo "    [!] 未提供 FNPACK_SHA256，未校验。实际哈希：${actual}"
        echo "        建议设置 FNPACK_SHA256=<哈希> 后重新构建以启用校验。"
    fi
    FNPACK="${WORKDIR}/fnpack"
fi

rm -f "${WORKDIR}/${APPNAME}.fpk" "${WORKDIR}/${APPNAME}_${PLATFORM}_v${VERSION}.fpk"
"${FNPACK}" build --directory "${PACKAGE_DIR}"

OUTFILE="${APPNAME}_${PLATFORM}_v${VERSION}.fpk"
if [ -f "${APPNAME}.fpk" ]; then
    mv "${APPNAME}.fpk" "${OUTFILE}"
fi
if [ ! -f "${OUTFILE}" ]; then
    echo "打包失败：未生成 ${OUTFILE}"
    exit 1
fi
echo "==> Build Complete: ${OUTFILE}"
echo "    sha256: $(sha256sum "${OUTFILE}" | cut -d' ' -f1)"

# 收进 dist/ 并只保留最近两个版本（命名与保留策略见 tools/publish.sh）
if [ -x "${ROOT}/tools/publish.sh" ]; then
    echo
    bash "${ROOT}/tools/publish.sh"
fi

# 清掉历史版本的 fpk。
# 正式产物由 tools/publish.sh 收进 dist/ 并按策略只留最近两个版本，
# fpk/ 下的这些只是构建中间产物（.gitignore 里已排除）。
# 原脚本只在开头按“当前版本名”删那两个文件，于是每构建一版就在 fpk/ 里永久留一份 92MB 的副本
# —— 实测这里攒到过 8 个版本、736MB。
shopt -s nullglob
for old in "${WORKDIR}/${APPNAME}_${PLATFORM}_v"*.fpk; do
    [ "$(basename "${old}")" = "${OUTFILE}" ] && continue
    rm -f "${old}"
    echo "    已清理历史构建产物: $(basename "${old}")"
done
shopt -u nullglob
