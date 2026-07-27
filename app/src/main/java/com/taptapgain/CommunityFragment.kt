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
import androidx.fragment.app.Fragment

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
    private var introContainer: LinearLayout? = null
    private var inWebMode: Boolean = false

    // Theme-tracking references for intro page
    private var tvTitle: TextView? = null
    private var tvSub: TextView? = null
    private var tvUrlLabel: TextView? = null
    private var tvUrlHint: TextView? = null
    private var tvUrl: TextView? = null
    private var tvTip: TextView? = null
    private var tvEntryName: TextView? = null
    private var tvEntryHint: TextView? = null
    private val stepNumTvs = mutableListOf<TextView>()
    private val stepTextTvs = mutableListOf<TextView>()
    private val cardBgs = mutableListOf<GradientDrawable>()
    private val numBoxBgs = mutableListOf<GradientDrawable>()
    private var urlCardBg: GradientDrawable? = null
    private var entryBg: GradientDrawable? = null
    private var dividerView: View? = null

    private data class ThemedViews(
        val backBtn: TextView, val titleText: TextView,
        val refreshBtn: TextView, val closeBtn: TextView
    )
    private var themedViews: ThemedViews? = null

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        val ctx = requireContext()
        val act = requireActivity()

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        rootLayout = root

        val tb = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48)
            )
        }
        topBar = tb

        backBtn = TextView(ctx).apply {
            text = "←"; textSize = 22f; gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "返回"; isClickable = true
            isEnabled = false; alpha = 0.4f
            setOnClickListener {
                val wv = webView
                if (inWebMode && wv != null && wv.canGoBack()) wv.goBack()
                else (act as? MainActivity)?.switchToTab(R.id.nav_home)
            }
        }

        titleText = TextView(ctx).apply {
            text = "Sulor 社区"; textSize = 16f; gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                marginStart = dp(8)
            }
            setSingleLine(); maxLines = 1
        }

        refreshBtn = TextView(ctx).apply {
            text = "⟳"; textSize = 22f; gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "刷新"; isClickable = true
            isEnabled = false; alpha = 0.4f
            setOnClickListener { webView?.reload() }
        }

        closeBtn = TextView(ctx).apply {
            text = "✕"; textSize = 18f; gravity = Gravity.CENTER
            setTextColor(ContextCompat_getColor(ctx, R.color.color_error))
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            contentDescription = "关闭"; isClickable = true
            setOnClickListener { (act as? MainActivity)?.switchToTab(R.id.nav_home) }
        }

        tb.addView(backBtn); tb.addView(titleText); tb.addView(refreshBtn); tb.addView(closeBtn)

        contentContainer = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }

        val intro = buildIntroView(ctx)
        introScroll = intro
        contentContainer!!.addView(intro)

        root.addView(tb); root.addView(contentContainer)

        return root
    }

    override fun onResume() {
        super.onResume()
        applyAllTheme()
        webView?.onResume()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) applyAllTheme()
    }

    private fun applyAllTheme() {
        val ctx = context ?: return
        // Top bar buttons
        val tf = FontHelper.currentTypeface(ctx) ?: Typeface.DEFAULT
        val accent = FontHelper.currentAccentColor(ctx)
        val isDark = FontHelper.isDarkMode(ctx)

        val pageBg = if (isDark) 0xFF141820.toInt() else 0xFFF5F6F8.toInt()
        val barBg  = if (isDark) 0xFF1A2030.toInt() else 0xFFFFFFFF.toInt()
        val cardBg = if (isDark) 0xFF1A2030.toInt() else 0xFFFFFFFF.toInt()
        val textPri = if (isDark) 0xFFFFFFFF.toInt() else 0xFF1A1A1A.toInt()
        val textSec = if (isDark) 0xFFB0B0B0.toInt() else 0xFF666666.toInt()
        val divC   = if (isDark) 0xFF2A2F3A.toInt() else 0xFFE0E2E8.toInt()
        val semiA  = Color.argb(24, Color.red(accent), Color.green(accent), Color.blue(accent))

        rootLayout?.setBackgroundColor(pageBg)
        topBar?.setBackgroundColor(barBg)
        introScroll?.setBackgroundColor(pageBg)

        backBtn?.apply { typeface = tf; setTextColor(accent) }
        refreshBtn?.apply { typeface = tf; setTextColor(accent) }
        titleText?.apply { typeface = tf; setTextColor(textPri) }
        closeBtn?.apply { typeface = tf }

        // Intro page colors
        tvTitle?.apply { typeface = tf; setTextColor(accent) }
        tvSub?.apply { typeface = tf; setTextColor(textSec) }
        tvUrlLabel?.apply { typeface = tf; setTextColor(accent) }
        tvUrl?.apply { setTextColor(textPri) }
        tvUrlHint?.apply { typeface = tf; setTextColor(textSec) }
        tvTip?.apply { typeface = tf; setTextColor(textSec) }
        tvEntryName?.apply { typeface = tf; setTextColor(accent) }
        tvEntryHint?.apply { typeface = tf; setTextColor(textSec) }
        stepNumTvs.forEach { it.typeface = Typeface.DEFAULT_BOLD; it.setTextColor(accent) }
        stepTextTvs.forEach { it.typeface = tf; it.setTextColor(textPri) }

        cardBgs.forEach { it.setColor(cardBg); it.setStroke(dp(2), accent) }
        numBoxBgs.forEach { it.setColor(semiA); it.setStroke(dp(1), accent) }
        urlCardBg?.setColor(semiA); urlCardBg?.setStroke(dp(1), accent)
        entryBg?.setColor(cardBg); entryBg?.setStroke(dp(2), accent)
        dividerView?.setBackgroundColor(divC)
    }

    @SuppressLint("SetTextI18n")
    private fun buildIntroView(ctx: android.content.Context): ScrollView {
        val isDark = FontHelper.isDarkMode(ctx)
        val accent = FontHelper.currentAccentColor(ctx)
        val textPri = if (isDark) 0xFFFFFFFF.toInt() else 0xFF1A1A1A.toInt()
        val textSec = if (isDark) 0xFFB0B0B0.toInt() else 0xFF666666.toInt()
        val cardBg = if (isDark) 0xFF1A2030.toInt() else 0xFFFFFFFF.toInt()
        val pageBg = if (isDark) 0xFF141820.toInt() else 0xFFF5F6F8.toInt()
        val divC  = if (isDark) 0xFF2A2F3A.toInt() else 0xFFE0E2E8.toInt()
        val semiA = Color.argb(24, Color.red(accent), Color.green(accent), Color.blue(accent))

        val scroll = ScrollView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            isFillViewport = true; setBackgroundColor(pageBg)
            setPadding(dp(16), dp(20), dp(16), dp(80))
            clipToPadding = false
        }

        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        introContainer = container

        fun makeTv(txt: String, sz: Float, col: Int, bold: Boolean = false,
                   sel: Boolean = false): TextView = TextView(ctx).apply {
            text = txt; setTextColor(col); textSize = sz
            if (bold) typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            if (sel) setTextIsSelectable(true)
            includeFontPadding = true
        }

        tvTitle = makeTv("Sulor Game · 游戏上传指南", 20f, accent, bold = true).also {
            it.setPadding(0, 0, 0, dp(6)); container.addView(it)
        }
        tvSub = makeTv("上传你的独立游戏作品，即可领取 Tap 官方 1000 REP 奖励金", 13f, textSec).also {
            it.setPadding(dp(8), 0, dp(8), dp(18)); container.addView(it)
        }

        data class Step(val n: Int, val t: String)
        val steps = listOf(
            Step(1, "进入 Sulor Game 网站，准备上传你的游戏作品"),
            Step(2, "二维码需从「Tap 资源置换平台」获取：选择游戏 → 上传资源板块 → 官网品牌挂件 → 游戏详情页生成二维码 → 下载"),
            Step(3, "在 Sulor Game 提交时，官网链接填写下方地址，二维码用刚才下载的图片"),
            Step(4, "上传游戏图标和封面图（从 TapTap 商店后台获取）"),
            Step(5, "点击「提交审核」，可联系站长加速审核"),
            Step(6, "审核通过即可领取 Tap 官方 1000 REP 奖励金")
        )

        steps.forEach { s ->
            val bd = GradientDrawable().apply {
                setColor(cardBg); setStroke(dp(2), accent); cornerRadius = 0f
                cardBgs.add(this)
            }
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP
                setPadding(dp(16), dp(16), dp(16), dp(20))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(12) }
                background = bd
            }
            val nbd = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE; setColor(semiA)
                setStroke(dp(1), accent); cornerRadius = 0f
                numBoxBgs.add(this)
            }
            val numTv = makeTv("${s.n}", 14f, accent, bold = true).apply {
                val sz = dp(30)
                layoutParams = LinearLayout.LayoutParams(sz, sz).apply { marginEnd = dp(14); topMargin = dp(2) }
                background = nbd
            }
            stepNumTvs.add(numTv)
            row.addView(numTv)
            val lineH = dp(22)
            val minLines = when (s.n) { 2, 3 -> 3; else -> 1 }
            val txtTv = makeTv(s.t, 14f, textPri, sel = true).apply {
                gravity = Gravity.TOP or Gravity.START
                setLineSpacing(dp(4).toFloat(), 1.0f)
                includeFontPadding = false
                minHeight = lineH * minLines
                setPadding(0, dp(2), 0, dp(2))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            stepTextTvs.add(txtTv)
            row.addView(txtTv)
            container.addView(row)
        }

        // URL card
        val ubd = GradientDrawable().apply {
            setColor(semiA); setStroke(dp(1), accent); cornerRadius = 0f
        }
        urlCardBg = ubd
        val urlCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4); bottomMargin = dp(14) }
            background = ubd
        }
        tvUrlLabel = makeTv("官网地址（填写用）", 12f, accent).apply {
            setPadding(0, 0, 0, dp(6)); urlCard.addView(this)
        }
        tvUrl = makeTv(COMMUNITY_URL, 14f, textPri, sel = true).apply {
            typeface = Typeface.MONOSPACE
            setPadding(dp(10), dp(8), dp(10), dp(8)); urlCard.addView(this)
        }
        tvUrlHint = makeTv("长按可复制", 11f, textSec).apply {
            setPadding(0, dp(4), 0, 0); urlCard.addView(this)
        }
        container.addView(urlCard)

        tvTip = makeTv("可参考画廊中其他游戏的提交方式，每款游戏均可领取一次 1000 REP 奖励",
            12f, textSec, sel = true).apply {
            setPadding(0, 0, 0, dp(16)); container.addView(this)
        }

        dividerView = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)
            ).apply { bottomMargin = dp(16) }
            setBackgroundColor(divC)
        }
        container.addView(dividerView)

        // Entry
        val ebd = GradientDrawable().apply {
            setColor(cardBg); setStroke(dp(2), accent); cornerRadius = 0f
        }
        entryBg = ebd
        val entry = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            isClickable = true; isFocusable = true
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = ebd
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
            setOnClickListener { enterWebsite() }
        }
        entry.addView(ImageView(ctx).apply {
            setImageResource(R.drawable.sulor_logo)
            val sz = dp(72)
            layoutParams = LinearLayout.LayoutParams(sz, sz).apply { bottomMargin = dp(12) }
            scaleType = ImageView.ScaleType.CENTER_CROP
        })
        tvEntryName = makeTv("Sulor Game", 16f, accent, bold = true).also { entry.addView(it) }
        tvEntryHint = makeTv("点击进入网站", 12f, textSec).apply {
            setPadding(0, dp(3), 0, 0); entry.addView(this)
        }
        container.addView(entry)
        scroll.addView(container)
        return scroll
    }

    private fun enterWebsite() {
        val ctx = context ?: return
        val wv = createWebView(ctx)
        webView = wv
        contentContainer!!.removeAllViews()
        contentContainer!!.addView(wv)
        inWebMode = true
        refreshBtn?.isEnabled = true; refreshBtn?.alpha = 1.0f
        backBtn?.isEnabled = true; backBtn?.alpha = 1.0f
        wv.loadUrl(COMMUNITY_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(ctx: android.content.Context): WebView {
        return WebView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
                useWideViewPort = true; loadWithOverviewMode = true
                setSupportZoom(true); builtInZoomControls = true; displayZoomControls = false
                allowFileAccess = true; cacheMode = WebSettings.LOAD_DEFAULT
                userAgentString = settings.userAgentString.replace("; wv", "")
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                mediaPlaybackRequiresUserGesture = false
            }
            android.webkit.CookieManager.getInstance().setAcceptCookie(true)
            android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    backBtn?.isEnabled = true; backBtn?.alpha = 1.0f
                }
                override fun shouldOverrideUrlLoading(view: WebView, req: android.webkit.WebResourceRequest): Boolean {
                    val url = req.url.toString()
                    if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, req.url)) }
                        catch (_: Exception) {}
                        return true
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
        webView?.let { it.stopLoading(); it.removeAllViews(); it.destroy() }
        webView = null
    }

    override fun onPause() { super.onPause(); webView?.onPause() }

    override fun onDestroyView() { destroyWebView(); super.onDestroyView() }

    private fun dp(v: Int): Int {
        val d = resources.displayMetrics.density
        return (v * d + 0.5f).toInt()
    }

    // Local helper to avoid needing ContextCompat import for colors
    private fun ContextCompat_getColor(ctx: android.content.Context, res: Int): Int =
        androidx.core.content.ContextCompat.getColor(ctx, res)

    companion object {
        private const val COMMUNITY_URL = "https://sulor.yanyususu.online/"
    }
}
