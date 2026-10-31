package dev.tapsmith.agent

/** A system dialog's answer buttons (AOSP `android:id/aerr_*`). */
enum class SystemDialogButton(
    val resourceId: String,
    /** How the button is named in reports. */
    val label: String,
) {
    CLOSE("android:id/aerr_close", "Close app"),
    WAIT("android:id/aerr_wait", "Wait"),
}

/** "… isn't responding" (ANR) or "… keeps stopping" (crash). */
enum class SystemDialogKind { ANR, CRASH }

/** A system ANR / crash dialog on screen right now. */
class SystemErrorDialog(
    /** The dialog's title ("Pixel Launcher isn't responding"), when known. */
    val title: String?,
    /** The answer buttons it shows. */
    val buttons: Set<SystemDialogButton>,
    /** Press [SystemDialogButton]; false when the press failed. */
    val click: (SystemDialogButton) -> Boolean,
) {
    /** Only an ANR dialog offers Wait. */
    val kind: SystemDialogKind get() = if (SystemDialogButton.WAIT in buttons) SystemDialogKind.ANR else SystemDialogKind.CRASH
}

/** The device, as far as answering system dialogs needs it. */
interface SystemDialogScreen {
    /** System ANR / crash dialogs on screen, topmost first. */
    fun errorDialogs(): List<SystemErrorDialog>

    /** `dumpsys window windows`, or null when it cannot be read. */
    fun windowDump(): String?
}

/** One dialog [SystemDialogAnswerer] answered. */
data class SystemDialogEvent(
    val title: String?,
    /** The owning process, when the window list names exactly one (or it is the app's). */
    val owner: String?,
    /** The app under test owns it (its own ANR, waited out). */
    val ownedByTarget: Boolean,
    val kind: SystemDialogKind,
    val button: SystemDialogButton,
    /** Wall-clock time it was answered (ms since epoch). */
    val timestampMs: Long,
)

/**
 * Answers system ANR / crash dialogs that come up while a test runs
 * (PILOT-977). Such a dialog takes focus and sits over the app: taps on the
 * app are refused as covered until the action times out, and key input goes
 * to the dialog. The preflight clears them only between tests.
 *
 * The dialog's nodes all belong to `android`; only its window title in
 * `dumpsys window` (`Application Not Responding: <process>` /
 * `Application Error: <process>`) names the owner, so the window list is read
 * only once a dialog is on screen. Then:
 *
 *  - another app's dialog: **Close app** (kills the hung process; the system
 *    restarts it clean, where Wait leaves it hung to come back in seconds);
 *  - the app under test's ANR: **Wait** — it may only be slow — reported, so
 *    the test result shows it (a real ANR in the app is a finding);
 *  - the app under test's crash dialog: left up. The app is gone, so the
 *    action fails (its element is not found), the failure screenshot and
 *    trace show the dialog, and the next preflight recovers the session;
 *  - system_server's ANR: Wait, never Close (that restarts the runtime);
 *  - an owner the window list does not name: left up, as it may be the app's.
 *
 * At most [MAX_PER_COMMAND] answers per command, so a dialog that keeps
 * coming back cannot hold a command. Answered dialogs are kept (the newest
 * [MAX_EVENTS]) until the daemon takes them for the test's report.
 */
