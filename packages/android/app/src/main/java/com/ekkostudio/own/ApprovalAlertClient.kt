package com.ekkostudio.own

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Talks to Studio with the phone's key (docs/approval-alerts.md). Plain
 * HttpURLConnection, so the stream, the list and answers are unit tested on
 * the JVM against a local server. The key goes only in the Authorization
 * header, never in a URL.
 */
class ApprovalAlertClient(private val server: String, private val key: String = "") {
    data class Response(val status: Int, val body: String)

    private fun open(path: String, method: String, timeoutMs: Int): HttpURLConnection {
        val connection = URL(server.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = timeoutMs
        connection.setRequestProperty("Accept", "application/json")
        if (key.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer $key")
        return connection
    }

    private fun call(path: String, method: String, body: String? = null): Response {
        val connection = open(path, method, 20_000)
        return try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray()) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            Response(status, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
        } catch (_: Exception) {
            Response(0, "")
        } finally {
            connection.disconnect()
        }
    }

    /** Trade a pairing code for this phone's key. */
    fun pair(code: String, name: String): Response = call(ApprovalAlerts.PAIR_PATH, "POST", ApprovalAlerts.pairBody(code, name))

    /** The list once (Battery saver checks, and after the app opens). */
    fun pending(): Response = call("${ApprovalAlerts.DEVICE_PATH}/approvals", "GET")

    fun status(): Response = call(ApprovalAlerts.DEVICE_PATH, "GET")

    /** Approve or reject one item. The message says what happened, including "Already approved in Studio". */
    fun answer(itemId: String, decision: ApprovalAlerts.Decision): Response {
        val path = ApprovalAlerts.answerPath(itemId, decision) ?: return Response(400, """{"error":"Not an approval from Studio."}""")
        return call(path, "POST", "{}")
    }

    /**
     * Holds the live stream open and calls [onEvent] for each event until the
     * server closes it, [stopped] says so, or the connection drops. Returns
     * the HTTP status (0 when Studio could not be reached). Studio sends a
     * comment every 45 seconds, so a read that waits 120 seconds means the
     * connection is gone.
     */
    fun stream(onEvent: (ApprovalAlerts.Event) -> Unit, stopped: () -> Boolean, onOpen: (HttpURLConnection) -> Unit = {}): Int {
        val connection = open("${ApprovalAlerts.DEVICE_PATH}/stream", "GET", 120_000)
        connection.setRequestProperty("Accept", "text/event-stream")
        return try {
            val status = connection.responseCode
            if (status != 200) return status
            onOpen(connection)
            val parser = ApprovalAlerts.SseParser()
            BufferedReader(InputStreamReader(connection.inputStream, Charsets.UTF_8)).use { reader ->
                while (!stopped()) {
                    val line = reader.readLine() ?: break
                    parser.feed(line)?.let(onEvent)
                }
            }
            status
        } catch (_: Exception) {
            0
        } finally {
            connection.disconnect()
        }
    }
}
