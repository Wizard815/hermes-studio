package com.ekkostudio.own

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingTest {
    private fun share(text: String?, subject: String? = null, type: String? = "text/plain") =
        Incoming.parse(Incoming.ACTION_SEND, type, null, text, subject)

    private fun view(uri: String) = Incoming.parse(Incoming.ACTION_VIEW, null, uri, null, null)

    @Test
    fun sharedTextBecomesAComposeRequest() {
        assertEquals(Incoming.Request.Compose("Call Sam about the invoice", false), share("  Call Sam about the invoice \n"))
        assertEquals(Incoming.Request.Compose("Meeting notes\n\nSam will send it.", false), share("Sam will send it.", "Meeting notes"))
        // A subject already in the text is not repeated; a subject alone is enough.
        assertEquals(Incoming.Request.Compose("Meeting notes: Sam will send it.", false), share("Meeting notes: Sam will send it.", "Meeting notes"))
        assertEquals(Incoming.Request.Compose("Meeting notes", false), share(null, "Meeting notes"))
    }

    @Test
    fun ignoresEmptyAndNonTextShares() {
        assertNull(share("   "))
        assertNull(share(null))
        assertNull(share("hello", type = "image/png"))
        assertNull(Incoming.parse("android.intent.action.MAIN", null, null, "hello", null))
        assertNull(Incoming.parse(null, null, null, null, null))
    }

    @Test
    fun longSharesAreCutWithoutSplittingACharacter() {
        val long = share("a".repeat(Incoming.MAX_TEXT_LENGTH + 5)) as Incoming.Request.Compose
        assertTrue(long.truncated)
        assertEquals(Incoming.MAX_TEXT_LENGTH, long.text.length)
        val emoji = "😀"
        val atBoundary = share("a".repeat(Incoming.MAX_TEXT_LENGTH - 1) + emoji + "b") as Incoming.Request.Compose
        assertTrue(atBoundary.truncated)
        assertEquals(Incoming.MAX_TEXT_LENGTH - 1, atBoundary.text.length)
        assertFalse(Character.isHighSurrogate(atBoundary.text.last()))
    }

    @Test
    fun chatLinksCarryDecodedText() {
        assertEquals(Incoming.Request.Compose("Draft a reply to Sam & Co.", false), view("ekkostudio-own://chat?text=Draft%20a%20reply%20to%20Sam%20%26%20Co."))
        assertEquals(Incoming.Request.Compose("plus is a space", false), view("ekkostudio-own://chat?text=plus+is+a+space"))
        assertEquals(Incoming.Request.Compose("über ✓", false), view("EKKOSTUDIO-OWN://chat?other=1&text=%C3%BCber%20%E2%9C%93"))
        // No text: an empty new chat.
        assertEquals(Incoming.Request.Compose("", false), view("ekkostudio-own://chat"))
        assertEquals(Incoming.Request.OmiPanel, view("ekkostudio-own://omi"))
    }

    @Test
    fun rejectsOtherSchemesHostsAndBrokenLinks() {
        assertNull(view("https://studio.example.com/#/hermes/chat?compose=x"))
        assertNull(view("omi://approvals"))
        assertNull(view("ekkostudio-own://settings?text=x"))
        assertNull(view("ekkostudio-own://chat?text=%E0%A4%A"))
        assertNull(view("not a uri"))
    }

    @Test
    fun composeUrlTargetsTheConfiguredServersNewChatRoute() {
        assertEquals(
            "https://studio.example.com/#/hermes/chat?compose=Hi%20Sam%2C%20a%2Bb%20%26%20%23tag%0Anext",
            Incoming.composeUrl("https://studio.example.com", "Hi Sam, a+b & #tag\nnext"),
        )
        // A saved address with a path, query or fragment keeps only scheme, host and path.
        assertEquals("https://example.com/studio/#/hermes/chat?compose=x", Incoming.composeUrl("https://example.com/studio/?a=1#/android", "x"))
        assertEquals("http://localhost:8648/#/hermes/chat?compose=", Incoming.composeUrl("http://localhost:8648", ""))
        assertNull(Incoming.composeUrl("file:///sdcard/index.html", "x"))
        assertNull(Incoming.composeUrl("javascript:alert(1)", "x"))
    }

    @Test
    fun composeUrlStaysOnTheServerOrigin() {
        val server = "https://studio.example.com"
        val url = Incoming.composeUrl(server, "@evil.example.com/ https://evil.example.com")!!
        assertEquals(StudioBridge.originRule(server), StudioBridge.originRule(url))
    }
}
