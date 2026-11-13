package com.taptapgain

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 备案监控前台服务：绑定邮箱后常驻通知栏，即使用户划掉 App 界面也继续每分钟查一轮
 * 当前账号下全部游戏的备案/广告状态（走用户自己的网络与 IP，服务器零压力），
 * 结果上报服务器，由服务器比对并发状态变化邮件。
 * 手机被杀后台/关机时，服务器对该账号自动按 10 分钟一轮兜底。
 */
class FilingMonitorService : Service() {

    companion object {
        const val CHANNEL_ID = "filing_monitor"
        const val NOTIF_ID = 1001
        const val INTERVAL_MS = 60_000L
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        const val FILING_BASE = "https://ark.yanyususu.online/tapsulor-filing"
        const val API = "https://developer.taptap.cn"

        private val running = AtomicBoolean(false)

        fun shouldRun(context: Context): Boolean {
            val p = context.getSharedPreferences("taptap_prefs", Context.MODE_PRIVATE)
            for ((k, v) in p.all) {
                if (k.startsWith("filing_enabled_") && v == true) {
                    val dev = k.removePrefix("filing_enabled_")
                    if (!p.getString("filing_token_$dev", null).isNullOrBlank()) return true
                }
            }
            return false
        }

        fun start(context: Context) {
            if (!shouldRun(context)) return
            val i = Intent(context, FilingMonitorService::class.java)
            context.startForegroundService(i)
        }

        fun stop(context: Context) {
            if (shouldRun(context)) return
            context.stopService(Intent(context, FilingMonitorService::class.java))
        }
    }

    private val client = OkHttpClient()
    private var thread: Thread? = null
    private lateinit var accountManager: AccountManager

    override fun onCreate() {
        super.onCreate()
        accountManager = AccountManager(this)
        startForegroundTyped()
        running.set(true)
        thread = Thread {
            while (running.get()) {
                try { scanAndReport() } catch (_: Exception) { }
                // 60 秒一轮；sleep 分片以便尽快响应停止
                var slept = 0L
                while (running.get() && slept < INTERVAL_MS) {
                    Thread.sleep(1000); slept += 1000
                }
            }
        }.apply { name = "filing-monitor"; start() }
    }

    private fun startForegroundTyped() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "备案状态监控", NotificationManager.IMPORTANCE_MIN)
            )
        }
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("TapSulor 备案监控运行中")
            .setContentText("每分钟检查备案/广告状态，状态变化发邮件提醒")
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(this, NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        running.set(false)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun prefs() = getSharedPreferences("taptap_prefs", Context.MODE_PRIVATE)

    private fun httpGet(url: String, cookieHeader: String): Pair<Int, String> {
        val b = Request.Builder().url(url)
            .header("User-Agent", UA)
            .header("Accept", "application/json, text/plain, */*")
        if (cookieHeader.isNotEmpty()) b.header("Cookie", cookieHeader)
        client.newCall(b.build()).execute().use { r ->
            return r.code to (r.body?.string() ?: "")
        }
    }

    private fun cookieHeaderFor(url: String): String {
        val host = try { java.net.URI(url).host ?: "" } catch (_: Exception) { "" }
        val all = accountManager.exportCookiesForServer()
        // 只发属于该域名的 Cookie + 剔除非法字符（Tomcat 对非法 Cookie 头直接 400）+ 控制总长
        fun legal(c: Map<String, String>): Boolean =
            ((c["name"] ?: "") + (c["value"] ?: "")).all { it.code in 0x21..0x7e } &&
                !(c["value"] ?: "").any { it == '"' || it == '\' || it == ';' || it == ',' || it == ' ' }
        val matched = all.filter { legal(it) }.filter { c ->
            val d = (c["domain"] ?: "").removePrefix(".").lowercase()
            d.isNotEmpty() && (host == d || host.endsWith(".$d"))
        }
        val picked = matched.ifEmpty { all.filter { legal(it) } }
        var header = picked.joinToString("; ") { "${it["name"]}=${it["value"]}" }
        while (header.length > 6500 && picked.isNotEmpty()) {
            picked.removeAt(picked.size - 1)
            header = picked.joinToString("; ") { "${it["name"]}=${it["value"]}" }
        }
        return header
    }

    private fun statusOf(appId: String, dev: String, ck: String): String? {
        val q = "?app_id=$appId&developer_id=$dev"
        // 产品口径：广告已开通即视为备案通过
        runCatching {
            val (ac, ab) = httpGet("$API/api/mini-app/v1/ad/info$q", cookieHeaderFor("$API/api/mini-app/v1/ad/info$q"))
            if (ac == 401 || ac == 403) return "UNAUTHORIZED"
            if (ac == 200) {
                val ad = JSONObject(ab).optJSONObject("data") ?: JSONObject()
                if (ad.optBoolean("is_enabled")) return "AD_ENABLED"
            }
        }
        runCatching {
            val (fc, fb) = httpGet("$API/api/mini-app/v2/filing/info$q", cookieHeaderFor("$API/api/mini-app/v2/filing/info$q"))
            if (fc == 401 || fc == 403) return "UNAUTHORIZED"
            if (fc == 200) {
                val d = JSONObject(fb).optJSONObject("data") ?: JSONObject()
                val st = if (d.has("status")) d.optInt("status") else d.optInt("filing_status")
                when (st) {
                    1 -> return "PENDING"
                    2 -> return "PASSED"
                    3 -> return "REJECTED"
                }
            }
        }
        return null // 查询失败：本轮不上报该游戏
    }

    private fun scanAndReport() {
        val p = prefs()
        val dev = accountManager.getActiveDeveloperId() ?: accountManager.getDeveloperId() ?: return
        val token = p.getString("filing_token_$dev", null) ?: return
        if (p.getBoolean("filing_enabled_$dev", false) != true) return

        // 游戏列表
        val (lc, lb) = httpGet("$API/api/app/v2/list?developer_id=$dev&page=1&pagesize=100", cookieHeaderFor("$API/api/app/v2/list"))
        if (lc != 200) return
        val list = JSONObject(lb).optJSONObject("data")?.optJSONArray("list") ?: return

        val statuses = JSONArray()
        for (i in 0 until list.length()) {
            if (!running.get()) return
            val app = list.optJSONObject(i) ?: continue
            val appId = app.optString("id")
            if (appId.isEmpty()) continue
            val st = statusOf(appId, dev, ck)
            when (st) {
                "UNAUTHORIZED" -> return // 登录态失效：不刷新上报时间，交给服务器兜底
                null -> Unit
                else -> statuses.put(JSONObject().put("app_id", appId).put("title", app.optString("title")).put("status", st))
            }
            Thread.sleep(150)
        }
        if (statuses.length() == 0) return

        val payload = JSONObject().put("statuses", statuses)
        val body = payload.toString().toRequestBody("application/json".toMediaType())
        val b = Request.Builder().url("$FILING_BASE/report").post(body)
            .header("User-Agent", UA)
            .header("Accept", "application/json")
            .header("X-Device-Token", token)
        client.newCall(b.build()).execute().use { }
    }
}
