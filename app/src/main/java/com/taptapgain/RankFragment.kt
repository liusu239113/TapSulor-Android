package com.taptapgain

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import okhttp3.Request
import androidx.webkit.WebViewClientCompat
import android.widget.FrameLayout
import androidx.fragment.app.Fragment

/**
 * 热度榜页：加载 assets/rank.html
 * 数据全部走公开接口，无需登录；复用 WebAppInterface 的 fetch 能力（同账号 Cookie）。
 */
class RankFragment : Fragment() {

    private var webView: WebView? = null

    private fun isImageUrl(url: String): Boolean {
        val u = url.lowercase()
        return u.contains("tapimg") || u.contains("tapimg.com") || u.endsWith(".png") || u.endsWith(".jpg") ||
            u.endsWith(".jpeg") || u.endsWith(".webp") || u.endsWith(".gif") || u.contains("_tap_appicon")
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val ctx = requireContext()
        val act = requireActivity()
        val accountManager = AccountManager(act)
        val apiClient = TapTapApiClient(accountManager)
        val updateChecker = UpdateChecker(act)

        val wv = WebView(ctx)
        wv.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            allowFileAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = userAgentString.replace("; wv", "")
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        wv.setBackgroundColor(0xFF0F141B.toInt())
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(ctx))
            .build()
        wv.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val asset = assetLoader.shouldInterceptRequest(request.url)
                if (asset != null) return asset
                val url = request.url.toString()
                // 与主页一致：图片走 OkHttp 代拉（带 Referer），否则 CDN 会返回碎图/被拦
                if (isImageUrl(url) && url.startsWith("http")) {
                    try {
                        val req = Request.Builder()
                            .url(url)
                            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
                            .header("Referer", "https://www.taptap.cn/")
                            .build()
                        val resp = apiClient.httpClient.newCall(req).execute()
                        val body = resp.body
                        if (resp.isSuccessful && body != null) {
                            val mime = resp.header("Content-Type")?.substringBefore(";") ?: "image/png"
                            return WebResourceResponse(mime, "utf-8", body.byteStream())
                        }
                    } catch (e: Exception) { }
                }
                return null
            }
        }

        WebAppInterface(requireActivity(), wv, accountManager, apiClient, updateChecker).register()

        wv.loadUrl("https://appassets.androidplatform.net/assets/rank.html")
        webView = wv
        return wv
    }

    override fun onResume() {
        super.onResume()
        pushTheme()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) pushTheme()
    }

    /** 从主页切回来时同步主题（深浅色/强调色/字体），保证与设置一致 */
    private fun pushTheme() {
        webView?.evaluateJavascript(
            "(function(){try{if(window.__applyTheme){window.__applyTheme();}else{" +
            "var d=document.documentElement;d.setAttribute('data-theme',localStorage.getItem('taptap_theme_mode')||'light');" +
            "d.setAttribute('data-accent',localStorage.getItem('taptap_theme_accent')||'cyan');" +
            "var f=localStorage.getItem('taptap_font_family')||'default';" +
            "if(f&&f!=='default')d.setAttribute('data-font',f);else d.removeAttribute('data-font');}}catch(e){}})()",
            null
        )
    }

    override fun onDestroyView() {
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        super.onDestroyView()
    }
}
