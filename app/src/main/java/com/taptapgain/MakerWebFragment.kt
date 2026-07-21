package com.taptapgain

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
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
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.util.concurrent.TimeUnit

class MakerWebFragment : Fragment() {

    private lateinit var webView: WebView
    private lateinit var titleText: TextView
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

        // Top bar
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

        val backBtn = TextView(ctx).apply {
            text = "←"
            setTextColor(ContextCompat.getColor(ctx, R.color.color_primary))
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "返回"
            isClickable = true
            setOnClickListener {
                if (webView.canGoBack()) webView.goBack()
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

        val refreshBtn = TextView(ctx).apply {
            text = "⟳"
            setTextColor(ContextCompat.getColor(ctx, R.color.color_primary))
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "刷新"
            isClickable = true
            setOnClickListener { webView.reload() }
        }

        val closeBtn = TextView(ctx).apply {
            text = "✕"
            setTextColor(ContextCompat.getColor(ctx, R.color.color_error))
            textSize = 18f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "关闭"
            isClickable = true
            setOnClickListener {
                // Switch back to home tab
                (act as? MainActivity)?.switchToTab(R.id.nav_home)
            }
        }

        topBar.addView(backBtn)
        topBar.addView(titleText)
        topBar.addView(refreshBtn)
        topBar.addView(closeBtn)

        // WebView container
        val webContainer = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        webView = WebView(ctx).apply webView@{
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            // 强制硬件加速(WebGL2 / 游戏运行时必需;部分设备默认关闭会导致游戏 iframe 弹"浏览器不支持")
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            // 允许 WebView 调试(便于排查 WebGL/UA 问题;Release 包可由 App 统一开关)
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
                // 使用真实 WebView UA,仅移除 "; wv" 标识(与首页 WebView 一致)。
                // 不要伪装桌面 Chrome,否则内嵌游戏运行时能力检测会失败。
                userAgentString = settings.userAgentString.replace("; wv", "")
                allowFileAccess = true
                allowContentAccess = true
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
                // 允许 https 页面加载 http 子资源 / iframe(游戏预览 iframe 可能混用资源)
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                javaScriptCanOpenWindowsAutomatically = true
                setSupportMultipleWindows(true)
                setGeolocationEnabled(true)
                loadsImagesAutomatically = true
                mediaPlaybackRequiresUserGesture = false
                // 启用 WebView 缓存(默认 LOAD_DEFAULT 即可)
                cacheMode = WebSettings.LOAD_DEFAULT
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this@webView, true)
                // SharedArrayBuffer 是 SCE / UrhoX 游戏运行时(WASM 多线程)的硬性依赖。
                // 这里用反射调用 android.webkit.WebSettings.setEnableSharedArrayBuffer(boolean),
                // 该方法在 API 34(Android 14)+ 新版 Chromium WebView 上可用;用反射避免不同
                // compileSdk / AndroidX 版本下符号缺失导致的编译失败。对不支持该方法的设备或
                // WebView,由下面 shouldInterceptRequest 注入 COOP/COEP 头让页面 cross-origin
                // isolated,双管齐下确保 SAB 可用。
                try {
                    val m = android.webkit.WebSettings::class.java.getMethod(
                        "setEnableSharedArrayBuffer", Boolean::class.javaPrimitiveType
                    )
                    m.invoke(this, true)
                } catch (_: Throwable) {
                    // 旧设备 / 旧 WebView 不支持该方法时静默跳过,走 COOP/COEP 头路径
                }
            }

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    titleText.text = "加载中..."
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // Maker 远程页自己会预留顶部状态栏/工具栏空间;由于我们已经有 48dp 原生顶栏,
                    // 再叠一层网页侧 padding-top 会出现大块留白。注入样式将顶部空隙清零。
                    view?.evaluateJavascript(
                        """(function(){
                            var s=document.getElementById('__tapsulor_topfix__');
                            if(!s){
                                s=document.createElement('style');
                                s.id='__tapsulor_topfix__';
                                s.textContent='html,body{padding-top:0!important;margin-top:0!important;}'+
                                    'body>*:first-child{margin-top:0!important;padding-top:0!important;}';
                                document.head.appendChild(s);
                            }
                            // 如果页面把内容区做了 padding-top,也尝试清零常见容器
                            var cands=document.querySelectorAll('[class*="safe-area"],[class*="SafeArea"],[class*="top-bar"],[class*="TopBar"],[class*="navbar"],[class*="Navbar"],header');
                            for(var i=0;i<cands.length;i++){
                                var el=cands[i];
                                var cs=getComputedStyle(el);
                                if((cs.position==='fixed'||cs.position==='sticky')&&parseFloat(cs.top)===0){
                                    el.style.display='none';
                                }else{
                                    el.style.paddingTop='0';
                                    el.style.marginTop='0';
                                }
                            }
                            window.scrollTo(0,0);
                        })();""",
                        null
                    )
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    val host = request.url.host ?: ""
                    // 所有 taptap.cn 子域(含登录 accounts/i/www 等)都留在 WebView 内完成,
                    // 避免登录流程跳出到外部浏览器导致 cookie 断裂
                    return if (host == "taptap.cn" || host.endsWith(".taptap.cn")) {
                        false
                    } else {
                        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
                        true
                    }
                }

