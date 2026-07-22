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
 *
 * 注意:GeckoView 153 的公开 API 与旧版文档/博客差异较大:
 *  - 没有 session.load(String),用 loadUri(String) 或 load(Loader().uri(...))
 *  - 没有 evaluateJS / isDebugMode / PromptResponse.DISMISS / FileCallback
 *  - onLocationChange 签名是 (session, url, List, Boolean);多参数用于子框架导航事件
 *  - onNewSession 返回 GeckoResult<GeckoSession>;想把弹窗留在当前 session,直接 loadUri
 *    并返回 GeckoResult.deny() 阻止 GeckoView 新建窗口
 *  - onFilePrompt 拿到 FilePrompt 后,其 confirm(Context, Uri[])/dismiss() 直接返回
 *    PromptResponse,再由 GeckoResult<PromptResponse> 发回引擎
 *  - StorageController 不暴露 cookieStore;本版本先跳过敏捷 Cookie 同步,用户首次进入
 *    需要在 GeckoView 内重新登录一次(Cookie 存储是持久的,后续重启 App 自动复用)。
 */
class MakerWebFragment : Fragment() {

    private var geckoView: GeckoView? = null
    private var geckoSession: GeckoSession? = null
    private lateinit var titleText: TextView
    private var backBtn: TextView? = null
    private var refreshBtn: TextView? = null
    private var closeBtn: TextView? = null

    // 跟踪回退栈状态(由 NavigationDelegate.onCanGoBack 回调驱动)
    private var canGoBackState: Boolean = false
    // 当前 URL(由 onLocationChange 回调记录,用于日志)
    private var currentUrl: String? = null

