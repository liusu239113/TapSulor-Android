package com.taptapgain

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.google.gson.Gson
import kotlinx.coroutines.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

class WebAppInterface(
    private val activity: Activity,
    private val webView: WebView,
    private val accountManager: AccountManager,
    private val apiClient: TapTapApiClient,
    private val updateChecker: UpdateChecker
) {
    private val gson = Gson()
    private val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val capturedApis = mutableListOf<Map<String, Any?>>()

    fun register() {
        webView.addJavascriptInterface(this, "AndroidBridge")
    }

    @JavascriptInterface fun isElectron(): Boolean = true

    @JavascriptInterface fun fetch(id: Int, url: String) {
        scope.launch {
            val result = apiClient.fetch(url)
            resolve(id, "__pendingFetchResolve", result)
        }
    }

    @JavascriptInterface fun checkLogin() {
        scope.launch {
            val result = apiClient.checkLoginStatus(accountManager.getDeveloperId())
            if (result.status == "ready" && result.developerId != null) {
                accountManager.setDeveloperId(result.developerId, addMode = false)
                accountManager.captureCurrentSessionCookies()
                // 写入昵称/头像/开发者主体名/Logo/工作室列表
                result.profile?.let { p ->
                    val studioRefs = result.studios.map { StudioRef(id = it.id, name = it.name, logo = it.logo) }
                    accountManager.updateAccountProfile(
                        developerId = result.developerId,
                        nickname = p.nickname,
                        avatar = p.avatar,
                        developerName = p.developerName,
                        developerAvatar = p.developerAvatar,
                        studios = studioRefs,
                        activeDeveloperId = result.developerId
                    )
                }
            }
            val payload = gson.toJson(
                mapOf(
                    "status" to result.status,
                    "developerId" to result.developerId,
                    "error" to result.error,
                    "profile" to result.profile,
                    "studios" to result.studios
                )
            )
            webView.post { webView.evaluateJavascript("window.__pendingLoginResolve(${jsString(payload)})", null) }
        }
    }

    @JavascriptInterface fun getDeveloperId(): String? = accountManager.getDeveloperId()

    @JavascriptInterface fun getStudios(): String = gson.toJson(accountManager.getStudios())

    @JavascriptInterface fun getActiveDeveloperId(): String? = accountManager.getActiveDeveloperId()

    @JavascriptInterface fun switchStudio(developerId: String): Boolean {
        val changed = accountManager.switchStudio(developerId)
        if (changed) {
            webView.post { webView.evaluateJavascript("if(window.__onStudioSwitched)window.__onStudioSwitched(${jsString(developerId)})", null) }
            webView.post { webView.reload() }
        }
        return changed
    }

    /** 暴露 APP 版本号给 Web 端（来自 BuildConfig.VERSION_NAME，与 build.gradle.kts 同步） */
    @JavascriptInterface fun getAppVersion(): String = BuildConfig.VERSION_NAME

    /** 后台 WorkManager 写入的热度快照（页面打开时合并进走势） */
    @JavascriptInterface fun getRankHistory(): String {
        return try {
            activity.getSharedPreferences("taptap_prefs", Context.MODE_PRIVATE)
                .getString("rank_bg_history_v1", "{}") ?: "{}"
        } catch (_: Exception) { "{}" }
    }

    /** 触发一次手动检查更新（非静默；已是最新或失败都会 Toast 提示，发现新版本则弹窗） */
    @JavascriptInterface fun checkUpdate() {
        activity.runOnUiThread { updateChecker.check(silent = false) }
    }

    /** Web 端主题/字体偏好同步到原生 SharedPreferences（冷启动时原生更新弹窗也能跟随） */
    @JavascriptInterface fun syncPreferences(mode: String?, accent: String?, font: String?) {
        val prefs = activity.getSharedPreferences("taptap_prefs", Context.MODE_PRIVATE)
        prefs.edit()
            .putString("theme_mode", mode ?: "light")
            .putString("theme_accent", accent ?: "cyan")
            .putString("font_family", font ?: "default")
            .apply()
    }

    @JavascriptInterface fun openLogin(mode: String?) {
        val intent = Intent(activity, LoginActivity::class.java)
        intent.putExtra("mode", mode ?: "login")
        activity.startActivityForResult(intent, LoginActivity.REQUEST_CODE_LOGIN)
    }

    /** 打开可见的 REP 授权页（首次需要账号确认授权，隐藏 WebView 点不了按钮） */
    @JavascriptInterface fun openRepAuth(developerId: String?) {
        val dev = (developerId ?: "").trim().ifEmpty {
            accountManager.getActiveDeveloperId() ?: accountManager.getDeveloperId() ?: ""
        }
        if (dev.isNotEmpty()) RepAuthActivity.start(activity, dev)
    }

    @JavascriptInterface fun getAccounts(): String = gson.toJson(accountManager.getAccountsPayload())

    @JavascriptInterface fun switchAccount(id: String): Boolean {
        val changed = accountManager.switchAccount(id)
        if (changed) {
            accountManager.restoreCurrentCookies {
                webView.reload()
            }
        }
        return changed
    }

    @JavascriptInterface fun addAccount(name: String, developerId: String) {
        accountManager.setDeveloperId(developerId, addMode = true)
    }

    @JavascriptInterface fun removeAccount(id: String): Boolean = accountManager.removeAccount(id)

    @JavascriptInterface fun openExplorer() {
        activity.startActivity(Intent(activity, ExplorerActivity::class.java))
    }

    @JavascriptInterface fun openGameBackend(appId: String, appName: String) {
        BackendWebViewActivity.start(activity, appId, appName)
    }

    @JavascriptInterface fun getCapturedApis(): String = gson.toJson(capturedApis)
    @JavascriptInterface fun clearCapturedApis() { capturedApis.clear() }

    @JavascriptInterface fun replayApi(id: Int, url: String) {
        scope.launch {
            val result = apiClient.fetch(url)
            resolve(id, "__pendingReplayResolve", result)
        }
    }

    @JavascriptInterface fun replayKeyApis() {
        val json = gson.toJson(mapOf("count" to 0, "saved" to false))
        webView.post { webView.evaluateJavascript("window.__pendingReplayKeyResolve(${jsString(json)})", null) }
    }

    fun notifyLoginSuccess() {
        webView.post {
            webView.evaluateJavascript("if(window.__onLoginSuccess)window.__onLoginSuccess()", null)
            webView.evaluateJavascript("if(window.__onLoginCheck)window.__onLoginCheck()", null)
        }
    }

    fun notifyAccountUpdated(update: AccountUpdate) {
        val json = gson.toJson(update)
        webView.post {
            webView.evaluateJavascript("if(window.__onAccountUpdated)window.__onAccountUpdated(${jsString(json)})", null)
        }
    }


    /** 带自定义请求头的 GET（REP 等需要 Authorization/x-app-id/x-developer-id 的接口） */
    @JavascriptInterface fun httpGet(id: Int, url: String, headersJson: String) {
        scope.launch {
            val headers = runCatching {
                gson.fromJson(headersJson, Map::class.java).entries.associate { it.key.toString() to it.value.toString() }
            }.getOrDefault(emptyMap())
            val result = apiClient.fetchWithHeaders(url, headers)
            resolve(id, "__pendingHttpGet", result)
        }
    }

    /** 带自定义请求头的 POST（提现等写接口需要 X-DC-XSRF-TOKEN） */
    @JavascriptInterface fun httpPost(id: Int, url: String, headersJson: String) {
        scope.launch {
            val headers = runCatching {
                gson.fromJson(headersJson, Map::class.java).entries.associate { it.key.toString() to it.value.toString() }
            }.getOrDefault(emptyMap())
            val result = apiClient.postWithHeaders(url, headers)
            resolve(id, "__pendingHttpPost", result)
        }
    }

    /**
     * 读取 REP 平台令牌：后台 WebView 打开 rep.taptap.cn/<developerId>/，
     * SSO 授权后从 localStorage 取 op-jwt-token（该令牌是所有 REP 接口的鉴权凭证）。
     */
    @JavascriptInterface fun repToken(id: Int, developerId: String) {
        activity.runOnUiThread {
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            val owner = runCatching { accountManager.getCurrentAccountId() }.getOrDefault("")
            val prefs = activity.getSharedPreferences("taptap_prefs", Context.MODE_PRIVATE)
            val cacheKey = "rep_token_$owner"
            val cached = prefs.getString(cacheKey, null)
            val cachedAt = prefs.getLong(cacheKey + "_at", 0L)
            // 桌面端同款：令牌按账号缓存 4 小时
            if (!cached.isNullOrEmpty() && System.currentTimeMillis() - cachedAt < 4L * 60L * 60L * 1000L) {
                webView.evaluateJavascript("window.__pendingRepToken($id, ${jsString(cached)})", null)
                return@runOnUiThread
            }
            val wv = WebView(activity)
            wv.settings.javaScriptEnabled = true
            wv.settings.domStorageEnabled = true
            wv.settings.userAgentString = DESKTOP_UA
            val cm = android.webkit.CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(wv, true)
            try {
                listOf("https://developer.taptap.cn/", "https://accounts.taptap.cn/", "https://rep.taptap.cn/").forEach { u ->
                    val url = u.toHttpUrlOrNull() ?: return@forEach
                    accountManager.getCookiesForUrl(owner, url).forEach { c -> cm.setCookie(u, c.name + "=" + c.value) }
                }
                cm.flush()
            } catch (_: Exception) { }
            val root = activity.window?.decorView as? android.view.ViewGroup
            if (root != null) {
                wv.visibility = android.view.View.INVISIBLE
                root.addView(wv, android.view.ViewGroup.LayoutParams(1, 1))
            }
            var settled = false
            var tries = 0

            fun cleanup() {
                try {
                    (wv.parent as? android.view.ViewGroup)?.removeView(wv)
                    wv.destroy()
                } catch (_: Exception) { }
            }

            fun finish(token: String) {
                if (settled) return
                settled = true
                if (token.isNotEmpty() && token != "LOGIN_REQUIRED") {
                    prefs.edit().putString(cacheKey, token)
                        .putLong(cacheKey + "_at", System.currentTimeMillis()).apply()
                }
                handler.post {
                    webView.evaluateJavascript("window.__pendingRepToken($id, ${jsString(token)})", null)
                    handler.postDelayed({ cleanup() }, 300)
                }
            }

            // 桌面端同款：停在授权页时自动点「确认登录」
            fun clickAuth() {
                wv.evaluateJavascript(
                    "(function(){var els=[].slice.call(document.querySelectorAll('button,a,[role=button],span,div'));" +
                    "var b=els.find(function(e){var t=(e.innerText||'').trim();" +
                    "return t==='确认登录'||t==='授权'||t==='同意'||t==='允许';});" +
                    "if(b){b.click();return 'clicked'}return 'no'})()",
                    null
                )
            }

            fun poll() {
                if (settled) return
                wv.evaluateJavascript(
                    "(function(){try{return JSON.stringify({token:localStorage.getItem('op-jwt-token')||''," +
                    "owner:localStorage.getItem('op-jwt-owner')||'',url:location.href," +
                    "text:(document.body?document.body.innerText:'').slice(0,200)})}catch(e){return ''}})()"
                ) { raw ->
                    val packed = (raw ?: "").trim()
                    var token = ""
                    var tokenOwner = ""
                    var pageUrl = ""
                    var pageText = ""
                    try {
                        val inner = if (packed.startsWith("\"") && packed.endsWith("\"")) {
                            gson.fromJson(packed, String::class.java)
                        } else packed
                        val o = com.google.gson.JsonParser.parseString(inner).asJsonObject
                        token = o.get("token")?.asString ?: ""
                        tokenOwner = o.get("owner")?.asString ?: ""
                        pageUrl = o.get("url")?.asString ?: ""
                        pageText = o.get("text")?.asString ?: ""
                    } catch (_: Exception) { }

                    if (token.isNotEmpty() && (tokenOwner.isEmpty() || tokenOwner == owner)) {
                        if (tokenOwner.isEmpty()) {
                            wv.evaluateJavascript(
                                "(function(){try{localStorage.setItem('op-jwt-owner'," + jsString(owner) + ")}catch(e){}})()",
                                null
                            )
                        }
                        finish(token)
                    } else if (token.isNotEmpty()) {
                        // 上一个账号的令牌，清掉重走当前账号 SSO
                        wv.evaluateJavascript(
                            "(function(){try{localStorage.removeItem('op-jwt-token');localStorage.removeItem('op-jwt-owner')}catch(e){}})()",
                            null
                        )
                        if (tries++ < 80) handler.postDelayed({ poll() }, 500) else finish("")
                    } else if (pageUrl.contains("accounts.taptap.cn/login")) {
                        finish("LOGIN_REQUIRED")
                    } else {
                        if (pageUrl.contains("accounts.taptap.cn/authorize") ||
                            pageText.contains("确认登录") || pageText.contains("授权登录") || pageText.contains("用户授权")
                        ) clickAuth()
                        if (tries++ < 80) handler.postDelayed({ poll() }, 500) else finish("")
                    }
                }
            }

            wv.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    handler.postDelayed({ poll() }, 800)
                }
            }
            wv.loadUrl("https://rep.taptap.cn/$developerId/")
            handler.postDelayed({ if (!settled) finish("") }, 42000L)
        }
    }


    /** 读取开发者中心 CSRF 令牌（写接口必须带 X-DC-XSRF-TOKEN） */
    @JavascriptInterface fun csrfToken(): String {
        return try {
            val raw = android.webkit.CookieManager.getInstance().getCookie("https://developer.taptap.cn/") ?: ""
            raw.split(";").map { it.trim() }.firstOrNull { it.startsWith("DC_XSRF_TOKEN=") }
                ?.substringAfter("=")
                ?.let { java.net.URLDecoder.decode(it, "UTF-8") } ?: ""
        } catch (e: Exception) {
            ""
        }
    }


    /**
     * 直接取 REP 收益：后台 WebView 打开 rep.taptap.cn/<developerId>/，
     * 在页面内（同源）用 localStorage 的令牌请求接口，避免 Cookie/头跨域问题。
     */
    @JavascriptInterface fun repRevenue(id: Int, appId: String, developerId: String) {
        activity.runOnUiThread {
            val wv = WebView(activity)
            wv.settings.javaScriptEnabled = true
            wv.settings.domStorageEnabled = true
            wv.settings.userAgentString =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            val cm = android.webkit.CookieManager.getInstance()
            cm.setAcceptCookie(true); cm.setAcceptThirdPartyCookies(wv, true)
            // 关键：把当前账号在 OkHttp 里的登录 Cookie 同步进 WebView，否则后台页面是未登录状态
            try {
                val accId = accountManager.getCurrentAccountId()
                listOf("https://developer.taptap.cn/", "https://accounts.taptap.cn/", "https://rep.taptap.cn/").forEach { u ->
                    val url = u.toHttpUrlOrNull() ?: return@forEach
                    accountManager.getCookiesForUrl(accId, url).forEach { c ->
                        cm.setCookie(u, c.name + "=" + c.value)
                    }
                }
                cm.flush()
            } catch (e: Exception) { }
            // 同 repToken：未 attach 的 WebView 上 View.postDelayed 不会执行
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            val root = activity.window?.decorView as? android.view.ViewGroup
            if (root != null) {
                wv.visibility = android.view.View.INVISIBLE
                root.addView(wv, android.view.ViewGroup.LayoutParams(1, 1))
            }
            var settled = false
            fun cleanup() {
                try {
                    (wv.parent as? android.view.ViewGroup)?.removeView(wv)
                    wv.destroy()
                } catch (_: Exception) { }
            }
            fun done(payload: String) {
                if (settled) return
                settled = true
                handler.post {
                    webView.evaluateJavascript("window.__pendingRepRevenue($id, ${jsString(payload)})", null)
                    handler.postDelayed({ cleanup() }, 300)
                }
            }
            fun run() {
                val js = "(async function(){try{" +
                    "var tk=localStorage.getItem('op-jwt-token')||'';" +
                    "if(!tk) return JSON.stringify({ok:false,error:'NO_TOKEN'});" +
                    "var r=await fetch('https://tap-op.tapapis.cn/rep/be/v1/dashboard/revenue',{headers:{Authorization:tk,'x-app-id':'" + appId + "','x-developer-id':'" + developerId + "'}});" +
                    "var t=await r.text();return JSON.stringify({ok:r.ok,status:r.status,body:t});" +
                    "}catch(e){return JSON.stringify({ok:false,error:String(e)})}})()"
                wv.evaluateJavascript(js) { v ->
                    // evaluateJavascript 返回的是被 JSON 编码过的字符串
                    val raw = (v ?: "").trim()
                    val unescaped = if (raw.startsWith("\"") && raw.endsWith("\"")) {
                        try { com.google.gson.JsonParser().parse(raw).asString } catch (_: Exception) { raw }
                    } else raw
                    done(unescaped)
                }
            }
            wv.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    // 等 SSO 授权把令牌写进 localStorage
                    var tries = 0
                    fun waitToken() {
                        if (settled) return
                        wv.evaluateJavascript("(function(){try{return localStorage.getItem('op-jwt-token')||''}catch(e){return ''}})()") { t ->
                            val token = (t ?: "").trim().trim('"')
                            if (token.isNotEmpty()) run()
                            else if (tries++ < 24) handler.postDelayed({ waitToken() }, 500)
                            else done("{\"ok\":false,\"error\":\"NO_TOKEN\"}")
                        }
                    }
                    handler.postDelayed({ waitToken() }, 600)
                }
            }
            wv.loadUrl("https://rep.taptap.cn/$developerId/")
            handler.postDelayed({ if (!settled) done("{\"ok\":false,\"error\":\"TIMEOUT\"}") }, 20000L)
        }
    }

    private fun resolve(id: Int, functionName: String, result: TapTapApiClient.FetchResult) {
        val json = gson.toJson(
            mapOf("ok" to result.ok, "status" to result.status, "body" to result.body, "error" to result.error)
        )
        webView.post { webView.evaluateJavascript("window.$functionName($id, ${jsString(json)})", null) }
    }

    private fun jsString(value: String): String = gson.toJson(value)

    fun destroy() { scope.cancel() }
}
