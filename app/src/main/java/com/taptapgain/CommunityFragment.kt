package com.taptapgain

import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment

class CommunityFragment : Fragment() {

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val ctx = requireContext()

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(ContextCompat.getColor(ctx, R.color.bg_page))
        }

        val iconText = TextView(ctx).apply {
            text = "🚧"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_primary))
            textSize = 56f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        val titleText = TextView(ctx).apply {
            text = "Sulor社区"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_primary))
            textSize = 24f
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, dp(8))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        val descText = TextView(ctx).apply {
            text = "敬请期待"
            setTextColor(ContextCompat.getColor(ctx, R.color.color_primary))
            textSize = 16f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        root.addView(iconText)
        root.addView(titleText)
        root.addView(descText)

        // 社区占位页样式:图标/标题=主文本色,描述=强调色,全部跟随字体偏好
        FontHelper.applyFont(ctx, iconText, titleText)
        FontHelper.applyTopBarStyle(ctx, descText)

        // 缓存引用用于 onResume 时重新应用
        themedViews = ThemedViews(iconText, titleText, descText)

        return root
    }

    private data class ThemedViews(val icon: TextView, val title: TextView, val desc: TextView)
    private var themedViews: ThemedViews? = null

    override fun onResume() {
        super.onResume()
        // 从设置页返回时重新应用(用户可能刚切换字体/强调色)
        themedViews?.let { v ->
            val ctx = context ?: return
            FontHelper.applyFont(ctx, v.icon, v.title)
            FontHelper.applyTopBarStyle(ctx, v.desc)
        }
    }

    private fun dp(value: Int): Int {
        val density = resources.displayMetrics.density
        return (value * density + 0.5f).toInt()
    }
}
