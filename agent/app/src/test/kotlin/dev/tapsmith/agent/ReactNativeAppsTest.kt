package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Host-side tests for telling React Native apps apart by their APKs (PILOT-1424). */
class ReactNativeAppsTest {
    private val reactNativeApk =
        sequenceOf("AndroidManifest.xml", "classes.dex", "lib/arm64-v8a/libreactnative.so", "lib/arm64-v8a/libhermes.so")
    private val nativeApk = sequenceOf("AndroidManifest.xml", "classes.dex", "lib/arm64-v8a/libsqlite.so")

    @Test
    fun `React Native's library names are recognised, and nothing else`() {
        assertTrue(ReactNativeApps.isReactNativeLibrary("lib/arm64-v8a/libreactnative.so"))
        assertTrue(ReactNativeApps.isReactNativeLibrary("lib/x86_64/libreactnativejni.so"))
        assertFalse(ReactNativeApps.isReactNativeLibrary("lib/arm64-v8a/libreactnative_extra.so"))
        assertFalse(ReactNativeApps.isReactNativeLibrary("assets/lib/arm64-v8a/libreactnative.so"))
        assertFalse(ReactNativeApps.isReactNativeLibrary("lib/arm64-v8a/libflutter.so"))
    }

    @Test
    fun `pm path output lists every APK`() {
        assertEquals(
            listOf("/data/app/a/base.apk", "/data/app/a/split_config.arm64_v8a.apk"),
            ReactNativeApps.parsePmPath("package:/data/app/a/base.apk\r\npackage:/data/app/a/split_config.arm64_v8a.apk\n"),
        )
        assertEquals(emptyList<String>(), ReactNativeApps.parsePmPath(""))
    }

    @Test
    fun `an app with React Native's library in any of its APKs is React Native, read once`() {
        var reads = 0
        val apps =
            ReactNativeApps(
                apkPathsOf = { listOf("base.apk", "split.apk") },
                entriesOf = { path ->
                    reads++
                    if (path == "split.apk") reactNativeApk else nativeApk
                },
            )
        assertTrue(apps.isReactNative("com.example.rn"))
        assertTrue(apps.isReactNative("com.example.rn"))
        assertEquals(2, reads)
    }

    @Test
    fun `an app without it is not, and that is remembered too`() {
        var lists = 0
        val apps =
            ReactNativeApps(apkPathsOf = {
                lists++
                listOf("base.apk")
            }, entriesOf = { nativeApk })
        assertFalse(apps.isReactNative("com.example.native"))
        assertFalse(apps.isReactNative("com.example.native"))
        assertEquals(1, lists)
    }

    @Test
    fun `an app that cannot be read is not React Native for now, and is asked again`() {
        var lists = 0
        var readable = false
        val apps =
            ReactNativeApps(apkPathsOf = {
                lists++
                listOf("base.apk")
            }, entriesOf = { if (readable) reactNativeApk else throw java.io.IOException("denied") })
        assertFalse(apps.isReactNative("com.example.rn"))
        readable = true
        assertTrue(apps.isReactNative("com.example.rn"))
        assertEquals(2, lists)
    }

    @Test
    fun `no package or no APKs is not React Native`() {
        val apps = ReactNativeApps(apkPathsOf = { emptyList() }, entriesOf = { reactNativeApk })
        assertFalse(apps.isReactNative(null))
        assertFalse(apps.isReactNative(""))
        assertFalse(apps.isReactNative("com.example.gone"))
    }
}
