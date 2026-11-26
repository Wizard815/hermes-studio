package com.ekkostudio.own

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.provider.OpenableColumns
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
import android.widget.ScrollView
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
import java.io.InputStream
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** Receives a Termux result: stdout, stderr, exitCode and error, as [Termux.result] builds them. */
typealias TermuxCallback = (Map<String, Any?>) -> Unit

/**
 * Shell around the Studio web app. The first run asks for the server URL (for
 * example the Cloudflare tunnel address); after that the WebView loads it and the
 * normal Studio login applies.
 *
 * Pages from that server (and only that server) also get `window.StudioOwn`,
 * which runs commands in Termux after the person confirms them here, and an
 * .apk downloaded from the server is installed through Android's installer.
 *
 * Text shared to the app (or `ekkostudio-own://chat?text=...`) opens a new
 * Studio chat with the text in the composer, never sent. The Omi panel opens
 * the Omi app and starts or stops the phone's AI servers in Termux (docs/omi.md).
 */
class MainActivity : AppCompatActivity() {
    private var webView: WebView? = null
    private var serverOrigin: String? = null
    private var scriptHandler: ScriptHandler? = null
    private var scriptTermuxInstalled: Boolean? = null
    private var pendingTermux: Pair<Termux.Command, TermuxCallback>? = null
    private val replies = mutableMapOf<Int, TermuxCallback>()
    private val requestIds = AtomicInteger(1)
    /** Shared before a server was set up: offered once it is. */
    private var pendingShared: ShareIntent.Shared? = null
    /** A share waiting for a Studio page to finish loading. */
    private var pendingShareScript: String? = null
    private var pageReady = false
    /** The Studio page's port, to tell Settings → Android app about approval alerts. */
    private var alertsReply: JavaScriptReplyProxy? = null
    /** Shared text that arrived before a server was configured. */
    private var pendingCompose: String? = null
    private var phoneAiStatus: TextView? = null

    private val prefs get() = getSharedPreferences("studio_own", Context.MODE_PRIVATE)

