package com.ekkostudio.own

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeTest {
    @Test
    fun originRuleIsSchemeHostAndNonDefaultPort() {
        assertEquals("https://studio.example.com", StudioBridge.originRule("https://Studio.Example.com/hermes/chat"))
        assertEquals("http://192.168.1.5:8648", StudioBridge.originRule("http://192.168.1.5:8648"))
        assertEquals("https://studio.example.com", StudioBridge.originRule("https://studio.example.com:443/"))
        assertNull(StudioBridge.originRule("file:///sdcard/index.html"))
        assertNull(StudioBridge.originRule("not a url"))
    }

    @Test
    fun termuxRequestsRunBashInTermuxHome() {
        val request = StudioBridge.parse("""{"type":"termux.run","command":"pkg install android-tools","workdir":"","background":true}""")
        val command = (request as StudioBridge.Request.RunInTermux).command
        assertEquals(Termux.HOME, command.workdir)
        val extras = Termux.extras(command)
        assertEquals(Termux.BASH, extras[Termux.EXTRA_PATH])
        assertArrayEquals(arrayOf("-c", "pkg install android-tools"), extras[Termux.EXTRA_ARGUMENTS] as Array<*>)
        assertEquals(true, extras[Termux.EXTRA_BACKGROUND])
    }

    @Test
    fun rejectsEmptyOversizedAndEscapingRequests() {
        assertNull(StudioBridge.parse("""{"type":"termux.run","command":"   "}"""))
        assertNull(StudioBridge.parse("""{"type":"termux.run","command":"${"x".repeat(Termux.MAX_COMMAND_LENGTH + 1)}"}"""))
        assertNull(StudioBridge.parse("""{"type":"termux.run","command":"ls","workdir":"/data/data/com.termux/files/../../com.other"}"""))
        assertNull(StudioBridge.parse("""{"type":"termux.run","command":"ls","workdir":"/system"}"""))
        assertNull(StudioBridge.parse("""{"type":"shell","command":"ls"}"""))
        assertNull(StudioBridge.parse("not json"))
    }

    @Test
    fun theInjectedApiOnlyPostsToThePort() {
        val script = StudioBridge.documentStartScript(termuxInstalled = true)
        assertTrue(script.contains("window.${StudioBridge.PORT_NAME}"))
        assertTrue(script.contains("return true;"))
        assertTrue(script.contains("studio-own:termux-result"))
        assertTrue(script.contains("openOmiPanel"))
    }

    @Test
    fun omiPanelRequestsNeedNoArguments() {
        assertEquals(StudioBridge.Request.OmiPanel, StudioBridge.parse("""{"type":"omi.panel"}"""))
        assertEquals(StudioBridge.Request.OmiPanel, StudioBridge.parse("""{"type":"omi.panel","command":"rm -rf ~"}"""))
    }

    @Test
    fun approvalAlertMessagesFromThePage() {
        assertEquals(StudioBridge.Request.AlertsStatus, StudioBridge.parse("""{"type":"alerts.status"}"""))
        assertEquals(StudioBridge.Request.AlertsPair("ABCD-EF23", "Pixel 8"), StudioBridge.parse("""{"type":"alerts.pair","code":"abcd ef23","name":" Pixel 8 "}"""))
        assertNull(StudioBridge.parse("""{"type":"alerts.pair","code":"nope"}"""))
        assertEquals(StudioBridge.Request.AlertsMode("saver"), StudioBridge.parse("""{"type":"alerts.mode","mode":"saver"}"""))
        assertNull(StudioBridge.parse("""{"type":"alerts.mode","mode":"always"}"""))
        assertEquals(StudioBridge.Request.AlertsUnpair, StudioBridge.parse("""{"type":"alerts.unpair"}"""))
        val script = StudioBridge.documentStartScript(termuxInstalled = false)
        assertTrue(script.contains("approvalAlerts"))
        assertTrue(script.contains("studio-own:alerts"))
    }
}
