package com.ekkostudio.own

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The phone's HTTP side against a small stand-in for Studio (OkHttp's
 * MockWebServer: the JDK's com.sun HTTP server is not on the Android unit-test
 * compile classpath).
 */
class ApprovalAlertClientTest {
    private lateinit var server: MockWebServer
    private val key = "sk-studio-phone-" + "k".repeat(43)
    private val seen = CopyOnWriteArrayList<String>()
    @Volatile private var answered = false

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val auth = request.getHeader("Authorization").orEmpty()
                val target = request.path.orEmpty()
                seen += "${request.method} $target ${if (auth == "Bearer $key") "key" else "nokey"}"
                val path = target.substringBefore('?')
                val (status, body, type) = when {
                    path == ApprovalAlerts.PAIR_PATH -> {
                        val sent = request.body.readUtf8()
                        if (sent.contains("ABCD-EF23")) Triple(201, """{"key":"$key","device":{"id":"d1","name":"Pixel 8"},"username":"robin"}""", "application/json")
                        else Triple(401, """{"error":"This code is wrong or has expired."}""", "application/json")
                    }
                    auth != "Bearer $key" -> Triple(401, """{"error":"This phone is not paired any more."}""", "application/json")
                    path.endsWith("/stream") -> Triple(200, "retry: 10000\n\nevent: approvals\ndata: {\"items\":[{\"id\":\"work-abc\",\"kind\":\"work\",\"title\":\"T\",\"detail\":\"D\",\"answerable\":true}]}\n\n: ping\n\nevent: approvals\ndata: {\"items\":[]}\n\n", "text/event-stream")
                    path.endsWith("/approvals") -> Triple(200, """{"items":[{"id":"chat-1","kind":"chat","title":"T","detail":"D","answerable":true}]}""", "application/json")
                    path.endsWith("/approve") -> {
                        val body = if (answered) """{"changed":false,"message":"Already approved on phone (Pixel 8)."}""" else """{"changed":true,"message":"Approved."}"""
                        answered = true
                        Triple(200, body, "application/json")
                    }
                    else -> Triple(404, """{"error":"No such approval"}""", "application/json")
                }
                return MockResponse().setResponseCode(status).setHeader("Content-Type", type).setBody(body)
            }
        }
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private val base get() = server.url("/").toString().trimEnd('/')

    @Test
    fun pairsWithACodeAndKeepsTheKeyOutOfUrls() {
        val response = ApprovalAlertClient(base).pair("ABCD-EF23", "Pixel 8")
        assertEquals(201, response.status)
        assertEquals("d1", ApprovalAlerts.parsePaired(response.body)?.deviceId)
        val wrong = ApprovalAlertClient(base).pair("ZZZZ-ZZZZ", "")
        assertEquals("This code is wrong or has expired.", ApprovalAlerts.answerMessage(wrong.status, wrong.body))
        ApprovalAlertClient(base, key).pending()
        assertTrue(seen.none { it.contains(key) })
    }

    @Test
    fun readsTheStreamAndTheList() {
        val events = mutableListOf<ApprovalAlerts.Event>()
        val status = ApprovalAlertClient(base, key).stream(onEvent = { events += it }, stopped = { false })
        assertEquals(200, status)
        assertEquals(listOf("approvals", "approvals"), events.map { it.name })
        assertEquals(listOf("work-abc"), ApprovalAlerts.parseItems(events[0].data)!!.map { it.id })
        assertEquals(emptyList<String>(), ApprovalAlerts.parseItems(events[1].data)!!.map { it.id })
        assertTrue(seen.any { it == "GET /api/studio/approval-alerts/device/stream key" })
        val list = ApprovalAlertClient(base, key).pending()
        assertEquals(listOf("chat-1"), ApprovalAlerts.parseItems(list.body)!!.map { it.id })
    }

    @Test
    fun answersOnceAndShowsWhereItWasAnswered() {
        val client = ApprovalAlertClient(base, key)
        val first = client.answer("work-abc", ApprovalAlerts.Decision.APPROVE)
        assertEquals("Approved.", ApprovalAlerts.answerMessage(first.status, first.body))
        val second = client.answer("work-abc", ApprovalAlerts.Decision.APPROVE)
        assertEquals("Already approved on phone (Pixel 8).", ApprovalAlerts.answerMessage(second.status, second.body))
        assertEquals(400, client.answer("../../admin", ApprovalAlerts.Decision.APPROVE).status)
        assertTrue(seen.contains("POST /api/studio/approval-alerts/device/approvals/work-abc/approve key"))
    }

    @Test
    fun aRemovedPhoneGets401() {
        val client = ApprovalAlertClient(base, "sk-studio-phone-" + "x".repeat(43))
        assertEquals(401, client.stream(onEvent = {}, stopped = { false }))
        assertEquals(401, client.pending().status)
    }
}
