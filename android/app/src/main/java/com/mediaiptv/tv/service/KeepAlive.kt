package com.mediaiptv.tv.service

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.mediaiptv.tv.util.Prefs

/**
 * 后台保活的统一入口。
 *
 * 目标：不管应用在前台还是后台，都尽量不被系统回收；真被回收了也要能自己回来。
 * 分层做的四件事：
 *   1. **前台服务常驻**（[KeepAliveService]）—— 带常驻通知，进程优先级远高于普通后台进程，
 *      是最主要的一道防线；
 *   2. **START_STICKY + onTaskRemoved 闹钟** —— 从最近任务里划掉、或被系统杀掉后拉回来；
 *   3. **JobScheduler 周期看门狗**（[KeepAliveJobService]，15 分钟一次、`setPersisted` 跨重启）
 *      —— 兜住前面两道都失效的情况；
 *   4. **电池优化豁免**引导 —— Android 6.0+ 的 Doze/App Standby 会在息屏后限制后台，
 *      豁免之后才真正稳。
 *
 * 说明清楚做不到的事：**用户在系统设置里点「强行停止」之后，应用在下次被手动打开之前
 * 不会以任何方式自启**，这是 Android 的设计，任何应用都绕不过去（能绕过的只有系统签名应用）。
 * 国内盒子 ROM 的「自启动管理/后台清理白名单」同样需要用户手动放行。
 */
object KeepAlive {

    private const val TAG = "KeepAlive"

    const val ACTION_START = "com.mediaiptv.tv.action.KEEPALIVE_START"
    const val ACTION_STOP = "com.mediaiptv.tv.action.KEEPALIVE_STOP"
    const val NOTIFICATION_ID = 1001
    const val CHANNEL_ID = "mediaiptv_keepalive"
    private const val JOB_ID = 2001
    private const val REQ_RESTART = 3001
    private const val REQ_NOTIFICATION = 4001

    fun isEnabled(context: Context): Boolean = Prefs.getKeepAlive(context)

    /** 启动常驻服务。受系统限制时会退化成「过一会儿再试」 */
    fun start(context: Context) {
        if (!isEnabled(context)) return
        val intent = Intent(context, KeepAliveService::class.java).setAction(ACTION_START)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (e: Exception) {
            // Android 12+ 从后台启动前台服务受限（ForegroundServiceStartNotAllowedException）。
            // 退化成排个闹钟稍后重试：等用户把应用切到前台、或授予电池优化豁免之后就能起来。
            Log.w(TAG, "startForegroundService 被系统拒绝：${e.message}，改为稍后重试")
            scheduleRestart(context, 60_000L)
        }
    }

    fun stop(context: Context) {
        cancelRestart(context)
        cancelWatchdogJob(context)
        try {
            context.stopService(Intent(context, KeepAliveService::class.java))
        } catch (_: Exception) {
            // 忽略
        }
    }

    /** 应用在前台时调用：该开的都开上 */
    fun ensure(context: Context) {
        if (!isEnabled(context)) return
        start(context)
        scheduleWatchdogJob(context)
    }

    // ---------------------------------------------------------------- 自恢复

    /** 排一个「过一会儿重启」的闹钟 */
    fun scheduleRestart(context: Context, delayMs: Long) {
        if (!isEnabled(context)) return
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        // 用 set() 而不是 setExact()：精确闹钟在 Android 12+ 需要 SCHEDULE_EXACT_ALARM 权限，
        // 而这里差几秒完全无所谓
        try {
            am.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + delayMs, restartPendingIntent(context))
        } catch (e: Exception) {
            Log.w(TAG, "排重启闹钟失败：${e.message}")
        }
    }

    fun cancelRestart(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        try { am.cancel(restartPendingIntent(context)) } catch (_: Exception) { /* 忽略 */ }
    }

    private fun restartPendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, RestartReceiver::class.java).setAction(ACTION_START)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, REQ_RESTART, intent, flags)
    }

    /** 周期看门狗：服务被回收后最多 15 分钟拉回来（15 分钟是 JobScheduler 的最小周期） */
    fun scheduleWatchdogJob(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
        val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && js.getPendingJob(JOB_ID) != null) return
        val info = JobInfo.Builder(JOB_ID, ComponentName(context, KeepAliveJobService::class.java))
            .setPeriodic(15 * 60 * 1000L)
            .setPersisted(true)          // 重启后依然有效（依赖 RECEIVE_BOOT_COMPLETED）
            .setRequiresDeviceIdle(false)
            .setRequiresCharging(false)
            .build()
        try {
            js.schedule(info)
        } catch (e: Exception) {
            Log.w(TAG, "排看门狗失败：${e.message}")
        }
    }

    fun cancelWatchdogJob(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
        val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
        try { js.cancel(JOB_ID) } catch (_: Exception) { /* 忽略 */ }
    }

    // ---------------------------------------------------------------- 电池优化

    /** 是否已豁免电池优化（Android 6.0 以下没有这个机制，视为已豁免） */
    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return try { pm.isIgnoringBatteryOptimizations(context.packageName) } catch (_: Exception) { true }
    }

    /** 引导用户把本应用加入电池优化白名单 */
    fun requestIgnoreBatteryOptimizations(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        // 先试直接弹「是否允许」；不少 TV 系统裁掉了这个页面，退回白名单列表页
        try {
            context.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (_: Exception) {
            try {
                context.startActivity(
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Exception) {
                Log.w(TAG, "系统没有电池优化设置页")
            }
        }
    }

    // ---------------------------------------------------------------- 通知权限

    /** Android 13+ 需要运行时通知权限；没有它常驻通知不显示（服务本身仍能跑） */
    fun hasNotificationPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    fun requestNotificationPermission(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (hasNotificationPermission(activity)) return
        try {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATION)
        } catch (_: Exception) {
            // 忽略：拿不到就只是不显示常驻通知
        }
    }
}
