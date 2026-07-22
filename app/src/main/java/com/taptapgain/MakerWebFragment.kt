package com.taptapgain

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment

/**
 * Tap 制造(Maker)页 Fragment。
 *
 * 使用系统 WebView(Chromium 内核)渲染,与开发者后台(BackendWebViewActivity)保持完全一致:
 *  - 真实 Chromium 内核 → TapTap 登录页可以做完整的特性检测,给出扫码 / 原生 QQ/微信拉起的完整面板,
 *    不会像 GeckoView 那样被降级到"仅手机号"简化面板。
 *  - Cookie 走 Android 全局 CookieManager,与 AccountManager 的 restore/import 天然打通,登录态直接复用。
 *  - 渲染进程挂在 App 主进程相关进程组内,后台不易被系统杀死;即使被杀也会自动重载空白页,不会出现 GeckoView
 *    那种 onKill 后需要手动重建 session 的黑屏。
 *  - window.open / 文件选择 / intent:// 等全部按 Chromium 标准路径处理,QQ/微信拉起一致。
 *
 * 关于 SharedArrayBuffer / WASM 多线程:
 *  - Android 系统 WebView 自 Chrome 97 起已在 Android 10+ 上默认启用站点隔离(Site Isolation),
 *    只要目标站点(maker.taptap.cn)返回正确的 COOP/COEP 头,window.crossOriginIsolated 即为 true,
 *    SharedArrayBuffer 与 WASM 多线程均可用,这与桌面 Chrome / Chrome Android 的行为一致。
 */
class MakerWebFragment : Fragment() {

    private var webView: WebView? = null
    private lateinit var titleText: TextView
    private var backBtn: TextView? = null
    private var refreshBtn: TextView? = null
    private var closeBtn: TextView? = null

