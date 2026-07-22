plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.taptapgain"
    compileSdk = 34

    signingConfigs {
        create("release") {
            storeFile = file("../keystore/tapsulor-release.jks")
            storePassword = "tapsulor2024"
            keyAlias = "tapsulor"
            keyPassword = "tapsulor2024"
        }
    }

    // GeckoView 只提供 arm64-v8a 单架构变体,过滤 ABI 减少 APK 体积
    // (绝大多数现代 Android 设备(含小米)都是 arm64-v8a;Android 12+ 新设备强制 arm64)
    defaultConfig {
        applicationId = "com.taptapgain"
        minSdk = 26
        targetSdk = 34
        versionCode = 3
        versionName = "1.0.2"
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }
    buildFeatures {
        buildConfig = true
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 沙箱离线环境无法下载 lint-gradle，直接跳过 release lint
            isShrinkResources = false
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.fragment:fragment-ktx:1.6.2")
    implementation("androidx.webkit:webkit:1.9.0")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.activity:activity-ktx:1.8.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("com.google.code.gson:gson:2.10.1")
    implementation("androidx.browser:browser:1.8.0")
    // GeckoView(Firefox 内核) — 真正内嵌在 App 内的浏览器组件,支持 SharedArrayBuffer/WASM 多线程
    // 不同于 WebView,GeckoView 自带独立的站点隔离能力,可直接运行 SCE/UrhoX 多线程 WASM 游戏
    implementation("org.mozilla.geckoview:geckoview-arm64-v8a:153.0.20260715202819")
}
