package com.taptapgain

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment

/**
 * 社区 Tab：引导页 + Sulor Game 网站入口。
 *
 * 字体/主题/深浅全部通过 FontHelper 实时读取：
 *  - onResume：切回 App / 从其他页面返回
 *  - onHiddenChanged(false)：从其他 Tab 切回来时也刷新（解决实时同步问题）
 *
 * UI 风格与 app 保持一致：直角方块、accent 色边框、无圆角。
 * 加大了行高和 padding，兼容 Pixel/潮酷等宽字体不被裁剪。
 */
class CommunityFragment : Fragment() {

    private var webView: WebView? = null
    private lateinit var titleText: TextView
    private var backBtn: TextView? = null
    private var refreshBtn: TextView? = null
    private var closeBtn: TextView? = null
    private var rootLayout: LinearLayout? = null
    private var topBar: LinearLayout? = null
    private var contentContainer: FrameLayout? = null
    private var introScroll: ScrollView? = null
    private var inWebMode: Boolean = false

    // 介绍页元素引用（供主题刷新使用）
    private var introRoot: LinearLayout? = null
    private var introAllTvs: List<TextView> = emptyList()
    private var introAccentTvs: List<TextView> = emptyList()
    private var introCardBgs: List<GradientDrawable> = emptyList()
    private var introCircleBgs: List<GradientDrawable> = emptyList()
    private var urlCardBg: GradientDrawable? = null
    private var entryBg: GradientDrawable? = null
    private var introUrlTv: TextView? = null
    private var dividerView: View? = null

    private data class ThemedViews(
        val backBtn: TextView, val titleText: TextView,
        val refreshBtn: TextView, val closeBtn: TextView
    )
    private var themedViews: ThemedViews? = null

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

