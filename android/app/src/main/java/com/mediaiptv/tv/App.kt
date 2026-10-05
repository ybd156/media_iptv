package com.mediaiptv.tv

import android.app.Application
import com.bumptech.glide.Glide
import com.bumptech.glide.GlideBuilder
import com.bumptech.glide.load.engine.DiskCacheStrategy
import com.bumptech.glide.request.RequestOptions

/**
 * 应用入口：初始化 Glide 全局配置（低分辨率台标缓存策略）
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()
        initGlide()
        preloadFfmpeg()
    }

    private fun initGlide() {
        // Glide 不需要手动 init，这里只是设置全局 RequestOptions
        // 在 UI 加载时使用 lowResolutionChannelLogo() 即可
    }

    /**
     * 后台预加载 native 库。
     *
     * ExoEngine 构造时需同步调用 FfmpegLibrary.isAvailable() 决定扩展渲染器模式，
     * 该调用会 System.loadLibrary 加载数 MB 的 .so；放在主线程会阻塞起播路径。
     *
     * 同理，ijk 兼容引擎的 5 个库（libwsrtcsdk 5.5MB + libijkffmpeg 8MB + libRtsSDK 2.2MB …）
     * 合计约 16MB，原先是在首次 AV3A 换台时于主线程 loadLibrary，直接卡在用户等待的
     * 换台路径上。这里一并提前加载（loadLibrariesOnce 内部幂等）。
     */
    private fun preloadFfmpeg() {
        Thread({
            try {
                androidx.media3.decoder.ffmpeg.FfmpegLibrary.isAvailable()
            } catch (_: Throwable) {
                // 扩展不可用：引擎自动退化为纯平台解码
            }
            try {
                tv.danmaku.ijk.media.player.IjkMediaPlayer.loadLibrariesOnce(null)
            } catch (_: Throwable) {
                // ijk 库不可用：手动切到 ijk 引擎时会退化为 Exo/系统引擎
            }
        }, "native-preload").start()
    }

    companion object {
        /**
         * 频道台标低分辨率加载策略：
         * 列表场景只加载 128x128，避免占用 TV 内存
         */
        fun lowResolutionChannelLogo(): RequestOptions = RequestOptions()
            .override(128, 128)
            .diskCacheStrategy(DiskCacheStrategy.ALL)
            .placeholder(R.drawable.ic_logo_placeholder)
            .error(R.drawable.ic_logo_placeholder)
    }
}
