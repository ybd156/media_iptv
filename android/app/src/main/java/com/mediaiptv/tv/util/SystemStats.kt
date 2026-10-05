package com.mediaiptv.tv.util

import android.os.Debug
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/**
 * 系统资源统计：本进程 CPU 占用率与内存占用（供 OSD 统计行展示）。
 *
 * CPU 通过读取 /proc/self/stat 的 utime+stime 两次采样差值计算，
 * 按 CPU 核心数归一为 0..100%；内存采用 PSS 口径（Debug.MemoryInfo）。
 *
 * 采样在后台线程按固定间隔进行，[cpuPercent] / [memoryMb] 只读取缓存值。
 * 原先这两个函数由 OSD 统计行每 500ms 在主线程直接调用：每次都要
 * `File("/proc/self/stat").readText()` + `Regex("\\s+")`（Kotlin 的 Regex 无缓存，
 * 每次重新编译 Pattern）+ `Debug.getMemoryInfo`（native 层遍历进程内存映射），
 * 在弱 TV SoC 上就是每秒两次可见卡顿。
 */
object SystemStats {

    /** 每秒时钟滴答数（jiffies，绝大多数设备为 100） */
    private val clockTicksPerSec: Long =
        runCatching { Os.sysconf(OsConstants._SC_CLK_TCK).toLong() }.getOrDefault(100L)
            .coerceAtLeast(1L)

    /** CPU 核心数 */
    private val cpuCount: Int = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)

    /** 预编译一次，避免每次采样都重新构造 Pattern */
    private val WHITESPACE = Regex("\\s+")

    /** 采样间隔：OSD 数字变化 0.5s 与 1s 的观感差异很小，但开销减半 */
    private const val SAMPLE_INTERVAL_MS = 1000L

    @Volatile
    private var lastCpuPercent: Int = -1

    @Volatile
    private var lastMemoryMb: Int = -1

    /** 采样线程运行标志 */
    @Volatile
    private var running = false

    /** 采样线程（OSD 打开时创建，关闭时退出；daemon 不阻塞进程退出） */
    @Volatile
    private var worker: Thread? = null

    /** 已启动的采样任务数（多次 start/stop 配对，避免重复创建线程） */
    private val refCount = AtomicInteger(0)

    /** 上次采样的 utime+stime 累计值（仅采样线程访问） */
    private var lastCpuJiffies = 0L

    /** 上次采样的墙钟时间（仅采样线程访问） */
    private var lastSampleMs = 0L

    /** OSD 打开时调用，开始后台采样（幂等） */
    @Synchronized
    fun start() {
        if (refCount.getAndIncrement() != 0) return
        lastSampleMs = 0L // 重新建立基线
        lastCpuPercent = -1
        lastMemoryMb = -1
        running = true
        val existing = worker
        if (existing != null && existing.isAlive) return
        worker = Thread({
            while (running) {
                try {
                    sampleCpu()
                    lastMemoryMb = readMemoryMb()
                } catch (_: Throwable) {
                    // 采样失败保留上一次的值，不影响播放
                }
                try {
                    Thread.sleep(SAMPLE_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }, "system-stats").apply {
            isDaemon = true
            start()
        }
    }

    /** OSD 关闭时调用，停止采样（幂等） */
    @Synchronized
    fun stop() {
        if (refCount.decrementAndGet() > 0) return
        refCount.set(0)
        running = false
        worker?.interrupt()
        worker = null
    }

    /**
     * 当前进程 CPU 占用率（0..100，按全部核心归一）。
     * 采样尚未建立基线时返回 -1（显示为 --）。
     */
    fun cpuPercent(): Int = lastCpuPercent

    /** 本进程内存占用（MB，PSS 口径）；尚未采样或失败时返回 -1 */
    fun memoryMb(): Int = lastMemoryMb

    /** 仅采样线程调用 */
    private fun sampleCpu() {
        // 进程名(comm)可能含空格/括号，取最后一个 ')' 之后的部分
        val tokens = File("/proc/self/stat").readText()
            .substringAfterLast(')')
            .trim()
            .split(WHITESPACE)
        // ')' 之后 index0=字段3(state)，index11=字段14(utime)，index12=字段15(stime)
        val total = tokens[11].toLong() + tokens[12].toLong()
        val now = SystemClock.elapsedRealtime()
        if (lastSampleMs == 0L) {
            lastCpuJiffies = total
            lastSampleMs = now
            return
        }
        val jiffiesDelta = total - lastCpuJiffies
        val timeDeltaMs = now - lastSampleMs
        lastCpuJiffies = total
        lastSampleMs = now
        if (timeDeltaMs <= 0L) return
        lastCpuPercent = (jiffiesDelta * 1000.0 / (clockTicksPerSec * timeDeltaMs) / cpuCount * 100)
            .toInt()
            .coerceIn(0, 100)
    }

    private fun readMemoryMb(): Int {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        return info.totalPss / 1024
    }
}
