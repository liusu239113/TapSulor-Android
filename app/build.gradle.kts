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
        versionCode = 4
        versionName = "1.0.3"
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }
    buildFeatures {
        buildConfig = true
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 沙箱离线环境无法下载 lint-gradle，直接跳过 release lint
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
        // GeckoView 153 的传递依赖(androidx.collection/annotation 等新版)使用 Kotlin 2.1
        // 编译,metadata 版本为 2.1.0;本项目用 Kotlin 1.9.20 编译器,默认只读 ≤2.0.0。
        // 这些 androidx 工具类在 GeckoView 中只以 Java 字节码形式调用,不会用到任何 Kotlin
        // 2.1 语言特性,因此跳过 metadata 版本检查是安全的(不会产生运行时或语义差异)。
        freeCompilerArgs += "-Xskip-metadata-version-check"
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
    // 不同于 WebView,GeckoView 自带独立的站点隔离能力(Fission),可直接运行 SCE/UrhoX 多线程 WASM 游戏
    // 选用 153 版(2026-07)。实际 API 表面(已通过解包 arm64 AAR class 文件确认):
    //   - session.loadUri(String) / session.load(Loader)  (没有 load(String))
    //   - NavigationDelegate.onLocationChange(session, url, List<GeckoSession>?, Boolean?) — 4 个参数
    //   - NavigationDelegate.onNewSession 必须返回 GeckoResult<GeckoSession>;弹窗在当前 session 加载并 deny()
    //   - 通过 onCanGoBack(session, Boolean) 回调回退状态(没有 canGoBack():GeckoResult<Boolean>)
    //   - 文件选择:onFilePrompt 拿到 FilePrompt,confirm(Context, Uri[])/dismiss() 返回 PromptResponse
    //     (没有 FileCallback / PromptResponse.DISMISS 常量)
    //   - GeckoRuntimeSettings.Builder 控制调试开关(没有 GeckoView.isDebugMode)
    //   - StorageController 不暴露 cookieStore;Cookie 同步在本版放弃,用户首次需要在 GeckoView 内登录一次
    //   - 没有 evaluateJS / 脚本注入 API;如需注入 CSS/JS 需走 WebExtension(本版未启用)
    // 153 的传递依赖:
    //   androidx.core:1.18.0 → 声明 minCompileSdk>=36,本项目 compileSdk=34,强制到 1.13.1
    //   kotlin-stdlib:2.3.21 → metadata 2.3.0,本项目 kotlin-compiler 1.9.20 只能读 ≤2.0.0,强制到 1.9.24
    //   androidx.media3:*:1.10.1 → minCompileSdk>=36,强制到 1.3.1 (minCompileSdk=34,API 兼容)
    //   其它传递依赖 (annotation/collection/lifecycle) 为 KMP/JVM jar,无 minCompileSdk 约束
    implementation("org.mozilla.geckoview:geckoview-arm64-v8a:153.0.20260715202819")
}

configurations.configureEach {
    resolutionStrategy {
        // 强制 androidx.core 系列到 1.13.1,保持 compileSdk=34 兼容
        // GeckoView 仅使用 ContextCompat 等基础兼容类,不依赖 core 1.18 新 API
        force("androidx.core:core:1.13.1")
        force("androidx.core:core-ktx:1.13.1")
        // 强制 kotlin-stdlib 对齐 Kotlin 编译器 1.9.20,避免 GeckoView 153 拉来的 2.3.21 元数据冲突
        // (kotlin-compiler 1.9 只能读到 metadata 2.0.0,kotlin-stdlib 2.3 的 metadata 是 2.3.0)
        force("org.jetbrains.kotlin:kotlin-stdlib:1.9.24")
        force("org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.9.24")
        force("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.24")
        force("org.jetbrains.kotlin:kotlin-stdlib-common:1.9.24")
        // 强制 androidx.media3 全家桶到 1.3.1,避免 GeckoView 153 直接依赖的 1.10.1 (minCompileSdk=36) 与 compileSdk=34 冲突
        // 1.3.1 是最后一个 minCompileSdk=34 的版本,所有 GeckoView 用到的 API 在 1.3.1 都已存在
        force("androidx.media3:media3-common:1.3.1")
        force("androidx.media3:media3-datasource:1.3.1")
        force("androidx.media3:media3-decoder:1.3.1")
        force("androidx.media3:media3-exoplayer:1.3.1")
        force("androidx.media3:media3-exoplayer-hls:1.3.1")
        // media3-exoplayer:1.10.1 还会传递拉到 container/extractor/database,统一降到 1.3.1
        force("androidx.media3:media3-container:1.3.1")
        force("androidx.media3:media3-extractor:1.3.1")
        force("androidx.media3:media3-database:1.3.1")
    }
}
