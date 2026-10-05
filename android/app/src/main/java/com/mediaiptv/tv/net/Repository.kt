package com.mediaiptv.tv.net

import android.content.Context
import android.os.Build
import com.mediaiptv.tv.model.*
import com.squareup.moshi.Types
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * API 仓库层：封装所有 /api/client/ 系列接口的业务语义。
 *
 * 业务返回统一 [Result]；业务 code=0 时 [Result.data] 非空。
 *
 * 注意：HTTP 由 [ApiClient] 在 IO 线程执行，但 Moshi 解码原先是在调用方上下文
 * （通常是 Dispatchers.Main）里做的。`/api/client/channels` 是全 App 最大的响应体
 * （所有分组 + 所有频道 + 所有线路），在主线程解码会掉帧甚至 ANR。
 * 因此这里统一通过 [parse] 把解码放到 Dispatchers.Default。
 */
class Repository(private val context: Context) {

    private val moshi = ApiClient.moshi

    /** 在后台线程解析 `{code,msg,data}` 包装体 */
    private suspend fun <T> parse(json: String, dataClass: Class<T>): ApiResponse<T>? =
        withContext(Dispatchers.Default) {
            val type = Types.newParameterizedType(ApiResponse::class.java, dataClass)
            moshi.adapter<ApiResponse<T>>(type).fromJson(json)
        }

    private fun <T> toResult(resp: ApiResponse<T>?): Result<T> =
        if (resp == null) Result.Error(-1, "解析失败")
        else if (resp.data != null) Result.Ok(resp.code, resp.msg, resp.data)
        else Result.Error(resp.code, resp.msg)

    // -------- 1. 设备注册 --------
    /**
     * @return 服务端返回的注册数据；调用方应检查 isApproved 决定后续流程
     */
    suspend fun register(): Result<RegisterData> {
        val deviceId = com.mediaiptv.tv.util.Prefs.getDeviceId(context)
        val body = RegisterRequest(
            deviceId = deviceId,
            model = "${Build.MANUFACTURER} ${Build.MODEL}",
            androidVersion = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
        )
        val reqAdapter = moshi.adapter(RegisterRequest::class.java)
        val json = ApiClient.post(context, "/api/client/register", reqAdapter.toJson(body))
        return toResult(parse(json, RegisterData::class.java))
    }

    // -------- 2. 心跳 --------
    suspend fun heartbeat(): Result<HeartbeatData> {
        val json = ApiClient.get(context, "/api/client/heartbeat")
        return toResult(parse(json, HeartbeatData::class.java))
    }

    // -------- 3. 频道列表 --------
    suspend fun channels(): Result<ChannelListData> {
        val json = ApiClient.get(context, "/api/client/channels")
        return toResult(parse(json, ChannelListData::class.java))
    }

    // -------- 4. 单频道 EPG --------
    suspend fun epg(channelId: Int, date: String): Result<EpgData> {
        val json = ApiClient.get(context, "/api/client/epg?channelId=$channelId&date=$date")
        return toResult(parse(json, EpgData::class.java))
    }

    // -------- 4b. 全频道正在播出 --------
    suspend fun epgNow(): Result<EpgNowData> {
        val json = ApiClient.get(context, "/api/client/epg/now")
        return toResult(parse(json, EpgNowData::class.java))
    }

    // -------- 5. 回看可用日期 --------
    suspend fun catchupDays(channelId: Int): Result<CatchupDaysData> {
        val json = ApiClient.get(context, "/api/client/catchup/days?channelId=$channelId")
        return toResult(parse(json, CatchupDaysData::class.java))
    }

    // -------- 6. 回看片段列表 --------
    suspend fun catchupList(channelId: Int, date: String): Result<CatchupListData> {
        val json = ApiClient.get(context, "/api/client/catchup/list?channelId=$channelId&date=$date")
        return toResult(parse(json, CatchupListData::class.java))
    }

    // -------- 7. 上报实际播放分辨率（帮助服务端快速收集画质数据） --------
    suspend fun reportResolution(urlId: Int, width: Int, height: Int) {
        try {
            ApiClient.post(context, "/api/client/report-resolution",
                """{"urlId":$urlId,"width":$width,"height":$height}""")
        } catch (_: Exception) { /* 静默失败，不影响播放 */ }
    }
}

/**
 * 简单 Result 封装：包含业务 code
 */
sealed class Result<out T> {
    abstract val code: Int
    abstract val msg: String

    data class Ok<T>(override val code: Int, override val msg: String, val data: T) : Result<T>()
    data class Error(override val code: Int, override val msg: String) : Result<Nothing>()

    val isOk: Boolean get() = this is Ok
    fun dataOrNull(): T? = (this as? Ok)?.data
}
