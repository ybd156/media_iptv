package com.mediaiptv.tv.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.mediaiptv.tv.net.ApiClient
import com.mediaiptv.tv.util.SystemStats
import okhttp3.OkHttpClient

/**
 * 基于 Media3 ExoPlayer 的引擎封装，支持 HLS/DASH/TS/FLV、自适应码率、清晰度切换。
 *
 * @param loadControl 若传 null，则使用默认配置（自动根据 [PlayerEngineFactory] 生成）
 */
@UnstableApi
class ExoEngine(
    context: Context,
    loadControl: LoadControl? = null,
    private val videoDecodeMode: String = "auto",  // 视频： "auto" | "hw" | "sw"
    private val audioDecodeMode: String = "auto",  // 音频： "auto" | "hw" | "sw"
    private val quality: String = "auto",     // "auto" | "high" | "low"
    private val audioPassthrough: Boolean = false, // 音频直通：AC3/DTS 原样送 HDMI 由电视/功放解码
    private val liveOffsetMs: Int = 2000      // 直播目标偏移：贴直播边缘播放，来源见 Prefs.getLiveOffsetMs
) : PlayerEngine {

    /** 应用级 Context（构造参数本身在成员方法中不可见，需显式持有） */
    private val appContext: Context = context.applicationContext

    override var listener: PlayerEngine.Listener? = null
    override val view: View get() = playerView

    private val trackSelector = DefaultTrackSelector(context).apply {
        setParameters(
            buildUponParameters()
                // 禁止非无缝自适应：码率切换若需要重配解码器（不同分辨率/编码参数），
                // 部分盒子硬解器会在重配后陷入持续花屏。宁可短暂缓冲也不重配解码器。
                .setAllowVideoNonSeamlessAdaptiveness(false)
                // 非直通模式优先 AAC 音轨：避开设备解不了的 AC3 轨（直播无声常见原因）。
                // 直通模式保留原始音轨，由外接功放/电视解码
                .let { p ->
                    if (audioPassthrough) p
                    else p.setPreferredAudioMimeType(androidx.media3.common.MimeTypes.AUDIO_AAC)
                }
                // 音频硬件卸载（offload）：设备支持时把 AAC/MP3 等压缩音轨交给音频 DSP 解码，
                // 不占主 CPU、降低功耗；不支持的设备自动回退普通输出。直播不要求无缝衔接。
                // 音频软解模式（FFmpeg）下必须关闭 offload，否则解码器选择与 offload 互相矛盾。
                .setAudioOffloadPreferences(
                    TrackSelectionParameters.AudioOffloadPreferences.Builder()
                        .setAudioOffloadMode(
                            if (audioDecodeMode == "sw")
                                TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_DISABLED
                            else
                                TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED
                        )
                        // 默认不要求 offload 支持无缝衔接，适配直播场景（Builder 默认 false，无需显式设置）
                        .build()
                )
        )
    }

    /**
     * 解码器过滤结果缓存。
     * 原先每次查询都 `filter` 出一个新 List，而 getDecoderInfos 会在渲染器创建、
     * 格式变化、解码器回退时反复被调用。按 (mime, secure, tunneling, mode) 缓存。
     */
    private val codecFilterCache = HashMap<String, List<MediaCodecInfo>>()

    /** 硬解/软解选择器：视频与音频分别按各自的模式过滤解码器 */
    private val codecSelector = object : MediaCodecSelector {
        override fun getDecoderInfos(
            mimeType: String, requiresSecureDecoder: Boolean, requiresTunnelingDecoder: Boolean
        ): List<MediaCodecInfo> {
            // 视频与音频解码偏好独立生效
            val mode = if (mimeType.startsWith("video/")) videoDecodeMode else audioDecodeMode
            val key = "$mimeType|$requiresSecureDecoder|$requiresTunnelingDecoder|$mode"
            codecFilterCache[key]?.let { return it }
            val all = MediaCodecUtil.getDecoderInfos(mimeType, requiresSecureDecoder, requiresTunnelingDecoder)
            val filtered = when (mode) {
                "sw" -> all.filter { it.softwareOnly }.ifEmpty { all }
                "hw" -> all.filter { it.hardwareAccelerated }.ifEmpty { all }
                else -> all
            }
            codecFilterCache[key] = filtered
            return filtered
        }
    }

    private val renderersFactory = DefaultRenderersFactory(context)
        .setMediaCodecSelector(codecSelector)
        .setEnableDecoderFallback(true) // 首选解码器失败时自动降级，提升老盒子兼容性
        // 异步解码队列：系统默认仅 Android 12+ (API31) 启用异步适配器，
        // 强制 Android 6+ (API23) 全部启用——独立线程喂帧，多核盒子丢帧更少、画面更跟手
        .also { if (Util.SDK_INT >= 23) it.forceEnableMediaCodecAsynchronousQueueing() }
        // FFmpeg 扩展模式：
        // - 音频指定软解（sw）：PREFER，让 FFmpeg 优先于系统解码器；
        // - 自动/硬解：ON，仅平台解不了的格式（AC3/E-AC3/DTS 等）才用 FFmpeg 兜底出声；
        // - 不可用：OFF。
        // 视频扩展（ExperimentalFfmpegVideoRenderer）本身未实现，不影响视频。
        .setExtensionRendererMode(
            when {
                !androidx.media3.decoder.ffmpeg.FfmpegLibrary.isAvailable() ->
                    DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF
                audioDecodeMode == "sw" ->
                    DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
                else ->
                    DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON
            }
        )

    /** 带宽估计器：用于 HLS 自适应码率决策（平滑估计） */
    private val bandwidthMeter = DefaultBandwidthMeter.Builder(context).build()

    /**
     * 实时网速统计：按滑动 1 秒窗口累计实际从网络接收的字节数（非平滑估计），
     * OSD 刷新时取到的就是最近 1 秒的真实瞬时速率。
     * 同时把每秒的字节量存入最多 8 个桶，用于估算整条流的实际码率
     * （裸 TS 流 format.bitrate 未知时的唯一可靠来源）。
     * OkHttp 可能多连接并行回调，统一用 synchronized 保护。
     */
    private val streamStats = object : androidx.media3.datasource.TransferListener {
        private var windowStartMs = android.os.SystemClock.elapsedRealtime()
        private var windowBytes = 0L
        private var lastBps = 0L

        /** 每秒一个桶：[起始时间戳, 该秒字节数]，最多保留 [STREAM_BITRATE_BUCKETS] 个 */
        private val buckets = ArrayDeque<LongArray>()

        override fun onTransferInitializing(
            source: androidx.media3.datasource.DataSource,
            dataSpec: androidx.media3.datasource.DataSpec,
            isNetwork: Boolean
        ) {}

        override fun onTransferStart(
            source: androidx.media3.datasource.DataSource,
            dataSpec: androidx.media3.datasource.DataSpec,
            isNetwork: Boolean
        ) {}

        override fun onBytesTransferred(
            source: androidx.media3.datasource.DataSource,
            dataSpec: androidx.media3.datasource.DataSpec,
            isNetwork: Boolean,
            bytesTransferred: Int
        ) = synchronized(this) {
            if (isNetwork) windowBytes += bytesTransferred
        }

        override fun onTransferEnd(
            source: androidx.media3.datasource.DataSource,
            dataSpec: androidx.media3.datasource.DataSpec,
            isNetwork: Boolean
        ) {}

        /** 秒窗口结算：满 1 秒就固化一个桶并淘汰旧桶 */
        private fun rollLocked(now: Long) {
            val elapsed = now - windowStartMs
            if (elapsed >= 1000L) {
                lastBps = windowBytes * 1000L / elapsed
                buckets.addLast(longArrayOf(windowStartMs, windowBytes))
                while (buckets.size > STREAM_BITRATE_BUCKETS) buckets.removeFirst()
                windowStartMs = now
                windowBytes = 0L
            }
        }

        /** 最近 1 秒的真实字节速率（字节/秒） */
        fun bytesPerSecond(): Long = synchronized(this) {
            rollLocked(android.os.SystemClock.elapsedRealtime())
            lastBps
        }

        /**
         * 换台时清空统计。
         * 不清的话新频道的"流码率"会混入上一路流最多 8 秒的字节数
         * （rollLocked 只按桶数量淘汰），切台后第一帧甚至可能显示旧频道的突发值。
         */
        fun reset() = synchronized(this) {
            buckets.clear()
            windowBytes = 0L
            windowStartMs = android.os.SystemClock.elapsedRealtime()
            lastBps = 0L
        }

        /**
         * 近 [STREAM_BITRATE_BUCKETS] 秒滚动窗口的平均速率（字节/秒）。
         * 稳态播放时约等于内容码率；起播初的缓冲突发会随窗口滑动自然消失。
         */
        fun streamBitrate(): Long = synchronized(this) {
            val now = android.os.SystemClock.elapsedRealtime()
            rollLocked(now)
            if (buckets.isEmpty()) return 0L
            var sum = 0L
            for (b in buckets) sum += b[1]
            val span = (now - buckets.first()[0]).coerceAtLeast(1L)
            sum * 1000L / span
        }
    }

    private val player: ExoPlayer = ExoPlayer.Builder(context)
        .setRenderersFactory(renderersFactory)
        .setTrackSelector(trackSelector)
        .setLoadControl(loadControl ?: DefaultLoadControl.Builder().build())
        .setBandwidthMeter(bandwidthMeter)
        .setSeekForwardIncrementMs(10000)
        .setSeekBackIncrementMs(10000)
        .setWakeMode(C.WAKE_MODE_NETWORK) // TV 播放时保持网络活跃
        .build()
        .apply {
            playWhenReady = true // 源准备好立即开播，不等待显式 play()
            // seek 对齐到**关键帧**。视频只能从关键帧开始解码，音频不需要 ——
            // 精确 seek 到关键帧中间时，音频立刻能出声，画面却要等解码追上，
            // 表现就是"声音出来了，画面要卡几秒才加载"（线上反馈，回看/时移都有）。
            // 本流关键帧实测 10 秒一个，CLOSEST_SYNC 让落点最多差半个 GOP（±5 秒），
            // 换来第一帧立刻出画 —— 拖动时的观感差别很大。
            setSeekParameters(SeekParameters.CLOSEST_SYNC)
            addAnalyticsListener(object : AnalyticsListener {
                // ── 音轨能不能播 ──
                // 1.11.17 起 AV3A(AVS3) 音频没有解码器了（ijk 兼容引擎随商业 SDK 移除）。
                // 播放器对解不了的音轨是**默默跳过**的：视频照播、音频没有，而且不报错 ——
                // 用户只会觉得"这个台没声音"，查不出原因。所以这里主动判一次并通知外层提示。
                // 只提示、不切引擎：已经没有可切的引擎了。
                override fun onTracksChanged(
                    eventTime: AnalyticsListener.EventTime,
                    tracks: androidx.media3.common.Tracks
                ) {
                    if (unsupportedAudioNotified) return
                    var hasAudio = false
                    var playable = false
                    var badMime = ""
                    for (group in tracks.groups) {
                        if (group.type != androidx.media3.common.C.TRACK_TYPE_AUDIO) continue
                        hasAudio = true
                        for (i in 0 until group.length) {
                            if (group.isTrackSupported(i)) {
                                playable = true
                            } else {
                                val m = group.getTrackFormat(i).sampleMimeType.orEmpty()
                                if (m.isNotEmpty()) badMime = m
                            }
                        }
                    }
                    if (hasAudio && !playable) {
                        unsupportedAudioNotified = true
                        val label = when {
                            badMime.contains("av3a") || badMime.contains("avs3") -> "AV3A(AVS3) 音频"
                            badMime.isNotEmpty() -> badMime.substringAfter('/').uppercase()
                            else -> "该音轨"
                        }
                        android.util.Log.i("ExoAudio", "unsupported audio mime=$badMime → 提示用户")
                        onUnsupportedAudio?.invoke("$label 本机无法解码：只有画面、没有声音")
                    }
                }

                // ── 加载时序诊断 ──
                // 线上问题：「进时移要等 5~10 秒才出画面，而服务端只用了 88ms」。
                // 光看应用日志分不清是"应用还没把源交给播放器"还是"播放器自己不发请求"，
                // 这里把播放器的加载事件按 elapsedRealtime 打出来，和 MainActivity 的
                // "engine.play() 调用前/返回" 一对，就能定位到是谁在拖。
                override fun onLoadStarted(
                    eventTime: AnalyticsListener.EventTime,
                    loadEventInfo: androidx.media3.exoplayer.source.LoadEventInfo,
                    mediaLoadData: androidx.media3.exoplayer.source.MediaLoadData
                ) {
                    android.util.Log.i(
                        "ExoLoad",
                        "start +${eventTime.realtimeMs} ${loadEventInfo.uri?.lastPathSegment} pos=${loadEventInfo.dataSpec.position} len=${loadEventInfo.dataSpec.length}"
                    )
                }

                override fun onLoadCompleted(
                    eventTime: AnalyticsListener.EventTime,
                    loadEventInfo: androidx.media3.exoplayer.source.LoadEventInfo,
                    mediaLoadData: androidx.media3.exoplayer.source.MediaLoadData
                ) {
                    android.util.Log.i(
                        "ExoLoad",
                        "done  +${eventTime.realtimeMs} ${loadEventInfo.uri?.lastPathSegment} bytes=${loadEventInfo.bytesLoaded} 耗时=${loadEventInfo.loadDurationMs}ms"
                    )
                }

                override fun onTimelineChanged(eventTime: AnalyticsListener.EventTime, reason: Int) {
                    android.util.Log.i("ExoLoad", "timeline +${eventTime.realtimeMs} reason=$reason")
                }

                override fun onPlaybackStateChanged(eventTime: AnalyticsListener.EventTime, state: Int) {
                    android.util.Log.i("ExoLoad", "state +${eventTime.realtimeMs} state=$state")
                }

                // 记录实际使用的视频解码器名（判断硬解/软解）与帧率，供 OSD 统计行展示
                override fun onVideoDecoderInitialized(
                    eventTime: AnalyticsListener.EventTime,
                    decoderName: String,
                    initializedTimestampMs: Long,
                    initializationDurationMs: Long
                ) {
                    videoDecoderName = decoderName
                }

                override fun onVideoInputFormatChanged(
                    eventTime: AnalyticsListener.EventTime,
                    format: androidx.media3.common.Format,
                    decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?
                ) {
                    videoFrameRate = format.frameRate
                }

                // 视频解码器报错（多数是损坏码流导致参考帧损坏、持续花屏）。
                // 5 秒窗口内累计达到阈值判定为"解码器陷入坏状态"，通知外层重新解码/重建解码器。
                override fun onVideoCodecError(
                    eventTime: AnalyticsListener.EventTime,
                    videoCodecError: Exception
                ) {
                    val now = System.currentTimeMillis()
                    codecErrorTimes.add(now)
                    while (codecErrorTimes.first() < now - CODEC_ERROR_WINDOW_MS) {
                        codecErrorTimes.removeFirst()
                    }
                    if (codecErrorTimes.size >= CODEC_ERROR_BURST_THRESHOLD) {
                        codecErrorTimes.clear()
                        onVideoCodecErrorBurst?.invoke()
                    }
                }

                // 记录音频解码器与格式，供 OSD 统计行展示
                override fun onAudioDecoderInitialized(
                    eventTime: AnalyticsListener.EventTime,
                    decoderName: String,
                    initializedTimestampMs: Long,
                    initializationDurationMs: Long
                ) {
                    audioDecoderName = decoderName
                }

                override fun onAudioInputFormatChanged(
                    eventTime: AnalyticsListener.EventTime,
                    format: androidx.media3.common.Format,
                    decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?
                ) {
                    audioMime = format.sampleMimeType ?: ""
                }
            })
        }

    /** 当前视频解码器名（c2.android/OMX.google 开头为软解） */
    private var videoDecoderName: String = ""

    /** 当前音频解码器名 */
    private var audioDecoderName: String = ""

    /** 当前音频 MIME 类型（如 audio/mp4a-latm） */
    private var audioMime: String = ""

    /** 当前视频帧率（-1 表示未知） */
    private var videoFrameRate: Float = -1f

    /** 解码器持续花屏突发回调：5 秒内达到 [CODEC_ERROR_BURST_THRESHOLD] 次错误时触发，由上层恢复 */
    var onVideoCodecErrorBurst: (() -> Unit)? = null

    /** onVideoCodecError 时间戳滑动窗口（仅保留该时长内的错误） */
    private val codecErrorTimes = ArrayDeque<Long>()

    /** 播放中途卡死回调：连续 [STALL_TIMEOUT_MS] 未正常播放（缓冲不恢复/连接假死/位置冻结）时触发 */
    var onPlaybackStalled: (() -> Unit)? = null

    /** 卡死监测 Handler（主线程轮询） */
    private val stallHandler = Handler(Looper.getMainLooper())

    /** 开始持续未播放的时间（0 表示当前在正常播放） */
    private var notPlayingSinceMs = 0L

    /** 上次观测到的播放位置，用于检测"播放器认为在播但画面冻结" */
    private var lastObservedPositionMs = Long.MIN_VALUE

    /**
     * 音轨本机无法解码时触发（例如 AV3A / AVS3 音频），参数是给用户看的文案。
     *
     * 1.11.17 起 ijk 兼容引擎随商业 SDK 一起移除了，所以这个回调**只用来提示**，
     * 外层不会再切换引擎。留着它的原因：播放器遇到解不了的音轨会默默跳过（继续播视频），
     * 用户看到的是"有画无声"却不知道为什么 —— 没有提示就等于坏得不明不白。
     */
    var onUnsupportedAudio: ((String) -> Unit)? = null

    /** 同一次播放里只提示一次（换台/重连时由 [resetStreamState] 重置） */
    private var unsupportedAudioNotified = false

    /** 播放位置连续不变的开始时间（0 表示位置在推进） */
    private var positionFrozenSinceMs = 0L

    /**
     * 卡死监测：每 [STALL_MONITOR_INTERVAL_MS] 检查一次播放状态。
     * 两种卡死：
     * 1) playWhenReady 但 isPlaying=false 持续超时（持续缓冲/拉流假死，且没有致命错误回调）；
     * 2) isPlaying=true 但 currentPosition 长时间不推进（解码器/渲染线程假死）。
     * 用户主动暂停（playWhenReady=false）、IDLE、ENDED 状态不监测。
     */
    private val stallMonitor = object : Runnable {
        override fun run() {
            val state = player.playbackState
            val now = System.currentTimeMillis()
            if (player.playWhenReady && state != Player.STATE_IDLE && state != Player.STATE_ENDED) {
                if (player.isPlaying) {
                    notPlayingSinceMs = 0L
                    // 位置冻结检测
                    val pos = player.currentPosition
                    if (pos == lastObservedPositionMs) {
                        if (positionFrozenSinceMs == 0L) positionFrozenSinceMs = now
                        else if (now - positionFrozenSinceMs >= STALL_TIMEOUT_MS) {
                            positionFrozenSinceMs = 0L
                            onPlaybackStalled?.invoke()
                        }
                    } else {
                        positionFrozenSinceMs = 0L
                    }
                    lastObservedPositionMs = pos
                } else {
                    if (notPlayingSinceMs == 0L) notPlayingSinceMs = now
                    else if (now - notPlayingSinceMs >= STALL_TIMEOUT_MS) {
                        notPlayingSinceMs = 0L
                        onPlaybackStalled?.invoke()
                    }
                }
            } else {
                notPlayingSinceMs = 0L
                positionFrozenSinceMs = 0L
            }
            // 只在真正播放中继续轮询：暂停/空闲时每 2 秒唤醒主线程毫无意义
            if (player.playWhenReady &&
                player.playbackState != Player.STATE_IDLE &&
                player.playbackState != Player.STATE_ENDED
            ) {
                stallHandler.postDelayed(this, STALL_MONITOR_INTERVAL_MS)
            }
        }
    }

    /** 重新武装卡死监测（play/setSource 时调用；暂停后不会自我续期） */
    private fun armStallMonitor() {
        stallHandler.removeCallbacks(stallMonitor)
        stallHandler.postDelayed(stallMonitor, STALL_MONITOR_INTERVAL_MS)
    }

    /**
     * 用户主动拖动进度条（遥控器左右键 / 触摸拖）后调用：把卡死计时清零。
     *
     * seek 之后的重新缓冲是**正常的**（播放器要去取新的那一小段），不该被当成
     * "连接假死"。否则一次稍慢的 seek 就会触发卡死监测 → 客户端自己把流重启 →
     * 用户拖到的位置也丢了。线上反馈的原话是：
     * 「拉进度条画面会卡住，一段时间就提示拉流失败，明明网速在跑」。
     */
    fun noteUserSeek() {
        positionFrozenSinceMs = 0L
        notPlayingSinceMs = 0L
        armStallMonitor()
    }

    private companion object {
        /** 错误统计窗口（ms） */
        const val CODEC_ERROR_WINDOW_MS = 5000L
        /** 窗口内多少次解码器错误判定为持续花屏 */
        const val CODEC_ERROR_BURST_THRESHOLD = 3
        /** 卡死判定超时（ms）：连续该时长未正常播放即触发重新拉流 */
        const val STALL_TIMEOUT_MS = 12_000L
        /** 卡死监测轮询间隔（ms） */
        const val STALL_MONITOR_INTERVAL_MS = 2_000L
        /** 流码率滚动窗口的桶数（每桶 1 秒，即近 8 秒平均） */
        const val STREAM_BITRATE_BUCKETS = 8
    }

    private val playerView: PlayerView = (android.view.LayoutInflater.from(context)
        .inflate(com.mediaiptv.tv.R.layout.view_player, null) as PlayerView).apply {
        useController = false
        // 不显示缓冲转圈：换台用画面淡入淡出过渡，转圈显得生硬
        setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
        player = this@ExoEngine.player
        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
    }

    /** PlayerView 内部的比例布局（media3 无公开 getter，用公开 id 取） */
    private val contentFrame: AspectRatioFrameLayout? =
        playerView.findViewById(androidx.media3.ui.R.id.exo_content_frame)

    private var lastUrl: String? = null
    private var lastHeaders: Map<String, String> = emptyMap()

    init {
        armStallMonitor() // 开始卡死监测（暂停后会自行停止续期）
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    listener?.onReady()
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                listener?.onPlaybackStateChanged(isPlaying)
            }

            override fun onPlayerError(error: PlaybackException) {
                listener?.onError(error.errorCode, error.message ?: "ExoPlayer error")
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                listener?.onVideoSizeChanged(videoSize.width, videoSize.height)
            }

            override fun onEvents(player: Player, events: Player.Events) {
                if (events.contains(Player.EVENT_POSITION_DISCONTINUITY)) {
                    listener?.onPositionChanged(
                        player.currentPosition,
                        player.duration.coerceAtLeast(0)
                    )
                }
            }
        })
    }

    override fun play(url: String, headers: Map<String, String>) {
        setSource(url, headers)
        start()
    }

    /**
     * 清空上一路流遗留的每流状态。引擎实例在换台/换线路/重连时会被复用
     * （MainActivity 对同一实例反复调用 play），不重置会导致 OSD 数据串台、
     * 花屏恢复误触发等问题。
     */
    private fun resetStreamState() {
        streamStats.reset()
        codecErrorTimes.clear()
        videoDecoderName = ""
        audioDecoderName = ""
        audioMime = ""
        videoFrameRate = -1f
        notPlayingSinceMs = 0L
        lastObservedPositionMs = Long.MIN_VALUE
        positionFrozenSinceMs = 0L
        offloadCacheKey = ""
        // 换台/重连要重新判一次音轨：上一个台提示过"音轨不支持"，新台可能完全正常
        unsupportedAudioNotified = false
    }

    override fun setSource(url: String, headers: Map<String, String>) {
        // 先清掉上一路流遗留的状态。引擎实例会在换台/换线路/重连时被复用，
        // 不重置会导致：OSD 码率混入旧频道的字节（最长 8 秒）、
        // codecErrorTimes 残留旧错误从而误触发"重新解码"恢复。
        resetStreamState()

        lastUrl = url
        lastHeaders = headers

        // Util.inferContentType 统一判定（代理 URL 已带 .m3u8/.flv 后缀提示），
        // 不再只判断 endsWith，避免带 query 的 HLS 地址被误判为 TS
        val contentType = Util.inferContentType(android.net.Uri.parse(url))

        // 时移流（服务端的 HLS 切片列表）**不要**套用"贴直播边缘"的低延迟配置。
        //
        // 时移分片是 10 秒一个（关键帧对齐），按 3 秒贴边播的话，播放器的起点就落在
        // **播放列表的最后一个分片**上，而下一个分片要等下一个关键帧写出来才会出现 ——
        // 服务端日志 + 播放器加载日志实测：进时移后 11 秒才出画面，期间只有播放列表
        // 每 5 秒刷一次、播放器一直 BUFFERING。不设这个偏移时，ExoPlayer 按
        // 3×TARGETDURATION 自己算（10 秒分片 → 30 秒余量），起点落在**更早的完整分片**上，
        // 手上永远有下一片可取，进时移立刻出画。
        // 代价：时移里"直播边缘"比真直播晚 ~30 秒 —— 这本来就和客户端进时移时
        // "回退 30 秒"的定位一致，而"回到直播"走的是直连流，不受影响。
        val isTimeshiftStream = url.contains("/stream/timeshift/")
        val mediaItemBuilder = MediaItem.Builder().setUri(url)
        if (!isTimeshiftStream) {
            // LL-HLS / 直播低延迟配置：贴直播边缘播放，允许轻微倍速追帧。
            // 目标偏移由设置决定（后台「直播偏移」→ 客户端默认值，客户端设置页优先）；
            // 原先这里写死 2000，后台那个字段填了完全不起作用。
            mediaItemBuilder.setLiveConfiguration(
                MediaItem.LiveConfiguration.Builder()
                    // Media3 的这几个参数是 Long；Int 字面量能自动推导，Int 变量不行
                    .setTargetOffsetMs(liveOffsetMs.toLong())
                    .setMinOffsetMs((liveOffsetMs / 2).coerceAtLeast(500).toLong())
                    .setMaxOffsetMs((liveOffsetMs * 5 / 2).coerceAtLeast(3000).toLong())
                    .setMinPlaybackSpeed(0.97f)
                    .setMaxPlaybackSpeed(1.03f)
                    .build()
            )
        }
        val mediaItem = mediaItemBuilder.build()
        applyQualityPreference()
        val okHttpClient = ApiClient.streamClient

        val dataSourceFactory = OkHttpDataSource.Factory(okHttpClient).apply {
            setDefaultRequestProperties(headers)
            setTransferListener(streamStats) // 实时网速统计
        }

        val mediaSource = when (contentType) {
            C.CONTENT_TYPE_HLS ->
                HlsMediaSource.Factory(dataSourceFactory)
                    // 播放列表带 CODECS 属性时直接初始化轨道、免下载首个分片，切台起播更快；
                    // 缺少属性时自动回退传统准备方式
                    .setAllowChunklessPreparation(true)
                    // 提取器：Media3 默认（DefaultHlsExtractorFactory）。
                    // 这里曾挂自定义工厂以识别 0xD5 AVS3 音频（AV3A），随 ijkplayer 与
                    // 商业 SDK 一并移除；普通 TS/fMP4/ADTS 分片行为与之前完全一致。
                    .createMediaSource(mediaItem)
            else ->
                androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(dataSourceFactory)
                    .createMediaSource(mediaItem)
        }

        android.util.Log.i("ExoLoad", "setSource 进入 +${android.os.SystemClock.elapsedRealtime()} $url")
        player.setMediaSource(mediaSource)
        player.prepare()
        android.util.Log.i("ExoLoad", "prepare 返回 +${android.os.SystemClock.elapsedRealtime()}")
    }

    override fun start() {
        player.play()
        armStallMonitor()
    }

    override fun pause() {
        player.pause()
    }

    override fun isPlaying(): Boolean = player.isPlaying

    override fun currentPosition(): Long = player.currentPosition

    /** live 流的 duration 是未定义的（返回 0），进度与定位要靠 [liveOffsetMs] 换算 */
    override fun duration(): Long = player.duration.coerceAtLeast(0)

    override fun liveOffsetMs(): Long {
        // 时移流的窗口边界是"直播边缘"，ExoPlayer 用 currentLiveOffset 给出距边缘的距离。
        // 未定义（不是 live 流 / 还没准备好）时它返回 C.TIME_UNSET，这里统一成 -1。
        val off = player.currentLiveOffset
        return if (off == C.TIME_UNSET || off < 0L) -1L else off
    }

    override fun seekTo(positionMs: Long) {
        player.seekTo(positionMs)
    }

    override fun setScaleMode(mode: String) {
        // 169：强制按 16:9 布局内容（0f = 恢复跟随视频真实比例）
        contentFrame?.setAspectRatio(if (mode == "169") 16f / 9f else 0f)
        playerView.resizeMode = when (mode) {
            "fill" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
            "zoom" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
        }
    }

    /**
     * 当前音轨是否真正走音频 DSP 硬解（offload）。
     * offload 生效时不会创建 MediaCodec 音频解码器（audioDecoderName 为空），
     * 因此不能靠解码器名判断；这里用 AudioManager 静态查询，与框架内部选择 offload 时
     * 的判定同源（getPlaybackOffloadSupport），仅 API 31+ 可查。
     */
    /**
     * audioOffloadActive 的缓存。
     * 查询走 AudioManager.getPlaybackOffloadSupport（JNI），且每次都要新建
     * AudioFormat/AudioAttributes，原实现每个 OSD tick 都重算一遍。按音频参数缓存即可。
     */
    private var offloadCacheKey: String = ""
    private var offloadCacheValue: Boolean = false

    private fun audioOffloadActive(): Boolean {
        if (audioDecodeMode == "sw" || Util.SDK_INT < 31) return false
        val f = player.audioFormat ?: return false
        if (f.sampleRate <= 0) return false
        val key = "${f.sampleMimeType}|${f.sampleRate}|${f.channelCount}"
        if (key == offloadCacheKey) return offloadCacheValue
        val value = queryAudioOffload(f)
        offloadCacheKey = key
        offloadCacheValue = value
        return value
    }

    private fun queryAudioOffload(f: Format): Boolean {
        val encoding = when (f.sampleMimeType?.lowercase().orEmpty()) {
            "audio/mp4a-latm", "audio/aac" -> android.media.AudioFormat.ENCODING_AAC_LC
            "audio/mpeg", "audio/mp3" -> android.media.AudioFormat.ENCODING_MP3
            "audio/ac3" -> android.media.AudioFormat.ENCODING_AC3
            "audio/eac3" -> android.media.AudioFormat.ENCODING_E_AC3
            "audio/dts" -> android.media.AudioFormat.ENCODING_DTS
            else -> return false
        }
        val channelMask = when (f.channelCount) {
            1 -> android.media.AudioFormat.CHANNEL_OUT_MONO
            6 -> android.media.AudioFormat.CHANNEL_OUT_5POINT1
            8 -> android.media.AudioFormat.CHANNEL_OUT_7POINT1
            else -> android.media.AudioFormat.CHANNEL_OUT_STEREO
        }
        return try {
            val af = android.media.AudioFormat.Builder()
                .setSampleRate(f.sampleRate)
                .setEncoding(encoding)
                .setChannelMask(channelMask)
                .build()
            val aa = android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MOVIE)
                .build()
            // 静态查询：返回 PLAYBACK_OFFLOAD_SUPPORTED / _NOT_SUPPORTED / _GAPLESS_SUPPORTED
            val support = android.media.AudioManager.getPlaybackOffloadSupport(af, aa)
            support != android.media.AudioManager.PLAYBACK_OFFLOAD_NOT_SUPPORTED
        } catch (e: Exception) {
            false
        }
    }

    /** OSD 统计：源格式 · 硬解/软解 · 帧率 · 流码率(Mbps) · 实时网速(MB/s)，无播放时返回空串 */
    override fun statsText(): String {
        if (player.playbackState == Player.STATE_IDLE) return ""
        val parts = mutableListOf<String>()
        // 源格式：从 URL 后缀提示判断（代理地址带 .m3u8/.flv），否则看容器 MIME
        val url = lastUrl ?: ""
        val fmt = when {
            url.contains(".m3u8") -> "HLS"
            url.contains(".flv") -> "FLV"
            player.videoFormat?.containerMimeType?.contains("mp2t") == true -> "MPEG-TS"
            else -> player.videoFormat?.containerMimeType?.substringAfter('/')?.uppercase() ?: "TS"
        }
        parts.add(fmt)
        // 解码方式（视频：硬解/软解 + 编码格式）
        if (videoDecoderName.isNotEmpty()) {
            val sw = videoDecoderName.startsWith("OMX.google") || videoDecoderName.startsWith("c2.android")
            parts.add(if (sw) "视频软解" else "视频硬解")
        }
        player.videoFormat?.codecs?.substringBefore(',')?.trim()?.let { parts.add(it) }
        // 音频格式 + 音频解码方式（如 "AAC 硬解"、"AC3 软解"）
        // 优先读 player.audioFormat（只要选中音轨就有值）；回调里的 audioMime 兜底
        val curAudioMime = player.audioFormat?.sampleMimeType ?: audioMime
        if (curAudioMime.isNotEmpty()) {
            val m = curAudioMime.lowercase()
            val audioLabel = when {
                m.contains("av3a") || m.contains("avs3") -> "AVS3音频"
                m.contains("mp4a") || m.contains("aac") -> "AAC"
                m.contains("eac3") || m.contains("ec-3") -> "E-AC3"
                m.contains("ac3") || m.contains("ac-3") -> "AC3"
                m.contains("mpeg") || m.contains("mp3") -> "MP3"
                m.contains("mp2") -> "MP2"
                m.contains("dts") -> "DTS"
                m.contains("flac") -> "FLAC"
                m.contains("opus") -> "OPUS"
                m.contains("pcm") || m.contains("raw") -> "PCM"
                else -> curAudioMime.substringAfter('/').uppercase()
            }
            // 解码方式判定优先级：
            // 1) 直通：压缩音轨原样送 HDMI/功放（音频直通开关开启时）
            // 2) DSP offload：压缩音轨交音频 DSP（真正的音频硬解，此时无 MediaCodec 解码器）
            // 3) 按解码器名：ffmpeg/c2.android/OMX.google 为软解，厂商解码器为硬解
            // 解码器尚未初始化时只显示格式
            val canPassthrough = audioPassthrough &&
                (m.contains("ac3") || m.contains("dts") || m.contains("truehd"))
            val modeText = when {
                canPassthrough -> "直通"
                audioOffloadActive() -> "音频硬解"
                audioDecoderName.isEmpty() -> ""
                audioDecoderName.startsWith("ffmpeg", ignoreCase = true)
                    || audioDecoderName.startsWith("OMX.google")
                    || audioDecoderName.startsWith("c2.android") -> "音频软解"
                else -> "音频硬解"
            }
            parts.add(if (modeText.isEmpty()) audioLabel else "$audioLabel $modeText")
        }
        // 帧率
        if (videoFrameRate > 0) parts.add("${videoFrameRate.toInt()}fps")
        // 流码率：HLS/DASH 声明了 bitrate 用声明值；裸 TS 通常没有，
        // 改用近 8 秒实际接收字节的滚动平均（真实内容码率，含少量封装开销）
        val declaredBitrate: Long =
            player.videoFormat?.bitrate?.toLong() ?: C.LENGTH_UNSET.toLong()
        val streamBitrate: Long =
            if (declaredBitrate > 0) declaredBitrate else streamStats.streamBitrate()
        if (streamBitrate > 0) {
            // 整数运算代替 String.format：后者每个 tick 都要构造 Formatter + StringBuilder + 装箱
            val hundredths = (streamBitrate * 100 / 1_000_000L).toInt()
            parts.add("码率 ${hundredths / 100}.${(hundredths % 100).toString().padStart(2, '0')}Mbps")
        }
        // 实时网速：最近 1 秒实际接收字节（非平滑估计），KB/s 或 MB/s
        val bytesPerSec = streamStats.bytesPerSecond()
        if (bytesPerSec > 0) {
            parts.add(
                if (bytesPerSec >= 1_000_000L) {
                    val tenths = (bytesPerSec * 10 / 1_000_000L).toInt()
                    "网速 ${tenths / 10}.${tenths % 10}MB/s"
                } else {
                    "网速 ${(bytesPerSec + 500) / 1000}KB/s"
                }
            )
        }
        // CPU 占用率（%，按全部核心归一）；首次采样无基线显示 --
        val cpu = SystemStats.cpuPercent()
        parts.add(if (cpu >= 0) "CPU $cpu%" else "CPU --")
        // 内存占用（MB，PSS）
        val mem = SystemStats.memoryMb()
        if (mem >= 0) parts.add("MEM $mem MB")
        return parts.joinToString(" · ")
    }

    /** 画质偏好应用：high=锁最高码率轨（起播即最高清，不做自适应降级），low=限制 1280x720，auto=自适应 */
    private fun applyQualityPreference() {
        trackSelector.parameters = trackSelector.buildUponParameters()
            .setForceHighestSupportedBitrate(quality == "high")
            .setMaxVideoSize(
                if (quality == "low") 1280 else Int.MAX_VALUE,
                if (quality == "low") 720 else Int.MAX_VALUE
            )
            .build()
    }

    /** 设置自适应码率是否启用（HLS/DASH 时可用） */
    fun setAdaptiveBitrate(enabled: Boolean) {
        trackSelector.parameters = trackSelector.buildUponParameters()
            .setForceHighestSupportedBitrate(!enabled)
            .build()
    }

    /** 切换固定清晰度轨道（HLS 多轨时可用）。轨道索引基于 [androidx.media3.common.Tracks.Group] 内的顺序 */
    fun selectVideoTrack(trackIndex: Int) {
        val tracks = player.currentTracks
        val videoGroup = tracks.groups.firstOrNull { it.type == C.TRACK_TYPE_VIDEO } ?: return
        if (trackIndex in 0 until videoGroup.mediaTrackGroup.length) {
            trackSelector.parameters = trackSelector.buildUponParameters()
                .setOverrideForType(
                    TrackSelectionOverride(videoGroup.mediaTrackGroup, trackIndex)
                )
                .build()
        }
    }

    override fun release() {
        stallHandler.removeCallbacks(stallMonitor)
        // 摘掉回指 Activity 的引用（这些 lambda 捕获了 MainActivity）并断开视图，
        // 避免释放后仍被回调
        listener = null
        onVideoCodecErrorBurst = null
        onPlaybackStalled = null
        playerView.player = null
        player.release() // release() 内部已包含 stop()
    }
}
