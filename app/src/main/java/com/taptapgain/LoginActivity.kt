package com.taptapgain

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity

class LoginActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    companion object {
        const val REQUEST_CODE_LOGIN = 1001
        const val EXTRA_RESULT_LOGIN_SUCCESS = "login_success"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply { self ->
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true; useWideViewPort = true; loadWithOverviewMode = true
                setSupportZoom(true); builtInZoomControls = true; displayZoomControls = false
                userAgentString = settings.userAgentString.replace("; wv", "")
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(self, true)
            }
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    if (url?.startsWith("https://developer.taptap.cn/") == true) checkLoginDelayed(view)
                }
            }
            addJavascriptInterface(object {
                @JavascriptInterface fun onLoginSuccess() {
                    runOnUiThread {
                        setResult(Activity.RESULT_OK, Intent().apply { putExtra(EXTRA_RESULT_LOGIN_SUCCESS, true) })
                        finish()
                    }
                }
            }, "AndroidLoginBridge")
        }
        setContentView(webView)
        webView.loadUrl(intent?.getStringExtra("start_url") ?: "https://developer.taptap.cn/")
    }

    private fun checkLoginDelayed(view: WebView?) {
        view?.postDelayed({
            view.evaluateJavascript("""(function(){fetch('https://developer.taptap.cn/api/user/v1/me').then(r=>r.json()).then(d=>{if(d&&d.data&&(d.data.developer_id||d.data.developerId))AndroidLoginBridge.onLoginSuccess()}).catch(()=>{})})()""", null)
        }, 1500)
    }

    override fun onBackPressed() { if (webView.canGoBack()) webView.goBack() else { setResult(Activity.RESULT_CANCELED); super.onBackPressed() } }
    override fun onDestroy() { webView.destroy(); super.onDestroy() }
}