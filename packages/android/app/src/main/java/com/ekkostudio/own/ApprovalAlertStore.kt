package com.ekkostudio.own

import android.content.Context
import android.content.SharedPreferences

/**
 * What the app keeps for approval alerts, in its private preferences: the
 * phone's key (only this app can read it; Studio can revoke it), its name,
 * the mode (live, saver, off) and which notifications are showing.
 */
class ApprovalAlertStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("studio_own", Context.MODE_PRIVATE)

    val server: String? get() = prefs.getString(KEY_SERVER_URL, null)?.takeIf { it.isNotBlank() }
    val key: String? get() = prefs.getString(KEY_KEY, null)?.takeIf { it.startsWith(ApprovalAlerts.KEY_PREFIX) }
    val deviceName: String get() = prefs.getString(KEY_NAME, null).orEmpty()
    val paired: Boolean get() = key != null && server != null

    var mode: String
        get() = prefs.getString(KEY_MODE, "off")?.takeIf { it in ApprovalAlerts.MODES } ?: "off"
        set(value) { prefs.edit().putString(KEY_MODE, if (value in ApprovalAlerts.MODES) value else "off").apply() }

    var shown: Set<String>
        get() = prefs.getStringSet(KEY_SHOWN, emptySet()).orEmpty().toSet()
        set(value) { prefs.edit().putStringSet(KEY_SHOWN, value.toSet()).apply() }

    fun savePairing(paired: ApprovalAlerts.Paired) {
        prefs.edit()
            .putString(KEY_KEY, paired.key)
            .putString(KEY_DEVICE_ID, paired.deviceId)
            .putString(KEY_NAME, paired.deviceName)
            .apply()
    }

    fun clearPairing() {
        prefs.edit().remove(KEY_KEY).remove(KEY_DEVICE_ID).remove(KEY_NAME).remove(KEY_SHOWN).putString(KEY_MODE, "off").apply()
    }

    fun client(): ApprovalAlertClient? {
        val server = server ?: return null
        val key = key ?: return null
        return ApprovalAlertClient(server, key)
    }

    companion object {
        /** The same preference MainActivity keeps the server address in. */
        const val KEY_SERVER_URL = "server_url"
        private const val KEY_KEY = "alerts_key"
        private const val KEY_DEVICE_ID = "alerts_device_id"
        private const val KEY_NAME = "alerts_device_name"
        private const val KEY_MODE = "alerts_mode"
        private const val KEY_SHOWN = "alerts_shown"
    }
}
