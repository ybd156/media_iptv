package com.mediaiptv.tv.service

import android.app.job.JobParameters
import android.app.job.JobService
import android.util.Log
import com.mediaiptv.tv.util.Prefs

/**
 * 周期看门狗：每 15 分钟检查一次常驻服务还在不在，不在就拉起来。
 *
 * 为什么还需要它（前面已经有 START_STICKY + 闹钟了）：
 *   - `START_STICKY` 在部分国产 ROM 上被改得不可靠；
 *   - 闹钟在设备深度 Doze 时可能被推迟很久；
 *   - 而 JobScheduler 的任务带 `setPersisted(true)`，**重启后依然有效**，
 *     相当于「开机自启」的第二条通道（万一 BOOT_COMPLETED 被 ROM 拦掉）。
 *
 * 15 分钟是 JobScheduler 允许的最小周期，也是「被关掉后最多多久回来」的上限。
 */
class KeepAliveJobService : JobService() {

    override fun onStartJob(params: JobParameters?): Boolean {
        if (Prefs.getKeepAlive(this)) {
            Log.d(TAG, "看门狗：确保常驻服务在运行")
            KeepAlive.start(this)
        }
        jobFinished(params, false)
        return false   // 已经同步做完了
    }

    /** 任务被系统打断时返回 true 表示「以后重排」，保活场景下希望它重排 */
    override fun onStopJob(params: JobParameters?): Boolean = Prefs.getKeepAlive(this)

    companion object {
        private const val TAG = "KeepAliveJobService"
    }
}
