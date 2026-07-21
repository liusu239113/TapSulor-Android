package com.taptapgain

import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.net.Uri
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
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

    private var currentDialog: Dialog? = null
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
        val title = if (info.forceUpdate) "发现重要更新" else "发现新版本"

        // 读取 WebView 侧同步过来的主题偏好（冷启动时可能还未同步，使用默认值）
        val prefs = activity.getSharedPreferences("taptap_prefs", Context.MODE_PRIVATE)
        val isDark = prefs.getString("theme_mode", "light") == "dark"
        val accent = prefs.getString("theme_accent", "cyan") ?: "cyan"

        // 使用浅色像素/Win95 风 Dialog，与 app 控制面板视觉一致
        val dialog = Dialog(activity, R.style.Theme_TapTapGain_UpdateDialog)
        dialog.setContentView(R.layout.dialog_update)
        dialog.setCancelable(!info.forceUpdate)
        dialog.setCanceledOnTouchOutside(!info.forceUpdate)

        // 设置窗口宽度（屏幕宽度的 86%，两侧留白）、居中
        val window = dialog.window
        window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        val lp = window?.attributes
        lp?.width = (activity.resources.displayMetrics.widthPixels * 0.86f).toInt()
        lp?.height = ViewGroup.LayoutParams.WRAP_CONTENT
        lp?.gravity = Gravity.CENTER
        window?.attributes = lp

        // 应用主题色（通过代码动态着色，覆盖 XML 硬编码色）
        applyDialogTheme(dialog, isDark, accent)

        // 填充内容
        dialog.findViewById<TextView>(R.id.tvLabel).text = "控制面板"
        dialog.findViewById<TextView>(R.id.tvTitle).text = title
        dialog.findViewById<TextView>(R.id.tvVersionBadge).text = "v$version"
        dialog.findViewById<TextView>(R.id.tvNotes).text = notes

        val tvPublishedAt = dialog.findViewById<TextView>(R.id.tvPublishedAt)
        if (!info.publishedAt.isNullOrBlank()) {
            tvPublishedAt.text = "发布时间：${info.publishedAt}"
            tvPublishedAt.visibility = View.VISIBLE
        } else {
            tvPublishedAt.visibility = View.GONE
        }

        // 按钮事件
        val btnUpdate = dialog.findViewById<TextView>(R.id.btnUpdate)
        val btnLater = dialog.findViewById<TextView>(R.id.btnLater)
        val btnClose = dialog.findViewById<TextView>(R.id.btnClose)

        btnUpdate.setOnClickListener {
            dialog.dismiss()
            currentDialog = null
            openDownloadPage(info)
        }

        if (info.forceUpdate) {
            // 强制更新：隐藏"稍后"与右上角关闭按钮，主按钮（已设 weight=1）会自动占满整行
            btnLater.visibility = View.GONE
            btnClose.visibility = View.GONE
        } else {
            val dismissAction = View.OnClickListener {
                dialog.dismiss()
                currentDialog = null
            }
            btnLater.setOnClickListener(dismissAction)
            btnClose.setOnClickListener(dismissAction)
        }

        dialog.show()
        currentDialog = dialog
    }

    // 根据主题色给 Dialog 的所有控件动态着色（Win95/像素风：0 圆角，2px 硬边）
    private fun applyDialogTheme(dialog: Dialog, isDark: Boolean, accent: String) {
        val c = AccentColors.get(accent)
        val bgCard = if (isDark) Color.parseColor("#1E242F") else Color.WHITE
        val bgMuted = if (isDark) Color.parseColor("#262D3A") else Color.parseColor("#EEF2F7")
        val textPrimary = if (isDark) Color.parseColor("#ECF0F5") else Color.parseColor("#1C2530")
        val textSecondary = if (isDark) Color.parseColor("#A6B0BD") else Color.parseColor("#4A5260")
        val textTertiary = if (isDark) Color.parseColor("#6F7B8C") else Color.parseColor("#8491A3")
        val borderStrong = if (isDark) Color.parseColor("#3E4858") else Color.parseColor("#B7C2D0")
        val danger = Color.parseColor("#FF6B6B")
        val dangerBorder = Color.parseColor("#D94C4C")
        val accentColor = Color.parseColor(c.accent)
        val accentInk = Color.parseColor(c.accentInk)

        val dp2 = dp(2)

        // Dialog 根背景：bg-card + accent 2px 描边 + 6px 右下阴影（纯色模拟）
        val root = dialog.findViewById<View>(R.id.dialogRoot) ?: return
        root.background = GradientDrawable().apply {
            setColor(bgCard)
            setStroke(dp2, accentColor)
            cornerRadius = 0f
        }

        // 顶部小标题（"控制面板"）
        dialog.findViewById<TextView>(R.id.tvLabel)?.apply {
            setTextColor(accentColor)
        }
        // 主标题
        dialog.findViewById<TextView>(R.id.tvTitle)?.apply {
            setTextColor(textPrimary)
        }
        // 版本徽章：accent 实心
        dialog.findViewById<TextView>(R.id.tvVersionBadge)?.apply {
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply {
                setColor(accentColor)
                cornerRadius = 0f
            }
        }
        // 更新说明
        dialog.findViewById<TextView>(R.id.tvNotes)?.apply {
            setTextColor(textPrimary)
        }
        // 发布时间
        dialog.findViewById<TextView>(R.id.tvPublishedAt)?.apply {
            setTextColor(textTertiary)
        }

        // 关闭按钮（danger 红，保持 Win95 raised）
        dialog.findViewById<TextView>(R.id.btnClose)?.apply {
            setTextColor(Color.WHITE)
            background = win95Button(danger, dangerBorder, dp2)
        }

        // 主按钮（立即更新）：accent-ink 底色 + accent 高亮凸起
        dialog.findViewById<TextView>(R.id.btnUpdate)?.apply {
            setTextColor(Color.WHITE)
            background = win95Button(accentInk, accentColor, dp2)
        }

        // 次按钮（稍后）：浅/暗模式不同色
        dialog.findViewById<TextView>(R.id.btnLater)?.apply {
            setTextColor(textPrimary)
            background = win95Button(bgMuted, borderStrong, dp2)
        }
    }

    // Win95/像素风凸起按钮：底层 base 色（右下露出 2px 阴影），上层 highlight 色（主体），按下时凹陷
    private fun win95Button(baseColor: Int, highlightColor: Int, insetPx: Int): StateListDrawable {
        val base = GradientDrawable().apply { setColor(baseColor); cornerRadius = 0f }
        val highlight = GradientDrawable().apply { setColor(highlightColor); cornerRadius = 0f }
        // 默认态：主体向上/左偏移 insetPx，露出右下 base 边（凸起阴影）
        val normalLayer = LayerDrawable(arrayOf(base, highlight)).apply {
            setLayerInset(1, 0, 0, insetPx, insetPx)
        }
        // 按下态：主体向下/右偏移 insetPx，露出左上 base 边（凹陷效果）
        val pressedLayer = LayerDrawable(arrayOf(base, highlight)).apply {
            setLayerInset(1, insetPx, insetPx, 0, 0)
        }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), pressedLayer)
            addState(intArrayOf(), normalLayer)
        }
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value.toFloat(),
            activity.resources.displayMetrics
        ).toInt()
    }

    // 强调色映射（与 CSS :root 变量对应）
    private enum class AccentColors(val accent: String, val accentInk: String) {
        cyan("#25B6E9", "#0E7FA8"),
        pink("#FF7FB3", "#B84179"),
        purple("#8B7CF6", "#5A49C9"),
        mint("#36C9A0", "#1F8C6D");
        companion object {
            fun get(name: String?): AccentColors = values().firstOrNull { it.name == name } ?: cyan
        }
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
