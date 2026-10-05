package com.mediaiptv.tv.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.mediaiptv.tv.BuildConfig
import com.mediaiptv.tv.net.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest

/** 服务端上的一个可用更新包 */
data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val size: Long,
    val sha256: String,
    val notes: String,
    val url: String,
)

/** 检查更新的结果 */
sealed class CheckResult {
    /** 有新版 */
    data class Available(val info: UpdateInfo) : CheckResult()
    /** 已是最新 */
    object UpToDate : CheckResult()
    /** 服务端还没放更新包 */
    object NoPackage : CheckResult()
    /** 查询失败（网络/解析/服务端报错） */
    data class Failed(val message: String) : CheckResult()
}

/**
 * 客户端自更新。
 *
 * 注意这里**做不到「静默自动安装」**：Android 只允许系统应用/设备管理员免交互安装，
 * 侧载的普通应用最多做到「检查 → 下载 → 调起系统安装器」，最后一步必须用户在系统
 * 界面上点确认。所以本模块的目标是把这个流程压缩成「一次点击 + 一次确认」。
 */
object Updater {

    /** 下载缓存目录（cacheDir 下的 update/，已在 file_paths.xml 里授权给 FileProvider） */
    private fun updateDir(context: Context): File =
        File(context.cacheDir, "update").apply { mkdirs() }

    /**
     * 查询服务端有没有比本机更新的版本。
     *
     * 分四种结果而不是简单的 null：手动点「检查更新」时，「已是最新」和
     * 「服务器上还没放更新包」是完全不同的两件事，不能让用户点了没反应。
     */
    suspend fun check(context: Context): CheckResult {
        val json = try {
            ApiClient.get(context, "/api/client/version?versionCode=${BuildConfig.VERSION_CODE}")
        } catch (e: Exception) {
            return CheckResult.Failed(e.message ?: "网络错误")
        }
        return try {
            val root = JSONObject(json)
            if (root.optInt("code", -1) != 0) {
                return CheckResult.Failed(root.optString("msg", "服务端返回异常"))
            }
            val data = root.optJSONObject("data") ?: return CheckResult.Failed("响应缺少 data")
            val latest = data.optJSONObject("latest")
            if (latest == null) return CheckResult.NoPackage
            if (!data.optBoolean("hasUpdate", false)) return CheckResult.UpToDate
            val code = latest.optInt("versionCode", 0)
            val name = latest.optString("versionName", "")
            val url = latest.optString("url", "")
            if (code <= 0 || name.isEmpty() || url.isEmpty()) return CheckResult.Failed("服务端返回的更新信息不完整")
            CheckResult.Available(
                UpdateInfo(
                    versionCode = code,
                    versionName = name,
                    size = latest.optLong("size", 0L),
                    sha256 = latest.optString("sha256", ""),
                    notes = latest.optString("notes", ""),
                    url = url,
                )
            )
        } catch (e: Exception) {
            CheckResult.Failed(e.message ?: "解析失败")
        }
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * 下载安装包到缓存目录。已下好且校验通过就直接复用（重试不用重下）。
     * @param onProgress 进度百分比 0..100；拿不到总长度时回调 -1
     */
    suspend fun download(
        context: Context,
        info: UpdateInfo,
        onProgress: (Int) -> Unit = {},
    ): File = withContext(Dispatchers.IO) {
        val out = File(updateDir(context), "mediaiptv_v${info.versionName}.apk")
        // 下载前顺手清掉旧版本的包（保留当前这一个）。
        // 时机放在这里而不是"安装成功之后"：安装一旦开始，本进程很快就被替换掉，
        // 根本没法可靠地判断"到底装成功了没有"。
        pruneCache(context, keep = out)
        if (out.exists() && out.length() > 0 && info.sha256.isNotEmpty() && sha256(out) == info.sha256) {
            onProgress(100)
            return@withContext out
        }
        out.delete()

        val request = Request.Builder().url(info.url).build()
        ApiClient.downloadClient.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("下载失败：HTTP ${resp.code}")
            val body = resp.body ?: throw IOException("下载失败：空响应")
            val total = if (info.size > 0) info.size else body.contentLength()
            body.byteStream().use { input ->
                FileOutputStream(out).use { output ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var lastPct = Int.MIN_VALUE
                    while (true) {
                        // 阻塞式读循环里没有挂起点，协程被取消也不会在这里生效。
                        // 不显式检查的话，用户点了「取消」要等整个包下完才有反应。
                        ensureActive()
                        val n = input.read(buf)
                        if (n <= 0) break
                        output.write(buf, 0, n)
                        done += n
                        val pct = if (total > 0) ((done * 100) / total).toInt().coerceIn(0, 100) else -1
                        if (pct != lastPct) {
                            lastPct = pct
                            onProgress(pct)
                        }
                    }
                }
            }
        }

        // 校验：断流/被中间设备改写都能在这里挡住，避免把坏包交给安装器
        if (info.sha256.isNotEmpty()) {
            val actual = sha256(out)
            if (!actual.equals(info.sha256, ignoreCase = true)) {
                out.delete()
                throw IOException("下载校验失败（sha256 不一致），已丢弃")
            }
        }
        onProgress(100)
        out
    }

    /** 是否已授予「安装未知来源应用」权限（Android 8.0+ 才需要单独授权） */
    fun canInstall(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            true
        }

    /** 跳到本应用的「安装未知应用」授权页 */
    fun openInstallPermissionSettings(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (_: Throwable) {
            // 个别定制系统没有这个页面，退到应用详情页
            try {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: Throwable) { /* 忽略 */ }
        }
    }

    /** 调起系统安装器 */
    fun install(context: Context, apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        context.startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        )
    }

    /**
     * 清掉已下载的旧安装包（保留 [keep]）。
     *
     * 原先这里是一个 `clearCache()`，注释写着"安装成功后再调用" —— 但**全工程没有任何地方调用它**，
     * 于是每更新一次就在 cacheDir/update 下留一份 20MB+ 的 APK，几个版本下来积一堆。
     * 现在由 [download] 在下载新包前调用，只留当前这一个。
     */
    fun pruneCache(context: Context, keep: File? = null) {
        updateDir(context).listFiles()?.forEach { f ->
            if (f.isFile && f.absolutePath != keep?.absolutePath) f.delete()
        }
    }
}
