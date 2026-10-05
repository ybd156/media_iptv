package com.mediaiptv.tv.net

import android.content.Context
import com.mediaiptv.tv.util.Prefs
import com.squareup.moshi.Moshi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * 通用 HTTP API 客户端：基于 OkHttp + Moshi 的轻量封装。
 * 自动附加 X-Device-Id 与 X-Token 头；baseUrl 由 SharedPreferences 提供。
 */
object ApiClient {

    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    /**
     * 所有 model 都标注了 @JsonClass(generateAdapter = true)，由 KSP 生成适配器，
     * 因此不再注册 KotlinJsonAdapterFactory（反射路径）。这样既省掉 moshi-kotlin
     * 与 kotlin-reflect（约 2MB+），也少一个 R8 需要保留元数据的易碎点。
     */
    val moshi: Moshi = Moshi.Builder().build()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    /** 直播流使用的独立 OkHttpClient（更长读超时） */
    val streamClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    /**
     * 下载安装包专用的 OkHttpClient。
     * 默认的 15 秒读超时是「两个数据块之间」的超时：几十 MB 的 APK 在弱网/慢盘上
     * 很容易中途卡住超过 15 秒而被误判失败，所以这里放宽到 60 秒，并且不做整体超时
     * （OkHttp 本身没有整体超时，靠 readTimeout 兜底）。
     */
    val downloadClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    private fun baseUrl(context: Context): String = Prefs.getServerUrl(context)

    private fun buildRequest(context: Context, path: String, method: String = "GET", body: String? = null): Request {
        val url = "${baseUrl(context)}$path"
        val builder = Request.Builder()
            .url(url)
            .header("X-Device-Id", Prefs.getDeviceId(context))
            .header("X-Token", Prefs.getToken(context))
            .header("Accept", "application/json")

        when (method) {
            "POST" -> builder.post((body ?: "{}").toRequestBody(JSON_MEDIA))
            "GET" -> builder.get()
        }
        return builder.build()
    }

    /**
     * 执行 GET 请求并返回原始 JSON 字符串；网络/解析异常直接抛出，由调用方捕获
     */
    suspend fun get(context: Context, path: String): String = withContext(Dispatchers.IO) {
        client.newCall(buildRequest(context, path, "GET")).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful && body.isEmpty()) {
                throw ApiException(resp.code, "HTTP ${resp.code}")
            }
            body
        }
    }

    /**
     * 执行 POST JSON 请求
     */
    suspend fun post(context: Context, path: String, jsonBody: String): String = withContext(Dispatchers.IO) {
        client.newCall(buildRequest(context, path, "POST", jsonBody)).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful && body.isEmpty()) {
                throw ApiException(resp.code, "HTTP ${resp.code}")
            }
            body
        }
    }
}

/** API 异常：附带 HTTP code 或业务 code */
class ApiException(val code: Int, message: String) : Exception(message)
