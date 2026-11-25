package com.ekkostudio.own

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OmiLinkTest {
    private val prod = "com.friend.ios"
    private val dev = "com.friend.ios.dev"

    @Test
    fun linksAreTheDocumentedContract() {
        assertEquals("omi://approvals", OmiLink.uri(OmiLink.Target.APPROVALS))
        assertEquals("omi://tasks", OmiLink.uri(OmiLink.Target.TASKS))
        assertEquals("omi://capture", OmiLink.uri(OmiLink.Target.CAPTURE))
        assertEquals(listOf(prod, dev), OmiLink.PACKAGES)
    }

    @Test
    fun usesTheDeepLinkWhenOmiHandlesItThenItsLauncher() {
        val attempts = OmiLink.attempts(OmiLink.Target.TASKS, installed = { it == prod }, handlesLink = { _, _ -> true })
        assertEquals(listOf(OmiLink.Launch.DeepLink(prod, "omi://tasks"), OmiLink.Launch.App(prod)), attempts)
    }

    @Test
    fun fallsBackToTheLauncherWhileOmiDoesNotHandleTheLink() {
        val asked = mutableListOf<Pair<String, String>>()
        val attempts = OmiLink.attempts(OmiLink.Target.APPROVALS, installed = { it == dev }, handlesLink = { pkg, uri -> asked += pkg to uri; false })
        assertEquals(listOf(OmiLink.Launch.App(dev)), attempts)
        // Only Omi's own package is asked, so another app claiming omi:// is never used.
        assertEquals(listOf(dev to "omi://approvals"), asked)
    }

    @Test
    fun prefersProdOverDevAndIsEmptyWithoutOmi() {
        val both = OmiLink.attempts(OmiLink.Target.CAPTURE, installed = { true }, handlesLink = { pkg, _ -> pkg == dev })
        assertEquals(listOf(OmiLink.Launch.App(prod), OmiLink.Launch.DeepLink(dev, "omi://capture"), OmiLink.Launch.App(dev)), both)
        assertTrue(OmiLink.attempts(OmiLink.Target.CAPTURE, installed = { false }, handlesLink = { _, _ -> true }).isEmpty())
    }
}
