package com.mediaiptv.tv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.mediaiptv.tv.service.KeepAlive
import com.mediaiptv.tv.ui.player.MainActivity
import com.mediaiptv.tv.util.Prefs

/**
 * 开机自启 + 升级后重启。
 *
 * 分两件事，分别由两个开关控制：
 *   - **常驻服务**（开关：后台保活，默认开）—— 从广播里启动**服务**是可靠的；
 *   - **拉起界面**（开关：开机自启，默认关）—— 从广播里启动 **Activity** 在
 *     Android 10+ 会被后台启动限制拦掉，只能尽力尝试。
 *
 * 之前这里只做第二件事（startActivity），在 Android 10+ 上基本等于没生效。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON" -> onBoot(context)

            // 应用被覆盖安装（含自动更新）之后进程一定被杀掉了，这里把常驻服务接回来
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Log.d(TAG, "应用已更新，重新拉起常驻服务")
                KeepAlive.ensure(context)
            }
        }
    }

    private fun onBoot(context: Context) {
        // 1. 常驻服务：这条路可靠，先做
        Log.d(TAG, "开机：拉起常驻服务")
        KeepAlive.ensure(context)

        // 2. 界面：尽力尝试，失败属系统行为（Android 10+ 的后台启动限制）
        if (!Prefs.getAutostart(context)) {
            Log.d(TAG, "开机自启界面已关闭，跳过")
            return
        }
        try {
            context.startActivity(
                Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                }
            )
        } catch (e: Exception) {
            // Android 10+ 会抛（Background Activity Start 限制）。界面起不来不是致命问题：
            // 常驻服务已经在了，用户点桌面图标即可，而且那时启动前台服务不再受限。
            Log.e(TAG, "开机拉起界面被系统拦截：${e.message}")
        }
    }

    companion object {
        private const val TAG = "BootReceiver"
    }
}
