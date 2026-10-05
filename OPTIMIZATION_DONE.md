# MediaIptv 优化实施记录

配套文档：[OPTIMIZATION_REVIEW.md](OPTIMIZATION_REVIEW.md)（审查报告，含每条问题的定位、证据与建议改法）。

本文档记录**实际改了什么、怎么验证的、哪些故意没改**。

---

## 零、一次误删事件（已修复，需你确认）

**发生了什么**：我在清理打包测试残留时执行了 `Remove-Item -Recurse -Force "fpk\package\app"`，
误以为 `fpk/package/app/` 只是构建暂存目录。实际上它同时存放着**入库的 UI 源码**：

```
fpk/package/app/ui/index.cgi          347 字节
fpk/package/app/ui/config             307 字节
fpk/package/app/ui/images/icon_0.png  568 字节
fpk/package/app/ui/images/icon_32.png 370 字节
fpk/package/app/ui/images/icon_64.png 568 字节
fpk/package/app/ui/images/icon_256.png 1952 字节
```

构建暂存只应清 `fpk/package/app/server/`。这是我的操作失误，不是脚本的问题。

**恢复情况**：

| 文件 | 恢复方式 | 状态 |
|---|---|---|
| `ui/images/icon_0.png` | 由仍存在的 `fpk/package/ICON.PNG`（64×64，同为 568 字节）逐字节复制 | ✅ 逐字节一致 |
| `ui/images/icon_64.png` | 同上 | ✅ 逐字节一致 |
| `ui/images/icon_256.png` | 由 `ICON_256.PNG`（256×256，同为 1952 字节）逐字节复制 | ✅ 逐字节一致 |
| `ui/images/icon_32.png` | 无原始副本，由 256 源图 LANCZOS 降采样生成 | ⚠️ 视觉一致，671 字节（原 370），非逐字节 |
| `ui/index.cgi` | 本会话内我重写过的版本（含 `TRIM_PKGVAR` fallback 与 `HTTP_HOST` 过滤） | ✅ 内容确定 |
| `ui/config` | **按同作者另两个 fnOS 项目（`Desktop/fnnvr`、`Desktop/fnos-zerotier`）的 schema 重建** | ⚠️ 功能等价，非原始字节 |

关于 `ui/config`：原始文件 307 字节、第 8 行为 `"port": "${server_port}",`、键必须是
manifest 里的 `desktop_applaunchname = mediaiptv.Application`。我据此枚举了合法 JSON 组合，
**有 7 个候选都恰好 307 字节**，无法唯一确定，因此改为按同作者可工作的 schema 重建：

```json
{
  ".url": {
    "mediaiptv.Application": {
      "title": "MediaIptv",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "protocol": "http",
      "port": "${server_port}",
      "url": "/",
      "allUsers": true,
      "control": { "accessPerm": "editable" }
    }
  }
}
```

已用 `pack.js` 实际打包确认 `ui/` 被正确收录（`ui/index.cgi` 权限 755、`ui/config` 与图标就位）。
**如果你手上还有原始 `ui/config`，请覆盖回去；否则这份重建可以正常工作**（`url: "/"` 会经服务端
已有的 `/` → `/admin/` 重定向进入后台）。

同时确认：`clean.ps1` / `clean.sh` 的目标本来就是正确的（清 `fpk/package/app/server`，
不会碰 `ui/`）。出错的是我临时敲的那条命令，不是脚本——脚本无需改动。

---

## 一、验证证据汇总

所有「实测」均为本次运行真实代码/接口得到的结果。

### 服务端

