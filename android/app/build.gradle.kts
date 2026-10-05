plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

/**
 * 版本号单一来源：fpk/package/manifest。
 * 打包脚本（build.sh / build.ps1）也读同一个文件，避免 APK 与 FPK 各报一个版本号
 * （此前 Android 是 1.2.3、FPK manifest 是 1.2.4、server/package.json 是 1.0.0）。
 *
 * 读不到就**直接让构建失败**，不再静默退回 "1.0.0"：
 * 路径是相对 rootProject 的 ../fpk/package/manifest，一旦换了目录布局（例如只把
 * android/ 单独拷出去构建），旧写法会安静地打出 versionName=1.0.0 的 APK ——
 * 构建成功、装到机器上才发现版本号是错的。这种错误必须在构建期就炸出来。
 */
val manifestVersion: String = run {
    val f = rootProject.file("../fpk/package/manifest")
    if (!f.exists()) {
        throw GradleException(
            "找不到版本号来源 fpk/package/manifest（期望位置：${f.absolutePath}）。" +
                "versionName 以它为单一来源；请在仓库根目录下的 android/ 里构建，或把该文件放到上述位置。"
        )
    }
    val m = Regex("(?m)^version\\s*=\\s*(\\S+)").find(f.readText())
        ?: throw GradleException("fpk/package/manifest 里没有 version 字段：${f.absolutePath}")
    m.groupValues[1].trim()
}

/**
 * release 签名密钥的解析结果，找不到就是 null（构建出未签名 APK 并打日志提示）。
 *   1) ~/.gradle/gradle.properties 里显式配的 RELEASE_STORE_FILE（正式发布走这条）
 *   2) 仓库内的自签密钥 android/release.jks（自用/侧载兜底，密码在 android/gradle.properties）
 */
val releaseStore: java.io.File? = run {
    val configured = providers.gradleProperty("RELEASE_STORE_FILE").orNull
    if (!configured.isNullOrBlank()) {
        file(configured).takeIf { it.exists() }
    } else {
        rootProject.file("release.jks").takeIf { it.exists() }
    }
}

android {
    namespace = "com.mediaiptv.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mediaiptv.tv"
        minSdk = 21
        targetSdk = 34
        // versionCode 需要单调递增，这里手工维护；versionName 取自 fpk manifest
        // 1.11.9 -> 65（时移：步进按窗口比例、修"重新进入时移"重启风暴、录像探针误判）
        // 1.11.10 -> 66（性能：录像按关键帧切成 10 秒字节范围小块；回看节目表正序；
        //                回看左右键直接拖进度条；点节目从节目起点播）
        // 1.11.11 -> 67（整片→切片粒度可以中途升级，不再卡在整片；seek 后不判卡死；
        //                回看进度条那行显示录像本身的时刻）
        // 1.11.12 -> 68（回看那行的"落后直播"按绝对时间算；OSD 节目名也按录像内容匹配）
        // 1.11.13 -> 69（暂停/播放画面正中闪图标；服务端：切片列表里不再混"整片"条目）
        // 1.11.14 -> 70（时移流不再贴直播边缘播：进时移/播到边缘不再等下一个关键帧）
        // 1.11.15 -> 71（秒播：进频道后预热时移窗口；回看/时移切换不再淡出黑屏；
        //                时移建窗重试 1.5s→0.6s；服务端录像分片写完 10 秒即预热切片索引）
        // 1.11.16 -> 72（客户端功能与 1.11.15 相同，只是跟随服务端版本号：
        //                服务端新增「从 GitHub Release 读版本并下发」的更新渠道）
        versionCode = 72
        versionName = manifestVersion

        ndk {
            abiFilters += listOf("armeabi-v7a", "arm64-v8a")
        }

        // 只保留中英文：res/ 下本来就只有 values（无 values-xx），
        // AndroidX/Media3 的几十种语言资源纯属死重量
        resourceConfigurations += listOf("zh", "en")
    }

    /**
     * 发布签名。
     * 原先完全没有 signingConfigs，release 产物是 app-release-unsigned.apk —— 无法安装、
     * 无法上架。密钥信息从 ~/.gradle/gradle.properties 读取，绝不写进仓库
     * （仓库此前连 .gitignore 都没有）。
     *
     * 在 ~/.gradle/gradle.properties 里配置（正式发布用这个）：
     *   RELEASE_STORE_FILE=/abs/path/release.jks
     *   RELEASE_STORE_PASSWORD=...
     *   RELEASE_KEY_ALIAS=...
     *   RELEASE_KEY_PASSWORD=...
     *
     * 没配就退回仓库内的自签密钥 android/release.jks（密码在 android/gradle.properties）。
     * 那是给自用/侧载用的：未签名的 APK 在 Android 上根本装不上，而自动更新功能
     * 必须能装上才有意义。要正式发布请换成你自己的密钥——注意换密钥后签名不同，
     * 已装的客户端无法覆盖升级，需要先卸载。
     */
    signingConfigs {
        create("release") {
            if (releaseStore != null) {
                storeFile = releaseStore
                storePassword = providers.gradleProperty("RELEASE_STORE_PASSWORD").orNull
                keyAlias = providers.gradleProperty("RELEASE_KEY_ALIAS").orNull
                keyPassword = providers.gradleProperty("RELEASE_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // 找不到密钥时保持未签名（并给出提示），找到就自动签名
            if (releaseStore != null) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.lifecycle(
                    "[MediaIptv] 未找到 release 密钥（RELEASE_STORE_FILE 或 android/release.jks），" +
                        "release APK 将保持未签名 —— 未签名 APK 装不上。"
                )
            }
        }
        debug {
            // 让 debug 与 release 可以同时安装
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    /**
     * 不按 ABI 拆分，只出一个通用 APK。
     *
     * 原先开了 abi splits，一次构建出 3 个包（arm64-v8a / armeabi-v7a / universal），
     * 加上 debug 变体一共 6 个文件；实际侧载时永远只用 universal 那一个，
     * 另外几个只是让发布目录变得难以分辨（还出过「旧包的标签贴到新版本上」的事故）。
     * 代价是包体大一些（两个 ABI 的原生库合计约 36.7MB，单机只用得到一半），
     * 换来的是「只有一个包、不会发错」。
     */
    // 不再声明 splits{}

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Kotlin
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")

    // AndroidX core
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // 频道/分组/节目单列表（原先由 leanback 传递引入，现显式声明）
    implementation("androidx.recyclerview:recyclerview:1.3.2")

    // Lifecycle（仅使用 lifecycleScope）
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")

    // Media3 (ExoPlayer) — 升级到 1.6.1 以匹配 Jellyfin FFmpeg 扩展版本
    implementation("androidx.media3:media3-exoplayer:1.6.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.6.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.6.1")
    implementation("androidx.media3:media3-ui:1.6.1")

    // 单元测试：给纯 JVM 可测的逻辑（Av3aReader 的时间戳推算等）补真实断言
    testImplementation("junit:junit:4.13.2")
    // Jellyfin 预编译 FFmpeg 扩展：软解 AC3/E-AC3/DTS 等平台不支持音轨（解决 AVS1 无声）
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:1.6.1+2")

    // Network
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // JSON：只用 codegen 适配器（所有 model 都标了 @JsonClass(generateAdapter = true)），
    // 不再引入 moshi-kotlin 反射工厂，省掉 kotlin-reflect 并少一个 R8 易碎点
    implementation("com.squareup.moshi:moshi:1.15.1")
    ksp("com.squareup.moshi:moshi-kotlin-codegen:1.15.1")

    // Image loading
    implementation("com.github.bumptech.glide:glide:4.16.0")
}
