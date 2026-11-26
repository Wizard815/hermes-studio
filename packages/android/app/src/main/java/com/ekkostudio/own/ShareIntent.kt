package com.ekkostudio.own

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * "Share → Studio" from any app: text, a link or images. The app asks whether
 * to start a new chat or add to the open one, then hands the Studio page what
 * was shared (`window.__studioOwnShare` and a `studio-own-share` event). The
 * page puts it in the chat input; nothing is sent until the person presses Send
 * (packages/client/src/utils/studio-own-share.ts).
 */
object ShareIntent {
    const val ACTION_SEND = "android.intent.action.SEND"
    const val ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"
    const val MAX_IMAGES = 4
    const val MAX_IMAGE_BYTES = 8 * 1024 * 1024
    const val MAX_TEXT = 100_000

    data class Shared(val text: String, val imageUris: List<String>)

    class Image(val name: String, val type: String, val bytes: ByteArray)

    enum class Mode(val wire: String) { NEW_CHAT("new"), CURRENT_CHAT("current") }

    /** What an ACTION_SEND / ACTION_SEND_MULTIPLE intent carries; null when there is nothing to share. */
    fun parse(action: String?, type: String?, text: CharSequence?, subject: CharSequence?, streams: List<String>): Shared? {
        if (action != ACTION_SEND && action != ACTION_SEND_MULTIPLE) return null
        val mime = type?.lowercase().orEmpty()
        val body = composeText(subject?.toString(), text?.toString())
        // Only images from a content provider (not file:// paths into this app's own storage).
        val images = if (mime.startsWith("image/") || mime == "*/*") {
            streams.filter { it.startsWith("content://") }.distinct().take(MAX_IMAGES)
        } else emptyList()
        if (body.isBlank() && images.isEmpty()) return null
        return Shared(body, images)
    }

    /** Subject and text as one message: a page title above its link, unless the text already has it. */
    fun composeText(subject: String?, text: String?): String {
        val body = text?.trim().orEmpty()
        val title = subject?.trim().orEmpty()
        val joined = when {
            title.isEmpty() -> body
            body.isEmpty() -> title
            body.contains(title) -> body
            else -> "$title\n$body"
        }
        return joined.take(MAX_TEXT)
    }

    /** Whether a content type may be attached (Studio's chat input takes images). */
    fun isImageType(type: String?): Boolean = type != null && Regex("^image/[a-z0-9.+-]+$", RegexOption.IGNORE_CASE).matches(type)

    /** A file name without path parts. */
    fun safeName(name: String?, type: String): String {
        val cleaned = name?.replace(Regex("[\\\\/]"), "_")?.trim()?.take(120).orEmpty()
        if (cleaned.isNotEmpty()) return cleaned
        val ext = type.substringAfter('/', "img").substringBefore('+').ifEmpty { "img" }
        return "shared.$ext"
    }

    /** The JavaScript the app runs in the Studio page (only pages from the configured server). */
    fun pageScript(mode: Mode, text: String, images: List<Image>): String {
        val files = JSONArray()
        for (image in images) {
            files.put(JSONObject()
                .put("name", image.name)
                .put("type", image.type)
                .put("data", Base64.getEncoder().encodeToString(image.bytes)))
        }
        val payload = JSONObject().put("mode", mode.wire).put("text", text).put("files", files)
        return "window.__studioOwnShare = $payload; window.dispatchEvent(new Event('studio-own-share'));"
    }
}
