package com.mediaiptv.tv.ui.player

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.SeekBar
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.util.UnstableApi
import androidx.recyclerview.widget.LinearLayoutManager
import com.mediaiptv.tv.R
import com.mediaiptv.tv.databinding.ActivityMainBinding
import com.mediaiptv.tv.model.CatchupSegment
import com.mediaiptv.tv.model.Channel
import com.mediaiptv.tv.model.ChannelGroup
import com.mediaiptv.tv.model.Program
import com.mediaiptv.tv.net.ApiClient
import com.mediaiptv.tv.net.Repository
import com.mediaiptv.tv.player.ExoEngine
import com.mediaiptv.tv.player.IjkEngine
import com.mediaiptv.tv.player.PlayerEngine
import com.mediaiptv.tv.player.PlayerEngineFactory
import com.mediaiptv.tv.ui.adapter.ChannelAdapter
import com.mediaiptv.tv.ui.adapter.EpgAdapter
import com.mediaiptv.tv.ui.adapter.GroupAdapter
import com.mediaiptv.tv.ui.settings.SettingsActivity
import com.mediaiptv.tv.util.Prefs
import com.mediaiptv.tv.util.SystemStats
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * 直播主界面：
 * - 全屏播放、OSD 信息栏、频道列表面板、EPG 面板、回看模式
 * - 长按 OK 呼出多线路切换
 * - 设备绑定未通过时进入轮询
 */
@UnstableApi
class MainActivity : AppCompatActivity() {

    companion object {
        /** 时移相关行为日志：真机排查靠它（截图抓不到视频层，OSD 文本也读不出来） */
        private const val TAG_TS = "Timeshift"
        /** 播放速率诊断日志 */
        private const val TAG_RATE = "PlayRate"

        /** 设置页改画面比例后回调，立即作用于当前引擎（避免返回主页才生效） */
        var onScaleModeChanged: ((String) -> Unit)? = null

        /** 播放中途卡死后最多快速重新拉流次数，超过则换线路或退避重连 */
        private const val STALL_MAX_FAST_RETRIES = 2

        /**
         * 时移起播最多原地等多少次 × [TIMESHIFT_WARMUP_RETRY_MS]。
         * 服务端出第一个分片要 4~5 秒（分片必须从关键帧起切，攒满一个分片时长才落盘），
         * 这里给到约 7 秒的兜底；正常情况下预热已经让窗口建好了，一次都不会用到。
         */
        private const val TIMESHIFT_WARMUP_MAX = 12

        /** 时移窗口建立期间的重试间隔（ms）：0.6s 一探，比 1.5s 少等一整个来回 */
        private const val TIMESHIFT_WARMUP_RETRY_MS = 600L

        // ----- 时移预热 -----
        /**
         * 进频道后多久开始预热时移窗口（ms）。
         * 不立刻做：起播瞬间要和直连流抢上游连接，等服务端那一路稳下来再说。
         */
        private const val TIMESHIFT_WARM_DELAY_MS = 8_000L
        /**
         * 预热续期间隔（ms）。
         * 服务端 2 分钟收不到请求就把会话停掉（省 CPU），而用户常常是"看几分钟直播
         * 再往回拖"，所以要定期续一次，否则真去拖的时候窗口又没了。
         */
        private const val TIMESHIFT_WARM_KEEPALIVE_MS = 90_000L

        // ----- 换台过渡动画 -----
        /** 淡出/淡入时画面最大缩放（轻微放大制造纵深感） */
        private const val SWITCH_SCALE_MAX = 1.05f
        /** 旧画面淡出时长（ms）：动画结束后才切流 */
        private const val SWITCH_FADE_OUT_MS = 180L
        /** 新画面淡入时长（ms） */
        private const val SWITCH_FADE_IN_MS = 320L

        /** 频道面板无操作自动关闭的静止时长（ms） */
        private const val CHANNEL_PANEL_AUTO_HIDE_MS = 3500L

        /** 启动画面兜底超时（ms）：无论加载是否完成都淡出，避免卡死在启动画面 */
        private const val SPLASH_FALLBACK_MS = 8000L

        /**
         * 频道加载的快速重试间隔（ms）。
         * 覆盖「开机后网络还没就绪」那段窗口：盒子拿到 IP 通常要 5~20 秒。
         */
        private val FAST_RETRY_DELAYS_MS = longArrayOf(1500L, 3000L, 5000L, 8000L, 8000L)

        /** 快速重试用完之后的慢重试间隔：一直等，网络/服务端一恢复就自动进入播放 */
        private const val SLOW_RETRY_MS = 30_000L

        /** 时移/回看用遥控器左右键拖动一次的步长 */
        private const val SEEK_STEP_MS = 30_000L
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var repository: Repository

    // ----- 引擎 -----
    private var engine: PlayerEngine? = null
    private var currentUrl: String = ""
    private var currentChannel: Channel? = null

    /**
     * 用户是否期望「正在播放」。
     * 手动暂停（回看模式的 OK 键）会置 false，所以「暂停 → 退到后台 → 回来」不会被自动续播。
     * 退到后台时靠它判断要不要在回到前台时接着放。
     */
    private var playbackActive = false

    /** onStop 那一刻是否正在播放，用于回到前台决定是否续播 */
    private var wasPlayingBeforeStop = false

    /**
     * 是否刚做过「换台淡出」，需要在首帧就绪时做对称的淡入。
     * 重连/重试不淡出，所以这里为 false —— 首帧到达时直接把画面摆正，
     * 不做「放大 → 缩回」的动画（那正是用户看到的"弹一下"）。
     */
    private var awaitingFadeIn = false

    // ----- 数据 -----
    private var groups: List<ChannelGroup> = emptyList()
    private var currentGroupIndex: Int = 0
    private var currentChannelIndexInGroup: Int = 0
    private var currentSourceIndex: Int = 0
    private var currentEpgPrograms: List<Program> = emptyList()
    private var currentCatchupSegment: CatchupSegment? = null
    /** 当前回看片段所属的日期偏移（0=今天，-1=昨天…），用来算"落后直播多久" */
    private var currentCatchupDayOffset: Int = 0
    private var isCatchupMode: Boolean = false

    /**
     * 时移模式：正在播服务端的滚动 HLS，而不是直连/代理的直播流。
     * 与回看的区别：回看是"看过去录下来的某一段"，时移是"直播，但窗口内可以往回拖"。
     */
    private var isTimeshiftMode: Boolean = false
    /** 手指/遥控器正在拖进度条。拖动期间轮询必须让位，否则每 500ms 被刷新抢回去，手感就是「拖不动」 */
    private var isUserSeeking: Boolean = false
    /**
     * 时移起播的重试计数。
     * 服务端要先起 ffmpeg 滚动窗口，头十几秒请求播放列表会拿到 503「缓冲正在建立」。
     * 这期间还没出过画面，属于"还没开始播"，不是线路故障 —— 不该切线路。
     * 出画面后置 -1，之后一律走正常错误处理。
     */
    private var timeshiftWarmup: Int = 0
    /**
     * 是否已经"进入"时移。
     * 频道打开时**不**进时移 —— 直连/代理流起播快，服务器也不必为没人回退的频道白跑 ffmpeg；
     * 只有用户真的往回拖了（触摸拖进度条，或遥控器左键）才切到时移流。
     */
    private var timeshiftEngaged: Boolean = false
    /** 进入时移后要定位到的回退毫秒数（出画后执行一次） */
    private var pendingTimeshiftBackMs: Long = 0L
    /** 回看：出画后要定位到的分片内偏移毫秒数（点的是节目就从节目起点开始） */
    private var pendingCatchupSeekMs: Long = 0L
    /**
     * 已确认建不起时移窗口的线路（channelUrlId）。
     * 服务端是**无条件**给每条线路都发时移地址的，所以"地址存在"不等于"这条源能时移" ——
     * 拉不动或太慢的源，ffmpeg 永远切不出第一个分片。
     * 记下来，换来换去不再反复等十几秒。
     */
    private val timeshiftUnavailable = mutableSetOf<Int>()

    /**
     * 时移预热：用户还在看直播的时候，就悄悄把服务端的时移窗口建起来。
     *
     * 为什么需要：服务端是"第一次请求播放列表时才拉起 ffmpeg"的按需模式，
     * 而第一个分片必须攒满一个分片时长（4 秒）才落盘 —— 用户往回拖之后才开始等这
     * 4~5 秒（线上日志实测这段等待中位 6.4 秒），这就是"点完时移要卡一会儿"。
     * 提前建好窗口后，真去拖的时候播放列表和分片都是毫秒级。
     *
     * 对"有录像的频道"（服务端走录像共用模式）根本没有 ffmpeg 成本，
     * 预热还能顺带把关键帧索引扫热：回看的播放列表请求从 486ms 降到 1~3ms。
     */
    private var timeshiftWarmCall: Call? = null
    /** 正在预热/续期的时移地址；换台或换线路时置空，避免给已经不看的那路白跑 ffmpeg */
    private var timeshiftWarmUrl: String? = null
    private val timeshiftWarmRunnable = Runnable { runTimeshiftWarmup() }

    /**
     * channelId -> (分组下标, 组内下标)。
     * 换台原先要做 3~4 次全列表 O(N) 扫描（含一次 groups.flatMap 复制整份频道列表），
     * 5000 频道下每次换台约 1.5~2 万次比较，全在主线程。频道列表只在加载/刷新时变化，
     * 建一次索引后换台就是 O(1)。
     */
    private var channelIndex: Map<Int, Pair<Int, Int>> = emptyMap()

    // ----- 面板状态 -----
    private enum class Panel { NONE, OSD, CHANNEL, EPG }
    private var currentPanel: Panel = Panel.NONE

    // ----- 协程/Handler -----
    private val mainHandler = Handler(Looper.getMainLooper())
    private var registerJob: Job? = null
    private var heartbeatJob: Job? = null
    /** 频道加载任务：失败会自己重试，重新加载时先取消上一个 */
    private var channelJob: Job? = null
    private var osdHideRunnable: Runnable? = null
    /** 频道面板无操作自动关闭定时器 */
    private var channelPanelHideRunnable: Runnable? = null
    /** 状态提示自动消失定时器 */
    private var statusHideRunnable: Runnable? = null
    private var epgRefreshRunnable: Runnable? = null
    private var reconnectJob: Job? = null
    private var reconnectCount = 0
    private var lastPressedBack = 0L
    /** 回看进度轮询 Job（必须保存以便取消） */
    private var progressJob: Job? = null

    /** 上次已上报给服务端的 (线路 id, 宽, 高)，用于跳过重复上报 */
    private var lastReportedUrlId: Int = -1
    private var lastReportedW: Int = 0
    private var lastReportedH: Int = 0

    /** 长按换台节流时间戳 */
    private var lastZapTime = 0L
    private val ZAP_THROTTLE_MS = 250L

    /**
     * 长按上下键换台节流。
     * 遥控器的重复事件频率很高，原实现每来一个事件就换一次台（重连直播流 + 发一次 EPG 请求），
     * 长按一秒能触发十几次。
     */
    private fun throttleZap(): Boolean {
        val now = System.currentTimeMillis()
        if (now - lastZapTime < ZAP_THROTTLE_MS) return true
        lastZapTime = now
        return false
    }

    // ----- 超时无画面自动换源 -----
    private var switchWatchdog: Runnable? = null
    /** 当前线路是否已出画面（onReady/onVideoSizeChanged 置位） */
    private var renderedSincePlay = false

    /** 是否已成功起播过一次：冷启动首播时 splash 覆盖画面，无需淡出，跳过等待直接拉流 */
    private var hasPlayedOnce = false
    /** 本次频道内已自动换源次数（达到线路数即停止，避免死循环） */
    private var autoSwitchAttempts = 0

    /** 当前频道是否已尝试过 ijk 兼容引擎回退（防止 AV3A 回调重复触发） */
    private var ijkFallbackTried = false

    // ----- 持续花屏自动恢复 -----
    /** 已执行的恢复级别：0=未恢复 1=已重新解码 2=已切换软硬解 3=已换线路（逐级升级，onReady 后归零） */
    private var recoveryLevel = 0

    // ----- 播放中途卡死自动拉流 -----
    /** 本次卡死已快速重拉次数（onReady 后归零，避免无限重拉） */
    private var stallRetryCount = 0

    /** OSD 显示期间每秒刷新统计行（网速/格式/码率） */
    private var statsRunnable: Runnable? = null

    /** sourceId -> 实际出画面高度，用于选源弹窗展示 */
    private val sourceHeights = mutableMapOf<Int, Int>()

    // ----- Adapters -----
    private lateinit var groupAdapter: GroupAdapter
    private lateinit var channelAdapter: ChannelAdapter
    private lateinit var epgAdapter: EpgAdapter

    private val sdfDate = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())

    /** EPG 面板查看的日期偏移：0=今天，-1=昨天 … 最多 -6（回看七天），+1..+7 未来预告 */
    private var epgDateOffset = 0

