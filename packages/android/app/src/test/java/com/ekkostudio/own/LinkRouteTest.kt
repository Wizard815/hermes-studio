package com.ekkostudio.own

import org.junit.Assert.assertEquals
import org.junit.Test

class LinkRouteTest {
    private val server = "https://studio.example.com"

    @Test
    fun linksToTheServerOpenInTheApp() {
        assertEquals(LinkRoute.Target.InApp("https://studio.example.com/#/hermes/session/abc"), LinkRoute.resolve("https://studio.example.com/#/hermes/session/abc", server))
        assertEquals(LinkRoute.Target.InApp("https://STUDIO.example.com:443/x"), LinkRoute.resolve("https://STUDIO.example.com:443/x", server))
    }

    @Test
    fun otherSitesGoToTheBrowser() {
        assertEquals(LinkRoute.Target.Browser("https://evil.example.com/"), LinkRoute.resolve("https://evil.example.com/", server))
        assertEquals(LinkRoute.Target.Browser("http://studio.example.com/"), LinkRoute.resolve("http://studio.example.com/", server))
        assertEquals(LinkRoute.Target.Browser("https://studio.example.com/"), LinkRoute.resolve("https://studio.example.com/", null))
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("javascript:alert(1)", server))
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("", server))
    }

    @Test
    fun studioOwnScheme() {
        assertEquals(LinkRoute.Target.InApp("https://studio.example.com/#/hermes/session/s-1"), LinkRoute.resolve("studio-own://chat/s-1", "$server/"))
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("studio-own://chat/..%2F..%2Fadmin", server))
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("studio-own://chat/s-1", null))
        assertEquals(
            LinkRoute.Target.InApp("https://studio.example.com/#/hermes/connections?tab=omi"),
            LinkRoute.resolve("studio-own://open?url=https%3A%2F%2Fstudio.example.com%2F%23%2Fhermes%2Fconnections%3Ftab%3Domi", server),
        )
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("studio-own://open?url=https%3A%2F%2Fevil.example.com%2F", server))
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("studio-own://open?url=studio-own%3A%2F%2Fchat%2Fx", server))
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("studio-own://settings", server))
    }

    @Test
    fun pairingLinksWorkWithOrWithoutAServer() {
        val expected = LinkRoute.Target.Pair(ApprovalAlerts.PairLink("https://studio.example.com", "ABCD-EF23"))
        assertEquals(expected, LinkRoute.resolve("studio-own://pair?server=https%3A%2F%2Fstudio.example.com&code=ABCD-EF23", server))
        assertEquals(expected, LinkRoute.resolve("studio-own://pair?server=https%3A%2F%2Fstudio.example.com&code=ABCD-EF23", null))
        assertEquals(LinkRoute.Target.Ignore, LinkRoute.resolve("studio-own://pair?code=bad", server))
    }
}
