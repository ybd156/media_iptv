# 这台 NAS 上 JVM 随机崩溃的排查记录

> 结论：**没查到根因，也没修好。** 目前靠 `build-on-nas.sh` 的自动重试兜住。
> 本文记录"已经排除了什么"和"怎么复测"，避免下次从零开始。

## 现象

在这台机器上跑 Gradle/AGP 构建（Android APK），JVM 会**随机**崩在 `libjvm.so` 的
native 代码里，表现为 `Gradle build daemon disappeared unexpectedly`，
并在构建目录留下 `hs_err_pid*.log`。崩溃大多发生在构建开始后 **2 分钟内**；
一次全量构建约 9 分钟，所以"崩"是早期事件、"成功"要熬满全程。

## 环境

| 项 | 值 |
| --- | --- |
| 主机 | Intel N100，4 核，15 GB 内存 |
| 系统 | Debian 12 (bookworm)，内核 `6.18.18.c1107-trim`（fnOS 厂商内核，dmesg 里可见其自定义 `[trim-mounts-hash]` 补丁） |
| JDK | Temurin 17.0.20.1+1 / Corretto 17.0.20.12.1（**同一个上游**） |
| 构建 | Gradle 8.7 + AGP 8.6.1 + Kotlin 1.9.24 |

## 已经排除的假设

| 假设 | 怎么测的 | 结果 |
| --- | --- | --- |
| 内存条 / CPU 硬件坏 | EDAC 计数（`igen6_edac` 已注册、POLLED 模式）、`kern.log`/`dmesg` 查 MCE/oops、自写 GC 压力程序 | **排除**：EDAC 0 错误、内核日志无硬件报错；压力程序单 JVM 3G 堆跑满 116 秒不崩、4 个 JVM 并发合计 8G 堆不崩、强制透明大页 12.7 万轮不崩 |
| 某个 GC 实现有 bug | 分别用 G1 / ParallelGC / SerialGC | **排除**：三种都崩 |
| 某个 JDK 发行版有问题 | Temurin 17 vs Corretto 17 | **无效证据**：两者同上游 17.0.20.1，不算两次独立验证 |
| THP=`always`（khugepaged 折叠页） | 改成 `madvise` 后连跑 2 次全量构建 | **排除**：2/2 崩 |
| `vm.mmap_rnd_bits=32`（Ubuntu 24.04 那个著名 JVM 崩溃诱因） | `sysctl vm.mmap_rnd_bits` | **排除**：实测 28（Debian 正常值） |
| 压缩指针解码写坏 | `-XX:-UseCompressedOops`（已在 hs_err 里确认 `UseCompressedOops=false` 生效） | **排除**：2/2 崩，崩溃点从 `narrowOop` 变成 `oopDesc*` |
| DSH 沙箱造成 | `grep Seccomp /proc/self/status`、`/sys/kernel/security/lsm` | **排除**：`Seccomp: 0`，只有 Landlock（纯文件系统限制），不可能造成内存损坏 |
| 文件监视 / 插桩 agent | 关掉后 | 只降概率，不是修复 |
| 多 JVM 内存压力 | `kotlin.compiler.execution.strategy=in-process`（只剩一个 JVM） | 只降概率，不是修复 |

## 未排除的方向

1. **厂商内核 `6.18.18.c1107-trim` 的 MM 相关回归** —— 目前最可疑。它只影响
   "重、长、多线程、大量类加载"的负载，日常服务/播放/录像/node 打包全都不受影响。
2. **JDK 17.0.20.1 自身回归** —— 因为上面那个"两个 JDK 同源"的问题，这条其实还没测过。
   要测就得换 **JDK 21 或别的上游版本**。
3. `-XX:-UseCompressedClassPointers` —— 关掉压缩 oops 后类指针**仍然是压缩的**
   （`UseCompressedClassPointers=true`），而崩溃正好发生在读类指针的
   `oop_oop_iterate<InstanceKlass, ...>` 路径上。这条测到一半被打断，**没有结论**。

## 排查过程中的两个方法论教训

这两条让我一度得出过错误结论，记下来避免重犯：

1. **"两个不同 JDK 都崩"不是两条证据** —— Temurin 和 Corretto 是同一个上游 17.0.20.1
   的不同打包。当时我把它当成"换了 JDK 也没用"的独立验证，是错的。
2. **构建缓存命中会造成假阳性** —— 有一次同参数重跑 21 秒就"BUILD SUCCESSFUL"，
   其实是 `FROM-CACHE`，真正会崩的 Kotlin/R8 根本没跑。验证崩溃率必须加
   `--no-build-cache --rerun-tasks`（脚本里的 `--fresh`）。

   推论：**单次成功在这个失败率下不能当证据**。我一度把一次成功当成"找到了修复"，
   用同样参数禁掉缓存重跑就崩了。

## 怎么复测（内核更新后 / 换机器后）

```bash
# 连续 4 次全量构建，统计崩溃次数；2 次崩溃就提前判定"未修复"
bash android/build-on-nas.sh --fresh --attempts 1   # 单次全量
```

判定基线：改内核前，真跑了 R8/Kotlin 的 5 次里崩 4 次（约 80%）。
**4 次全量构建 0 崩溃**才够说"有改善"（若真实崩溃率仍 80%，4 次全过的概率约 0.16%）。

## 现在的兜底

`android/build-on-nas.sh`：固定一套降低概率的参数 + 崩了自动重试 + aapt2 验收版本号。
实测两次都出了正确的 APK（一次"崩 1 次后第 2 次成功、累计 241 秒"，一次"全新缓存第 1 次即成功"）。

**这个脚本是兜底，不是修复。** 崩溃概率没有降下来，只是被重试吸收了。
