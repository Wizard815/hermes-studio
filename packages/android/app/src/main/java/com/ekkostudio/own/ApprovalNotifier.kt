package com.ekkostudio.own

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Approval notifications: title, short detail, Approve / Reject (risky ones
 * open a confirmation in the app first), tap opens the chat. Blocked alerts
 * have no buttons. Android 13+ needs the notification permission; without
 * it nothing shows and Settings → Android app says so.
 */
class ApprovalNotifier(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    fun ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val system = context.getSystemService(NotificationManager::class.java)
        system.createNotificationChannel(NotificationChannel(CHANNEL_APPROVALS, context.getString(R.string.alerts_channel), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.alerts_channel_hint)
        })
        system.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, context.getString(R.string.alerts_service_channel), NotificationManager.IMPORTANCE_MIN).apply {
            description = context.getString(R.string.alerts_service_channel_hint)
            setShowBadge(false)
        })
    }

    fun enabled(): Boolean = manager.areNotificationsEnabled()

    private fun openIntent(url: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    @android.annotation.SuppressLint("MissingPermission")
    fun show(server: String, item: ApprovalAlerts.Item) {
        if (!enabled()) return
        val id = ApprovalAlerts.notificationId(item.id)
        val builder = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(item.title)
            .setContentText(item.detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(item.detail))
            .setCategory(if (item.answerable) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setWhen(if (item.at > 0) item.at else System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent(ApprovalAlerts.openUrl(server, item), id))
        for ((index, button) in ApprovalAlerts.buttons(item).withIndex()) {
            val label = if (button.decision == ApprovalAlerts.Decision.APPROVE) R.string.alerts_approve else R.string.alerts_reject
            val requestCode = id * 4 + index + 1
            val pending = if (button.confirmFirst) {
                // Risky: the app shows the whole command and asks again.
                val intent = Intent(context, MainActivity::class.java)
                    .setAction(MainActivity.ACTION_CONFIRM_APPROVAL)
                    .putExtra(EXTRA_ITEM_ID, item.id)
                    .putExtra(EXTRA_TITLE, item.title)
                    .putExtra(EXTRA_DETAIL, item.detail)
                    .putExtra(EXTRA_OPEN_URL, ApprovalAlerts.openUrl(server, item))
                    .putExtra(EXTRA_DECISION, button.decision.name)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            } else {
                val intent = Intent(context, ApprovalActionReceiver::class.java)
                    .setAction(ApprovalActionReceiver.ACTION_ANSWER)
                    .putExtra(EXTRA_ITEM_ID, item.id)
                    .putExtra(EXTRA_TITLE, item.title)
                    .putExtra(EXTRA_DECISION, button.decision.name)
                PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            builder.addAction(0, context.getString(label), pending)
        }
        manager.notify(id, builder.build())
    }

    /** After an answer: Studio's words in place of the buttons ("Already approved in Studio by robin."). */
    @android.annotation.SuppressLint("MissingPermission")
    fun showResult(itemId: String, title: String, message: String) {
        if (!enabled()) return
        val notification = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(true)
            .setTimeoutAfter(60_000)
            .build()
        manager.notify(ApprovalAlerts.notificationId(itemId), notification)
    }

    fun cancel(itemId: String) = manager.cancel(ApprovalAlerts.notificationId(itemId))

    fun cancelAll(ids: Collection<String>) = ids.forEach(::cancel)

    /** The quiet notification Android requires while the live stream runs. */
    fun ongoing(connected: Boolean): android.app.Notification {
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentTitle(context.getString(R.string.alerts_ongoing_title))
            .setContentText(context.getString(if (connected) R.string.alerts_ongoing_connected else R.string.alerts_ongoing_waiting))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .build()
    }

    @android.annotation.SuppressLint("MissingPermission")
    fun updateOngoing(connected: Boolean) {
        if (enabled()) manager.notify(ApprovalAlerts.ONGOING_ID, ongoing(connected))
    }

    companion object {
        const val CHANNEL_APPROVALS = "approvals"
        const val CHANNEL_SERVICE = "approval_alerts_service"
        const val EXTRA_ITEM_ID = "alert_item_id"
        const val EXTRA_TITLE = "alert_title"
        const val EXTRA_DETAIL = "alert_detail"
        const val EXTRA_OPEN_URL = "alert_open_url"
        const val EXTRA_DECISION = "alert_decision"
    }
}

/** Shows new items and takes away what Studio no longer waits for (answered anywhere). */
object ApprovalAlertSync {
    fun apply(context: Context, items: List<ApprovalAlerts.Item>) {
        val store = ApprovalAlertStore(context)
        val server = store.server ?: return
        val notifier = ApprovalNotifier(context)
        val plan = ApprovalAlerts.plan(store.shown, items)
        plan.cancel.forEach(notifier::cancel)
        plan.post.forEach { notifier.show(server, it) }
        store.shown = items.map { it.id }.toSet()
    }

    fun test(context: Context, item: ApprovalAlerts.Item) {
        val server = ApprovalAlertStore(context).server ?: return
        ApprovalNotifier(context).show(server, item)
    }
}
