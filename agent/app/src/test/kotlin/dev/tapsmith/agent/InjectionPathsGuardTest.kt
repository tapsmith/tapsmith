package dev.tapsmith.agent

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every input event the agent makes must go through [GestureInjector] and
 * [UiAutomationInputSink] (PILOT-789): UiAutomator's own gestures and the
 * public two-argument UiAutomation.injectInputEvent wait up to ~5 s on window
 * animations around each press and release. This scans the agent's sources so
 * a new UiDevice/UiObject2 gesture call fails here rather than on a slow CI
 * runner months later.
 */
class InjectionPathsGuardTest {
    private val sourceDir = File("src/main/kotlin/dev/tapsmith/agent")

    /** The only files allowed to inject. */
    private val injectors = setOf("GestureInjector.kt", "UiAutomationInputSink.kt")

    private val forbidden =
        listOf(
            // UiDevice gestures and keys
            Regex(
                """\bdevice\.(click|swipe|drag|pressKeyCode|pressBack|pressHome|pressEnter|pressDelete|pressMenu|pressSearch|pressRecentApps|pressDPad\w*)\(""",
            ),
            // UiObject2 gestures
            Regex("""\.(click|longClick|swipe|scroll|fling|drag|pinchOpen|pinchClose)\(\s*\)"""),
            Regex(
                """\.(swipe|scroll|fling|drag|pinchOpen|pinchClose|longClick)\((dir|direction|Direction|percent|android\.graphics\.Point)""",
            ),
            Regex("""\.scrollUntil\("""),
            // Direct injection
            Regex("""\binjectInputEvent\("""),
            Regex("""\bsendPointerSync\(|\bsendKeySync\(|\bsendKeyDownUpSync\("""),
        )

    @Test
    fun `no source outside the injector makes input events itself`() {
        assertTrue("run from the agent's app module: $sourceDir not found", sourceDir.isDirectory)
        val offenders =
            sourceDir
                .walkTopDown()
                .filter { it.isFile && it.extension == "kt" && it.name !in injectors }
                .flatMap { file ->
                    file.readLines().withIndex().mapNotNull { (i, raw) ->
                        val line = raw.substringBefore("//").trim()
                        if (line.startsWith("*") || line.startsWith("/*")) return@mapNotNull null
                        if (forbidden.any { it.containsMatchIn(line) }) "${file.name}:${i + 1}: ${raw.trim()}" else null
                    }
                }.toList()
        assertTrue(
            "These inject input outside GestureInjector, so they wait on window animations (PILOT-789):\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty(),
        )
    }
}
