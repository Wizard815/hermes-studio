package com.ekkostudio.own

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The phone's own language model (llama.cpp `llama-server`, 127.0.0.1:8081) and
 * speech-to-text (`whisper-server`, 127.0.0.1:8080) from Omi's PHONE-LLM guide,
 * started and stopped in Termux. Both commands go through the normal Termux
 * confirmation; the status probe only reads the two local ports.
 */
object PhoneAi {
    /** The guide's start script. */
    val START: Termux.Command = checkNotNull(Termux.command("~/bin/omi-phone-ai.sh", null, background = true))

    /** The guide's stop command (step 4). */
    val STOP: Termux.Command = checkNotNull(Termux.command("pkill llama-server; pkill whisper-server; termux-wake-unlock", null, background = true))

    /** llama-server's health check: 200 when ready, 503 while the model loads; no API key needed. */
    const val CHAT_URL = "http://127.0.0.1:8081/health"

    /** whisper-server's page. */
    const val SPEECH_URL = "http://127.0.0.1:8080/"

    enum class State { OFF, LOADING, RUNNING }

    data class Status(val chat: State, val speech: State)

    /** What a probe's HTTP status (null: nothing answered) means. */
    fun state(httpCode: Int?): State = when (httpCode) {
        null -> State.OFF
        503 -> State.LOADING
        else -> State.RUNNING
    }

    fun status(chatCode: Int?, speechCode: Int?): Status = Status(state(chatCode), state(speechCode))

    sealed interface Outcome {
        data object Done : Outcome

        /** Termux refused because `allow-external-apps` is not enabled. */
        data object TermuxNotSetUp : Outcome

        /** bash could not find `~/bin/omi-phone-ai.sh`. */
        data object ScriptMissing : Outcome

        data class Failed(val message: String) : Outcome
    }

    /** Maps a Termux result (see [Termux.result]) to what the phone AI panel tells the person. */
    fun outcome(result: Map<String, Any?>): Outcome {
        val error = (result["error"] as? String)?.takeIf { it.isNotBlank() }
        if (error != null) return if (error.contains("allow-external-apps", ignoreCase = true)) Outcome.TermuxNotSetUp else Outcome.Failed(error)
        val code = result["exitCode"] as? Int ?: return Outcome.Done
        if (code == 0) return Outcome.Done
        if (code == 127) return Outcome.ScriptMissing
        val stderr = (result["stderr"] as? String)?.trim().orEmpty()
        return Outcome.Failed(if (stderr.isEmpty()) "Exit code $code" else stderr.takeLast(300))
    }

    /** Blocking: call off the main thread. The HTTP status, or null when nothing listens. */
    fun probe(url: String, timeoutMs: Int = 1_500): Int? {
        val connection = try { URL(url).openConnection() as HttpURLConnection } catch (_: IOException) { return null }
        return try {
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.instanceFollowRedirects = false
            connection.responseCode
        } catch (_: IOException) {
            null
        } finally {
            connection.disconnect()
        }
    }
}
