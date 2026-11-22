package dev.tapsmith.agent

import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipFile

/**
 * Which apps are React Native apps (PILOT-1424): there, every plain view a
 * touch lands on takes it. React Native hit-tests touches itself, in its root
 * view, and the view the touch lands on is its target unless it is
 * `pointerEvents="none"` — so a bar laid over a list eats a tap on a row under
 * it, though nothing in the bar is clickable. In a native, Compose or Flutter
 * app a view that takes no touches lets them through to what is under it.
 *
 * The accessibility tree cannot tell the two apart (a React Native view
 * reports the class names native ones do), so the app's APKs are looked in:
 * a React Native app ships React Native's native library. Read once per
 * package and remembered for the agent's life: the APK paths come from
 * `pm path` and only the zip's central directory is read.
 */
class ReactNativeApps(
    /** The APK paths of a package (base and splits); empty when unknown. */
    private val apkPathsOf: (String) -> List<String>,
    /** The entry names of the APK at a path; throws when unreadable. */
    private val entriesOf: (String) -> Sequence<String> = ::zipEntries,
    private val log: (String, Throwable?) -> Unit = { _, _ -> },
) {
    private val known = ConcurrentHashMap<String, Boolean>()

    /** Whether [packageName] is a React Native app; false when it cannot be
     *  told (then it is asked again next time, not remembered). */
    fun isReactNative(packageName: String?): Boolean {
        if (packageName.isNullOrEmpty()) return false
        known[packageName]?.let { return it }
        val answer = detect(packageName) ?: return false
        known[packageName] = answer
        return answer
    }

    private fun detect(packageName: String): Boolean? {
        val paths =
            try {
                apkPathsOf(packageName)
            } catch (e: Exception) {
                log("Could not list the APKs of $packageName", e)
                return null
            }
        if (paths.isEmpty()) return null
        var unreadable = false
        for (path in paths) {
            try {
                if (entriesOf(path).any(::isReactNativeLibrary)) return true
            } catch (e: Exception) {
                log("Could not read $path", e)
                unreadable = true
            }
        }
        return if (unreadable) null else false
    }

    companion object {
        /** React Native's core native library, by the names it has shipped
         *  under: `libreactnative.so` (0.76+, merged) and `libreactnativejni.so`
         *  (before). An app with `extractNativeLibs` still lists them in its
         *  APK; a Play install puts them in an ABI split, also listed. */
        private val LIBRARY = Regex("lib/[^/]+/libreactnative(jni)?\\.so")

        fun isReactNativeLibrary(entry: String): Boolean = LIBRARY.matches(entry)

        /** The paths `pm path <package>` prints, one `package:<path>` a line. */
        fun parsePmPath(output: String): List<String> =
            output
                .lineSequence()
                .map { it.trim() }
                .filter { it.startsWith("package:") }
                .map { it.removePrefix("package:") }
                .toList()

        private fun zipEntries(path: String): Sequence<String> =
            ZipFile(path)
                .use { zip ->
                    zip
                        .entries()
                        .asSequence()
                        .map { it.name }
                        .toList()
                }.asSequence()
    }
}
