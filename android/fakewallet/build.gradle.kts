plugins {
    id("com.android.application")
}

// The same NaCl and Base58 as the app, so it isn't copied by hand.
val shared = layout.buildDirectory.dir("shared/eu/drivezzz/app/core")
val copyShared by tasks.registering(Copy::class) {
    from(rootProject.file("app/src/main/java/eu/drivezzz/app/core/NaCl.kt"))
    into(shared)
}

android {
    namespace = "eu.drivezzz.fakewallet"
    compileSdk = 37
    defaultConfig {
        // What the app looks for and opens. A real Phantom can't be installed next to this, nor is there one on an emulator without Google Play.
        applicationId = "app.phantom"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].kotlin.srcDir(layout.buildDirectory.get().dir("shared").asFile)
    packaging {
        resources.excludes += setOf("META-INF/versions/**", "META-INF/{AL2.0,LGPL2.1}", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

kotlin {
    jvmToolchain(21)
}

tasks.named("preBuild") { dependsOn(copyShared) }

dependencies {
    implementation("org.bouncycastle:bcprov-jdk18on:1.82")
}
