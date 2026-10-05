package com.mediaiptv.tv.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.mediaiptv.tv.R
import com.mediaiptv.tv.ui.player.MainActivity
import com.mediaiptv.tv.util.Prefs

/**
 * 常驻前台服务。
 *
 * 存在的意义是**提高进程优先级**：普通后台进程在内存紧张时最先被回收，而带常驻通知的
 * 前台服务优先级接近可见进程，电视盒子上长期挂着也不会被清掉。播放本身仍由
 * MainActivity 里的播放器负责，这里不碰播放逻辑。
 *
 * 三个自恢复点：
 *   - `START_STICKY`：被系统杀掉后由系统重建；
 *   - `onTaskRemoved`：用户从最近任务划掉（这种情况 START_STICKY 不重建）→ 自己排闹钟；
 *   - `onDestroy`：被别的方式结束时也排一次闹钟。
 * 再加上 [KeepAlive.scheduleWatchdogJob] 的周期任务兜底。
 */
class KeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        goForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 用户关掉了保活、或收到停止指令：干净退出，不要自我重启
        if (intent?.action == KeepAlive.ACTION_STOP || !Prefs.getKeepAlive(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        goForeground()
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (Prefs.getKeepAlive(this)) KeepAlive.scheduleRestart(this, 1500L)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        // 设置页关闭开关时是「先改 pref 再 stopService」，所以这里不会误重启
        if (Prefs.getKeepAlive(this)) KeepAlive.scheduleRestart(this, 3000L)
        super.onDestroy()
    }

    private fun goForeground() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14 起必须声明前台服务类型，且类型要与 manifest 里的一致
                startForeground(
                    KeepAlive.NOTIFICATION_ID,
                    buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else {
                startForeground(KeepAlive.NOTIFICATION_ID, buildNotification())
            }
        } catch (e: Exception) {
            // 缺权限/类型不匹配时会抛，记录但不崩溃：服务仍以普通后台服务形态运行
            Log.w(TAG, "startForeground 失败：${e.message}")
        }
    }

    private fun buildNotification(): Notification {
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
        val tap = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            flags
        )
        return NotificationCompat.Builder(this, KeepAlive.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_logo_placeholder)
            .setContentTitle(getString(R.string.keepalive_title))
            .setContentText(getString(R.string.keepalive_text))
            .setContentIntent(tap)
            .setOngoing(true)          // 不可滑动清除
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (nm.getNotificationChannel(KeepAlive.CHANNEL_ID) != null) return
        // IMPORTANCE_MIN：不响、不弹横幅、不出现在锁屏，只作为「应用在运行」的常驻提示
        val channel = NotificationChannel(
            KeepAlive.CHANNEL_ID,
            getString(R.string.keepalive_channel),
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = getString(R.string.keepalive_channel_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "KeepAliveService"
    }
}
