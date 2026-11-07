package com.ekkostudio.own

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Shell around the Studio web app. The first run asks for the server URL (for
 * example the Cloudflare tunnel address); after that the WebView loads it and the
 * normal Studio login applies.
 *
 * Pages from that server (and only that server) also get `window.StudioOwn`,
 * which runs commands in Termux after the person confirms them here, and an
 * .apk downloaded from the server is installed through Android's installer.
 */
class MainActivity : AppCompatActivity() {
    private var webView: WebView? = null
    private var serverOrigin: String? = null
    private var scriptHandler: ScriptHandler? = null
    private var scriptTermuxInstalled: Boolean? = null
    private var pendingTermux: Pair<Termux.Command, JavaScriptReplyProxy>? = null
    private val replies = mutableMapOf<Int, JavaScriptReplyProxy>()
    private val requestIds = AtomicInteger(1)

    private val prefs get() = getSharedPreferences("studio_own", Context.MODE_PRIVATE)

    private val termuxResults = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getIntExtra(EXTRA_REQUEST_ID, 0)
            val reply = replies.remove(id) ?: return
            reply.postMessage(StudioBridge.resultMessage(Termux.result(intent.getBundleExtra(Termux.RESULT_BUNDLE))))
        }
    }

    private val installStatus = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                    confirm?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                }
                PackageInstaller.STATUS_SUCCESS -> toast(getString(R.string.apk_installed))
                else -> toast(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: getString(R.string.apk_install_failed))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ContextCompat.registerReceiver(this, termuxResults, IntentFilter(ACTION_TERMUX_RESULT), ContextCompat.RECEIVER_NOT_EXPORTED)
        ContextCompat.registerReceiver(this, installStatus, IntentFilter(ApkInstaller.ACTION_STATUS), ContextCompat.RECEIVER_NOT_EXPORTED)
        val saved = prefs.getString(KEY_SERVER_URL, null)
        if (saved.isNullOrBlank()) showSetup() else showWebView(saved)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.canGoBack()) view.goBack() else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        // Termux may have been installed or removed while Studio was in the background.
        webView?.let { installBridgeScript(it) }
    }

    private fun showSetup() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 3, pad, pad)
        }
        val title = TextView(this).apply {
            text = "Connect to your Studio server"
            textSize = 20f
        }
        val input = EditText(this).apply {
            hint = "https://studio.example.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            tag = "server_url"
            setSingleLine()
        }
        val button = Button(this).apply {
            text = "Connect"
            tag = "connect"
            setOnClickListener {
                val url = normalizeUrl(input.text.toString())
                if (url == null) {
                    input.error = "Enter a full http(s) address"
                } else {
                    prefs.edit().putString(KEY_SERVER_URL, url).apply()
                    showWebView(url)
                }
            }
        }
        layout.addView(title)
        layout.addView(input, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        layout.addView(button)
        setContentView(layout)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(url: String) {
        val view = WebView(this).apply {
            tag = "studio_webview"
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        serverOrigin = StudioBridge.originRule(url)
        installBridge(view)
        view.setDownloadListener { downloadUrl, userAgent, contentDisposition, mimeType, _ ->
            onDownload(downloadUrl, userAgent, contentDisposition, mimeType)
        }
        webView = view
        setContentView(view)
        view.loadUrl(url)
    }

    // --- Studio page bridge ---------------------------------------------------

    private fun installBridge(view: WebView) {
        val origin = serverOrigin ?: return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(view, StudioBridge.PORT_NAME, setOf(origin)) { _, message, _, _, reply ->
            when (val request = StudioBridge.parse(message.data)) {
                is StudioBridge.Request.RunInTermux -> requestTermux(request.command, reply)
                null -> Unit
            }
        }
        installBridgeScript(view)
    }

    /** (Re)defines `window.StudioOwn` when the Termux state changed, reloading an open page. */
    private fun installBridgeScript(view: WebView) {
        val origin = serverOrigin ?: return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val installed = Termux.isInstalled(this)
        if (scriptTermuxInstalled == installed) return
        val first = scriptTermuxInstalled == null
        scriptHandler?.remove()
        scriptHandler = WebViewCompat.addDocumentStartJavaScript(view, StudioBridge.documentStartScript(installed), setOf(origin))
        scriptTermuxInstalled = installed
        if (!first) view.reload()
    }

    private fun requestTermux(command: Termux.Command, reply: JavaScriptReplyProxy) {
        if (!Termux.isInstalled(this)) {
            reply.postMessage(StudioBridge.resultMessage(mapOf("error" to getString(R.string.termux_missing))))
            return
        }
        if (ContextCompat.checkSelfPermission(this, Termux.PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            pendingTermux = command to reply
            requestPermissions(arrayOf(Termux.PERMISSION), REQUEST_TERMUX_PERMISSION)
            return
        }
        confirmTermux(command, reply)
    }

    @Deprecated("Deprecated in Java")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_TERMUX_PERMISSION) return
        val (command, reply) = pendingTermux ?: return
        pendingTermux = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) confirmTermux(command, reply)
        else reply.postMessage(StudioBridge.resultMessage(mapOf("error" to getString(R.string.termux_permission_denied))))
    }

    /** Nothing reaches Termux until the person reads the command and taps Run. */
    private fun confirmTermux(command: Termux.Command, reply: JavaScriptReplyProxy) {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val body = TextView(this).apply {
            text = getString(R.string.termux_confirm_body, command.workdir, command.script)
            setTextIsSelectable(true)
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(pad, pad / 2, pad, 0)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.termux_confirm_title)
            .setView(body)
            .setPositiveButton(R.string.run) { _, _ -> runTermux(command, reply) }
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                reply.postMessage(StudioBridge.resultMessage(mapOf("error" to getString(R.string.termux_cancelled))))
            }
            .setCancelable(false)
            .show()
    }

    private fun runTermux(command: Termux.Command, reply: JavaScriptReplyProxy) {
        val id = requestIds.getAndIncrement()
        val result = Intent(ACTION_TERMUX_RESULT).setPackage(packageName).putExtra(EXTRA_REQUEST_ID, id)
        // Termux fills in the result extras, so the PendingIntent must be mutable.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        replies[id] = reply
        try {
            Termux.start(this, command, PendingIntent.getBroadcast(this, id, result, flags))
        } catch (error: Exception) {
            replies.remove(id)
            reply.postMessage(StudioBridge.resultMessage(mapOf("error" to (error.message ?: getString(R.string.termux_failed)))))
        }
    }

    // --- APK downloads --------------------------------------------------------

    private fun onDownload(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        val fromServer = serverOrigin != null && StudioBridge.originRule(url) == serverOrigin
        if (!fromServer || !ApkInstaller.isApk(url, contentDisposition, mimeType)) {
            // Anything else goes to the browser, which has its own download manager.
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { toast(getString(R.string.download_unsupported)) }
            return
        }
        if (!ApkInstaller.canInstall(this)) {
            toast(getString(R.string.apk_allow_installs))
            startActivity(ApkInstaller.settingsIntent(this))
            return
        }
        val name = ApkInstaller.fileName(url, contentDisposition)
        AlertDialog.Builder(this)
            .setTitle(R.string.apk_confirm_title)
            .setMessage(getString(R.string.apk_confirm_body, name))
            .setPositiveButton(R.string.install) { _, _ -> downloadAndInstall(url, userAgent, name) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun downloadAndInstall(url: String, userAgent: String?, name: String) {
        toast(getString(R.string.apk_downloading, name))
        thread(name = "apk-download") {
            try {
                val apk = ApkInstaller.download(applicationContext, url, userAgent, name)
                ApkInstaller.install(applicationContext, apk)
            } catch (error: Exception) {
                runOnUiThread { toast(error.message ?: getString(R.string.apk_install_failed)) }
            }
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    override fun onDestroy() {
        unregisterReceiver(termuxResults)
        unregisterReceiver(installStatus)
        scriptHandler?.remove()
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val ACTION_TERMUX_RESULT = "com.ekkostudio.own.TERMUX_RESULT"
        private const val EXTRA_REQUEST_ID = "request_id"
        private const val REQUEST_TERMUX_PERMISSION = 41

        /** Accepts only absolute http(s) URLs; returns null for anything else. */
        fun normalizeUrl(raw: String): String? {
            val trimmed = raw.trim().trimEnd('/')
            if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) return null
            val host = trimmed.substringAfter("://").substringBefore('/')
            return if (host.isBlank()) null else trimmed
        }
    }
}
