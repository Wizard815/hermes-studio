package com.ekkostudio.own

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApkInstallerTest {
    @Test
    fun recognisesStudioDownloadsOfApks() {
        val url = "https://studio.example.com/api/studio/files/download?path=%2Fworkspace%2Fapp%2Fbuild%2Fapp-debug.apk&token=abc"
        assertTrue(ApkInstaller.isApk(url, null, "application/octet-stream"))
        assertEquals("app-debug.apk", ApkInstaller.fileName(url, null))
        assertTrue(ApkInstaller.isApk("https://x/y", null, "application/vnd.android.package-archive"))
        assertFalse(ApkInstaller.isApk("https://studio.example.com/api/studio/files/download?path=notes.txt", null, "text/plain"))
    }

    @Test
    fun prefersContentDispositionAndSanitisesNames() {
        assertEquals("My_App_1.0.apk", ApkInstaller.fileName("https://x/download", "attachment; filename*=UTF-8''My%20App%201.0.apk"))
        assertEquals("evil.apk", ApkInstaller.fileName("https://x/download", "attachment; filename=\"../../evil.apk\""))
        assertEquals("download.apk", ApkInstaller.fileName("https://x/", null))
    }
}
