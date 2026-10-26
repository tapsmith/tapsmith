plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP 9 compiles Kotlin itself (built-in Kotlin), so :app no longer applies
    // this plugin. Declaring it here only pins the Kotlin Gradle plugin AGP
    // uses above the version AGP bundles.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0" apply false
}