| 验证项 | 结果 |
|---|---|
| 16 个改动过的 .js 文件语法检查 | 16/16 通过（`node --check`） |
| 订阅刷新不再丢录制任务 | 20/20 断言通过 |
| EPG 解析（27 万条节目） | 数据正确性 12/12 通过 |
| EPG 事件循环阻塞 | **修复前 7290ms → 修复后最大请求延迟 122ms** |
| `/stream` 签名鉴权 | 12/12 通过（含伪造/篡改/过期/跨 id 复用） |
| 密码 scrypt + 重启不回退 | 17/17 通过（含真实重启验证） |
| 全量回归 | **45/45 通过** |
| 索引生效 | 所有目标查询由 `SCAN` 变为 `SEARCH` |
| gzip 压缩 | 149387 → 23781 字节（**15.9%**，逐字节一致） |
| 管理后台 JS | 语法正确、7 个 data-act 全部注册、无残留 onclick 内插外部字符串 |
| 优雅退出 handler 体内操作 | 全部通过，`db.close()` 后 WAL 合并为 0 字节 |

关键前后对比（EPG 同步 268800 条节目期间，每 50ms 探测一次接口）：

```
修复前：事件循环冻结 7290ms（20ms 心跳只跑了 11 次），峰值 RSS 897MB
修复后：同步耗时 ~4.7s，期间探测 114 次，延迟 中位 4ms / p95 63ms / 最大 122ms
```

### Android

| 验证项 | 结果 |
|---|---|
| `:app:compileDebugKotlin` | 通过（仅 2 条既有 API 弃用警告） |
| `:app:assembleDebug` + `:app:assembleRelease` | **BUILD SUCCESSFUL** |
| 完整 release 链路（含 `lintVitalRelease`） | **BUILD SUCCESSFUL**（经 SOCKS5 代理下载 lint 依赖） |
| **AGP 8.6.1 升级后** 完整构建（debug + release + lint） | **BUILD SUCCESSFUL**，`compileSdk = 35` 警告消失 |

APK 体积对比：

```
改动前  release(universal) 24.7 MB    debug 31.2 MB
改动后  app-universal-release-unsigned.apk      21.4 MB   ← 24.7 → 21.4 MB（-13%）
        app-arm64-v8a-release-unsigned.apk      12.7 MB
        app-armeabi-v7a-release-unsigned.apk    10.6 MB
        app-universal-debug.apk                 27.8 MB
```

体积下降来自：移除 `-keep class kotlin.**`、移除 `-keep class androidx.media3.**`（Media3 自带 consumer 规则已覆盖反射路径）、移除 moshi-kotlin 反射工厂、`resourceConfigurations` 限定中英文。

### 打包（本轮补测：此前因环境无 bash 而未验证）

安装了 Git for Windows（真实 bash 5.3）后**实际执行**，不再是逐行审查：

| 验证项 | 结果 |
|---|---|
| 全部 13 个 shell 脚本 `bash -n` | **13/13 通过**（含 `cmd/main`、四个 callback、`build.sh`、`index.cgi`、`clean.sh`） |
| `build.sh` manifest 解析（CRLF 修复） | 正确输出 `mediaiptv v1.2.4 [all] arch=[x64 arm64]` |
| `build.sh` Node 运行时下载 + **SHA-256 校验** | `node-v24.9.0-linux-x64.tar.gz: OK`、`...-arm64.tar.gz: OK`（两架构均校验通过） |
| Node 运行时落盘与权限位 | 124 MB / 121 MB，`-rwxr-xr-x` |
| `build.sh` fnpack 下载 + 未提供哈希时的告警 | 正确打印实际哈希 `efc8097b…` 并提示设置 `FNPACK_SHA256` |
| `build.sh` 在 Windows 上停在 fnpack | 退出码 126（`Exec format error`，Linux ELF 无法在 Windows 执行）——预期行为 |
| `pack.js` 产出真实 `.fpk` | **91.2 MB 有效包**，1940 个内层条目 |
| 包内权限位 | `cmd/main` 755、`wizard/*` 644、`manifest` 644、`server/node_*` 755、`ui/index.cgi` 755 |
| `node_modules/.bin` 排除 | 0 条（已排除） |
| `pack.js` 可复现性 | 连续两次打包 **sha256 完全一致** |
| `pack.js` 预检 | 缺 Node 运行时/入口时明确报错、退出码 1、不产出包 |
| `clean.ps1 -DryRun` | 在 PowerShell 5.1 下正常（正确报出 407 MB Android 构建产物） |

