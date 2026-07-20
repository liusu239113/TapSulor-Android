package com.taptapgain

import android.app.Activity
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.google.gson.Gson
import kotlinx.coroutines.*

class WebAppInterface(
    private val activity: Activity,
    private val webView: WebView,
    private val accountManager: AccountManager,
    private val apiClient: TapTapApiClient
) {
    private val gson = Gson()
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val capturedApis = mutableListOf<Map<String, Any?>>()

    fun register() {
        webView.addJavascriptInterface(this, "AndroidBridge")
    }

    @JavascriptInterface fun isElectron(): Boolean = true

    @JavascriptInterface fun fetch(url: String) {
        scope.launch {
            val result = apiClient.fetch(url)
            resolve("__pendingFetchResolve", result)
        }
    }

    @JavascriptInterface fun checkLogin() {
        scope.launch {
            val result = apiClient.checkLoginStatus(accountManager.getDeveloperId())
            if (result.status == "ready" && result.developerId != null) {
                accountManager.setDeveloperId(result.developerId, addMode = false)
                accountManager.captureCurrentSessionCookies()
            }
            val payload = gson.toJson(
                mapOf("status" to result.status, "developerId" to result.developerId, "error" to result.error)
            )
            webView.post { webView.evaluateJavascript("window.__pendingLoginResolve(${jsString(payload)})", null) }
        }
    }

    @JavascriptInterface fun getDeveloperId(): String? = accountManager.getDeveloperId()

    @JavascriptInterface fun openLogin(mode: String?) {
        val intent = Intent(activity, LoginActivity::class.java)
        intent.putExtra("mode", mode ?: "login")
        activity.startActivityForResult(intent, LoginActivity.REQUEST_CODE_LOGIN)
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

    @JavascriptInterface fun getCapturedApis(): String = gson.toJson(capturedApis)
    @JavascriptInterface fun clearCapturedApis() { capturedApis.clear() }

    @JavascriptInterface fun replayApi(url: String) {
        scope.launch {
            val result = apiClient.fetch(url)
            resolve("__pendingReplayResolve", result)
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

    private fun resolve(functionName: String, result: TapTapApiClient.FetchResult) {
        val json = gson.toJson(
            mapOf("ok" to result.ok, "status" to result.status, "body" to result.body, "error" to result.error)
        )
        webView.post { webView.evaluateJavascript("window.$functionName(${jsString(json)})", null) }
    }

    private fun jsString(value: String): String = gson.toJson(value)

    fun destroy() { scope.cancel() }
}