    private var canGoBackState: Boolean = false
    private var currentUrl: String? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val ctx = requireContext()
        val act = requireActivity()

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(ContextCompat.getColor(ctx, R.color.bg_page))
        }

        // === Top bar ===
        val topBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setBackgroundColor(ContextCompat.getColor(ctx, R.color.bg_top_bar))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48)
            )
        }

        backBtn = TextView(ctx).apply {
            text = "←"
            setTextColor(ContextCompat.getColor(ctx, R.color.color_primary))
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "返回"
            isClickable = true
            isEnabled = false
            alpha = 0.4f
            setOnClickListener {
                val wv = webView ?: return@setOnClickListener
                if (wv.canGoBack()) wv.goBack()
            }
        }

        titleText = TextView(ctx).apply {
            text = "Tap制造"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_primary))
            textSize = 16f
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                marginStart = dp(8)
            }
            setSingleLine()
            maxLines = 1
        }

        refreshBtn = TextView(ctx).apply {
            text = "⟳"
            setTextColor(ContextCompat.getColor(ctx, R.color.color_primary))
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "刷新"
            isClickable = true
            setOnClickListener { webView?.reload() }
        }

        closeBtn = TextView(ctx).apply {
            text = "✕"
            setTextColor(ContextCompat.getColor(ctx, R.color.color_error))
            textSize = 18f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "关闭"
            isClickable = true
            setOnClickListener {
                (act as? MainActivity)?.switchToTab(R.id.nav_home)
            }
        }

        topBar.addView(backBtn)
        topBar.addView(titleText)
        topBar.addView(refreshBtn)
        topBar.addView(closeBtn)

        // === WebView 容器 ===
        val webContainer = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        val wv = createWebView(ctx)
        webView = wv
        webContainer.addView(wv)
        root.addView(topBar)
        root.addView(webContainer)

        applyNativeTheme(ctx, backBtn!!, titleText, refreshBtn!!, closeBtn!!)

        // 恢复登录态后再加载 Maker 首页
        val accountManager = AccountManager(ctx)
        accountManager.restoreCurrentCookies {
            val url = MAKER_URL
            Log.i(TAG, "restoreCurrentCookies done, loading $url")
            activity?.runOnUiThread { wv.loadUrl(url) }
        }

        return root
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(ctx: Context): WebView {
        return WebView(ctx).apply wv@{
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            // 硬件加速 —— WebGL2 / 游戏预览必需
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            WebView.setWebContentsDebuggingEnabled(true)

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
                // 与 BackendWebViewActivity 完全一致:真实 Chromium UA,仅去掉 "; wv" 标识,
                // TapTap 检测到真实 Chromium 内核会给出完整登录面板(扫码、原生 App 拉起)。
                userAgentString = settings.userAgentString.replace("; wv", "")
                allowFileAccess = true
                allowContentAccess = true
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                javaScriptCanOpenWindowsAutomatically = true
                setSupportMultipleWindows(true)
                setGeolocationEnabled(true)
                loadsImagesAutomatically = true
                cacheMode = WebSettings.LOAD_DEFAULT
                mediaPlaybackRequiresUserGesture = false

                // 开启第三方 Cookie,登录授权流依赖
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this@wv, true)
            }

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    titleText.text = "加载中..."
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    currentUrl = url
                    // 登录完成后把 Cookie 回流到 AccountManager 的内存/磁盘缓存,
                    // 供后续 HTTP 请求和其他 WebView 复用(开发者后台 / 首页)。
                    val ctx2 = context ?: return
                    val am = AccountManager(ctx2)
                    try {
                        am.importCookiesFromWebView(am.getCurrentAccountId())
                    } catch (e: Exception) {
                        Log.w(TAG, "importCookiesFromWebView failed", e)
                    }
                }

                override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                    super.doUpdateVisitedHistory(view, url, isReload)
                    currentUrl = url
                    canGoBackState = view?.canGoBack() ?: false
                    backBtn?.isEnabled = canGoBackState
                    backBtn?.alpha = if (canGoBackState) 1.0f else 0.4f
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val url = request.url.toString()
                    val host = request.url.host ?: ""

                    // 非 http(s) 协议(mqqapi://、mqqwpa://、weixin://、intent:// 等)交给系统处理
                    if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        Log.d(TAG, "Non-http(s) scheme, dispatching via Intent: $url")
                        dispatchExternalIntent(url)
                        return true
                    }

                    // 所有 taptap.cn 子域(含 accounts/passport/www/i 等登录域)留在 WebView 内完成
                    return if (host == "taptap.cn" || host.endsWith(".taptap.cn")) {
                        false
                    } else {
                        Log.d(TAG, "External http(s) link, opening in browser: $url")
                        dispatchExternalIntent(url)
                        true
                    }
                }

                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    // Chromium 渲染进程崩溃/被系统回收:重载页面即可,无需手动重建 session。
                    Log.w(TAG, "WebView render process gone; will reload if still attached")
                    activity?.runOnUiThread {
                        try {
                            val w = webView ?: return@runOnUiThread
                            w.loadUrl(currentUrl ?: MAKER_URL)
                        } catch (e: Exception) {
                            Log.w(TAG, "reload after renderProcessGone failed", e)
                        }
                    }
                    return true
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView?, title: String?) {
                    super.onReceivedTitle(view, title)
                    if (!title.isNullOrEmpty() && title.length <= 20) {
                        titleText.text = title
                    } else {
                        titleText.text = "Tap制造"
                    }
                }

                // window.open() 弹窗(登录授权等) —— 把 URL 回灌到主 WebView 加载,
                // 与 BackendWebViewActivity 行为一致。
                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: android.os.Message?
                ): Boolean {
                    val newWebView = WebView(this@MakerWebFragment.requireContext())
                    newWebView.settings.javaScriptEnabled = true
                    newWebView.webChromeClient = this
                    newWebView.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            v: WebView,
                            request: WebResourceRequest
                        ): Boolean {
                            this@wv.post { this@wv.loadUrl(request.url.toString()) }
                            newWebView.destroy()
                            (resultMsg?.obj as? WebView.WebViewTransport)?.webView = newWebView
                            resultMsg?.sendToTarget()
                            return true
                        }
                    }
                    (resultMsg?.obj as? WebView.WebViewTransport)?.webView = newWebView
                    resultMsg?.sendToTarget()
                    return true
                }

                // 文件选择(头像上传、封面、APK 等)
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    this@MakerWebFragment.filePathCallback?.onReceiveValue(null)
                    this@MakerWebFragment.filePathCallback = filePathCallback
                    val intent = Intent(Intent.ACTION_GET_CONTENT)
                    intent.addCategory(Intent.CATEGORY_OPENABLE)
                    intent.type = "*/*"
                    return try {
                        startActivityForResult(
                            Intent.createChooser(intent, "选择文件"),
                            REQUEST_FILE_CHOOSER
                        )
                        true
                    } catch (e: Exception) {
                        this@MakerWebFragment.filePathCallback = null
                        false
                    }
                }
            }
        }
    }

    /** 把任意链接交给系统处理(浏览器 / 原生 App / intent:// 解析)。 */
    private fun dispatchExternalIntent(url: String) {
        val ctx = context ?: return
        try {
            val intent: Intent = if (url.startsWith("intent://")) {
                Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to dispatch external intent: $url", e)
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_FILE_CHOOSER) {
            val cb = filePathCallback
            filePathCallback = null
            if (cb == null) return
            try {
                if (resultCode == Activity.RESULT_OK && data != null) {
                    val uris = mutableListOf<Uri>()
                    val clip = data.clipData
                    if (clip != null) {
                        for (i in 0 until clip.itemCount) {
                            clip.getItemAt(i).uri?.let { uris.add(it) }
                        }
                    } else {
                        data.data?.let { uris.add(it) }
                    }
                    cb.onReceiveValue(if (uris.isNotEmpty()) uris.toTypedArray() else null)
                } else {
                    cb.onReceiveValue(null)
                }
            } catch (e: Exception) {
                Log.w(TAG, "onActivityResult file chooser completion failed", e)
                try { cb.onReceiveValue(null) } catch (_: Exception) {}
            }
        }
    }

    fun canGoBack(): Boolean = canGoBackState

    fun goBack() {
        webView?.goBack()
    }

    fun destroyWebView() {
        try { filePathCallback?.onReceiveValue(null) } catch (_: Exception) {}
        filePathCallback = null
        try {
            webView?.apply {
                stopLoading()
                webChromeClient = null
                webViewClient = WebViewClient()
                removeAllViews()
                destroy()
            }
        } catch (_: Exception) {}
        webView = null
    }

    override fun onDestroyView() {
        destroyWebView()
        super.onDestroyView()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        themedViews?.let { v ->
            val ctx = context ?: return
            FontHelper.applyTopBarStyle(ctx, v.backBtn, v.refreshBtn)
            FontHelper.applyFont(ctx, v.titleText, v.closeBtn)
        }
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            webView?.onPause()
        } else {
            webView?.onResume()
        }
    }

    private data class ThemedViews(
        val backBtn: TextView, val titleText: TextView,
        val refreshBtn: TextView, val closeBtn: TextView
    )
    private var themedViews: ThemedViews? = null

    private fun applyNativeTheme(
        ctx: Context,
        backBtn: TextView, titleText: TextView,
        refreshBtn: TextView, closeBtn: TextView
    ) {
        FontHelper.applyTopBarStyle(ctx, backBtn, refreshBtn)
        FontHelper.applyFont(ctx, titleText, closeBtn)
        themedViews = ThemedViews(backBtn, titleText, refreshBtn, closeBtn)
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }

    companion object {
        private const val TAG = "MakerWebView"
        private const val MAKER_URL = "https://maker.taptap.cn/"
        private const val REQUEST_FILE_CHOOSER = 2001
    }
}
