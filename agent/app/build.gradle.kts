plugins {
    id("com.android.application")
    id("org.jlleitschuh.gradle.ktlint")
}

val coreKtxVersion = "1.19.1"
val testRunnerVersion = "1.7.0"
val testCoreVersion = "1.7.0"
val uiautomatorVersion = "2.4.0"
val coroutinesVersion = "1.11.0"
val jsonVersion = "20240303"

android {
    namespace = "dev.tapsmith.agent"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.tapsmith.agent"
        // 24 (Android 7): from here on /proc hides other apps' processes, so
        // no app can read the agent token from the `am instrument -e token`
        // command line (PILOT-969). Tapsmith documents API 26+ anyway.
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// The host tests replay the SDK's conformance fixtures (TextRegexTest,
// LocatorConformanceTest): declare them, so changing a fixture re-runs the
// tests instead of leaving the task up to date.
tasks.withType<Test>().configureEach {
    inputs
        .dir(rootProject.file("../packages/tapsmith/src/__tests__/fixtures"))
        .withPropertyName("sdkConformanceFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

dependencies {
    implementation("androidx.core:core-ktx:$coreKtxVersion")
    implementation("androidx.test:runner:$testRunnerVersion")
    implementation("androidx.test:core:$testCoreVersion")
    implementation("androidx.test.uiautomator:uiautomator:$uiautomatorVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:$coroutinesVersion")
    implementation("org.json:json:$jsonVersion")

    androidTestImplementation("androidx.test:runner:$testRunnerVersion")
    androidTestImplementation("androidx.test:core:$testCoreVersion")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:$uiautomatorVersion")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:$jsonVersion")
}
