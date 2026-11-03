package com.ekkostudio.own

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NormalizeUrlTest {
    @Test
    fun acceptsHttpAndHttpsAndTrimsTrailingSlash() {
        assertEquals("https://studio.example.com", MainActivity.normalizeUrl("  https://studio.example.com/ "))
        assertEquals("http://192.168.1.5:8648", MainActivity.normalizeUrl("http://192.168.1.5:8648"))
    }

    @Test
    fun rejectsOtherSchemesAndEmptyHosts() {
        assertNull(MainActivity.normalizeUrl("studio.example.com"))
        assertNull(MainActivity.normalizeUrl("file:///etc/passwd"))
        assertNull(MainActivity.normalizeUrl("javascript:alert(1)"))
        assertNull(MainActivity.normalizeUrl("https://"))
    }
}
