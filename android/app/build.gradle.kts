plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.windscore.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.windscore.app"
        minSdk = 28          // Android 9+
        targetSdk = 34
        // 由 npm run version 与 package.json、桌面端同步递增。
        versionCode = 153
        versionName = "0.4.26"
    }

    signingConfigs {
        create("release") {
            storeFile = file("../windscore.keystore")
            storePassword = "windscore"
            keyAlias = "windscore"
            keyPassword = "windscore"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // Generated web assets: every APK uses a fresh Android-specific Vite build.
    sourceSets.getByName("main").assets.setSrcDirs(listOf(layout.buildDirectory.dir("generated/webAssets")))
}

val buildWeb by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir.parentFile)
    commandLine(if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm", "run", "build:android")
}

val syncWebAssets by tasks.registering(Sync::class) {
    dependsOn(buildWeb)
    from(rootProject.file("../dist-android"))
    into(layout.buildDirectory.dir("generated/webAssets"))
}

tasks.named("preBuild") { dependsOn(syncWebAssets) }

// 面向手机交付的唯一文件名，避免 Downloads 中多份 app-debug.apk 混淆。
tasks.register<Copy>("exportDebugApk") {
    dependsOn("packageDebug")
    from(layout.buildDirectory.file("outputs/apk/debug/app-debug.apk"))
    into(rootProject.file("../artifacts/releases"))
    rename { "WindScore-${android.defaultConfig.versionName}-android-build${android.defaultConfig.versionCode}.apk" }
}

tasks.register<Copy>("exportReleaseApk") {
    dependsOn("packageRelease")
    from(layout.buildDirectory.file("outputs/apk/release/app-release.apk"))
    into(rootProject.file("../artifacts/releases"))
    rename { "WindScore-${android.defaultConfig.versionName}-android-build${android.defaultConfig.versionCode}-release.apk" }
}

tasks.configureEach {
    if (name == "assembleDebug") dependsOn("exportDebugApk")
    if (name == "assembleRelease") dependsOn("exportReleaseApk")
}

dependencies {
    implementation("androidx.webkit:webkit:1.10.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
