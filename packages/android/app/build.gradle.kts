plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ekkostudio.own"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ekkostudio.own"
        minSdk = 26
        targetSdk = 34
        versionCode = 5
        versionName = "0.5.0"
        // Links to this host open in the app (docs/android-devices.md). Build with
        // -PstudioOwnHost=studio.example.com; the default claims no real host.
        manifestPlaceholders["studioOwnHost"] = (project.findProperty("studioOwnHost") as String?) ?: "studio-own.invalid"
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
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    // Battery saver approval checks every 15 minutes (docs/approval-alerts.md).
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    testImplementation("junit:junit:4.13.2")
    // org.json is a stub in local unit tests; the real one parses bridge messages there.
    testImplementation("org.json:json:20240303")
    // A stand-in Studio for ApprovalAlertClientTest (com.sun.net.httpserver is not on the unit-test classpath).
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