**本轮未能真实执行的两步（环境限制，已用替身或跳过）**：
1. `npm ci` —— 本机 `registry.npmjs.org` 被中间人拦截（证书为 `*.csmjs.cc`）且对包 tarball 返回 404，
   npm 无法联网取包。已改为复用 `server/node_modules`（生产依赖全是纯 JS，且已完整安装）。
2. `fnpack` 执行 —— 它是 Linux x86_64 二进制，Windows 上无法运行；最终打包改走 `pack.js`
   （即 README 里给 Windows 的路径）。

其余全部为真实执行结果。

---

## 二、改动清单

### 服务端

**修复丢数据 / 卡死 / 安全**

1. **订阅刷新不再清空录制任务**（`routes/admin.js`、`services/recorder.js`）
   - `importM3U` 拆成 `importParsed` + 包装；已存在频道做 **upsert 而非「先删光再重建」**，频道 id 保持稳定
   - `refreshSource` 改为差异删除：只删「刷新前属于该源、刷新后已消失」的频道，并把连带删除的录制任务数写进日志与返回值
   - 顺带修掉重复导入会无限累积重复线路的问题（按 url 查重，重复导入变幂等）
   - 新频道/新分组的 `sort` 从现有最大值续排，不再与既有数据交错
   - `recorder.cleanup()` 增加孤儿录像回收：频道已不存在的录像按默认保留期清理（原先因 `cutoffMap` 无对应条目而被永久跳过）

2. **EPG 解析移出主线程**（新增 `services/epgWorker.js`，重写 `services/epg.js`，改 `routes/admin.js`）
   - 用 `sax` 流式解析替代 xml2js 建整棵 DOM；时间转换不再走 dayjs（27 万次 dayjs 调用本身就很慢）
   - 解析在 worker 线程完成，节目按 5000 条一批回传，主线程只做批量入库
   - gunzip 改异步；`INSERT OR REPLACE` 改真正的 `ON CONFLICT DO UPDATE`
   - 同步结束后清理 2 天前的过期节目（`/epg` 与 `/epg/now` 只查当天，旧数据纯占盘）
   - `sax` 已加入 `package.json` 依赖（原本只是 xml2js 的传递依赖）

3. **`/stream/*` 加签名鉴权**（新增 `services/streamAuth.js`，改 `routes/stream.js`、`routes/client.js`、`routes/admin.js`、后台页面）
   - 签名绑定 `(类型, id, 过期时间)`，HMAC-SHA256，密钥持久化在 `settings.streamSecret`
   - 有效期 7 天（TV 盒子可能连续开机数天不重拉频道列表）
   - 可通过 `settings.streamAuth='0'` 关闭以兼容旧客户端；后台「系统设置 → 直播源访问」有开关
   - 后台录像列表新增 `playUrl` 字段（否则后台的「播放」链接会 403）

4. **管理员密码改 scrypt + 兼容迁移**（`auth.js`、`db.js`、`routes/admin.js`）
   - `admins` 表新增 `algo` 列；老库的 sha256 哈希在登录成功后就地升级为 scrypt
   - 常数时间比较；改密码时换新 salt 并使其它会话立即失效
   - 过期会话每 10 分钟清理（原先只在被访问到时删除）
   - **`ADMIN_PASSWORD` 环境变量不再覆盖用户自行修改过的密码**（原先 FPK 每次重启都会把密码改回安装向导的值）

5. **优雅退出**（`index.js`）
   - 注册 SIGTERM/SIGINT handler：停止接受新连接 → 杀掉全部 ffmpeg 录制进程 → `db.close()`（WAL checkpoint）→ 3 秒兜底强退
   - 直播流是长连接，用 `server.closeAllConnections()` 强制断开

**性能与健壮性**

