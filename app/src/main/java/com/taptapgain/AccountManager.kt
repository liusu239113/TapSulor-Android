package com.taptapgain

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import com.google.gson.reflect.TypeToken
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.concurrent.ConcurrentHashMap

data class Account(
    val id: String,
    val name: String,
    val developerId: String? = null,
    val partition: String = "persist:taptap",
    /** 账号（用户）昵称，来自 /api/user/v1/me */
    val nickname: String? = null,
    /** 账号（用户）头像 URL，来自 /api/user/v1/me */
    val avatar: String? = null,
    /** 开发者主体/工作室名称，来自 /api/developer/v1/list */
    val developerName: String? = null,
    /** 开发者主体/工作室 Logo URL，来自 /api/developer/v1/list */
    val developerAvatar: String? = null,
    /** 当前账号下可用的工作室/厂商身份列表 */
    val studios: List<StudioRef> = emptyList(),
    /** 当前选中的工作室 id（默认等于 developerId，切换后更新） */
    val activeDeveloperId: String? = null
)

/** 简化的工作室引用（用于持久化，引用 TapTapApiClient.Studio 的子集） */
data class StudioRef(
    val id: String,
    val name: String? = null,
    val logo: String? = null
)

data class AccountConfig(
    val current: String = "acc-1",
    val accounts: List<Account> = listOf(Account(id = "acc-1", name = "默认账号", partition = "persist:taptap"))
)

data class AccountUpdate(
    val developerId: String,
    val isNew: Boolean = false,
    val switched: Boolean = false,
    val alreadyCurrent: Boolean = false
)

/**
 * 序列化用的 Cookie DTO。OkHttp 的 Cookie 类字段不便直接 Gson 序列化，
 * 这里仅保留重新构造 Cookie 所需的全部属性。
 */
private data class CookieDto(
    @SerializedName("n") val name: String,
    @SerializedName("v") val value: String,
    @SerializedName("d") val domain: String,
    @SerializedName("p") val path: String,
    @SerializedName("s") val secure: Boolean,
    @SerializedName("h") val httpOnly: Boolean,
    @SerializedName("ho") val hostOnly: Boolean,
    @SerializedName("persist") val persistent: Boolean,
    @SerializedName("e") val expiresAt: Long
) {
    fun toCookie(): Cookie {
        val builder = Cookie.Builder()
            .name(name)
            .value(value)
            .path(path)
        if (hostOnly) builder.hostOnlyDomain(domain) else builder.domain(domain)
        if (secure) builder.secure()
        if (httpOnly) builder.httpOnly()
        if (persistent) builder.expiresAt(expiresAt)
        return builder.build()
    }

    companion object {
        fun fromCookie(c: Cookie): CookieDto = CookieDto(
            name = c.name,
            value = c.value,
            domain = c.domain,
            path = c.path,
            secure = c.secure,
            httpOnly = c.httpOnly,
            hostOnly = c.hostOnly,
            persistent = c.persistent,
            expiresAt = c.expiresAt
        )
    }
}

