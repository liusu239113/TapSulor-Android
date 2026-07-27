package com.taptapgain

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.*
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class ExplorerActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableImmersiveMode()
        webView = WebView(this).apply webView@{
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true; useWideViewPort = true; loadWithOverviewMode = true
                setSupportZoom(true); builtInZoomControls = true; displayZoomControls = false
                userAgentString = settings.userAgentString.replace("; wv", "")
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this@webView, true)
            }
            webViewClient = WebViewClient(); webChromeClient = WebChromeClient()
            setOnLongClickListener { v ->
                val wv = v as? WebView ?: return@setOnLongClickListener false
                val result = wv.hitTestResult
                if (result != null && (result.type == WebView.HitTestResult.IMAGE_TYPE || result.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE)) {
                    val imgUrl = result.extra
                    if (!imgUrl.isNullOrEmpty()) {
                        AlertDialog.Builder(this@ExplorerActivity)
                            .setItems(arrayOf("保存图片到相册")) { _, _ ->
                                ImageSaver.saveImageFromUrl(this@ExplorerActivity, imgUrl)
                            }
                            .show()
                        return@setOnLongClickListener true
                    }
                }
                false
            }
        }
        setContentView(webView)
        val accountManager = AccountManager(this)
        val devId = accountManager.getDeveloperId()
        accountManager.restoreCurrentCookies {
            webView.loadUrl(if (devId != null) "https://developer.taptap.cn/v3/$devId/all-app" else "https://developer.taptap.cn/")
        }
    }

    override fun onBackPressed() { if (webView.canGoBack()) webView.goBack() else super.onBackPressed() }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    override fun onDestroy() { webView.destroy(); super.onDestroy() }
}