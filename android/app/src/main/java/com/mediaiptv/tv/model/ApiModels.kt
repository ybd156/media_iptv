package com.mediaiptv.tv.model

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

/**
 * 统一响应包
 */
@JsonClass(generateAdapter = true)
data class ApiResponse<T>(
    @Json(name = "code") val code: Int,
    @Json(name = "msg") val msg: String,
    @Json(name = "data") val data: T? = null
) {
    val isSuccess: Boolean get() = code == 0
    val isPending: Boolean get() = code == 1001
    val isUnauthorized: Boolean get() = code == 401
}

/**
 * 注册请求体
 */
@JsonClass(generateAdapter = true)
data class RegisterRequest(
    @Json(name = "deviceId") val deviceId: String,
    @Json(name = "model") val model: String,
    @Json(name = "androidVersion") val androidVersion: String
)

/**
 * 注册响应数据
 */
@JsonClass(generateAdapter = true)
data class RegisterData(
    @Json(name = "status") val status: String,
    @Json(name = "token") val token: String? = null
) {
    val isApproved: Boolean get() = status == "approved"
}

/**
 * 播放器配置
 */
@JsonClass(generateAdapter = true)
data class PlayerConfig(
    @Json(name = "engine") val engine: String = "exo",
    @Json(name = "bufferMs") val bufferMs: Int = 5000,
    @Json(name = "liveOffsetMs") val liveOffsetMs: Int = 0,
    @Json(name = "scaleMode") val scaleMode: String = "fit",
    @Json(name = "autoStart") val autoStart: Boolean = false
)

/**
 * 心跳响应数据
 */
@JsonClass(generateAdapter = true)
/**
 * 服务端能力（心跳下发）。
 * 时移「开关」只有服务端有 —— 客户端不再各说各话，服务端没开就不给进。
 */
data class ServerFeatures(
    @Json(name = "timeshift") val timeshift: Boolean = false,
    @Json(name = "timeshiftWindowMin") val timeshiftWindowMin: Int = 0,
    @Json(name = "record") val record: Boolean = false
)

data class HeartbeatData(
    @Json(name = "status") val status: String,
    @Json(name = "serverTime") val serverTime: Long = 0L,
    @Json(name = "config") val config: PlayerConfig? = null,
    @Json(name = "features") val features: ServerFeatures? = null
)

/**
 * 播放线路
 */
@JsonClass(generateAdapter = true)
data class SourceUrl(
    @Json(name = "id") val id: Int,
    @Json(name = "url") val url: String,
    @Json(name = "height") val height: Int = 0,
    @Json(name = "userAgent") val userAgent: String = "",
    /**
     * 时移地址（服务端滚动 HLS 的 m3u8）。
     * 只有服务端开了时移、且这条线路不是组播源时才非空；
     * 为空表示这条线路不支持时移，客户端按普通直播处理。
     */
    @Json(name = "timeshiftUrl") val timeshiftUrl: String = ""
)

/**
 * 频道
 */
@JsonClass(generateAdapter = true)
data class Channel(
    @Json(name = "id") val id: Int,
    @Json(name = "name") val name: String,
    @Json(name = "logo") val logo: String? = null,
    @Json(name = "epgId") val epgId: String? = null,
    @Json(name = "urls") val urls: List<SourceUrl> = emptyList(),
    /** 服务端下发的：这个频道当前有没有在录像。只有它为 true 才给时移入口（进度条） */
    @Json(name = "hasRecording") val hasRecording: Boolean = false
)

/**
 * 频道分组
 */
@JsonClass(generateAdapter = true)
data class ChannelGroup(
    @Json(name = "id") val id: Int,
    @Json(name = "name") val name: String,
    @Json(name = "channels") val channels: List<Channel> = emptyList()
)

/**
 * 频道列表响应
 */
@JsonClass(generateAdapter = true)
data class ChannelListData(
    @Json(name = "groups") val groups: List<ChannelGroup> = emptyList()
)

/**
 * EPG 节目
 */
@JsonClass(generateAdapter = true)
data class Program(
    @Json(name = "title") val title: String,
    @Json(name = "start") val start: String,
    @Json(name = "end") val end: String,
    @Json(name = "hasRecord") val hasRecord: Boolean = false
)

/**
 * EPG 响应
 */
@JsonClass(generateAdapter = true)
data class EpgData(
    @Json(name = "programs") val programs: List<Program> = emptyList()
)

/**
 * 可回看日期列表。
 * 字段名必须与服务端一致：/api/client/catchup/days 返回的是 `{ days: [...] }`
 * （原先写成 `dates`，Moshi 会解析出空列表，一旦接线就会静默失效）。
 */
@JsonClass(generateAdapter = true)
data class CatchupDaysData(
    @Json(name = "days") val days: List<String> = emptyList()
)

/**
 * 回看片段
 */
@JsonClass(generateAdapter = true)
data class CatchupSegment(
    @Json(name = "id") val id: Int,
    @Json(name = "start") val start: String,
    @Json(name = "end") val end: String,
    @Json(name = "url") val url: String
)

/**
 * 回看片段列表
 */
@JsonClass(generateAdapter = true)
data class CatchupListData(
    @Json(name = "segments") val segments: List<CatchupSegment> = emptyList()
)

/**
 * 单个频道的正在播出节目（简报）
 */
@JsonClass(generateAdapter = true)
data class NowProgram(
    @Json(name = "title") val title: String,
    @Json(name = "start") val start: String = "",
    @Json(name = "end") val end: String = ""
)

/**
 * 全频道正在播出响应：key 为频道 id 的字符串形式
 */
@JsonClass(generateAdapter = true)
data class EpgNowData(
    @Json(name = "now") val now: Map<String, NowProgram> = emptyMap(),
    @Json(name = "next") val next: Map<String, NowProgram> = emptyMap()
)
