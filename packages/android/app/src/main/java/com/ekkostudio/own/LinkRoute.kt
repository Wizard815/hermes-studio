package com.ekkostudio.own

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * Links that open Studio Own (docs/android-devices.md):
 *
 * - `https://<your Studio server>/…` opens in the app. Android sends these here
 *   when the app was built with that host (`-PstudioOwnHost=…`) and the server
 *   serves `/.well-known/assetlinks.json`, or when the person picks the app.
 * - `studio-own://chat/<session id>` opens that chat.
 * - `studio-own://open?url=<a link on your Studio server>` opens that page.
 *
 * Anything that is not on the configured server goes to the browser: the app's
 * page bridge (Termux, APK installs) is only for the server's own pages.
 */
object LinkRoute {
    const val SCHEME = "studio-own"

    sealed interface Target {
        data class InApp(val url: String) : Target
        data class Browser(val url: String) : Target
        /** Nothing to open (bad link, or no server set up yet). */
        data object Ignore : Target
        /** `studio-own://pair?server=…&code=…`: pair for approval alerts (docs/approval-alerts.md). */
        data class Pair(val link: ApprovalAlerts.PairLink) : Target
    }

    private val sessionId = Regex("^[A-Za-z0-9_.:-]{1,200}$")

    fun resolve(link: String?, serverUrl: String?): Target {
        val raw = link?.trim().orEmpty()
        if (raw.isEmpty()) return Target.Ignore
        val uri = try { URI(raw) } catch (_: Exception) { return Target.Ignore }
        val scheme = uri.scheme?.lowercase()
        // Pairing works before a server is set up: the link names the server.
        if (scheme == SCHEME && uri.host?.lowercase() == "pair") return ApprovalAlerts.parsePairLink(raw)?.let { Target.Pair(it) } ?: Target.Ignore
        if (scheme == SCHEME) return resolveCustom(uri, serverUrl)
        if (scheme != "http" && scheme != "https") return Target.Ignore
        val server = serverUrl?.let { StudioBridge.originRule(it) }
        return if (server != null && StudioBridge.originRule(raw) == server) Target.InApp(raw) else Target.Browser(raw)
    }

    private fun resolveCustom(uri: URI, serverUrl: String?): Target {
        val server = serverUrl?.trimEnd('/') ?: return Target.Ignore
        return when (uri.host?.lowercase()) {
            "chat" -> {
                val id = URLDecoder.decode(uri.rawPath.orEmpty().trim('/'), "UTF-8")
                if (!sessionId.matches(id)) Target.Ignore
                else Target.InApp("$server/#/hermes/session/${URLEncoder.encode(id, "UTF-8")}")
            }
            "open" -> {
                val target = queryParam(uri.rawQuery, "url") ?: return Target.Ignore
                // Only pages on the server; studio-own:// inside studio-own:// is not followed.
                if (!target.startsWith("http://", ignoreCase = true) && !target.startsWith("https://", ignoreCase = true)) return Target.Ignore
                when (val inner = resolve(target, serverUrl)) {
                    is Target.InApp -> inner
                    else -> Target.Ignore
                }
            }
            else -> Target.Ignore
        }
    }

    private fun queryParam(rawQuery: String?, name: String): String? {
        for (pair in rawQuery.orEmpty().split('&')) {
            val key = pair.substringBefore('=')
            if (key == name) return URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8").ifEmpty { null }
        }
        return null
    }
}
