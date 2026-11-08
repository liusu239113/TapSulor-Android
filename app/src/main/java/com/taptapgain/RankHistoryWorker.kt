package com.taptapgain

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 后台热度快照：App 关闭/被杀后仍由 WorkManager 每 20 分钟拉一次三榜，
 * 写入 SharedPreferences，页面打开时通过 getRankHistory() 合并进走势。
 */
class RankHistoryWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    companion object {
        const val PREFS = "taptap_prefs"
        const val KEY = "rank_bg_history_v1"
        const val KEEP = 504                     // 20 分钟 × 504 ≈ 7 天
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        private val BOARDS = listOf("hot" to 150, "new" to 100, "game_jam" to 100)

        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val periodic = PeriodicWorkRequestBuilder<RankHistoryWorker>(20, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "rank_history_periodic", ExistingPeriodicWorkPolicy.KEEP, periodic
            )
            // 启动时立刻补一条，避免等 20 分钟才有第一个点
            val once = OneTimeWorkRequestBuilder<RankHistoryWorker>()
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                "rank_history_now", ExistingWorkPolicy.KEEP, once
            )
        }
    }

    override fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val uid = prefs.getString("rank_uuid", null) ?: run {
            val v = java.util.UUID.randomUUID().toString()
            prefs.edit().putString("rank_uuid", v).apply()
            v
        }
        val xua = "V=1&PN=WebApp&LANG=zh_CN&VN_CODE=100000000&LOC=CN&PLT=PC&DS=Android&UID=$uid&OS=Windows&OSV=10&DT=PC"
        val encodedXua = java.net.URLEncoder.encode(xua, "UTF-8")
        val client = OkHttpClient()
        val all = try { JSONObject(prefs.getString(KEY, "{}") ?: "{}") } catch (_: Exception) { JSONObject() }
        val now = System.currentTimeMillis()

        for ((type, total) in BOARDS) {
            val items = JSONArray()
            var from = 0
            var realTotal = total
            while (from < total) {
                val url = "https://www.taptap.cn/webapiv2/app-top/v2/hits?type_name=$type&from=$from&limit=10&X-UA=$encodedXua"
                val req = Request.Builder().url(url)
                    .header("User-Agent", UA)
                    .header("Accept", "application/json, text/plain, */*")
                    .build()
                val body = try {
                    client.newCall(req).execute().use { if (it.isSuccessful) it.body?.string() else null }
                } catch (_: Exception) { null } ?: break
                val root = try { JSONObject(body) } catch (_: Exception) { break }
                val data = root.optJSONObject("data") ?: break
                realTotal = data.optInt("total", total)
                val list = data.optJSONArray("list") ?: break
                if (list.length() == 0) break
                for (i in 0 until list.length()) {
                    val app = list.optJSONObject(i)?.optJSONObject("app") ?: continue
                    val id = app.optString("id")
                    if (id.isEmpty()) continue
                    val hits = app.optJSONObject("stat")?.optLong("hits_total", 0L) ?: 0L
                    val arr = JSONArray()
                    arr.put(id)
                    arr.put(from + i + 1)
                    arr.put(hits)
                    items.put(arr)
                }
                from += 10
                if (from >= realTotal) break
            }
            if (items.length() == 0) continue

            val snap = JSONObject().put("ts", now).put("items", items)
            val old = all.optJSONArray(type) ?: JSONArray()
            val out = JSONArray()
            var replaced = false
            for (i in 0 until old.length()) {
                val s = old.optJSONObject(i) ?: continue
                if (!replaced && i == old.length() - 1 && now - s.optLong("ts") < 5 * 60 * 1000L) {
                    out.put(snap)
                    replaced = true
                } else {
                    out.put(s)
                }
            }
            if (!replaced) out.put(snap)

            val keep = JSONArray()
            val start = if (out.length() > KEEP) out.length() - KEEP else 0
            for (i in start until out.length()) keep.put(out.get(i))
            all.put(type, keep)
        }
        prefs.edit().putString(KEY, all.toString()).apply()
        return Result.success()
    }
}