6. **补 7 个索引 + 一次性清理重复线路**（`db.js`）
7. **访问日志改用 `req.originalUrl`**（`index.js`）——原先 `req.path` 在 `finish` 时已被剥掉挂载前缀，导致「直播流不写日志」的过滤完全失效且所有日志路径都缺前缀
8. **gzip 压缩**（`index.js`，仅包装 `res.json`，不碰静态资源与 `/stream`）
9. **`last_seen` 写入节流 60 秒**（`auth.js`）——原先每个已鉴权请求都写一次库
10. **`logger.tail` 反向读文件末尾 2MB**（`logger.js`）——原先整个日志读进内存
11. **统一流地址解析**（新增 `services/streamUrl.js`，替换 stream/probe/recorder/client 四处各写一遍的实现）
12. **直播流设置项缓存 30 秒**、**`/stats` 录像目录遍历缓存 30 秒**、**`scanSegments` 用 `withFileTypes` 省掉一半 stat**
13. **管理后台 XSS 修复**：7 处「把外部字符串塞进 onclick」改为 `data-*` 属性 + 事件委托
14. **静态资源缓存头**、**`baseUrlOf()` 尊重 `X-Forwarded-Proto`**（原先硬编码 `http://`）

### Android

**主线程开销**

15. **`SystemStats` 改为后台采样**：`Regex` 提升为预编译常量，CPU/PSS 采样交给独立线程，`cpuPercent()`/`memoryMb()` 只读缓存；OSD 开关时通过 `start()`/`stop()` 启停
16. **JSON 解析移出主线程**（`Repository.kt`）：新增 `parse()` 在 `Dispatchers.Default` 解码，顺带消除 7 处重复样板
17. **`ExoEngine.statsText()`**：`hasAv3aDecoder()` 改 `by lazy`（设备常量）、`audioOffloadActive()` 按音频参数缓存、3 处 `String.format` 改整数运算
18. **`IjkEngine.statsText()`**：`mediaInfo` 按 2 秒 TTL 缓存（原每次 OSD tick 都做 2 次 JNI + 完整 Bundle 解析）

**生命周期与泄漏**

19. **`onDestroy` 用 `removeCallbacksAndMessages(null)` 清空所有延时回调**（原先漏了 6 个，其中 `channelPanelHideRunnable` 会每 3.5 秒自我重投，Activity 销毁后永久循环）
20. **新增 `onStop()`**：退到后台停掉 EPG 定时刷新、OSD 采样、回看进度轮询
21. **回看进度轮询保存 Job**：`startProgressPolling()` 先取消旧 Job（原先每次点节目都新起一个永不退出的 `while(isCatchupMode)` 循环）
22. **`ExoEngine.release()`** 摘掉 listener 与三个回调 lambda、断开 `playerView.player`；**stall monitor 只在播放中续期**（原先暂停时也每 2 秒唤醒主线程）

**功能缺陷**

23. **`SystemEngine` 缩放修复**：删掉从未生效的局部 `Matrix` 与撤销 `setFixedSize()` 的 `setSizeFromLayout()`，改为调整 SurfaceView 布局尺寸（缓冲区保持原始分辨率）；原先 fit/fill/zoom/169 渲染完全一样
24. **`SystemEngine` 异常捕获改 `catch (e: Exception)`**：`setDataSource` 对 rtmp:// 等会抛 `IllegalArgumentException`，原先只 catch IOException，兜底引擎反而会崩主线程；失败时同时释放半成品播放器
25. **`ExoEngine.setSource()` 新增 `resetStreamState()`**：清空码率统计、`av3aNotified`、`codecErrorTimes`、解码器名/帧率、卡死监测时间戳、offload 缓存
26. **`IjkEngine`**：`release()` 前先 `reset()`（清 native 已投递的消息队列）、换台清空码率采样与元数据缓存、`model.bin` 释放移到构造时的后台线程
27. **换台 O(1) 查找**：新增 `channelIndex: Map<Int, Pair<Int,Int>>`，替换 3 处全列表扫描（含一次 `groups.flatMap` 整份复制）
28. **切分组时同步 `currentChannelIndexInGroup`**（原先沿用旧组序号，UP/DOWN 会跳到无意义的频道）
29. **启动选台跳过无线路频道**，全空时提示「暂无可用频道」（原先选中空频道会黑屏且无提示）
30. **自动换源提示的线路号修正**（原先在自增后取值，前后半段都是错的且 0 基）
31. **`reportResolution` 去重**（原先每次 `onVideoSizeChanged` 都发一个 POST）
32. **长按换台节流 250ms**（原先遥控器重复事件每次都换台+发 EPG 请求）
33. **EPG 定时刷新只在 EPG 面板可见时拉当前频道节目单**，并统一走 `loadEpgForChannel`（顺带修掉「10 分钟刷新不更新频道行节目名」）
34. **`activity_main.xml` 移除 `android:keepScreenOn`**（它让设置里的「播放时不息屏」开关失效）
35. **`ChannelAdapter`**：6 个兜底 `GradientDrawable` 预建复用、Glide 回调移到 ViewHolder 上创建一次、`submitNowPlaying` 只刷新标题真变的行
36. **`EpgAdapter`**：颜色资源解析缓存、`submitPrograms` 一次遍历替代两次 filter + asReversed
37. **`ApiModels.CatchupDaysData` 字段名 `dates` → `days`**（与服务端一致；原先会解析出空列表）
38. **`App` 预热 ijk native 库**（约 16MB，原先在首次 AV3A 换台时于主线程 loadLibrary）