    private val termuxResults = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getIntExtra(EXTRA_REQUEST_ID, 0)
            replies.remove(id)?.invoke(Termux.result(intent.getBundleExtra(Termux.RESULT_BUNDLE)))
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
        // A link to the server opens that page instead of the start page.
        val link = (LinkRoute.resolve(intent?.dataString, saved) as? LinkRoute.Target.InApp)?.url
        if (saved.isNullOrBlank()) showSetup() else showWebView(link ?: saved)
        // A recreated activity must not replay the share or link it started with.
        if (link == null && savedInstanceState == null) handleIntent(intent)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.canGoBack()) view.goBack() else finish()
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    // --- Share to Studio, and links ---------------------------------------------

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val server = prefs.getString(KEY_SERVER_URL, null)
        if (intent.action == ACTION_CONFIRM_APPROVAL) {
            intent.action = null
            confirmApproval(intent)
            return
        }
        if (intent.action == Intent.ACTION_VIEW) {
            // ekkostudio-own://chat?text=… and ekkostudio-own://omi (docs/omi.md); not again from Recents.
            val own = intent.dataString?.let { Incoming.link(it) }
            if (own != null || intent.dataString?.startsWith(Incoming.SCHEME + ":", ignoreCase = true) == true) {
                intent.action = null
                if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
                when (own) {
                    is Incoming.Request.Compose -> openCompose(own)
                    Incoming.Request.OmiPanel -> showOmiPanel()
                    null -> Unit
                }
                return
            }
            when (val target = LinkRoute.resolve(intent.dataString, server)) {
                is LinkRoute.Target.InApp -> webView?.loadUrl(target.url) ?: showWebView(target.url)
                is LinkRoute.Target.Browser -> openInBrowser(target.url)
                is LinkRoute.Target.Pair -> { intent.action = null; confirmPairLink(target.link) }
                LinkRoute.Target.Ignore -> if (server.isNullOrBlank()) toast(getString(R.string.share_connect_first))
            }
            return
        }
        @Suppress("DEPRECATION")
        val streams = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(
                if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM),
            )
            Intent.ACTION_SEND_MULTIPLE -> (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)).orEmpty()
            else -> return
        }.map { it.toString() }
        val shared = ShareIntent.parse(intent.action, intent.type, intent.getCharSequenceExtra(Intent.EXTRA_TEXT), intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT), streams)
        // Handled once: rotating or reopening the app does not share it again.
        intent.action = null
        if (shared == null) { toast(getString(R.string.share_nothing)); return }
        if (server.isNullOrBlank()) { pendingShared = shared; toast(getString(R.string.share_connect_first)); return }
        askWhereToShare(shared)
    }

    private fun askWhereToShare(shared: ShareIntent.Shared) {
        AlertDialog.Builder(this)
            .setTitle(R.string.share_title)
            .setMessage(shared.text.take(300).ifBlank { resources.getQuantityString(R.plurals.share_images, shared.imageUris.size, shared.imageUris.size) })
            .setPositiveButton(R.string.share_new_chat) { _, _ -> readAndShare(shared, ShareIntent.Mode.NEW_CHAT) }
            .setNeutralButton(R.string.share_current_chat) { _, _ -> readAndShare(shared, ShareIntent.Mode.CURRENT_CHAT) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Reads the shared images (off the main thread), then hands everything to the Studio page. */
    private fun readAndShare(shared: ShareIntent.Shared, mode: ShareIntent.Mode) {
        thread(name = "share-read") {
            val images = shared.imageUris.mapNotNull { readImage(Uri.parse(it)) }
            val skipped = shared.imageUris.size - images.size
            runOnUiThread {
                if (skipped > 0) toast(getString(R.string.share_images_skipped, skipped))
                pendingShareScript = ShareIntent.pageScript(mode, shared.text, images)
                flushShare()
            }
        }
    }

    private fun readImage(uri: Uri): ShareIntent.Image? = try {
        val type = contentResolver.getType(uri)
        if (!ShareIntent.isImageType(type)) null
        else {
            val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
            contentResolver.openInputStream(uri)?.use { input ->
                val bytes = input.readNBytesCompat(ShareIntent.MAX_IMAGE_BYTES + 1)
                if (bytes.size > ShareIntent.MAX_IMAGE_BYTES) null else ShareIntent.Image(ShareIntent.safeName(name, type!!), type, bytes)
            }
        }
    } catch (_: Exception) { null }

    /** Runs the share in the page once a page from the server has loaded (never in another site's page). */
    private fun flushShare() {
        val script = pendingShareScript ?: return
        val view = webView ?: return
        if (!pageReady || serverOrigin == null || StudioBridge.originRule(view.url ?: "") != serverOrigin) return
        pendingShareScript = null
        view.evaluateJavascript(script, null)
    }

    private fun openInBrowser(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) { toast(getString(R.string.download_unsupported)) }

    }

    /** Loads Studio's new-chat page with the text in the composer; the person presses Send. */
    private fun openCompose(request: Incoming.Request.Compose) {
        if (request.truncated) toast(getString(R.string.share_truncated))
        val server = prefs.getString(KEY_SERVER_URL, null)
        val url = server?.let { Incoming.composeUrl(it, request.text) }
        if (server == null || url == null) {
            // Still on the setup screen: open the chat once the server is connected.
            pendingCompose = request.text
            return
        }
        val view = webView
        if (view == null) showWebView(server, url) else view.loadUrl(url)
    }

    override fun onResume() {
        super.onResume()
        // Termux may have been installed or removed while Studio was in the background.
        webView?.let { installBridgeScript(it) }
        // Notification or battery settings may have changed in Android's settings.
        sendAlertsState()
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
                    val compose = pendingCompose?.let { Incoming.composeUrl(url, it) }
                    pendingCompose = null
                    showWebView(url, compose ?: url)
                    pendingShared?.let { pendingShared = null; askWhereToShare(it) }
                }
            }
        }
        layout.addView(title)
        layout.addView(input, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        layout.addView(button)
        setContentView(layout)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(url: String, startUrl: String = url) {
        val view = WebView(this).apply {
            tag = "studio_webview"
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    pageReady = false
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    pageReady = true
                    flushShare()
                }
            }
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
        view.loadUrl(startUrl)
    }

    // --- Studio page bridge ---------------------------------------------------

    private fun installBridge(view: WebView) {
        val origin = serverOrigin ?: return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(view, StudioBridge.PORT_NAME, setOf(origin)) { _, message, _, _, reply ->
            when (val request = StudioBridge.parse(message.data)) {
                is StudioBridge.Request.RunInTermux -> requestTermux(request.command) { reply.postMessage(StudioBridge.resultMessage(it)) }
                StudioBridge.Request.AlertsStatus -> { alertsReply = reply; sendAlertsState() }
                is StudioBridge.Request.AlertsPair -> { alertsReply = reply; pairAlerts(prefs.getString(KEY_SERVER_URL, null), request.code, request.name) }
                is StudioBridge.Request.AlertsMode -> { alertsReply = reply; setAlertsMode(request.mode) }
                StudioBridge.Request.AlertsUnpair -> { alertsReply = reply; ApprovalAlertControl.unpaired(this); sendAlertsState() }
                StudioBridge.Request.AlertsBattery -> openBatterySettings()
                StudioBridge.Request.OmiPanel -> showOmiPanel()
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

    private fun requestTermux(command: Termux.Command, reply: TermuxCallback) {
        if (!Termux.isInstalled(this)) {
            reply(mapOf("error" to getString(R.string.termux_missing)))
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
        if (requestCode == REQUEST_NOTIFICATION_PERMISSION) { sendAlertsState(); return }
        if (requestCode != REQUEST_TERMUX_PERMISSION) return
        val (command, reply) = pendingTermux ?: return
        pendingTermux = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) confirmTermux(command, reply)
        else reply(mapOf("error" to getString(R.string.termux_permission_denied)))
    }

    /** Nothing reaches Termux until the person reads the command and taps Run. */
    private fun confirmTermux(command: Termux.Command, reply: TermuxCallback) {
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
                reply(mapOf("error" to getString(R.string.termux_cancelled)))
            }
            .setCancelable(false)
            .show()
    }

    private fun runTermux(command: Termux.Command, reply: TermuxCallback) {
        val id = requestIds.getAndIncrement()
        val result = Intent(ACTION_TERMUX_RESULT).setPackage(packageName).putExtra(EXTRA_REQUEST_ID, id)
        // Termux fills in the result extras, so the PendingIntent must be mutable.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        replies[id] = reply
        try {
            Termux.start(this, command, PendingIntent.getBroadcast(this, id, result, flags))
        } catch (error: Exception) {
            replies.remove(id)
            reply(mapOf("error" to (error.message ?: getString(R.string.termux_failed))))
        }
    }

    // --- Approval alerts (docs/approval-alerts.md) ----------------------------

    private fun sendAlertsState(message: String? = null) {
        val reply = alertsReply ?: return
        val store = ApprovalAlertStore(this)
        val power = getSystemService(PowerManager::class.java)
        val unrestricted = power?.isIgnoringBatteryOptimizations(packageName) ?: false
        reply.postMessage(ApprovalAlerts.stateMessage(store.paired, store.deviceName, store.mode, ApprovalNotifier(this).enabled(), unrestricted, message))
    }

    /** A QR code or link from Studio's Settings → Android app. */
    private fun confirmPairLink(link: ApprovalAlerts.PairLink) {
        val saved = prefs.getString(KEY_SERVER_URL, null)
        // Pair with the server the app already uses; a link only sets it up when there is none yet.
        val server = saved ?: link.server
        if (server == null) { toast(getString(R.string.share_connect_first)); return }
        AlertDialog.Builder(this)
            .setTitle(R.string.alerts_pair_title)
            .setMessage(getString(R.string.alerts_pair_body, server))
            .setPositiveButton(R.string.alerts_pair) { _, _ ->
                if (saved == null) {
                    prefs.edit().putString(KEY_SERVER_URL, server).apply()
                    showWebView(server)
                }
                pairAlerts(server, link.code, "")
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun pairAlerts(server: String?, code: String, name: String) {
        if (server.isNullOrBlank()) { sendAlertsState(getString(R.string.share_connect_first)); return }
        val deviceName = name.ifBlank { listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ").take(60) }
        thread(name = "approval-pair") {
            val response = ApprovalAlertClient(server).pair(code, deviceName)
            val paired = if (response.status == 201) ApprovalAlerts.parsePaired(response.body) else null
            runOnUiThread {
                if (paired == null) {
                    val why = ApprovalAlerts.answerMessage(response.status, response.body)
                    toast(getString(R.string.alerts_pair_failed, why))
                    sendAlertsState(getString(R.string.alerts_pair_failed, why))
                    return@runOnUiThread
                }
                ApprovalAlertStore(this).savePairing(paired)
                setAlertsMode("live", getString(R.string.alerts_paired))
                toast(getString(R.string.alerts_paired))
            }
        }
    }

    private fun setAlertsMode(mode: String, message: String? = null) {
        if (mode != "off") askForNotifications()
        ApprovalAlertControl.setMode(this, mode)
        sendAlertsState(message)
    }

    /** Android 13+ asks once; without it the alerts stay silent and the Studio page says so. */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATION_PERMISSION)
        }
    }

    private fun openBatterySettings() {
        try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) { toast(getString(R.string.download_unsupported)) }
    }

    /** A risky approval: show all of it and ask again before answering. */
    private fun confirmApproval(intent: Intent) {
        val itemId = intent.getStringExtra(ApprovalNotifier.EXTRA_ITEM_ID) ?: return
        val title = intent.getStringExtra(ApprovalNotifier.EXTRA_TITLE).orEmpty()
        val detail = intent.getStringExtra(ApprovalNotifier.EXTRA_DETAIL).orEmpty()
        val openUrl = intent.getStringExtra(ApprovalNotifier.EXTRA_OPEN_URL)
        val asked = runCatching { ApprovalAlerts.Decision.valueOf(intent.getStringExtra(ApprovalNotifier.EXTRA_DECISION).orEmpty()) }.getOrNull()
            ?: ApprovalAlerts.Decision.APPROVE
        val other = if (asked == ApprovalAlerts.Decision.APPROVE) ApprovalAlerts.Decision.REJECT else ApprovalAlerts.Decision.APPROVE
        val answer = { decision: ApprovalAlerts.Decision ->
            thread(name = "approval-answer") {
                val message = ApprovalActionReceiver.answer(applicationContext, itemId, title, decision)
                runOnUiThread { toast(message) }
            }
        }
        val label = { decision: ApprovalAlerts.Decision -> if (decision == ApprovalAlerts.Decision.APPROVE) R.string.alerts_approve else R.string.alerts_reject }
        val pad = (16 * resources.displayMetrics.density).toInt()
        val body = TextView(this).apply {
            text = getString(R.string.alerts_confirm_body, detail)
            setTextIsSelectable(true)
            setPadding(pad, pad / 2, pad, 0)
        }
        AlertDialog.Builder(this)
            .setTitle(title.ifBlank { getString(R.string.alerts_confirm_title) })
            .setView(body)
            .setPositiveButton(label(asked)) { _, _ -> answer(asked) }
            .setNegativeButton(label(other)) { _, _ -> answer(other) }
            .setNeutralButton(R.string.alerts_open_chat) { _, _ ->
                val server = prefs.getString(KEY_SERVER_URL, null)
                val target = (LinkRoute.resolve(openUrl, server) as? LinkRoute.Target.InApp)?.url
                if (target != null) webView?.loadUrl(target) ?: showWebView(target)
            }
            .show()
    }

    // --- Omi and phone AI -----------------------------------------------------

    /** Native panel: open Omi, start/stop the phone's AI servers (confirmed like any Termux command), their status. */
    private fun showOmiPanel() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val status = TextView(this).apply {
            text = getString(R.string.phone_ai_checking)
            setPadding(0, 0, 0, pad / 2)
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(status)
        }
        fun button(label: Int, action: () -> Unit) = layout.addView(Button(this).apply {
            setText(label)
            isAllCaps = false
            setOnClickListener { action() }
        }, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        button(R.string.omi_open_approvals) { openOmi(OmiLink.Target.APPROVALS) }
        button(R.string.omi_open_tasks) { openOmi(OmiLink.Target.TASKS) }
        button(R.string.omi_open_capture) { openOmi(OmiLink.Target.CAPTURE) }
        button(R.string.phone_ai_start) { runPhoneAi(PhoneAi.START) }
        button(R.string.phone_ai_stop) { runPhoneAi(PhoneAi.STOP) }
        button(R.string.phone_ai_refresh) { refreshPhoneAiStatus() }
        phoneAiStatus = status
        AlertDialog.Builder(this)
            .setTitle(R.string.omi_panel_title)
            .setView(ScrollView(this).apply { addView(layout) })
            .setPositiveButton(android.R.string.ok, null)
            .setOnDismissListener { if (phoneAiStatus === status) phoneAiStatus = null }
            .show()
        refreshPhoneAiStatus()
    }

    private fun openOmi(target: OmiLink.Target) {
        val attempts = OmiLink.attempts(
            target,
            installed = { packageManager.getLaunchIntentForPackage(it) != null },
            handlesLink = { pkg, uri -> packageManager.resolveActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(pkg), 0) != null },
        )
        for (attempt in attempts) {
            val intent = when (attempt) {
                is OmiLink.Launch.DeepLink -> Intent(Intent.ACTION_VIEW, Uri.parse(attempt.uri)).setPackage(attempt.packageName)
                is OmiLink.Launch.App -> packageManager.getLaunchIntentForPackage(attempt.packageName) ?: continue
            }
            try {
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (_: ActivityNotFoundException) {
            } catch (_: SecurityException) {
            }
        }
        toast(getString(R.string.omi_missing))
    }

    private fun runPhoneAi(command: Termux.Command) {
        if (!Termux.isInstalled(this)) {
            showTermuxHelp()
            return
        }
        requestTermux(command) { result ->
            when (val outcome = PhoneAi.outcome(result)) {
                PhoneAi.Outcome.Done -> Unit
                PhoneAi.Outcome.TermuxNotSetUp -> showTermuxHelp()
                PhoneAi.Outcome.ScriptMissing -> toast(getString(R.string.phone_ai_script_missing))
                is PhoneAi.Outcome.Failed -> toast(outcome.message)
            }
            refreshPhoneAiStatus()
            // The servers take a few seconds to listen, longer to load a model.
            phoneAiStatus?.postDelayed({ refreshPhoneAiStatus() }, 4_000)
        }
    }

    private fun refreshPhoneAiStatus() {
        val view = phoneAiStatus ?: return
        thread(name = "phone-ai-status") {
            val status = PhoneAi.status(PhoneAi.probe(PhoneAi.CHAT_URL), PhoneAi.probe(PhoneAi.SPEECH_URL))
            runOnUiThread {
                if (phoneAiStatus === view) view.text = getString(R.string.phone_ai_status, stateLabel(status.chat), stateLabel(status.speech))
            }
        }
    }

    private fun stateLabel(state: PhoneAi.State): String = getString(when (state) {
        PhoneAi.State.OFF -> R.string.phone_ai_off
        PhoneAi.State.LOADING -> R.string.phone_ai_loading
        PhoneAi.State.RUNNING -> R.string.phone_ai_running
    })

    private fun showTermuxHelp() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val body = TextView(this).apply {
            text = getString(R.string.termux_setup_body)
            setTextIsSelectable(true)
            setPadding(pad, pad / 2, pad, 0)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.termux_setup_title)
            .setView(ScrollView(this).apply { addView(body) })
            .setPositiveButton(android.R.string.ok, null)
            .show()
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
        private const val REQUEST_NOTIFICATION_PERMISSION = 42
        /** A risky approval's button: confirm in the app first (ApprovalNotifier). */
        const val ACTION_CONFIRM_APPROVAL = "com.ekkostudio.own.CONFIRM_APPROVAL"

        /** Up to [limit] bytes (InputStream.readNBytes needs Android 13). */
        fun InputStream.readNBytesCompat(limit: Int): ByteArray {
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            while (out.size() < limit) {
                val read = read(buffer, 0, minOf(buffer.size, limit - out.size()))
                if (read < 0) break
                out.write(buffer, 0, read)
            }
            return out.toByteArray()
        }

        /** Accepts only absolute http(s) URLs; returns null for anything else. */
        fun normalizeUrl(raw: String): String? {
            val trimmed = raw.trim().trimEnd('/')
            if (!(trimmed.startsWith("http://") || trimmed.startsWith("https://"))) return null
            val host = trimmed.substringAfter("://").substringBefore('/')
            return if (host.isBlank()) null else trimmed
        }
    }
}
