package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-side tests for answering system ANR / crash dialogs mid-test
 * (PILOT-977): which button each owner gets, when a dialog is left alone, and
 * what is reported. The screen is a fake whose dialogs go away when answered.
 */
class SystemDialogAnswererTest {
    private class FakeClock(
        var nowMs: Long = 0,
    ) : GuardClock {
        override fun now(): Long = nowMs

        override fun sleep(ms: Long) {
            nowMs += ms
        }
    }

    /** One dialog on the fake screen; [onClick] decides what a tap does. */
    private inner class Dialog(
        val title: String?,
        val anr: Boolean,
        var stays: Boolean = false,
    ) {
        val clicks = mutableListOf<SystemDialogButton>()

        fun asSeen() =
            SystemErrorDialog(
                title = title,
                buttons = if (anr) setOf(SystemDialogButton.CLOSE, SystemDialogButton.WAIT) else setOf(SystemDialogButton.CLOSE),
                click = { button ->
                    clicks.add(button)
                    if (!stays) dialogs.remove(this)
                    true
                },
            )
    }

    private val dialogs = mutableListOf<Dialog>()
    private var windowDump: String? = ""
    private var dumps = 0
    private val clock = FakeClock()

    /** Reads of whether an app window is back, and how many say no first. */
    private var appWindowReads = 0
    private var appWindowMissingReads = 0

    private val screen =
        object : SystemDialogScreen {
            override fun errorDialogs() = dialogs.map { it.asSeen() }

            override fun windowDump(): String? {
                dumps++
                return windowDump
            }

            override fun appWindowShown(): Boolean = ++appWindowReads > appWindowMissingReads
        }

    private fun answerer(target: String? = APP) = SystemDialogAnswerer(screen, target, clock, wallClock = { 1_000 })

    private fun anrWindow(process: String) = "  Window #9 Window{abc123 u0 Application Not Responding: $process}:\n"

    private fun crashWindow(process: String) = "  Window #9 Window{abc124 u0 Application Error: $process}:\n"

    @Test
    fun `nothing on screen costs no dumpsys and answers nothing`() {
        val a = answerer()
        assertFalse(a.answer())
        assertEquals(0, dumps)
        assertTrue(a.takeEvents().isEmpty())
    }