        // === 顶栏（直角，与其他页面一致）===
        topBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            // bg set dynamically via refreshAll()
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
                val wv = webView
                if (inWebMode && wv != null && wv.canGoBack()) {
                    wv.goBack()
                } else {
                    (act as? MainActivity)?.switchToTab(R.id.nav_home)
                }
            }
        }

        titleText = TextView(ctx).apply {
            text = "Sulor 社区"
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
            isEnabled = false
            alpha = 0.4f
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

        topBar!!.addView(backBtn)
        topBar!!.addView(titleText)
        topBar!!.addView(refreshBtn)
        topBar!!.addView(closeBtn)

        contentContainer = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        val intro = buildIntroView(ctx)
        introScroll = intro
        contentContainer!!.addView(intro)

        rootLayout = root
        root.addView(topBar)
        root.addView(contentContainer)

        applyNativeTheme(backBtn!!, titleText, refreshBtn!!, closeBtn!!)

        return root
    }

    /** 实时刷新介绍页的字体、主题色、深浅模式 */
    private fun refreshIntroTheme() {
        val ctx = context ?: return
        val tf = FontHelper.currentTypeface(ctx) ?: Typeface.DEFAULT
        introAllTvs.forEach { it.typeface = tf }

        val accent = FontHelper.currentAccentColor(ctx)
        introAccentTvs.forEach { it.setTextColor(accent) }

        // 深浅模式背景色
        val isDark = FontHelper.isDarkMode(ctx)
        val pageBg = if (isDark) 0xFF141820.toInt() else 0xFFF5F6F8.toInt()
        val cardBg = if (isDark) 0xFF1A2030.toInt() else 0xFFFFFFFF.toInt()
        val textPrimary = if (isDark) 0xFFFFFFFF.toInt() else 0xFF1A1A1A.toInt()
        val textSecondary = if (isDark) 0xFFB0B0B0.toInt() else 0xFF666666.toInt()
        val dividerC = if (isDark) 0xFF1A2030.toInt() else 0xFFE0E2E8.toInt()

        introRoot?.setBackgroundColor(pageBg)
        introScroll?.setBackgroundColor(pageBg)
        introCardBgs.forEach { it.setColor(cardBg); it.setStroke(dp(2), accent) }
        introCircleBgs.forEach {
            it.setColor(Color.argb(24, Color.red(accent), Color.green(accent), Color.blue(accent)))
            it.setStroke(dp(1), accent)
        }
        urlCardBg?.let {
            it.setColor(Color.argb(24, Color.red(accent), Color.green(accent), Color.blue(accent)))
            it.setStroke(dp(1), accent)
        }
        entryBg?.let { it.setColor(cardBg); it.setStroke(dp(2), accent) }
        dividerView?.setBackgroundColor(dividerC)

        // 非强调色文字也刷新深浅
        introAllTvs.forEach { tv ->
            when {
                introAccentTvs.contains(tv) -> {} // already set accent
                tv === introUrlTv -> tv.setTextColor(textPrimary)
                tv.tag == "secondary" -> tv.setTextColor(textSecondary)
                else -> {} // primary text stays
            }
        }
        // 重新设置 primary 色的普通文字
        introRoot?.let { root ->
            setPrimaryTextColors(root, textPrimary, textSecondary)
        }
    }

    /** 递归设置容器内非强调色 TextView 的颜色 */
    private fun setPrimaryTextColors(parent: ViewGroup, primary: Int, secondary: Int) {
        for (i in 0 until parent.childCount) {
            val child = parent.getChildAt(i)
            if (child is TextView && child !in introAccentTvs && child !== introUrlTv) {
                if (child.tag == "secondary") {
                    child.setTextColor(secondary)
                } else if (child.tag != "accent") {
                    child.setTextColor(primary)
                }
            }
            if (child is ViewGroup) setPrimaryTextColors(child, primary, secondary)
        }
    }

    @SuppressLint("SetTextI18n")
    private fun buildIntroView(ctx: android.content.Context): ScrollView {
        val isDark = FontHelper.isDarkMode(ctx)
        val accent = FontHelper.currentAccentColor(ctx)
        val pageBg = if (isDark) 0xFF141820.toInt() else 0xFFF5F6F8.toInt()
        val cardBg = if (isDark) 0xFF1A2030.toInt() else 0xFFFFFFFF.toInt()
        val textPrimary = if (isDark) 0xFFFFFFFF.toInt() else 0xFF1A1A1A.toInt()
        val textSecondary = if (isDark) 0xFFB0B0B0.toInt() else 0xFF666666.toInt()
        val dividerC = if (isDark) 0xFF1A2030.toInt() else 0xFFE0E2E8.toInt()
        val semiAccent = Color.argb(24, Color.red(accent), Color.green(accent), Color.blue(accent))

        val scroll = ScrollView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            isFillViewport = true
            setBackgroundColor(pageBg)
            // 底部额外 padding 避免被导航栏/裁剪
            setPadding(dp(16), dp(20), dp(16), dp(40))
            clipToPadding = false
        }

        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        introRoot = container

        val allTvs = mutableListOf<TextView>()
        val accentTvs = mutableListOf<TextView>()
        val cardBgs = mutableListOf<GradientDrawable>()
        val circleBgs = mutableListOf<GradientDrawable>()

        fun tv(text: String, size: Float, color: Int, bold: Boolean = false,
               selectable: Boolean = false, tag: String = "primary"): TextView {
            return TextView(ctx).apply {
                this.text = text
                setTextColor(color)
                textSize = size
                if (bold) typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                if (selectable) setTextIsSelectable(true)
                this.tag = tag
                allTvs.add(this)
                if (color == accent) accentTvs.add(this)
            }
        }

        // 标题
        container.addView(tv("Sulor Game · 游戏上传指南", 20f, accent, bold = true).apply {
            setPadding(0, 0, 0, dp(6))
        })

        // 副标题
        container.addView(tv("上传你的独立游戏作品，即可领取 Tap 官方 1000 REP 奖励金",
            13f, textSecondary, tag = "secondary").apply {
            setPadding(dp(8), 0, dp(8), dp(18))
        })

        data class Step(val num: Int, val text: String)
        val steps = listOf(
            Step(1, "进入 Sulor Game 网站，准备上传你的游戏作品"),
            Step(2, "二维码资料需从「Tap 资源置换平台」获取：选择你的游戏 → 点击「上传资源板块」→ 点击上方「官网品牌挂件」→ 选择「游戏详情页生成二维码」→ 下载二维码"),
            Step(3, "在 Sulor Game 提交时，官网链接填写下方地址，二维码使用上一步下载的图片"),
            Step(4, "上传游戏图标和封面图（从 TapTap 商店后台获取）"),
            Step(5, "点击「提交审核」，可联系站长加速审核"),
            Step(6, "审核通过后即可领取价值 Tap 官方 1000 REP 的奖励金")
        )

        steps.forEach { step ->
            val cardBd = GradientDrawable().apply {
                setColor(cardBg)
                setStroke(dp(2), accent)
                cornerRadius = 0f  // 直角
                cardBgs.add(this)
            }
            val card = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.TOP
                setPadding(dp(14), dp(14), dp(14), dp(14))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                background = cardBd
            }

            val circleBd = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE  // 方块代替圆圈
                setColor(semiAccent)
                setStroke(dp(1), accent)
                cornerRadius = 0f
                circleBgs.add(this)
            }

            val numBox = TextView(ctx).apply {
                text = "${step.num}"
                setTextColor(accent)
                textSize = 14f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                val sz = dp(28)
                layoutParams = LinearLayout.LayoutParams(sz, sz).apply {
                    marginEnd = dp(12)
                    topMargin = dp(0)
                }
                background = circleBd
                tag = "accent"
                allTvs.add(this)
                accentTvs.add(this)
            }
            card.addView(numBox)

            val stepText = TextView(ctx).apply {
                text = step.text
                setTextColor(textPrimary)
                textSize = 14f
                setLineSpacing(dp(6).toFloat(), 1.15f)
                setTextIsSelectable(true)
                includeFontPadding = true
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                tag = "primary"
                allTvs.add(this)
            }
            card.addView(stepText)
            container.addView(card)
        }

        // 官网地址卡片
        val uBg = GradientDrawable().apply {
            setColor(semiAccent)
            setStroke(dp(1), accent)
            cornerRadius = 0f
        }
        urlCardBg = uBg
        val urlCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4); bottomMargin = dp(14) }
            background = uBg
        }
        urlCard.addView(tv("官网地址（填写用）", 12f, accent, tag = "accent").apply {
            setPadding(0, 0, 0, dp(6))
        })
        introUrlTv = TextView(ctx).apply {
            text = COMMUNITY_URL
            setTextColor(textPrimary)
            textSize = 14f
            typeface = Typeface.MONOSPACE
            gravity = Gravity.CENTER
            setTextIsSelectable(true)
            setPadding(dp(10), dp(8), dp(10), dp(8))
            includeFontPadding = true
            tag = "url"
            allTvs.add(this)
        }
        urlCard.addView(introUrlTv)
        urlCard.addView(tv("长按可复制", 11f, textSecondary, tag = "secondary").apply {
            setPadding(0, dp(4), 0, 0)
        })
        container.addView(urlCard)

        // 提示
        container.addView(tv("可参考画廊中其他游戏的提交方式，每款游戏均可领取一次 1000 REP 奖励",
            12f, textSecondary, selectable = true, tag = "secondary").apply {
            setPadding(0, 0, 0, dp(16))
        })

        // 分隔线
        dividerView = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                bottomMargin = dp(16)
            }
            setBackgroundColor(dividerC)
        }
        container.addView(dividerView)

        // 入口卡片（直角方块）
        val eBg = GradientDrawable().apply {
            setColor(cardBg)
            setStroke(dp(2), accent)
            cornerRadius = 0f
        }
        entryBg = eBg
        val entryWrap = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isClickable = true
            isFocusable = true
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = eBg
            setOnClickListener { enterWebsite() }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        entryWrap.addView(ImageView(ctx).apply {
            setImageResource(R.drawable.sulor_logo)
            val sz = dp(72)
            layoutParams = LinearLayout.LayoutParams(sz, sz).apply { bottomMargin = dp(10) }
            scaleType = ImageView.ScaleType.CENTER_CROP
        })
        entryWrap.addView(tv("Sulor Game", 16f, accent, bold = true, tag = "accent"))
        entryWrap.addView(tv("点击进入网站", 12f, textSecondary, tag = "secondary").apply {
            setPadding(0, dp(3), 0, 0)
        })
        container.addView(entryWrap)

        scroll.addView(container)

        introAllTvs = allTvs
        introAccentTvs = accentTvs
        introCardBgs = cardBgs
        introCircleBgs = circleBgs

        return scroll
    }

    private fun enterWebsite() {
        val ctx = context ?: return
        val wv = createWebView(ctx)
        webView = wv
        contentContainer!!.removeAllViews()
        contentContainer!!.addView(wv)
        inWebMode = true
        refreshBtn?.isEnabled = true
        refreshBtn?.alpha = 1.0f
        backBtn?.isEnabled = true
        backBtn?.alpha = 1.0f
        wv.loadUrl(COMMUNITY_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(ctx: android.content.Context): WebView {
        return WebView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
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
                mediaPlaybackRequiresUserGesture = false
            }
            android.webkit.CookieManager.getInstance().setAcceptCookie(true)
            android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    backBtn?.isEnabled = true
                    backBtn?.alpha = 1.0f
                }
                override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        try {
                            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, request.url)
                            startActivity(intent)
                            return true
                        } catch (_: Exception) {}
                    }
                    return false
                }
            }
            webChromeClient = WebChromeClient()
        }
    }

    fun canGoBack(): Boolean = inWebMode && (webView?.canGoBack() ?: false)
    fun goBack() { webView?.goBack() }

    fun destroyWebView() {
        webView?.let { wv ->
            wv.stopLoading()
            wv.removeAllViews()
            wv.destroy()
        }
        webView = null
    }

    override fun onResume() {
        super.onResume()
        refreshAll()
        webView?.onResume()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) refreshAll()
    }

    private fun refreshAll() {
        val ctx = context ?: return
        themedViews?.let { v ->
            FontHelper.applyTopBarStyle(ctx, v.backBtn, v.refreshBtn)
            FontHelper.applyFont(ctx, v.titleText, v.closeBtn)
        }
        refreshIntroTheme()
    }

    override fun onPause() {
        super.onPause()
        webView?.onPause()
    }

    override fun onDestroyView() {
        destroyWebView()
        super.onDestroyView()
    }

    private fun applyNativeTheme(
        backBtn: TextView, titleText: TextView,
        refreshBtn: TextView, closeBtn: TextView
    ) {
        val ctx = requireContext()
        FontHelper.applyTopBarStyle(ctx, backBtn, refreshBtn)
        FontHelper.applyFont(ctx, titleText, closeBtn)
        themedViews = ThemedViews(backBtn, titleText, refreshBtn, closeBtn)
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }

    companion object {
        private const val COMMUNITY_URL = "https://sulor.yanyususu.online/"
    }
}
