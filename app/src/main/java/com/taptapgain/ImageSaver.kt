package com.taptapgain

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object ImageSaver {

    private const val TAG = "ImageSaver"
    private val client = OkHttpClient()

    fun saveImageFromUrl(context: Context, imageUrl: String) {
        val appContext = context.applicationContext
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val mimeType = guessMimeType(imageUrl)
                val fileName = generateFileName(imageUrl)

                val bytes = downloadImage(imageUrl)
                if (bytes == null) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(appContext, "下载图片失败", Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }

                val savedUri = saveBytesToGallery(appContext, bytes, fileName, mimeType)
                withContext(Dispatchers.Main) {
                    if (savedUri != null) {
                        Toast.makeText(appContext, "图片已保存到相册", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(appContext, "保存失败", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "saveImageFromUrl failed: $imageUrl", e)
                withContext(Dispatchers.Main) {
                    Toast.makeText(appContext, "保存图片失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun downloadImage(url: String): ByteArray? {
        return try {
            val request = Request.Builder().url(url).build()
            val response = client.newCall(request).execute()
            if (!response.isSuccessful) {
                Log.w(TAG, "download failed: ${response.code}")
                return null
            }
            response.body?.bytes()
        } catch (e: IOException) {
            Log.e(TAG, "download error", e)
            null
        }
    }

    private fun guessMimeType(url: String): String {
        val decoded = Uri.decode(url)
        val extension = decoded.substringAfterLast('.', "").substringBefore('?').lowercase(Locale.ROOT)
        return when (extension) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "bmp" -> "image/bmp"
            "svg" -> "image/svg+xml"
            else -> "image/jpeg"
        }
    }

    private fun generateFileName(url: String): String {
        val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
        val decoded = Uri.decode(url)
        val extension = decoded.substringAfterLast('.', "jpg")
            .substringBefore('?')
            .ifEmpty { "jpg" }
        return "TapSulor_$timestamp.$extension"
    }

    private fun saveBytesToGallery(
        context: Context,
        bytes: ByteArray,
        fileName: String,
        mimeType: String
    ): Uri? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveApi29Plus(context, bytes, fileName, mimeType)
        } else {
            saveLegacy(context, bytes, fileName)
        }
    }

    private fun saveApi29Plus(
        context: Context,
        bytes: ByteArray,
        fileName: String,
        mimeType: String
    ): Uri? {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
            put(MediaStore.Images.Media.MIME_TYPE, mimeType)
            put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/TapSulor")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values) ?: return null
        return try {
            resolver.openOutputStream(uri)?.use { os ->
                os.write(bytes)
                os.flush()
            }
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            uri
        } catch (e: Exception) {
            Log.e(TAG, "saveApi29Plus error", e)
            resolver.delete(uri, null, null)
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun saveLegacy(context: Context, bytes: ByteArray, fileName: String): Uri? {
        val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
        val targetDir = File(picturesDir, "TapSulor")
        if (!targetDir.exists()) targetDir.mkdirs()
        val file = File(targetDir, fileName)
        return try {
            FileOutputStream(file).use { it.write(bytes) }
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DATA, file.absolutePath)
                put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Images.Media.MIME_TYPE, guessMimeType(fileName))
            }
            context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
        } catch (e: Exception) {
            Log.e(TAG, "saveLegacy error", e)
            null
        }
    }
}
