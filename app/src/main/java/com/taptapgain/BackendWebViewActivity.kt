package com.taptapgain

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.io.BufferedReader
import java.io.InputStreamReader

class BackendWebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var titleText: TextView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var themeCss: String = ""
    private var themeJs: String = ""
    private var appName: String = ""
    private var appId: String = ""

    companion object {
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        const val EXTRA_APP_ID = "extra_app_id"
        const val EXTRA_APP_NAME = "extra_app_name"
        private const val REQUEST_FILE_CHOOSER = 1001

        fun start(activity: Activity, appId: String, appName: String) {
            val intent = Intent(activity, BackendWebViewActivity::class.java)
            intent.putExtra(EXTRA_APP_ID, appId)
            intent.putExtra(EXTRA_APP_NAME, appName)
            activity.startActivity(intent)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableImmersiveMode()

        appId = intent.getStringExtra(EXTRA_APP_ID) ?: ""
        appName = intent.getStringExtra(EXTRA_APP_NAME) ?: "游戏后台"

        // Load theme assets
        themeCss = loadAssetText("css/taptap-theme.css")
        themeJs = loadAssetText("js/taptap-theme.js")

        // Build layout: top bar + WebView
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(0xFF141820.toInt())
        }

        // Top bar
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setBackgroundColor(0xFF1A2030.toInt())
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48)
            )
        }

        val backBtn = TextView(this).apply {
            text = "←"
            setTextColor(0xFF00C4CD.toInt())
            textSize = 22f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            setPadding(0, 0, 0, 0)
            contentDescription = "返回"
            isClickable = true
            setOnClickListener {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        }

        titleText = TextView(this).apply {
            text = appName
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 16f
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                marginStart = dp(8)
            }
            setSingleLine()
            maxLines = 1
        }

        val closeBtn = TextView(this).apply {
            text = "✕"
            setTextColor(0xFFFF6B6B.toInt())
            textSize = 18f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(36))
            setPadding(0, 0, 0, 0)
            contentDescription = "关闭"
            isClickable = true
            setOnClickListener { finish() }
        }

        topBar.addView(backBtn)
        topBar.addView(titleText)
        topBar.addView(closeBtn)

        // WebView container
        val webContainer = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        webView = WebView(this).apply {
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
                userAgentString = DESKTOP_UA
                allowFileAccess = true
                allowContentAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this@apply, true)
            }

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    titleText.text = "加载中..."
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    injectTheme()
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    // Stay within developer.taptap.cn
                    return if (url.startsWith("https://developer.taptap.cn") || url.startsWith("https://www.taptap.cn")) {
                        false // Let WebView handle it
                    } else {
                        // Open external links in browser
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        } catch (_: Exception) {}
                        true
                    }
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView?, title: String?) {
                    super.onReceivedTitle(view, title)
                    if (!title.isNullOrEmpty() && !title.contains("TapTap", ignoreCase = true)) {
                        titleText.text = title
                    } else {
                        titleText.text = appName
                    }
                }

                // File chooser for APK/image uploads
                override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    this@BackendWebViewActivity.filePathCallback?.onReceiveValue(null)
                    this@BackendWebViewActivity.filePathCallback = filePathCallback
                    val intent = Intent(Intent.ACTION_GET_CONTENT)
                    intent.addCategory(Intent.CATEGORY_OPENABLE)
                    intent.type = "*/*"
                    try {
                        startActivityForResult(
                            Intent.createChooser(intent, "选择文件"),
                            REQUEST_FILE_CHOOSER
                        )
                    } catch (e: Exception) {
                        this@BackendWebViewActivity.filePathCallback = null
                        return false
                    }
                    return true
                }
            }
        }

        webContainer.addView(webView)
        root.addView(topBar)
        root.addView(webContainer)
        setContentView(root)

        // Load the game backend page after restoring cookies
        val accountManager = AccountManager(this)
        val devId = accountManager.getDeveloperId()
        accountManager.restoreCurrentCookies {
            val url = if (devId != null && appId.isNotEmpty()) {
                "https://developer.taptap.cn/v3/$devId/app/$appId"
            } else if (devId != null) {
                "https://developer.taptap.cn/v3/$devId/all-app"
            } else {
                "https://developer.taptap.cn/"
            }
            runOnUiThread { webView.loadUrl(url) }
        }
    }

    @SuppressLint("NewApi")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_FILE_CHOOSER) {
            val results = if (resultCode == RESULT_OK && data != null) {
                val uri = data.data
                if (uri != null) arrayOf(uri) else null
            } else null
            filePathCallback?.onReceiveValue(results)
            filePathCallback = null
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        webView.destroy()
        super.onDestroy()
    }

    private fun injectTheme() {
        // Use org.json.JSONObject.quote for safe JSON string encoding of the CSS/JS content
        val cssQuoted = org.json.JSONObject.quote(themeCss)
        val injectCss = """
            (function() {
                if (document.getElementById('__taptap_theme_css__')) return;
                var style = document.createElement('style');
                style.id = '__taptap_theme_css__';
                style.textContent = $cssQuoted;
                document.head.appendChild(style);
            })();
        """.trimIndent()

        val jsQuoted = org.json.JSONObject.quote(themeJs)
        val injectJs = """
            (function() {
                if (window.__tsThemeInstalled) return;
                var script = document.createElement('script');
                script.id = '__taptap_theme_js__';
                script.textContent = $jsQuoted;
                document.head.appendChild(script);
            })();
        """.trimIndent()

        webView.evaluateJavascript(injectCss, null)
        webView.evaluateJavascript(injectJs, null)
    }

    private fun loadAssetText(path: String): String {
        return try {
            val stream = assets.open(path)
            val reader = BufferedReader(InputStreamReader(stream, Charsets.UTF_8))
            val sb = StringBuilder()
            var line: String?
            while (reader.readLine().also { line = it } != null) {
                sb.append(line).append('\n')
            }
            reader.close()
            sb.toString()
        } catch (e: Exception) {
            ""
        }
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }
}
