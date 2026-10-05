#!/bin/bash
# 安装回调沙箱测试：验证「自定义数据目录不可用」不再导致安装失败。
#
# 背景：应用以专用包用户运行，/vol<N> 下的用户目录对它不可写；向导里填的自定义
# 数据目录一旦建不出来，旧版 install_callback 会 exit 1，整个安装被判为失败：
#   mkdir: cannot create directory '/vol1/1000/docker': Permission denied
#  无法创建数据目录 /vol1/1000/docker/mediaiptv
# 这个脚本用假的 TRIM_* 环境直接跑 cmd/install_callback，检查各种输入下的退出码。
#
# 用法：bash fpk/test_install_callback.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="${HERE}/package"
CMD="${PKG}/cmd"
APPDEST="${PKG}/app"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mediaiptv-install-test.XXXXXX")"
PASS=0
FAIL=0
LAST_VAR=""

# 找一个既能写、又满足 install_callback 路径规则（/vol<N>/...）的目录做「合法自定义目录」用例。
# 找不到就跳过该用例（不误报失败）。项目自身目录在 /vol<N>/ 下时通常就是可写的。
WRITABLE_VOL=""
for cand in "${HERE}" "/vol1/1000" "/vol1" "/vol2"; do
    [ -d "${cand}" ] || continue
    probe="${cand}/.mediaiptv-test-probe.$$"
    if (umask 077 && : >"${probe}") 2>/dev/null; then
        rm -f "${probe}"
        WRITABLE_VOL="${cand}/.mediaiptv-test-data"
        break
    fi
done

run_case() {
    local name="$1" wizard="$2" expect_rc="$3" expect_record="$4" expect_text="$5"
    local var="${ROOT}/var-${name}"
    LAST_VAR="${var}"
    rm -rf "${var}"; mkdir -p "${var}"

    local out rc
    out=$(
        TRIM_APPDEST="${APPDEST}" TRIM_PKGVAR="${var}" TRIM_TEMP_LOGFILE="${ROOT}/${name}.tmplog" \
        wizard_data="${wizard}" server_port="9527" admin_password="secret123" \
        bash "${CMD}/install_callback" 2>&1
    )
    rc=$?

    local recorded="no"
    [ -f "${var}/wizard_data_path" ] && recorded="$(cat "${var}/wizard_data_path")"

    local ok=1
    [ "${rc}" = "${expect_rc}" ] || { ok=0; echo "  ✗ exit code: 期望 ${expect_rc} 实际 ${rc}"; }
    if [ "${expect_record}" = "-" ]; then
        [ "${recorded}" = "no" ] || { ok=0; echo "  ✗ 不应记录 wizard_data_path，实际 ${recorded}"; }
    else
        [ "${recorded}" = "${expect_record}" ] || { ok=0; echo "  ✗ wizard_data_path: 期望 ${expect_record} 实际 ${recorded}"; }
    fi
    if [ -n "${expect_text}" ]; then
        echo "${out}" | grep -qF "${expect_text}" || { ok=0; echo "  ✗ 输出里没有 '${expect_text}'"; }
    fi

    if [ "${ok}" = "1" ]; then
        echo "  ✓ ${name} (exit ${rc}, recorded=${recorded})"
        PASS=$((PASS + 1))
    else
        echo "  --- 实际输出 ---"; echo "${out}" | sed 's/^/      /'
        FAIL=$((FAIL + 1))
    fi
}

echo "== 安装回调沙箱测试 =="
echo "ROOT=${ROOT}"
echo
echo "[1] 向导留空（推荐路径：用应用默认目录）"
run_case "blank" "" 0 "-" "使用应用默认目录"

echo
echo "[2] 复现原始故障：一个建不出来的 /vol 路径"
UNWRITABLE="/vol1/1000/mediaiptv-should-not-exist/data"
if mkdir -p "${UNWRITABLE}" 2>/dev/null; then
    echo "  (注意：本机居然能创建 ${UNWRITABLE}，无法复现该场景，跳过)"
    rmdir "${UNWRITABLE}" 2>/dev/null || true
else
    run_case "unwritable" "${UNWRITABLE}" 0 "-" "不可用"
fi

echo
echo "[3] 合法且可写的自定义目录"
if [ -n "${WRITABLE_VOL}" ]; then
    run_case "writable" "${WRITABLE_VOL}" 0 "${WRITABLE_VOL}" "数据目录："
else
    echo "  (本机找不到可写的 /vol<N>/... 目录，跳过)"
fi

echo
echo "[4] 非法路径（不在 /vol 下）→ 回退，不失败"
run_case "outside" "/etc/mediaiptv" 0 "-" "不可用"

echo
echo "[5] 含 .. 的路径 → 回退，不失败"
run_case "dotdot" "/vol1/../../etc/mediaiptv" 0 "-" "不可用"

echo
echo "[6] 端口/密码写入仍然正常"
V="${LAST_VAR}"
if [ "$(cat "${V}/server_port" 2>/dev/null)" = "9527" ] && [ "$(cat "${V}/admin_password" 2>/dev/null)" = "secret123" ]; then
    echo "  ✓ server_port / admin_password 已写入"
    PASS=$((PASS + 1))
else
    echo "  ✗ 端口或密码未写入"; FAIL=$((FAIL + 1))
fi
echo "  admin_password 权限: $(stat -c '%a' "${V}/admin_password" 2>/dev/null)"

echo
echo "== 结果: ${PASS} 通过 / ${FAIL} 失败 =="
[ -n "${WRITABLE_VOL}" ] && rm -rf "${WRITABLE_VOL}" 2>/dev/null
rm -rf "${ROOT}" 2>/dev/null
exit $((FAIL > 0))
