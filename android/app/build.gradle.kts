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
        // 与 package.json 版本号手工同步（npm run version 不会动这里）
        versionCode = 2
        versionName = "0.2.77"
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

dependencies {
    implementation("androidx.webkit:webkit:1.10.0")
}
