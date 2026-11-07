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
     * and turns replies into a `studio-own:termux-result` event.
     */
    fun documentStartScript(termuxInstalled: Boolean): String = """
        (function () {
          var port = window.$PORT_NAME;
          if (!port || window.StudioOwn) return;
          port.onmessage = function (event) {
            var detail;
            try { detail = JSON.parse(event.data); } catch (e) { return; }
            window.dispatchEvent(new CustomEvent('studio-own:termux-result', { detail: detail }));
          };
          window.StudioOwn = Object.freeze({
            isTermuxInstalled: function () { return $termuxInstalled; },
            runInTermux: function (command, workdir, background) {
              port.postMessage(JSON.stringify({ type: 'termux.run', command: String(command || ''), workdir: String(workdir || ''), background: !!background }));
            }
          });
        })();
    """.trimIndent()

    sealed interface Request {
        data class RunInTermux(val command: Termux.Command) : Request
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
            else -> null
        }
    }

    fun resultMessage(fields: Map<String, Any?>): String = JSONObject(fields.filterValues { it != null }).toString()
}
