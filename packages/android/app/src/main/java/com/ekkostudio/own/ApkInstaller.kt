package com.ekkostudio.own

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.webkit.CookieManager
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLDecoder
import java.net.URL

/** Downloads an APK from the Studio server and hands it to Android's package installer. */
object ApkInstaller {
    const val ACTION_STATUS = "com.ekkostudio.own.APK_INSTALL_STATUS"
    private const val MAX_BYTES = 512L * 1024 * 1024

    /** True for a download that is an APK, judged by type, file name or URL. */
    fun isApk(url: String, contentDisposition: String?, mimeType: String?): Boolean {
        if (mimeType.equals("application/vnd.android.package-archive", ignoreCase = true)) return true
        val name = fileName(url, contentDisposition)
        return name.endsWith(".apk", ignoreCase = true)
    }

    /** The file name from Content-Disposition, Studio's `name`/`path` query, or the URL path. */
    fun fileName(url: String, contentDisposition: String?): String {
        val decode = { value: String -> URLDecoder.decode(value, "UTF-8") }
        val fromHeader = contentDisposition?.let {
            Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)?.let(decode)
                ?: Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)
        }
        val uri = try { URI(url) } catch (_: Exception) { null }
        val query = uri?.rawQuery.orEmpty().split('&').mapNotNull { pair ->
            val at = pair.indexOf('=')
            if (at <= 0) null else pair.substring(0, at) to decode(pair.substring(at + 1))
        }.toMap()
        val raw = fromHeader
            ?: query["name"]
            ?: query["path"]
            ?: uri?.path?.takeIf { it.isNotEmpty() && it != "/" }
            ?: "download.apk"
        return raw.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "download.apk" }
    }

    /** Whether Android lets this app install packages; if not, the person allows it in Settings. */
    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    fun settingsIntent(context: Context): Intent =
        Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))

    /** Blocking: call off the main thread. Sends the WebView's cookies; Studio's token is already in the URL. */
    fun download(context: Context, url: String, userAgent: String?, name: String): File {
        val dir = File(context.cacheDir, "apk").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val target = File(dir, name)
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 15_000
            connection.readTimeout = 60_000
            CookieManager.getInstance().getCookie(url)?.let { connection.setRequestProperty("Cookie", it) }
            userAgent?.let { connection.setRequestProperty("User-Agent", it) }
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("The server answered $code")
            var total = 0L
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > MAX_BYTES) throw IllegalStateException("The APK is larger than 512 MB")
                        output.write(buffer, 0, read)
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
        return target
    }

    /** Writes the APK into an install session; the result arrives as an [ACTION_STATUS] broadcast. */
    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("base.apk", 0, apk.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            val status = Intent(ACTION_STATUS).setPackage(context.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, status, flags).intentSender)
        }
    }
}
