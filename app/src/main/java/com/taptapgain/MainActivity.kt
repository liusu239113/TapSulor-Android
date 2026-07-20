package com.taptapgain

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
        apiClient = TapTapApiClient()
        webView = WebView(this).apply outer@{
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
                useWideViewPort = true; loadWithOverviewMode = true
                setSupportZoom(true); builtInZoomControls = true; displayZoomControls = false
                allowFileAccess = true; cacheMode = WebSettings.LOAD_DEFAULT
                userAgentString = settings.userAgentString.replace("; wv", "")
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this@outer, true)
            }

            val assetLoader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
                .build()

            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    injectBridgeShim(view)
                }
            }
            webChromeClient = WebChromeClient()
        }

        setContentView(webView)
        webAppInterface = WebAppInterface(this, webView, accountManager, apiClient)
        webAppInterface.register()
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    private fun injectBridgeShim(view: WebView?) {
        view ?: return
        val shim = """
(function(){
if(window.__bridgeInjected)return;
window.__bridgeInjected=true;
window.__fetchResolveQueue=[];
window.__loginResolveQueue=[];
window.__replayResolveQueue=[];
window.__replayKeyResolveQueue=[];
window.__pendingFetchResolve=function(s){var cb=window.__fetchResolveQueue.shift();if(cb)cb(JSON.parse(s));};
window.__pendingLoginResolve=function(s){var cb=window.__loginResolveQueue.shift();if(cb)cb(JSON.parse(s));};
window.__pendingReplayResolve=function(s){var cb=window.__replayResolveQueue.shift();if(cb)cb(s);};
window.__pendingReplayKeyResolve=function(s){var cb=window.__replayKeyResolveQueue.shift();if(cb)cb(JSON.parse(s));};
window.electronAPI={
isElectron:true,
fetch:function(u){return new Promise(function(r){window.__fetchResolveQueue.push(r);AndroidBridge.fetch(u);});},
checkLogin:function(){return new Promise(function(r){window.__loginResolveQueue.push(r);AndroidBridge.checkLogin();});},
getDeveloperId:function(){return AndroidBridge.getDeveloperId();},
openLogin:function(m){AndroidBridge.openLogin(m||null);},
getAccounts:function(){return JSON.parse(AndroidBridge.getAccounts());},
switchAccount:function(i){return AndroidBridge.switchAccount(i);},
addAccount:function(d){if(d)AndroidBridge.addAccount(d.name||'',d.developerId||'');},
removeAccount:function(i){return AndroidBridge.removeAccount(i);},
openExplorer:function(){AndroidBridge.openExplorer();},
getCapturedApis:function(){return JSON.parse(AndroidBridge.getCapturedApis());},
clearCapturedApis:function(){AndroidBridge.clearCapturedApis();},
replayApi:function(u){return new Promise(function(r){window.__replayResolveQueue.push(r);AndroidBridge.replayApi(u);});},
replayKeyApis:function(){return new Promise(function(r){window.__replayKeyResolveQueue.push(r);AndroidBridge.replayKeyApis();});},
onLoginSuccess:function(c){window.__onLoginSuccess=c;},
onLoginCheck:function(c){window.__onLoginCheck=c;},
onAccountUpdated:function(c){window.__onAccountUpdated=c;},
onApisUpdated:function(c){window.__onApisUpdated=c;},
onTrayRefresh:function(){}
};
window.dispatchEvent(new CustomEvent('electronAPIReady'));
})();
""".trimIndent()
        view.evaluateJavascript(shim, null)
    }

    @Deprecated("Use registerForActivityResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == LoginActivity.REQUEST_CODE_LOGIN && resultCode == RESULT_OK) {
            webAppInterface.notifyLoginSuccess()
            webView.postDelayed({ webView.evaluateJavascript("if(window.electronAPI&&window.electronAPI.checkLogin)window.electronAPI.checkLogin()", null) }, 500)
        }
    }

    override fun onBackPressed() { if (webView.canGoBack()) webView.goBack() else super.onBackPressed() }
    override fun onDestroy() { webAppInterface.destroy(); webView.destroy(); super.onDestroy() }
}