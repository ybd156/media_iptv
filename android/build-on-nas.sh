#!/bin/bash
# 在飞牛 NAS 上稳定打出 MediaIptv 的 APK。
#
# ── 为什么要这么写 ────────────────────────────────────────────────────────────
# 这台 NAS（Intel N100 / Debian 12 / 内核 6.18.18.c1107-trim）上，JVM 会**随机**
# 在 native 代码里 SIGSEGV：崩过 GC 线程（G1 / Parallel / Serial 三种都崩过），
# 也崩过普通 JIT 编译后的 Java 代码（HashMap.resize、VfsRelativePath.normalizeRoot）。
# 实测排除过：不是内存条坏（EDAC 计数 0）、不是 JVM 普遍不可用（自写 GC 压力程序
# 单 JVM 3G 堆 + 强制大页 12.7 万轮不崩、4 个 JVM 并发 8G 堆也不崩）。
# 换 JDK（Temurin/Corretto）、换 GC、关文件监视都只是**降低概率**，不能根除：
# 同一套「成功过」的参数原样重跑仍会崩（成功率大致 1/4 量级）。
#
# 所以本脚本不假装能修好 JVM，而是把「稳定」建立在三件事上：
#   1) 固定用一套降低崩溃概率的参数（单 JVM、SerialGC、关文件监视与插桩 agent）；
#   2) 崩了自动重试 —— 崩溃都发生在头 2 分钟内，而 Gradle 的增量状态与构建缓存
#      会保留已完成的工作，所以重试是**有进展**的，不是原地掷骰子；
#   3) 每次都用 aapt2 验收产物里的 versionCode/versionName，只有真的对才报成功
#      （这台机器上已经出过「构建成功但 versionName 静默变成 1.0.0」的事故）。
#
# 想从根上减少崩溃概率，可以（需要 root）把透明大页从 always 改成 madvise：
#   echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
#   echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/defrag
# 注意：**实测这条对崩溃率没有可见改善**（改完仍 2/2 崩），所以脚本不依赖它，
# 也不把它当成修复。留着只因为它是公认的 JVM 不稳定诱因、成本几乎为零。
#
# ── 用法 ─────────────────────────────────────────────────────────────────────
#   bash android/build-on-nas.sh                 # 打 release（未签名）
#   bash android/build-on-nas.sh --debug         # 打 debug
#   bash android/build-on-nas.sh --attempts 10   # 最多尝试 10 次（默认 6）
#   bash android/build-on-nas.sh --clean         # 删掉工作副本重建（工具链缓存保留）
#   bash android/build-on-nas.sh --fresh         # 禁用构建缓存 + 强制全量重跑
#                                                # （验证用；也用于崩溃率对比）
#   APK_CACHE_DIR=/vol1/apk-cache bash android/build-on-nas.sh   # 固定缓存位置
#
# 缓存位置是**探测**出来的，不写死：优先 $HOME/.cache/mediaiptv-android，
# 其次 /vol1/1000/.cache/mediaiptv-android，最后才退到 /tmp/mediaiptv-android。
# 原因：人类用户 SSH 进来跑时 $HOME 可写且重启不丢；DSH 沙箱里的 agent 只有
# 项目目录和 /tmp 可写，$HOME 是只读的。想固定就用 APK_CACHE_DIR。
#
# 首次运行会下载 JDK 17 + Android SDK（约 620MB）以及 Gradle 与依赖（约 900MB）。
# 依赖：bash / curl / tar / unzip。
set -uo pipefail

ATTEMPTS=6
VARIANT=release
CLEAN=0
FRESH=0
while [ $# -gt 0 ]; do
    case "$1" in
        --debug) VARIANT=debug; shift ;;
        --release) VARIANT=release; shift ;;
        --attempts) ATTEMPTS="${2:-6}"; shift 2 ;;
        --clean) CLEAN=1; shift ;;
        --fresh) FRESH=1; shift ;;
        -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
        *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
    esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
MANIFEST="$ROOT/fpk/package/manifest"

