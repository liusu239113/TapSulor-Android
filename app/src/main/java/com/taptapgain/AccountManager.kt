package com.taptapgain

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson

data class Account(
    val id: String,
    val name: String,
    val developerId: String? = null,
    val partition: String = "persist:taptap"
)

data class AccountConfig(
    val current: String = "acc-1",
    val accounts: List<Account> = listOf(Account(id = "acc-1", name = "默认账号", partition = "persist:taptap"))
)

class AccountManager(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("taptapgain_accounts", Context.MODE_PRIVATE)
    private val gson = Gson()
    private val configKey = "accounts_config"

    fun loadConfig(): AccountConfig {
        val json = prefs.getString(configKey, null) ?: return AccountConfig()
        return try { gson.fromJson(json, AccountConfig::class.java) } catch (e: Exception) { AccountConfig() }
    }

    fun saveConfig(config: AccountConfig) { prefs.edit().putString(configKey, gson.toJson(config)).apply() }

    fun getCurrentAccount(): Account {
        val config = loadConfig()
        return config.accounts.find { it.id == config.current } ?: config.accounts.first()
    }

    fun getDeveloperId(): String? = getCurrentAccount().developerId

    fun setDeveloperId(developerId: String) {
        val config = loadConfig()
        val current = config.accounts.find { it.id == config.current } ?: config.accounts.first()
        if (current.developerId == null || current.developerId == "381509") {
            val updated = config.accounts.map { if (it.id == current.id) it.copy(developerId = developerId, name = "TapTap $developerId") else it }
            saveConfig(config.copy(accounts = updated))
        } else if (config.accounts.none { it.developerId == developerId }) {
            val newAcc = Account(id = "acc-${System.currentTimeMillis()}", name = "TapTap $developerId", developerId = developerId, partition = "persist:taptap-$developerId")
            saveConfig(config.copy(current = newAcc.id, accounts = config.accounts + newAcc))
        }
    }

    fun switchAccount(accountId: String): Boolean {
        val config = loadConfig()
        return if (config.accounts.any { it.id == accountId }) { saveConfig(config.copy(current = accountId)); true } else false
    }

    fun getAccounts(): List<Account> = loadConfig().accounts

    fun removeAccount(accountId: String): Boolean {
        val config = loadConfig()
        if (config.accounts.size <= 1) return false
        val filtered = config.accounts.filter { it.id != accountId }
        val newCurrent = if (config.current == accountId) filtered.first().id else config.current
        saveConfig(config.copy(current = newCurrent, accounts = filtered))
        return true
    }

    fun addAccount(name: String, developerId: String) {
        val config = loadConfig()
        val newAcc = Account(id = "acc-${System.currentTimeMillis()}", name = name, developerId = developerId, partition = "persist:taptap-$developerId")
        saveConfig(config.copy(current = newAcc.id, accounts = config.accounts + newAcc))
    }
}
