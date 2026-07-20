package com.taptapgain

import android.webkit.CookieManager
import okhttp3.*
import java.util.concurrent.TimeUnit
import com.google.gson.Gson

class TapTapApiClient {
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .followRedirects(true)
        .cookieJar(object : CookieJar {
            private val cookieStore = mutableMapOf<String, List<Cookie>>()

            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                cookieStore[url.host] = cookies
                try {
                    val wc = CookieManager.getInstance()
                    cookies.forEach { c -> wc.setCookie("${url.scheme}://${url.host}", "${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}") }
                    android.os.Handler(android.os.Looper.getMainLooper()).post { wc.flush() }
                } catch (_: Exception) {}
            }

            override fun loadForRequest(url: HttpUrl): List<Cookie> {
                val result = mutableListOf<Cookie>()
                cookieStore.forEach { (h, cs) -> if (url.host.endsWith(h) || h.endsWith(url.host)) result.addAll(cs.filter { it.matches(url) }) }
                if (result.isEmpty()) {
                    try {
                        val cstr = CookieManager.getInstance().getCookie(url.toString()) ?: ""
                        cstr.split(";").forEach { p ->
                            val parts = p.trim().split("=", limit = 2)
                            if (parts.size == 2) result.add(Cookie.Builder().name(parts[0].trim()).value(parts[1].trim()).domain(url.host).build())
                        }
                    } catch (_: Exception) {}
                }
                return result
            }
        }).build()

    data class FetchResult(val ok: Boolean, val status: Int, val body: String, val error: String?)

    suspend fun fetch(url: String): FetchResult {
        return try {
            val req = Request.Builder().url(url).addHeader("User-Agent", "TapTapGain/1.0.1 Android").build()
            val res = client.newCall(req).execute()
            FetchResult(ok = res.isSuccessful, status = res.code, body = res.body?.string() ?: "", error = if (res.isSuccessful) null else "HTTP ${res.code}")
        } catch (e: Exception) {
            FetchResult(false, 0, "", e.message)
        }
    }

    data class CheckLoginResult(val status: String, val developerId: String?, val error: String? = null)

    suspend fun checkLoginStatus(): CheckLoginResult {
        val host = "developer.taptap.cn"
        val me = fetch("https://$host/api/user/v1/me")
        if (me.status == 401 || me.status == 403) return CheckLoginResult("unauthenticated", null)
        if (!me.ok || me.status == 0) return CheckLoginResult("error", null, me.error ?: "network_error")

        try {
            val json = gson.fromJson(me.body, Map::class.java)
            val data = json["data"] as? Map<*, *>
            var devId = data?.get("developer_id") ?: data?.get("developerId")
            if (devId == null) { val dev = data?.get("developer") as? Map<*, *>; devId = dev?.get("id") }
            if (devId != null) return CheckLoginResult("ready", devId.toString())
        } catch (_: Exception) {}

        val list = fetch("https://$host/api/developer/v1/list")
        if (list.ok) {
            try {
                val json = gson.fromJson(list.body, Map::class.java)
                val d = json["data"] as? Map<*, *>
                val items = d?.get("list") as? List<*>
                if (!items.isNullOrEmpty()) {
                    val first = items.first() as? Map<*, *>
                    val id = first?.get("developer_id") ?: first?.get("developerId") ?: first?.get("id")
                    if (id != null) return CheckLoginResult("ready", id.toString())
                }
                return CheckLoginResult("no-developer", null)
            } catch (_: Exception) {}
        }

        return CheckLoginResult("error", null, "identity_unavailable")
    }
}