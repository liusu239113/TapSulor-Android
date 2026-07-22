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
    // 143 版(2025-10)的 API 已是现代形态(load(Loader)/evaluateJS/isDebugMode/cookieStore/GeckoResult<Boolean> canGoBack)
    // 其传递依赖 androidx.core:1.16.0 声明 minCompileSdk=35;本项目 compileSdk=34,通过 resolutionStrategy
    // 将 core 强制回退到 1.13.1(GeckoView 仅使用 ContextCompat 等基础兼容类,不依赖 core 1.16 新 API)
    implementation("org.mozilla.geckoview:geckoview-arm64-v8a:143.0.20251003115653")
}

configurations.configureEach {
    resolutionStrategy {
        // 强制 androidx.core 系列到 1.13.1,保持 compileSdk=34 兼容
        // GeckoView 仅使用 ContextCompat 等基础兼容类,不依赖 core 1.16 新 API
        force("androidx.core:core:1.13.1")
        force("androidx.core:core-ktx:1.13.1")
        // 强制 kotlin-stdlib 对齐 Kotlin 编译器 1.9.20,避免 GeckoView 143 拉来的 2.2.10 元数据冲突
        // (kotlin-compiler 1.9 只能读到 metadata 2.0.0,kotlin-stdlib 2.2 的 metadata 是 2.2.0)
        force("org.jetbrains.kotlin:kotlin-stdlib:1.9.24")
        force("org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.9.24")
        force("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.24")
        force("org.jetbrains.kotlin:kotlin-stdlib-common:1.9.24")
    }
}