                // 为 maker.taptap.cn 的所有响应强制注入 COOP/COEP 头,
                // 使得顶层文档 + 游戏 iframe 处于 cross-origin isolated 状态,
                // 从而允许 SharedArrayBuffer(SCE / UrhoX WASM 多线程必需)。
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    val host = request.url.host ?: ""
                    val isMakerHost = host == "maker.taptap.cn" || host.endsWith(".maker.taptap.cn")
                    // 游戏运行时 iframe 也可能托管在单独子域(如 *.game.taptap.cn / sce-cdn 等),
                    // 为安全起见,对所有 taptap.cn 子域都注入头,避免 iframe 侧 SAB 失效。
                    val isTapTapDomain = host == "taptap.cn" || host.endsWith(".taptap.cn")
                    if (!isMakerHost && !isTapTapDomain) return null
                    // 没有请求体的方法直接代理;其它(POST/PUT 等)回退系统默认,避免破坏业务请求
                    val method = request.method?.uppercase() ?: "GET"
                    if (method != "GET" && method != "HEAD") return null
                    return fetchWithCoopCoep(request.url.toString(), method, request.requestHeaders)
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

                // 处理 window.open() 弹出的新窗口(taptap 登录/授权/分享 等可能会用):
                // 在当前 WebView 内加载目标 URL,而不是丢弃
                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: android.os.Message?
                ): Boolean {
                    val newWebView = WebView(requireContext())
                    newWebView.settings.javaScriptEnabled = true
                    newWebView.webChromeClient = this
                    newWebView.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            v: WebView,
                            request: WebResourceRequest
                        ): Boolean {
                            // 把 popup URL 转到主 webView 里,在当前页面内跳转
                            webView.post { webView.loadUrl(request.url.toString()) }
                            // 销毁临时 WebView
                            newWebView.destroy()
                            // 把假的 WebView 回传给 Chromium,避免它一直等 transport
                            (resultMsg?.obj as? WebView.WebViewTransport)?.webView = newWebView
                            resultMsg?.sendToTarget()
                            return true
                        }
                    }
                    (resultMsg?.obj as? WebView.WebViewTransport)?.webView = newWebView
                    resultMsg?.sendToTarget()
                    return true
                }

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
                    try {
                        startActivityForResult(
                            Intent.createChooser(intent, "选择文件"),
                            REQUEST_FILE_CHOOSER
                        )
                    } catch (e: Exception) {
                        this@MakerWebFragment.filePathCallback = null
                        return false
                    }
                    return true
                }
            }
        }

        webContainer.addView(webView)
        root.addView(topBar)
        root.addView(webContainer)

        // 顶部栏样式:返回/刷新按钮=强调色,标题=主文本色,关闭=危险红;全部跟随字体偏好
        applyNativeTheme(ctx, backBtn, titleText, refreshBtn, closeBtn)

        // Restore cookies and load maker page
        val accountManager = AccountManager(ctx)
        accountManager.restoreCurrentCookies {
            act.runOnUiThread { webView.loadUrl(MAKER_URL) }
        }

        return root
    }

    @SuppressLint("NewApi")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_FILE_CHOOSER) {
            val results = if (resultCode == android.app.Activity.RESULT_OK && data != null) {
                val uri = data.data
                if (uri != null) arrayOf(uri) else null
            } else null
            filePathCallback?.onReceiveValue(results)
            filePathCallback = null
        }
    }

    fun canGoBack(): Boolean = ::webView.isInitialized && webView.canGoBack()
    fun goBack() { if (::webView.isInitialized) webView.goBack() }
    fun destroyWebView() { if (::webView.isInitialized) webView.destroy() }

    private data class ThemedViews(
        val backBtn: TextView, val titleText: TextView,
        val refreshBtn: TextView, val closeBtn: TextView
    )
    private var themedViews: ThemedViews? = null

    private fun applyNativeTheme(
        ctx: android.content.Context,
        backBtn: TextView, titleText: TextView,
        refreshBtn: TextView, closeBtn: TextView
    ) {
        // 返回/刷新按钮=强调色 + 自定义字体;标题/关闭按钮保持原配色,仅应用字体
        FontHelper.applyTopBarStyle(ctx, backBtn, refreshBtn)
        FontHelper.applyFont(ctx, titleText, closeBtn)
        themedViews = ThemedViews(backBtn, titleText, refreshBtn, closeBtn)
    }

    override fun onResume() {
        super.onResume()
        // 从设置页返回时重新应用(用户可能刚切换字体/强调色)
        themedViews?.let { v ->
            val ctx = context ?: return
            FontHelper.applyTopBarStyle(ctx, v.backBtn, v.refreshBtn)
            FontHelper.applyFont(ctx, v.titleText, v.closeBtn)
        }
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }

    companion object {
        // 使用真实 WebView UA(仅去掉 "; wv" 标识),避免被检测为 WebView。
        // 不要伪装成桌面 Chrome 高版本,否则内嵌的游戏运行时(SCE/WASM/WebGL2)
        // 会走"桌面新版 Chrome"路径,调用 Android WebView 实际不支持的 API,
        // 导致弹出"浏览器不支持游戏所需运行环境"。
        private const val MAKER_URL = "https://maker.taptap.cn/"
        private const val REQUEST_FILE_CHOOSER = 2001

        // 代理 maker.taptap.cn 请求时复用的 OkHttpClient(长连接/线程池共享)
        private val coopClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .followRedirects(true)
                .followSslRedirects(true)
                .build()
        }
    }

    // 通过 OkHttp 代理请求并强制注入 COOP/COEP/CORP 响应头,
    // 使顶层文档及 iframe 处于 cross-origin isolated 状态,启用 SharedArrayBuffer。
    private fun fetchWithCoopCoep(
        url: String,
        method: String,
        requestHeaders: Map<String, String>
    ): WebResourceResponse? {
        return try {
            val reqBuilder = Request.Builder().url(url)
            // 透传大部分请求头(跳掉 hop-by-hop 头以及已由 OkHttp 自动处理的)
            val skipHeaders = setOf(
                "host", "connection", "content-length", "transfer-encoding",
                "accept-encoding", "proxy-connection", "keep-alive"
            )
            for ((k, v) in requestHeaders) {
                if (k.lowercase() in skipHeaders) continue
                reqBuilder.header(k, v)
            }
            // 显式带上 WebView CookieManager 里该 URL 的 cookie,保证登录态
            val cookie = CookieManager.getInstance().getCookie(url)
            if (!cookie.isNullOrEmpty()) reqBuilder.header("Cookie", cookie)

            if (method == "HEAD") reqBuilder.head()
            else reqBuilder.get()

            coopClient.newCall(reqBuilder.build()).execute().use { resp ->
                val body = resp.body
                val bytes = body?.bytes() ?: ByteArray(0)
                val contentType = resp.header("Content-Type") ?: "application/octet-stream"
                val mime = contentType.substringBefore(';').trim()
                val charset = contentType.substringAfter("charset=", "UTF-8").substringBefore(';').trim()

                // 收集原始响应头,并强制注入 cross-origin isolation 头
                val mergedHeaders = mutableMapOf<String, String>()
                for ((k, v) in resp.headers) {
                    // 重复头按多行合并
                    mergedHeaders[k] = if (mergedHeaders.containsKey(k)) mergedHeaders[k] + ", " + v else v
                }
                // 顶层文档 + iframe: 开启跨源隔离 -> SharedArrayBuffer 可用
                mergedHeaders["Cross-Origin-Opener-Policy"] = "same-origin"
                mergedHeaders["Cross-Origin-Embedder-Policy"] = "require-corp"
                // 允许这些响应被同源/跨源 iframe 作为子资源加载(配合 COEP:require-corp)
                mergedHeaders["Cross-Origin-Resource-Policy"] = "cross-origin"

                WebResourceResponse(mime, charset, ByteArrayInputStream(bytes)).apply {
                    setStatusCodeAndReasonPhrase(resp.code, resp.message.ifEmpty { "OK" })
                    responseHeaders = mergedHeaders
                }
            }
        } catch (e: Exception) {
            // 代理失败时回退系统默认加载逻辑(返回 null 让 WebView 自己去请求)
            null
        }
    }
}
