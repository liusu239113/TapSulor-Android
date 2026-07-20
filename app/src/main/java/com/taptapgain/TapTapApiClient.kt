package com.taptapgain

import android.webkit.CookieManager
import android.os.Handler
import android.os.Looper
import com.google.gson.Gson
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class TapTapApiClient {
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .followRedirects(true)
        .cookieJar(object : CookieJar {
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                val cookieManager = CookieManager.getInstance()
                cookies.forEach { cookie ->
                    val attributes = buildString {
                        append(cookie.name).append('=').append(cookie.value)
                        append("; Domain=").append(cookie.domain)
                        append("; Path=").append(cookie.path)
                        if (cookie.secure) append("; Secure")
                    }
                    cookieManager.setCookie("${url.scheme}://${url.host}", attributes)
                }
                Handler(Looper.getMainLooper()).post { cookieManager.flush() }
            }

            override fun loadForRequest(url: HttpUrl): List<Cookie> {
                val raw = CookieManager.getInstance().getCookie(url.toString()) ?: return emptyList()
                return raw.split(';').mapNotNull { part ->
                    val pair = part.trim().split('=', limit = 2)
                    if (pair.size != 2 || pair[0].isBlank()) return@mapNotNull null
                    try {
                        Cookie.Builder()
                            .name(pair[0].trim())
                            .value(pair[1].trim())
                            .domain(url.host)
                            .path("/")
                            .build()
                    } catch (_: Exception) {
                        null
                    }
                }
            }
        })
        .build()

    data class FetchResult(val ok: Boolean, val status: Int, val body: String, val error: String?)

    suspend fun fetch(url: String): FetchResult {
        return try {
            val request = Request.Builder()
                .url(url)
                .addHeader("User-Agent", "TapTapGain/1.0.1 Android")
                .addHeader("Accept", "application/json, text/plain, */*")
                .build()
            client.newCall(request).execute().use { response ->
                FetchResult(
                    ok = response.isSuccessful,
                    status = response.code,
                    body = response.body?.string() ?: "",
                    error = if (response.isSuccessful) null else "HTTP ${response.code}"
                )
            }
        } catch (e: Exception) {
            FetchResult(false, 0, "", e.message ?: "network_error")
        }
    }

    data class CheckLoginResult(val status: String, val developerId: String?, val error: String? = null)

    suspend fun checkLoginStatus(): CheckLoginResult {
        val host = "developer.taptap.cn"
        val me = fetch("https://$host/api/user/v1/me")
        if (me.status == 401 || me.status == 403) return CheckLoginResult("unauthenticated", null)
        if (!me.ok || me.status == 0) return CheckLoginResult("error", null, me.error ?: "network_error")

        val meDeveloperId = extractDeveloperId(me.body)
        if (meDeveloperId != null) return CheckLoginResult("ready", meDeveloperId)

        val list = fetch("https://$host/api/developer/v1/list")
        if (list.status == 401 || list.status == 403) return CheckLoginResult("unauthenticated", null)
        if (!list.ok || list.status == 0) return CheckLoginResult("error", null, list.error ?: "identity_unavailable")

        val developerIds = extractDeveloperIds(list.body)
        return if (developerIds.isNotEmpty()) {
            CheckLoginResult("ready", developerIds.first())
        } else {
            CheckLoginResult("no-developer", null)
        }
    }

    private fun extractDeveloperId(body: String): String? {
        return try {
            val root = gson.fromJson(body, Map::class.java)
            val data = root["data"] as? Map<*, *>
            val value = data?.get("developer_id")
                ?: data?.get("developerId")
                ?: (data?.get("developer") as? Map<*, *>)?.get("id")
            value?.toString()?.takeIf { it.matches(Regex("\\d+")) }
        } catch (_: Exception) {
            null
        }
    }

    private fun extractDeveloperIds(body: String): List<String> {
        return try {
            val root = gson.fromJson(body, Map::class.java)
            val data = root["data"]
            val rawList = when (data) {
                is Map<*, *> -> data["list"] ?: data["items"] ?: data["developers"]
                is List<*> -> data
                else -> null
            } as? List<*> ?: emptyList<Any?>()
            rawList.mapNotNull { item ->
                val map = item as? Map<*, *>
                val value = map?.get("developer_id") ?: map?.get("developerId") ?: map?.get("id")
                value?.toString()?.takeIf { it.matches(Regex("\\d+")) }
            }.distinct()
        } catch (_: Exception) {
            emptyList()
        }
    }
}
