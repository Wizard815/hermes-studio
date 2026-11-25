package com.ekkostudio.own

/**
 * Opening the Omi app. Studio Own sends `omi://approvals`, `omi://tasks` and
 * `omi://capture` to Omi's own package only (never to whichever app claims the
 * scheme); while Omi does not handle a link yet, it opens Omi's main screen.
 * See docs/omi.md for the contract.
 */
object OmiLink {
    /** Omi's application ids: the prod flavor, then the dev flavor (app/android/app/build.gradle). */
    val PACKAGES = listOf("com.friend.ios", "com.friend.ios.dev")
    const val SCHEME = "omi"

    enum class Target(val host: String) {
        APPROVALS("approvals"),
        TASKS("tasks"),
        CAPTURE("capture"),
    }

    fun uri(target: Target): String = "$SCHEME://${target.host}"

    sealed interface Launch {
        val packageName: String

        /** `ACTION_VIEW` of [uri], limited to [packageName]. */
        data class DeepLink(override val packageName: String, val uri: String) : Launch

        /** Omi's launcher activity. */
        data class App(override val packageName: String) : Launch
    }

    /**
     * What to try, in order, until one starts: for each installed Omi, its deep
     * link when that package handles it, then its launcher activity. Empty when
     * Omi is not installed.
     */
    fun attempts(target: Target, installed: (String) -> Boolean, handlesLink: (packageName: String, uri: String) -> Boolean): List<Launch> {
        val link = uri(target)
        return PACKAGES.filter(installed).flatMap { pkg ->
            listOfNotNull(if (handlesLink(pkg, link)) Launch.DeepLink(pkg, link) else null, Launch.App(pkg))
        }
    }
}
