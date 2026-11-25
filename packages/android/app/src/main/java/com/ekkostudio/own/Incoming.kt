package com.ekkostudio.own

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * What other apps (Omi, a browser, any share sheet) can hand to Studio Own.
 * Shared text only ever lands in the composer of a new Studio chat: nothing is
 * sent until the person presses Send there. See docs/omi.md for the contract.
 */
object Incoming {
    const val SCHEME = "ekkostudio-own"
    const val ACTION_SEND = "android.intent.action.SEND"
    const val ACTION_VIEW = "android.intent.action.VIEW"
    const val MAX_TEXT_LENGTH = 20_000

    /** The Studio web route that opens a new chat with `compose` in its composer. */
    const val COMPOSE_ROUTE = "/#/hermes/chat?compose="

    sealed interface Request {
        /** Open a new Studio chat with [text] in the composer; [truncated] when it was cut to [MAX_TEXT_LENGTH]. */
        data class Compose(val text: String, val truncated: Boolean) : Request

        /** Show the native Omi and phone AI panel. */
        data object OmiPanel : Request
    }

    /**
     * Reads an incoming intent, passed as plain values so it can be tested off-device.
     * `ACTION_SEND` with text, `ekkostudio-own://chat?text=...` and `ekkostudio-own://omi`
     * are understood; anything else is null.
     */
    fun parse(action: String?, type: String?, data: String?, text: CharSequence?, subject: CharSequence?): Request? = when (action) {
        ACTION_SEND -> if (type == null || type.lowercase().startsWith("text/")) shared(text?.toString(), subject?.toString()) else null
        ACTION_VIEW -> data?.let(::link)
        else -> null
    }

    /** `ekkostudio-own://chat[?text=...]` or `ekkostudio-own://omi`. */
    fun link(uri: String): Request? {
        val parsed = try { URI(uri) } catch (_: Exception) { return null }
        if (!parsed.scheme.equals(SCHEME, ignoreCase = true)) return null
        return when (parsed.host?.lowercase()) {
            // No text opens an empty new chat; a malformed escape is rejected.
            "chat" -> query(parsed.rawQuery.orEmpty())?.let { compose(it["text"].orEmpty()) }
            "omi" -> Request.OmiPanel
            else -> null
        }
    }

    /** A share carries the text and sometimes a subject (a title); keep both, once. */
    private fun shared(text: String?, subject: String?): Request? {
        val body = text?.trim().orEmpty()
        val title = subject?.trim().orEmpty()
        val combined = when {
            title.isEmpty() || body.contains(title) -> body
            body.isEmpty() -> title
            else -> "$title\n\n$body"
        }
        return if (combined.isEmpty()) null else compose(combined)
    }

    private fun compose(raw: String): Request.Compose {
        val text = raw.trim()
        if (text.length <= MAX_TEXT_LENGTH) return Request.Compose(text, truncated = false)
        // Do not cut a surrogate pair in half.
        val end = if (Character.isHighSurrogate(text[MAX_TEXT_LENGTH - 1])) MAX_TEXT_LENGTH - 1 else MAX_TEXT_LENGTH
        return Request.Compose(text.substring(0, end), truncated = true)
    }

    /** Form-style query (`+` is a space); null when an escape is malformed. */
    private fun query(raw: String): Map<String, String>? = try {
        raw.split('&').filter { it.isNotEmpty() }.associate { pair ->
            val at = pair.indexOf('=')
            val key = if (at < 0) pair else pair.substring(0, at)
            val value = if (at < 0) "" else pair.substring(at + 1)
            URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
        }
    } catch (_: IllegalArgumentException) {
        null
    }

    /**
     * The page to load for a compose request: the configured server, Studio's
     * new-chat route and the text. Only the configured server's origin gets it.
     * The text sits in the URL fragment, so it is not sent to the server.
     */
    fun composeUrl(serverUrl: String, text: String): String? {
        StudioBridge.originRule(serverUrl) ?: return null
        val base = serverUrl.substringBefore('#').substringBefore('?').trimEnd('/')
        return base + COMPOSE_ROUTE + URLEncoder.encode(text, "UTF-8").replace("+", "%20")
    }
}
