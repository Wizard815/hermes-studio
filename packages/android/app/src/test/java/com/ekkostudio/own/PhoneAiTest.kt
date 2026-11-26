package com.ekkostudio.own

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.ServerSocket

class PhoneAiTest {
    @Test
    fun startAndStopAreTheGuidesCommandsRunInTermuxHome() {
        assertEquals("~/bin/omi-phone-ai.sh", PhoneAi.START.script)
        assertEquals("pkill llama-server; pkill whisper-server; termux-wake-unlock", PhoneAi.STOP.script)
        for (command in listOf(PhoneAi.START, PhoneAi.STOP)) {
            assertEquals(Termux.HOME, command.workdir)
            assertEquals(true, command.background)
            assertArrayEquals(arrayOf("-c", command.script), Termux.extras(command)[Termux.EXTRA_ARGUMENTS] as Array<*>)
        }
    }

    @Test
    fun probesOnlyLocalhost() {
        assertEquals("http://127.0.0.1:8081/health", PhoneAi.CHAT_URL)
        assertEquals("http://127.0.0.1:8080/", PhoneAi.SPEECH_URL)
    }

    @Test
    fun mapsProbeResultsToStates() {
        assertEquals(PhoneAi.State.OFF, PhoneAi.state(null))
        assertEquals(PhoneAi.State.LOADING, PhoneAi.state(503))
        assertEquals(PhoneAi.State.RUNNING, PhoneAi.state(200))
        // Something answers on the port, even if it is not the expected page.
        assertEquals(PhoneAi.State.RUNNING, PhoneAi.state(404))
        assertEquals(PhoneAi.Status(PhoneAi.State.LOADING, PhoneAi.State.OFF), PhoneAi.status(503, null))
    }

    @Test
    fun aClosedPortProbesAsNothingListening() {
        val port = ServerSocket(0).use { it.localPort }
        assertNull(PhoneAi.probe("http://127.0.0.1:$port/health", timeoutMs = 500))
    }

    @Test
    fun mapsTermuxResultsToWhatThePanelShows() {
        assertEquals(PhoneAi.Outcome.Done, PhoneAi.outcome(mapOf("stdout" to "", "exitCode" to 0)))
        assertEquals(PhoneAi.Outcome.Done, PhoneAi.outcome(mapOf("stdout" to null)))
        assertEquals(
            PhoneAi.Outcome.TermuxNotSetUp,
            PhoneAi.outcome(mapOf("error" to "RunCommandService requires `allow-external-apps` property to be set to `true` in `~/.termux/termux.properties` file.")),
        )
        assertEquals(PhoneAi.Outcome.ScriptMissing, PhoneAi.outcome(mapOf("stderr" to "bash: ~/bin/omi-phone-ai.sh: No such file or directory", "exitCode" to 127)))
        assertEquals(PhoneAi.Outcome.Failed("Cancelled on the phone."), PhoneAi.outcome(mapOf("error" to "Cancelled on the phone.")))
        assertEquals(PhoneAi.Outcome.Failed("boom"), PhoneAi.outcome(mapOf("stderr" to "  boom\n", "exitCode" to 2)))
        assertEquals(PhoneAi.Outcome.Failed("Exit code 1"), PhoneAi.outcome(mapOf("stderr" to "", "exitCode" to 1)))
    }
}
