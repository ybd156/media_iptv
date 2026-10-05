package com.mediaiptv.tv.player

import android.view.Surface
import android.view.View

/**
 * 播放内核统一接口，用于在 ExoPlayer 与系统 MediaPlayer 之间切换。
 * 所有方法应在主线程调用（或内部自行切到主线程）。
 */
interface PlayerEngine {

    /** 播放状态回调 */
    interface Listener {
        fun onReady()
        fun onError(errorCode: Int, errorMessage: String)
        fun onPlaybackStateChanged(isPlaying: Boolean)
        fun onVideoSizeChanged(width: Int, height: Int)
        fun onPositionChanged(positionMs: Long, durationMs: Long)
    }

    val view: View
    var listener: Listener?

    /** 准备并播放目标 URL */
    fun play(url: String, headers: Map<String, String> = emptyMap())

    /** 仅设置源但不播放（回看切换时可用） */
    fun setSource(url: String, headers: Map<String, String> = emptyMap())

    /** 开始播放（如果已准备好） */
    fun start()

    /** 暂停 */
    fun pause()

    /** 是否正在播放 */
    fun isPlaying(): Boolean

    /** 获取当前位置（ms） */
    fun currentPosition(): Long

    /** 获取时长（ms） */
    fun duration(): Long

    /**
     * 距直播边缘的毫秒数（只对直播/时移流有意义）；不是直播流、或还没就绪时返回 -1。
     *
     * 为什么单独要这个方法：时移流是 HLS **live**（播放列表没有 `#EXT-X-ENDLIST`），
     * 这种流的 [duration] 在播放器里是"未定义"的 —— ExoPlayer 返回 0。
     * 而"按总时长算进度条""按总时长减回退量来 seek"这套算法全建立在 duration 上，
     * 于是整个失效：拖了不动、进度条恒等于最右边。
     * 直播流里唯一确定的量是"距边缘多远"，进度和定位都必须用它换算。
     */
    fun liveOffsetMs(): Long = -1L

    /** 跳转到指定位置（ms） */
    fun seekTo(positionMs: Long)

    /** 切换缩放模式：fit/fill/zoom/169 */
    fun setScaleMode(mode: String)

    /** OSD 统计行：源格式/码率/实时网速等；不支持的引擎返回空串 */
    fun statsText(): String = ""

    /** 释放资源 */
    fun release()
}
