package com.taptapgain

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.fragment.app.Fragment

/**
 * 热度榜页：加载 assets/rank.html
 * 数据全部走公开接口，无需登录；复用 WebAppInterface 的 fetch 能力（同账号 Cookie）。
 */
class RankFragment : Fragment() {

    private var webView: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val ctx = requireContext()
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
        wv.webViewClient = WebViewClient()

        val accountManager = AccountManager(ctx)
        val apiClient = TapTapApiClient(accountManager)
        val updateChecker = UpdateChecker(ctx)
        WebAppInterface(requireActivity(), wv, accountManager, apiClient, updateChecker).register()

        wv.loadUrl("file:///android_asset/rank.html")
        webView = wv
        return wv
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
