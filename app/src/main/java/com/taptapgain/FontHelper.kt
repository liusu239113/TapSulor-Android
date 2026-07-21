package com.taptapgain

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * App 主题/字体助手：根据 web 端同步到 SharedPreferences 的偏好,
 * 为 Native 顶栏/弹窗/占位页等非 WebView 区域统一提供字体与强调色。
 *
 * 字体键:    "default"(系统字体) / "pixel"(UserPixel 像素体) / "chaoku"(潮酷体)
 *            与 webapp css [data-font] 取值一致。
 * 主题模式:  "light" / "dark"  (日间/夜间,原生 UI 仍主要走 DayNight 资源)
 * 强调色键:  "cyan" / "pink" / "purple" / "mint" (与 webapp data-accent 对齐)
 *
 * 写入方:     WebAppInterface.syncPreferences(mode, accent, font)
 */
object FontHelper {
    private const val PREFS_NAME = "taptap_prefs"
    private const val KEY_FONT = "font_family"
    private const val KEY_ACCENT = "theme_accent"
    private const val KEY_MODE = "theme_mode"

    // 与 webapp assets/fonts/ 对齐
    private const val FONT_PIXEL = "fonts/PixelFont.ttf"
    private const val FONT_CHAOKU = "fonts/ChaoKuFont.ttf"

    // 进程内缓存,避免每次 createFromAsset
    @Volatile private var pixelTypeface: Typeface? = null
    @Volatile private var chaoKuTypeface: Typeface? = null

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // ---------- 字体 ----------

    /** 返回当前字体偏好 ("default" | "pixel" | "chaoku") */
    fun currentFontKey(ctx: Context): String = prefs(ctx).getString(KEY_FONT, "default") ?: "default"

    /** 返回当前偏好对应的 Typeface;default 返回 null(让 TextView 用系统字体) */
    fun currentTypeface(ctx: Context): Typeface? {
        val app = ctx.applicationContext
        return when (currentFontKey(ctx)) {
            "pixel" -> pixelTypeface ?: Typeface.createFromAsset(app.assets, FONT_PIXEL).also { pixelTypeface = it }
            "chaoku" -> chaoKuTypeface ?: Typeface.createFromAsset(app.assets, FONT_CHAOKU).also { chaoKuTypeface = it }
            else -> null
        }
    }

    /** 把当前字体应用到任意多个 TextView 上 */
    fun applyFont(ctx: Context, vararg views: TextView) {
        val tf = currentTypeface(ctx)
        for (v in views) {
            v.typeface = tf ?: Typeface.DEFAULT
        }
    }

    // 兼容旧调用名
    fun apply(ctx: Context, vararg views: TextView) = applyFont(ctx, *views)

    // ---------- 强调色 ----------

    /** 强调色键 -> 深色/浅色模式下的颜色值(与 webapp CSS 变量 --accent 对齐) */
    enum class Accent(val key: String, val hex: String) {
        CYAN("cyan", "#25B6E9"),
        PINK("pink", "#FF7FB3"),
        PURPLE("purple", "#8B7CF6"),
        MINT("mint", "#36C9A0");
        companion object {
            fun fromKey(key: String?): Accent = values().firstOrNull { it.key == key } ?: CYAN
        }
    }

    /** 返回当前强调色键 */
    fun currentAccentKey(ctx: Context): String = prefs(ctx).getString(KEY_ACCENT, "cyan") ?: "cyan"

    /** 返回当前强调色(颜色 int,已解析 alpha) */
    fun currentAccentColor(ctx: Context): Int =
        Color.parseColor(Accent.fromKey(currentAccentKey(ctx)).hex)

    /** 是否为深色模式 */
    fun isDarkMode(ctx: Context): Boolean = prefs(ctx).getString(KEY_MODE, "light") == "dark"

    /**
     * 把当前主题样式应用到一组"顶部栏按钮 TextView"上:
     * - 字体跟随 font_family
     * - 文字颜色跟随 theme_accent(强调色)
     * 注: 该方法不会修改 TextView 的 textSize/padding/gravity 等布局属性,只改字体与颜色。
     */
    fun applyTopBarStyle(ctx: Context, vararg accentViews: TextView) {
        val tf = currentTypeface(ctx)
        val accent = currentAccentColor(ctx)
        for (v in accentViews) {
            v.typeface = tf ?: Typeface.DEFAULT
            v.setTextColor(accent)
        }
    }
}