class AccountManager(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("taptapgain_accounts", Context.MODE_PRIVATE)
    private val gson = Gson()
    private val configKey = "accounts_config"
    private val cookieKeyPrefix = "account_cookies_"
    private val mainHandler = Handler(Looper.getMainLooper())

    /** In-memory per-account cookie store: accountId -> cookies. */
    private val cookieStore = ConcurrentHashMap<String, MutableList<Cookie>>()

    /** TapTap 根域，WebView 导入时用这些 URL 拉取所有相关 cookie。 */
    private val taptapCookieUrls = listOf(
        "https://developer.taptap.cn/",
        "https://www.taptap.cn/",
        "https://passport.taptap.cn/",
        "https://taptap.cn/"
    )

    private val cookieListType = object : TypeToken<List<CookieDto>>() {}.type

    init {
        // Preload all accounts' cookies from SharedPreferences into memory.
        val config = loadConfig()
        config.accounts.forEach { acc ->
            cookieStore[acc.id] = loadCookiesFromPrefs(acc.id).toMutableList()
        }
    }

    // -------------------------------------------------------------------------
    // Account config
    // -------------------------------------------------------------------------

    fun loadConfig(): AccountConfig {
        val json = prefs.getString(configKey, null) ?: return AccountConfig()
        return try {
            gson.fromJson(json, AccountConfig::class.java) ?: AccountConfig()
        } catch (_: Exception) {
            AccountConfig()
        }
    }

    fun saveConfig(config: AccountConfig) {
        prefs.edit().putString(configKey, gson.toJson(config)).apply()
    }

    fun getCurrentAccount(): Account {
        val config = loadConfig()
        return config.accounts.find { it.id == config.current } ?: config.accounts.first()
    }

    fun getCurrentAccountId(): String = getCurrentAccount().id

    fun getDeveloperId(): String? {
        val acc = getCurrentAccount()
        return acc.activeDeveloperId ?: acc.developerId
    }

    /** 获取当前账号的工作室列表 */
    fun getStudios(): List<StudioRef> = getCurrentAccount().studios

    /** 获取当前激活的工作室 id */
    fun getActiveDeveloperId(): String? = getDeveloperId()

    /**
     * 在当前账号内切换工作室（厂商身份）。
     * 仅更新 activeDeveloperId 和显示用的 developerName/Logo，不切换 cookie。
     */
    fun switchStudio(developerId: String): Boolean {
        val config = loadConfig()
        val current = config.accounts.find { it.id == config.current } ?: return false
        if (current.studios.none { it.id == developerId }) return false
        val studio = current.studios.firstOrNull { it.id == developerId } ?: return false
        val updated = current.copy(
            activeDeveloperId = developerId,
            developerName = studio.name ?: current.developerName,
            developerAvatar = studio.logo ?: current.developerAvatar
        )
        val newAccounts = config.accounts.map { if (it.id == current.id) updated else it }
        saveConfig(config.copy(accounts = newAccounts))
        return true
    }

    fun getAccountsPayload(): AccountConfig = loadConfig()

    fun setDeveloperId(developerId: String, addMode: Boolean = false): AccountUpdate {
        val config = loadConfig()
        val current = config.accounts.find { it.id == config.current } ?: config.accounts.first()
        val existing = config.accounts.find { it.developerId == developerId }

        if (existing != null) {
            val wasCurrent = current.id == existing.id
            saveConfig(config.copy(current = existing.id))
            return AccountUpdate(developerId = developerId, switched = !wasCurrent, alreadyCurrent = wasCurrent)
        }

        if (!addMode || current.developerId.isNullOrBlank()) {
            // Update current account in place.
            val partition = "persist:taptap-$developerId"
            val updated = config.accounts.map {
                if (it.id == current.id) it.copy(developerId = developerId, name = "TapTap $developerId", partition = partition) else it
            }
            saveConfig(config.copy(current = current.id, accounts = updated))
            return AccountUpdate(developerId = developerId, isNew = true)
        }

        // Add a brand-new account.
        val newAcc = Account(
            id = "acc-${System.currentTimeMillis()}",
            name = "TapTap $developerId",
            developerId = developerId,
            partition = "persist:taptap-$developerId"
        )
        cookieStore.putIfAbsent(newAcc.id, mutableListOf())
        saveConfig(config.copy(current = newAcc.id, accounts = config.accounts + newAcc))
        return AccountUpdate(developerId = developerId, isNew = true)
    }

    /**
     * 更新某个账号的昵称/头像/开发者主体名/Logo/工作室列表。任意字段传 null 表示不更新该字段。
     * 必须匹配 developerId（如果提供）以避免把数据写到错误账号。
     */
    fun updateAccountProfile(
        accountId: String? = null,
        developerId: String? = null,
        nickname: String? = null,
        avatar: String? = null,
        developerName: String? = null,
        developerAvatar: String? = null,
        studios: List<StudioRef>? = null,
        activeDeveloperId: String? = null
    ): Account? {
        val config = loadConfig()
        val targetId = accountId
            ?: config.accounts.find { it.developerId == developerId }?.id
            ?: config.current
        var updated: Account? = null
        val newAccounts = config.accounts.map { acc ->
            if (acc.id != targetId) return@map acc
            val merged = acc.copy(
                nickname = nickname ?: acc.nickname,
                avatar = avatar ?: acc.avatar,
                developerName = developerName ?: acc.developerName,
                developerAvatar = developerAvatar ?: acc.developerAvatar,
                studios = studios ?: acc.studios,
                activeDeveloperId = activeDeveloperId ?: acc.activeDeveloperId,
                // 如果有 developerName 且当前 name 还是默认的 "TapTap xxx"，用更可读的名字覆盖
                name = if (!developerName.isNullOrBlank() && acc.name.startsWith("TapTap ")) developerName else acc.name
            )
            updated = merged
            merged
        }
        saveConfig(config.copy(accounts = newAccounts))
        return updated
    }

    fun switchAccount(accountId: String): Boolean {
        val config = loadConfig()
        if (config.accounts.none { it.id == accountId }) return false
        saveConfig(config.copy(current = accountId))
        return true
    }

    fun removeAccount(accountId: String): Boolean {
        val config = loadConfig()
        if (config.accounts.size <= 1 || config.current == accountId) return false
        val filtered = config.accounts.filter { it.id != accountId }
        saveConfig(config.copy(accounts = filtered))
        cookieStore.remove(accountId)
        prefs.edit().remove(cookieKeyPrefix + accountId).apply()
        return true
    }

    // -------------------------------------------------------------------------
    // Per-account cookie store (used by TapTapApiClient's CookieJar)
    // -------------------------------------------------------------------------

    /** Merge new cookies from a Set-Cookie response into the account's store. */
    fun addCookies(accountId: String, url: HttpUrl, cookies: List<Cookie>) {
        val store = cookieStore.getOrPut(accountId) { mutableListOf() }
        synchronized(store) {
            cookies.forEach { newCookie ->
                store.removeAll { existing ->
                    existing.name == newCookie.name &&
                            existing.domain == newCookie.domain &&
                            existing.path == newCookie.path
                }
                // Remove expired cookies
                if (!newCookie.persistent || newCookie.expiresAt > System.currentTimeMillis()) {
                    store.add(newCookie)
                }
            }
            // Also purge any expired cookies from the store
            val now = System.currentTimeMillis()
            store.removeAll { it.persistent && it.expiresAt <= now }
        }
        persistCookies(accountId)
    }

    /** Return cookies that should be sent for a request to [url]. */
    fun getCookiesForUrl(accountId: String, url: HttpUrl): List<Cookie> {
        val store = cookieStore[accountId] ?: return emptyList()
        val now = System.currentTimeMillis()
        val isHttps = url.isHttps
        val host = url.host
        val path = url.encodedPath
        synchronized(store) {
            store.removeAll { it.persistent && it.expiresAt <= now }
            return store.filter { c ->
                if (c.secure && !isHttps) return@filter false
                if (!domainMatches(c, host)) return@filter false
                if (!pathMatches(c, path)) return@filter false
                true
            }
        }
    }

    private fun domainMatches(cookie: Cookie, host: String): Boolean {
        return if (cookie.hostOnly) {
            host.equals(cookie.domain, ignoreCase = true)
        } else {
            val domain = cookie.domain.removePrefix(".")
            host.equals(domain, ignoreCase = true) ||
                    host.endsWith(".$domain", ignoreCase = true)
        }
    }

    private fun pathMatches(cookie: Cookie, requestPath: String): Boolean {
        val cookiePath = cookie.path
        if (cookiePath == "/" || requestPath == cookiePath) return true
        if (requestPath.startsWith(cookiePath)) {
            return cookiePath.endsWith("/") || requestPath[cookiePath.length] == '/'
        }
        return false
    }

    // -------------------------------------------------------------------------
    // WebView <-> per-account store sync
    // -------------------------------------------------------------------------

    /**
     * After the user finishes logging in inside WebView, the global CookieManager
     * contains all of TapTap's session cookies. Pull them into the current
     * account's store so future OkHttp requests and account switches use them.
     */
    fun importCookiesFromWebView(accountId: String) {
        val cookieManager = CookieManager.getInstance()
        val collected = linkedMapOf<String, Cookie>() // keyed by "name|domain|path"
        val baseUrl = "https://developer.taptap.cn/".toHttpUrl()
        for (urlStr in taptapCookieUrls) {
            val raw = cookieManager.getCookie(urlStr) ?: continue
            val url = urlStr.toHttpUrl()
            raw.split(';').forEach { part ->
                val pair = part.trim().split('=', limit = 2)
                if (pair.size != 2 || pair[0].isBlank()) return@forEach
                val name = pair[0].trim()
                val value = pair[1].trim()
                // WebView's getCookie does not return attributes; build a permissive cookie
                // scoped to the URL's host with path "/". This is sufficient for API calls
                // to developer.taptap.cn which is the only endpoint OkHttp talks to.
                try {
                    val c = Cookie.Builder()
                        .name(name)
                        .value(value)
                        .domain(url.host)
                        .path("/")
                        .build()
                    val key = "$name|${url.host}|/"
                    // Last write wins; the most specific URL's cookie takes precedence is fine here
                    collected[key] = c
                } catch (_: Exception) { /* skip invalid */ }
            }
        }
        val store = cookieStore.getOrPut(accountId) { mutableListOf() }
        synchronized(store) {
            collected.values.forEach { newCookie ->
                store.removeAll { it.name == newCookie.name && it.domain == newCookie.domain && it.path == newCookie.path }
                store.add(newCookie)
            }
        }
        persistCookies(accountId)
    }

    /** Capture alias kept for compatibility with existing callers. */
    fun captureCurrentSessionCookies() {
        importCookiesFromWebView(getCurrentAccountId())
    }

    fun saveCurrentSessionCookies() = captureCurrentSessionCookies()

    /**
     * Push the account's cookies into the global WebView CookieManager so that
     * the WebView sees the correct session for the active account.
     * Must be called on the main thread (or posts itself there).
     */
    fun syncCookiesToWebView(accountId: String, onComplete: () -> Unit = {}) {
        val cookies = cookieStore[accountId]?.toList() ?: emptyList()
        val cookieManager = CookieManager.getInstance()
        mainHandler.post {
            cookieManager.removeAllCookies {
                cookies.forEach { c ->
                    val url = "${if (c.secure) "https" else "http"}://${c.domain}${c.path}"
                    val setCookieHeader = buildString {
                        append(c.name).append('=').append(c.value)
                        append("; Domain=").append(if (c.hostOnly) c.domain else ".$c.domain")
                        append("; Path=").append(c.path)
                        if (c.secure) append("; Secure")
                        if (c.httpOnly) append("; HttpOnly")
                    }
                    cookieManager.setCookie(url, setCookieHeader)
                }
                cookieManager.flush()
                mainHandler.post(onComplete)
            }
        }
    }

    /** Alias kept for callers that restore at startup. */
    fun restoreCurrentCookies(onComplete: () -> Unit = {}) {
        syncCookiesToWebView(getCurrentAccountId(), onComplete)
    }

    /** Clear the shared Android WebView cookie store (before starting a new login). */
    fun clearWebViewCookies(onComplete: () -> Unit = {}) {
        val cookieManager = CookieManager.getInstance()
        mainHandler.post {
            cookieManager.removeAllCookies {
                cookieManager.flush()
                mainHandler.post(onComplete)
            }
        }
    }

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------

    private fun persistCookies(accountId: String) {
        val store = cookieStore[accountId] ?: return
        val dtos = synchronized(store) { store.map(CookieDto::fromCookie) }
        prefs.edit().putString(cookieKeyPrefix + accountId, gson.toJson(dtos)).apply()
    }

    private fun loadCookiesFromPrefs(accountId: String): List<Cookie> {
        val json = prefs.getString(cookieKeyPrefix + accountId, null) ?: return emptyList()
        return try {
            val dtos: List<CookieDto> = gson.fromJson(json, cookieListType) ?: return emptyList()
            dtos.map { it.toCookie() }
        } catch (_: Exception) {
            emptyList()
        }
    }
}
