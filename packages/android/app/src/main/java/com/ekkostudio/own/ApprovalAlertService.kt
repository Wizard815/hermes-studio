package com.ekkostudio.own

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Live approval alerts (docs/approval-alerts.md, "Battery"). While the mode
 * is Live, this foreground service holds one server-sent-events connection
 * to Studio and shows a quiet ongoing notification, as Android requires.
 * Studio sends the whole list on connect and on every change, plus a comment
 * every 45 seconds; the radio otherwise sleeps. If the connection drops, it
 * waits 2 s, 4 s, … up to 5 minutes before trying again. No Google services.
 */
class ApprovalAlertService : Service() {
    @Volatile private var running = false
    @Volatile private var connection: HttpURLConnection? = null
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notifier = ApprovalNotifier(this)
        notifier.ensureChannels()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, ApprovalAlerts.ONGOING_ID, notifier.ongoing(false), type)
        val store = ApprovalAlertStore(this)
        if (!store.paired || store.mode != "live") { stopSelf(); return START_NOT_STICKY }
        if (worker?.isAlive != true) {
            running = true
            worker = thread(name = "approval-alerts") { loop() }
        }
        return START_STICKY
    }

    private fun loop() {
        var attempt = 0
        while (running) {
            val store = ApprovalAlertStore(this)
            val client = store.client() ?: break
            val notifier = ApprovalNotifier(this)
            var opened = false
            val status = client.stream(
                onEvent = { event -> handle(event) },
                stopped = { !running },
                onOpen = { open -> connection = open; opened = true; attempt = 0; notifier.updateOngoing(true) },
            )
            connection = null
            if (!running) break
            notifier.updateOngoing(false)
            if (status == 401) {
                // The phone was removed in Studio.
                ApprovalAlertControl.unpaired(this)
                break
            }
            if (status == 403) {
                // Android app is not this person's choice in Studio any more: check now and then.
                sleep(15 * 60_000L)
                continue
            }
            sleep(ApprovalAlerts.backoffMs(if (opened) 0 else attempt++))
        }
        stopSelf()
    }

    private fun handle(event: ApprovalAlerts.Event) {
        when (event.name) {
            "approvals" -> ApprovalAlerts.parseItems(event.data)?.let { ApprovalAlertSync.apply(this, it) }
            "test" -> try { ApprovalAlerts.parseItem(org.json.JSONObject(event.data))?.let { ApprovalAlertSync.test(this, it) } } catch (_: Exception) { }
            "revoked" -> { running = false; ApprovalAlertControl.unpaired(this) }
        }
    }

    private fun sleep(ms: Long) {
        val until = System.currentTimeMillis() + ms
        while (running && System.currentTimeMillis() < until) {
            try { Thread.sleep(minOf(1_000L, until - System.currentTimeMillis()).coerceAtLeast(1)) } catch (_: InterruptedException) { return }
        }
    }

    override fun onDestroy() {
        running = false
        connection?.disconnect()
        worker?.interrupt()
        super.onDestroy()
    }
}

/** Battery saver: one check every 15 minutes (Android's shortest period), only with a network. */
class ApprovalPollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val store = ApprovalAlertStore(applicationContext)
        if (store.mode != "saver") return Result.success()
        val client = store.client() ?: return Result.success()
        val response = client.pending()
        return when {
            response.status == 401 -> { ApprovalAlertControl.unpaired(applicationContext); Result.success() }
            response.status in 200..299 -> {
                ApprovalAlerts.parseItems(response.body)?.let { ApprovalAlertSync.apply(applicationContext, it) }
                Result.success()
            }
            else -> Result.retry()
        }
    }
}

/** Turns the modes on and off. Live and Battery saver never run at the same time. */
object ApprovalAlertControl {
    private const val WORK_NAME = "approval-alerts-poll"

    fun setMode(context: Context, mode: String) {
        val store = ApprovalAlertStore(context)
        store.mode = mode
        apply(context)
    }

    /** After a reboot, an app update or a mode change. */
    fun apply(context: Context) {
        val store = ApprovalAlertStore(context)
        val work = WorkManager.getInstance(context)
        val service = Intent(context, ApprovalAlertService::class.java)
        if (!store.paired || store.mode == "off") {
            context.stopService(service)
            work.cancelUniqueWork(WORK_NAME)
            return
        }
        ApprovalNotifier(context).ensureChannels()
        if (store.mode == "live") {
            work.cancelUniqueWork(WORK_NAME)
            ContextCompat.startForegroundService(context, service)
        } else {
            context.stopService(service)
            val request = PeriodicWorkRequestBuilder<ApprovalPollWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            work.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }

    /** Studio removed this phone: forget the key, stop, clear the notifications. */
    fun unpaired(context: Context) {
        val store = ApprovalAlertStore(context)
        ApprovalNotifier(context).cancelAll(store.shown)
        store.clearPairing()
        apply(context)
    }
}

/** Live alerts come back after a reboot or an app update. */
class ApprovalBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            ApprovalAlertControl.apply(context)
        }
    }
}

/** Approve / Reject on a notification: answered in the background, the notification then shows Studio's reply. */
class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ANSWER) return
        val itemId = intent.getStringExtra(ApprovalNotifier.EXTRA_ITEM_ID) ?: return
        val title = intent.getStringExtra(ApprovalNotifier.EXTRA_TITLE).orEmpty()
        val decision = runCatching { ApprovalAlerts.Decision.valueOf(intent.getStringExtra(ApprovalNotifier.EXTRA_DECISION).orEmpty()) }.getOrNull() ?: return
        val pending = goAsync()
        thread(name = "approval-answer") {
            try { answer(context.applicationContext, itemId, title, decision) } finally { pending.finish() }
        }
    }

    companion object {
        const val ACTION_ANSWER = "com.ekkostudio.own.ANSWER_APPROVAL"

        /** Used by the notification buttons and by the in-app confirmation. */
        fun answer(context: Context, itemId: String, title: String, decision: ApprovalAlerts.Decision): String {
            val notifier = ApprovalNotifier(context)
            val store = ApprovalAlertStore(context)
            // The list Studio sends next no longer has it: keep the reply on screen instead of taking it away.
            store.shown = store.shown - itemId
            val client = store.client()
            val message = if (client == null) context.getString(R.string.alerts_not_paired)
            else client.answer(itemId, decision).let { ApprovalAlerts.answerMessage(it.status, it.body) }
            notifier.showResult(itemId, title, message)
            return message
        }
    }
}
