package com.taptapgain

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import com.google.gson.Gson

data class Account(
    val id: String,
    val name: String,
    val developerId: String? = null,
    val partition: String = "persist:taptap",
    val cookies: Map<String, String> = emptyMap()
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

class AccountManager(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("taptapgain_accounts", Context.MODE_PRIVATE)
    private val gson = Gson()
    private val configKey = "accounts_config"
    private val mainHandler = Handler(Looper.getMainLooper())

    private val sessionCookieUrls = listOf(
        "https://developer.taptap.cn/",
        "https://taptap.cn/",
        "https://www.taptap.cn/",
        "https://passport.taptap.cn/"
    )

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

    fun getDeveloperId(): String? = getCurrentAccount().developerId

    fun getAccountsPayload(): AccountConfig = loadConfig()

    /**
     * Bind the developer identity found in the current WebView session.
     * addMode keeps the existing account and creates/selects a separate account.
     */
    fun setDeveloperId(developerId: String, addMode: Boolean = false): AccountUpdate {
        val config = loadConfig()
        val current = config.accounts.find { it.id == config.current } ?: config.accounts.first()
        val existing = config.accounts.find { it.developerId == developerId }

        if (existing != null) {
            val wasCurrent = current.id == existing.id
            saveConfig(config.copy(current = existing.id))
            return AccountUpdate(
                developerId = developerId,
                switched = !wasCurrent,
                alreadyCurrent = wasCurrent
            )
        }

        if (!addMode || current.developerId.isNullOrBlank() || current.developerId == "381509") {
            val updated = config.accounts.map {
                if (it.id == current.id) it.copy(developerId = developerId, name = "TapTap $developerId") else it
            }
            saveConfig(config.copy(current = current.id, accounts = updated))
            return AccountUpdate(developerId = developerId, isNew = true)
        }

        val newAcc = Account(
            id = "acc-${System.currentTimeMillis()}",
            name = "TapTap $developerId",
            developerId = developerId,
            partition = "persist:taptap-$developerId"
        )
        saveConfig(config.copy(current = newAcc.id, accounts = config.accounts + newAcc))
        return AccountUpdate(developerId = developerId, isNew = true)
    }

    fun saveCurrentSessionCookies() {
        val config = loadConfig()
        val current = config.accounts.find { it.id == config.current } ?: return
        val cookieManager = CookieManager.getInstance()
        val cookies = sessionCookieUrls.mapNotNull { url ->
            cookieManager.getCookie(url)?.takeIf { it.isNotBlank() }?.let { url to it }
        }.toMap()
        val updated = config.accounts.map {
            if (it.id == current.id) it.copy(cookies = cookies) else it
        }
        saveConfig(config.copy(accounts = updated))
        cookieManager.flush()
    }

    fun captureCurrentSessionCookies() = saveCurrentSessionCookies()

    /** Clear the shared Android WebView cookie store before starting another login. */
    fun clearWebViewCookies(onComplete: () -> Unit = {}) {
        val cookieManager = CookieManager.getInstance()
        mainHandler.post {
            cookieManager.removeAllCookies {
                cookieManager.flush()
                mainHandler.post(onComplete)
            }
        }
    }

    /** Restore the selected account's saved WebView session. */
    fun restoreCurrentCookies(onComplete: () -> Unit = {}) {
        val cookies = getCurrentAccount().cookies
        val cookieManager = CookieManager.getInstance()
        mainHandler.post {
            cookieManager.removeAllCookies {
                cookies.forEach { (url, rawCookies) ->
                    rawCookies.split(';').map { it.trim() }.filter { it.contains('=') }.forEach { cookie ->
                        cookieManager.setCookie(url, "$cookie; Path=/")
                    }
                }
                cookieManager.flush()
                mainHandler.post(onComplete)
            }
        }
    }

    fun switchAccount(accountId: String): Boolean {
        val config = loadConfig()
        return if (config.accounts.any { it.id == accountId }) {
            saveConfig(config.copy(current = accountId))
            true
        } else {
            false
        }
    }

    fun removeAccount(accountId: String): Boolean {
        val config = loadConfig()
        if (config.accounts.size <= 1 || config.current == accountId) return false
        val filtered = config.accounts.filter { it.id != accountId }
        saveConfig(config.copy(accounts = filtered))
        return true
    }
}
