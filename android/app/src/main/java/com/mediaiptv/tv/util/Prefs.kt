package com.mediaiptv.tv.util

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import java.util.UUID

/**
 * 全局 SharedPreferences 封装：token、设备 ID、播放设置
 */
object Prefs {

    private const val NAME = "media_iptv_prefs"

    private const val KEY_TOKEN = "token"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_SERVER_URL = "server_url"
    private const val KEY_ENGINE = "engine"            // "exo" | "system" | "ijk"
    private const val KEY_BUFFER_LEVEL = "buffer_level" // 0=低 1=中 2=高
    private const val KEY_SCALE_MODE = "scale_mode"    // "fit"|"fill"|"zoom"
    private const val KEY_AUTOSTART = "autostart"
    private const val KEY_DECODE_MODE = "decode_mode"   // 旧键（已拆分为视频/音频，仅用于迁移）
    private const val KEY_VIDEO_DECODE_MODE = "video_decode_mode" // "auto"|"hw"|"sw"
    private const val KEY_AUDIO_DECODE_MODE = "audio_decode_mode" // "auto"|"hw"|"sw"
    private const val KEY_QUALITY = "quality"           // "auto"|"high"|"low"
    private const val KEY_AUTO_SWITCH = "auto_switch_source"   // 超时无画面自动换源
    private const val KEY_SWITCH_TIMEOUT = "switch_timeout_sec" // 换源等待秒数
    private const val KEY_LAST_CHANNEL = "last_channel_id"      // 频道记忆：上次观看的频道
    private const val KEY_LAST_PLAY_URL = "last_play_url"       // 上次成功播放的地址（冷启动预热连接）
    private const val KEY_AV3A_SOURCES = "av3a_sources"         // 需要 AV3A 兼容引擎(ijk)的线路集合："channelId:sourceId"
    private const val KEY_AUDIO_PASSTHROUGH = "audio_passthrough" // 音频直通
    private const val KEY_KEEP_SCREEN_ON = "keep_screen_on"       // 播放时强制不息屏
    private const val KEY_OSD_STATS = "osd_stats"                 // 是否显示 OSD 底部统计行
    private const val KEY_OSD_STATS_INTERVAL = "osd_stats_interval_ms" // OSD 统计刷新间隔(ms)
    private const val KEY_SKIPPED_UPDATE = "skipped_update_version"    // 用户点过「稍后」的更新版本号
    private const val KEY_KEEP_ALIVE = "keep_alive"                    // 后台保活（前台服务常驻）
    private const val KEY_TIMESHIFT = "timeshift"                      // 时移回看（直播走服务端滚动 HLS）

    // 服务端下发的播放配置默认值（后台「客户端播放配置」）。
    // 这些**不是**用户设置，而是"用户没自己设过时用什么"——
    // 见 getEngine/getBufferMs/getScaleMode/getLiveOffsetMs 的取值顺序。
    private const val KEY_SRV_ENGINE = "srv_engine"
    private const val KEY_SRV_BUFFER_MS = "srv_buffer_ms"
    private const val KEY_SRV_SCALE = "srv_scale"
    private const val KEY_SRV_LIVE_OFFSET = "srv_live_offset_ms"
    // 服务端能力（心跳下发）：时移/录像是否开启由**服务端**决定
    private const val KEY_SRV_TS_ON = "srv_feature_timeshift"
    private const val KEY_SRV_TS_WINDOW = "srv_feature_ts_window_min"
    private const val KEY_SRV_REC_ON = "srv_feature_record"

    const val DEFAULT_SERVER = "http://192.168.1.1:9527"

    const val ENGINE_EXO = "exo"
    const val ENGINE_SYSTEM = "system"
    const val ENGINE_IJK = "ijk"      // IJK 兼容引擎（内置 AV3A 等解码器，可手动强制使用）

