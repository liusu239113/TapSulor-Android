package com.taptapgain

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * TapTap API client.
 *
 * Cookie handling mirrors the Electron original: every HTTP request goes through
 * a CookieJar that reads/writes the *current account's* cookie store owned by
 * [AccountManager], giving each account its own isolated session (equivalent to
 * Electron's `session.fromPartition(partition)`).
 *
 * Developer identity classification mirrors `account-state.js` verbatim:
 *   1. Hit `/api/user/v1/me`. On 401/403 -> unauthenticated. On network error -> error.
 *   2. Pull `data.developer_id` / `data.developerId` / `data.developer.id` from /me.
 *      If found -> ready.
 *   3. Otherwise hit `/api/developer/v1/list`. On error -> error.
 *      Collect `data.list[*].developer_id` / `developerId` / `id`.
 *      If empty -> no-developer. Otherwise -> ready (prefer configured id if it matches).
 */
class TapTapApiClient(private val accountManager: AccountManager) {

    // Exposed for use by MainActivity's image proxy (same package).
    internal val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .cookieJar(object : CookieJar {
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                val accId = accountManager.getCurrentAccountId()
                accountManager.addCookies(accId, url, cookies)
            }

            override fun loadForRequest(url: HttpUrl): List<Cookie> {
                val accId = accountManager.getCurrentAccountId()
                return accountManager.getCookiesForUrl(accId, url)
            }
        })
        .build()

    data class FetchResult(val ok: Boolean, val status: Int, val body: String, val error: String?)

    /** 登录状态 + 附属账号资料（昵称/头像/开发者主体名/Logo） */
    data class UserProfile(
        val nickname: String? = null,
        val avatar: String? = null,
        val developerName: String? = null,
        val developerAvatar: String? = null
    )

    data class CheckLoginResult(
        val status: String,
        val developerId: String?,
        val error: String? = null,
        val profile: UserProfile? = null
    )

    suspend fun fetch(url: String): FetchResult = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url(url)
                // Match Electron (Chromium desktop) User-Agent so TapTap returns the same
                // responses as the original EXE.
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                )
                .header("Accept", "application/json, text/plain, */*")
                .build()
            httpClient.newCall(request).execute().use { response ->
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

    /** Synchronous fetch used internally by checkLoginStatus. */
    private fun fetchSync(url: String): FetchResult {
        return try {
            val request = Request.Builder()
                .url(url)
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                )
                .header("Accept", "application/json, text/plain, */*")
                .build()
            httpClient.newCall(request).execute().use { response ->
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

    suspend fun checkLoginStatus(configuredDeveloperId: String? = null): CheckLoginResult =
        withContext(Dispatchers.IO) {
            val host = "https://developer.taptap.cn"

            val meResponse = fetchSync("$host/api/user/v1/me")

            // 401 / 403 -> not logged in
            if (meResponse.status == 401 || meResponse.status == 403) {
                return@withContext CheckLoginResult("unauthenticated", null)
            }
            // Network error / timeout
            if (meResponse.status == 0 || meResponse.error != null) {
                return@withContext CheckLoginResult("error", null, meResponse.error ?: "network_error")
            }

            val meJson = parseJson(meResponse.body)
            val meData = meJson?.asJsonObjectOrNull()?.get("data")?.asJsonObjectOrNull()
            val meDeveloperId = extractDeveloperIdFromData(meData)
            // 从 /me 里尽量抠出昵称 + 头像（字段名在 TapTap 不同版本里变动过，故多候选）
            val userProfile = extractUserProfile(meData)

            if (meDeveloperId != null) {
                return@withContext CheckLoginResult("ready", meDeveloperId, profile = userProfile)
            }

            // Fallback: developer list
            val listResponse = fetchSync("$host/api/developer/v1/list")
            if (listResponse.status == 0 || listResponse.error != null) {
                return@withContext CheckLoginResult("error", null, listResponse.error ?: "identity_unavailable")
            }
            val listJson = parseJson(listResponse.body)
            val ids = extractDeveloperIdsFromList(listJson)
            // 从 /list 里拿到开发者主体名 + Logo（作为开发者主体级别的工作室信息）
            val devProfile = extractDeveloperProfile(listJson, ids.firstOrNull())
            val merged = UserProfile(
                nickname = userProfile.nickname ?: devProfile.nickname,
                avatar = userProfile.avatar ?: devProfile.avatar,
                developerName = devProfile.developerName ?: userProfile.developerName,
                developerAvatar = devProfile.developerAvatar ?: userProfile.developerAvatar
            )
            if (ids.isEmpty()) {
                return@withContext CheckLoginResult("no-developer", null)
            }
            val configuredId = normalizeDeveloperId(configuredDeveloperId)
            val chosenId = if (configuredId != null && ids.contains(configuredId)) configuredId else ids[0]
            CheckLoginResult("ready", chosenId, profile = merged)
        }

    // -------------------------------------------------------------------------
    // account-state.js parity helpers
    // -------------------------------------------------------------------------

    private fun parseJson(body: String): JsonElement? {
        return try {
            if (body.isBlank()) null else JsonParser.parseString(body)
        } catch (_: Exception) {
            null
        }
    }

    /** data.developer_id ?? data.developerId ?? data.developer.id */
    private fun extractDeveloperIdFromMe(root: JsonElement?): String? {
        val data = root?.asJsonObjectOrNull()?.get("data") ?: return null
        return extractDeveloperIdFromData(data)
    }

    /** data.list[*] -> (developer_id ?? developerId ?? id) */
    private fun extractDeveloperIdsFromList(root: JsonElement?): List<String> {
        val data = root?.asJsonObjectOrNull()?.get("data")?.asJsonObjectOrNull() ?: return emptyList()
        val list = data.get("list")?.asJsonArrayOrNull() ?: return emptyList()
        val seen = linkedSetOf<String>()
        list.forEach { item ->
            val id = extractDeveloperIdFromItem(item)
            if (id != null) seen.add(id)
        }
        return seen.toList()
    }

    /**
     * `/api/user/v1/me` 返回的 `data` 字段里尝试抠出昵称和头像。
     * TapTap 不同历史版本字段名有变，这里兼容多种候选 key，同时支持嵌套的 `user`/`profile` 子对象。
     */
    private fun extractUserProfile(meData: JsonObject?): UserProfile {
        if (meData == null) return UserProfile()
        val nickname = firstNonBlankString(meData,
            "nickname", "name", "user_name", "username", "userName")
            ?: meData.get("user")?.asJsonObjectOrNull().let { firstNonBlankString(it,
                "nickname", "name", "user_name", "username") }
            ?: meData.get("profile")?.asJsonObjectOrNull().let { firstNonBlankString(it,
                "nickname", "name", "user_name", "username") }
        val avatar = firstNonBlankString(meData,
            "avatar", "avatar_url", "avatarUrl", "photo", "icon", "headimg", "head_img")
            ?: meData.get("user")?.asJsonObjectOrNull().let { firstNonBlankString(it,
                "avatar", "avatar_url", "photo", "icon") }
            ?: meData.get("profile")?.asJsonObjectOrNull().let { firstNonBlankString(it,
                "avatar", "avatar_url", "photo", "icon") }
        return UserProfile(nickname = nickname, avatar = avatar)
    }

    /**
     * `/api/developer/v1/list` 返回里抠出开发者主体（工作室）名 + Logo。
     * 若传入 chosenId，则优先匹配该 developer 的条目；否则取列表第一个。
     */
    private fun extractDeveloperProfile(root: JsonElement?, chosenId: String?): UserProfile {
        val data = root?.asJsonObjectOrNull()?.get("data")?.asJsonObjectOrNull() ?: return UserProfile()
        val list = data.get("list")?.asJsonArrayOrNull() ?: return UserProfile()
        val target: JsonObject? = if (chosenId != null) {
            list.firstOrNull { item ->
                val id = extractDeveloperIdFromItem(item)
                id == chosenId
            }?.asJsonObjectOrNull() ?: list.firstOrNull()?.asJsonObjectOrNull()
        } else {
            list.firstOrNull()?.asJsonObjectOrNull()
        }
        if (target == null) return UserProfile()
        val developerName = firstNonBlankString(target,
            "developer_name", "developerName", "name", "username", "nickname", "title")
        val developerAvatar = firstNonBlankString(target,
            "logo", "developer_logo", "developerLogo", "avatar", "icon", "avatar_url")
        return UserProfile(developerName = developerName, developerAvatar = developerAvatar)
    }

    private fun firstNonBlankString(obj: JsonObject?, vararg keys: String): String? {
        if (obj == null) return null
        for (key in keys) {
            val v = obj.get(key) ?: continue
            if (v.isJsonNull) continue
            if (!v.isJsonPrimitive) continue
            val p = v.asJsonPrimitive
            val s = when {
                p.isString -> p.asString.trim()
                p.isNumber -> p.asNumber.toString()
                else -> continue
            }
            if (s.isNotEmpty()) return s
        }
        return null
    }

    private fun extractDeveloperIdFromData(data: JsonElement?): String? {
        val obj = data?.asJsonObjectOrNull() ?: return null
        // Prefer developer_id / developerId on the data object itself.
        normalizeDeveloperId(obj.get("developer_id"))?.let { return it }
        normalizeDeveloperId(obj.get("developerId"))?.let { return it }
        // Then data.developer.id.
        val dev = obj.get("developer")?.asJsonObjectOrNull()
        if (dev != null) {
            normalizeDeveloperId(dev.get("id"))?.let { return it }
        }
        return null
    }

    private fun extractDeveloperIdFromItem(item: JsonElement?): String? {
        val obj = item?.asJsonObjectOrNull() ?: return null
        normalizeDeveloperId(obj.get("developer_id"))?.let { return it }
        normalizeDeveloperId(obj.get("developerId"))?.let { return it }
        normalizeDeveloperId(obj.get("id"))?.let { return it }
        return null
    }

    private fun normalizeDeveloperId(value: Any?): String? {
        if (value == null) return null
        if (value is JsonElement) {
            if (value.isJsonNull) return null
            if (!value.isJsonPrimitive) return null
            val p = value.asJsonPrimitive
            return when {
                p.isNumber -> try {
                    p.asBigDecimal.stripTrailingZeros().toPlainString().takeIf { it.all(Char::isDigit) }
                } catch (_: Exception) { null }
                p.isString -> normalizeDeveloperId(p.asString)
                else -> null
            }
        }
        if (value is Number) return value.toLong().toString()
        val raw = value.toString().trim()
        return when {
            raw.isEmpty() -> null
            raw.all(Char::isDigit) -> raw
            raw.matches(Regex("\\d+\\.0+")) -> raw.substringBefore('.')
            else -> null
        }
    }

    private fun JsonElement.asJsonObjectOrNull(): JsonObject? =
        if (isJsonObject) asJsonObject else null

    private fun JsonElement.asJsonArrayOrNull(): JsonArray? =
        if (isJsonArray) asJsonArray else null
}