    @Test
    fun `another app's ANR is closed and reported as foreign`() {
        val d = Dialog("Pixel Launcher isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER)
        val a = answerer()
        assertTrue(a.answer())
        assertEquals(listOf(SystemDialogButton.CLOSE), d.clicks)
        val event = a.takeEvents().single()
        assertEquals("Pixel Launcher isn't responding", event.title)
        assertEquals(LAUNCHER, event.owner)
        assertFalse(event.ownedByTarget)
        assertEquals(SystemDialogKind.ANR, event.kind)
        assertEquals(SystemDialogButton.CLOSE, event.button)
        assertEquals(1_000, event.timestampMs)
        // Taken once.
        assertTrue(a.takeEvents().isEmpty())
    }

    @Test
    fun `after answering, it waits for the app's window to be readable again`() {
        // On a device the app's window comes back to the accessibility tree a
        // moment after the dialog leaves; a lookup right then found nothing.
        Dialog("Pixel Launcher isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER)
        appWindowMissingReads = 3
        val a = answerer()
        assertTrue(a.answer())
        assertEquals(4, appWindowReads)
    }

    @Test
    fun `the wait for the app's window is bounded`() {
        Dialog("Pixel Launcher isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER)
        appWindowMissingReads = Int.MAX_VALUE
        val before = clock.nowMs
        assertTrue(answerer().answer())
        assertTrue(clock.nowMs - before <= SystemDialogAnswerer.GONE_TIMEOUT_MS + SystemDialogAnswerer.APP_WINDOW_TIMEOUT_MS + 200)
    }

    @Test
    fun `nothing answered, nothing waited for`() {
        assertFalse(answerer().answer())
        assertEquals(0, appWindowReads)
    }

    @Test
    fun `another app's crash dialog is closed`() {
        val d = Dialog("Gallery keeps stopping", anr = false).also(dialogs::add)
        windowDump = crashWindow("com.example.gallery")
        val a = answerer()
        assertTrue(a.answer())
        assertEquals(listOf(SystemDialogButton.CLOSE), d.clicks)
        assertEquals(SystemDialogKind.CRASH, a.takeEvents().single().kind)
    }

    @Test
    fun `the app under test's ANR is waited out and reported as the app's`() {
        val d = Dialog("Test App isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(APP)
        val a = answerer()
        assertTrue(a.answer())
        assertEquals(listOf(SystemDialogButton.WAIT), d.clicks)
        val event = a.takeEvents().single()
        assertTrue(event.ownedByTarget)
        assertEquals(APP, event.owner)
        assertEquals(SystemDialogButton.WAIT, event.button)
    }

    @Test
    fun `the app's secondary process counts as the app`() {
        val d = Dialog("Test App isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow("$APP:remote")
        assertTrue(answerer().answer())
        assertEquals(listOf(SystemDialogButton.WAIT), d.clicks)
    }

    @Test
    fun `the app under test's crash dialog is left alone and not reported`() {
        val d = Dialog("Test App keeps stopping", anr = false).also(dialogs::add)
        windowDump = crashWindow(APP)
        val a = answerer()
        assertFalse(a.answer())
        assertTrue(d.clicks.isEmpty())
        assertTrue(a.takeEvents().isEmpty())
    }

    @Test
    fun `system_server's ANR is waited out, never closed`() {
        val d = Dialog("Process system isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow("system")
        val a = answerer()
        assertTrue(a.answer())
        assertEquals(listOf(SystemDialogButton.WAIT), d.clicks)
        assertFalse(a.takeEvents().single().ownedByTarget)
    }

    @Test
    fun `a dialog whose owner cannot be read is left alone`() {
        val d = Dialog("Something isn't responding", anr = true).also(dialogs::add)
        windowDump = null
        val a = answerer()
        assertFalse(a.answer())
        assertTrue(d.clicks.isEmpty())
        windowDump = "  Window #1 Window{1 u0 StatusBar}:\n"
        assertFalse(a.answer())
        assertTrue(d.clicks.isEmpty())
    }

    @Test
    fun `when the window list names the app among several owners, the dialog is treated as the app's`() {
        val d = Dialog("Some app isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER) + anrWindow(APP)
        val a = answerer()
        assertTrue(a.answer())
        assertEquals(listOf(SystemDialogButton.WAIT), d.clicks)
        val event = a.takeEvents().single()
        assertTrue(event.ownedByTarget)
        assertEquals(APP, event.owner)
    }

    @Test
    fun `several foreign owners close the dialog without naming one`() {
        Dialog("Some app isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER) + anrWindow("com.google.android.gms")
        val a = answerer()
        assertTrue(a.answer())
        assertNull(a.takeEvents().single().owner)
    }

    @Test
    fun `an owner of the other dialog kind does not count`() {
        // A crash window for the launcher says nothing about whose ANR this is.
        val d = Dialog("Some app isn't responding", anr = true).also(dialogs::add)
        windowDump = crashWindow(LAUNCHER)
        assertFalse(answerer().answer())
        assertTrue(d.clicks.isEmpty())
    }

    @Test
    fun `without a target package every owned dialog is another app's`() {
        val d = Dialog("Test App isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(APP)
        assertTrue(answerer(target = null).answer())
        assertEquals(listOf(SystemDialogButton.CLOSE), d.clicks)
    }

    @Test
    fun `stacked dialogs are answered in turn`() {
        val first = Dialog("Google Play services isn't responding", anr = true).also(dialogs::add)
        val second = Dialog("Pixel Launcher isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER)
        val a = answerer()
        assertTrue(a.answer())
        assertEquals(1, first.clicks.size)
        assertEquals(1, second.clicks.size)
        assertEquals(2, a.takeEvents().size)
    }

    @Test
    fun `a dialog that keeps coming back is answered at most three times per command`() {
        val d = Dialog("Pixel Launcher isn't responding", anr = true, stays = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER)
        val a = answerer()
        a.startCommand()
        assertTrue(a.answer())
        assertFalse(a.answer())
        assertEquals(3, d.clicks.size)
        assertEquals(3, a.takeEvents().size)
        // The next command gets a fresh allowance.
        a.startCommand()
        assertTrue(a.answer())
        assertEquals(6, d.clicks.size)
    }

    @Test
    fun `a dialog with no button for the chosen answer falls back to the other`() {
        // A foreign ANR dialog drawn without Close app: Wait.
        val d = Dialog("Pixel Launcher isn't responding", anr = true).also(dialogs::add)
        windowDump = anrWindow(LAUNCHER)
        val seen =
            SystemErrorDialog("Pixel Launcher isn't responding", setOf(SystemDialogButton.WAIT)) { b ->
                d.clicks.add(b)
                dialogs.remove(d)
                true
            }
        val only =
            object : SystemDialogScreen {
                override fun errorDialogs() = if (dialogs.isEmpty()) emptyList() else listOf(seen)

                override fun windowDump() = windowDump
            }
        assertTrue(SystemDialogAnswerer(only, APP, clock, wallClock = { 0 }).answer())
        assertEquals(listOf(SystemDialogButton.WAIT), d.clicks)
    }

    @Test
    fun `a failed click stops answering`() {
        windowDump = anrWindow(LAUNCHER)
        val seen = SystemErrorDialog("Pixel Launcher isn't responding", setOf(SystemDialogButton.CLOSE, SystemDialogButton.WAIT)) { false }
        val only =
            object : SystemDialogScreen {
                override fun errorDialogs() = listOf(seen)

                override fun windowDump() = windowDump
            }
        val a = SystemDialogAnswerer(only, APP, clock, wallClock = { 0 })
        assertFalse(a.answer())
        assertTrue(a.takeEvents().isEmpty())
    }

    @Test
    fun `a screen read that throws answers nothing`() {
        val broken =
            object : SystemDialogScreen {
                override fun errorDialogs(): List<SystemErrorDialog> = throw IllegalStateException("no UiAutomation")

                override fun windowDump(): String? = null
            }
        assertFalse(SystemDialogAnswerer(broken, APP, clock, wallClock = { 0 }).answer())
    }

    @Test
    fun `the event queue is bounded, keeping the newest`() {
        val a = answerer()
        windowDump = anrWindow(LAUNCHER)
        repeat(SystemDialogAnswerer.MAX_EVENTS + 5) { i ->
            dialogs.add(Dialog("Dialog $i isn't responding", anr = true))
            a.startCommand()
            a.answer()
        }
        val events = a.takeEvents()
        assertEquals(SystemDialogAnswerer.MAX_EVENTS, events.size)
        assertEquals("Dialog ${SystemDialogAnswerer.MAX_EVENTS + 4} isn't responding", events.last().title)
    }

    @Test
    fun `owners are read from the window titles`() {
        val dump =
            """
            Window #8 Window{5949593 u0 com.android.settings/com.android.settings.Settings}:
            Window #9 Window{e2a6968 u0 Application Not Responding: com.google.android.apps.nexuslauncher}:
            Window #10 Window{e2a6969 u0 Application Error: com.example.app:remote}:
            """.trimIndent()
        assertEquals(
            listOf(SystemDialogKind.ANR to "com.google.android.apps.nexuslauncher", SystemDialogKind.CRASH to "com.example.app"),
            SystemDialogAnswerer.ownersIn(dump),
        )
    }

    companion object {
        const val APP = "dev.tapsmith.testapp"
        const val LAUNCHER = "com.google.android.apps.nexuslauncher"
    }
}
