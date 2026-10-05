// AGP 8.6.1 是首个正式支持 compileSdk 35 的版本，且最低要求 Gradle 8.7 —— 与本项目
// 现有的 wrapper 版本一致，因此无需更换 Gradle 发行版即可消除
// "We recommend using a newer Android Gradle plugin to use compileSdk = 35" 警告。
// Kotlin / KSP 保持 1.9.24 不变，避免引入 K2 编译器带来的额外变量。
plugins {
    id("com.android.application") version "8.6.1" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    id("com.google.devtools.ksp") version "1.9.24-1.0.20" apply false
}
