package com.taptapgain

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Message
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var accountManager: AccountManager
    private var checking = false
    private var finished = false
    private var nativeCheckAttempts = 0
    private val apiClient = TapTapApiClient()

    companion object {
        const val REQUEST_CODE_LOGIN = 1001
        const val EXTRA_RESULT_LOGIN_SUCCESS = "login_success"
        const val EXTRA_DEVELOPER_ID = "developer_id"
        const val EXTRA_LOGIN_MODE_ADD = "login_mode_add"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accountManager = AccountManager(this)
        configureWebView()
        setContentView(webView)
        if (intent?.getStringExtra("mode") == "add") {
            accountManager.clearWebViewCookies { webView.loadUrl("https://developer.taptap.cn/") }
        } else {
            webView.loadUrl("https://developer.taptap.cn/")
        }
    }

    private fun configureWebView() {
        webView = WebView(this).apply outer@{
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                javaScriptCanOpenWindowsAutomatically = true
                setSupportMultipleWindows(true)
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
                userAgentString = settings.userAgentString.replace("; wv", "")
            }
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this@outer, true)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    scheduleLoginCheck(view)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    scheduleLoginCheck(view)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: Message?
                ): Boolean {
                    val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                    transport.webView = view
                    resultMsg.sendToTarget()
                    return true
                }
            }
            addJavascriptInterface(object {
                @JavascriptInterface
                fun onLoginSuccess(developerId: String) = finishLogin(developerId)
            }, "AndroidLoginBridge")
        }
    }

    private fun scheduleLoginCheck(view: WebView?) {
        view ?: return
        view.postDelayed({ checkLogin(view) }, 900)
        view.postDelayed({ checkLoginNatively() }, 1400)
    }

    private fun checkLoginNatively() {
        if (finished || isFinishing || nativeCheckAttempts >= 12) return
        nativeCheckAttempts++
        lifecycleScope.launch {
            val result = apiClient.checkLoginStatus()
            if (result.status == "ready" && result.developerId != null) {
                finishLogin(result.developerId)
            } else if (!finished) {
                webView.postDelayed({ checkLoginNatively() }, 1800)
            }
        }
    }

    private fun checkLogin(view: WebView) {
        if (checking || finished || isFinishing) return
        checking = true
        view.evaluateJavascript(
            """(async function(){
                try {
                    const urls = ['/api/user/v1/me', '/api/developer/v1/list'];
                    for (const path of urls) {
                        const response = await fetch(path, {credentials:'include'});
                        if (!response.ok) continue;
                        const payload = await response.json();
                        const data = payload && payload.data;
                        const list = Array.isArray(data) ? data : (data && (data.list || data.items || data.developers));
                        const directId = data && (data.developer_id || data.developerId || (data.developer && data.developer.id));
                        const first = Array.isArray(list) && list.length > 0 ? list[0] : null;
                        const listId = first && (first.developer_id || first.developerId || first.id);
                        const id = directId || listId;
                        if (id) {
                            AndroidLoginBridge.onLoginSuccess(String(id));
                            return;
                        }
                    }
                } catch (e) {}
            })()""",
            null
        )
        view.postDelayed({ checking = false }, 1200)
    }

    private fun finishLogin(developerId: String) {
        if (finished || isFinishing || !developerId.matches(Regex("\\d+"))) return
        finished = true
        setResult(
            Activity.RESULT_OK,
            Intent()
                .putExtra(EXTRA_RESULT_LOGIN_SUCCESS, true)
                .putExtra(EXTRA_DEVELOPER_ID, developerId)
                .putExtra(EXTRA_LOGIN_MODE_ADD, intent?.getStringExtra("mode") == "add")
        )
        finish()
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else {
            setResult(Activity.RESULT_CANCELED)
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
