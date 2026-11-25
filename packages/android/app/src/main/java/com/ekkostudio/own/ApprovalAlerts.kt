package com.ekkostudio.own

import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * Approval alerts (docs/approval-alerts.md): what Studio sends a paired phone
 * and what the app does with it. No Android classes here, so it is unit
 * tested on the JVM; the service, notifications and receiver use it.
 */
object ApprovalAlerts {
    const val KEY_PREFIX = "sk-studio-phone-"
    const val DEVICE_PATH = "/api/studio/approval-alerts/device"
    const val PAIR_PATH = "/api/studio/approval-alerts/pair"

    data class Item(
        val id: String,
        val kind: String,
        val title: String,
        val detail: String,
        val at: Long,
        val sessionId: String,
        val link: String,
        val dangerous: Boolean,
        val answerable: Boolean,
    )

    private val itemId = Regex("^[A-Za-z0-9_-]{1,120}$")
    private val kinds = setOf("work", "chat", "phone", "blocked")

    fun parseItem(json: JSONObject): Item? {
        val id = json.optString("id")
        val kind = json.optString("kind")
        if (!itemId.matches(id) || kind !in kinds) return null
        return Item(
            id = id,
            kind = kind,
            title = json.optString("title").take(120).ifBlank { "Studio asks for approval" },
            detail = json.optString("detail").take(600),
            at = json.optLong("at"),
            sessionId = json.optString("sessionId").take(200),
            link = json.optString("link").take(300),
            dangerous = json.optBoolean("dangerous", false),
            answerable = json.optBoolean("answerable", false),
        )
    }

    /** `{"items":[…]}` from the list route or an `approvals` stream event. Bad entries are skipped. */
    fun parseItems(body: String?): List<Item>? {
        val json = try { JSONObject(body ?: return null) } catch (_: Exception) { return null }
        val array = json.optJSONArray("items") ?: return null
        return (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.let(::parseItem) }
    }

    // --- the stream ---------------------------------------------------------

    data class Event(val name: String, val data: String)

    /**
     * Server-sent events, one line at a time. Returns an event at each blank
     * line; comments (`: ping`) and `retry:` are not events.
     */
    class SseParser {
        private var name = ""
        private val data = StringBuilder()
        var retryMs: Long? = null
            private set

        fun feed(rawLine: String): Event? {
            val line = rawLine.removeSuffix("\r")
            if (line.isEmpty()) {
                if (data.isEmpty() && name.isEmpty()) return null
                val event = Event(name.ifEmpty { "message" }, data.toString().removeSuffix("\n"))
                name = ""
                data.setLength(0)
                return event
            }
            if (line.startsWith(":")) return null
            val field = line.substringBefore(':')
            val value = line.substringAfter(':', "").removePrefix(" ")
            when (field) {
                "event" -> name = value
                "data" -> data.append(value).append('\n')
                "retry" -> value.toLongOrNull()?.let { retryMs = it }
            }
            return null
        }
    }

    // --- notifications --------------------------------------------------------

    /** Which notifications to show and which to take away, given what is shown now. */
    data class Plan(val post: List<Item>, val cancel: List<String>)

    fun plan(shown: Set<String>, items: List<Item>): Plan {
        val ids = items.map { it.id }.toSet()
        return Plan(post = items.filter { it.id !in shown }, cancel = shown.filter { it !in ids }.sorted())
    }

    /** A stable notification id per item; never the ongoing notification's. */
    fun notificationId(itemId: String): Int {
        val hash = itemId.hashCode() and 0x3fffffff
        return if (hash == ONGOING_ID) hash + 1 else hash + 1000
    }

    const val ONGOING_ID = 41

    enum class Decision(val path: String, val label: String) { APPROVE("approve", "Approve"), REJECT("reject", "Reject") }

    /**
     * What a notification button does. A risky item asks on the phone first
     * (the app opens a confirmation); Blocked alerts have no buttons, they only open Studio.
     */
    data class Button(val decision: Decision, val confirmFirst: Boolean)

    fun buttons(item: Item): List<Button> =
        if (!item.answerable) emptyList()
        else listOf(Button(Decision.APPROVE, item.dangerous), Button(Decision.REJECT, item.dangerous))

