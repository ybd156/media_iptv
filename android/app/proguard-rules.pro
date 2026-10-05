# ============================ Moshi ============================
# 为什么这条 keep 是「承重」的，不能删：
# 所有 model 都用 @JsonClass(generateAdapter = true)，Moshi 在运行时是通过
# Types.generatedJsonAdapterName(type) 拼出适配器类名再用 Class.forName 反射加载的
# （例如 com.mediaiptv.tv.model.ApiResponseJsonAdapter）。生成出来的 *JsonAdapter 与
# model 同包，所以这条规则同时也保住了适配器类本身；一旦删掉，R8 会把只被
# 「按名字引用」的适配器裁掉，release 包会在解析 JSON 时崩溃。
-keep class com.mediaiptv.tv.model.** { *; }
-keepnames @com.squareup.moshi.JsonClass class *
-keepclassmembers class * {
    @com.squareup.moshi.FromJson <methods>;
    @com.squareup.moshi.ToJson <methods>;
}
-keepclasseswithmembers class * {
    @com.squareup.moshi.* <methods>;
}

# ============================ OkHttp ============================
-dontwarn okhttp3.**
-dontwarn okio.**

# ============================ Media3 / ExoPlayer ============================
# 这里原先有一条 `-keep class androidx.media3.** { *; }`，把整个 Media3（含仅通过反射
# 访问的内部类）全部保留，基本抵消了 build.gradle.kts 里刚打开的 isMinifyEnabled /
# isShrinkResources。
#
# 已确认可以删除：Media3 各模块自带 consumer ProGuard 规则（AAR 内的 proguard.txt），
# 且覆盖了全部反射路径，包括 DefaultRenderersFactory 通过反射构造扩展渲染器
# （FfmpegAudioRenderer / LibvpxVideoRenderer / LibopusAudioRenderer …）以及
# DefaultMediaSourceFactory 的 HlsMediaSource$Factory 等。Jellyfin 的 FFmpeg 扩展
# 解码器正是靠这条路径被实例化的，consumer 规则里已显式保留其构造函数。
-dontwarn androidx.media3.**

# ============================ Kotlin ============================
# 原先有一条 `-keep class kotlin.** { *; }`，把整个 Kotlin 标准库连同成员名都保留下来。
# 标准库是被直接调用的，不需要反射保留；唯一需要 kotlin-reflect 的
# KotlinJsonAdapterFactory 已在本次改动中移除（所有 model 都走 codegen）。
# 因此这里不再保留 kotlin.**，让 R8 正常裁剪。
-dontwarn kotlin.**

# ============================ ijkplayer AV3A 兼容引擎 ============================
# native 通过 JNI 回调以下 Java 类/方法，关闭混淆与裁剪，否则 release(minify) 构建会在
# 运行时崩溃。这些类是 vendored 源码（android/app/src/main/java/tv/danmaku、com/wangsu、
# com/aliyun），不是 AAR 依赖，所以必须显式保留。
-keep class tv.danmaku.ijk.media.player.** { *; }
-keep class com.wangsu.** { *; }
-keep class com.aliyun.rts.** { *; }
-dontwarn tv.danmaku.ijk.media.player.**
-dontwarn com.wangsu.**
-dontwarn com.aliyun.rts.**
