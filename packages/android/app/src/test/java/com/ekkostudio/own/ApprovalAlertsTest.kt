package com.ekkostudio.own

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalAlertsTest {
    private val work = """{"id":"work-abc","kind":"work","title":"Agent work waits for your approval","detail":"Deploy the gate fix","at":1700000000000,"sessionId":"chat-9","link":"/hermes/connections?tab=agent-work","dangerous":false,"answerable":true}"""
    private val risky = """{"id":"chat-1","kind":"chat","title":"Claude Code asks to run a command","detail":"sudo rm -rf /srv/cache","at":1,"sessionId":"s1","link":"/hermes/session/s1","dangerous":true,"answerable":true}"""
    private val blocked = """{"id":"alert-7","kind":"blocked","title":"Blocked: Fix the gate","detail":"evil.example.com refused","at":2,"sessionId":"","link":"/hermes/chat","dangerous":false,"answerable":false}"""

    @Test
    fun parsesTheListAndSkipsBadEntries() {
        val items = ApprovalAlerts.parseItems("""{"items":[$work,{"id":"../x","kind":"work"},{"id":"a","kind":"other"},$risky]}""")!!
        assertEquals(listOf("work-abc", "chat-1"), items.map { it.id })
        assertEquals("Deploy the gate fix", items[0].detail)
        assertTrue(items[1].dangerous)
        assertNull(ApprovalAlerts.parseItems("not json"))
        assertNull(ApprovalAlerts.parseItems("""{"nothing":1}"""))
    }

    @Test
    fun readsServerSentEvents() {
        val parser = ApprovalAlerts.SseParser()
        val events = "retry: 10000\n\nevent: approvals\ndata: {\"items\":[]}\n\n: ping\n\nevent: test\ndata: a\ndata: b\n\n".split("\n").mapNotNull { parser.feed(it) }
        assertEquals(listOf(ApprovalAlerts.Event("approvals", "{\"items\":[]}"), ApprovalAlerts.Event("test", "a\nb")), events)
        assertEquals(10_000L, parser.retryMs)
        assertNull(ApprovalAlerts.SseParser().feed(""))
        assertEquals(ApprovalAlerts.Event("message", "x"), ApprovalAlerts.SseParser().let { it.feed("data: x\r"); it.feed("\r") })
    }

    @Test
    fun showsNewItemsAndTakesAwayAnsweredOnes() {
        val items = ApprovalAlerts.parseItems("""{"items":[$work,$risky]}""")!!
        val first = ApprovalAlerts.plan(emptySet(), items)
        assertEquals(listOf("work-abc", "chat-1"), first.post.map { it.id })
        assertEquals(emptyList<String>(), first.cancel)
        // chat-1 was answered somewhere (in Studio): it is no longer in the list.
        val second = ApprovalAlerts.plan(setOf("work-abc", "chat-1"), items.take(1))
        assertEquals(emptyList<ApprovalAlerts.Item>(), second.post)
        assertEquals(listOf("chat-1"), second.cancel)
    }

    @Test
    fun buttonsAskFirstForRiskyItemsAndBlockedAlertsHaveNone() {
        val (plain, danger, alert) = ApprovalAlerts.parseItems("""{"items":[$work,$risky,$blocked]}""")!!
        assertEquals(listOf(ApprovalAlerts.Button(ApprovalAlerts.Decision.APPROVE, false), ApprovalAlerts.Button(ApprovalAlerts.Decision.REJECT, false)), ApprovalAlerts.buttons(plain))
        assertTrue(ApprovalAlerts.buttons(danger).all { it.confirmFirst })
        assertTrue(ApprovalAlerts.buttons(alert).isEmpty())
    }

    @Test
    fun tappingOpensTheChatOrStudiosPage() {
        val (plain, _, alert) = ApprovalAlerts.parseItems("""{"items":[$work,$risky,$blocked]}""")!!
        assertEquals("https://studio.example.com/#/hermes/session/chat-9", ApprovalAlerts.openUrl("https://studio.example.com/", plain))
        assertEquals("https://studio.example.com/#/hermes/chat", ApprovalAlerts.openUrl("https://studio.example.com", alert))
        val phone = plain.copy(kind = "phone", sessionId = "s1", link = "/android")
        assertEquals("https://studio.example.com/#/android", ApprovalAlerts.openUrl("https://studio.example.com", phone))
        val offsite = alert.copy(link = "//evil.example.com")
        assertEquals("https://studio.example.com/#/hermes/chat", ApprovalAlerts.openUrl("https://studio.example.com", offsite))
    }

    @Test
    fun answersGoToTheItemsRouteAndShowStudiosWords() {
        assertEquals("/api/studio/approval-alerts/device/approvals/work-abc/approve", ApprovalAlerts.answerPath("work-abc", ApprovalAlerts.Decision.APPROVE))
        assertEquals("/api/studio/approval-alerts/device/approvals/chat-1/reject", ApprovalAlerts.answerPath("chat-1", ApprovalAlerts.Decision.REJECT))
        assertNull(ApprovalAlerts.answerPath("../admin", ApprovalAlerts.Decision.APPROVE))
        assertEquals("Approved.", ApprovalAlerts.answerMessage(200, """{"changed":true,"message":"Approved."}"""))
        assertEquals("Already approved in Studio by robin.", ApprovalAlerts.answerMessage(200, """{"changed":false,"message":"Already approved in Studio by robin."}"""))
        assertEquals("No such approval", ApprovalAlerts.answerMessage(404, """{"error":"No such approval"}"""))
        assertTrue(ApprovalAlerts.answerMessage(401, "").contains("not paired"))
        assertTrue(ApprovalAlerts.answerMessage(0, "").contains("did not answer"))
    }

    @Test
    fun notificationIdsAreStableAndNeverTheOngoingOne() {
        assertEquals(ApprovalAlerts.notificationId("work-abc"), ApprovalAlerts.notificationId("work-abc"))
        assertNotEquals(ApprovalAlerts.notificationId("work-abc"), ApprovalAlerts.notificationId("work-abd"))
        assertTrue((0..2000).map { "chat-$it" }.none { ApprovalAlerts.notificationId(it) == ApprovalAlerts.ONGOING_ID })
    }

    @Test
    fun reconnectsWithGrowingWaits() {
        assertEquals(2_000L, ApprovalAlerts.backoffMs(0))
        assertEquals(4_000L, ApprovalAlerts.backoffMs(1))
        assertEquals(300_000L, ApprovalAlerts.backoffMs(20))
    }

    @Test
    fun pairingCodesAndLinks() {
        assertEquals("ABCD-EF23", ApprovalAlerts.normalizeCode(" abcd ef23 "))
        assertNull(ApprovalAlerts.normalizeCode("ABCD-EF2"))
        assertNull(ApprovalAlerts.normalizeCode("ABCD-EF01"))
        val link = ApprovalAlerts.parsePairLink("studio-own://pair?server=https%3A%2F%2Fstudio.example.com%2F&code=abcd-ef23")!!
        assertEquals(ApprovalAlerts.PairLink("https://studio.example.com", "ABCD-EF23"), link)
        assertEquals(ApprovalAlerts.PairLink(null, "ABCD-EF23"), ApprovalAlerts.parsePairLink("studio-own://pair?server=javascript%3Aalert(1)&code=ABCDEF23"))
        assertNull(ApprovalAlerts.parsePairLink("studio-own://pair?code=nope"))
        assertNull(ApprovalAlerts.parsePairLink("https://studio.example.com/pair?code=ABCDEF23"))
        assertEquals("""{"code":"ABCD-EF23","name":"Pixel 8"}""", ApprovalAlerts.pairBody("ABCD-EF23", "Pixel 8").let { org.json.JSONObject(it).let { j -> """{"code":"${j.getString("code")}","name":"${j.getString("name")}"}""" } })
        val key = "sk-studio-phone-" + "a".repeat(43)
        assertEquals(ApprovalAlerts.Paired(key, "d1", "Pixel 8"), ApprovalAlerts.parsePaired("""{"key":"$key","device":{"id":"d1","name":"Pixel 8"}}"""))
        assertNull(ApprovalAlerts.parsePaired("""{"key":"sk-studio-omi-x","device":{"id":"d1"}}"""))
    }

    @Test
    fun theStudioPageGetsThePhonesState() {
        val state = org.json.JSONObject(ApprovalAlerts.stateMessage(true, "Pixel 8", "live", notifications = false, unrestricted = false, message = "Paired."))
        assertEquals("alerts", state.getString("channel"))
        assertEquals("denied", state.getString("notifications"))
        assertEquals("Paired.", state.getString("message"))
        assertFalse(state.getBoolean("unrestricted"))
    }
}