    // 文件选择:先暂存 Prompt 对象和异步 GeckoResult,在 onActivityResult 中完成
    private var activeFilePrompt: GeckoSession.PromptDelegate.FilePrompt? = null
    private var activeFilePromptResult: GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? = null

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
                .allowJavascript(true)
                .build()
        )
        geckoSession = session

        // 创建 GeckoView View 组件(替换 WebView)
        val gv = GeckoView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        geckoView = gv

        // 打开 session 并绑定到 GeckoView
        session.open(runtime)
        gv.setSession(session)

        // === 导航代理(替代 WebViewClient) ===
        // 注意 onLocationChange 在 GeckoView 153 中是 4 个参数,后两个用于子框架导航
        session.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onLocationChange(
                session: GeckoSession,
                url: String?,
                changedPermissions: List<GeckoSession.PermissionDelegate.ContentPermission>,
                hasUserGesture: Boolean
            ) {
                currentUrl = url
                Log.d(TAG, "onLocationChange: $url (hasUserGesture=$hasUserGesture)")
            }

            override fun onCanGoBack(
                session: GeckoSession,
                canGoBack: Boolean
            ) {
                canGoBackState = canGoBack
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
                newSession: GeckoSession,
                uri: String
            ): GeckoResult<GeckoSession>? {
                // window.open() 弹出的新窗口(登录授权等)在当前主 session 内加载,
                // 并返回 null 告诉 GeckoView 走默认处理(即不新建 GeckoSession)。
                // GeckoResult.deny() 返回 GeckoResult<AllowOrDeny>,无法直接赋给
                // GeckoResult<GeckoSession>;而 NavigationDelegate.onNewSession 的契约
                // 里,返回 null 即代表"不处理新窗口",引擎会丢弃 newSession。
                Log.d(TAG, "onNewSession (popup), loading in current session: $uri")
                geckoSession?.loadUri(uri)
                return null
            }

            override fun onLoadError(
                session: GeckoSession,
                url: String?,
                error: org.mozilla.geckoview.WebRequestError
            ): GeckoResult<String>? {
                Log.w(TAG, "onLoadError: $url error=$error")
                return null // 让 GeckoView 走默认错误页
            }
        }

        // === 内容代理(替代 WebChromeClient 的标题/全屏/crash 等) ===
        session.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onTitleChange(session: GeckoSession, title: String?) {
                if (!title.isNullOrEmpty() && title.length <= 20) {
                    titleText.text = title
                } else {
                    titleText.text = "Tap制造"
                }
            }

            override fun onCloseRequest(session: GeckoSession) {
                Log.d(TAG, "onCloseRequest")
            }

            override fun onFullScreen(session: GeckoSession, fullScreen: Boolean) {
                Log.d(TAG, "onFullScreen: $fullScreen")
            }

            override fun onCrash(session: GeckoSession) {
                Log.e(TAG, "GeckoView CRASH — reloading")
                session.reload()
            }

            override fun onKill(session: GeckoSession) {
                Log.e(TAG, "GeckoView KILLED by system — reloading")
                session.reload()
            }
        }

        // === 进度代理 ===
        session.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStart(session: GeckoSession, url: String) {
                titleText.text = "加载中..."
            }

            override fun onPageStop(session: GeckoSession, success: Boolean) {
                Log.i(TAG, "onPageStop success=$success url=${currentUrl ?: "?"}")
                if (success) {
                    titleText.text = "Tap制造"
                } else {
                    titleText.text = "加载失败"
                }
            }

            override fun onProgressChange(session: GeckoSession, progress: Int) {
                // 可在此加进度条;目前仅打日志
                if (progress in 1..99) {
                    Log.v(TAG, "progress: $progress%")
                }
            }

            override fun onSecurityChange(
                session: GeckoSession,
                info: GeckoSession.ProgressDelegate.SecurityInformation
            ) {}

            override fun onSessionStateChange(
                session: GeckoSession,
                state: GeckoSession.SessionState
            ) {}
        }

        // === Prompt 代理(处理文件选择器/JS alert/confirm) ===
        // GeckoView 153 的 FilePrompt 不再暴露 callback 字段;我们把 Prompt 对象和
        // GeckoResult 暂存,在 onActivityResult 里通过 prompt.confirm/dismiss 拿到
        // PromptResponse 后,complete 到返回的 GeckoResult 中。
        session.promptDelegate = object : GeckoSession.PromptDelegate {
            override fun onFilePrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.FilePrompt
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse> {
                // 释放上一次未处理的 prompt(防止泄漏)
                activeFilePrompt?.dismiss()
                activeFilePrompt = prompt

                val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
                activeFilePromptResult = result

                // prompt.mimeTypes 是跨模块 public API 属性,Kotlin 不允许智能类型转换;
                // 先拷贝到本地 val 再判断
                val mimeTypes = prompt.mimeTypes
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (!mimeTypes.isNullOrEmpty()) {
                        mimeTypes.joinToString(",")
                    } else {
                        "*/*"
                    }
                    if (prompt.type == GeckoSession.PromptDelegate.FilePrompt.Type.MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }

                return try {
                    startActivityForResult(
                        Intent.createChooser(intent, "选择文件"),
                        REQUEST_FILE_CHOOSER
                    )
                    // 返回 GeckoResult,稍后在 onActivityResult 中 complete
                    result
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to start file chooser", e)
                    activeFilePrompt = null
                    activeFilePromptResult = null
                    GeckoResult.fromValue(prompt.dismiss())
                }
            }

            // 其余弹窗(alert/confirm/text/auth 等)走默认处理即可
        }

        webContainer.addView(gv)
        root.addView(topBar)
        root.addView(webContainer)

        // 顶部栏样式: 返回/刷新=强调色,标题/关闭保持原配色,仅应用字体
        applyNativeTheme(ctx, backBtn!!, titleText, refreshBtn!!, closeBtn!!)

        // 直接加载 Maker 页面(GeckoView 内部持久化 Cookie;首次需用户在页面内登录一次)
        Log.w(TAG, "NOTE: GeckoView 153 StorageController 不暴露 cookieStore;" +
                " 首次进入可能需要在页面内重新登录(Cookie 持久化到 Gecko 进程)。")
        act.runOnUiThread {
            if (isAdded) {
                Log.d(TAG, "Loading maker URL: $MAKER_URL")
                session.loadUri(MAKER_URL)
            }
        }

        return root
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_FILE_CHOOSER) {
            val prompt = activeFilePrompt
            val result = activeFilePromptResult
            activeFilePrompt = null
            activeFilePromptResult = null

            if (prompt == null || result == null) return

            val ctx = context
            try {
                if (resultCode == Activity.RESULT_OK && ctx != null) {
                    val uris = mutableListOf<Uri>()
                    val clip = data?.clipData
                    if (clip != null) {
                        for (i in 0 until clip.itemCount) {
                            clip.getItemAt(i).uri?.let { uris.add(it) }
                        }
                    } else {
                        data?.data?.let { uris.add(it) }
                    }
                    if (uris.isNotEmpty()) {
                        result.complete(prompt.confirm(ctx, uris.toTypedArray()))
                    } else {
                        result.complete(prompt.dismiss())
                    }
                } else {
                    result.complete(prompt.dismiss())
                }
            } catch (e: Exception) {
                Log.w(TAG, "onActivityResult file prompt completion failed", e)
                try { result.complete(prompt.dismiss()) } catch (_: Exception) {}
            }
        }
    }

    fun canGoBack(): Boolean = canGoBackState

    fun goBack() {
        geckoSession?.goBack()
    }

    fun destroyWebView() {
        try {
            activeFilePrompt?.dismiss()
        } catch (_: Exception) {}
        activeFilePrompt = null
        activeFilePromptResult = null
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
                //  - fissionEnabled(true): 显式开启站点隔离(默认已开,显式确认 SAB 可用)
                //  - remoteDebuggingEnabled(true): 允许 USB 远程调试(about:debugging)
                //  - consoleOutput(true)/debugLogging(true): 把 Gecko 内部日志打到 logcat
                //  - aboutConfigEnabled(true): 允许 about:config 调试
                //  - javaScriptEnabled(true): 显式允许 JS(WASM 多线程需要)
                //  - 使用 applicationContext 避免 Activity 泄漏
                val settings = GeckoRuntimeSettings.Builder()
                    .fissionEnabled(true)
                    .javaScriptEnabled(true)
                    .remoteDebuggingEnabled(true)
                    .consoleOutput(true)
                    .debugLogging(true)
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