### 打包与构建

39. **`cmd/main`**：`start`/`stop` 正确传递退出码（原先永远 exit 0，启动失败也报成功）、`setsid` + 进程组杀、PID 校验（防 PID 复用导致永远认为在运行）、端口范围校验、`log_msg` 前先建目录、`cd` 检查、用真实监听探测替代固定 `sleep 2`、**删除自引用软链**（`data/data -> data`，会让 tar/du/rsync -L 死循环）
40. **`install_callback`**：去掉 `chmod -R 777`（改为 0750 + 路径前缀校验）、去掉硬编码 `admin123`（空则生成随机密码）、`umask 077` + `chmod 600` 密码文件、补 `cmd/*` 可执行位、校验包完整性
41. **`config_callback`**：端口 1..65535 校验、`umask 077`、透传 restart 退出码
42. **`uninstall_callback`**：`rm -rf` 前做路径白名单 + 最小层级 + 挂载点检查
43. **`upgrade_callback`**：升级后重新应用可执行位（原先只 restart，新到的 0644 文件无法执行）
44. **`index.cgi`**：补 `TRIM_PKGVAR` fallback、`HTTP_HOST` 过滤（原先可 CR/LF 注入响应头 + 开放重定向）
45. **`manifest` 规范化为 LF**（原为 CRLF，会让 `build.sh` 解析出的产物名带 `\r`、改名静默失败却仍打印成功）
46. **`build.sh`**：`set -euo pipefail`、`curl -fsSL`、**校验 Node 官方 SHA-256**、`trap` 清理临时目录、下载缓存、显式设置可执行位、结尾校验产物存在、移除 `./fnpack.exe` 分支（Linux 上执行 Windows PE 只会失败）
47. **`build.ps1`**：检查每个原生命令的 `$LASTEXITCODE`（原先 fnpack 失败会把上次残留的包改名成本次版本并打印 Done）、`curl.exe -f`、Node 版本从 `fpk/node-version` 单一来源读取、**默认改用 `pack.js`**（Windows 上唯一能正确保留 Unix 可执行位的方式）
48. **`pack.js`**：全程流式（原先把两个 110MB 二进制 + node_modules 全读进内存再 concat + gzipSync(9)，峰值 250MB+ 且完全同步）、预检必需文件、mtime 取自 manifest（可用 `SOURCE_DATE_EPOCH` 覆盖）→ **产物可复现**、输出 sha256、排除 `node_modules/.bin`
49. **`Dockerfile`**：`NODE_ENV=production`（原先错误响应会返回堆栈）、`npm ci` + 拷贝 lockfile、`USER node` 去 root、`HEALTHCHECK`
50. **`.dockerignore`**：补 `.env*`、密钥、测试残留
51. **`.gitignore`**（原先全仓库没有）：node_modules、build、.gradle、local.properties、server/data、*.fpk、fpk 暂存、密钥、编辑器残留
52. **`clean.ps1` / `clean.sh`**：新增，带 `-DryRun` / `--dry-run`
53. **`proguard-rules.pro`**：移除 `-keep class kotlin.**` 与 `-keep class androidx.media3.**`（后者依据 Media3 自带 consumer 规则，其中已显式保留 `FfmpegAudioRenderer` 等反射构造的扩展渲染器）；保留 Moshi 的 model keep 并加注释说明它是承重的
54. **`build.gradle.kts`**：新增 `signingConfigs`（从 `~/.gradle/gradle.properties` 读密钥）、ABI splits（`isUniversalApk = true`，universal 与分 ABI 产物并存）、`resourceConfigurations` 限定中英文、移除 `moshi-kotlin`、`versionName` 取自 fpk manifest、debug 加 `applicationIdSuffix`
55. **`AndroidManifest.xml`**：`allowBackup=false`、`BootReceiver` 改 `exported=false`
56. **`gradle.properties`**：补签名配置说明与代理配置说明
57. **PowerShell 脚本补 UTF-8 BOM**（`clean.ps1`、`fpk/build.ps1`，并顺带修了既有的 `android/gen_icons.ps1`）——无 BOM 时 PowerShell 5.1 按 ANSI 解码，中文注释会导致**语法错误无法运行**
58. **版本号去重**：`server/package.json` 1.0.0 → 1.2.4；Android `versionName` 改从 `fpk/package/manifest` 读取

