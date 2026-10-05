package com.mediaiptv.tv.update

import android.app.Activity
import android.app.AlertDialog
import com.mediaiptv.tv.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.File

/**
 * 更新相关的对话框。
 *
 * 抽出来是为了让「启动时自动检查」和「设置页手动检查」共用同一套流程与文案 ——
 * 两处各写一遍，迟早会出现「自动弹的能装、手动弹的装不上」这种不一致。
 */
object UpdateDialogs {

    /** 发现新版本 */
    fun showFound(activity: Activity, info: UpdateInfo, scope: CoroutineScope, onLater: () -> Unit = {}) {
        val body = buildString {
            if (info.size > 0) append(activity.getString(R.string.update_size_mb, info.size / 1048576.0))
            if (info.notes.isNotBlank()) {
                if (isNotEmpty()) append("\n\n")
                append(info.notes)
            }
        }
        AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.update_found_title, info.versionName))
            // takeIf 而不是 ifBlank { null }：后者在 Kotlin 的类型推断下容易出问题
            .setMessage(body.takeIf { it.isNotBlank() })
            .setPositiveButton(R.string.update_now) { _, _ -> startDownload(activity, info, scope) }
            .setNegativeButton(R.string.update_later) { _, _ -> onLater() }
            .show()
    }

    /** 下载 → 校验 → 调起安装器 */
    private fun startDownload(activity: Activity, info: UpdateInfo, scope: CoroutineScope) {
        // 取消按钮原先传的是 null —— 画出来了、点了却毫无反应，
        // 而且 setCancelable(false) 连 BACK 都关不掉：下载慢的时候用户没有任何退路。
        var job: Job? = null
        val dialog = AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.update_found_title, info.versionName))
            .setMessage(activity.getString(R.string.update_downloading, 0))
            .setCancelable(false)
            .setNegativeButton(android.R.string.cancel) { _, _ -> job?.cancel() }
            .show()

        job = scope.launch {
            val result = runCatching {
                Updater.download(activity, info) { pct ->
                    activity.runOnUiThread {
                        dialog.setMessage(
                            activity.getString(R.string.update_downloading, if (pct < 0) 0 else pct)
                        )
                    }
                }
            }
            dialog.dismiss()
            // 用户主动取消不是"下载失败"，不该再弹一个失败框
            if (result.exceptionOrNull() is CancellationException) return@launch
            result
                .onSuccess { apk -> installWithPermissionCheck(activity, apk) }
                .onFailure { e ->
                    AlertDialog.Builder(activity)
                        .setTitle(R.string.update_check)
                        .setMessage(activity.getString(R.string.update_download_failed, e.message ?: "未知错误"))
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }
        }
    }

    private fun installWithPermissionCheck(activity: Activity, apk: File) {
        if (!Updater.canInstall(activity)) {
            // Android 8.0+ 必须由用户显式允许「安装未知应用」，这里只能引导过去
            AlertDialog.Builder(activity)
                .setTitle(R.string.update_need_permission_title)
                .setMessage(R.string.update_need_permission_msg)
                .setPositiveButton(R.string.update_go_settings) { _, _ ->
                    Updater.openInstallPermissionSettings(activity)
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
            return
        }
        runCatching { Updater.install(activity, apk) }
            .onFailure { e ->
                AlertDialog.Builder(activity)
                    .setTitle(R.string.update_check)
                    .setMessage(activity.getString(R.string.update_download_failed, e.message ?: "无法调起安装器"))
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
            }
    }

    /**
     * 手动检查更新：把四种结果都明确反馈给用户。
     * @param onStatus 用于更新设置页那一行的状态文字（检查中 / 已是最新 / …）
     */
    fun checkManually(activity: Activity, scope: CoroutineScope, onStatus: (String) -> Unit) {
        onStatus(activity.getString(R.string.update_checking))
        scope.launch {
            when (val r = Updater.check(activity)) {
                is CheckResult.Available -> {
                    onStatus("v${r.info.versionName}")
                    showFound(activity, r.info, scope)
                }
                CheckResult.UpToDate -> onStatus(activity.getString(R.string.update_up_to_date))
                CheckResult.NoPackage -> onStatus(activity.getString(R.string.update_no_package))
                is CheckResult.Failed -> {
                    onStatus(activity.getString(R.string.update_check_failed, r.message))
                    AlertDialog.Builder(activity)
                        .setTitle(R.string.update_check)
                        .setMessage(activity.getString(R.string.update_check_failed, r.message))
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                }
            }
        }
    }
}
