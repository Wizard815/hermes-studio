package com.ekkostudio.own

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle

/**
 * Termux's RUN_COMMAND intent (https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent).
 * Termux only accepts it when the person has set `allow-external-apps = true`
 * in ~/.termux/termux.properties and granted this app the RUN_COMMAND permission.
 */
object Termux {
    const val PACKAGE = "com.termux"
    const val PERMISSION = "com.termux.permission.RUN_COMMAND"
    private const val SERVICE = "com.termux.app.RunCommandService"
    private const val ACTION = "com.termux.RUN_COMMAND"
    const val PREFIX = "/data/data/com.termux/files/usr"
    const val HOME = "/data/data/com.termux/files/home"
    const val BASH = "$PREFIX/bin/bash"

    const val EXTRA_PATH = "com.termux.RUN_COMMAND_PATH"
    const val EXTRA_ARGUMENTS = "com.termux.RUN_COMMAND_ARGUMENTS"
    const val EXTRA_WORKDIR = "com.termux.RUN_COMMAND_WORKDIR"
    const val EXTRA_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND"
    const val EXTRA_SESSION_ACTION = "com.termux.RUN_COMMAND_SESSION_ACTION"
    const val EXTRA_COMMAND_LABEL = "com.termux.RUN_COMMAND_COMMAND_LABEL"
    const val EXTRA_PENDING_INTENT = "com.termux.RUN_COMMAND_PENDING_INTENT"

    /** Where Termux puts the outcome in the PendingIntent it fires back. */
    const val RESULT_BUNDLE = "result"

    const val MAX_COMMAND_LENGTH = 8_000

    /** A command as Studio sends it, already checked. */
    data class Command(val script: String, val workdir: String, val background: Boolean)

    /** Validates what a Studio page asked for. Returns null when it cannot be run. */
    fun command(script: String?, workdir: String?, background: Boolean): Command? {
        val text = script?.trim().orEmpty()
        if (text.isEmpty() || text.length > MAX_COMMAND_LENGTH) return null
        val dir = workdir?.trim().orEmpty().ifEmpty { HOME }
        // Termux resolves the working directory inside its own storage; keep it there.
        if (!dir.startsWith("/data/data/com.termux/files/") && !dir.startsWith("/sdcard") && !dir.startsWith("/storage/")) return null
        if (dir.contains("..")) return null
        return Command(text, dir, background)
    }

    /** The extras of a RUN_COMMAND intent: bash -c <script>. */
    fun extras(command: Command): Map<String, Any> = linkedMapOf(
        EXTRA_PATH to BASH,
        EXTRA_ARGUMENTS to arrayOf("-c", command.script),
        EXTRA_WORKDIR to command.workdir,
        EXTRA_BACKGROUND to command.background,
        // "0": open a new session and bring Termux to the front.
        EXTRA_SESSION_ACTION to "0",
        EXTRA_COMMAND_LABEL to "Studio",
    )

    fun isInstalled(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    fun intent(command: Command, result: PendingIntent?): Intent = Intent(ACTION).apply {
        setClassName(PACKAGE, SERVICE)
        for ((key, value) in extras(command)) {
            when (value) {
                is String -> putExtra(key, value)
                is Boolean -> putExtra(key, value)
                is Array<*> -> putExtra(key, value.map { it.toString() }.toTypedArray())
            }
        }
        if (result != null) putExtra(EXTRA_PENDING_INTENT, result)
    }

    /** Starts the command. Called while Studio is on screen, so a plain service start is allowed. */
    fun start(context: Context, command: Command, result: PendingIntent?) {
        context.startService(intent(command, result))
    }

    /** Turns Termux's result bundle into the fields the Studio page shows. */
    fun result(bundle: Bundle?): Map<String, Any?> {
        if (bundle == null) return mapOf("error" to "Termux did not report a result")
        val err = bundle.getInt("err", -1)
        val errmsg = bundle.getString("errmsg")
        return linkedMapOf(
            "stdout" to bundle.getString("stdout"),
            "stderr" to bundle.getString("stderr"),
            "exitCode" to if (bundle.containsKey("exitCode")) bundle.getInt("exitCode") else null,
            // err is -1 (Activity.RESULT_OK) when Termux itself succeeded.
            "error" to if (err != -1 && !errmsg.isNullOrBlank()) errmsg else null,
        )
    }
}
