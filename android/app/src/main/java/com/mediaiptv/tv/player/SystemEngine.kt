package com.mediaiptv.tv.player

import android.content.Context
import android.media.MediaPlayer
import android.net.Uri
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout

/**
 * 基于系统 MediaPlayer 的引擎封装（engine=system 时使用）。
 * 用于在设备兼容性极差、ExoPlayer 无法解码时的兜底方案。
 */
class SystemEngine(private val context: Context) : PlayerEngine {

    override var listener: PlayerEngine.Listener? = null
    override val view: View get() = surfaceView

    private val surfaceView: SurfaceView = SurfaceView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                mediaPlayer?.setDisplay(holder)
            }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {}
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                mediaPlayer?.setDisplay(null)
            }
        })
    }

    private var mediaPlayer: MediaPlayer? = null
    private var pendingUrl: String? = null
    private var pendingHeaders: Map<String, String> = emptyMap()
    private var isPrepared = false
    private var scaleMode: String = "fit"
    private var videoWidth = 0
    private var videoHeight = 0

    override fun play(url: String, headers: Map<String, String>) {
        setSource(url, headers)
        start()
    }

    override fun setSource(url: String, headers: Map<String, String>) {
        releaseCurrent()
        pendingUrl = url
        pendingHeaders = headers
        isPrepared = false
        // 必须按源重置尺寸：否则 applyScaleMode() 会先用上一路视频的宽高做缩放
        videoWidth = 0
        videoHeight = 0

        val mp = MediaPlayer().apply {
            setOnPreparedListener { _ ->
                isPrepared = true
                listener?.onReady()
                applyScaleMode()
                start()
                notifyPosition()
            }
            setOnErrorListener { _, what, extra ->
                listener?.onError(what, "MediaPlayer error what=$what extra=$extra")
                true
            }
            setOnCompletionListener {
                listener?.onPlaybackStateChanged(false)
            }
            setOnInfoListener { _, what, _ ->
                if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) {
                    listener?.onPlaybackStateChanged(true)
                }
                false
            }
            setOnVideoSizeChangedListener { _, w, h ->
                this@SystemEngine.videoWidth = w
                this@SystemEngine.videoHeight = h
                listener?.onVideoSizeChanged(w, h)
                applyScaleMode()
            }
        }
        mediaPlayer = mp

        try {
            if (headers.isEmpty()) {
                mp.setDataSource(context, Uri.parse(url))
            } else {
                // 系统播放器对 headers 支持有限，这里通过 Uri headers 传递
                mp.setDataSource(context, Uri.parse(url), headers.toMutableMap())
            }
            mp.setDisplay(surfaceView.holder)
            mp.prepareAsync()
        } catch (e: Exception) {
            // 不能只 catch IOException：setDataSource 对不支持的 scheme（rtmp:// / udp:// 等）
            // 会抛 IllegalArgumentException/SecurityException，prepareAsync 会抛
            // IllegalStateException —— 兜底引擎反而会直接把主线程搞崩。
            listener?.onError(-1, "系统播放器无法播放该地址: ${e.message}")
            releaseCurrent()
        }
    }

    override fun start() {
        if (isPrepared) {
            mediaPlayer?.start()
            notifyPosition()
        }
    }

    override fun pause() {
        mediaPlayer?.pause()
    }

    override fun isPlaying(): Boolean = mediaPlayer?.isPlaying ?: false

    override fun currentPosition(): Long = mediaPlayer?.currentPosition?.toLong() ?: 0L

    override fun duration(): Long = mediaPlayer?.duration?.toLong()?.coerceAtLeast(0) ?: 0L

    override fun seekTo(positionMs: Long) {
        val mp = mediaPlayer ?: return
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            mp.seekTo(positionMs, MediaPlayer.SEEK_CLOSEST)
        } else {
            @Suppress("DEPRECATION")
            mp.seekTo(positionMs.toInt())
        }
    }

    override fun setScaleMode(mode: String) {
        scaleMode = mode
        applyScaleMode()
    }

    /**
     * 画面比例。
     *
     * 原实现是「构造一个局部 Matrix 做 scale/translate → 调 setFixedSize() → 再调
     * setSizeFromLayout()」。三个问题：
     *   1. 那个 Matrix 从未交给任何 Canvas/SurfaceHolder/View，纯属死代码；
     *   2. setSizeFromLayout() 与 setFixedSize() 互斥，后者被立即撤销；
     *   3. 于是 fit/fill/zoom/169 四种模式渲染结果完全一样。
     *
     * 正确做法是改变 SurfaceView 的布局尺寸（缓冲区保持原始分辨率，由 SurfaceView
     * 负责缩放到该尺寸）。
     */
    private fun applyScaleMode() {
        if (videoWidth <= 0 || videoHeight <= 0) return
        val parent = surfaceView.parent as? View ?: return
        val pw = parent.width
        val ph = parent.height
        if (pw <= 0 || ph <= 0) return

        val targetW: Int
        val targetH: Int
        when (scaleMode) {
            "fill" -> {
                // 拉伸填满，不保持比例
                targetW = pw
                targetH = ph
            }
            "zoom" -> {
                // 等比放大到铺满并裁掉溢出部分（尺寸可大于父容器，由父容器裁剪）
                val s = maxOf(pw.toFloat() / videoWidth, ph.toFloat() / videoHeight)
                targetW = (videoWidth * s).toInt()
                targetH = (videoHeight * s).toInt()
            }
            "169" -> {
                // 强制按 16:9 处理源画面（非 16:9 源会被拉伸到 16:9）
                val assumedW = videoHeight * 16f / 9f
                val s = minOf(pw / assumedW, ph / videoHeight.toFloat())
                targetW = (assumedW * s).toInt()
                targetH = (videoHeight * s).toInt()
            }
            else -> {
                // fit：等比缩放并完整显示（留黑边）
                val s = minOf(pw.toFloat() / videoWidth, ph.toFloat() / videoHeight)
                targetW = (videoWidth * s).toInt()
                targetH = (videoHeight * s).toInt()
            }
        }

        val w = targetW.coerceAtLeast(1)
        val h = targetH.coerceAtLeast(1)
        val lp = surfaceView.layoutParams as? FrameLayout.LayoutParams
            ?: FrameLayout.LayoutParams(w, h)
        lp.width = w
        lp.height = h
        lp.gravity = Gravity.CENTER
        surfaceView.layoutParams = lp
        // 缓冲区用原始视频尺寸，缩放交给 SurfaceView
        runCatching { surfaceView.holder.setFixedSize(videoWidth, videoHeight) }
    }

    private fun notifyPosition() {
        // 仅触发一次回调，UI 层可定时轮询 currentPosition()
        val mp = mediaPlayer ?: return
        listener?.onPositionChanged(mp.currentPosition.toLong(), mp.duration.toLong().coerceAtLeast(0))
    }

    override fun release() {
        releaseCurrent()
    }

    private fun releaseCurrent() {
        mediaPlayer?.let { mp ->
            try {
                if (mp.isPlaying) mp.stop()
            } catch (e: Exception) { /* ignore */ }
            mp.release()
        }
        mediaPlayer = null
        isPrepared = false
    }
}