    private fun epgDateStr(): String {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, epgDateOffset)
        return sdfDate.format(cal.time)
    }

    private fun epgDateLabel(): String {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_YEAR, epgDateOffset)
        val md = SimpleDateFormat("MM-dd", Locale.getDefault()).format(cal.time)
        return when (epgDateOffset) {
            0 -> "${getString(R.string.epg_today)} $md"
            1 -> "${getString(R.string.epg_tomorrow)} $md"
            else -> md
        }
    }

    /** 切换 EPG 面板日期并重新加载该天节目单（-6 回看 … 0 今天 … +7 预告） */
    private fun shiftEpgDate(delta: Int) {
        val next = (epgDateOffset + delta).coerceIn(-6, 7)
        if (next == epgDateOffset) return
        epgDateOffset = next
        binding.tvEpgDate.text = "◀  ${epgDateLabel()}  ▶"
        currentChannel?.let { loadEpgForChannel(it) }
    }
    private val sdfTime = SimpleDateFormat("HH:mm", Locale.getDefault())
    private val sdfTimeSec = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 全面屏：隐藏状态栏/导航栏，画面延伸到刘海/挖孔区域
        enterImmersiveMode()

        repository = Repository(this)

        setupRecyclerViews()
        setupSeekBar()
        setupListeners()

        // 启动画面：覆盖注册/加载/起播全过程
        startSplash()
        // 先发起注册/心跳/频道请求与上次地址的连接预热（均为异步），让网络往返与随后的
        // 引擎初始化（ExoPlayer 构建 + FFmpeg 库加载）重叠执行，缩短"启动→起播"耗时。
        // 协程的 Main 续体排在主线程队列之后，引擎必然先于起播就绪。
        startRegistrationFlow()
        warmUpStreamConnection()
        // 冷启动：上次观看的线路若已知需要 AV3A 兼容引擎，直接起 ijk，
        // 省掉"ExoPlayer 构建 → 解析出 av3a → 推翻重建 ijk"这一整轮（实测该路径多花约 3–4s）
        setupEngine(
            useIjk = Prefs.getEngine(this) == Prefs.ENGINE_EXO && Prefs.isLastSourceAv3a(this)
        )
        // 设置页切换画面比例 → 立即作用于当前引擎
        onScaleModeChanged = { mode -> engine?.setScaleMode(mode) }

        checkUpdateOnStart()

        // 后台保活：拉起常驻前台服务（开关在设置 → 系统 → 后台保活，默认开）。
        // 用户此刻就在前台，所以这里启动前台服务不受 Android 12+ 的后台启动限制。
        com.mediaiptv.tv.service.KeepAlive.ensure(this)
        // Android 13+ 常驻通知需要运行时权限；拿不到只是不显示通知，服务照常
        com.mediaiptv.tv.service.KeepAlive.requestNotificationPermission(this)
    }

    /**
     * 启动时静默检查更新：只有确实有新版本才弹窗。
     *
     * 延迟几秒再查，避开启动画面与起播路径（电视盒子开机那几秒本来就在抢带宽/CPU）。
     * 用户点过「稍后」的版本不再重复打扰——开机就弹窗非常烦人；但更高版本仍会提示，
     * 设置页里的「检查更新」也永远会显示结果。
     */
    private fun checkUpdateOnStart() {
        lifecycleScope.launch {
            kotlinx.coroutines.delay(5000)
            val r = com.mediaiptv.tv.update.Updater.check(this@MainActivity)
            if (r !is com.mediaiptv.tv.update.CheckResult.Available) return@launch
            if (r.info.versionCode <= Prefs.getSkippedUpdateVersion(this@MainActivity)) return@launch
            com.mediaiptv.tv.update.UpdateDialogs.showFound(this@MainActivity, r.info, lifecycleScope) {
                Prefs.setSkippedUpdateVersion(this@MainActivity, r.info.versionCode)
            }
        }
    }

    /**
     * 冷启动连接预热：后台先向上次成功播放的地址发起一次请求，把 DNS/TCP/TLS（含 HTTP/2）
     * 握手提前做完并放入 OkHttp 连接池；ExoPlayer 用同一个 OkHttpClient 拉流时可直接复用
     * 连接，省去握手耗时。结果丢弃，失败静默（预热失败不影响正常播放）。
     */
    private fun warmUpStreamConnection() {
        val url = Prefs.getLastPlayUrl(this)
        if (url.isEmpty()) return
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                com.mediaiptv.tv.net.ApiClient.streamClient
                    .newCall(okhttp3.Request.Builder().url(url).build())
                    .execute()
                    .use { it.body?.close() }
            } catch (_: Exception) {
                // 预热失败忽略
            }
        }
    }

    // ============================ 启动画面 ============================

    /** 启动画面是否已淡出（避免重复执行动画） */
    private var splashDismissed = false

    private var splashFallback: Runnable? = null

    /** 全频道"正在播出"是否已拉取：延迟到首帧之后再拉，避免起播阶段抢带宽 */
    private var nowPlayingLoaded = false

    /** 启动画面入场：Logo 从 0.85 倍缩放淡入，同时挂兜底超时 */
    private fun startSplash() {
        val logo = binding.ivSplashLogo
        logo.alpha = 0f
        logo.scaleX = 0.85f
        logo.scaleY = 0.85f
        logo.animate()
            .alpha(1f).scaleX(1f).scaleY(1f)
            .setDuration(500)
            .setInterpolator(android.view.animation.DecelerateInterpolator())
            .start()
        splashFallback = Runnable { dismissSplash() }
        mainHandler.postDelayed(splashFallback!!, SPLASH_FALLBACK_MS)
    }

    /** 淡出启动画面露出主界面（首帧就绪 / 需绑定 / 兜底超时三处调用） */
    private fun dismissSplash() {
        if (splashDismissed) return
        splashDismissed = true
        splashFallback?.let { mainHandler.removeCallbacks(it) }
        splashFallback = null
        binding.splash.animate().cancel()
        binding.splash.animate()
            .alpha(0f)
            .setDuration(250)
            .setInterpolator(android.view.animation.DecelerateInterpolator())
            .withEndAction { binding.splash.visibility = View.GONE }
            .start()
    }

    // ============================ 初始化 ============================

    /** 沉浸式全面屏：隐藏状态栏与导航栏，内容延伸到刘海/挖孔区域；系统栏滑出后自动再隐藏 */
    private fun enterImmersiveMode() {
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        // 刘海屏/挖孔屏区域也用于渲染（API 28+）
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            window.attributes.layoutInDisplayCutoutMode =
                android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        val controller = androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // 用户滑出系统栏后，窗口重新获焦时再次隐藏
        if (hasFocus) enterImmersiveMode()
    }

    /** 重建 channelId -> (gi, ci) 索引。频道列表变化后调用一次即可 */
    private fun rebuildChannelIndex() {
        val map = HashMap<Int, Pair<Int, Int>>()
        groups.forEachIndexed { gi, g ->
            g.channels.forEachIndexed { ci, ch ->
                if (!map.containsKey(ch.id)) map[ch.id] = gi to ci
            }
        }
        channelIndex = map
    }

    private fun setupRecyclerViews() {
        groupAdapter = GroupAdapter { group ->
            val idx = groups.indexOfFirst { it.id == group.id }
            if (idx >= 0) {
                currentGroupIndex = idx
                // 切组后组内序号必须同步：否则 UP/DOWN 会用上一组的序号去索引新分组，
                // 跳到毫无关系的频道
                currentChannelIndexInGroup = currentChannel
                    ?.let { ch -> groups[idx].channels.indexOfFirst { it.id == ch.id } }
                    ?.takeIf { it >= 0 } ?: 0
                channelAdapter.submitList(groups[idx].channels)
                if (groups[idx].channels.isNotEmpty()) {
                    binding.rvChannels.scrollToPosition(0)
                }
            }
        }
        binding.rvGroups.layoutManager = LinearLayoutManager(this)
        binding.rvGroups.adapter = groupAdapter

        channelAdapter = ChannelAdapter(
            // OK/点击才换台：浏览频道列表时背景始终保持原频道，不预览不拉流
            onClick = { channel ->
                if (channel.id != channelAdapter.currentChannelId) {
                    playChannel(channel)
                } else {
                    confirmChannelSelection()
                }
            },
            // 长按频道项：先切到该频道上下文再弹线路列表（触屏等效遥控器长按 OK）
            onLongClick = { channel ->
                currentChannel = channel
                showSourceDialog()
            },
            // 焦点只负责高亮：上下浏览不换台不连接，仅重置面板自动关闭计时
            onFocus = {
                scheduleChannelPanelHide()
            }
        )
        binding.rvChannels.layoutManager = LinearLayoutManager(this)
        binding.rvChannels.adapter = channelAdapter

        epgAdapter = EpgAdapter { program ->
            // 点击有录像的已播节目 → 拉该节目所显示日期的回看片段并定位到对应时段
            currentChannel?.let { ch ->
                loadCatchupSegments(ch, epgDateStr(), program)
            }
        }
        binding.rvEpg.layoutManager = LinearLayoutManager(this)
        binding.rvEpg.adapter = epgAdapter
    }

    /**
     * @param useIjk true 时使用内置 av3a 解码器的 ijk 兼容引擎（AV3A 频道自动回退）
     */
    private fun setupEngine(useIjk: Boolean = false) {
        releaseEngine()
        // 同步快照，避免 applyEngineConfig 误判
        lastEngineSnapshot = EngineSnapshot(
            Prefs.getEngine(this),
            Prefs.getVideoDecodeMode(this),
            Prefs.getAudioDecodeMode(this),
            // 必须用 getBufferMs 而不是 getBufferLevel：LoadControl 是按毫秒建的，
            // 而服务端下发的默认值改的也是毫秒（用户没选过档位时 getBufferMs 才返回它）。
            // 用档位做判据的话，服务端把缓冲从 5000 改成 8000 时档位不变 → 快照不变 →
            // 引擎不重建 → 新缓冲永远不生效。
            Prefs.getBufferMs(this),
            Prefs.getAudioPassthrough(this),
            Prefs.getLiveOffsetMs(this)
        )
        engine = if (useIjk) IjkEngine(this) else PlayerEngineFactory.create(this)
        // 将引擎提供的渲染视图注入容器
        binding.playerContainer.removeAllViews()
        binding.playerContainer.addView(engine?.view)
        // 解码器错误突发（持续花屏）→ 自动分级恢复
        (engine as? ExoEngine)?.onVideoCodecErrorBurst = { handleVideoCodecErrorBurst() }
        // 播放中途卡死（缓冲不恢复/连接假死）→ 自动重新拉流
        (engine as? ExoEngine)?.onPlaybackStalled = { handlePlaybackStalled() }
        // 音轨本机无法解码（AV3A/AVS3）→ 自动切换内置 av3a 解码器的 ijk 兼容引擎；
        // 兼容引擎也失败（已尝试过）才仅提示
        (engine as? ExoEngine)?.onUnsupportedAudio = { msg ->
            // 记住该线路需要 AV3A 兼容引擎：下次播放同线路直接起 ijk，省一轮重建
            markCurrentSourceAsAv3a()
            if (!ijkFallbackTried) {
                ijkFallbackTried = true
                android.util.Log.i("AV3ADBG", "switch to ijk engine")
                showStatus("AV3A 音轨，正在切换兼容解码引擎…")
                setupEngine(useIjk = true)
                if (currentUrl.isNotEmpty()) playCurrentSource()
            } else {
                showStatusTemp(msg)
            }
        }
        engine?.listener = object : PlayerEngine.Listener {
            override fun onReady() {
                reconnectCount = 0
                renderedSincePlay = true
                if (isTimeshiftMode) Log.i(TAG_TS, "时移已出画面（等待了 $timeshiftWarmup 次重试）")
                timeshiftWarmup = -1
                if (pendingTimeshiftBackMs > 0L) {
                    val back = pendingTimeshiftBackMs
                    pendingTimeshiftBackMs = 0L
                    val dur = engine?.duration() ?: 0L
                    if (dur > 0L) {
                        val target = (dur - back).coerceAtLeast(0L)
                        Log.i(TAG_TS, "时移定位：回退 ${back / 1000}s → ${target}ms / ${dur}ms")
                        engine?.seekTo(target)
                        // 窗口比要回退的还短（滚动 HLS 刚建立、只有几秒）→ 只能退到窗口开头。
                        // 这时进度条几乎没有可拖的范围，必须说清楚是"窗口刚起步"，
                        // 否则用户会以为拖动坏了 —— 线上反馈就是「遥控器拉不动进度条」。
                        if (dur < back) {
                            showStatusTemp(getString(R.string.timeshift_window_short, dur / 1000))
                        }
                    }
                    showOsd()
                }
                // 回看：定位到用户点的那个节目的起点（服务端现在下发的是按关键帧切片的
                // VOD 播放列表，一次 seek 只取一小块，所以这一步很快、不会卡）
                if (pendingCatchupSeekMs > 0L) {
                    val off = pendingCatchupSeekMs
                    pendingCatchupSeekMs = 0L
                    val dur = engine?.duration() ?: 0L
                    if (dur > off) {
                        Log.i(TAG_TS, "回看定位：从分片内 ${off / 1000}s 开始（分片时长 ${dur / 1000}s）")
                        engine?.seekTo(off)
                        updateCatchupProgress(off, dur)
                    }
                }
                recoveryLevel = 0 // 画面恢复正常，重置花屏自动恢复级别
                stallRetryCount = 0 // 播放恢复正常，重置卡死重拉计数
                cancelSwitchWatchdog()
                hideStatus()
                fadeInPlayer()
                dismissSplash() // 画面就绪：启动画面平滑淡出
                // 记录本次成功播放的地址：下次冷启动预热该地址的连接
                if (currentUrl.isNotEmpty()) Prefs.setLastPlayUrl(this@MainActivity, currentUrl)
                // 首帧之后再拉"全频道正在播出"，避免与起播阶段的拉流抢带宽
                if (!nowPlayingLoaded) {
                    nowPlayingLoaded = true
                    loadNowPlaying()
                }
                // 播放成功：记下当前可用的源索引，下次优先用这条线路
                currentChannel?.let { ch ->
                    if (currentSourceIndex < ch.urls.size) {
                        val sourceId = ch.urls[currentSourceIndex].id
                        Prefs.setPreferredSource(this@MainActivity, ch.id, sourceId)
                    }
                }
            }

            override fun onError(errorCode: Int, errorMessage: String) {
                val ch = currentChannel
                // 时移起播：服务端建滚动窗口期间会返回 503。
                // 原先这条错误会走进下面的"切换线路"分支，于是一开时移就跳台，
                // 用户看到的就是"时移很难用"。这里先原地重试同一条线路。
                if (isTimeshiftMode && !isCatchupMode && timeshiftWarmup in 0 until TIMESHIFT_WARMUP_MAX) {
                    timeshiftWarmup++
                    Log.i(TAG_TS, "时移窗口建立中，第 $timeshiftWarmup 次重试（$errorMessage）")
                    showStatus(getString(R.string.timeshift_warming))
                    mainHandler.postDelayed({
                        if (playbackActive && isTimeshiftMode) restartCurrentPlayback()
                    }, TIMESHIFT_WARMUP_RETRY_MS)
                    return
                }
                if (isTimeshiftMode && !isCatchupMode && timeshiftWarmup >= TIMESHIFT_WARMUP_MAX) {
                    // 等满还建不起窗口 → 这条源时移确实不可用。
                    // 退回直连直播（画面不断），而不是当成线路故障去跳台 ——
                    // 后者正是"时移一开就有些频道乱跳"的来源。
                    val srcId = ch?.urls?.getOrNull(currentSourceIndex)?.id
                    if (srcId != null) timeshiftUnavailable.add(srcId)
                    Log.i(TAG_TS, "时移建立失败，退回直连（line=$srcId）")
                    isTimeshiftMode = false
                    stopProgressPolling()
                    applySeekBarVisibility()
                    updateModeTag()
                    showStatusTemp(getString(R.string.timeshift_fallback))
                    playCurrentSource(animate = false)
                    return
                }
                // 先自动尝试下一条线路，全部失败才走重连退避
                if (!isCatchupMode && ch != null && currentSourceIndex < ch.urls.size - 1) {
                    val failedIndex = currentSourceIndex // 自增前先记下失败的那条，否则提示里的线路号是错的
                    currentSourceIndex++
                    currentUrl = ch.urls[currentSourceIndex].url
                    updateOsdSource()
                    showStatus("线路 ${failedIndex + 1} 播放失败，自动切换线路 ${currentSourceIndex + 1}")
                    reconnectCount = 0
                    playCurrentSource()
                    return
                }
                showStatus("播放出错：${errorMessage.take(60)}")
                scheduleReconnect()
            }

            override fun onPlaybackStateChanged(isPlaying: Boolean) {
                if (isPlaying) hideStatus()
            }

            override fun onVideoSizeChanged(width: Int, height: Int) {
                runOnUiThread {
                    if (width > 0 && height > 0) {
                        renderedSincePlay = true
                        cancelSwitchWatchdog()
                    }
                    binding.tvResolution.text = "${width}x${height}"
                    val ch = currentChannel ?: return@runOnUiThread
                    if (currentSourceIndex < ch.urls.size) {
                        sourceHeights[ch.urls[currentSourceIndex].id] = height
                        // 上报实际分辨率到服务端，加速画质数据收集。
                        // 去重：onVideoSizeChanged 在格式变化/重新 prepare/重复换台时都会触发，
                        // 原实现每次都会发一个 POST。
                        if (width > 0 && height > 0) {
                            val urlId = ch.urls[currentSourceIndex].id
                            if (urlId != lastReportedUrlId || width != lastReportedW || height != lastReportedH) {
                                lastReportedUrlId = urlId
                                lastReportedW = width
                                lastReportedH = height
                                lifecycleScope.launch(Dispatchers.IO) {
                                    repository.reportResolution(urlId, width, height)
                                }
                            }
                        }
                    }
                }
            }

            override fun onPositionChanged(positionMs: Long, durationMs: Long) {
                // 时移也要：拖动后立刻反映位置，不用等下一次 500ms 轮询
                if (isCatchupMode || isTimeshiftMode) updateCatchupProgress(positionMs, durationMs)
            }
        }
        engine?.setScaleMode(Prefs.getScaleMode(this))
    }

    private fun setupSeekBar() {
        binding.seekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {}
            override fun onStartTrackingTouch(seekBar: SeekBar?) {
                isUserSeeking = true
            }

            override fun onStopTrackingTouch(seekBar: SeekBar?) {
                // 还没进时移：这次往回拖就是"进入时移"的入口。
                // 进度条的 0~100 映射到服务端的时移窗口，100 = 直播边缘。
                if (!isTimeshiftMode && !isCatchupMode && seekBar != null && seekBar.progress < 99 &&
                    canEnterTimeshift()
                ) {
                    val winMs = Prefs.serverTimeshiftWindowMin(this@MainActivity).toLong() * 60_000L
                    val backMs = (winMs * (100 - seekBar.progress) / 100).coerceAtLeast(5_000L)
                    isUserSeeking = false
                    enterTimeshift(backMs)
                    return
                }
                val dur = engine?.duration() ?: 0
                if (dur > 0 && seekBar != null) {
                    // 拖到最右端时直接对到窗口末尾（＝直播边缘），避免因
                    // 四舍五入差一两个百分点而"永远差几秒回不到直播"
                    val target = if (seekBar.progress >= 99) dur else dur * seekBar.progress / 100
                    Log.i(TAG_TS, "拖动结束：${seekBar.progress}% → ${target}ms（总长 ${dur}ms）")
                    engine?.seekTo(target)
                    (engine as? ExoEngine)?.noteUserSeek()
                }
                isUserSeeking = false
                showOsd()
            }
        })
    }

    private fun setupListeners() {
        // 长按 OK → 多线路切换（在 dispatchKeyEvent 处理）

        // 绑定遮罩上的"打开设置"按钮：平板/手机无菜单键时触屏点击进入，遥控器可聚焦按 OK
        binding.btnOpenSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        // 触屏手势：
        // - 点按画面：呼出/隐藏 OSD
        // - 左滑（屏幕右缘向左）：打开节目单
        // - 右滑（屏幕左缘向右）：打开频道面板
        // - 长按画面右侧 1/3 区域：打开设置
        // - 长按画面其他区域：打开线路切换
        setupTouchGestures()

        // EPG 日期按钮：触屏点击等效遥控器左右键
        binding.btnEpgPrev.setOnClickListener { shiftEpgDate(-1) }
        binding.btnEpgNext.setOnClickListener { shiftEpgDate(1) }
    }

    /** 手势识别：点按 / 左右滑动 / 分区长按 */
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun setupTouchGestures() {
        var downX = 0f
        var downY = 0f
        var longPressHandled = false
        val longPressRunnable = Runnable {
            // 长按右侧 1/3 区域 → 设置；其余 → 线路切换
            if (downX > binding.playerContainer.width * 2f / 3f) {
                startActivity(Intent(this, SettingsActivity::class.java))
            } else if (!isCatchupMode && currentChannel != null) {
                showSourceDialog()
            }
            longPressHandled = true
        }
        binding.playerContainer.setOnTouchListener { _, event ->
            when (event.action) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    downX = event.x; downY = event.y
                    longPressHandled = false
                    mainHandler.postDelayed(longPressRunnable, 600)
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    // 移动超过阈值就取消长按（防误触）
                    if (Math.abs(event.x - downX) > 40 || Math.abs(event.y - downY) > 40) {
                        mainHandler.removeCallbacks(longPressRunnable)
                    }
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    mainHandler.removeCallbacks(longPressRunnable)
                    if (event.action == android.view.MotionEvent.ACTION_UP && !longPressHandled) {
                        val dx = event.x - downX
                        val dy = event.y - downY
                        val w = binding.playerContainer.width
                        val density = resources.displayMetrics.density
                        val swipeThreshold = 80 * density
                        val edgeSize = 60 * density
                        when {
                            // 从右缘向左滑 → 节目单
                            dx < -swipeThreshold && downX > w - edgeSize * 2 && Math.abs(dy) < swipeThreshold -> toggleEpgPanel()
                            // 从左缘向右滑 → 频道面板
                            dx > swipeThreshold && downX < edgeSize * 2 && Math.abs(dy) < swipeThreshold -> showChannelPanel()
                            // 点按 → OSD
                            Math.abs(dx) < 24 * density && Math.abs(dy) < 24 * density -> {
                                when (currentPanel) {
                                    Panel.NONE -> showOsd()
                                    Panel.OSD -> hideOsd()
                                    else -> hideAllPanels()
                                }
                            }
                        }
                    }
                }
            }
            true
        }
    }

    // ============================ 注册 / 心跳流程 ============================

    private var lastServerUrl = ""

    private fun startRegistrationFlow() {
        lastServerUrl = Prefs.getServerUrl(this)
        val token = Prefs.getToken(this)
        if (token.isNotEmpty()) {
            // 已有 token：直接进心跳
            binding.bindingMask.visibility = View.GONE
            startHeartbeat()
            loadChannels()
        } else {
            showBindingMask()
            // 需要绑定：让用户看到绑定界面，启动画面淡出
            dismissSplash()
            startRegisterPolling()
        }
    }

    private fun showBindingMask() {
        binding.bindingMask.visibility = View.VISIBLE
        binding.tvDeviceId.text = getString(R.string.device_id_label, Prefs.getDeviceId(this))
        binding.tvServerAddr.text = getString(R.string.server_addr_label, lastServerUrl)
        binding.tvBindStatus.text = getString(R.string.bind_status_connecting)
    }

    private fun startRegisterPolling() {
        registerJob?.cancel()
        registerJob = lifecycleScope.launch {
            while (true) {
                try {
                    when (val result = repository.register()) {
                        is com.mediaiptv.tv.net.Result.Ok -> {
                            val data = result.data
                            if (data.isApproved && !data.token.isNullOrEmpty()) {
                                Prefs.setToken(this@MainActivity, data.token)
                                withContext(Dispatchers.Main) {
                                    binding.bindingMask.visibility = View.GONE
                                    startHeartbeat()
                                    loadChannels()
                                }
                                break
                            } else {
                                withContext(Dispatchers.Main) {
                                    binding.tvBindStatus.text = getString(R.string.bind_status_waiting)
                                }
                            }
                        }
                        is com.mediaiptv.tv.net.Result.Error -> {
                            withContext(Dispatchers.Main) {
                                binding.tvBindStatus.text = if (result.code == 1001) {
                                    getString(R.string.bind_status_waiting)
                                } else {
                                    getString(R.string.bind_status_error)
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) {
                        binding.tvBindStatus.text = getString(R.string.bind_status_error)
                    }
                }
                delay(5000)
            }
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = lifecycleScope.launch {
            while (true) {
                try {
                    val result = repository.heartbeat()
                    if (result is com.mediaiptv.tv.net.Result.Ok) {
                        // 服务端下发的播放配置：存下来当作「用户没自己设过时」的默认值
                        // （取值顺序见 Prefs.getEngine：本地 > 服务端 > 内置）。
                        //
                        // 原先这里收到 config 却完全没用 —— lambda 里连 it 都没读，
                        // 只借它触发一次 applyEngineConfig()，而那个函数读的全是本地 Prefs。
                        // 于是后台那整块「客户端播放配置」是一组完全无效的开关。
                        result.data.features?.let { f ->
                            if (Prefs.setServerFeatures(this@MainActivity, f.timeshift, f.timeshiftWindowMin, f.record)) {
                                withContext(Dispatchers.Main) {
                                    updateModeTag()
                                    applySeekBarVisibility()
                                }
                            }
                        }
                        val cfg = result.data.config
                        val changed = cfg != null && Prefs.setServerPlayerConfig(
                            this@MainActivity,
                            cfg.engine,
                            cfg.bufferMs,
                            cfg.scaleMode,
                            cfg.liveOffsetMs
                        )
                        if (changed) {
                            withContext(Dispatchers.Main) {
                                applyEngineConfig()
                                // 画面比例不在引擎快照里（它是动态可改的，不需要重建引擎），
                                // 所以这里单独应用一次 —— 否则服务端改了比例要等下次 onResume 才生效。
                                engine?.setScaleMode(Prefs.getScaleMode(this@MainActivity))
                            }
                        }
                    } else if (result.code == 401) {
                        // token 失效，清除并重新注册
                        Prefs.clearToken(this@MainActivity)
                        withContext(Dispatchers.Main) { startRegistrationFlow() }
                        break
                    }
                } catch (e: Exception) {
                    // 网络异常忽略，等下次心跳
                }
                delay(60_000) // 每分钟一次心跳
            }
        }
    }

    /** 引擎创建时的完整配置快照：引擎+视频解码+音频解码+缓冲+音频直通。任一变化都重建引擎 */
    private data class EngineSnapshot(
        val engine: String,
        val videoDecode: String,
        val audioDecode: String,
        val buffer: Int,
        val passthrough: Boolean,
        /** 直播偏移也要进快照：它在引擎构造时固化进 LiveConfiguration，改了必须重建 */
        val liveOffset: Int
    )
    private var lastEngineSnapshot: EngineSnapshot? = null

    /** 引擎切换后重建 PlayerEngine 并重连当前频道 */
    private fun applyEngineConfig() {
        val snap = EngineSnapshot(
            Prefs.getEngine(this),
            Prefs.getVideoDecodeMode(this),
            Prefs.getAudioDecodeMode(this),
            // 必须用 getBufferMs 而不是 getBufferLevel：LoadControl 是按毫秒建的，
            // 而服务端下发的默认值改的也是毫秒（用户没选过档位时 getBufferMs 才返回它）。
            // 用档位做判据的话，服务端把缓冲从 5000 改成 8000 时档位不变 → 快照不变 →
            // 引擎不重建 → 新缓冲永远不生效。
            Prefs.getBufferMs(this),
            Prefs.getAudioPassthrough(this),
            Prefs.getLiveOffsetMs(this)
        )
        // 任一配置变化都重建：解码器选择器/LoadControl 在构造时固化，动态改不了
        if (lastEngineSnapshot != snap) {
            lastEngineSnapshot = snap
            setupEngine()
            if (currentUrl.isNotEmpty()) playCurrentSource()
        }
    }

    // ============================ 频道 / EPG 加载 ============================

    /**
     * 加载频道列表（失败会自己重试，直到成功）。
     *
     * 为什么必须重试：电视盒子关机再开时，**网络（DHCP / 以太网 / Wi-Fi）通常比应用启动
     * 慢十几秒**，服务端也可能刚上电还没起来。原实现只请求一次，失败就把
     * 「加载频道失败」直接打在屏幕上而且永不重试 —— 这正是「关机后第一次打开提示
     * 频道加载失败」的根因（心跳那条链路本来就有 60 秒重试，频道加载却没有）。
     *
     * 现在的策略：前几次快速重试覆盖开机那段窗口，之后转成 30 秒一次的慢重试一直等，
     * 网络或服务端一恢复就自动进入播放，不需要用户重开应用。
     */
    private fun loadChannels() {
        channelJob?.cancel()
        channelJob = lifecycleScope.launch {
            var attempt = 0
            var lastError = ""
            while (isActive) {
                attempt++
                try {
                    when (val result = repository.channels()) {
                        is com.mediaiptv.tv.net.Result.Ok -> {
                            withContext(Dispatchers.Main) { applyChannelList(result.data.groups) }
                            return@launch
                        }
                        is com.mediaiptv.tv.net.Result.Error -> {
                            if (result.code == 401) {
                                // token 失效：清掉并回到绑定流程，别在这里空转
                                Prefs.clearToken(this@MainActivity)
                                withContext(Dispatchers.Main) { startRegistrationFlow() }
                                return@launch
                            }
                            lastError = "服务端返回 ${result.code}"
                        }
                    }
                } catch (e: Exception) {
                    lastError = e.message ?: e.javaClass.simpleName
                }

                val fast = attempt <= FAST_RETRY_DELAYS_MS.size
                withContext(Dispatchers.Main) {
                    showStatus(
                        if (fast) getString(R.string.channels_connecting, attempt, FAST_RETRY_DELAYS_MS.size)
                        else getString(R.string.channels_retrying_slow, lastError)
                    )
                }
                delay(if (fast) FAST_RETRY_DELAYS_MS[attempt - 1] else SLOW_RETRY_MS)
            }
        }
    }

    /** 频道列表到手后的界面更新（在主线程调用） */
    private fun applyChannelList(list: List<ChannelGroup>) {
        groups = list
        if (groups.isEmpty()) {
            showStatus(getString(R.string.no_channels))
            return
        }
        hideStatus()
        groupAdapter.submitList(groups)
        groupAdapter.setSelectedPosition(0)
        channelAdapter.submitList(groups[0].channels)
        rebuildChannelIndex()
        // 频道记忆：优先恢复上次观看的频道，找不到才播第一个
        // 两者都跳过没有线路的频道：playChannel 对 urls 为空会直接 return，
        // 否则首屏就是黑屏且没有任何提示
        val lastId = Prefs.getLastChannelId(this)
        val remembered = if (lastId > 0) {
            channelIndex[lastId]
                ?.let { (gi, ci) -> groups.getOrNull(gi)?.channels?.getOrNull(ci) }
                ?.takeIf { it.urls.isNotEmpty() }
        } else null
        val target = remembered
            ?: groups.firstNotNullOfOrNull { g -> g.channels.firstOrNull { it.urls.isNotEmpty() } }
        if (target != null) {
            playChannel(target)
        } else {
            showStatus(getString(R.string.no_channels))
        }
    }

    private fun loadEpgForChannel(channel: Channel) {
        val date = epgDateStr()
        lifecycleScope.launch {
            try {
                val result = repository.epg(channel.id, date)
                if (result is com.mediaiptv.tv.net.Result.Ok) {
                    val programs = result.data.programs
                    withContext(Dispatchers.Main) {
                        val nowSec = sdfTimeSec.format(Date())
                        epgAdapter.submitPrograms(
                            programs, nowSec, epgDateOffset,
                            getString(R.string.epg_section_replay), getString(R.string.epg_section_live),
                            getString(R.string.epg_section_preview),
                            getString(R.string.epg_tag_now), getString(R.string.epg_tag_next),
                            getString(R.string.epg_tag_replay)
                        )
                        // OSD 与频道行高亮只反映"今天正在播"的节目
                        if (epgDateOffset == 0) {
                            currentEpgPrograms = programs
                            updateOsdProgram(programs)
                            channelAdapter.updateCurrentProgram(
                                programs.firstOrNull { programCovers(it, nowSec) }?.title.orEmpty()
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                // 静默失败
            }
        }
        scheduleEpgRefresh()
    }

    /** 全频道"正在播出"：填充频道列表每行的节目标题 */
    private fun loadNowPlaying() {
        lifecycleScope.launch {
            try {
                val result = repository.epgNow()
                if (result is com.mediaiptv.tv.net.Result.Ok) {
                    val map = result.data.now.mapNotNull { (k, v) ->
                        k.toIntOrNull()?.let { it to v.title }
                    }.toMap()
                    withContext(Dispatchers.Main) {
                        channelAdapter.submitNowPlaying(map)
                    }
                }
            } catch (_: Exception) { }
        }
    }

    /** EPG 定时刷新：每 10 分钟重新拉取当前频道节目单 + 全频道正在播出，服务器端更新后客户端自动可见 */
    private fun scheduleEpgRefresh() {
        epgRefreshRunnable?.let { mainHandler.removeCallbacks(it) }
        epgRefreshRunnable = Runnable {
            // 频道列表每行都要显示"正在播出"，这个始终刷新
            loadNowPlaying()
            // 当前频道的完整节目单只在 EPG 面板可见时才需要。
            // 原实现在面板关着、甚至未在播放时也无条件拉一次，并且刷新后只更新了
            // OSD 而没有更新频道列表行的节目名（与 loadEpgForChannel 不一致）。
            // 统一走 loadEpgForChannel 就同时解决这两个问题。
            if (currentPanel == Panel.EPG) {
                currentChannel?.let { loadEpgForChannel(it) }
            }
            scheduleEpgRefresh() // 循环调度
        }
        mainHandler.postDelayed(epgRefreshRunnable!!, 10 * 60 * 1000L)
    }

    /** 拉取回看片段；指定 program 时定位到与节目时段重叠的片段，否则取第一段 */
    private fun loadCatchupSegments(channel: Channel, date: String, program: Program? = null) {
        lifecycleScope.launch {
            try {
                val result = repository.catchupList(channel.id, date)
                if (result is com.mediaiptv.tv.net.Result.Ok) {
                    val segments = result.data.segments
                    if (segments.isNotEmpty()) {
                        val target = if (program != null) {
                            segments.firstOrNull { it.start < program.end && it.end > program.start }
                                ?: segments[0]
                        } else segments[0]
                        withContext(Dispatchers.Main) {
                            playCatchup(target, program, epgDateOffset)
                        }
                    } else {
                        withContext(Dispatchers.Main) {
                            showStatus(getString(R.string.no_catchup))
                            mainHandler.postDelayed({ hideStatus() }, 2000)
                        }
                    }
                }
            } catch (e: Exception) {
                // 静默
            }
        }
    }

    // ============================ 播放控制 ============================

    private fun playChannel(channel: Channel) {
        if (channel.urls.isEmpty()) return
        // 换台：旧频道的时移窗口不再需要，别让它继续占着 ffmpeg
        cancelTimeshiftWarmup()
        // 新频道：重新允许 AV3A 兼容引擎回退。
        // 是否切回默认引擎/直接起 ijk 由 playCurrentSource → ensureEngineForSource 按线路记忆决定
        ijkFallbackTried = false
        timeshiftWarmup = 0
        timeshiftEngaged = false
        pendingTimeshiftBackMs = 0L
        pendingCatchupSeekMs = 0L
        currentChannel = channel
        // 同步当前分组与组内序号，保证 OK 确认后 UP/DOWN 换台从正确位置开始
        channelIndex[channel.id]?.let { (gi, ci) ->
            currentGroupIndex = gi
            currentChannelIndexInGroup = ci
        }
        Prefs.setLastChannelId(this, channel.id) // 频道记忆
        autoSwitchAttempts = 0
        // 服务端已按画质排序（高清在前）：优先用上次成功线路，否则直接用第一条
        val preferredId = Prefs.getPreferredSource(this, channel.id)
        currentSourceIndex = if (preferredId > 0) {
            channel.urls.indexOfFirst { it.id == preferredId }.takeIf { it >= 0 } ?: 0
        } else 0
        // 画质偏好"最高"：直接选已探测分辨率最高的线路（不依赖记忆线路）
        if (Prefs.getQuality(this) == Prefs.QUALITY_HIGH) {
            val bestIdx = channel.urls.indices
                .filter { channel.urls[it].height > 0 }
                .maxByOrNull { channel.urls[it].height }
            if (bestIdx != null) currentSourceIndex = bestIdx
        }
        isCatchupMode = false
        currentCatchupSegment = null
        updateModeTag()
        updateChannelHighlight(channel)

        currentUrl = channel.urls[currentSourceIndex].url
        updateOsdSource()
        playCurrentSource()
        loadEpgForChannel(channel)

        // 确认换台：收起所有面板并弹 OSD
        binding.tvChannelName.text = channel.name
        hideAllPanels()
        showOsd()
    }

    /** 播放当前线路，携带服务端下发的 User-Agent（直连模式防防盗链） */
    /**
     * 重新拉取当前线路并播放。
     * @param animate false 用于「同一条流的重连/重试」：不做换台淡入淡出，
     *   否则重试成功的瞬间画面会弹一下。真正的换台（playChannel）保持默认 true。
     */
    private fun playCurrentSource(animate: Boolean = true) {
        val ch = currentChannel ?: return
        if (currentSourceIndex >= ch.urls.size) return
        val src = ch.urls[currentSourceIndex]
        ensureEngineForSource(ch.id, src.id)
        val headers = if (src.userAgent.isNotEmpty()) mapOf("User-Agent" to src.userAgent) else emptyMap()
        playbackActive = true

        // 时移：开了开关且这条线路支持时移时，播服务端的滚动 HLS，而不是直连/代理流。
        // 直连流在客户端"没有过去"，只有服务端缓冲出窗口才谈得上往回拖。
        // 以服务端能力为准：服务端没开时移就没有入口，客户端不再有自己的开关
        val useTimeshift = timeshiftEngaged && Prefs.serverTimeshiftOn(this) &&
            src.timeshiftUrl.isNotEmpty() && !timeshiftUnavailable.contains(src.id)
        // 这里原来会弹"本线路不支持时移（服务端未提供时移地址）"。
        // 但服务端现在**只对有录像的频道**下发时移地址，也就是说绝大多数频道都没有 ——
        // 于是每换一个台就弹一次，纯属噪音。没有入口＝本来就不该提示，直接去掉。
        isTimeshiftMode = useTimeshift
        applySeekBarVisibility()
        if (useTimeshift) {
            Log.i(TAG_TS, "起播时移流：${src.timeshiftUrl}")
            // HLS 的 duration 就是窗口长度，播放器自己知道能拖到哪，
            // 进度条交给 startProgressPolling 按引擎的位置/时长驱动
            startProgressPolling()
            // 进入时移**不做**淡出：淡出会先把画面抹黑，而时移流本来就要等窗口，
            // 用户看到的就是"点了之后一直黑着"。保持原画面（直播帧）挂到新流首帧到达为止，
            // 观感上是"画面直接跳到回退位置"，而不是"黑屏等一会儿"。
            fadeSwitch(false) {
                Log.i("ExoLoad", "engine.play() 调用前 +${android.os.SystemClock.elapsedRealtime()}")
                engine?.play(src.timeshiftUrl, headers)
                Log.i("ExoLoad", "engine.play() 返回 +${android.os.SystemClock.elapsedRealtime()}")
            }
        } else {
            // 服务端支持时移时，即使还没进时移也要让进度条在（用户靠拖它进入时移）
            if (!isCatchupMode) {
                if (canEnterTimeshift()) startProgressPolling() else stopProgressPolling()
            }
            fadeSwitch(animate) { engine?.play(src.url, headers) }
        }
        updateModeTag()
        scheduleSwitchWatchdog()
        startRateDiag()
        // 直播播放稳定后把时移窗口预热起来（详见 [timeshiftWarmUrl]）；
        // 已经在时移/回看里就不预热了，那两路本来就在用服务端的切片
        scheduleTimeshiftWarmup()
    }

    /**
     * 排一次时移预热（详见 [timeshiftWarmUrl] 的说明）。
     *
     * 已经在这条地址上预热/续期时直接返回 —— 否则播放中途的自动重连
     * （restartCurrentPlayback → playCurrentSource）会把 8 秒计时反复重置，
     * 永远等不到真正预热的那一次。
     */
    private fun scheduleTimeshiftWarmup() {
        val src = currentChannel?.urls?.getOrNull(currentSourceIndex)
        // 不能把这一串判断塞进一个 Boolean 变量再靠它推导 src 非空：Kotlin 的智能转换
        // 不会穿过布尔变量，下面 src.timeshiftUrl 就编译不过了。逐条早返回。
        if (src == null) {
            cancelTimeshiftWarmup()
            return
        }
        val usable = Prefs.serverTimeshiftOn(this) &&
            src.timeshiftUrl.isNotEmpty() &&
            !timeshiftUnavailable.contains(src.id) &&
            !isCatchupMode && !timeshiftEngaged
        if (!usable) {
            cancelTimeshiftWarmup()
            return
        }
        if (timeshiftWarmUrl == src.timeshiftUrl) return
        cancelTimeshiftWarmup()
        timeshiftWarmUrl = src.timeshiftUrl
        mainHandler.postDelayed(timeshiftWarmRunnable, TIMESHIFT_WARM_DELAY_MS)
    }

    /** 取消预热：换台、进回看/时移、退出播放时调用，别给已经不看的那一路白跑 ffmpeg */
    private fun cancelTimeshiftWarmup() {
        mainHandler.removeCallbacks(timeshiftWarmRunnable)
        timeshiftWarmCall?.cancel()
        timeshiftWarmCall = null
        timeshiftWarmUrl = null
    }

    /**
     * 发一次预热请求。服务端只要收到这次请求就会把滚动窗口拉起来；
     * 响应内容一律不要 —— 播放列表由播放器自己去取，这里只负责"让服务端开始干活"。
     */
    private fun runTimeshiftWarmup() {
        val url = timeshiftWarmUrl ?: return
        if (!playbackActive || isCatchupMode || timeshiftEngaged) return
        val req = Request.Builder().url(url).get().build()
        val call = ApiClient.streamClient.newCall(req)
        timeshiftWarmCall = call
        Log.i(TAG_TS, "预热时移窗口：$url")
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // 预热失败只是退回"点的时候再等"，不影响正在播的直播流
                Log.i(TAG_TS, "时移预热失败（不影响播放）：${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { it.body?.close() }
                Log.i(TAG_TS, "时移预热完成 code=${response.code}")
            }
        })
        // 续期：服务端空闲 2 分钟就停会话，用户看几分钟再往回拖时窗口还得在
        mainHandler.postDelayed(timeshiftWarmRunnable, TIMESHIFT_WARM_KEEPALIVE_MS)
    }

    /**
     * 按线路记忆选择引擎：曾判定需要 AV3A 兼容引擎的线路直接起 ijk，
     * 省掉"先建 ExoPlayer → 解析出 av3a → 推翻重建 ijk"这一整轮；
     * 回到普通线路时再切回默认引擎。仅在默认 Exo 内核下生效（用户选系统内核时不干预）。
     *
     * 切回默认引擎多加 [ijkFallbackTried] 判断：AV3A 回退若未成功记住线路
     * （例如 currentChannel 为空），不至于来回重建造成循环。
     */
    private fun ensureEngineForSource(channelId: Int, sourceId: Int) {
        if (Prefs.getEngine(this) != Prefs.ENGINE_EXO) return
        if (Prefs.isAv3aSource(this, channelId, sourceId)) {
            if (engine !is IjkEngine) {
                ijkFallbackTried = true
                setupEngine(useIjk = true)
            }
        } else if (engine is IjkEngine && !ijkFallbackTried) {
            setupEngine()
        }
    }

    /** 记录当前线路被判定需要 AV3A 兼容引擎（key = channelId:sourceId） */
    private fun markCurrentSourceAsAv3a() {
        val ch = currentChannel ?: return
        if (currentSourceIndex < ch.urls.size) {
            Prefs.markAv3aSource(this, ch.id, ch.urls[currentSourceIndex].id)
        }
    }

    // ============================ 持续花屏自动恢复 ============================

    /** 重新播放当前内容（直播走当前线路，回看走回看片段），建立全新连接与全新解码器。
     *  这是**重连/重试**路径（卡顿自动重连、花屏恢复），不是换台，所以不做过渡动画。 */
    private fun restartCurrentPlayback() {
        if (isCatchupMode) {
            fadeSwitch(animate = false) { engine?.play(currentUrl) }
        } else {
            playCurrentSource(animate = false)
        }
    }

    /**
     * 解码器错误突发（参考帧损坏、解码器内部状态异常导致持续花屏）时分级恢复：
     * 1) 重新解码当前流（全新解码器，等同快速重进频道）
     * 2) 仍异常则切换 硬解↔软解 重建引擎（与用户手动切换等效）
     * 3) 再异常则自动换线路；无更多手段时提示
     */
    private fun handleVideoCodecErrorBurst() {
        // 起播阶段还没出过画面的情况交给超时换源 watchdog，不在此处理
        if (!renderedSincePlay) return
        when (recoveryLevel) {
            0 -> {
                recoveryLevel = 1
                showStatus("画面异常，正在重新解码…")
                restartCurrentPlayback()
            }
            1 -> {
                // 花屏是视频解码问题：轮换视频解码模式（不动音频设置）
                val next = when (Prefs.getVideoDecodeMode(this)) {
                    Prefs.DECODE_SW -> Prefs.DECODE_HW
                    Prefs.DECODE_HW -> Prefs.DECODE_SW
                    else -> Prefs.DECODE_SW // auto：先尝试软解
                }
                recoveryLevel = 2
                showStatus("重新解码未恢复，视频切换为${if (next == Prefs.DECODE_SW) "软解" else "硬解"}…")
                Prefs.setVideoDecodeMode(this, next)
                setupEngine() // 解码器选择器在构造时固化，需重建引擎
                restartCurrentPlayback()
            }
            2 -> {
                val ch = currentChannel
                if (!isCatchupMode && ch != null && ch.urls.size > 1) {
                    currentSourceIndex = (currentSourceIndex + 1) % ch.urls.size
                    currentUrl = ch.urls[currentSourceIndex].url
                    updateOsdSource()
                    recoveryLevel = 3
                    showStatus("切换解码方式未恢复，换用线路 ${currentSourceIndex + 1}…")
                    restartCurrentPlayback()
                } else {
                    recoveryLevel = 3
                    showStatus("当前频道信号异常，请稍后再试或换台观看")
                }
            }
            else -> { /* 已逐级尝试完毕，等待下次正常播放后重置 */ }
        }
    }

    // ============================ 播放中途卡死自动拉流 ============================

    /**
     * 播放中途卡住（持续缓冲不恢复、拉流连接假死、画面位置冻结，且没有致命错误回调）时：
     * 1) 先快速重新拉流（全新连接），最多 2 次；
     * 2) 仍卡住且该频道有多条线路，则换线路；
     * 3) 再无手段则走指数退避重连（scheduleReconnect），避免高频重拉。
     */
    private fun handlePlaybackStalled() {
        // 起播阶段还没出过画面的情况交给超时换源 watchdog，不在此处理
        if (!renderedSincePlay) return
        if (stallRetryCount < STALL_MAX_FAST_RETRIES) {
            stallRetryCount++
            showStatus(
                if (stallRetryCount == 1) "播放卡住，正在重新拉流…"
                else "仍然卡住，再次拉流…"
            )
            restartCurrentPlayback()
            return
        }
        val ch = currentChannel
        if (!isCatchupMode && ch != null && ch.urls.size > 1) {
            currentSourceIndex = (currentSourceIndex + 1) % ch.urls.size
            currentUrl = ch.urls[currentSourceIndex].url
            updateOsdSource()
            showStatus("多次拉流未恢复，换用线路 ${currentSourceIndex + 1}…")
            stallRetryCount = 0
            restartCurrentPlayback()
        } else {
            showStatus("网络信号不佳，稍后自动重试…")
            scheduleReconnect() // 指数退避重连，达到上限后提示
        }
    }

    // ============================ 换台淡入淡出 ============================

    /**
     * 换台过渡：旧画面先平滑淡出（约 180ms）并轻微放大，动画结束再切流——
     * 不再瞬间切到黑屏。快速连按频道时取消旧动画并立即结算其切流动作，避免动作丢失。
     * 若当前已是隐藏状态（如起播），则直接切流，不增加延迟。
     *
     * @param animate false = 同一条流的重连/重试。这种情况下没有"旧画面"需要过渡，
     *   做淡出+放大只会让重试成功的瞬间"弹一下"（见 [awaitingFadeIn]）。
     */
    private fun fadeSwitch(animate: Boolean = true, action: () -> Unit) {
        val v = binding.playerContainer
        v.animate().cancel() // 取消会触发挂起的 endAction，由 switched 标志保证只切一次

        if (!animate) {
            // 重连场景：保持画面不透明、不缩放，直接切流
            awaitingFadeIn = false
            v.alpha = 1f
            v.scaleX = 1f
            v.scaleY = 1f
            action()
            return
        }

        // 冷启动首播：启动画面正覆盖在播放器之上，没有"旧画面"需要淡出，直接立即拉流，
        // 省去 SWITCH_FADE_OUT_MS 等待，缩短"启动→起播"耗时
        if (!hasPlayedOnce) {
            hasPlayedOnce = true
            awaitingFadeIn = true
            v.alpha = 0f
            v.scaleX = SWITCH_SCALE_MAX
            v.scaleY = SWITCH_SCALE_MAX
            action()
            return
        }
        if (v.alpha <= 0.02f) {
            awaitingFadeIn = true
            v.alpha = 0f
            v.scaleX = SWITCH_SCALE_MAX
            v.scaleY = SWITCH_SCALE_MAX
            action()
            return
        }
        awaitingFadeIn = true
        var switched = false
        v.animate()
            .alpha(0f)
            .scaleX(SWITCH_SCALE_MAX)
            .scaleY(SWITCH_SCALE_MAX)
            .setDuration(SWITCH_FADE_OUT_MS)
            .setInterpolator(android.view.animation.AccelerateInterpolator())
            .withEndAction {
                if (!switched) {
                    switched = true
                    action()
                }
            }
            .start()
    }

    /**
     * 新画面就绪后淡入（约 320ms）：从轻微放大状态平滑缩回并加速减速，
     * 与淡出过程对称，形成完整的换台过渡。
     *
     * **只有真的淡出过才做这个动画。** 原实现无条件把 scale 先设成 1.05 再缩回，
     * 于是每次「源卡顿 → 自动重连 → 成功」之后首帧一到，画面就会突然放大再缩回去，
     * 看上去像"弹一下"。重连路径不淡出（见 [fadeSwitch] 的 animate 参数），
     * 这里也就直接把画面摆正。
     */
    private fun fadeInPlayer() {
        val v = binding.playerContainer
        v.animate().cancel()
        if (!awaitingFadeIn) {
            v.alpha = 1f
            v.scaleX = 1f
            v.scaleY = 1f
            return
        }
        awaitingFadeIn = false
        v.scaleX = SWITCH_SCALE_MAX
        v.scaleY = SWITCH_SCALE_MAX
        v.animate()
            .alpha(1f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(SWITCH_FADE_IN_MS)
            .setInterpolator(android.view.animation.DecelerateInterpolator(1.2f))
            .start()
    }

    // ============================ 超时无画面自动换源 ============================

    private fun cancelSwitchWatchdog() {
        switchWatchdog?.let { mainHandler.removeCallbacks(it) }
        switchWatchdog = null
    }

    /** 开启 watchdog：N 秒内未出画面则自动切下一条线路（可在设置关闭/调时长） */
    private fun scheduleSwitchWatchdog() {
        cancelSwitchWatchdog()
        val ch = currentChannel ?: return
        // 回看模式/单线路/开关关闭时不启用
        if (isCatchupMode || ch.urls.size <= 1 || !Prefs.getAutoSwitchSource(this)) return
        renderedSincePlay = false
        val timeoutSec = Prefs.getSwitchTimeoutSec(this)
        val fromIndex = currentSourceIndex
        switchWatchdog = Runnable {
            if (renderedSincePlay || isCatchupMode) return@Runnable
            // 时移窗口正在建立时不算"没画面"：这时换下一条线路是误判，
            // 而时移本身最多原地等 TIMESHIFT_WARMUP_MAX 次，等满会走正常错误处理。
            if (isTimeshiftMode && timeshiftWarmup in 0 until TIMESHIFT_WARMUP_MAX) {
                switchWatchdog?.let { mainHandler.postDelayed(it, timeoutSec * 1000L) }
                return@Runnable
            }
            val cur = currentChannel ?: return@Runnable
            if (autoSwitchAttempts >= cur.urls.size - 1) {
                showStatus(getString(R.string.all_sources_failed))
                return@Runnable
            }
            autoSwitchAttempts++
            currentSourceIndex = (currentSourceIndex + 1) % cur.urls.size
            currentUrl = cur.urls[currentSourceIndex].url
            updateOsdSource()
            showStatus(getString(R.string.switching_no_picture, fromIndex + 1, timeoutSec, currentSourceIndex + 1))
            playCurrentSource()
        }
        mainHandler.postDelayed(switchWatchdog!!, timeoutSec * 1000L)
    }

    /**
     * 播放回看片段。
     * @param program 用户点的那条节目；给了就从**节目起点**开始播，而不是从录像分片起点
     *   （分片是 5 分钟一片，不从节目起点播最多会早放 5 分钟，用户还得自己往前拖）
     * @param dayOffset 这条录像属于哪一天（0=今天，-1=昨天…），进度条那行算"落后直播多久"要用
     */
    private fun playCatchup(segment: CatchupSegment, program: Program? = null, dayOffset: Int = 0) {
        isCatchupMode = true
        // 回看占用了播放器，时移预热先停（用户看完回看回到直播时会重新排）
        cancelTimeshiftWarmup()
        currentCatchupSegment = segment
        currentCatchupDayOffset = dayOffset
        updateModeTag()
        binding.seekBar.visibility = View.VISIBLE
        binding.tvModeTag.text = getString(R.string.catchup_tag)
        currentUrl = segment.url
        pendingCatchupSeekMs = if (program != null) {
            val p = secOfDay(program.start)
            val s0 = secOfDay(segment.start)
            if (p >= 0 && s0 >= 0) ((p - s0) * 1000L).coerceIn(0L, 3600_000L) else 0L
        } else {
            0L
        }
        // 回看**不做**淡出：淡出那 180ms 只是先把画面抹黑，而回看的播放列表本身就要等
        // （首次请求要扫关键帧索引）。保持原画面挂到回看首帧到达，观感上是"直接切过去"。
        fadeSwitch(false) {
            Log.i("ExoLoad", "回看 engine.play() 调用前 +${android.os.SystemClock.elapsedRealtime()}")
            engine?.play(segment.url)
            Log.i("ExoLoad", "回看 engine.play() 返回 +${android.os.SystemClock.elapsedRealtime()}")
        }
        hideAllPanels() // 从节目单点回看时收起面板，避免状态错乱
        binding.tvChannelName.text = "${currentChannel?.name.orEmpty()} · ${segment.start}"
        showOsd()
        startProgressPolling()
    }

    /** "HH:mm:ss" → 当天秒数；解析不了返回 -1 */
    private fun secOfDay(hms: String): Long {
        val p = hms.split(':')
        if (p.size != 3) return -1L
        val h = p[0].toLongOrNull() ?: return -1L
        val m = p[1].toLongOrNull() ?: return -1L
        val s = p[2].toLongOrNull() ?: return -1L
        return h * 3600 + m * 60 + s
    }

    /** 回看模式下进度轮询（Job 需要保存：原先每次点节目都新起一个 while(isCatchupMode)
     *  循环且从不取消，在回看模式下再点一个节目时 isCatchupMode 仍为 true，
     *  旧循环不会退出，于是 N 次点击就有 N 个 500ms 循环同时写同一个 SeekBar） */
    private fun startProgressPolling() {
        progressJob?.cancel()
        progressJob = lifecycleScope.launch {
            while (isCatchupMode || isTimeshiftMode || canEnterTimeshift()) {
                if (isCatchupMode || isTimeshiftMode) {
                    val dur = engine?.duration() ?: 0
                    val pos = engine?.currentPosition() ?: 0
                    if (dur > 0) {
                        updateCatchupProgress(pos, dur)
                    } else if (isTimeshiftMode) {
                        // 窗口还没建立（时移播放列表还没回来）：指针停在直播端，
                        // 但要在那一行说清楚在等什么 —— 否则"按了没反应"看起来就是坏了
                        if (binding.seekBar.progress != 100) binding.seekBar.progress = 100
                        binding.tvSeekTime.visibility = View.VISIBLE
                        binding.tvSeekTime.text = getString(R.string.timeshift_warming)
                    }
                } else {
                    // 还没进时移：指针停在最右端（＝直播边缘），往回拖才会进时移
                    if (binding.seekBar.progress != 100) binding.seekBar.progress = 100
                    binding.tvSeekTime.visibility = View.VISIBLE
                    binding.tvSeekTime.text = getString(R.string.live_tag)
                }
                delay(500)
            }
        }
    }

    private fun stopProgressPolling() {
        progressJob?.cancel()
        progressJob = null
    }

    private fun backToLive() {
        Log.i(TAG_TS, "回到直播（原模式 回看=${isCatchupMode} 时移=${isTimeshiftMode} 落后=${isBehindLive()}）")
        isCatchupMode = false
        isTimeshiftMode = false
        timeshiftEngaged = false
        pendingTimeshiftBackMs = 0L
        currentCatchupSegment = null
        stopProgressPolling()
        applySeekBarVisibility()
        updateModeTag()
        // 重新拉流：时移开着的话 playCurrentSource 会重新走滚动 HLS（回到窗口末尾＝直播）
        currentChannel?.let { playChannel(it) }
    }

    private fun updateModeTag() {
        // 时移下要能看到"现在落后多少"以及"怎么回直播"，
        // 否则标签只写"时移"，用户不知道该按什么键。
        val behindSec = if (isBehindLive()) {
            val dur = engine?.duration() ?: 0L
            val pos = engine?.currentPosition() ?: 0L
            (dur - pos) / 1000
        } else {
            0L
        }
        // 标签只写状态词。落后多少秒放到进度条那一行（见 tvSeekTime），
        // 标签里再写一遍"落后 12:34"既挤又和进度条重复。
        binding.tvModeTag.text = when {
            isCatchupMode -> getString(R.string.catchup_tag)
            isTimeshiftMode -> getString(R.string.timeshift_tag)
            else -> getString(R.string.live_tag)
        }
        binding.tvModeTag.visibility = if (isCatchupMode || isTimeshiftMode) View.VISIBLE else View.GONE
    }

    private fun updateChannelHighlight(channel: Channel) {
        channelAdapter.currentChannelId = channel.id
        // 在分组中找到位置（走索引，避免每次换台全列表扫描）
        val pos = channelIndex[channel.id] ?: return
        currentGroupIndex = pos.first
        currentChannelIndexInGroup = pos.second
        groupAdapter.setSelectedPosition(pos.first)
        channelAdapter.submitList(groups[pos.first].channels)
    }

    // ============================ OSD ============================

    private fun showOsd() {
        currentPanel = Panel.OSD
        binding.osdPanel.visibility = View.VISIBLE
        binding.tvTime.text = sdfTime.format(Date())
        updateOsdStats()
        startStatsPolling()
        osdHideRunnable?.let { mainHandler.removeCallbacks(it) }
        osdHideRunnable = Runnable { hideOsd() }
        mainHandler.postDelayed(osdHideRunnable!!, 5000)
    }

    private fun hideOsd() {
        if (currentPanel == Panel.OSD) {
            binding.osdPanel.visibility = View.GONE
            currentPanel = Panel.NONE
        }
        osdHideRunnable?.let { mainHandler.removeCallbacks(it) }
        osdHideRunnable = null
        stopStatsPolling()
    }

    /** 刷新 OSD 统计行（源格式/码率/网速）；设置关闭统计行时隐藏并清空 */
    private fun updateOsdStats() {
        if (!Prefs.getOsdStats(this)) {
            binding.tvStats.text = ""
            binding.tvStats.visibility = View.GONE
            return
        }
        binding.tvStats.visibility = View.VISIBLE
        binding.tvStats.text = try { engine?.statsText().orEmpty() } catch (e: Exception) { "" }
    }

    /** OSD 显示期间按设置的间隔刷新统计行（网速/CPU/内存实时感更强） */
    private fun startStatsPolling() {
        stopStatsPolling()
        if (!Prefs.getOsdStats(this)) return
        // CPU/PSS 采样交给 SystemStats 的后台线程，主线程这里只读缓存值
        SystemStats.start()
        val interval = Prefs.getOsdStatsIntervalMs(this).toLong()
        statsRunnable = object : Runnable {
            override fun run() {
                if (currentPanel != Panel.OSD) return
                updateOsdStats()
                mainHandler.postDelayed(this, interval)
            }
        }
        mainHandler.postDelayed(statsRunnable!!, interval)
    }

    /**
     * 播放速率诊断：每 2 秒打印一次当前播放位置。
     * 位置增量 / 实际经过时间 = 真实播放速率（1.0 正常，0.5 就是慢一半）。
     * 这是唯一不依赖截图/OSD 文本的客观指标 —— 之前用 SurfaceFlinger 帧间隔测，
     * 标定时发现连已知正常的频道也测不出帧，方法不可靠。
     */
    private var rateDiagRunnable: Runnable? = null

    private fun startRateDiag() {
        stopRateDiag()
        val r = object : Runnable {
            override fun run() {
                if (!playbackActive) return
                val pos = engine?.currentPosition() ?: -1
                val dur = engine?.duration() ?: -1
                Log.i(TAG_RATE, "pos=$pos dur=$dur playing=${engine?.isPlaying()} ts=${System.currentTimeMillis()}")
                mainHandler.postDelayed(this, 2000L)
            }
        }
        rateDiagRunnable = r
        mainHandler.postDelayed(r, 2000L)
    }

    private fun stopRateDiag() {
        rateDiagRunnable?.let { mainHandler.removeCallbacks(it) }
        rateDiagRunnable = null
    }

    private fun stopStatsPolling() {
        statsRunnable?.let { mainHandler.removeCallbacks(it) }
        statsRunnable = null
        SystemStats.stop()
    }

    private fun updateOsdProgram(programs: List<Program>) {
        val now = sdfTimeSec.format(Date())
        val current = programs.firstOrNull { programCovers(it, now) }
        binding.tvProgramInfo.text = current?.let {
            "${it.start}-${it.end}  ${it.title}"
        } ?: getString(R.string.no_program)
    }

    /**
     * 节目是否覆盖某个时刻（HH:mm:ss 字符串比较，同一天内字典序即时间序）。
     * 跨零点的节目（23:28-01:09）要单独算：覆盖范围是 start..24:00 加 00:00..end，
     * 直接 `start <= t && end > t` 在 23:40 会判成"没在播"，在 00:30 也判不出来。
     */
    private fun programCovers(p: Program, hms: String): Boolean =
        if (p.end <= p.start) (hms >= p.start || hms < p.end) else (hms >= p.start && hms < p.end)

    /**
     * 当前内容是否可以拖动。
     * 回看片段和时移窗口都有确定的时长；普通直播（直连/代理）duration 为 0。
     * 用它做判据很干净 —— 也顺带保证左右键在普通直播下仍是原来的「开频道面板 / 开节目单」。
     */
    private fun canSeek(): Boolean = (engine?.duration() ?: 0L) > 0L

    /**
     * 时移模式下是否落后于直播边缘。
     * 阈值 5 秒：正常播放本身就有几秒延迟（服务端 liveOffset 默认 3 秒），
     * 不设阈值的话一进时移就提示"落后"，反而让人以为坏了。
     */
    private fun isBehindLive(): Boolean {
        if (!isTimeshiftMode) return false
        val dur = engine?.duration() ?: 0L
        val pos = engine?.currentPosition() ?: 0L
        return dur > 0L && (dur - pos) > 5_000L
    }

    /**
     * 进度条显示条件：回看 / 时移中 / **服务端支持时移且这条线路带时移地址**。
     * 最后一种就是"还没进时移" —— 进度条得在，用户才有地方往回拖来进入时移。
     */
    private fun applySeekBarVisibility() {
        // 用 INVISIBLE 而不是 GONE：**占位但不可见**。
        // 用 GONE 的话，能时移的频道比不能的多出一行，OSD 框高度就会跳 ——
        // 用户要的是"框固定高度，只有里面的信息在变"。
        binding.seekBar.visibility =
            if (isCatchupMode || isTimeshiftMode || canEnterTimeshift()) View.VISIBLE else View.INVISIBLE
    }

    /**
     * 是否给"拉进度条进时移"的入口。
     *
     * 除了服务端开了时移、当前线路带时移地址之外，**还要求服务端真的在录像** ——
     * 时移的价值主要来自"共用录像分片的时间轴"（窗口长、不额外跑 ffmpeg）；
     * 服务端没录像时只能退回滚动 HLS（窗口短、更吃资源），这种半成品入口不给，
     * 免得用户拖了发现只能退几分钟。
     */
    private fun canEnterTimeshift(): Boolean {
        // **已经在时移里就不要再"进入时移"**：那条路会 restartCurrentPlayback() 重启流。
        // 时移流刚起播时 duration 还是 0、canSeek() 为假，左键会落到这个分支 ——
        // 于是按住左键 = 每 50ms 重启一次流（线上实测 400ms 内 12 次
        // "拉进度条 → 进入时移"），窗口永远攒不起来，表现就是"进度条拉不动"。
        if (isTimeshiftMode || isCatchupMode) return false
        val ch = currentChannel ?: return false
        val src = ch.urls.getOrNull(currentSourceIndex) ?: return false
        // 两道判断：
        //  ① 全局：服务端**当前有没有任何录制任务**（心跳每 30 秒刷新）。
        //     这道是必须的 —— 频道列表是启动时拉的、会缓存，用户把录制关掉之后
        //     客户端手里那条频道的 hasRecording/timeshiftUrl 还是旧的，
        //     只靠 ② 会放行（实测就是这样：关掉录像后按方向键仍进了时移）。
        //     逻辑上也一致：没有录制任务时，任何频道都不可能真有录像。
        //  ② 单频道：服务端只对配了录制任务的频道下发 hasRecording=true。
        return Prefs.serverTimeshiftOn(this) && Prefs.serverRecordOn(this) && ch.hasRecording &&
            src.timeshiftUrl.isNotEmpty() && !timeshiftUnavailable.contains(src.id)
    }

    /** 从普通直播进入时移：切到时移流，出画后再定位到 backMs 之前 */
    private fun enterTimeshift(backMs: Long) {
        if (!canEnterTimeshift()) return
        Log.i(TAG_TS, "拉进度条 → 进入时移，回退 ${backMs / 1000} 秒")
        timeshiftEngaged = true
        timeshiftWarmup = 0
        pendingTimeshiftBackMs = backMs
        restartCurrentPlayback()
    }

    /** 暂停/继续。回看与时移共用；普通直播没有可拖动窗口，调用前应先判断 [canSeek] */
    private fun togglePause() {
        if (engine?.isPlaying() == true) {
            engine?.pause()
            // 记成「用户主动暂停」：退到后台再回来不会被自动续播
            playbackActive = false
            // 暂停时带出控制栏。这不只是好看：回看模式下 OK 是暂停/播放（不是开控制栏），
            // 控制栏一旦自动隐藏就再没有别的入口，于是"想往回拖一点"会变得无从下手。
            // 暂停即显示进度条，是最自然、也最不需要额外记忆的做法。
            showOsd()
            showPlayPauseIcon(paused = true)
        } else {
            engine?.start()
            playbackActive = true
            showPlayPauseIcon(paused = false)
        }
    }

    /** 暂停/播放图标闪烁的代数：连按两次时，前一次动画的收尾不能把新图标关掉 */
    private var playPauseIconGen = 0

    /**
     * 画面正中闪一下暂停/播放图标。
     * 遥控器操作没有指针、也没有系统 toast，暂停/播放如果只体现在"画面动不动"上，
     * 用户按完会怀疑到底按上没有 —— 给一个明确的视觉回执。
     */
    private fun showPlayPauseIcon(paused: Boolean) {
        val iv = binding.ivPlayPause
        playPauseIconGen++
        val gen = playPauseIconGen
        iv.animate().cancel()
        iv.setImageResource(if (paused) R.drawable.ic_pause_center else R.drawable.ic_play_center)
        iv.alpha = 1f
        iv.visibility = View.VISIBLE
        iv.animate()
            .alpha(0f)
            .setStartDelay(800) // 先完整显示 0.8 秒，再淡出（太短用户会怀疑没按上）
            .setDuration(400)
            .withEndAction { if (gen == playPauseIconGen) iv.visibility = View.GONE }
            .start()
    }

    /**
     * 相对当前位置快退/快进。
     * 时移下额外提示「落后直播多少」—— 滚动 HLS 往回拖之后画面本来就比直播晚，
     * 不说清楚用户会以为是卡住了。
     */
    /**
     * 连续快退/快进的加速档位：**步进按窗口比例算**，不再是固定的 1~60 秒。
     *
     * 固定步进在长窗口下等于没动 —— 服务端时移窗口按设置可以到 120 分钟
     * （线上实测 119.6 分钟 = 7177 秒），按一下走 1 秒只有 0.014%，
     * 进度条指针肉眼完全看不出来，用户的原话就是「遥控器拉不动进度条」。
     *
     * 现在第 1 档 = 窗口的 0.5%，连按逐级放大到 20%，并夹在 [1 秒, 10 分钟]：
     *   窗口 5 秒    → 每档都是 1 秒（下限，精细微调）
     *   窗口 2.5 分  → 1 / 1.5 / 3 / 4.5 / 7.5 / 12 / 18 / 30 秒
     *   窗口 120 分  → 36 / 72 / 144 / 216 / 360 / 576 / 600 / 600 秒
     * 也就是"按一下指针动 0.5%~20%"，任何窗口长度下都能看出来在动。
     */
    private val seekRampRatio = doubleArrayOf(0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.20)
    private var seekRampIndex = 0
    /** 上一次**按键事件**的时间：判断"按住"还是"连按"，与节流用的 [lastSeekAt] 分开 */
    private var lastKeyEventAt = 0L
    /** 上一次**真正走了步进**的时间：长按自动重复的节流基准 */
    private var lastSeekAt = 0L

    /** 两次按键间隔小于这个值，就认为是遥控器**长按自动重复**（而不是用户在连按） */
    private val keyRepeatMs = 130L

    /**
     * 自动重复时的最小步进间隔。遥控器实测约 50ms 一次重复，
     * 而步进改成"按窗口比例"之后，最高档在 120 分钟窗口下是 10 分钟/次 ——
     * 不节流就是几十分钟/秒，指针直接飞出去停不住。150ms 一步 ≈ 4 分钟/秒，
     * 按住不放就是一个可控的粗调。
     */
    private val keyRepeatMinStepMs = 150L

    /** 步进下限/上限：窗口很小时按秒微调，窗口很大时一次也别超过 10 分钟 */
    private val seekStepMinMs = 1_000L
    private val seekStepMaxMs = 600_000L

    /**
     * 按**事件间隔**区分三种情况（不再用 KeyEvent.repeatCount ——
     * 实测不少电视遥控器普通连按也带 repeatCount>0，用它判断会导致档位永远停在最低档、
     * 用户"按半天只能回退几秒"）：
     *
     *   间隔 < 130ms  遥控器长按自动重复 → **保持当前档位**，并按 [keyRepeatMinStepMs] 节流
     *   130ms~2s      用户在连按         → 逐级加速
     *   > 2s          停手后重新开始     → 回到最低档
     */
    private fun seekByAccel(direction: Int) {
        val now = System.currentTimeMillis()
        val gap = now - lastKeyEventAt
        when {
            gap < keyRepeatMs -> { /* 自动重复：保持档位 */ }
            gap < 2000 -> seekRampIndex = (seekRampIndex + 1).coerceAtMost(seekRampRatio.size - 1)
            else -> seekRampIndex = 0
        }
        lastKeyEventAt = now
        // 节流：距离上一次真正步进不足 keyRepeatMinStepMs 的重复事件直接丢掉。
        // 丢掉时不更新 lastSeekAt，所以下一个重复事件的间隔会自然变大，直到走下一步。
        if (now - lastSeekAt < keyRepeatMinStepMs) return
        lastSeekAt = now
        val dur = engine?.duration() ?: 0L
        val step = if (dur > 0L) {
            (dur * seekRampRatio[seekRampIndex]).toLong().coerceIn(seekStepMinMs, seekStepMaxMs)
        } else {
            seekStepMinMs
        }
        Log.i(TAG_TS, "加速拖动：第 ${seekRampIndex + 1} 档，窗口 ${dur / 1000}s，步进 ${step / 1000} 秒（间隔 ${gap}ms）")
        seekBy(direction * step)
    }

    private fun seekBy(deltaMs: Long) {
        val eng = engine ?: return
        val dur = eng.duration()
        if (dur <= 0L) {
            // 时移流刚起播、播放列表还没回来（duration 未知）：这时拖动无处可拖。
            // 原先静默 return，用户只看到"按了没反应"。
            if (isTimeshiftMode) showStatusTemp(getString(R.string.timeshift_warming))
            return
        }
        val target = (eng.currentPosition() + deltaMs).coerceIn(0L, dur)
        eng.seekTo(target)
        // seek 后的重新缓冲不算"卡死"：把卡死计时清零，别让监测把流重启、把位置丢掉
        (eng as? ExoEngine)?.noteUserSeek()
        // 重新计时 OSD 自动隐藏。不刷新的话：OSD 在拖动过程中自己消失，
        // 隐藏之后左右键就变回「开频道面板 / 开节目单」—— 用户按的还是同一个键，
        // 行为却突然变了。showOsd() 本身是幂等的（会重置计时器、刷新时间）。
        showOsd()
        // 落后多少**不在这里弹提示**了：进度条下面那行（tvSeekTime）已经实时显示
        // "21:05:30（落后 3 分 20 秒）"，再弹一个提示是重复信息、还挡住画面。
        // 这里只把进度条那一行刷新一次，让数字立刻跟上。
        val durNow = engine?.duration() ?: 0L
        val posNow = engine?.currentPosition() ?: 0L
        if (durNow > 0) updateCatchupProgress(posNow, durNow)
    }

    private val seekTimeFmt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())

    private fun updateCatchupProgress(positionMs: Long, durationMs: Long) {
        // 用户正在拖动时，进度条归用户控制。原先无条件覆盖，
        // 结果是指针被每 500ms 的轮询拽回去 —— 表现就是「进度条不跟手」。
        if (isUserSeeking) return
        if (durationMs > 0) {
            val progress = (positionMs * 100 / durationMs).toInt().coerceIn(0, 100)
            binding.seekBar.progress = progress
            binding.tvSeekTime.visibility = View.VISIBLE
            val segStartSec = currentCatchupSegment?.start?.let { secOfDay(it) } ?: -1L
            if (isCatchupMode && segStartSec >= 0) {
                // 回看：这里要显示**这段录像本身是几点的**（用户问的是"这是几点的节目"）。
                // 原来一律按"现在往回推多久"算，对几小时前的录像完全没意义 ——
                // 播 08:32 的录像时它显示的是"现在减 5 分钟"。
                val contentSec = (segStartSec + positionMs / 1000) % 86_400
                val hhmmss = String.format(
                    java.util.Locale.US, "%02d:%02d:%02d",
                    contentSec / 3600, contentSec % 3600 / 60, contentSec % 60
                )
                // "落后直播多久"必须拿**绝对时间**算：录像那天的 0 点 + 节目单的日期偏移
                // + 分片内偏移。直接把"当天秒数"当毫秒用会算出 49 万小时（实测踩过）。
                val behindMs = (System.currentTimeMillis() - catchupWallClockMs(contentSec)).coerceAtLeast(0)
                binding.tvSeekTime.text = getString(R.string.catchup_time_label, hhmmss, fmtBehind(behindMs))
                // OSD 里"正在播出"那行也按录像内容的时间匹配，别显示成现在正在播的节目。
                // 只在"今天"这么做：currentEpgPrograms 装的是今天那份节目单，看昨天/前几天的
                // 回看时没有对应那天的数据，宁可不改，也不要拿今天的节目名去套。
                if (currentCatchupDayOffset == 0) {
                    val prog = currentEpgPrograms.firstOrNull { programCovers(it, hhmmss) }
                    if (prog != null) {
                        binding.tvProgramInfo.text = "${prog.start}-${prog.end}  ${prog.title}"
                    }
                }
            } else {
                // 时移：窗口末尾≈现在，往回推 positionMs 就是当时的时间。
                val behindMs = (durationMs - positionMs).coerceAtLeast(0)
                binding.tvSeekTime.text = getString(
                    R.string.timeshift_time_label,
                    seekTimeFmt.format(java.util.Date(System.currentTimeMillis() - behindMs)),
                    behindMs / 60_000,
                    behindMs / 1000 % 60
                )
            }
        }
    }

    /** 回看内容里"当天第 contentSec 秒"对应的绝对毫秒（今天 0 点 + 日期偏移） */
    private fun catchupWallClockMs(contentSec: Long): Long {
        val cal = java.util.Calendar.getInstance()
        cal.set(java.util.Calendar.HOUR_OF_DAY, 0)
        cal.set(java.util.Calendar.MINUTE, 0)
        cal.set(java.util.Calendar.SECOND, 0)
        cal.set(java.util.Calendar.MILLISECOND, 0)
        return cal.timeInMillis + currentCatchupDayOffset * 86_400_000L + contentSec * 1000L
    }

    /** "5 小时 12 分" / "12 分 30 秒"：给"落后直播多久"用（回看可能差好几小时） */
    private fun fmtBehind(ms: Long): String {
        val totalSec = ms / 1000
        val h = totalSec / 3600
        val m = totalSec % 3600 / 60
        val s = totalSec % 60
        return if (h > 0) "${h} 小时 ${m} 分" else "${m} 分 ${s} 秒"
    }

    // ============================ 面板切换 ============================

    private fun toggleChannelPanel() {
        if (currentPanel == Panel.CHANNEL) {
            hideAllPanels()
        } else {
            showChannelPanel()
        }
    }

    /** 打开频道面板，焦点落在当前频道上；列表预选当前观看的分组与频道，而不是回到第一个 */
    private fun showChannelPanel() {
        hideAllPanels()
        currentPanel = Panel.CHANNEL
        binding.channelPanel.visibility = View.VISIBLE
        if (groups.isNotEmpty()) {
            val g = currentGroupIndex.coerceIn(0, groups.size - 1)
            groupAdapter.setSelectedPosition(g)
            channelAdapter.submitList(groups[g].channels)
            currentChannel?.let { updateChannelHighlight(it) }
        }
        focusChannelList()
    }

    /** 焦点移到右侧频道列表：当前播放频道在该分组则定位到它，否则（刚切换了
     *  新分组）定位到第一个频道。submitList 是异步 DiffUtil，post 等 layout 完成。 */
    private fun focusChannelList() {
        val expected = groups.getOrNull(currentGroupIndex)?.channels ?: return
        if (expected.isEmpty()) return
        val inThisGroup = expected.indexOfFirst { it.id == currentChannel?.id }
        val pos = if (inThisGroup >= 0) inThisGroup else 0
        binding.rvChannels.scrollToPosition(pos)
        binding.rvChannels.post {
            if (currentPanel != Panel.CHANNEL) return@post
            val holder = binding.rvChannels.findViewHolderForAdapterPosition(pos)
            if (holder != null) holder.itemView.requestFocus()
        }
    }

    /** 频道面板中当前持有焦点的列表（分组或频道），两者都没焦点时返回 null */
    private fun focusedChannelPanelList(): androidx.recyclerview.widget.RecyclerView? = when {
        binding.rvGroups.hasFocus() -> binding.rvGroups
        binding.rvChannels.hasFocus() -> binding.rvChannels
        else -> null
    }

    /**
     * 频道面板内纵向键处理：在列表内部正常移动焦点（即使条目少、列表无需滚动），
     * 到达顶/底边界时吞掉按键——防止焦点越界跳到另一个列表触发误播
     * （分组↔频道只允许通过 LEFT/RIGHT 跨越）。
     * 边界按当前焦点项的位置判断，不能用 findLastVisibleItemPosition：
     * 条目数少于一屏时它恒等于末位，会把正常移动也拦截掉。
     */
    private fun handleChannelVerticalKey(event: KeyEvent, down: Boolean): Boolean {
        val active = focusedChannelPanelList() ?: return true
        val count = active.adapter?.itemCount ?: 0
        val child = active.focusedChild
        val pos = if (child != null) active.getChildAdapterPosition(child)
        else androidx.recyclerview.widget.RecyclerView.NO_POSITION
        val atEdge = pos != androidx.recyclerview.widget.RecyclerView.NO_POSITION &&
            if (down) pos >= count - 1 else pos <= 0
        return if (atEdge) true else super.dispatchKeyEvent(event)
    }

    /** 焦点移到左侧分组列表（定位到当前分组） */
    private fun focusGroupList() {
        val count = groupAdapter.itemCount
        if (count == 0) return
        // 进入分类浏览：取消频道列表的 3.5s 自动收起，否则用户还在挑分类就被踢回直播
        // 并把当前频道"确认"掉。回到频道列表时 onFocus 会重新计时。
        cancelChannelPanelHide()
        val pos = currentGroupIndex.coerceIn(0, count - 1)
        binding.rvGroups.scrollToPosition(pos)
        binding.rvGroups.post {
            if (currentPanel != Panel.CHANNEL) return@post
            val holder = binding.rvGroups.findViewHolderForAdapterPosition(pos)
            if (holder != null) holder.itemView.requestFocus()
        }
    }

    private fun toggleEpgPanel() {
        if (currentPanel == Panel.EPG) {
            hideAllPanels()
        } else {
            hideAllPanels()
            currentPanel = Panel.EPG
            binding.epgPanel.visibility = View.VISIBLE
            // 打开时回到"今天"，日期行可左右键切换（支持回看七天）
            epgDateOffset = 0
            binding.tvEpgDate.text = "◀  ${epgDateLabel()}  ▶"
            currentChannel?.let {
                binding.tvEpgTitle.text = "${it.name} · ${getString(R.string.epg_title)}"
            }
            // 焦点先落在日期行（左右换日期），按下键自然进入节目列表并定位到正在播出
            binding.tvEpgDate.requestFocus()
            val idx = epgAdapter.currentRowIndex.takeIf { it >= 0 } ?: 0
            if (epgAdapter.itemCount > 0) {
                binding.rvEpg.scrollToPosition(idx.coerceIn(0, epgAdapter.itemCount - 1))
            }
        }
    }

    private fun hideAllPanels() {
        binding.osdPanel.visibility = View.GONE
        binding.channelPanel.visibility = View.GONE
        binding.epgPanel.visibility = View.GONE
        currentPanel = Panel.NONE
        cancelChannelPanelHide()
    }

    /** OK/点击确认当前焦点频道：收起频道面板并弹出 OSD */
    private fun confirmChannelSelection() {
        cancelChannelPanelHide()
        hideAllPanels()
        currentChannel?.let { binding.tvChannelName.text = it.name }
        showOsd()
    }

    /** 频道列表浏览时，若 3.5s 内没有新操作则自动关闭面板（不换台，等同取消） */
    private fun scheduleChannelPanelHide() {
        channelPanelHideRunnable?.let { mainHandler.removeCallbacks(it) }
        channelPanelHideRunnable = object : Runnable {
            override fun run() {
                if (currentPanel != Panel.CHANNEL) return
                // 焦点在分组列表：用户正在浏览分类，不顺延会把用户踢回直播
                if (binding.rvGroups.hasFocus()) {
                    mainHandler.postDelayed(this, CHANNEL_PANEL_AUTO_HIDE_MS)
                    return
                }
                // 未确认即关闭：保持原频道继续播放，不弹 OSD
                hideAllPanels()
            }
        }
        mainHandler.postDelayed(channelPanelHideRunnable!!, CHANNEL_PANEL_AUTO_HIDE_MS)
    }

    private fun cancelChannelPanelHide() {
        channelPanelHideRunnable?.let { mainHandler.removeCallbacks(it) }
        channelPanelHideRunnable = null
    }

    // ============================ 状态提示 ============================

    private fun showStatus(text: String) {
        binding.tvStatus.text = text
        binding.tvStatus.visibility = View.VISIBLE
    }

    /** 状态提示定时自动消失（如"音轨不支持"这类不应常驻屏幕的提示） */
    private fun showStatusTemp(text: String, durationMs: Long = 4000) {
        showStatus(text)
        statusHideRunnable?.let { mainHandler.removeCallbacks(it) }
        statusHideRunnable = Runnable { hideStatus() }
        mainHandler.postDelayed(statusHideRunnable!!, durationMs)
    }

    private fun hideStatus() {
        statusHideRunnable?.let { mainHandler.removeCallbacks(it) }
        statusHideRunnable = null
        binding.tvStatus.visibility = View.GONE
    }

    // ============================ 线路指示 ============================

    /** OSD 上的线路指示：线路 x/y */
    private fun updateOsdSource() {
        val ch = currentChannel
        if (ch == null || ch.urls.size <= 1) {
            binding.tvSource.text = ""
        } else {
            binding.tvSource.text = getString(R.string.source_indicator, currentSourceIndex + 1, ch.urls.size)
        }
    }

    // ============================ 重连 ============================

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        if (reconnectCount >= 5) {
            showStatus(getString(R.string.reconnect_failed))
            return
        }
        reconnectCount++
        val delayMs = (1000L shl (reconnectCount - 1)).coerceAtMost(30_000) // 1s/2s/4s/8s/16s
        showStatus(getString(R.string.reconnecting, reconnectCount, 5))
        reconnectJob = lifecycleScope.launch {
            delay(delayMs)
            if (currentUrl.isNotEmpty()) {
                restartCurrentPlayback() // 直播重拉当前线路，回看重放片段
            }
        }
    }

    // ============================ 按键处理 ============================

    /** 长按 OK 弹窗后吞掉随后的抬起事件，避免触发列表项点击 */
    private var swallowNextOkUp = false

    /** 连按 OK 计数（3 次内 900ms → 打开换源列表） */
    private var okPressCount = 0
    private var lastOkPressTime = 0L

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_UP &&
            (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER || event.keyCode == KeyEvent.KEYCODE_ENTER)
        ) {
            if (swallowNextOkUp) {
                swallowNextOkUp = false
                return true
            }
        }
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                    // 长按 OK 弹多线路
                    if (event.isLongPress) {
                        swallowNextOkUp = true
                        showSourceDialog()
                        return true
                    }
                    when (currentPanel) {
                        Panel.NONE -> {
                            // 连按 3 次 OK 打开手动换源列表（部分遥控器长按不灵，与长按并存）
                            val now = System.currentTimeMillis()
                            okPressCount = if (now - lastOkPressTime < 900) okPressCount + 1 else 1
                            lastOkPressTime = now
                            if (okPressCount >= 3) {
                                okPressCount = 0
                                hideOsd()
                                showSourceDialog()
                                return true
                            }
                            // 短按 OK：回看=暂停/播放；直播/时移=打开 OSD。
                            // 时移要打开 OSD 才看得到进度条、才能用左右键往回拖。
                            if (isCatchupMode) togglePause() else showOsd()
                            return true
                        }
                        Panel.OSD -> {
                            // 可拖动的内容（回看/时移）：OK 统一是播放/暂停，
                            // 收起控制栏交给 BACK 或 5 秒自动隐藏。
                            // 普通直播没有"暂停"这回事，保持原来的收起。
                            if (isCatchupMode || isTimeshiftMode) togglePause() else hideOsd()
                            return true
                        }
                        // 频道/EPG 面板打开时：OK 交给列表项处理选中，不拦截
                        else -> return super.dispatchKeyEvent(event)
                    }
                }
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    // 时移中：左右键**只**当"拖进度条"，而且放在最前面判断 ——
                    // 绝不再进时移（会重启流）、也不再打开频道面板/节目单：
                    // 误开面板会把攒下的时移进度整个丢掉，用户此刻要的是继续往回拖。
                    if (isTimeshiftMode) {
                        showOsd()
                        seekByAccel(-1)
                        return true
                    }
                    // 回看：和时移一样，左右键只当"拖进度条"，**控制栏关着也认**。
                    // 原先回看必须先按 OK 把控制栏叫出来，5 秒后它自动隐藏，
                    // 同一个键又变回"开频道面板"——用户以为回看拖不动。
                    if (isCatchupMode && canSeek()) {
                        showOsd()
                        seekByAccel(-1)
                        return true
                    }
                    // OSD 打开且内容可拖动（回看）时，左右键当快退快进。
                    // 普通直播 duration 为 0，会落到下面的老逻辑，
                    // 所以频道面板/节目单的导航完全不受影响。
                    if (currentPanel == Panel.OSD && canSeek()) {
                        seekByAccel(-1)
                        return true
                    }
                    // 还没进时移但服务端支持：左键就是"往回拖"。
                    // 遥控器拖不了触摸进度条，必须有这条入口。
                    if (currentPanel == Panel.OSD && canEnterTimeshift()) {
                        enterTimeshift(SEEK_STEP_MS)
                        return true
                    }
                    when (currentPanel) {
                        Panel.NONE, Panel.OSD -> {
                            // 直播画面 → 打开频道面板（焦点在右侧频道列表）
                            showChannelPanel()
                            return true
                        }
                        Panel.CHANNEL -> {
                            if (binding.rvChannels.hasFocus()) {
                                // 频道列表 → 左移回分组列表
                                focusGroupList()
                            } else {
                                // 焦点已在分组列表 → 关闭面板回直播
                                hideAllPanels()
                            }
                            return true
                        }
                        Panel.EPG -> {
                            if (binding.tvEpgDate.hasFocus()) {
                                // 日期行聚焦：左键 → 前一天（最多回看 7 天）
                                shiftEpgDate(-1)
                            } else {
                                // 节目单 → 返回频道面板
                                showChannelPanel()
                            }
                            return true
                        }
                    }
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    // 同左键：时移中最先吃掉左右键，只当拖进度条（不再开节目单）
                    if (isTimeshiftMode) {
                        showOsd()
                        seekByAccel(1)
                        return true
                    }
                    // 回看同理：控制栏关着也认左右键是快进快退
                    if (isCatchupMode && canSeek()) {
                        showOsd()
                        seekByAccel(1)
                        return true
                    }
                    if (currentPanel == Panel.OSD && canSeek()) {
                        seekByAccel(1)
                        return true
                    }
                    when (currentPanel) {
                        Panel.NONE, Panel.OSD -> {
                            // 直播画面 → 直接打开节目单
                            if (currentChannel != null) {
                                toggleEpgPanel()
                            }
                            return true
                        }
                        Panel.CHANNEL -> {
                            if (binding.rvGroups.hasFocus()) {
                                // 分组列表 → 右移进频道列表
                                focusChannelList()
                            } else {
                                // 焦点在频道列表 → 打开节目单
                                toggleEpgPanel()
                            }
                            return true
                        }
                        Panel.EPG -> {
                            // 日期行聚焦：右键 → 后一天（最多回到今天）；否则吞掉避免误操作
                            if (binding.tvEpgDate.hasFocus()) {
                                shiftEpgDate(1)
                            }
                            return true
                        }
                    }
                }
                KeyEvent.KEYCODE_DPAD_UP -> {
                    when (currentPanel) {
                        Panel.NONE, Panel.OSD -> {
                            // 时移中禁止换台：换台会把攒下的时移进度整个丢掉
                            if (isTimeshiftMode) {
                                showStatusTemp(getString(R.string.timeshift_zap_blocked))
                                return true
                            }
                            if (throttleZap()) return true
                            channelUp()
                            return true
                        }
                        Panel.CHANNEL -> return handleChannelVerticalKey(event, /* down= */ false)
                        else -> { /* EPG：交给列表默认处理 */ }
                    }
                }
                KeyEvent.KEYCODE_DPAD_DOWN -> {
                    when (currentPanel) {
                        Panel.NONE, Panel.OSD -> {
                            if (isTimeshiftMode) {
                                showStatusTemp(getString(R.string.timeshift_zap_blocked))
                                return true
                            }
                            if (throttleZap()) return true
                            channelDown()
                            return true
                        }
                        Panel.CHANNEL -> return handleChannelVerticalKey(event, /* down= */ true)
                        else -> { /* EPG：交给列表默认处理 */ }
                    }
                }
                // 数字键选台
                KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_2,
                KeyEvent.KEYCODE_3, KeyEvent.KEYCODE_4, KeyEvent.KEYCODE_5,
                KeyEvent.KEYCODE_6, KeyEvent.KEYCODE_7, KeyEvent.KEYCODE_8,
                KeyEvent.KEYCODE_9 -> {
                    if (currentPanel == Panel.NONE || currentPanel == Panel.OSD) {
                        onNumberKey(event.keyCode - KeyEvent.KEYCODE_0)
                        return true
                    }
                }
                KeyEvent.KEYCODE_MENU -> {
                    if (event.isLongPress) {
                        // 长按菜单键：手动重新解码（解码器没报错但肉眼看到持续花屏时使用）
                        showStatus("正在刷新画面…")
                        recoveryLevel = 0
                        restartCurrentPlayback()
                        return true
                    }
                    // 打开设置前收起所有面板，避免设置浮窗与频道/节目单面板叠在一起
                    hideAllPanels()
                    startActivity(Intent(this, SettingsActivity::class.java))
                    return true
                }
                // 标准媒体键：遥控器上带这些键的直接当传输控制。
                // 只在可拖动的内容（回看 / 时移）上生效，普通直播不拦截、交回系统。
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                KeyEvent.KEYCODE_MEDIA_PLAY,
                KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                    if (canSeek()) {
                        togglePause()
                        return true
                    }
                }
                KeyEvent.KEYCODE_MEDIA_REWIND -> {
                    if (canSeek()) {
                        seekByAccel(-1)
                        return true
                    }
                }
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                    if (canSeek()) {
                        seekByAccel(1)
                        return true
                    }
                }
                KeyEvent.KEYCODE_BACK -> {
                    return handleBackKey()
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** 逐级返回：节目单 → 频道列表 → 分组列表 → 直播画面 → 双击退出 */
    private fun handleBackKey(): Boolean {
        when (currentPanel) {
            Panel.OSD -> { hideOsd(); return true }
            Panel.EPG -> {
                if (binding.rvEpg.hasFocus()) {
                    // 焦点在节目列表 → 先退回日期行
                    binding.tvEpgDate.requestFocus()
                } else {
                    // 焦点在日期行 → 直接退出节目单回直播（不再弹左侧频道菜单）
                    hideAllPanels()
                }
                return true
            }
            Panel.CHANNEL -> {
                if (binding.rvChannels.hasFocus()) {
                    // 频道列表 → 退回分组列表
                    focusGroupList()
                } else {
                    // 分组列表 → 关闭面板回直播
                    hideAllPanels()
                }
                return true
            }
            Panel.NONE -> {
                if (isCatchupMode) {
                    backToLive()
                    return true
                }
                // 时移回退之后要能一步回到直播。原先只能靠一直按右键追，
                // 落后半小时得按 60 下，实际等于回不去。
                // 回看模式下按返回也是这个语义，保持一致。
                // 在时移模式下，返回键**无条件**先退出时移回直播。
                // 原先要求"落后 5 秒以上"才回直播，停在直播边缘时按返回会走到下面的
                // "双击退出程序" —— 用户按一下返回像是要退出应用。
                if (isTimeshiftMode) {
                    Log.i(TAG_TS, "返回键：退出时移回直播（落后=${isBehindLive()}）")
                    backToLive()
                    showStatusTemp(getString(R.string.timeshift_live))
                    return true
                }
                // 双击退出
                val now = System.currentTimeMillis()
                if (now - lastPressedBack < 2000) {
                    finish()
                } else {
                    lastPressedBack = now
                    showStatus(getString(R.string.exit_confirm))
                    mainHandler.postDelayed({ hideStatus() }, 2000)
                }
                return true
            }
        }
    }

    private fun channelUp() {
        val group = groups.getOrNull(currentGroupIndex) ?: return
        val size = group.channels.size
        if (size == 0) return
        // 跳过没有可用线路的占位频道，否则按了换台键毫无反应像失灵
        var next = currentChannelIndexInGroup
        repeat(size) {
            next = (next - 1 + size) % size
            if (group.channels[next].urls.isNotEmpty()) {
                currentChannelIndexInGroup = next
                playChannel(group.channels[next])
                return
            }
        }
    }

    private fun channelDown() {
        val group = groups.getOrNull(currentGroupIndex) ?: return
        val size = group.channels.size
        if (size == 0) return
        var next = currentChannelIndexInGroup
        repeat(size) {
            next = (next + 1) % size
            if (group.channels[next].urls.isNotEmpty()) {
                currentChannelIndexInGroup = next
                playChannel(group.channels[next])
                return
            }
        }
    }

    // ============================ 数字键选台 ============================

    private var numberInput = ""
    private var numberInputRunnable: Runnable? = null

    private fun onNumberKey(digit: Int) {
        numberInputRunnable?.let { mainHandler.removeCallbacks(it) }
        numberInput += digit.toString()
        showStatus("选台：$numberInput")
        // 1.8 秒内无后续输入则执行跳转
        numberInputRunnable = Runnable {
            val num = numberInput.toIntOrNull()
            numberInput = ""
            if (num != null && num > 0) jumpToChannelNumber(num) else hideStatus()
        }
        mainHandler.postDelayed(numberInputRunnable!!, 1800)
    }

    /** 按全局序号选台（跨分组按顺序编号） */
    private fun jumpToChannelNumber(num: Int) {
        var idx = 0
        for ((gi, g) in groups.withIndex()) {
            for ((ci, ch) in g.channels.withIndex()) {
                idx++
                if (idx == num) {
                    currentGroupIndex = gi
                    currentChannelIndexInGroup = ci
                    playChannel(ch)
                    return
                }
            }
        }
        showStatus("频道号 $num 不存在")
        mainHandler.postDelayed({ hideStatus() }, 2000)
    }

    private fun showSourceDialog() {
        val channel = currentChannel ?: return
        if (isCatchupMode) return
        if (channel.urls.size <= 1) {
            showStatus(getString(R.string.only_one_source))
            mainHandler.postDelayed({ hideStatus() }, 2000)
            return
        }
        // 优先用服务端探测的分辨率，其次用本机实际出画面记录
        val items = channel.urls.mapIndexed { idx, u ->
            val h = if (u.height > 0) u.height else (sourceHeights[u.id] ?: 0)
            if (h > 0) "${getString(R.string.source_line, idx + 1)}（${h}P）"
            else getString(R.string.source_line, idx + 1)
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(R.string.select_source)
            .setSingleChoiceItems(items, currentSourceIndex) { dialog, which ->
                currentSourceIndex = which
                currentUrl = channel.urls[which].url
                Prefs.setPreferredSource(this, channel.id, channel.urls[which].id)
                updateOsdSource()
                playCurrentSource()
                dialog.dismiss()
            }
            .show()
    }

    // ============================ 生命周期 ============================

    /**
     * 播放时强制不息屏：设置开启则在窗口加 FLAG_KEEP_SCREEN_ON，
     * 关闭则清除。在 onResume 调用，从设置页返回后可立即生效。
     */
    private fun applyKeepScreenOn() {
        if (Prefs.getKeepScreenOn(this)) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    override fun onResume() {
        super.onResume()
        // 从后台回来：离开前在放就接着放。
        // 放在 applyEngineConfig 之前 —— 万一引擎配置变了、它自己会重新拉流，
        // 不会跟这里的续播互相覆盖。
        resumeAfterBackground()
        // 引擎切换后回到 MainActivity：检查内核变更
        applyEngineConfig()
        // 播放时强制不息屏（设置可开关）
        applyKeepScreenOn()
        // 画面比例在设置页改完后立即生效（引擎可能未重建）
        engine?.setScaleMode(Prefs.getScaleMode(this))
        // 从设置页返回时：若服务器地址变化且未绑定，重新走注册流程
        val url = Prefs.getServerUrl(this)
        if (url != lastServerUrl && Prefs.getToken(this).isEmpty()) {
            lastServerUrl = url
            showBindingMask()
            startRegisterPolling()
        }
        // 时移开关在设置页被改过：立刻按新值重拉一次，不用等用户换台才生效。
        // 值没变时什么都不做（onResume 每次回前台都会走到这里）。
        if (!isCatchupMode && currentChannel != null &&
            Prefs.serverTimeshiftOn(this) != isTimeshiftMode
        ) {
            playCurrentSource(animate = false)
        }
        // 回到前台：恢复 OSD 统计采样与 EPG 定时刷新
        if (currentPanel == Panel.OSD) SystemStats.start()
        scheduleEpgRefresh()
    }

    /**
     * 退到后台时：**暂停播放** + 停掉周期任务。
     *
     * 暂停是后加的：原先 onStop 只清定时任务、不碰播放器，于是按 Home 键切到别的应用后
     * 画面/声音还在后台跑（电视上尤其明显）。现在离开就停，回来再接着放
     * （见 [resumeAfterBackground]）。
     *
     * 不会误伤设置页：设置面板是浮窗主题（`windowIsFloating`），盖在播放画面上时
     * MainActivity 只 onPause 不 onStop，所以在设置里调参不会打断正在看的节目。
     *
     * 原先没有 onStop/onPause：60 秒心跳、10 分钟 EPG 刷新、回看进度轮询在后台
     * 一直跑，ExoEngine 的 stall monitor 也每 2 秒无条件唤醒主线程。
     */
    override fun onStop() {
        super.onStop()
        // 只有「用户期望在播」时才暂停，避免把用户自己暂停的状态也记成待续播
        wasPlayingBeforeStop = playbackActive && engine != null
        if (wasPlayingBeforeStop) engine?.pause()

        // 退到后台就不再需要预热：既省服务端那一路 ffmpeg，也避免回来时
        // 因为 timeshiftWarmUrl 还留着而误判"已经在预热"，导致预热再也不重排
        cancelTimeshiftWarmup()
        mainHandler.removeCallbacksAndMessages(null)
        osdHideRunnable = null
        epgRefreshRunnable = null
        channelPanelHideRunnable = null
        statusHideRunnable = null
        cancelSwitchWatchdog()
        stopStatsPolling()
        stopProgressPolling()
        stopRateDiag()
    }

    /**
     * 从后台回到前台时续播。
     *
     * 直播和回看的处理不一样：
     *   - **回看**：从暂停的位置 `start()` 继续，保留观看进度；
     *   - **直播**：重新拉流，而不是从暂停点续播 —— 续播会停在离开时的那一帧，
     *     看到的是一段"过去"的内容，而且直播流不会自己追回直播边缘。
     *     重新拉流的代价是约 1 秒重缓冲，换来的是回来就是当前正在播的节目。
     */
    private fun resumeAfterBackground() {
        if (!wasPlayingBeforeStop) return
        wasPlayingBeforeStop = false
        if (isCatchupMode) {
            engine?.start()
        } else {
            // 也不是换台，不做过渡动画
            playCurrentSource(animate = false)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // 所有 mainHandler 上的延时回调都要清掉：它们都强引用 Activity 与 binding。
        // 其中 channelPanelHideRunnable 在「焦点仍在分组列表」时会每 3.5 秒重新投递
        // 自己，Activity 销毁后若不清除就会永久循环。用 removeCallbacksAndMessages(null)
        // 一并覆盖那些临时 postDelayed { hideStatus() } 的匿名回调。
        mainHandler.removeCallbacksAndMessages(null)
        osdHideRunnable = null
        epgRefreshRunnable = null
        channelPanelHideRunnable = null
        statusHideRunnable = null
        numberInputRunnable = null
        splashFallback = null

        cancelSwitchWatchdog()
        stopStatsPolling()
        stopProgressPolling()
        onScaleModeChanged = null
        registerJob?.cancel()
        heartbeatJob?.cancel()
        reconnectJob?.cancel()
        releaseEngine()
    }

    private fun releaseEngine() {
        engine?.release()
        engine = null
    }
}
