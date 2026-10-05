package com.mediaiptv.tv.player

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.LoadControl
import com.mediaiptv.tv.util.Prefs

/**
 * 播放引擎工厂：根据设置创建对应引擎，并配置 LoadControl。
 *
 * 只有两条分支：ExoPlayer（media3，默认）与系统 MediaPlayer。
 * 未知或遗留的引擎名（例如旧版本存下来的 "ijk"）一律落到 ExoEngine。
 */
@UnstableApi
object PlayerEngineFactory {

    fun create(context: Context): PlayerEngine {
        val engineName = Prefs.getEngine(context)
        return if (engineName == Prefs.ENGINE_SYSTEM) {
            SystemEngine(context)
        } else {
            ExoEngine(
                context,
                buildLoadControl(context),
                videoDecodeMode = Prefs.getVideoDecodeMode(context),
                audioDecodeMode = Prefs.getAudioDecodeMode(context),
                quality = Prefs.getQuality(context),
                audioPassthrough = Prefs.getAudioPassthrough(context),
                liveOffsetMs = Prefs.getLiveOffsetMs(context)
            )
        }
    }

    /**
     * 根据用户选择的缓冲档位 + 网络类型动态调整 LoadControl。
     * 低档 2s / 中档 5s / 高档 10s；Wi-Fi 下可适当放宽（中/高档不变，低档维持 2s）。
     *
     * maxBuffer 取档位的 4 倍：点播（VOD）分片时长可达 16s+ 且 CDN（如 jsdelivr）
     * 下载抖动大，更大的预取缓冲能让播放器提前拉好后续分片，避免下不动立刻卡住。
     * 重缓冲后的恢复门槛提到 5s，防止刚恢复又因抖动再次卡停。
     */
    @UnstableApi
    fun buildLoadControl(context: Context): LoadControl {
        val bufferMs = Prefs.getBufferMs(context)
        val isWifi = isWifiConnected(context)
        // Wi-Fi 下中档提升 20%（可酌情调整），移动网络保守
        val multiplier = if (isWifi) 1.2f else 1.0f
        val minBuffer = (bufferMs * multiplier).toInt().coerceAtLeast(1500)
        val maxBuffer = (bufferMs * 4).coerceAtLeast(8000)

        return DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs= */ minBuffer,
                /* maxBufferMs= */ maxBuffer,
                /* bufferForPlaybackMs= */ 800,      // 起播缓冲压到 0.8s，快速出画面
                /* bufferForPlaybackAfterRebufferMs= */ 5000
            )
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()
    }

    private fun isWifiConnected(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val nw = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(nw) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }
}
