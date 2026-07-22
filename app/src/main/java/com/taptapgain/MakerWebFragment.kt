package com.taptapgain

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.GeckoSessionSettings

/**
 * 使用 GeckoView(Firefox 内核)渲染 Tap 制造页面的 Fragment。
 *
 * 为什么不用系统 WebView:
 *  - Android WebView 缺少站点隔离(site isolation/Fission),即使 COOP/COEP 头正确、
 *    反射调用 setEnableSharedArrayBuffer(true),window.crossOriginIsolated 仍为 false,
 *    SharedArrayBuffer 不可用 → SCE/UrhoX WASM 多线程游戏无法启动,弹出"不支持"覆盖层。
 *
 * 为什么不用 Chrome Custom Tabs:
 *  - Custom Tabs 以独立 Activity 运行,即使 Chrome 包名被强制,在小米等设备上仍会
 *    离开当前 App 任务栈,用户感知为"跳出到浏览器",不符合产品要求。
 *
 * GeckoView 是 Mozilla 官方提供的可嵌入 Android View(就像 WebView 一样嵌在布局里),
 * 但内置 Firefox 完整渲染引擎,默认开启站点隔离(Fission),原生支持 SharedArrayBuffer
 * 和 WASM 多线程,完全在 App 进程内渲染,无任何外部 Activity 跳转。
 */
class MakerWebFragment : Fragment() {

    private var geckoView: GeckoView? = null
    private var geckoSession: GeckoSession? = null
    private lateinit var titleText: TextView
    private var backBtn: TextView? = null
    private var refreshBtn: TextView? = null
    private var closeBtn: TextView? = null

    // 文件选择回调(GeckoView PromptDelegate 触发)
    private var filePromptCallback: GeckoSession.PromptDelegate.FileCallback? = null

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

        // === Top bar (与原来 WebView 版本一致) ===
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
            isEnabled = false // 初始不可用,等有历史记录再启用
            alpha = 0.4f
            setOnClickListener {
                geckoSession?.goBack()
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
            setOnClickListener {
                geckoSession?.reload()
            }
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

        // === GeckoView 容器 ===
        val webContainer = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        val runtime = getRuntime(ctx)

        // 创建 GeckoSession(类似 WebView 的浏览状态)
        val session = GeckoSession(
            GeckoSessionSettings.Builder()
                .usePrivateMode(false)
                .build()
        )
        geckoSession = session

        // 创建 GeckoView View 组件(替换 WebView)
        val gv = GeckoView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            // 启用调试(便于排查;release 包可关闭)
            isDebugMode = true
        }
        geckoView = gv

        // 打开 session 并绑定到 GeckoView
        session.open(runtime)
        gv.setSession(session)

        // === 导航代理(替代 WebViewClient) ===
        session.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLocationChange(
                session: GeckoSession,
                url: String?
            ) {
                Log.d(TAG, "onLocationChange: $url")
                updateBackButton()
            }

            override fun onCanGoBack(
                session: GeckoSession,
                canGoBack: Boolean
            ) {
                activity?.runOnUiThread {
                    backBtn?.isEnabled = canGoBack
                    backBtn?.alpha = if (canGoBack) 1.0f else 0.4f
                }
            }

