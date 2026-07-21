package com.taptapgain

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.google.android.material.bottomnavigation.BottomNavigationView
import okhttp3.Request
import java.io.ByteArrayInputStream

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var webAppInterface: WebAppInterface
    private lateinit var accountManager: AccountManager
    private lateinit var apiClient: TapTapApiClient
    private lateinit var updateChecker: UpdateChecker
    private lateinit var bottomNav: BottomNavigationView
    private lateinit var tabContainer: FrameLayout
    private lateinit var bottomDivider: View

    // 当前选中的 tab id
    private var currentTabId: Int = R.id.nav_home
    // 冷启动开屏阶段底栏是否已经显示（避免 onPageFinished 多次触发重复显示）
    private var bottomNavShown = false

    // Fragment 缓存（避免每次切换都重建 WebView）
    private var makerFragment: MakerWebFragment? = null
    private var communityFragment: CommunityFragment? = null
    // 防止 setOnItemSelectedListener 与 switchToTab 互相递归
    private var isSwitchingTab = false

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
        // 冷启动开屏阶段底部导航延迟显示时间:等主页 webapp 开屏动画播完再露出 Tab 栏
        private const val BOTTOM_NAV_SHOW_DELAY_MS = 1500L
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

        setContentView(R.layout.activity_main)
        tabContainer = findViewById(R.id.tab_container)
        bottomNav = findViewById(R.id.bottom_nav)
        bottomDivider = findViewById(R.id.bottom_divider)

        // 1) 创建主页 WebView（原有逻辑），直接放进 tab_container
        webView = WebView(this).apply outer@{
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
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
                    val assetResp = assetLoader.shouldInterceptRequest(request.url)
                    if (assetResp != null) return assetResp
                    if (isImageRequest(url, request)) {
                        return fetchImageViaOkHttp(url)
                    }
                    return null
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    // 冷启动时主页 index.html 加载完成后,等待 webapp 自身开屏动画结束,
                    // 再显示底部导航栏,避免在开屏画面上露出 Tab 条(符合用户反馈要求)
                    if (!bottomNavShown) {
                        bottomNavShown = true
                        mainHandler.postDelayed({
                            bottomDivider.visibility = View.VISIBLE
                            bottomNav.visibility = View.VISIBLE
                        }, BOTTOM_NAV_SHOW_DELAY_MS)
                    }
                }
            }
            webChromeClient = WebChromeClient()
        }
        tabContainer.addView(webView)

        webAppInterface = WebAppInterface(this, webView, accountManager, apiClient, updateChecker)
        webAppInterface.register()
        accountManager.restoreCurrentCookies {
            webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        }

        // 2) 底部导航切换
        bottomNav.setOnItemSelectedListener { item ->
            if (!isSwitchingTab) switchToTabInternal(item.itemId)
            true
        }
        // 默认主页（webView 已经在 tab_container 里，无需额外处理）

        // 冷启动后延迟 3 秒静默检查更新
        mainHandler.postDelayed({ updateChecker.check(silent = true) }, 3000)
    }

    /** 供外部（如 MakerWebFragment 关闭按钮）调用的公共切换方法：同步底部导航选中态。 */
    fun switchToTab(tabId: Int) {
        if (tabId == currentTabId) return
        isSwitchingTab = true
        bottomNav.selectedItemId = tabId
        isSwitchingTab = false
        switchToTabInternal(tabId)
    }

    /** 内部真正的 Tab 切换逻辑（不触发导航选中回调）。 */
    private fun switchToTabInternal(tabId: Int) {
        if (tabId == currentTabId) return

        val ft = supportFragmentManager.beginTransaction()
        // 隐藏所有 Fragment
        listOfNotNull(makerFragment, communityFragment).forEach { ft.hide(it) }

        when (tabId) {
            R.id.nav_home -> {
                webView.visibility = View.VISIBLE
            }
            R.id.nav_maker -> {
                webView.visibility = View.GONE
                val existing = makerFragment
                if (existing == null) {
                    val f = MakerWebFragment()
                    makerFragment = f
                    ft.add(R.id.tab_container, f, "maker")
                } else {
                    ft.show(existing)
                }
            }
            R.id.nav_community -> {
                webView.visibility = View.GONE
                val existing = communityFragment
                if (existing == null) {
                    val f = CommunityFragment()
                    communityFragment = f
                    ft.add(R.id.tab_container, f, "community")
                } else {
                    ft.show(existing)
                }
            }
        }
        currentTabId = tabId
        ft.commitAllowingStateLoss()
    }

    @Deprecated("Use registerForActivityResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        // 登录回调
        if (requestCode == LoginActivity.REQUEST_CODE_LOGIN && resultCode == RESULT_OK) {
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
            return
        }
        // 转发给 MakerWebFragment 的文件选择
        makerFragment?.onActivityResult(requestCode, resultCode, data)
    }

    override fun onBackPressed() {
        // 当前在制造 Tab：先让 maker WebView 后退，不能后退则回主页
        if (currentTabId == R.id.nav_maker) {
            val maker = makerFragment
            if (maker != null && maker.canGoBack()) {
                maker.goBack()
                return
            }
            switchToTab(R.id.nav_home)
            return
        }
        // 非主页 Tab：直接回主页
        if (currentTabId != R.id.nav_home) {
            switchToTab(R.id.nav_home)
            return
        }
        // 主页：原逻辑
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        mainHandler.removeCallbacks(backgroundRefreshRunnable)
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
        mainHandler.removeCallbacks(backgroundRefreshRunnable)
        mainHandler.postDelayed(backgroundRefreshRunnable, BACKGROUND_REFRESH_INTERVAL_MS)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(backgroundRefreshRunnable)
        updateChecker.destroy()
        webAppInterface.destroy()
        makerFragment?.destroyWebView()
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    private fun isImageRequest(url: String, request: WebResourceRequest): Boolean {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false
        val accept = request.requestHeaders["Accept"] ?: ""
        if (accept.contains("image/")) return true
        val path = request.url.path ?: return false
        return imageExtensions.any { path.endsWith(it, ignoreCase = true) }
    }

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
