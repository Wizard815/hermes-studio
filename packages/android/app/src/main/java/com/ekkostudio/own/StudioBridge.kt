package com.ekkostudio.own

import org.json.JSONObject
import java.net.URI

/**
 * What the Studio page can ask of this app. The bridge is offered only to
 * frames whose origin is the configured Studio server (WebViewCompat origin
 * rules), and every Termux command is confirmed on the phone first.
 */
object StudioBridge {
    const val PORT_NAME = "StudioOwnPort"

    /** `scheme://host[:port]` of the server URL, the form WebView origin rules take. */
    fun originRule(serverUrl: String): String? {
        val uri = try { URI(serverUrl) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host ?: return null
        if (scheme != "http" && scheme != "https") return null
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return "$scheme://${host.lowercase()}$port"
    }

    /**
     * Injected at document start into Studio frames only. Defines the API the
     * Studio client looks for (`window.StudioOwn`) on top of the message port,
     * including `openOmiPanel()` for the native Omi and phone AI panel,
     * and turns replies into a `studio-own:termux-result` event.
     */
    fun documentStartScript(termuxInstalled: Boolean): String = """
        (function () {
          var port = window.$PORT_NAME;
          if (!port || window.StudioOwn) return;
          port.onmessage = function (event) {
            var detail;
            try { detail = JSON.parse(event.data); } catch (e) { return; }
            var name = detail && detail.channel === 'alerts' ? 'studio-own:alerts' : 'studio-own:termux-result';
            window.dispatchEvent(new CustomEvent(name, { detail: detail }));
          };
          var send = function (message) { port.postMessage(JSON.stringify(message)); };
          window.StudioOwn = Object.freeze({
            isTermuxInstalled: function () { return $termuxInstalled; },
            runInTermux: function (command, workdir, background) {
              send({ type: 'termux.run', command: String(command || ''), workdir: String(workdir || ''), background: !!background });
            },
            approvalAlerts: Object.freeze({
              status: function () { send({ type: 'alerts.status' }); },
              pair: function (code, name) { send({ type: 'alerts.pair', code: String(code || ''), name: String(name || '') }); },
              setMode: function (mode) { send({ type: 'alerts.mode', mode: String(mode || '') }); },
              unpair: function () { send({ type: 'alerts.unpair' }); },
              openBatterySettings: function () { send({ type: 'alerts.battery' }); }
            }),
            openOmiPanel: function () {
              send({ type: 'omi.panel' });
            }
          });
        })();
    """.trimIndent()

    sealed interface Request {
        data class RunInTermux(val command: Termux.Command) : Request
        /** Approval alerts on this phone (docs/approval-alerts.md). */
        data object AlertsStatus : Request
        data class AlertsPair(val code: String, val name: String) : Request
        data class AlertsMode(val mode: String) : Request
        data object AlertsUnpair : Request
        data object AlertsBattery : Request

        /** Show the native Omi and phone AI panel (it asks before every Termux command itself). */
        data object OmiPanel : Request
    }

    /** Parses a page message. Unknown or invalid messages are ignored (null). */
    fun parse(message: String?): Request? {
        val json = try { JSONObject(message ?: return null) } catch (_: Exception) { return null }
        return when (json.optString("type")) {
            "termux.run" -> Termux.command(
                json.optString("command"),
                json.optString("workdir"),
                json.optBoolean("background", true),
            )?.let { Request.RunInTermux(it) }
            "alerts.status" -> Request.AlertsStatus
            "alerts.pair" -> ApprovalAlerts.normalizeCode(json.optString("code"))?.let { Request.AlertsPair(it, json.optString("name").trim().take(60)) }
            "alerts.mode" -> json.optString("mode").takeIf { it in ApprovalAlerts.MODES }?.let { Request.AlertsMode(it) }
            "alerts.unpair" -> Request.AlertsUnpair
            "alerts.battery" -> Request.AlertsBattery
            "omi.panel" -> Request.OmiPanel
            else -> null
        }
    }

    fun resultMessage(fields: Map<String, Any?>): String = JSONObject(fields.filterValues { it != null }).toString()
}
