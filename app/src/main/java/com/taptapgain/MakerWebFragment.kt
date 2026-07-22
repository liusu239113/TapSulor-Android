package com.taptapgain

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
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
 *    SharedArrayBuffer 不可用 → SCE/UrhoX WASM 多线程游戏无法启动。
 *
 * GeckoView 是 Mozilla 官方提供的可嵌入 Android View,内置 Firefox 完整渲染引擎,
 * 默认开启站点隔离(Fission),原生支持 SharedArrayBuffer 和 WASM 多线程,完全在 App
 * 进程内渲染,无任何外部 Activity 跳转。
 *
 * 黑屏恢复策略:
 *  - Gecko 内容进程在后台被系统杀掉时会回调 onKill/onCrash。此时 session 已无法 reload,
 *    我们只是标记 needsRebuild=true,下次进入 Tab(onHiddenChanged(false)/onResume)或
 *    用户点刷新按钮时执行完整的 session 重建(new GeckoSession → open → setSession → loadUri)。
 *
 * 登录对齐(与 BackendWebViewActivity 行为一致):
 *  - UA 覆盖成 Chrome Android(不带 "; wv" 标记),让 TapTap 登录页给出完整面板(含扫码)。
 *  - 非 http(s) 链接(mqqapi://、mqqwpa://、weixin://、intent:// 等)通过 Intent.ACTION_VIEW
 *    交给系统处理,由系统拉起 QQ/微信等原生 App。
 */
class MakerWebFragment : Fragment() {

    private var geckoView: GeckoView? = null
    private var geckoSession: GeckoSession? = null
    private lateinit var titleText: TextView
    private var backBtn: TextView? = null
    private var refreshBtn: TextView? = null
    private var closeBtn: TextView? = null

    // 跟踪回退栈状态
    private var canGoBackState: Boolean = false
    private var currentUrl: String? = null
    // Gecko 内容进程被系统杀掉标记 —— 下次 onResume/显示时重建 session
    private var needsRebuild: Boolean = false
    // 正在重建中,防重入
    private var rebuilding: Boolean = false

    // 文件选择
    private var activeFilePrompt: GeckoSession.PromptDelegate.FilePrompt? = null
    private var activeFilePromptResult: GeckoResult<GeckoSession.PromptDelegate.PromptResponse>? = null

    // 冷启动 splash:本进程内首次进入 Tap 制造 Tab 时显示,加载完成后淡出。
    // 仅在进程冷启动(或被系统杀掉后重启)时展示一次,普通 Tab 切换不重复触发。
    private var splashView: View? = null
    private var splashDismissed: Boolean = false
    private var splashMediaPlayer: MediaPlayer? = null

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
            setOnClickListener { geckoSession?.goBack() }
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
            setOnClickListener { hardReload() }
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

        val gv = GeckoView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        geckoView = gv

        // 创建并打开初始 session
        val session = createAndOpenSession(runtime, gv)
        geckoSession = session

        webContainer.addView(gv)

        // === 冷启动 splash 覆盖层(仅本进程首次进入 Maker 时可见) ===
        // 用全局 companion 标志保证进程生命周期内只显示一次 —— Tab 切换/返回/重建 session 都不重复。
        // 不再使用静态大图,改用代码绘制的渐变背景 + logo pop 动画 + 品牌名淡入,
        // 与主面板 web 端 #splash 的视觉风格保持一致。
        if (!splashShownInProcess) {
            val splash = buildAnimatedSplash(ctx)
            webContainer.addView(splash)
            splashView = splash
            splashShownInProcess = true
            playSplashSound(ctx)
            scheduleSplashFallback()
        }

        root.addView(topBar)
        root.addView(webContainer)

        applyNativeTheme(ctx, backBtn!!, titleText, refreshBtn!!, closeBtn!!)

        // 首次加载
        Log.d(TAG, "Loading maker URL: $MAKER_URL")
        session.loadUri(MAKER_URL)

        return root
    }

    /**
     * 创建一个新的 GeckoSession、打开并绑定到 gv,同时挂好所有 delegate。
     * 调用者负责把返回的 session 赋值给 geckoSession。
     */
    private fun createAndOpenSession(runtime: GeckoRuntime, gv: GeckoView): GeckoSession {
        val session = GeckoSession(
            GeckoSessionSettings.Builder()
                .usePrivateMode(false)
                .allowJavascript(true)
                // 平板(iPad)模式:
                //  - VIEWPORT_MODE_MOBILE: 用移动端视口(<meta viewport> 生效,适配触屏缩放)
                //  - USER_AGENT_MODE_MOBILE + IPAD_UA: 伪装成 iPad Safari,
                //    maker.taptap.cn 会下发平板版页面(比 PC 版更适合手机/平板触屏操作,
                //    登录面板仍保留扫码 / QQ / 微信 / 手机号入口)。
                .viewportMode(GeckoSessionSettings.VIEWPORT_MODE_MOBILE)
                .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_MOBILE)
                .userAgentOverride(IPAD_UA)
                .build()
        )
        attachDelegates(session)
        session.open(runtime)
        gv.setSession(session)
        return session
    }

    /** 给 session 绑定所有 delegate(集中在此,便于重建时复用)。 */
    private fun attachDelegates(session: GeckoSession) {
        // === 导航代理 ===
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

            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                canGoBackState = canGoBack
                activity?.runOnUiThread {
                    backBtn?.isEnabled = canGoBack
                    backBtn?.alpha = if (canGoBack) 1.0f else 0.4f
                }
            }

            override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) {}

            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest
            ): GeckoResult<AllowOrDeny>? {
                val url = request.uri

                // 非 http(s) 协议(mqqapi://、mqqwpa://、weixin://、intent:// 等)
                // 交给系统 Intent 处理,由系统拉起原生 App。
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    Log.d(TAG, "Non-http(s) scheme, dispatching via Intent: $url")
                    dispatchExternalIntent(url)
                    return GeckoResult.deny()
                }

                val host = try { Uri.parse(url).host ?: "" } catch (_: Exception) { "" }

                // 所有 taptap.cn 子域留在 GeckoView 内
                val isTapTap = host == "taptap.cn" || host.endsWith(".taptap.cn")

                return if (isTapTap) {
                    Log.d(TAG, "Loading in GeckoView: $url")
                    GeckoResult.allow()
                } else {
                    Log.d(TAG, "External http(s) link, opening in browser: $url")
                    dispatchExternalIntent(url)
                    GeckoResult.deny()
                }
            }

            override fun onNewSession(
                newSession: GeckoSession,
                uri: String
            ): GeckoResult<GeckoSession>? {
                // window.open() 弹窗:把 URL 回灌到当前主 session 加载,
                // 返回 null 让引擎丢掉 newSession。
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
                return null
            }
        }

        // === 内容代理 ===
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
                Log.e(TAG, "GeckoView CRASH — marking for rebuild")
                needsRebuild = true
                updateTitleForState()
            }

            override fun onKill(session: GeckoSession) {
                // 内容进程被系统杀掉,此时 session 已无法 reload。仅标记,
                // 等下次显示/用户刷新时再真正重建。
                Log.e(TAG, "GeckoView KILLED by system — marking for rebuild")
                needsRebuild = true
                updateTitleForState()
            }
        }

        // === 进度代理 ===
        session.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onPageStart(session: GeckoSession, url: String) {
                titleText.text = "加载中..."
            }

            override fun onPageStop(session: GeckoSession, success: Boolean) {
                Log.i(TAG, "onPageStop success=$success url=${currentUrl ?: "?"}")
                if (needsRebuild) {
                    needsRebuild = false
                }
                updateTitleForState()
                dismissSplashIfVisible()
            }

            override fun onProgressChange(session: GeckoSession, progress: Int) {}

            override fun onSecurityChange(
                session: GeckoSession,
                info: GeckoSession.ProgressDelegate.SecurityInformation
            ) {}

            override fun onSessionStateChange(
                session: GeckoSession,
                state: GeckoSession.SessionState
            ) {}
        }

        // === Prompt 代理(文件选择) ===
        session.promptDelegate = object : GeckoSession.PromptDelegate {
            override fun onFilePrompt(
                session: GeckoSession,
                prompt: GeckoSession.PromptDelegate.FilePrompt
            ): GeckoResult<GeckoSession.PromptDelegate.PromptResponse> {
                activeFilePrompt?.dismiss()
                activeFilePrompt = prompt

                val result = GeckoResult<GeckoSession.PromptDelegate.PromptResponse>()
                activeFilePromptResult = result

                val mimeTypes = prompt.mimeTypes
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    // Android Intent.type 只能接受单个 MIME；多类型必须通过 EXTRA_MIME_TYPES 传数组。
                    // 否则逗号拼接(如 "image/png,image/jpeg") 会被当成非法 MIME，系统选择器返回空列表（"相册没有图片"）。
                    val hasWildcard = mimeTypes.isNullOrEmpty() || mimeTypes.any { it.trim() == "*/*" }
                    if (hasWildcard) {
                        type = "*/*"
                    } else {
                        type = "*/*"
                        putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
                    }
                    if (prompt.type == GeckoSession.PromptDelegate.FilePrompt.Type.MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    // 部分 ROM/选择器需要显式 FLAG 才会把返回的 URI 读权限授予本进程
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }

                return try {
                    startActivityForResult(
                        Intent.createChooser(intent, "选择图片或文件"),
                        REQUEST_FILE_CHOOSER
                    )
                    result
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to start file chooser", e)
                    activeFilePrompt = null
                    activeFilePromptResult = null
                    GeckoResult.fromValue(prompt.dismiss())
                }
            }
        }
    }

    private fun updateTitleForState() {
        val act = activity ?: return
        act.runOnUiThread {
            titleText.text = if (needsRebuild) "点击⟳重载" else "Tap制造"
        }
    }

    /** 把任意链接交给系统处理(浏览器 / 原生 App / intent:// 解析)。 */
    private fun dispatchExternalIntent(url: String) {
        val ctx = context ?: return
        try {
            val intent: Intent = if (url.startsWith("intent://")) {
                // intent:// 协议常见于 QQ/微信/H5 拉起 App,需要 parseUri 解析
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

    /**
     * 硬刷新:
     *  - 若 session 已死 → 整体重建(close 旧的、new 新的、open、loadUri)
     *  - 若 session 还在 → bypass-cache reload
     */
    private fun hardReload() {
        val gv = geckoView
        val ctx = context
        if (gv == null || ctx == null) return

        if (needsRebuild || geckoSession == null) {
            Log.i(TAG, "hardReload: rebuilding session")
            rebuildSession()
            return
        }

        Log.i(TAG, "hardReload: bypass-cache reload")
        try {
            geckoSession?.reload(GeckoSession.LOAD_FLAGS_BYPASS_CACHE)
        } catch (e: Exception) {
            Log.w(TAG, "reload() threw, falling back to rebuild", e)
            rebuildSession()
        }
    }

    /** 完整重建 GeckoSession(黑屏/被杀后的恢复路径)。 */
    private fun rebuildSession() {
        if (rebuilding) return
        rebuilding = true
        val gv = geckoView
        val ctx = context
        val act = activity
        if (gv == null || ctx == null || act == null) {
            rebuilding = false
            return
        }
        act.runOnUiThread {
            try {
                // 先拆掉旧 session
                activeFilePrompt?.dismiss()
                activeFilePrompt = null
                activeFilePromptResult = null
                val old = geckoSession
                geckoSession = null
                try { old?.close() } catch (_: Exception) {}

                // 创建新的
                val newSession = createAndOpenSession(getRuntime(ctx), gv)
                geckoSession = newSession
                needsRebuild = false
                canGoBackState = false
                currentUrl = null
                backBtn?.isEnabled = false
                backBtn?.alpha = 0.4f
                Log.i(TAG, "Session rebuilt; loading $MAKER_URL")
                newSession.loadUri(MAKER_URL)
            } catch (e: Exception) {
                Log.e(TAG, "rebuildSession failed", e)
            } finally {
                rebuilding = false
            }
        }
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
        try { activeFilePrompt?.dismiss() } catch (_: Exception) {}
        activeFilePrompt = null
        activeFilePromptResult = null
        // 释放启动音效播放器(若还在播放)
        splashMediaPlayer?.let { mp ->
            try { mp.stop() } catch (_: Exception) {}
            try { mp.release() } catch (_: Exception) {}
        }
        splashMediaPlayer = null
        splashView?.let { v ->
            v.animate().cancel()
            (v.parent as? ViewGroup)?.removeView(v)
        }
        splashView = null
        try { geckoSession?.close() } catch (_: Exception) {}
        geckoSession = null
        geckoView = null
    }

    /**
     * 冷启动 splash 淡出并移除。
     *  - 首次 onPageStop(success=true) 触发一次;
     *  - 兜底: 最长 SPLASH_MAX_MS 后无论页面是否加载完都淡出,避免页面卡住时 splash 永久遮挡。
     */
    private fun dismissSplashIfVisible() {
        if (splashDismissed) return
        val v = splashView ?: return
        splashDismissed = true
        val act = activity ?: return
        act.runOnUiThread {
            v.animate().cancel()
            // 出场动画对齐 web 端 #splash.is-done: opacity 0 + scale 1.08, 700ms ease
            v.animate()
                .alpha(0f)
                .scaleX(1.08f)
                .scaleY(1.08f)
                .setDuration(700)
                .setInterpolator(DecelerateInterpolator())
                .withEndAction {
                    (v.parent as? ViewGroup)?.removeView(v)
                    if (splashView === v) splashView = null
                }
                .start()
        }
    }

    private fun scheduleSplashFallback() {
        val v = splashView ?: return
        v.postDelayed({ dismissSplashIfVisible() }, SPLASH_MAX_MS)
    }

    /**
     * 构建动画版启动页(代码绘制,不依赖静态大图)。
     *
     * 视觉对齐主面板 web 端 #splash:
     *  - 135° 青蓝渐变背景 (#25B6E9 → #5ED5F5 → #A7E9F9)
     *  - 128dp 白色圆角方块承载 App 图标,带浅色描边和偏移阴影
     *  - 下方 "TapSulor" 粗体品牌名 + "Tap 制造" 副标语
     *  - 入场: logo 从 0.4 倍 + 轻微旋转 pop 弹出(Overshoot),品牌名延迟 250ms 淡入上移
     *  - 出场在 dismissSplashIfVisible() 统一处理: 整体淡出 + 轻微放大
     */
    private fun buildAnimatedSplash(ctx: Context): View {
        val container = FrameLayout(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            isClickable = true
            isFocusable = true
            contentDescription = "TapSulor"
            setBackgroundColor(0xFF25B6E9.toInt())
        }

        // 渐变背景层(用 GradientDrawable 比自定义 onDraw 更省/更平滑)
        val bg = GradientDrawable(
            GradientDrawable.Orientation.BL_TR,
            intArrayOf(0xFF25B6E9.toInt(), 0xFF5ED5F5.toInt(), 0xFFA7E9F9.toInt())
        )
        @Suppress("DEPRECATION")
        container.background = bg

        // 内容竖排容器
        val content = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
            )
        }

        // 品牌主 logo(包含角色立绘 + TapSulor 字标,自带深蓝底色;无需额外白底卡片)
        val logoSize = dp(220)
        val logoImg = ImageView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(logoSize, logoSize).apply {
                bottomMargin = dp(10)
            }
            scaleType = ImageView.ScaleType.FIT_CENTER
            setImageResource(R.drawable.maker_logo)
            // 入场前初始态:缩小 + 轻微旋转 + 透明
            alpha = 0f
            scaleX = 0.4f
            scaleY = 0.4f
            rotation = -8f
        }

        // 副标语
        val tagline = TextView(ctx).apply {
            text = "Tap 制造 · 开发者工作台"
            setTextColor(Color.parseColor("#E6FFFFFF"))
            textSize = 12f
            letterSpacing = 0.18f
            gravity = Gravity.CENTER
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dp(2)
            layoutParams = lp
            alpha = 0f
            translationY = dp(8).toFloat()
            try {
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            } catch (_: Exception) {}
        }

        content.addView(logoImg)
        content.addView(tagline)
        container.addView(content)

        // 入场动画 —— 在 view attach 到窗口后执行,避免首帧还没测量就启动导致的跳变
        container.post {
            // logo pop
            logoImg.animate()
                .alpha(1f)
                .scaleX(1f).scaleY(1f)
                .rotation(0f)
                .setDuration(700)
                .setInterpolator(OvershootInterpolator(1.4f))
                .start()

            // tagline fade + up (延迟 420ms)
            tagline.animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(420)
                .setDuration(600)
                .setInterpolator(DecelerateInterpolator())
                .start()
        }

        return container
    }

    /** 播放启动音效(从 raw/maker_splash.mp3 加载,一次性播放完自动释放)。 */
    private fun playSplashSound(ctx: Context) {
        try {
            val mp = MediaPlayer.create(ctx, R.raw.maker_splash)
            if (mp == null) {
                Log.w(TAG, "Splash sound MediaPlayer.create returned null")
                return
            }
            splashMediaPlayer = mp
            mp.setVolume(0.8f, 0.8f)
            mp.setOnCompletionListener { player ->
                try { player.release() } catch (_: Exception) {}
                if (splashMediaPlayer === player) splashMediaPlayer = null
            }
            mp.setOnErrorListener { player, _, _ ->
                try { player.release() } catch (_: Exception) {}
                if (splashMediaPlayer === player) splashMediaPlayer = null
                true
            }
            mp.start()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to play splash sound", e)
            splashMediaPlayer = null
        }
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
        ctx: Context,
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
        // 与系统浏览器/WebView 行为对齐:不在 onPause/onHiddenChanged 主动 setActive(false),
        // 避免 Gecko 主动把内容进程降到低优先级被系统频繁杀掉、造成黑屏。
        // 仅显式确保激活态;若真的被系统回收,onKill 会置 needsRebuild,此时才重建。
        geckoSession?.setActive(true)
        if (needsRebuild) {
            Log.i(TAG, "onResume: Gecko 进程已被杀,重建 session")
            rebuildSession()
        }
    }

    override fun onPause() {
        super.onPause()
        // 故意不调 setActive(false) — 保持与系统 WebView 一致的后台行为,
        // 短时间切后台回来页面状态(正在编辑的游戏/滚动/表单)完全保留。
    }

    /**
     * MainActivity 用 ft.hide/show 切换 Tab(不触发 onResume/onPause)。
     * 同样不主动停活 Tab,保证切回来就是原页面;只有 onKill 标记时才重建。
     */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) {
            Log.d(TAG, "onHiddenChanged: shown, needsRebuild=$needsRebuild")
            geckoSession?.setActive(true)
            if (needsRebuild) {
                rebuildSession()
            }
        }
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }

    companion object {
        private const val TAG = "MakerGeckoView"
        private const val MAKER_URL = "https://maker.taptap.cn/"
        private const val REQUEST_FILE_CHOOSER = 2001

        // splash 最长展示时间 —— 即便页面卡住也会强制淡出,避免永久遮挡。
        private const val SPLASH_MAX_MS = 6000L
        // 进程级标志:本进程内首次进入 Maker Tab 才显示 splash,
        // Tab 切换、回退、session 重建都不会重复触发。
        @Volatile
        private var splashShownInProcess: Boolean = false

        // iPad Safari UA(平板模式)。
        // 与 VIEWPORT_MODE_MOBILE + USER_AGENT_MODE_MOBILE 配合,让 maker.taptap.cn 下发平板版页面,
        // 兼顾触屏操作体验和完整的登录入口(TapTap App 扫码 / QQ / 微信 / 手机号)。
        private const val IPAD_UA =
            "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
            "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

        @Volatile
        private var runtime: GeckoRuntime? = null

        fun getRuntime(context: Context): GeckoRuntime {
            runtime?.let { return it }
            synchronized(this) {
                runtime?.let { return it }

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
