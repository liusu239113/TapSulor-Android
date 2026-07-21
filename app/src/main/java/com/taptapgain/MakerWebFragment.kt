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

class MakerWebFragment : Fragment() {

    private lateinit var webView: WebView
    private lateinit var titleText: TextView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        // 使用真实 WebView UA(仅去掉 "; wv" 标识),避免被检测为 WebView。
        // 不要伪装成桌面 Chrome 高版本,否则内嵌的游戏运行时(SCE/WASM/WebGL2)
        // 会走"桌面新版 Chrome"路径,调用 Android WebView 实际不支持的 API,
        // 导致弹出"浏览器不支持游戏所需运行环境"。
        private const val MAKER_URL = "https://maker.taptap.cn/"
        private const val REQUEST_FILE_CHOOSER = 2001
    }

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
}
