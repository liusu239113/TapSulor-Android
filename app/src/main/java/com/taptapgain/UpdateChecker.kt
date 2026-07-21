package com.taptapgain

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.browser.customtabs.CustomTabsIntent
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * App 自更新检查器。
 *
 * 协议：客户端 GET `${UPDATE_BASE_URL}version.json`（服务器由用户自行部署），返回字段：
 * ```json
 * {
 *   "latest_version": "1.0.1",
 *   "version_code": 2,
 *   "apk_url": "https://ark.yanyususu.online/tapsulor/TapSulor-v1.0.1.apk",
 *   "update_notes": "1. ...\n2. ...",
 *   "force_update": false,
 *   "download_page": "https://ark.yanyususu.online/tapsulor/",
 *   "published_at": "2026-07-21"
 * }
 * ```
 * 比较规则：服务器 `version_code` > `BuildConfig.VERSION_CODE` 时弹窗提示更新。
 * 下载动作：优先跳 `download_page`（走系统浏览器/Custom Tabs，浏览器负责下载 APK），
 * 若未提供则跳 `apk_url`。强制更新时只显示"立即更新"按钮、不允许关闭弹窗。
 */
class UpdateChecker(private val activity: Activity) {

    data class UpdateInfo(
        @SerializedName("latest_version") val latestVersion: String? = null,
        @SerializedName("version_code") val versionCode: Int = 0,
        @SerializedName("apk_url") val apkUrl: String? = null,
        @SerializedName("update_notes") val updateNotes: String? = null,
        @SerializedName("force_update") val forceUpdate: Boolean = false,
        @SerializedName("download_page") val downloadPage: String? = null,
        @SerializedName("published_at") val publishedAt: String? = null
    )

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    // 与 Activity 生命周期绑定；Activity 销毁时取消所有在途请求，避免泄漏
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private var currentDialog: AlertDialog? = null
    private var checking = false

    /**
     * 触发一次更新检查。
     * @param silent 静默模式：仅在发现新版本时弹窗，不弹"已是最新/网络错误"提示（冷启动用）。
     */
    fun check(silent: Boolean = false) {
        if (checking) return
        checking = true
        scope.launch {
            val info = fetchUpdateInfo()
            checking = false
            when {
                info == null -> if (!silent) {
                    Toast.makeText(activity, "检查更新失败，请稍后重试", Toast.LENGTH_SHORT).show()
                }
                info.versionCode > BuildConfig.VERSION_CODE -> showUpdateDialog(info)
                else -> if (!silent) {
                    Toast.makeText(
                        activity,
                        "已是最新版本（${BuildConfig.VERSION_NAME}）",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }
    }

    fun destroy() {
        scope.cancel()
        currentDialog?.dismiss()
        currentDialog = null
    }

    private suspend fun fetchUpdateInfo(): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("$UPDATE_BASE_URL$VERSION_JSON_PATH")
                .header("User-Agent", "TapSulor/${BuildConfig.VERSION_NAME} (Android)")
                .header("Accept", "application/json")
                .build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                val body = resp.body?.string()?.takeIf { it.isNotBlank() } ?: return@withContext null
                return@withContext try {
                    com.google.gson.Gson().fromJson(body, UpdateInfo::class.java)
                } catch (_: Exception) {
                    null
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun showUpdateDialog(info: UpdateInfo) {
        if (activity.isFinishing) return
        currentDialog?.dismiss()

        val version = info.latestVersion ?: info.versionCode.toString()
        val notes = info.updateNotes?.takeIf { it.isNotBlank() } ?: "修复已知问题，优化体验。"
        val title = if (info.forceUpdate) "发现重要更新 v$version" else "发现新版本 v$version"
        val message = buildString {
            append(notes)
            if (!info.publishedAt.isNullOrBlank()) {
                append("\n\n发布时间：").append(info.publishedAt)
            }
        }

        val builder = AlertDialog.Builder(activity)
            .setTitle(title)
            .setMessage(message)
            .setCancelable(!info.forceUpdate)
            .setPositiveButton("立即更新") { _, _ -> openDownloadPage(info) }

        if (!info.forceUpdate) {
            builder.setNegativeButton("稍后", null)
        }

        val dialog = builder.create()
        dialog.setCanceledOnTouchOutside(!info.forceUpdate)
        dialog.show()
        currentDialog = dialog
    }

    private fun openDownloadPage(info: UpdateInfo) {
        // 优先打开下载页（页面内可放 QR 码、多通道下载、历史版本），
        // 若未配置则直接打开 APK 直链。
        val target = info.downloadPage?.takeIf { it.isNotBlank() }
            ?: info.apkUrl?.takeIf { it.isNotBlank() }
            ?: UPDATE_BASE_URL
        val uri = Uri.parse(target)

        // 先尝试 Custom Tabs（体验更像内嵌浏览器，保留在 app 内），失败再回退系统浏览器。
        val launched = runCatching {
            val tabsIntent = CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
            tabsIntent.launchUrl(activity, uri)
            true
        }.getOrDefault(false)

        if (!launched) {
            try {
                activity.startActivity(
                    Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(activity, "未找到浏览器，请手动访问 $target", Toast.LENGTH_LONG).show()
            }
        }

        // 强制更新时跳到下载页后直接关闭 app，避免用户绕回旧版本继续使用。
        if (info.forceUpdate) {
            activity.finishAffinity()
        }
    }

    companion object {
        // 服务器根地址（用户部署在 https://ark.yanyususu.online/tapsulor/）。
        // 末尾需保留斜杠以拼 version.json 路径。
        private const val UPDATE_BASE_URL = "https://ark.yanyususu.online/tapsulor/"
        private const val VERSION_JSON_PATH = "version.json"
    }
}
