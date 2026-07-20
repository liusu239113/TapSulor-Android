package com.taptapgain

import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 沉浸式全屏工具：隐藏状态栏与导航栏，滑屏时短暂显示后自动收起。
 * 在 Activity.onCreate 与 onWindowFocusChanged(hasFocus=true) 中调用 [enableImmersiveMode]。
 */
fun AppCompatActivity.enableImmersiveMode() {
    // 允许内容绘制到系统栏区域（edge-to-edge），避免隐藏状态下出现黑边
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.hide(WindowInsetsCompat.Type.statusBars() or WindowInsetsCompat.Type.navigationBars())
    // 从边缘向内滑时临时显示系统栏，数秒后自动隐藏，且不会重新布局
    controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
}
