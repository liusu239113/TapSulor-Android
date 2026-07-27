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
 * 社区 Tab：
 * 1) 进入显示 Sulor Game 上传引导页（步骤说明 + 网站入口 logo）
 * 2) 点击 logo/名称后在同一容器加载 https://sulor.yanyususu.online/
 *    顶栏 ← / Sulor 社区 / ⟳ / ✕ ，与 Maker/Backend 风格一致
 * 字体和主题色全部通过 FontHelper 动态读取，设置页修改后 onResume 立即同步。
 */
class CommunityFragment : Fragment() {

    private var webView: WebView? = null
    private lateinit var titleText: TextView
    private var backBtn: TextView? = null
    private var refreshBtn: TextView? = null
    private var closeBtn: TextView? = null
    private var topBar: LinearLayout? = null
    private var contentContainer: FrameLayout? = null
    private var introView: View? = null
    private var inWebMode: Boolean = false

    // 介绍页中所有需要跟随字体/主题色变化的元素
    private var introAllTextViews: List<TextView> = emptyList()
    private var introAccentDrawables: List<GradientDrawable> = emptyList()
    private var introAccentViews: List<TextView> = emptyList()  // 需要设置 accent text color 的 TextView
    private var introSemiBgViews: List<View> = emptyList()       // 需要半透明 accent 背景的 View
    private var introUrlTv: TextView? = null

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

        // === 顶栏 ===
        topBar = LinearLayout(ctx).apply {
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

        // === 内容容器（切换介绍页 / WebView）===
        contentContainer = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        introView = buildIntroView(ctx)
        contentContainer!!.addView(introView)

        root.addView(topBar)
        root.addView(contentContainer)

        applyNativeTheme(backBtn!!, titleText, refreshBtn!!, closeBtn!!)

        return root
    }

    /** 重新应用介绍页的字体和主题色（onResume 时调用） */
    private fun applyIntroTheme(ctx: android.content.Context) {
        val tf = FontHelper.currentTypeface(ctx) ?: Typeface.DEFAULT
        introAllTextViews.forEach { it.typeface = tf }
        val accent = FontHelper.currentAccentColor(ctx)
        introAccentViews.forEach { it.setTextColor(accent) }
        val semiAccent = Color.argb(24, Color.red(accent), Color.green(accent), Color.blue(accent))
        introSemiBgViews.forEach { (it.background as? GradientDrawable)?.setColor(semiAccent) }
        introAccentDrawables.forEach { d ->
            d.setStroke(dp(2), accent)
            if (d === introAccentDrawables.firstOrNull()) { /* number circle has 1dp stroke, handled below */ }
        }
        // number circles: stroke width 1dp
        introAccentDrawables.forEachIndexed { i, d ->
            if (i < introAccentDrawables.size - 2) { // circles are first 6
                d.setStroke(dp(1), accent)
            }
        }
        // URL tv uses monospace font, apply custom
        introUrlTv?.typeface = Typeface.MONOSPACE
        introUrlTv?.setTextColor(ContextCompat.getColor(ctx, R.color.text_primary))
    }

    @SuppressLint("SetTextI18n")
    private fun buildIntroView(ctx: android.content.Context): View {
        val scroll = ScrollView(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            isFillViewport = true
        }

        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(20), dp(24), dp(20), dp(24))
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        val accentColor = FontHelper.currentAccentColor(ctx)
        val textColor = ContextCompat.getColor(ctx, R.color.text_primary)
        val dimColor = ContextCompat.getColor(ctx, R.color.text_secondary)
        val cardBg = ContextCompat.getColor(ctx, R.color.bg_top_bar)
        val dividerColor = ContextCompat.getColor(ctx, R.color.bg_divider)
        val semiAccent = Color.argb(24, Color.red(accentColor), Color.green(accentColor), Color.blue(accentColor))

        val allTvs = mutableListOf<TextView>()
        val accentTvs = mutableListOf<TextView>()
        val accentDrawables = mutableListOf<GradientDrawable>()
        val semiBgViews = mutableListOf<View>()

