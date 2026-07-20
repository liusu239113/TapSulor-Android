# Keep WebAppInterface methods accessible from JavaScript
-keepclassmembers class com.taptapgain.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
