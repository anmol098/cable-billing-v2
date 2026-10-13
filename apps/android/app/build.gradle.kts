// The lineman app (PLAN §11.1): single app module with feature packages.
// Shared file (tasks/README.md §6): append dependency lines only; on conflict keep both sides.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
    alias(libs.plugins.room)
}

/** API base URL for a flavour; `-Pcb.apiBaseUrl.dev=http://192.168.1.5:3000/api/mobile/v1/` overrides it. */
fun apiBaseUrl(
    flavor: String,
    default: String,
): String = providers.gradleProperty("cb.apiBaseUrl.$flavor").getOrElse(default)

/** Sentry DSN from `-Pcb.sentryDsn=…` or the SENTRY_DSN environment variable. Empty = Sentry stays off. */
val sentryDsn: String =
    providers
        .gradleProperty("cb.sentryDsn")
        .orElse(providers.environmentVariable("SENTRY_DSN"))
        .getOrElse("")

android {
    namespace = "com.cablebilling.lineman"
    compileSdk = 37

    defaultConfig {
        // Provisional until H-02 decides the domain (D-21).
        applicationId = "com.cablebilling.lineman"
        minSdk = 26
        // Google Play requires API 36 (Android 16) for new apps and updates from 31 Aug 2026.
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "SENTRY_DSN", "\"$sentryDsn\"")
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            // Local Next.js dev server as seen from the Android emulator (PLAN §17 "Local").
            buildConfigField(
                "String",
                "API_BASE_URL",
                "\"${apiBaseUrl("dev", "http://10.0.2.2:3000/api/mobile/v1/")}\"",
            )
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            // TODO(H-02): real staging domain.
            buildConfigField(
                "String",
                "API_BASE_URL",
                "\"${apiBaseUrl("staging", "https://staging.cablebilling.example/api/mobile/v1/")}\"",
            )
        }
        create("prod") {
            dimension = "env"
            // TODO(H-02): real production domain.
            buildConfigField(
                "String",
                "API_BASE_URL",
                "\"${apiBaseUrl("prod", "https://app.cablebilling.example/api/mobile/v1/")}\"",
            )
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    androidResources {
        // Only the languages we ship (D-06); drops other locales from libraries.
        localeFilters += listOf("en", "hi")
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                it.maxHeapSize = "2g"
                // Robolectric's Android 16 (API 36) runtime reflects into this JDK-internal package.
                it.jvmArgs("--add-opens=java.base/jdk.internal.access=ALL-UNNAMED")
            }
        }
    }

    lint {
        abortOnError = true
        checkDependencies = true
        lintConfig = file("../config/lint/lint.xml")
    }

    packaging {
        resources.excludes += listOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

room {
    // Exported schemas are committed (PLAN §11.1, migration tests in T-064 / T-072).
    schemaDirectory("$projectDir/schemas")
}

dependencies {
    implementation(project(":core:designsystem"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.navigation.compose)
    implementation(libs.androidx.hilt.work)
    ksp(libs.androidx.hilt.compiler)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.retrofit)
    implementation(libs.retrofit.converter.kotlinx.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging.interceptor)

    implementation(libs.tink.android)
    implementation(libs.sentry.android.core)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
