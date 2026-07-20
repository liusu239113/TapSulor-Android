package com.taptapgain

import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var webAppInterface: WebAppInterface
    private lateinit var accountManager: AccountManager
    private lateinit var apiClient: TapTapApiClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountManager = AccountManager(this)
        apiClient = TapTapApiClient(accountManager)
        webView = WebView(this).apply outer@{
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
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
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this@outer, true)

            val assetLoader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
                .build()

            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }
            }
            webChromeClient = WebChromeClient()
        }

        setContentView(webView)
        webAppInterface = WebAppInterface(this, webView, accountManager, apiClient)
        webAppInterface.register()
        accountManager.restoreCurrentCookies {
            webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        }
    }

    @Deprecated("Use registerForActivityResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != LoginActivity.REQUEST_CODE_LOGIN || resultCode != RESULT_OK) return

        val developerId = data?.getStringExtra(LoginActivity.EXTRA_DEVELOPER_ID)
        val addMode = data?.getBooleanExtra(LoginActivity.EXTRA_LOGIN_MODE_ADD, false) ?: false
        if (!developerId.isNullOrBlank()) {
            val update = accountManager.setDeveloperId(developerId, addMode)
            accountManager.captureCurrentSessionCookies()
            webAppInterface.notifyAccountUpdated(update)
        }
        webAppInterface.notifyLoginSuccess()
        webView.postDelayed({
            webView.evaluateJavascript(
                "if(window.electronAPI&&window.electronAPI.checkLogin)window.electronAPI.checkLogin()",
                null
            )
        }, 500)
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        webAppInterface.destroy()
        webView.destroy()
        super.onDestroy()
    }
}
