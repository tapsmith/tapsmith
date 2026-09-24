plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jlleitschuh.gradle.ktlint")
}

val coreKtxVersion = "1.15.0"
val testRunnerVersion = "1.6.2"
val testCoreVersion = "1.6.1"
val uiautomatorVersion = "2.3.0"
val coroutinesVersion = "1.8.1"
val jsonVersion = "20240303"

android {
    namespace = "dev.tapsmith.agent"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.tapsmith.agent"
        minSdk = 21
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

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            kotlin.srcDirs("src/main/kotlin")
        }
        getByName("androidTest") {
            kotlin.srcDirs("src/androidTest/kotlin")
        }
        getByName("test") {
            kotlin.srcDirs("src/test/kotlin")
        }
    }
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
