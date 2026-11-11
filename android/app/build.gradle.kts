import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// The upload key stays out of git: docs/android.md. Without this file a release build comes out unsigned.
val keystoreFile = rootProject.file("keystore.properties")
val keystore = Properties().apply { if (keystoreFile.exists()) keystoreFile.inputStream().use { load(it) } }

// Push (core/Notifier.kt): the Firebase project's app/google-services.json, read here instead of by Google's plugin. Not a secret.
// Without the file the build has no push, and the app says things itself while it runs.
val firebase: Map<String, String> = run {
    val f = file("google-services.json")
    if (!f.exists()) return@run emptyMap()
    @Suppress("UNCHECKED_CAST")
    val json = groovy.json.JsonSlurper().parse(f) as Map<String, Any?>
    val project = json["project_info"] as Map<String, Any?>
    val client = (json["client"] as List<Map<String, Any?>>).first {
        ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == "eu.drivezzz.app"
    }
    mapOf(
        "FCM_APP_ID" to (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"].toString(),
        "FCM_API_KEY" to ((client["api_key"] as List<Map<String, Any?>>).first()["current_key"]).toString(),
        "FCM_PROJECT_ID" to project["project_id"].toString(),
        "FCM_SENDER_ID" to project["project_number"].toString(),
    )
}

android {
    namespace = "eu.drivezzz.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "eu.drivezzz.app"
        // Android 16 only for now (Pieter, 7 November 2026): older versions can be added later. 34 is the lowest it has run on.
        minSdk = 36
        // An APK for one kind of phone, much smaller: ./gradlew :app:assembleLive -Pabi=arm64-v8a (docs/android.md). Android Studio's
        // own way to do that (android.injected.build.abi) marks the APK test-only, which a phone refuses to install.
        providers.gradleProperty("abi").orNull?.let { ndk { abiFilters += it.split(",") } }
        targetSdk = 36
        versionCode = 4
        versionName = "1.0"
        // Not a secret: it says which app is talking to the WalletConnect relay. The same one as iOS.
        buildConfigField("String", "WC_PROJECT_ID", "\"31ae35073ce5a54aa9051157dfb9c1a3\"")
        for (name in listOf("FCM_APP_ID", "FCM_API_KEY", "FCM_PROJECT_ID", "FCM_SENDER_ID")) {
            buildConfigField("String", name, "\"${firebase[name] ?: ""}\"")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    signingConfigs {
        if (keystoreFile.exists()) {
            create("upload") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // The live server, as on iOS (Pieter, 6 November 2026: Android is on the live server too), unless serverURLOverride
            // says otherwise: set that to the test server before anything that makes accounts. `qa` is the build for the test server.
            buildConfigField("String", "DEFAULT_SERVER", "\"https://drivezzz.s3rver.nl\"")
            buildConfigField("boolean", "TEST_BUTTONS", "true")
        }
        release {
            buildConfigField("String", "DEFAULT_SERVER", "\"https://drivezzz.s3rver.nl\"")
            buildConfigField("boolean", "TEST_BUTTONS", "false")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystoreFile.exists()) signingConfig = signingConfigs.getByName("upload")
        }
        // A release build (shrunk, optimised), on the test server: what riders would get, but safe to make accounts with.
        create("qa") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
            buildConfigField("String", "DEFAULT_SERVER", "\"http://your-server:8090\"")
            buildConfigField("boolean", "TEST_BUTTONS", "true")
        }
        // The release build on the live server, signed with this Mac's debug key: to put on your own Android phone, on the same server as
        // an iPhone, before there's an upload key. Real accounts and real money, so never to test with. Not for Google Play.
        create("live") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += setOf("META-INF/versions/**", "META-INF/{AL2.0,LGPL2.1}", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    val bom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(bom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // The map (the seam is map/DzMap.kt): no key, no Google account.
    // OpenGL ES, not the default Vulkan build: cheap phones can have no Vulkan it can use ("No Vulkan compatible GPU found" on start).
    // OpenGL ES 3 is on every phone that runs Android 16.
    implementation("org.maplibre.gl:android-sdk-opengl:13.7.1")
    // X25519, Ed25519, ChaCha20-Poly1305, HKDF, secp256k1 and GCM with a 16-byte nonce, on any Android version.
    implementation("org.bouncycastle:bcprov-jdk18on:1.82")
    implementation("com.google.zxing:core:3.5.4")
    // Push through Firebase Cloud Messaging (core/Notifier.kt). Off until there's a google-services.json.
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-messaging")

    // The driver checks for the Netherlands (features/checks, docs/driver-checks-nl.md). Everything is read on the phone:
    // the camera, the text on an ID and on documents, and faces with ML Kit's models in the app (nothing waits for Google Play);
    // the ID's chip by NFC with JMRTD (LGPL-3.0), its photo in JPEG 2000 with JJ2000 (Apache-2.0). The face match is SFace (OpenCV
    // Zoo, Apache-2.0) in Kotlin of our own. The photos never leave the phone, only the score does, as on iOS.
    val camerax = "1.5.3"
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")
    implementation("com.google.mlkit:text-recognition:16.0.1")
    implementation("com.google.mlkit:face-detection:16.1.7")
    implementation("org.jmrtd:jmrtd:0.8.9")
    implementation("net.sf.scuba:scuba-sc-android:0.0.27")
    implementation("edu.ucar:jj2000:5.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test:2.4.21")
    testImplementation("org.json:json:20250517")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