---

## 三、故意未改动的部分

| 项目 | 原因 |
|---|---|
| **Gradle 配置缓存** | 曾按建议开启，**实测在 AGP 8.2.2 下会失败**（`LintTool` 的 `__classpath__` 无法序列化，`:app:lintVitalAnalyzeRelease` 报错）。已回退，并在 `gradle.properties` 里写明原因与启用条件。AGP 已升到 8.6.1，可以再试，但本轮未再改动（避免一次引入两个变量）。 |
| **`Av3aHlsExtractorFactory` 的 TS 嗅探前置检查** | 收益是省掉非 TS 分片的一次 `TsExtractor` 构造与嗅探（发生在加载线程，不在主线程）；风险是改动 HLS 提取路径，而本环境无法做真机播放验证。为不破坏可用的播放链路而暂缓。 |
| **`networkSecurityConfig` 替代 `usesCleartextTraffic`** | 服务器地址是用户在设置里填的任意局域网 `IP:端口`，`networkSecurityConfig` 只能按域名/固定 IP 列举，无法覆盖。已在 Manifest 里写明理由。 |
| **`-keep class com.mediaiptv.tv.model.**`** | **不能删**。Moshi 通过 `Types.generatedJsonAdapterName()` 拼出适配器类名再 `Class.forName` 反射加载，生成的 `*JsonAdapter` 与 model 同包，这条规则同时保住了适配器本身。已加注释说明。 |
| **`Config.CHANNEL_OUT_7POINT1` / `getPlaybackOffloadSupport` 弃用警告** | 编译有 2 条既有弃用警告，功能正常，未改动（替换需要新的 API 与真机验证）。 |
| **AGP 8.2.2 → 8.6.1** | ✅ **本轮已完成**（原先因无网络而搁置）。见下方「AGP 升级」小节。 |

### AGP 升级（本轮完成）

选择 **AGP 8.6.1** 而不是 8.7+，理由是它把改动面压到最小：

- AGP 8.6 是**首个正式支持 `compileSdk = 35`** 的版本 → 警告消失
- AGP 8.6 最低要求 **Gradle 8.7**，与本项目现有 wrapper **完全一致** → 无需更换 Gradle 发行版（否则要再下 130 MB）
- Kotlin / KSP 保持 1.9.24 不动 → 不引入 K2 编译器这个额外变量

验证：`:app:assembleDebug` + `:app:assembleRelease`（含 `lintVitalRelease`）**BUILD SUCCESSFUL**，
且构建日志里不再出现 `We recommend using a newer Android Gradle plugin`。产物体积与升级前一致
（universal release 21.4 MB）。

后续若要继续升到 AGP 8.7+，则需要同时把 wrapper 提到 Gradle 8.9+。

---