    const val SCALE_FIT = "fit"
    const val SCALE_FILL = "fill"
    const val SCALE_ZOOM = "zoom"
    const val SCALE_169 = "169"   // 强制 16:9（非 16:9 画面拉伸/裁到 16:9）

    const val DECODE_AUTO = "auto"
    const val DECODE_HW = "hw"
    const val DECODE_SW = "sw"

    const val QUALITY_AUTO = "auto"
    const val QUALITY_HIGH = "high"
    const val QUALITY_LOW = "low"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    // -------- Token --------
    fun getToken(context: Context): String = prefs(context).getString(KEY_TOKEN, "") ?: ""

    fun setToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply()
    }

    fun clearToken(context: Context) {
        prefs(context).edit().remove(KEY_TOKEN).apply()
    }

    // -------- 设备 ID（首次启动生成并持久化）--------
    fun getDeviceId(context: Context): String {
        val p = prefs(context)
        val saved = p.getString(KEY_DEVICE_ID, null)
        if (!saved.isNullOrEmpty()) return saved
        // 尝试使用 ANDROID_ID，否则用 UUID
        val id = try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
                ?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" }
                ?: UUID.randomUUID().toString()
        } catch (e: Exception) {
            UUID.randomUUID().toString()
        }
        p.edit().putString(KEY_DEVICE_ID, id).apply()
        return id
    }

    // -------- 服务器地址 --------
    fun getServerUrl(context: Context): String =
        prefs(context).getString(KEY_SERVER_URL, DEFAULT_SERVER) ?: DEFAULT_SERVER

    fun setServerUrl(context: Context, url: String) {
        var u = url.trim().trimEnd('/')
        // 用户常忘记协议头，自动补全
        if (u.isNotEmpty() && !u.startsWith("http://") && !u.startsWith("https://")) {
            u = "http://$u"
        }
        prefs(context).edit().putString(KEY_SERVER_URL, u).apply()
    }

    // -------- 播放内核 --------
    /**
     * 播放引擎。取值顺序：**用户在客户端设置页选过的 > 服务端下发的默认值 > 内置 exo**。
     * 后台「客户端播放配置」里的引擎就是这里的第二档 —— 用户没动过才生效。
     */
    fun getEngine(context: Context): String {
        val p = prefs(context)
        if (p.contains(KEY_ENGINE)) return p.getString(KEY_ENGINE, ENGINE_EXO) ?: ENGINE_EXO
        return p.getString(KEY_SRV_ENGINE, null) ?: ENGINE_EXO
    }

    fun setEngine(context: Context, engine: String) {
        prefs(context).edit().putString(KEY_ENGINE, engine).apply()
    }

    // -------- 缓冲档位 --------
    fun getBufferLevel(context: Context): Int = prefs(context).getInt(KEY_BUFFER_LEVEL, 1)

    fun setBufferLevel(context: Context, level: Int) {
        prefs(context).edit().putInt(KEY_BUFFER_LEVEL, level).apply()
    }

    /**
     * 缓冲毫秒数。客户端设置页把它做成三档（低 2s / 中 5s / 高 10s）；
     * 用户没选过档位时用服务端下发的 bufferMs，最后才落到 5s。
     */
    fun getBufferMs(context: Context): Int {
        val p = prefs(context)
        if (p.contains(KEY_BUFFER_LEVEL)) {
            return when (getBufferLevel(context)) {
                0 -> 2000
                2 -> 10000
                else -> 5000
            }
        }
        return p.getInt(KEY_SRV_BUFFER_MS, 5000)
    }

    // -------- 画面比例 --------
    fun getScaleMode(context: Context): String {
        val p = prefs(context)
        if (p.contains(KEY_SCALE_MODE)) return p.getString(KEY_SCALE_MODE, SCALE_FIT) ?: SCALE_FIT
        return p.getString(KEY_SRV_SCALE, null) ?: SCALE_FIT
    }

    fun setScaleMode(context: Context, mode: String) {
        prefs(context).edit().putString(KEY_SCALE_MODE, mode).apply()
    }

    /**
     * 直播目标偏移（ms）：客户端贴直播边缘播放，留一点缓冲避免频繁卡顿。
     * 原先 ExoEngine 里写死 2000，后台那个「直播偏移」填了也没用；现在走设置。
     */
    fun getLiveOffsetMs(context: Context): Int =
        prefs(context).getInt(KEY_SRV_LIVE_OFFSET, 2000)

    /**
     * 保存服务端下发的播放配置默认值。
     * @return 是否有字段发生变化（没变就不用重建引擎，避免每次心跳都重拉流）
     */
    // -------- 服务端能力（心跳下发）--------

    /** 服务端是否开启时移。客户端没有自己的时移开关，一切以服务端为准。 */
    fun serverTimeshiftOn(context: Context): Boolean = prefs(context).getBoolean(KEY_SRV_TS_ON, false)

    /** 服务端时移窗口长度（分钟），仅用于界面提示。0 = 未开或未知 */
    fun serverTimeshiftWindowMin(context: Context): Int = prefs(context).getInt(KEY_SRV_TS_WINDOW, 0)

    /** 服务端是否有启用的录像任务（决定回看入口可不可用） */
    fun serverRecordOn(context: Context): Boolean = prefs(context).getBoolean(KEY_SRV_REC_ON, false)

    /** @return 是否发生变化（变了才需要刷界面） */
    fun setServerFeatures(context: Context, tsOn: Boolean, tsWindowMin: Int, recOn: Boolean): Boolean {
        val p = prefs(context)
        val changed = p.getBoolean(KEY_SRV_TS_ON, false) != tsOn || p.getBoolean(KEY_SRV_REC_ON, false) != recOn
        p.edit()
            .putBoolean(KEY_SRV_TS_ON, tsOn)
            .putInt(KEY_SRV_TS_WINDOW, tsWindowMin)
            .putBoolean(KEY_SRV_REC_ON, recOn)
            .apply()
        return changed
    }

    fun setServerPlayerConfig(
        context: Context,
        engine: String?,
        bufferMs: Int?,
        scaleMode: String?,
        liveOffsetMs: Int?
    ): Boolean {
        val p = prefs(context)
        val changed = (engine != null && p.getString(KEY_SRV_ENGINE, null) != engine) ||
            (bufferMs != null && bufferMs > 0 && p.getInt(KEY_SRV_BUFFER_MS, 5000) != bufferMs) ||
            (scaleMode != null && p.getString(KEY_SRV_SCALE, null) != scaleMode) ||
            (liveOffsetMs != null && liveOffsetMs > 0 && p.getInt(KEY_SRV_LIVE_OFFSET, 2000) != liveOffsetMs)
        if (!changed) return false
        p.edit().apply {
            if (engine != null) putString(KEY_SRV_ENGINE, engine)
            if (bufferMs != null && bufferMs > 0) putInt(KEY_SRV_BUFFER_MS, bufferMs)
            if (scaleMode != null) putString(KEY_SRV_SCALE, scaleMode)
            if (liveOffsetMs != null && liveOffsetMs > 0) putInt(KEY_SRV_LIVE_OFFSET, liveOffsetMs)
        }.apply()
        return true
    }

    // -------- 开机自启 --------
    fun getAutostart(context: Context): Boolean = prefs(context).getBoolean(KEY_AUTOSTART, false)

    fun setAutostart(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTOSTART, enabled).apply()
    }

    // -------- 后台保活 --------
    /**
     * 是否常驻后台（前台服务 + 被杀自恢复）。
     * 默认开：电视盒子上的直播应用如果被系统回收，用户再打开要等一整套启动流程，
     * 而且「开机自启」也依赖它。不想要常驻通知的话可以在设置里关掉。
     */
    fun getKeepAlive(context: Context): Boolean = prefs(context).getBoolean(KEY_KEEP_ALIVE, true)

    fun setKeepAlive(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_KEEP_ALIVE, enabled).apply()
    }

    // -------- 时移（timeshift）--------

    /**
     * 时移回看：开启后直播走服务端的滚动 HLS，可以暂停/往回拖。
     *
     * **默认关闭**，两个原因：
     *   1. 时移要服务端为每个频道常驻一个 ffmpeg 转封装进程，没人看的时候不该白跑；
     *   2. 滚动 HLS 天然比直连多 4~8 秒延迟，不想要的人不该被动承担。
     * 关掉时播放路径与之前完全一致。
     */
    fun getTimeshift(context: Context): Boolean = prefs(context).getBoolean(KEY_TIMESHIFT, false)

    fun setTimeshift(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_TIMESHIFT, enabled).apply()
    }

    // -------- 解码模式（视频 / 音频分开设置）--------

    /**
     * 视频解码模式。首次读取时若新键不存在（旧版本只有一个 decode_mode），
     * 则把旧值同时迁移为视频与音频的初始模式。
     */
    fun getVideoDecodeMode(context: Context): String =
        getSplitDecodeMode(context, KEY_VIDEO_DECODE_MODE)

    fun setVideoDecodeMode(context: Context, mode: String) {
        prefs(context).edit().putString(KEY_VIDEO_DECODE_MODE, mode).apply()
    }

    fun getAudioDecodeMode(context: Context): String =
        getSplitDecodeMode(context, KEY_AUDIO_DECODE_MODE)

    fun setAudioDecodeMode(context: Context, mode: String) {
        prefs(context).edit().putString(KEY_AUDIO_DECODE_MODE, mode).apply()
    }

    /** 读取拆分后的解码模式，并在首次调用时完成旧配置迁移 */
    private fun getSplitDecodeMode(context: Context, key: String): String {
        val p = prefs(context)
        if (!p.contains(KEY_VIDEO_DECODE_MODE) || !p.contains(KEY_AUDIO_DECODE_MODE)) {
            val legacy = p.getString(KEY_DECODE_MODE, DECODE_AUTO) ?: DECODE_AUTO
            p.edit()
                .putString(KEY_VIDEO_DECODE_MODE, legacy)
                .putString(KEY_AUDIO_DECODE_MODE, legacy)
                .apply()
        }
        return p.getString(key, DECODE_AUTO) ?: DECODE_AUTO
    }

    // -------- 画质偏好 --------
    fun getQuality(context: Context): String =
        prefs(context).getString(KEY_QUALITY, QUALITY_AUTO) ?: QUALITY_AUTO

    fun setQuality(context: Context, quality: String) {
        prefs(context).edit().putString(KEY_QUALITY, quality).apply()
    }

    // -------- 超时无画面自动换源 --------
    fun getAutoSwitchSource(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUTO_SWITCH, true)

    fun setAutoSwitchSource(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO_SWITCH, enabled).apply()
    }

    /** 无画面判定等待秒数（默认 10 秒） */
    fun getSwitchTimeoutSec(context: Context): Int =
        prefs(context).getInt(KEY_SWITCH_TIMEOUT, 10)

    fun setSwitchTimeoutSec(context: Context, sec: Int) {
        prefs(context).edit().putInt(KEY_SWITCH_TIMEOUT, sec).apply()
    }

    // -------- 频道记忆：下次启动自动播放上次观看的频道 --------
    fun getLastChannelId(context: Context): Int =
        prefs(context).getInt(KEY_LAST_CHANNEL, -1)

    fun setLastChannelId(context: Context, channelId: Int) {
        prefs(context).edit().putInt(KEY_LAST_CHANNEL, channelId).apply()
    }

    // -------- 上次成功播放地址：冷启动时预热该地址的连接（DNS/TCP/TLS），缩短起播握手 --------
    fun getLastPlayUrl(context: Context): String =
        prefs(context).getString(KEY_LAST_PLAY_URL, "").orEmpty()

    fun setLastPlayUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_LAST_PLAY_URL, url).apply()
    }

    // -------- AV3A 线路记忆 --------
    // 某条线路一旦被判定音轨需要 AV3A 兼容引擎(ijk)，就记下来；下次播同线路直接起 ijk，
    // 省掉"先建 ExoPlayer → 解析出 av3a → 推翻重建 ijk"这一整轮（实测约 3–4s）。

    private fun av3aKey(channelId: Int, sourceId: Int) = "$channelId:$sourceId"

    fun isAv3aSource(context: Context, channelId: Int, sourceId: Int): Boolean {
        if (channelId <= 0 || sourceId <= 0) return false
        return prefs(context).getStringSet(KEY_AV3A_SOURCES, emptySet())
            ?.contains(av3aKey(channelId, sourceId)) == true
    }

    fun markAv3aSource(context: Context, channelId: Int, sourceId: Int) {
        if (channelId <= 0 || sourceId <= 0) return
        val p = prefs(context)
        // getStringSet 返回的集合不可直接改，需拷贝
        val cur = p.getStringSet(KEY_AV3A_SOURCES, emptySet())?.toMutableSet() ?: mutableSetOf()
        if (cur.add(av3aKey(channelId, sourceId))) {
            p.edit().putStringSet(KEY_AV3A_SOURCES, cur).apply()
        }
    }

    /** 冷启动：上次观看的线路是否已知需要 AV3A 兼容引擎 */
    fun isLastSourceAv3a(context: Context): Boolean {
        val cid = getLastChannelId(context)
        if (cid <= 0) return false
        return isAv3aSource(context, cid, getPreferredSource(context, cid))
    }

    // -------- 音频直通（passthrough）：AC3/E-AC3/DTS 原样送 HDMI 由电视/功放解码 --------
    fun getAudioPassthrough(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUDIO_PASSTHROUGH, false)

    fun setAudioPassthrough(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUDIO_PASSTHROUGH, enabled).apply()
    }

    // -------- 播放时强制不息屏 --------
    fun getKeepScreenOn(context: Context): Boolean =
        prefs(context).getBoolean(KEY_KEEP_SCREEN_ON, true)

    fun setKeepScreenOn(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_KEEP_SCREEN_ON, enabled).apply()
    }

    // -------- OSD 底部统计行 --------
    fun getOsdStats(context: Context): Boolean =
        prefs(context).getBoolean(KEY_OSD_STATS, true)

    fun setOsdStats(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_OSD_STATS, enabled).apply()
    }

    /** OSD 统计刷新间隔毫秒（默认 500） */
    fun getOsdStatsIntervalMs(context: Context): Int =
        prefs(context).getInt(KEY_OSD_STATS_INTERVAL, 500)

    fun setOsdStatsIntervalMs(context: Context, ms: Int) {
        prefs(context).edit().putInt(KEY_OSD_STATS_INTERVAL, ms).apply()
    }

    // -------- 频道-源偏好（上次成功播放的源 id）--------
    fun getPreferredSource(context: Context, channelId: Int): Int {
        return prefs(context).getInt("pref_source_$channelId", -1)
    }

    fun setPreferredSource(context: Context, channelId: Int, sourceId: Int) {
        prefs(context).edit().putInt("pref_source_$channelId", sourceId).apply()
    }

    // -------- 客户端自更新 --------
    /**
     * 用户点了「稍后」的那个版本号。
     * 记下来是为了不要每次启动都弹同一个更新提示——电视盒子开机就弹窗非常烦人；
     * 但更高版本仍会提示，手动「检查更新」也永远会显示。
     */
    fun getSkippedUpdateVersion(context: Context): Int =
        prefs(context).getInt(KEY_SKIPPED_UPDATE, 0)

    fun setSkippedUpdateVersion(context: Context, versionCode: Int) {
        prefs(context).edit().putInt(KEY_SKIPPED_UPDATE, versionCode).apply()
    }
}
