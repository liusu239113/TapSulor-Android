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

    fun register() { webView.addJavascriptInterface(this, "AndroidBridge") }

    @JavascriptInterface fun isElectron(): Boolean = true

    @JavascriptInterface fun fetch(url: String) {
        scope.launch {
            val result = apiClient.fetch(url)
            val json = gson.toJson(mapOf("ok" to result.ok, "status" to result.status, "body" to result.body, "error" to result.error))
            webView.post { webView.evaluateJavascript("window.__pendingFetchResolve('${json.replace("'", "\\'").replace("\n", "\\n")}')", null) }
        }
    }

    @JavascriptInterface fun checkLogin() {
        scope.launch {
            val result = apiClient.checkLoginStatus()
            if (result.status == "ready" && result.developerId != null) accountManager.setDeveloperId(result.developerId)
            val json = gson.toJson(mapOf("status" to result.status, "developerId" to result.developerId, "error" to result.error))
            webView.post { webView.evaluateJavascript("window.__pendingLoginResolve('${json.replace("'", "\\'").replace("\n", "\\n")}')", null) }
        }
    }

    @JavascriptInterface fun getDeveloperId(): String? = accountManager.getDeveloperId()

    @JavascriptInterface fun openLogin(mode: String?) {
        val intent = Intent(activity, LoginActivity::class.java)
        if (mode == "add") intent.putExtra("mode", "add")
        activity.startActivityForResult(intent, LoginActivity.REQUEST_CODE_LOGIN)
    }

    @JavascriptInterface fun getAccounts(): String = gson.toJson(accountManager.getAccounts())
    @JavascriptInterface fun switchAccount(id: String): Boolean = accountManager.switchAccount(id)
    @JavascriptInterface fun addAccount(name: String, developerId: String) { accountManager.addAccount(name, developerId) }
    @JavascriptInterface fun removeAccount(id: String): Boolean = accountManager.removeAccount(id)

    @JavascriptInterface fun openExplorer() { activity.startActivity(Intent(activity, ExplorerActivity::class.java)) }
    @JavascriptInterface fun getCapturedApis(): String = gson.toJson(capturedApis)
    @JavascriptInterface fun clearCapturedApis() { capturedApis.clear() }

    @JavascriptInterface fun replayApi(url: String) {
        scope.launch {
            val result = apiClient.fetch(url)
            webView.post { webView.evaluateJavascript("window.__pendingReplayResolve('${result.body.replace("'", "\\'").replace("\n", "\\n")}')", null) }
        }
    }

    fun notifyLoginSuccess() { webView.post { webView.evaluateJavascript("if(window.__onLoginSuccess) window.__onLoginSuccess()", null) } }
    fun destroy() { scope.cancel() }
}