package com.ekkostudio.own

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareIntentTest {
    @Test
    fun sharedLinkWithItsPageTitle() {
        val shared = ShareIntent.parse(ShareIntent.ACTION_SEND, "text/plain", "https://example.com/a", "Example page", emptyList())
        assertEquals(ShareIntent.Shared("Example page\nhttps://example.com/a", emptyList()), shared)
        // A text that already has the title is kept as it is.
        assertEquals("Example page https://x", ShareIntent.composeText("Example page", " Example page https://x "))
    }

    @Test
    fun imagesOnlyFromContentProvidersAndAtMostFour() {
        val streams = listOf("content://a/1", "file:///data/data/com.ekkostudio.own/x", "content://a/2", "content://a/1", "content://a/3", "content://a/4", "content://a/5")
        val shared = ShareIntent.parse(ShareIntent.ACTION_SEND_MULTIPLE, "image/*", null, null, streams)!!
        assertEquals(listOf("content://a/1", "content://a/2", "content://a/3", "content://a/4"), shared.imageUris)
        assertEquals("", shared.text)
        // A text share never attaches streams.
        assertEquals(emptyList<String>(), ShareIntent.parse(ShareIntent.ACTION_SEND, "text/plain", "hi", null, listOf("content://a/1"))!!.imageUris)
    }

    @Test
    fun nothingToShare() {
        assertNull(ShareIntent.parse("android.intent.action.VIEW", "text/plain", "hi", null, emptyList()))
        assertNull(ShareIntent.parse(ShareIntent.ACTION_SEND, "text/plain", "   ", null, emptyList()))
        assertNull(ShareIntent.parse(ShareIntent.ACTION_SEND, "application/pdf", null, null, listOf("content://a/1")))
    }

    @Test
    fun imageTypesAndNames() {
        assertTrue(ShareIntent.isImageType("image/png"))
        assertTrue(ShareIntent.isImageType("image/svg+xml"))
        assertFalse(ShareIntent.isImageType("text/html"))
        assertFalse(ShareIntent.isImageType(null))
        assertEquals("a_b.png", ShareIntent.safeName("a/b.png", "image/png"))
        assertEquals("shared.jpeg", ShareIntent.safeName(null, "image/jpeg"))
        assertEquals("shared.svg", ShareIntent.safeName(" ", "image/svg+xml"))
    }

    @Test
    fun pageScriptCarriesModeTextAndBase64Images() {
        val script = ShareIntent.pageScript(ShareIntent.Mode.CURRENT_CHAT, "Look \"here\"", listOf(ShareIntent.Image("p.png", "image/png", byteArrayOf(1, 2, 3))))
        assertTrue(script.startsWith("window.__studioOwnShare = {"))
        assertTrue(script.endsWith("window.dispatchEvent(new Event('studio-own-share'));"))
        val json = JSONObject(script.removePrefix("window.__studioOwnShare = ").substringBefore("; window.dispatchEvent"))
        assertEquals("current", json.getString("mode"))
        assertEquals("Look \"here\"", json.getString("text"))
        val file = json.getJSONArray("files").getJSONObject(0)
        assertEquals("p.png", file.getString("name"))
        assertEquals("AQID", file.getString("data"))
    }
}
