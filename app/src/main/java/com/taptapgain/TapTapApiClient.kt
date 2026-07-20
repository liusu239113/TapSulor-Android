package com.taptapgain

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import com.google.gson.JsonElement
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class TapTapApiClient {
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
                        Cookie.Builder().name(pair[0].trim()).value(pair[1].trim())
                            .domain(url.host).path("/").build()
                    } catch (_: Exception) {
                        null
                    }
                }
            }
        })
        .build()

    data class FetchResult(val ok: Boolean, val status: Int, val body: String, val error: String?)
    data class CheckLoginResult(val status: String, val developerId: String?, val error: String? = null)

    suspend fun fetch(url: String): FetchResult = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url(url)
                .addHeader("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36")
                .addHeader("Accept", "application/json, text/plain, */*")
                .addHeader("Referer", "https://developer.taptap.cn/")
                .build()
            client.newCall(request).execute().use { response ->
                FetchResult(
                    response.isSuccessful,
                    response.code,
                    response.body?.string() ?: "",
                    if (response.isSuccessful) null else "HTTP ${response.code}"
                )
            }
        } catch (e: Exception) {
            FetchResult(false, 0, "", e.message ?: "network_error")
        }
    }

    suspend fun checkLoginStatus(configuredDeveloperId: String? = null): CheckLoginResult {
        val host = "developer.taptap.cn"
        val me = fetch("https://$host/api/user/v1/me")
        if (me.status == 401 || me.status == 403) return CheckLoginResult("unauthenticated", null)
        if (!me.ok || me.status == 0) return CheckLoginResult("error", null, me.error ?: "network_error")

        val allIds = linkedSetOf<String>()
        allIds.addAll(extractDeveloperIds(me.body))

        val listEndpoints = listOf(
            "https://$host/api/developer/v1/list",
            "https://$host/api/developer/v1/developers",
            "https://$host/api/user/v1/developers"
        )
        var anyListSucceeded = false
        for (url in listEndpoints) {
            val result = fetch(url)
            if (result.status == 401 || result.status == 403) continue
            if (result.ok) {
                anyListSucceeded = true
                allIds.addAll(extractDeveloperIds(result.body))
            }
        }

        val configured = normalizeId(configuredDeveloperId)
        if (configured != null) {
            val permission = fetch("https://$host/api/app/v2/list?developer_id=$configured&page=1&pagesize=1")
            if (permission.ok && responseIsSuccessful(permission.body)) {
                return CheckLoginResult("ready", configured)
            }
        }

        if (allIds.isNotEmpty()) {
            return CheckLoginResult("ready", configured?.takeIf { it in allIds } ?: allIds.first())
        }

        return if (anyListSucceeded) {
            CheckLoginResult("identity-unresolved", null, "developer_identity_not_found")
        } else {
            CheckLoginResult("identity-unresolved", null, "developer_list_unavailable")
        }
    }

    private fun responseIsSuccessful(body: String): Boolean {
        return try {
            val root = JsonParser.parseString(body)
            !root.isJsonObject || !root.asJsonObject.has("success") || root.asJsonObject.get("success").asBoolean
        } catch (_: Exception) {
            true
        }
    }

    private fun extractDeveloperIds(body: String): List<String> {
        return try {
            val ids = linkedSetOf<String>()
            collectDeveloperIds(JsonParser.parseString(body), ids)
            ids.toList()
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun collectDeveloperIds(element: JsonElement?, ids: MutableSet<String>) {
        if (element == null || element.isJsonNull) return
        if (element.isJsonArray) {
            element.asJsonArray.forEach { collectDeveloperIds(it, ids) }
            return
        }
        if (!element.isJsonObject) return

        val obj = element.asJsonObject
        listOf("developer_id", "developerId", "developerID").forEach { key ->
            if (obj.has(key)) normalizeId(obj.get(key))?.let(ids::add)
        }
        if (obj.has("developer") && obj.get("developer").isJsonObject) {
            val developer = obj.getAsJsonObject("developer")
            if (developer.has("id")) normalizeId(developer.get("id"))?.let(ids::add)
        }
        obj.entrySet().forEach { (key, value) ->
            if (key in setOf("data", "list", "items", "developers", "developer_list", "developerList", "user", "result")) {
                collectDeveloperIds(value, ids)
            }
        }
    }

    private fun normalizeId(value: Any?): String? {
        if (value == null) return null
        if (value is JsonElement) {
            if (!value.isJsonPrimitive) return null
            val primitive = value.asJsonPrimitive
            return when {
                primitive.isString -> normalizeId(primitive.asString)
                primitive.isNumber -> try { primitive.asBigDecimal.stripTrailingZeros().toPlainString().takeIf { it.all(Char::isDigit) } } catch (_: Exception) { null }
                else -> null
            }
        }
        if (value is Number) return value.toLong().toString().takeIf { it.all(Char::isDigit) }
        val raw = value.toString().trim()
        return when {
            raw.all(Char::isDigit) && raw.isNotEmpty() -> raw
            raw.matches(Regex("\\d+\\.0+")) -> raw.substringBefore('.')
            else -> null
        }
    }
}