            override fun onCanGoForward(
                session: GeckoSession,
                canGoForward: Boolean
            ) {}

            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest
            ): GeckoResult<AllowOrDeny>? {
                val url = request.uri
                val host = try {
                    Uri.parse(url).host ?: ""
                } catch (_: Exception) { "" }

                // 所有 taptap.cn 子域留在 GeckoView 内加载(含登录 accounts/i/www 等)
                val isTapTap = host == "taptap.cn" || host.endsWith(".taptap.cn")

                return if (isTapTap) {
                    Log.d(TAG, "Loading in GeckoView: $url")
                    GeckoResult.allow()
                } else {
                    // 外部链接用系统浏览器打开,不离开 App 内的制造页面
                    Log.d(TAG, "External link, opening in browser: $url")
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (_: Exception) {}
                    GeckoResult.deny()
                }
            }

            override fun onNewSession(
                session: GeckoSession,
                uri: String
            ): GeckoResult<GeckoSession>? {
                // window.open() 弹出的新窗口(登录授权等)在当前 session 内加载
                Log.d(TAG, "onNewSession (popup): $uri")
                session.load(uri)
                return GeckoResult.fromValue(null)
            }
        }

        // === 内容代理(替代 WebChromeClient 的标题/进度/alerts) ===
        session.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onTitleChange(session: GeckoSession, title: String?) {
                super.onTitleChange(session, title)
                if (!title.isNullOrEmpty() && title.length <= 20) {
                    titleText.text = title
                } else {
                    titleText.text = "Tap制造"
                }
            }
        }

        // === 进度代理 ===
        session.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStart(session: GeckoSession, url: String?) {
                titleText.text = "加载中..."
            }

            override fun onPageStop(session: GeckoSession, success: Boolean) {
                if (success) {
                    // 注入 CSS: 清零 Maker 网页顶部自带的状态栏/工具栏留白,与原生顶栏不重复
                    val js = """
                        (function(){
                            var s=document.getElementById('__tapsulor_topfix__');
                            if(!s){
                                s=document.createElement('style');
                                s.id='__tapsulor_topfix__';
                                s.textContent='html,body{padding-top:0!important;margin-top:0!important;}'+
                                    'body>*:first-child{margin-top:0!important;padding-top:0!important;}';
                                document.head.appendChild(s);
                            }
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
                            // 诊断: 输出 SAB/crossOriginIsolated 状态
                            console.log('[TapSulor] crossOriginIsolated='+window.crossOriginIsolated+' hasSAB='+(typeof SharedArrayBuffer!=='undefined'));
                            return window.crossOriginIsolated === true ? 'SAB_OK' : 'SAB_NOT_ISOLATED';
                        })();
                    """.trimIndent()
                    session.evaluateJS(js)?.then({ result ->
                        Log.i(TAG, "Page JS injected, crossOriginIsolated=$result")
                        GeckoResult.fromValue(null)
                    }, { error ->
                        Log.w(TAG, "JS injection failed: ${error?.message}")
                        GeckoResult.fromValue(null)
                    })
                }
            }
        }

        // === Prompt 代理(处理文件选择器/JS alert/confirm) ===
        session.promptDelegate = object : GeckoSession.PromptDelegate {
            override fun onFilePrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.FilePrompt
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? {
                // 清空上一次未处理的回调
                filePromptCallback?.dismiss()
                filePromptCallback = prompt.callback

                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                return try {
                    startActivityForResult(
                        Intent.createChooser(intent, "选择文件"),
                        REQUEST_FILE_CHOOSER
                    )
                    // 返回 null 表示异步处理,稍后在 onActivityResult 中通过 callback 确认/取消
                    null
                } catch (e: Exception) {
                    filePromptCallback = null
                    GeckoResult.fromValue(
                        prompt.dismiss().takeIf { it != null }
                            ?: GeckoSession.PromptDelegate.PromptResponse.DISMISS
                    )
                }
            }
        }

        webContainer.addView(gv)
        root.addView(topBar)
        root.addView(webContainer)

        // 顶部栏样式: 返回/刷新=强调色,标题/关闭保持原配色,仅应用字体
        applyNativeTheme(ctx, backBtn!!, titleText, refreshBtn!!, closeBtn!!)

        // === Cookie 同步后再加载 Maker 页面 ===
        syncCookiesToGecko(runtime) {
            act.runOnUiThread {
                if (isAdded) {
                    Log.d(TAG, "Loading maker URL: $MAKER_URL")
                    session.load(MAKER_URL)
                }
            }
        }

        return root
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_FILE_CHOOSER) {
            val cb = filePromptCallback
            filePromptCallback = null
            if (cb != null) {
                if (resultCode == Activity.RESULT_OK && data?.data != null) {
                    cb.confirm(arrayOf(data.data!!))
                } else {
                    cb.dismiss()
                }
            }
        }
    }

    /** 将 AccountManager 中保存的 TapTap Cookie 注入 GeckoRuntime 的 Cookie 存储。 */
    private fun syncCookiesToGecko(runtime: GeckoRuntime, onComplete: () -> Unit) {
        val ctx = context ?: run { onComplete(); return }
        val accountManager = AccountManager(ctx)
        val accountId = accountManager.getCurrentAccountId()

        // 收集所有 TapTap 相关 URL 的 cookie
        val urls = listOf(
            "https://maker.taptap.cn/",
            "https://developer.taptap.cn/",
            "https://www.taptap.cn/",
            "https://passport.taptap.cn/",
            "https://taptap.cn/"
        )

        val cookieStrings = mutableListOf<Pair<String, String>>() // (uri, cookieString)
        for (urlStr in urls) {
            try {
                val httpUrl = urlStr.toHttpUrl()
                val cookies = accountManager.getCookiesForUrl(accountId, httpUrl)
                for (c in cookies) {
                    val cookieStr = buildString {
                        append(c.name).append('=').append(c.value)
                        append("; Domain=").append(if (c.hostOnly) c.domain else ".$c.domain")
                        append("; Path=").append(c.path)
                        if (c.secure) append("; Secure")
                        if (c.httpOnly) append("; HttpOnly")
                    }
                    cookieStrings.add(urlStr to cookieStr)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to get cookies for $urlStr", e)
            }
        }

        Log.d(TAG, "Syncing ${cookieStrings.size} cookies to GeckoView")

        if (cookieStrings.isEmpty()) {
            onComplete()
            return
        }

        val cookieStore = runtime.storageController.cookieStore
        var pending = cookieStrings.size
        val done = {
            pending--
            if (pending <= 0) {
                activity?.runOnUiThread(onComplete) ?: onComplete()
            }
        }

        for ((uri, cookieStr) in cookieStrings) {
            try {
                cookieStore.setCookie(uri, cookieStr)?.then({
                    Log.v(TAG, "Cookie set: ${cookieStr.take(40)}...")
                    done()
                    GeckoResult.fromValue(null)
                }, { error ->
                    Log.w(TAG, "Failed to set cookie: ${error?.message}")
                    done()
                    GeckoResult.fromValue(null)
                }) ?: done()
            } catch (e: Exception) {
                Log.w(TAG, "Exception setting cookie", e)
                done()
            }
        }
    }

    private fun updateBackButton() {
        val s = geckoSession ?: return
        try {
            s.canGoBack().then { canBack ->
                activity?.runOnUiThread {
                    backBtn?.isEnabled = canBack == true
                    backBtn?.alpha = if (canBack == true) 1.0f else 0.4f
                }
                GeckoResult.fromValue(null)
            }
        } catch (_: Exception) {}
    }

    fun canGoBack(): Boolean = geckoSession?.let {
        try {
            // GeckoSession.canGoBack() returns GeckoResult<Boolean>, but for quick check we use navigation history
            // Use a best-effort synchronous check; the delegate updates the button state async
            backBtn?.isEnabled ?: false
        } catch (_: Exception) { false }
    } ?: false

    fun goBack() {
        geckoSession?.goBack()
    }

    fun destroyWebView() {
        try {
            geckoSession?.close()
        } catch (_: Exception) {}
        geckoSession = null
        geckoView = null
    }

    override fun onDestroyView() {
        destroyWebView()
        super.onDestroyView()
    }

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
        FontHelper.applyTopBarStyle(ctx, backBtn, refreshBtn)
        FontHelper.applyFont(ctx, titleText, closeBtn)
        themedViews = ThemedViews(backBtn, titleText, refreshBtn, closeBtn)
    }

    override fun onResume() {
        super.onResume()
        themedViews?.let { v ->
            val ctx = context ?: return
            FontHelper.applyTopBarStyle(ctx, v.backBtn, v.refreshBtn)
            FontHelper.applyFont(ctx, v.titleText, v.closeBtn)
        }
        // 激活 GeckoSession(前台)
        geckoSession?.setActive(true)
    }

    override fun onPause() {
        super.onPause()
        // 失活 GeckoSession(后台,节省资源)
        geckoSession?.setActive(false)
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }

    companion object {
        private const val TAG = "MakerGeckoView"
        private const val MAKER_URL = "https://maker.taptap.cn/"
        private const val REQUEST_FILE_CHOOSER = 2001

        // GeckoRuntime 单例(每个进程只需创建一次,内部维护 Gecko 引擎的主线程和配置)
        @Volatile
        private var runtime: GeckoRuntime? = null

        fun getRuntime(context: android.content.Context): GeckoRuntime {
            runtime?.let { return it }
            synchronized(this) {
                runtime?.let { return it }

                // GeckoRuntimeSettings 配置:
                //  - aboutConfigEnabled: 允许 about:config 调试(可选)
                //  - 不强制关闭 multiprocess/Fission(默认开启 → 站点隔离 → SAB 可用)
                //  - 使用应用 context 避免 Activity 泄漏
                val settings = GeckoRuntimeSettings.Builder()
                    .aboutConfigEnabled(true)
                    .build()

                val r = GeckoRuntime.create(context.applicationContext, settings)
                runtime = r
                Log.i(TAG, "GeckoRuntime created (GeckoView ${BuildConfig.VERSION_NAME})")
                return r
            }
        }
    }
}