class SystemDialogAnswerer(
    private val screen: SystemDialogScreen,
    /** The app under test (the daemon's `targetPackage`), if known. */
    private val targetPackage: String?,
    private val clock: GuardClock,
    private val wallClock: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    companion object {
        /** Dialogs answered per command (Speedrun answers up to 3 per read). */
        const val MAX_PER_COMMAND = 3

        /** Events kept for the daemon to take; older ones are dropped. */
        const val MAX_EVENTS = 32

        /** How long an answered dialog gets to leave the screen. */
        const val GONE_TIMEOUT_MS = 2_000L
        private const val GONE_POLL_MS = 100L

        /** system_server's process name in a dialog window's title. */
        private const val SYSTEM_SERVER = "system"

        private val OWNER_TITLE =
            Regex("""Window\{[0-9a-f]+ u\d+ (Application Not Responding|Application Error): ([^\s}:]+)(?::[^\s}]*)?\}""")

        /**
         * The error-dialog windows `dumpsys window windows` lists, as (kind,
         * process) in listed order; a `:service` suffix is dropped so an
         * app's secondary process reads as the app.
         */
        fun ownersIn(dump: String): List<Pair<SystemDialogKind, String>> =
            OWNER_TITLE
                .findAll(dump)
                .map { m ->
                    val kind = if (m.groupValues[1] == "Application Error") SystemDialogKind.CRASH else SystemDialogKind.ANR
                    kind to m.groupValues[2]
                }.distinct()
                .toList()
    }

    private val events = ArrayDeque<SystemDialogEvent>()
    private var answeredThisCommand = 0

    /** A new command: it gets a fresh allowance of answers. */
    @Synchronized
    fun startCommand() {
        answeredThisCommand = 0
    }

    /**
     * Answer the system dialogs on screen, topmost first, until none is left
     * that may be answered. True when at least one was. Never throws (except
     * for a cancelled command's sleep): a failure leaves the screen as it was.
     */
    @Synchronized
    fun answer(): Boolean {
        var answered = false
        while (answeredThisCommand < MAX_PER_COMMAND) {
            val dialog = topDialog() ?: break
            if (!answerOne(dialog)) break
            answered = true
            answeredThisCommand++
            waitUntilGone(dialog)
        }
        return answered
    }

    /** The answered dialogs since the last call, oldest first. */
    @Synchronized
    fun takeEvents(): List<SystemDialogEvent> = events.toList().also { events.clear() }

    private fun topDialog(): SystemErrorDialog? =
        try {
            screen.errorDialogs().firstOrNull()
        } catch (e: Exception) {
            log("could not read the windows for system dialogs: ${e.message}")
            null
        }

    /** Answer [dialog] when its owner allows; false when it is left up. */
    private fun answerOne(dialog: SystemErrorDialog): Boolean {
        val dump =
            try {
                screen.windowDump()
            } catch (e: Exception) {
                null
            }
        // Only windows of the dialog's own kind can be its owner.
        val owners =
            dump
                ?.let(::ownersIn)
                .orEmpty()
                .filter { it.first == dialog.kind }
                .map { it.second }
        if (owners.isEmpty()) {
            log("system dialog '${dialog.title}' has no owner in the window list; leaving it")
            return false
        }
        val target = targetPackage?.takeIf { it.isNotEmpty() }
        // Ambiguous with the app among the owners: it may be the app's.
        val ownedByTarget = target != null && target in owners
        val owner = if (ownedByTarget) target else owners.singleOrNull()
        val preferred =
            when {
                ownedByTarget && dialog.kind == SystemDialogKind.CRASH -> {
                    log("the app under test's crash dialog '${dialog.title}' is left up")
                    return false
                }
                ownedByTarget || SYSTEM_SERVER in owners -> listOf(SystemDialogButton.WAIT)
                else -> listOf(SystemDialogButton.CLOSE, SystemDialogButton.WAIT)
            }
        val button = preferred.firstOrNull { it in dialog.buttons } ?: return false
        CommandCancellation.checkpoint()
        val clicked =
            try {
                dialog.click(button)
            } catch (e: Exception) {
                log("pressing ${button.label} on '${dialog.title}' failed: ${e.message}")
                false
            }
        if (!clicked) return false
        log("answered system dialog '${dialog.title}' (${owner ?: owners.joinToString()}) with ${button.label}")
        if (events.size >= MAX_EVENTS) events.removeFirst()
        events.addLast(SystemDialogEvent(dialog.title, owner, ownedByTarget, dialog.kind, button, wallClock()))
        return true
    }

    /** Bounded poll for [dialog] to leave the screen; best effort. */
    private fun waitUntilGone(dialog: SystemErrorDialog) {
        val deadline = clock.now() + GONE_TIMEOUT_MS
        while (clock.now() < deadline) {
            val still =
                try {
                    screen.errorDialogs().any { it.title == dialog.title }
                } catch (e: Exception) {
                    false
                }
            if (!still) return
            clock.sleep(GONE_POLL_MS)
        }
    }
}