        // 标题
        val titleTv = TextView(ctx).apply {
            text = "Sulor Game · 游戏上传指南"
            setTextColor(accentColor)
            textSize = 20f
            gravity = Gravity.CENTER
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, dp(6))
        }
        allTvs.add(titleTv); accentTvs.add(titleTv)
        container.addView(titleTv)

        val subTv = TextView(ctx).apply {
            text = "上传你的独立游戏作品，即可领取 Tap 官方 1000 REP 奖励金"
            setTextColor(dimColor)
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(dp(8), 0, dp(8), dp(20))
        }
        allTvs.add(subTv)
        container.addView(subTv)

        data class Step(val num: Int, val text: String)
        val steps = listOf(
            Step(1, "进入 Sulor Game 网站，准备上传你的游戏作品"),
            Step(2, "二维码资料需从「Tap 资源置换平台」获取：选择你的游戏 → 点击「上传资源板块」→ 点击上方「官网品牌挂件」→ 选择「游戏详情页生成二维码」→ 下载二维码"),
            Step(3, "在 Sulor Game 提交时，官网链接填写下方地址，二维码使用上一步下载的图片"),
            Step(4, "上传游戏图标和封面图（从 TapTap 商店后台获取）"),
            Step(5, "点击「提交审核」，可联系站长加速审核"),
            Step(6, "审核通过后即可领取价值 Tap 官方 1000 REP 的奖励金 🎉")
        )

        val circleDrawables = mutableListOf<GradientDrawable>()

        steps.forEach { step ->
            val card = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.TOP
                setPadding(dp(14), dp(12), dp(14), dp(12))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                background = GradientDrawable().apply {
                    setColor(cardBg)
                    setStroke(dp(2), accentColor)
                    cornerRadius = dp(10).toFloat()
                    accentDrawables.add(this)
                }
            }

            val circleBg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(semiAccent)
                setStroke(dp(1), accentColor)
                accentDrawables.add(this)
                circleDrawables.add(this)
            }

            val numCircle = TextView(ctx).apply {
                text = "${step.num}"
                setTextColor(accentColor)
                textSize = 14f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                val size = dp(26)
                layoutParams = LinearLayout.LayoutParams(size, size).apply { marginEnd = dp(12) }
                background = circleBg
            }
            allTvs.add(numCircle); accentTvs.add(numCircle)
            card.addView(numCircle)

            val stepTv = TextView(ctx).apply {
                text = step.text
                setTextColor(textColor)
                textSize = 14f
                setLineSpacing(dp(4).toFloat(), 1.0f)
                setTextIsSelectable(true)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            allTvs.add(stepTv)
            card.addView(stepTv)
            container.addView(card)
        }

        // 官网地址卡片
        val urlCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4); bottomMargin = dp(16) }
            background = GradientDrawable().apply {
                setColor(semiAccent)
                setStroke(dp(1), accentColor)
                cornerRadius = dp(10).toFloat()
                accentDrawables.add(this)
            }
        }
        semiBgViews.add(urlCard)

        val urlLabel = TextView(ctx).apply {
            text = "🌐 官网地址（填写用）"
            setTextColor(accentColor)
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(6))
        }
        allTvs.add(urlLabel); accentTvs.add(urlLabel)
        urlCard.addView(urlLabel)

        val urlTv = TextView(ctx).apply {
            text = COMMUNITY_URL
            setTextColor(textColor)
            textSize = 14f
            typeface = Typeface.MONOSPACE
            gravity = Gravity.CENTER
            setTextIsSelectable(true)
            setPadding(dp(8), dp(6), dp(8), dp(6))
        }
        allTvs.add(urlTv); introUrlTv = urlTv
        urlCard.addView(urlTv)

        val urlHint = TextView(ctx).apply {
            text = "↑ 长按可复制"
            setTextColor(dimColor)
            textSize = 11f
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, 0)
        }
        allTvs.add(urlHint)
        urlCard.addView(urlHint)
        container.addView(urlCard)

        // 提示
        val tipTv = TextView(ctx).apply {
            text = "💡 可参考画廊中其他游戏的提交方式，每款游戏均可领取一次 1000 REP 奖励"
            setTextColor(dimColor)
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(18))
            setTextIsSelectable(true)
        }
        allTvs.add(tipTv)
        container.addView(tipTv)

        // 分隔线
        container.addView(View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                bottomMargin = dp(16)
            }
            setBackgroundColor(dividerColor)
        })

        // 入口
        val entryWrap = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isClickable = true
            isFocusable = true
            setPadding(dp(20), dp(16), dp(20), dp(16))
            background = GradientDrawable().apply {
                setColor(cardBg)
                setStroke(dp(2), accentColor)
                cornerRadius = dp(14).toFloat()
                accentDrawables.add(this)
            }
            setOnClickListener { enterWebsite() }
        }

        entryWrap.addView(ImageView(ctx).apply {
            setImageResource(R.drawable.sulor_logo)
            layoutParams = LinearLayout.LayoutParams(dp(72), dp(72)).apply { bottomMargin = dp(8) }
            scaleType = ImageView.ScaleType.CENTER_CROP
        })
        val entryName = TextView(ctx).apply {
            text = "Sulor Game"
            setTextColor(accentColor)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        allTvs.add(entryName); accentTvs.add(entryName)
        entryWrap.addView(entryName)
        val entryHint = TextView(ctx).apply {
            text = "点击进入网站"
            setTextColor(dimColor)
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, dp(2), 0, 0)
        }
        allTvs.add(entryHint)
        entryWrap.addView(entryHint)

        container.addView(entryWrap)
        scroll.addView(container)

        introAllTextViews = allTvs
        introAccentViews = accentTvs
        introAccentDrawables = accentDrawables
        introSemiBgViews = semiBgViews

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
        val ctx = context ?: return
        themedViews?.let { v ->
            FontHelper.applyTopBarStyle(ctx, v.backBtn, v.refreshBtn)
            FontHelper.applyFont(ctx, v.titleText, v.closeBtn)
        }
        applyIntroTheme(ctx)
        webView?.onResume()
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
        FontHelper.applyTopBarStyle(requireContext(), backBtn, refreshBtn)
        FontHelper.applyFont(requireContext(), titleText, closeBtn)
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
