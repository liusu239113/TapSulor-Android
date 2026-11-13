package com.taptapgain

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机自启：绑定过备案提醒的设备重启后自动恢复前台监控服务。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && FilingMonitorService.shouldRun(context)) {
            FilingMonitorService.start(context)
        }
    }
}
