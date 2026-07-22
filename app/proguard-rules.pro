# === GeckoView(Firefox 内核) ===
# GeckoView 大量使用反射 + LambdaMetaFactory 回调 delegate 接口,
# 且内部 JNI 会按名字查找 Java 类/方法。全量保留 org.mozilla.geckoview 包。
-keep class org.mozilla.geckoview.** { *; }
-keep interface org.mozilla.geckoview.** { *; }
-keep class org.mozilla.gecko.** { *; }
-keep interface org.mozilla.gecko.** { *; }
-dontwarn org.mozilla.geckoview.**
-dontwarn org.mozilla.gecko.**
# GeckoView 自带的 omni.ja/原生 so 里引用了 org.chromium 等可选类
-dontwarn org.chromium.**
-dontwarn com.google.android.gms.**

# === JS 桥接(WebAppInterface 暴露给 WebView 的 @JavascriptInterface 方法必须保留原名) ===
-keepclassmembers class com.taptapgain.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# === Kotlin / 协程 ===
-dontwarn kotlin.**
-keep class kotlin.Metadata { *; }
-keepclassmembers class kotlin.Metadata {
    public <methods>;
}

# === OkHttp ===
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }
-keep class okio.** { *; }

# === Gson(反射序列化字段) ===
-keepattributes Signature
-keepattributes *Annotation*
-dontwarn sun.misc.**
-keep class com.google.gson.** { *; }
-keep class * extends com.google.gson.TypeAdapter
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer
-keepclassmembers,allowobfuscation class * {
  @com.google.gson.annotations.SerializedName <fields>;
}

# === AndroidX / Material ===
-keep class androidx.** { *; }
-keep interface androidx.** { *; }
-dontwarn androidx.**
-keep class com.google.android.material.** { *; }

# === WebView / Chrome(WebViewClient / WebChromeClient 回调名不能混淆) ===
-keep class android.webkit.** { *; }
-keepclassmembers class * extends android.webkit.WebViewClient { *; }
-keepclassmembers class * extends android.webkit.WebChromeClient { *; }

# === 通用 ===
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
