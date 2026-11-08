package com.taptapgain

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * REP 授权页：rep.taptap.cn 首次使用需要账号确认授权（accounts.taptap.cn/authorize）。
 * 隐藏 WebView 无法点“确认登录”，所以这里给用户一个可见页面，点一次后
 * op-jwt-token 会写进本 App 的 localStorage，之后 repToken 直接读取。
 */
class RepAuthActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_DEVELOPER_ID = "developer_id"
        const val REQUEST_CODE = 1002

        fun start(activity: Activity, developerId: String) {
            activity.startActivityForResult(
                Intent(activity, RepAuthActivity::class.java)
                    .putExtra(EXTRA_DEVELOPER_ID, developerId),
                REQUEST_CODE
            )
        }
    }

    private lateinit var webView: WebView
    private lateinit var accountManager: AccountManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableImmersiveMode()
        val developerId = intent?.getStringExtra(EXTRA_DEVELOPER_ID).orEmpty()
        accountManager = AccountManager(this)

        webView = WebView(this).apply outer@{
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.userAgentString = settings.userAgentString.replace("; wv", "")
            val cm = android.webkit.CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(this@outer, true)
            try {
                val accId = accountManager.getCurrentAccountId()
                listOf(
                    "https://developer.taptap.cn/",
                    "https://accounts.taptap.cn/",
                    "https://rep.taptap.cn/"
                ).forEach { u ->
                    val url = u.toHttpUrlOrNull() ?: return@forEach
                    accountManager.getCookiesForUrl(accId, url).forEach { c ->
                        cm.setCookie(u, c.name + "=" + c.value)
                    }
                }
                cm.flush()
            } catch (_: Exception) { }

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    pollToken(0)
                }
            }
        }
        setContentView(webView)
        webView.loadUrl("https://rep.taptap.cn/$developerId/")
    }

    private fun pollToken(tries: Int) {
        if (tries > 45 || isFinishing || isDestroyed) return
        webView.evaluateJavascript(
            "(function(){try{return localStorage.getItem('op-jwt-token')||''}catch(e){return ''}})()"
        ) { v ->
            val token = (v ?: "").trim().trim('"')
            if (token.isNotEmpty()) {
                // 把这次登录/授权过程中拿到的 accounts/rep Cookie 回存到账号仓库，
                // 否则下次冷启动 restore 会再次丢掉 SSO 会话
                try {
                    accountManager.importCookiesFromWebView(accountManager.getCurrentAccountId())
                } catch (_: Exception) { }
                setResult(Activity.RESULT_OK)
                finish()
            } else if (!isFinishing) {
                webView.postDelayed({ pollToken(tries + 1) }, 700)
            }
        }
    }

    override fun onBackPressed() {
        // 即使没走完授权，只要在页面里登录过，也把 accounts 会话回存
        try {
            accountManager.importCookiesFromWebView(accountManager.getCurrentAccountId())
        } catch (_: Exception) { }
        if (webView.canGoBack()) webView.goBack() else {
            setResult(Activity.RESULT_CANCELED)
            super.onBackPressed()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
