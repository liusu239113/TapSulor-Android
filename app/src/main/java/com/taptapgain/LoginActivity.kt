package com.taptapgain

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class LoginActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var accountManager: AccountManager
    private lateinit var apiClient: TapTapApiClient
    private var checking = false
    private var finished = false
    private var nativeCheckAttempts = 0

    companion object {
        const val REQUEST_CODE_LOGIN = 1001
        const val EXTRA_RESULT_LOGIN_SUCCESS = "login_success"
        const val EXTRA_DEVELOPER_ID = "developer_id"
        const val EXTRA_LOGIN_MODE_ADD = "login_mode_add"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableImmersiveMode()
        accountManager = AccountManager(this)
        apiClient = TapTapApiClient(accountManager)
        configureWebView()
        setContentView(webView)
        // For add-account mode, clear WebView cookies first so the user starts fresh.
        // The per-account store is keyed by account id, so other accounts stay intact.
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
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    return interceptOAuthUrl(url)
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    extractDeveloperIdFromUrl(url)?.let { finishLogin(it) }
                    scheduleLoginCheck(view)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    extractDeveloperIdFromUrl(url)?.let { finishLogin(it) }
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

    private fun extractDeveloperIdFromUrl(url: String?): String? {
        val value = url ?: return null
        val match = Regex("/(?:v3|developer|developer-center)/([0-9]+)(?:/|$)").find(value)
            ?: Regex("[?&](?:developer_id|developerId|developerID)=([0-9]+)").find(value)
        return match?.groupValues?.getOrNull(1)
    }

    /**
     * OAuth / native-scheme interception.
     *
     * Embedded WebView cannot dispatch non-http(s) schemes (weixin://, mqqapi://, …)
     * to the system, so WeChat forces a PC QR and QQ hard-errors inside WebView.
     *
     * Strategy:
     *  - Native schemes (weixin/mqq/mqqwpa/mqqopensdkapi/weixin/…) → ACTION_VIEW so the
     *    installed WeChat/QQ app handles them directly.
     *  - Web OAuth entry points (open.weixin.qq.com, graph.qq.com, passport.taptap.cn hops
     *    to third-party auth) → Chrome Custom Tabs. The browser process can then launch the
     *    native app and — on Chrome-based devices — shares cookies back into the app-wide
     *    CookieManager so the existing probeDeveloperIdFromWebView() detects login on return.
     *  - Everything else → return false to let the embedded WebView load normally (phone
     *    login continues to work as before).
     */
    private fun interceptOAuthUrl(url: String): Boolean {
        if (finished || isFinishing) return false
        val uri = try { Uri.parse(url) } catch (_: Exception) { return false }
        val scheme = uri.scheme?.lowercase() ?: return false
        val host = uri.host?.lowercase() ?: ""

        // 1) Native app schemes → hand off directly to the installed app.
        val nativeSchemes = setOf("weixin", "mqqapi", "mqqwpa", "mqqopensdkapi", "mqqopensdk", "wechat")
        if (scheme in nativeSchemes) {
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            } catch (_: Exception) {
                // App not installed / no handler → fall through and let WebView try (will show error page).
                false
            }
        }

        // 2) Web OAuth endpoints that need to run in a real browser (so cookies/schemes work).
        // TapTap passport stays in WebView unless it is actively bouncing to a third-party provider.
        val isOAuthWeb: Boolean = when {
            host == "open.weixin.qq.com" -> true
            host == "graph.qq.com" || host.endsWith(".graph.qq.com") -> true
            host == "xui.ptlogin2.qq.com" || host.endsWith(".ptlogin2.qq.com") -> true
            host == "openmobile.qq.com" -> true
            host == "weixin.qq.com" || host.endsWith(".weixin.qq.com") -> true
            host == "passport.taptap.cn" && (url.contains("third_party") || url.contains("connect")) -> true
            else -> false
        }

        if (isOAuthWeb && (scheme == "http" || scheme == "https")) {
            return try {
                val tabsIntent = CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                    .build()
                tabsIntent.launchUrl(this, uri)
                true
            } catch (_: Exception) {
                // No Custom Tabs provider → fall back to plain ACTION_VIEW.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    true
                } catch (_: Exception) { false }
            }
        }

        return false
    }

    override fun onResume() {
        super.onResume()
        // Returning from WeChat/QQ/Custom Tab: cookies may have just landed in CookieManager.
        // Kick the native probe immediately so success is detected without waiting for a page load.
        if (!finished && !isFinishing) {
            webView.postDelayed({ checkLoginNatively() }, 300)
        }
    }

    private fun scheduleLoginCheck(view: WebView?) {
        view ?: return
        view.postDelayed({ checkLogin(view) }, 900)
        view.postDelayed({ checkLoginNatively() }, 1400)
    }

    /**
     * Native login check that reads cookies DIRECTLY from the WebView CookieManager,
     * because during login the cookies live in WebView (not yet imported to any account).
     * Logic mirrors account-state.js verbatim.
     */
    private fun checkLoginNatively() {
        if (finished || isFinishing || nativeCheckAttempts >= 12) return
        nativeCheckAttempts++
        lifecycleScope.launch {
            val developerId = probeDeveloperIdFromWebView()
            if (developerId != null) {
                finishLogin(developerId)
            } else if (!finished) {
                webView.postDelayed({ checkLoginNatively() }, 1800)
            }
        }
    }

    private suspend fun probeDeveloperIdFromWebView(): String? = withContext(Dispatchers.IO) {
        // Snapshot current WebView cookies for developer.taptap.cn
        val url = "https://developer.taptap.cn/".toHttpUrl()
        val raw = CookieManager.getInstance().getCookie(url.toString()) ?: return@withContext null
        val cookies = raw.split(';').mapNotNull { part ->
            val pair = part.trim().split('=', limit = 2)
            if (pair.size != 2 || pair[0].isBlank()) return@mapNotNull null
            try {
                Cookie.Builder().name(pair[0].trim()).value(pair[1].trim())
                    .domain(url.host).path("/").build()
            } catch (_: Exception) { null }
        }
        if (cookies.isEmpty()) return@withContext null

        val client = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .followRedirects(true)
            .cookieJar(object : okhttp3.CookieJar {
                override fun saveFromResponse(u: HttpUrl, list: List<Cookie>) {}
                override fun loadForRequest(u: HttpUrl): List<Cookie> = cookies
            })
            .build()

        val ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

        // 1) /api/user/v1/me
        val meBody = requestBody(client, "/api/user/v1/me", ua)
        if (meBody.status == 401 || meBody.status == 403) return@withContext null
        if (meBody.body != null) {
            val id = extractMeId(meBody.body)
            if (id != null) return@withContext id
        }

        // 2) /api/developer/v1/list
        val listBody = requestBody(client, "/api/developer/v1/list", ua)
        if (listBody.body != null) {
            return@withContext extractListId(listBody.body)
        }
        return@withContext null
    }

    private data class Resp(val status: Int, val body: String?)

    private fun requestBody(client: OkHttpClient, path: String, ua: String): Resp {
        return try {
            client.newCall(
                Request.Builder().url("https://developer.taptap.cn$path")
                    .header("User-Agent", ua)
                    .header("Accept", "application/json, text/plain, */*")
                    .build()
            ).execute().use { resp ->
                Resp(resp.code, if (resp.isSuccessful) resp.body?.string() else null)
            }
        } catch (_: Exception) {
            Resp(0, null)
        }
    }

    private fun extractMeId(body: String): String? {
        return try {
            val root = JsonParser.parseString(body).asJsonObject ?: return null
            val data = root.getAsJsonObject("data") ?: return null
            val did = primStr(data.get("developer_id"))
                ?: primStr(data.get("developerId"))
                ?: primStr(data.getAsJsonObject("developer")?.get("id"))
            did?.takeIf { it.all(Char::isDigit) }
        } catch (_: Exception) { null }
    }

    private fun extractListId(body: String): String? {
        return try {
            val root = JsonParser.parseString(body).asJsonObject ?: return null
            val data = root.getAsJsonObject("data") ?: return null
            val list = data.getAsJsonArray("list") ?: return null
            for (el in list) {
                val obj = el.asJsonObject ?: continue
                val id = primStr(obj.get("developer_id"))
                    ?: primStr(obj.get("developerId"))
                    ?: primStr(obj.get("id"))
                if (id != null && id.all(Char::isDigit)) return id
            }
            null
        } catch (_: Exception) { null }
    }

    private fun primStr(el: com.google.gson.JsonElement?): String? {
        if (el == null || !el.isJsonPrimitive) return null
        val p = el.asJsonPrimitive
        return when {
            p.isNumber -> p.asBigDecimal.stripTrailingZeros().toPlainString()
            p.isString -> p.asString.trim()
            else -> null
        }
    }

    private fun checkLogin(view: WebView) {
        if (checking || finished || isFinishing) return
        checking = true
        // Mirror account-state.js: only /me and /developer/v1/list, exact field extraction.
        view.evaluateJavascript(
            """(async function(){
                try {
                    function norm(v){ if(v==null) return null; const s=String(v).trim(); return /^\d+$/.test(s) ? s : (s.endsWith('.0') ? s.slice(0,-2) : null); }
                    function fromMe(p){ const d=p&&p.data; return d && (norm(d.developer_id) || norm(d.developerId) || (d.developer && norm(d.developer.id))); }
                    function fromList(p){ const list = p && p.data && p.data.list; if(!Array.isArray(list)) return null; for(const it of list){ const id = norm(it.developer_id) || norm(it.developerId) || norm(it.id); if(id) return id; } return null; }
                    let me = await fetch('/api/user/v1/me', {credentials:'include'});
                    if (me.status === 401 || me.status === 403) return;
                    let meJson = await me.json();
                    const idFromMe = fromMe(meJson);
                    if (idFromMe) { AndroidLoginBridge.onLoginSuccess(String(idFromMe)); return; }
                    let list = await fetch('/api/developer/v1/list', {credentials:'include'});
                    if (!list.ok) return;
                    let listJson = await list.json();
                    const idFromList = fromList(listJson);
                    if (idFromList) AndroidLoginBridge.onLoginSuccess(String(idFromList));
                } catch (e) {}
            })()""",
            null
        )
        view.postDelayed({ checking = false }, 1500)
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

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableImmersiveMode()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
