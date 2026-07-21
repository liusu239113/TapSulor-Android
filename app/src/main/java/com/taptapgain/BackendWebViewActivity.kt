package com.taptapgain

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class BackendWebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var titleText: TextView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var appName: String = ""
    private var appId: String = ""

    private data class ThemedViews(
        val backBtn: TextView, val titleText: TextView,
        val refreshBtn: TextView, val closeBtn: TextView
    )
    private var themedViews: ThemedViews? = null

    companion object {
        // 使用真实 WebView UA(仅去掉 "; wv" 标识),避免被检测为 WebView。
        // 不伪装成桌面 Chrome,防止内嵌的控制台/WebGL 能力检测失败。
        const val EXTRA_APP_ID = "extra_app_id"
        const val EXTRA_APP_NAME = "extra_app_name"
        private const val REQUEST_FILE_CHOOSER = 1001

        fun start(activity: Activity, appId: String, appName: String) {
            val intent = Intent(activity, BackendWebViewActivity::class.java)
            intent.putExtra(EXTRA_APP_ID, appId)
            intent.putExtra(EXTRA_APP_NAME, appName)
            activity.startActivity(intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableImmersiveMode()

        appId = intent.getStringExtra(EXTRA_APP_ID) ?: ""
        appName = intent.getStringExtra(EXTRA_APP_NAME) ?: "开发者后台"

        // Build layout: top bar + WebView
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(ContextCompat.getColor(this@BackendWebViewActivity, R.color.bg_page))
        }

        // Top bar
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setBackgroundColor(ContextCompat.getColor(this@BackendWebViewActivity, R.color.bg_top_bar))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48)
            )
        }

        val backBtn = TextView(this).apply {
            text = "←"
            setTextColor(ContextCompat.getColor(this@BackendWebViewActivity, R.color.color_primary))
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            setPadding(0, 0, 0, 0)
            contentDescription = "返回"
            isClickable = true
            setOnClickListener {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        }

        titleText = TextView(this).apply {
            text = appName
            setTextColor(ContextCompat.getColor(this@BackendWebViewActivity, R.color.text_primary))
            textSize = 16f
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                marginStart = dp(8)
            }
            setSingleLine()
            maxLines = 1
        }

        val refreshBtn = TextView(this).apply {
            text = "⟳"
            setTextColor(ContextCompat.getColor(this@BackendWebViewActivity, R.color.color_primary))
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "刷新"
            isClickable = true
            setOnClickListener { webView.reload() }
        }

        val closeBtn = TextView(this).apply {
            text = "✕"
            setTextColor(ContextCompat.getColor(this@BackendWebViewActivity, R.color.color_error))
            textSize = 18f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            setPadding(0, 0, 0, 0)
            contentDescription = "关闭"
            isClickable = true
            setOnClickListener { finish() }
        }

        topBar.addView(backBtn)
        topBar.addView(titleText)
        topBar.addView(refreshBtn)
        topBar.addView(closeBtn)

        // WebView container
        val webContainer = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        webView = WebView(this).apply webView@{
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            // 强制硬件加速(WebGL2 / 控制台图表必需)
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
                // 使用真实 WebView UA,仅移除 "; wv" 标识(与首页一致)
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
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this@webView, true)
                // 允许无用户手势自动播放音频
                mediaPlaybackRequiresUserGesture = false
            }

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    titleText.text = "加载中..."
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    val host = request.url.host ?: ""
                    // 所有 taptap.cn 子域(含登录 accounts/i/www 等)都留在 WebView 内完成
                    return if (host == "taptap.cn" || host.endsWith(".taptap.cn")) {
                        false
                    } else {
                        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
                        true
                    }
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView?, title: String?) {
                    super.onReceivedTitle(view, title)
                    if (!title.isNullOrEmpty() && !title.contains("TapTap", ignoreCase = true)) {
                        titleText.text = title
                    } else {
                        titleText.text = appName
                    }
                }

                // 处理 window.open() 弹出窗口(登录授权等),在当前 WebView 内跳转
                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: android.os.Message?
                ): Boolean {
                    val newWebView = WebView(this@BackendWebViewActivity)
                    newWebView.settings.javaScriptEnabled = true
                    newWebView.webChromeClient = this
                    newWebView.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            v: WebView,
                            request: WebResourceRequest
                        ): Boolean {
                            webView.post { webView.loadUrl(request.url.toString()) }
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

                // File chooser for APK/image uploads
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    this@BackendWebViewActivity.filePathCallback?.onReceiveValue(null)
                    this@BackendWebViewActivity.filePathCallback = filePathCallback
                    val intent = Intent(Intent.ACTION_GET_CONTENT)
                    intent.addCategory(Intent.CATEGORY_OPENABLE)
                    intent.type = "*/*"
                    try {
                        startActivityForResult(
                            Intent.createChooser(intent, "选择文件"),
                            REQUEST_FILE_CHOOSER
                        )
                    } catch (e: Exception) {
                        this@BackendWebViewActivity.filePathCallback = null
                        return false
                    }
                    return true
                }
            }
        }

        webContainer.addView(webView)
        root.addView(topBar)
        root.addView(webContainer)
        setContentView(root)

        // 顶部栏样式:返回/刷新按钮=强调色,标题=主文本色,关闭=危险红;全部跟随字体偏好
        applyNativeTheme(backBtn, titleText, refreshBtn, closeBtn)

        // Load the game backend page after restoring cookies
        val accountManager = AccountManager(this)
        val devId = accountManager.getDeveloperId()
        accountManager.restoreCurrentCookies {
            val url = if (devId != null && appId.isNotEmpty()) {
                "https://developer.taptap.cn/v3/$devId/app/$appId"
            } else if (devId != null) {
                "https://developer.taptap.cn/v3/$devId/all-app"
            } else {
                "https://developer.taptap.cn/"
            }
            runOnUiThread { webView.loadUrl(url) }
        }
    }

    @SuppressLint("NewApi")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_FILE_CHOOSER) {
            val results = if (resultCode == RESULT_OK && data != null) {
                val uri = data.data
                if (uri != null) arrayOf(uri) else null
            } else null
            filePathCallback?.onReceiveValue(results)
            filePathCallback = null
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onResume() {
        super.onResume()
        // 从设置页/其他页面返回时重新应用主题字体/强调色(用户可能刚切换过)
        themedViews?.let { v ->
            FontHelper.applyTopBarStyle(this, v.backBtn, v.refreshBtn)
            FontHelper.applyFont(this, v.titleText, v.closeBtn)
        }
    }

    /** 把 web 端同步过来的字体偏好/强调色应用到顶部栏所有 TextView */
    private fun applyNativeTheme(
        backBtn: TextView, titleText: TextView,
        refreshBtn: TextView, closeBtn: TextView
    ) {
        // 返回/刷新按钮使用强调色 + 自定义字体
        FontHelper.applyTopBarStyle(this, backBtn, refreshBtn)
        // 标题/关闭按钮保持原配色(text_primary / color_error),仅应用字体
        FontHelper.applyFont(this, titleText, closeBtn)
        themedViews = ThemedViews(backBtn, titleText, refreshBtn, closeBtn)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        webView.destroy()
        super.onDestroy()
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }
}