# ── 工具链缓存放哪 ────────────────────────────────────────────────────────────
# 原则：优先放「重启不会丢」的位置，探测失败才退到 /tmp。
# 这台 NAS 上两种运行身份的可写位置不同：
#   - 人类用户 SSH 进来跑：$HOME 可写（fnOS 下是 /vol1/1000），缓存能长期留着
#   - DSH 沙箱里的 agent 跑：只有项目目录和 /tmp 可写，$HOME 是只读的
# 所以探测而不是写死。要固定位置就设 APK_CACHE_DIR。
pick_cache_dir() {
    if [ -n "${APK_CACHE_DIR:-}" ]; then printf '%s\n' "$APK_CACHE_DIR"; return; fi
    local cand parent
    for cand in "${HOME:-}/.cache/mediaiptv-android" "/vol1/1000/.cache/mediaiptv-android" "/tmp/mediaiptv-android"; do
        case "$cand" in /*) ;; *) continue ;; esac
        parent="$(dirname "$cand")"
        mkdir -p "$parent" 2>/dev/null || continue
        if (umask 077 && : >"$parent/.mediaiptv-wtest.$$") 2>/dev/null; then
            rm -f "$parent/.mediaiptv-wtest.$$"
            printf '%s\n' "$cand"
            return
        fi
    done
    printf '%s\n' "/tmp/mediaiptv-android"
}
CACHE="$(pick_cache_dir)"
JDK="$CACHE/jdk"
SDK="$CACHE/sdk"
WORK="$CACHE/work"

# 沙箱/无 HOME 写权限的环境下，把这些都指到可写目录，否则 Gradle 与 sdkmanager
# 会因为写不了 $HOME/.gradle、$HOME/.android 而报一堆看不懂的 IO 异常。
export ANDROID_USER_HOME="$CACHE/android-home"
export GRADLE_USER_HOME="$CACHE/gradle-home"
export JAVA_HOME="$JDK"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="$JAVA_HOME/bin:$PATH"

JDK_URL="${APK_JDK_URL:-https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse}"
CMDTOOLS_URL="${APK_CMDTOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip}"
BUILD_TOOLS="35.0.0"
PLATFORM="android-35"

say() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "错误：$*" >&2; exit 1; }

# ---------------------------------------------------------------- 版本号来源
[ -f "$MANIFEST" ] || die "找不到版本号来源 $MANIFEST"
EXPECT_VERSION="$(grep -E '^version[[:space:]]*=' "$MANIFEST" | head -1 | cut -d= -f2- | tr -d ' \r')"
[ -n "$EXPECT_VERSION" ] || die "$MANIFEST 里没有 version 字段"
# versionCode 是手工维护的，从 build.gradle.kts 读出来做验收
EXPECT_CODE="$(grep -E '^[[:space:]]*versionCode[[:space:]]*=' "$HERE/app/build.gradle.kts" | head -1 | cut -d= -f2- | tr -d ' \r')"
say "目标：variant=$VARIANT versionName=$EXPECT_VERSION versionCode=$EXPECT_CODE"

# ---------------------------------------------------------------- 依赖工具链
ensure_tools() {
    mkdir -p "$CACHE" "$ANDROID_USER_HOME" "$GRADLE_USER_HOME"

    if [ ! -x "$JDK/bin/java" ]; then
        say "下载 JDK 17 到 $JDK ..."
        curl -fsSL -o "$CACHE/jdk.tar.gz" "$JDK_URL" || die "JDK 下载失败"
        mkdir -p "$JDK"
        tar -xzf "$CACHE/jdk.tar.gz" -C "$JDK" --strip-components=1 || die "JDK 解压失败"
        rm -f "$CACHE/jdk.tar.gz"
    fi
    say "JDK: $("$JDK/bin/java" -version 2>&1 | head -1)"

    if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
        say "下载 Android cmdline-tools ..."
        curl -fsSL -o "$CACHE/cmdtools.zip" "$CMDTOOLS_URL" || die "cmdline-tools 下载失败"
        mkdir -p "$SDK/cmdline-tools"
        unzip -q -o "$CACHE/cmdtools.zip" -d "$SDK/cmdline-tools" || die "cmdline-tools 解压失败"
        [ -d "$SDK/cmdline-tools/cmdline-tools" ] && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
        rm -f "$CACHE/cmdtools.zip"
    fi
    if [ ! -d "$SDK/platforms/$PLATFORM" ] || [ ! -d "$SDK/build-tools/$BUILD_TOOLS" ]; then
        say "安装 platform-tools / $PLATFORM / build-tools $BUILD_TOOLS ..."
        yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1
        "$SDK/cmdline-tools/latest/bin/sdkmanager" --install \
            "platform-tools" "platforms;$PLATFORM" "build-tools;$BUILD_TOOLS" 2>&1 | tail -2
    fi
    [ -d "$SDK/platforms/$PLATFORM" ] || die "Android SDK 安装不完整（缺 platforms/$PLATFORM）"
    [ -x "$SDK/build-tools/$BUILD_TOOLS/aapt2" ] || die "Android SDK 安装不完整（缺 aapt2）"
    say "SDK: $SDK"
}

# ---------------------------------------------------------------- 权限修复
# 这个工作区（DSH 沙箱挂载）里，**任何写文件的操作**都可能把文件留成 mode 000：
# 实测 Edit 工具、sed -i 都会（属主仍是当前用户，只是权限位丢了）。
# 后果很隐蔽：tar 同步源码时报 "Cannot open: Permission denied" 直接中断构建，
# 而错误信息指向的是源码文件，看起来像"文件坏了"。
# 这里统一修一遍 —— 只动自己拥有的，root 拥有的那些实际可读、不用碰。
fix_perms() {
    local n
    n="$(find "$ROOT" -type f -user "$(id -un)" ! -perm -u+r 2>/dev/null | grep -vc node_modules || true)"
    if [ "${n:-0}" -gt 0 ]; then
        find "$ROOT" -type d -user "$(id -un)" ! -perm -u+rx -exec chmod u+rx {} + 2>/dev/null
        find "$ROOT" -type f -user "$(id -un)" ! -perm -u+r -exec chmod u+rw {} + 2>/dev/null
        say "修复了 $n 个权限为 000 的文件（沙箱里 Edit/sed 改过就会这样）"
    fi
}

# ---------------------------------------------------------------- 签名密码
# 签名密码**不进仓库**（见 android/gradle.properties 的说明）：写在那里会跟着公开，
# 而密码泄露 = 别人能签出可覆盖安装到你电视上的"更新包"。
# 这里按「环境变量 > android/signing.env」取值，再写进本次构建的 GRADLE_USER_HOME
# （用户级 gradle.properties，Gradle 会自动读，优先级高于项目里的那份）。
load_signing() {
    local env_file="$HERE/signing.env"
    if [ -f "$env_file" ]; then
        # shellcheck disable=SC1090
        set -a; . "$env_file"; set +a
        say "签名配置：已读取 $env_file"
    fi

    if [ -z "${RELEASE_STORE_PASSWORD:-}" ]; then
        say "⚠️ 没有找到签名密码：release APK 会打成**未签名**包（装不上）。"
        say "   解决：cp android/signing.env.example android/signing.env 并填好密码，"
        say "        或者 RELEASE_STORE_PASSWORD=*** bash android/build-on-nas.sh"
        return 0
    fi

    mkdir -p "$GRADLE_USER_HOME"
    {
        echo "RELEASE_STORE_PASSWORD=${RELEASE_STORE_PASSWORD}"
        echo "RELEASE_KEY_ALIAS=${RELEASE_KEY_ALIAS:-mediaiptv}"
        echo "RELEASE_KEY_PASSWORD=${RELEASE_KEY_PASSWORD:-$RELEASE_STORE_PASSWORD}"
        # 留空则让 build.gradle.kts 退回仓库内的 android/release.jks
        [ -n "${RELEASE_STORE_FILE:-}" ] && echo "RELEASE_STORE_FILE=${RELEASE_STORE_FILE}"
    } >"$GRADLE_USER_HOME/gradle.properties"
    say "签名配置：已写入 $GRADLE_USER_HOME/gradle.properties（alias=${RELEASE_KEY_ALIAS:-mediaiptv}）"
}

# ---------------------------------------------------------------- 准备构建目录
# 在 $WORK 里构建，不碰仓库里的 android/：
#   - android/local.properties 指向 Windows 的 C:\Dev\android-sdk，改了会破坏 Windows 侧构建
#   - 不污染 android/.gradle 与 android/app/build 的中间产物
# 注意目录形状：app/build.gradle.kts 用 rootProject.file("../fpk/package/manifest") 取
# versionName，所以 android/ 必须与 fpk/ 保持兄弟关系，否则 versionName 会取不到。
prepare_work() {
    local first=0
    if [ ! -d "$WORK/android" ] || [ ! -f "$WORK/android/local.properties" ]; then
        first=1
        say "新建构建目录 $WORK ..."
        rm -rf "$WORK"
        mkdir -p "$WORK/android" "$WORK/fpk/package"
    fi

    # 每次运行都重新同步源码，只复用 app/build 与 .gradle 的增量状态。
    # 之前这里是「目录存在就整个跳过」——那样在重试之间是对的，但跨次运行会让
    # 改过的 Android 源码不生效（构建的还是上一次的旧代码），是个很坑的静默错误。
    # tar 解到已存在的目录会覆盖源码文件，同时不会删掉 app/build。
    tar -C "$HERE" -cf - --exclude=./build --exclude=./app/build --exclude=./.gradle . \
        | tar -C "$WORK/android" -xf - || die "复制工程失败"
    cp -f "$MANIFEST" "$WORK/fpk/package/manifest"
    # 工作区挂载会把文件呈现成 mode 000，tar 会把这个权限原样带过来，于是 gradlew
    # 变成不可执行（u+rwX 里的大写 X 只对「本来就可执行」的文件生效）。
    chmod -R u+rwX "$WORK"
    chmod +x "$WORK/android/gradlew"
    echo "sdk.dir=$SDK" > "$WORK/android/local.properties"

    # 降低崩溃概率的参数。gradle.properties 刚被源码覆盖，所以这里只追加一次，
    # 不会越跑越多。改动只落在工作副本里，不动仓库的 gradle.properties。
    cat >> "$WORK/android/gradle.properties" <<'EOF'

# --- build-on-nas.sh 追加：降低 JVM 崩溃概率 ---
# 单 JVM（Kotlin 编译并进 Gradle 进程，少一个 3G 的 JVM）、单线程 GC、限制并发。
org.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=768m -XX:+UseSerialGC
kotlin.compiler.execution.strategy=in-process
org.gradle.parallel=false
org.gradle.workers.max=2
org.gradle.vfs.watch=false
EOF
    [ "$first" = "1" ] || say "已同步源码到 $WORK（保留增量状态）"
}

# ---------------------------------------------------------------- 验收产物
verify_and_collect() {
    local src="$WORK/android/app/build/outputs/apk/$VARIANT"
    local dst="$HERE/app/build/outputs/apk/$VARIANT"
    local aapt="$SDK/build-tools/$BUILD_TOOLS/aapt2"
    local n=0
    [ -d "$src" ] || die "构建报告成功，但没有产物目录 $src"

    # 先清空目标目录再拷：否则上一版按 ABI 拆分的旧产物会和新包混在一起
    # （publish.sh 会按真实版本号/ABI 规则过滤掉，但目录里混着两版很容易看错）
    rm -rf "$dst"
    mkdir -p "$dst"
    for f in "$src"/*.apk; do
        [ -f "$f" ] || continue
        local badge
        badge="$("$aapt" dump badging "$f" 2>/dev/null | head -1)"
        local code name
        code="$(echo "$badge" | grep -o "versionCode='[0-9]*'" | tr -dc '0-9')"
        name="$(echo "$badge" | grep -o "versionName='[^']*'" | cut -d"'" -f2)"
        # 版本号不对就当失败：这台机器上真出过「构建成功但 versionName=1.0.0」
        if [ "$code" != "$EXPECT_CODE" ]; then
            die "$(basename "$f") 的 versionCode=$code，期望 $EXPECT_CODE"
        fi
        case "$name" in
            "$EXPECT_VERSION"|"$EXPECT_VERSION"-*) ;;
            *) die "$(basename "$f") 的 versionName=$name，期望 $EXPECT_VERSION" ;;
        esac
        cp -f "$f" "$dst/"
        printf "    %-42s versionCode=%s versionName=%s  %s\n" \
            "$(basename "$f")" "$code" "$name" "$(sha256sum "$f" | cut -c1-16)"
        n=$((n + 1))
    done
    [ "$n" -gt 0 ] || die "构建报告成功，但一个 APK 都没找到"
    [ -f "$src/output-metadata.json" ] && cp -f "$src/output-metadata.json" "$dst/"
    say "已验收 $n 个 APK -> $dst"
}

# ---------------------------------------------------------------- 主流程
say "缓存目录: $CACHE"
say "工作副本: $WORK"
[ "$CLEAN" = "1" ] && { say "--clean：删除工作副本（工具链缓存保留）"; rm -rf "$WORK"; }
ensure_tools
fix_perms
load_signing
prepare_work

if [ "$VARIANT" = "debug" ]; then TASK="assembleDebug"; else TASK="assembleRelease"; fi

# 清掉本变体上一次的产物再构建。
# 不清的话，签了名的 app-*-release.apk 会和上一版未签名的 app-*-release-unsigned.apk
# 同时留在输出目录里，publish.sh 按真实版本号过滤时能挡住，但目录里混着两版很容易看错。
rm -rf "$WORK/android/app/build/outputs/apk/$VARIANT"

# --fresh：忽略构建缓存、强制所有任务重跑。用来验证「这次是真跑过的」，
# 也让崩溃率对比有意义（缓存命中会让「没崩」变成假阳性）。
FRESH_ARGS=()
[ "$FRESH" = "1" ] && FRESH_ARGS=(--no-build-cache --rerun-tasks)
[ "$FRESH" = "1" ] && say "--fresh：禁用构建缓存并强制重跑（每次都是全量构建）"

START=$(date +%s)
attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    LOG="$CACHE/attempt-$attempt.log"
    rm -f "$WORK/android"/hs_err_pid*.log
    say "── 第 $attempt/$ATTEMPTS 次尝试（日志 $LOG）──"

    ( cd "$WORK/android" && ./gradlew --no-daemon --stacktrace \
        "${FRESH_ARGS[@]}" \
        --no-watch-fs \
        -Dorg.gradle.internal.instrumentation.agent=false \
        -Dorg.gradle.vfs.watch=false \
        "$TASK" ) >"$LOG" 2>&1
    rc=$?

    if [ "$rc" -eq 0 ]; then
        say "构建成功（第 $attempt 次尝试，累计 $(( $(date +%s) - START ))s）"
        verify_and_collect
        rm -f "$WORK/android"/hs_err_pid*.log
        # 收进 dist/ 并只保留最近两个版本（命名规则见 tools/publish.sh）
        if [ -x "$ROOT/tools/publish.sh" ]; then
            say ""
            bash "$ROOT/tools/publish.sh"
        fi
        exit 0
    fi

    # 区分「JVM 崩了，值得重试」和「真的编译/配置错误，重试也没用」
    is_crash=0
    ls "$WORK/android"/hs_err_pid*.log >/dev/null 2>&1 && is_crash=1
    grep -q "daemon disappeared unexpectedly" "$LOG" 2>/dev/null && is_crash=1
    grep -q "JVM crash log found" "$LOG" 2>/dev/null && is_crash=1

    if [ "$is_crash" -eq 1 ]; then
        say "第 $attempt 次被 JVM 崩溃打断（已知环境问题），准备重试"
        for h in "$WORK/android"/hs_err_pid*.log; do
            [ -f "$h" ] && say "   $(grep -m1 'Problematic frame' -A1 "$h" | tail -1 | cut -c1-100)"
        done
        # 收掉可能残留的守护进程，释放内存
        pkill -f "[G]radleDaemon" 2>/dev/null || true
        sleep 3
        continue
    fi

    say "第 $attempt 次是真实构建错误（不是 JVM 崩溃），不再重试。日志末尾："
    tail -25 "$LOG" | sed 's/^/    /'
    exit 1
done

say "连续 $ATTEMPTS 次都被 JVM 崩溃打断。可尝试："
say "  1) 加大重试次数：bash android/build-on-nas.sh --attempts 15"
say "  2) 用 root 把透明大页改成 madvise："
say "     echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled"
say "  3) 换台机器构建（Windows 上：cd android && gradlew.bat $TASK）"
exit 1
