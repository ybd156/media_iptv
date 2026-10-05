package com.mediaiptv.tv.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.mediaiptv.tv.util.Prefs

/**
 * 闹钟触发的「把常驻服务拉回来」。
 *
 * 用在两个地方：用户从最近任务里划掉应用之后（`onTaskRemoved`），
 * 以及服务被系统结束时（`onDestroy`）。这两种情况 `START_STICKY` 都不会重建，
 * 必须靠闹钟。
 */
class RestartReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (!Prefs.getKeepAlive(context)) {
            Log.d(TAG, "保活已关闭，忽略重启")
            return
        }
        Log.d(TAG, "收到重启请求，拉起常驻服务")
        KeepAlive.start(context)
    }

    companion object {
        private const val TAG = "RestartReceiver"
    }
}
