package com.taptapgain

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import okhttp3.Request
import java.io.ByteArrayInputStream

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var webAppInterface: WebAppInterface
    private lateinit var accountManager: AccountManager
    private lateinit var apiClient: TapTapApiClient
    private lateinit var updateChecker: UpdateChecker

    // 后台定时刷新：onPause 启动，每 5 分钟触发一次轻量刷新（绕过 Chromium 后台节流）
    private val mainHandler = Handler(Looper.getMainLooper())
    private var hasResumedOnce = false
    private val backgroundRefreshRunnable = object : Runnable {
        override fun run() {
            try {
                webView.evaluateJavascript(
                    "if(window.__onAppBackgroundTick)window.__onAppBackgroundTick();",
                    null
                )
            } catch (_: Exception) {}
            mainHandler.postDelayed(this, BACKGROUND_REFRESH_INTERVAL_MS)
        }
    }

    companion object {
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        private const val TAPTAP_REFERER = "https://developer.taptap.cn/"
        private const val BACKGROUND_REFRESH_INTERVAL_MS = 5L * 60L * 1000L  // 5 分钟
        private val imageExtensions = arrayOf(
            ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".ico", ".bmp"
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableImmersiveMode()
        accountManager = AccountManager(this)
        apiClient = TapTapApiClient(accountManager)
        updateChecker = UpdateChecker(this)
        webView = WebView(this).apply outer@{
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
                allowFileAccess = true
                cacheMode = WebSettings.LOAD_DEFAULT
                userAgentString = settings.userAgentString.replace("; wv", "")
                // 允许 http/https 混合内容，避免 CDN 偶发返回 http 链接时被 WebView 拦截
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this@outer, true)

            val assetLoader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
                .build()

            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val url = request.url.toString()
                    // 本地 assets 交给默认 loader
                    val assetResp = assetLoader.shouldInterceptRequest(request.url)
                    if (assetResp != null) return assetResp
                    // 仅代理 CDN 图片请求，绕过 Referer 防盗链（WebView 从 appassets.androidplatform.net 发起，
                    // Referer 不是 taptap.cn，CDN 会返回 403；改用 OkHttp 带桌面 UA + TapTap Referer 拉取）
                    if (isImageRequest(url, request)) {
                        return fetchImageViaOkHttp(url)
                    }
                    return null
                }
            }
            webChromeClient = WebChromeClient()
        }

        setContentView(webView)
        webAppInterface = WebAppInterface(this, webView, accountManager, apiClient, updateChecker)
        webAppInterface.register()
        accountManager.restoreCurrentCookies {
            webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        }
        // 冷启动后延迟 3 秒静默检查更新（不打扰用户，只在发现新版本时弹窗）
        mainHandler.postDelayed({ updateChecker.check(silent = true) }, 3000)
    }

    @Deprecated("Use registerForActivityResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != LoginActivity.REQUEST_CODE_LOGIN || resultCode != RESULT_OK) return

        val developerId = data?.getStringExtra(LoginActivity.EXTRA_DEVELOPER_ID)
        val addMode = data?.getBooleanExtra(LoginActivity.EXTRA_LOGIN_MODE_ADD, false) ?: false
        if (!developerId.isNullOrBlank()) {
            val update = accountManager.setDeveloperId(developerId, addMode)
            accountManager.captureCurrentSessionCookies()
            webAppInterface.notifyAccountUpdated(update)
        }
        webAppInterface.notifyLoginSuccess()
        webView.postDelayed({
            webView.evaluateJavascript(
                "if(window.electronAPI&&window.electronAPI.checkLogin)window.electronAPI.checkLogin()",
                null
            )
        }, 500)
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        // 取消后台定时 tick，避免与前台刷新竞争
        mainHandler.removeCallbacks(backgroundRefreshRunnable)
        // 首次进入（冷启动）由 JS splash/init 流程自刷一次；之后每次回前台都强制刷一次
        if (hasResumedOnce) {
            try {
                webView.evaluateJavascript(
                    "if(window.__onAppResume)window.__onAppResume();",
                    null
                )
            } catch (_: Exception) {}
        } else {
            hasResumedOnce = true
        }
    }

    override fun onPause() {
        super.onPause()
        // 退到后台：启动 5 分钟节拍器，轻量刷新数据
        mainHandler.removeCallbacks(backgroundRefreshRunnable)
        mainHandler.postDelayed(backgroundRefreshRunnable, BACKGROUND_REFRESH_INTERVAL_MS)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(backgroundRefreshRunnable)
        updateChecker.destroy()
        webAppInterface.destroy()
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    /** 判断某个请求是不是需要代理的图片请求。 */
    private fun isImageRequest(url: String, request: WebResourceRequest): Boolean {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false
        val accept = request.requestHeaders["Accept"] ?: ""
        if (accept.contains("image/")) return true
        val path = request.url.path ?: return false
        return imageExtensions.any { path.endsWith(it, ignoreCase = true) }
    }

    /** 用 OkHttp 带桌面 UA + TapTap Referer + 当前账号 Cookie 拉取图片，返回 WebResourceResponse。 */
    private fun fetchImageViaOkHttp(url: String): WebResourceResponse? {
        return try {
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", DESKTOP_UA)
                .header("Referer", TAPTAP_REFERER)
                .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
                .build()
            apiClient.httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body ?: return null
                val bytes = body.bytes()
                val mime = resp.header("Content-Type")?.substringBefore(';')?.trim()
                    ?: guessMime(url)
                val inputStream = ByteArrayInputStream(bytes)
                WebResourceResponse(mime, "UTF-8", inputStream)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun guessMime(url: String): String {
        return when {
            url.endsWith(".png", ignoreCase = true) -> "image/png"
            url.endsWith(".jpg", ignoreCase = true) || url.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg"
            url.endsWith(".webp", ignoreCase = true) -> "image/webp"
            url.endsWith(".gif", ignoreCase = true) -> "image/gif"
            url.endsWith(".svg", ignoreCase = true) -> "image/svg+xml"
            url.endsWith(".avif", ignoreCase = true) -> "image/avif"
            url.endsWith(".ico", ignoreCase = true) -> "image/x-icon"
            else -> "image/*"
        }
    }
}