## 四、行为变化（升级须知）

1. **`/stream/*` 现在需要 URL 签名**。客户端从 `/api/client/channels`、`/catchup/list` 拿到的地址已自动带签名，正常使用无感。**旧版 APK 会 403**，此时可在后台「系统设置 → 直播源访问 → 流地址签名鉴权」关闭。
2. **release APK 文件名变化**（因为启用了 ABI 拆分）：
   - `app-universal-release-unsigned.apk`（原来的 `app-release-unsigned.apk`，仍可直接 sideload）
   - `app-arm64-v8a-release-unsigned.apk` / `app-armeabi-v7a-release-unsigned.apk`
3. **debug 包名变为 `com.mediaiptv.tv.debug`**，与 release 可共存（原先会互相覆盖）。
4. **未配置签名密钥时 release 仍为未签名**，构建时会打印提示；配置方式见 `gradle.properties` 注释。
5. **`ADMIN_PASSWORD` 环境变量只在首次初始化生效**，不再覆盖后台改过的密码。
6. **FPK 安装向导不再预填 `admin123`**；若留空会生成随机密码并打印在安装日志里。
7. **订阅刷新只会删除「已从订阅中消失」的频道**，连带删除其录制任务（数量会记入日志）。
8. **EPG 只保留最近 2 天以外的清理**：同步后自动删除 2 天前的节目数据。
9. Android 的 `versionName` 现在来自 `fpk/package/manifest`（当前 1.2.4）。
10. **AGP 从 8.2.2 升到 8.6.1**，`compileSdk = 35` 的警告消失；Gradle wrapper 仍是 8.7，Kotlin/KSP 仍是 1.9.24。
11. 工作区里保留了本轮验证产出的 `fpk/mediaiptv_all_v1.2.4.fpk`（91.2 MB）、`fpk/fnpack`（3.6 MB）
    与 `fpk/package/app/server/` 暂存（253 MB，含两个 Node 运行时）。它们都在 `.gitignore` 覆盖范围内；
    执行 `.\clean.ps1` 可清除，但 `package/app/server` 清掉后重新构建需再次下载约 250 MB。

---

## 五、本次为验证而安装/依赖的环境（不在仓库内）

| 项 | 位置 | 说明 |
|---|---|---|
| Git for Windows（PortableGit 2.56.0） | `C:\Dev\dsh-shell\git` | 提供真实 bash 5.3 与 curl/sha256sum/tar 等工具，用于验证 fpk shell 脚本。可整体删除，不影响项目。 |
| busybox 1.38 | `C:\Dev\dsh-shell\busybox.exe` | 备用 POSIX shell（未最终使用）。 |
| SOCKS5 代理 | `127.0.0.1:10808` | 你提供的代理。Java/Gradle 用 `systemProp.socksProxyHost` 直接支持；npm 不支持 SOCKS，本轮验证时另写了一个本机 HTTP→SOCKS5 桥接（临时文件，已随临时目录删除）。 |

**本机网络的一个坑（值得记一下）**：`registry.npmjs.org` 与 `repo1.maven.org` 会被中间人拦截，
返回的证书是 `*.csmjs.cc`，因此 npm / curl(schannel) 都会报证书错误；强行忽略证书后 npm 取包
仍得到 **404**。而 `nodejs.org`、`dl.google.com`、`static2.fnnas.com`、`github.com` 的 TLS 正常
（Gradle 能正常拉依赖正是因为这个）。**结论：本机无法执行 `npm install`**——需要装/更新服务端依赖时，
请换一个不被拦截的网络环境。

另外提醒：`android/gen_icons.ps1` 里的输出路径写的是
`c:\Users\Z\Documents\trae_projects\MediaIptv\android\app\src\main\res`，
与当前实际路径（`C:\Users\Z\Desktop\trae_projects\...`）不符；直接运行它会把图标写到不存在的目录。
本轮顺手给它补了 UTF-8 BOM（否则 PowerShell 5.1 会因中文注释报语法错误），但**路径没有改**——
如果你确实要用它重新生成图标，需要先把 `$base` 改到当前路径。