    /** Where tapping the notification goes in the app: the chat, else the page Studio named. */
    fun openUrl(server: String, item: Item): String {
        val base = server.trimEnd('/')
        if (item.sessionId.isNotBlank() && item.kind != "phone") return "$base/#/hermes/session/${URLEncoder.encode(item.sessionId, "UTF-8")}"
        val link = item.link.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/hermes/chat"
        return "$base/#$link"
    }

    /** Null for anything that is not one of Studio's item ids (they go into a URL path). */
    fun answerPath(id: String, decision: Decision): String? =
        if (!itemId.matches(id)) null else "$DEVICE_PATH/approvals/$id/${decision.path}"

    /** The text to show after an answer: Studio's own words ("Already approved in Studio by robin."). */
    fun answerMessage(status: Int, body: String?): String {
        val json = try { JSONObject(body ?: "") } catch (_: Exception) { null }
        if (status in 200..299) return json?.optString("message")?.ifBlank { null } ?: "Done."
        val error = json?.optString("error")?.ifBlank { null }
        return when {
            error != null -> error
            status == 401 -> "This phone is not paired any more. Pair it again in Studio: Settings → Android app."
            status == 0 -> "Studio did not answer. Check the phone's connection, then try again from Studio."
            else -> "Studio answered $status. Try again from Studio."
        }
    }

    /** Wait before reconnecting the stream: 2 s, 4 s, … up to 5 minutes. */
    fun backoffMs(attempt: Int): Long {
        val exp = 2_000L shl attempt.coerceIn(0, 8)
        return minOf(exp, 300_000L)
    }

    // --- pairing ---------------------------------------------------------------

    data class PairLink(val server: String?, val code: String)

    private val codePattern = Regex("^[A-Z2-9]{8}$")

    /** `abcd efgh` or `ABCD-EFGH` → `ABCD-EFGH`; null when it is not a pairing code. */
    fun normalizeCode(raw: String?): String? {
        val compact = raw.orEmpty().uppercase().filter { it.isLetterOrDigit() }
        return if (codePattern.matches(compact)) "${compact.take(4)}-${compact.drop(4)}" else null
    }

    /** `studio-own://pair?server=https%3A%2F%2Fstudio.example.com&code=ABCD-EFGH` (the QR code in Studio). */
    fun parsePairLink(raw: String?): PairLink? {
        val uri = try { URI(raw?.trim() ?: return null) } catch (_: Exception) { return null }
        if (uri.scheme?.lowercase() != LinkRoute.SCHEME || uri.host?.lowercase() != "pair") return null
        var server: String? = null
        var code: String? = null
        for (pair in uri.rawQuery.orEmpty().split('&')) {
            val value = URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")
            when (pair.substringBefore('=')) {
                "server" -> server = StudioBridge.originRule(value)?.let { value.trimEnd('/') }
                "code" -> code = normalizeCode(value)
            }
        }
        return PairLink(server, code ?: return null)
    }

    fun pairBody(code: String, name: String): String = JSONObject(mapOf("code" to code, "name" to name.take(60))).toString()

    data class Paired(val key: String, val deviceId: String, val deviceName: String)

    fun parsePaired(body: String?): Paired? {
        val json = try { JSONObject(body ?: return null) } catch (_: Exception) { return null }
        val key = json.optString("key")
        val device = json.optJSONObject("device") ?: return null
        if (!key.startsWith(KEY_PREFIX) || key.length != KEY_PREFIX.length + 43) return null
        return Paired(key, device.optString("id"), device.optString("name").ifBlank { "Phone" })
    }

    /** What the Studio page's Settings → Android app shows about this phone (`studio-own:alerts`). */
    fun stateMessage(paired: Boolean, deviceName: String, mode: String, notifications: Boolean, unrestricted: Boolean, message: String? = null): String =
        JSONObject(
            mapOf(
                "channel" to "alerts",
                "paired" to paired,
                "deviceName" to deviceName,
                "mode" to mode,
                "notifications" to if (notifications) "granted" else "denied",
                "unrestricted" to unrestricted,
            ) + (if (message != null) mapOf("message" to message) else emptyMap()),
        ).toString()

    val MODES = setOf("live", "saver", "off")
}
