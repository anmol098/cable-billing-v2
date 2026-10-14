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

/**
 * Sentry DSN of a flavour (T-071): `-Pcb.sentryDsn.<flavour>=…` or `SENTRY_DSN_<FLAVOUR>`; staging and
 * prod fall back to `-Pcb.sentryDsn` / `SENTRY_DSN`. dev never falls back, so local builds and the unit
 * tests (devDebug) have no DSN. Empty = Sentry stays off.
 */
fun sentryDsn(flavor: String): String {
    val own =
        providers
            .gradleProperty("cb.sentryDsn.$flavor")
            .orElse(providers.environmentVariable("SENTRY_DSN_${flavor.uppercase()}"))
    val shared = providers.gradleProperty("cb.sentryDsn").orElse(providers.environmentVariable("SENTRY_DSN"))
    return (if (flavor == "dev") own else own.orElse(shared)).getOrElse("")
}

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

        // T-072: AndroidJUnitRunner with a plain Application (src/androidTest/java/…/durability), so the
        // instrumented suite wires the real classes by hand without CableApplication's start-up work.
        testInstrumentationRunner = "com.cablebilling.lineman.durability.DurabilityTestRunner"
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            buildConfigField("String", "SENTRY_DSN", "\"${sentryDsn("dev")}\"")
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
            buildConfigField("String", "SENTRY_DSN", "\"${sentryDsn("staging")}\"")
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
            buildConfigField("String", "SENTRY_DSN", "\"${sentryDsn("prod")}\"")
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
    implementation(libs.androidx.lifecycle.process)

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
    testImplementation(libs.okhttp.mockwebserver3)
    testImplementation(libs.androidx.room.testing)
    testImplementation(libs.androidx.work.testing)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    // T-072: the instrumented durability + migration suite (src/androidTest; emulator or phone).
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.okhttp.mockwebserver3)
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.work.testing)
}

// T-063: the mobile API contract is an input of the unit tests. ApiModelsUpToDateTest regenerates the
// DTOs (data/network/generated/ApiModels.kt) from packages/contracts/openapi.json and fails on drift;
// the network tests decode packages/contracts/fixtures. Regenerate the DTOs with
// ./gradlew :app:testDevDebugUnitTest --tests '*ApiModelsUpToDateTest' -Pcb.writeApiModels=true
val apiContractDir: Directory = rootProject.layout.projectDirectory.dir("../../packages/contracts")
val writeApiModels: String? = providers.gradleProperty("cb.writeApiModels").orNull

tasks.withType<Test>().configureEach {
    inputs
        .file(apiContractDir.file("openapi.json"))
        .withPropertyName("apiContract")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs
        .dir(apiContractDir.dir("fixtures"))
        .withPropertyName("apiFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    if (writeApiModels != null) systemProperty("cb.writeApiModels", writeApiModels)
}

// T-064: MigrationTestHelper reads the exported Room schemas from the app's assets. The Room plugin adds
// them to androidTest only, and Robolectric unit tests see the tested variant's assets (unit-test assets
// are not merged), so debug builds carry them (a few KB of JSON; release builds never do).
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.sources.assets?.addStaticSourceDirectory(file("schemas").path)
    }
}

// T-068: ReceiptDatesTest checks the receipt month names against packages/domain (T-024), so that
// file is a test input. ReceiptRendererSnapshotTest compares receipts with the PNGs in
// src/test/resources/receipt-snapshots; rewrite them after an intended layout change with
// ./gradlew :app:testDevDebugUnitTest --tests '*ReceiptRendererSnapshotTest' -Pcb.writeReceiptSnapshots=true
val domainLabels: RegularFile = rootProject.layout.projectDirectory.file("../../packages/domain/src/time/labels.ts")
val writeReceiptSnapshots: String? = providers.gradleProperty("cb.writeReceiptSnapshots").orNull

tasks.withType<Test>().configureEach {
    inputs
        .file(domainLabels)
        .withPropertyName("domainLabels")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    if (writeReceiptSnapshots != null) systemProperty("cb.writeReceiptSnapshots", writeReceiptSnapshots)
}

// T-072: the durability and migration scenarios in src/androidTest/shared run twice: as instrumented tests
// on an emulator or phone (connectedDevDebugAndroidTest: real SQLite, files, Keystore, WorkManager) and on
// Robolectric inside testDevDebugUnitTest, so every PR runs them. Code there may only use what both test
// classpaths have (no contract fixture files, no src/test helpers). Instrumented-only code: src/androidTest/java.
android {
    sourceSets {
        // `kotlin`, not `java`: AGP 9's built-in Kotlin compiles only the Kotlin source directories.
        getByName("androidTest").kotlin.srcDir("src/androidTest/shared/java")
        getByName("test").kotlin.srcDir("src/androidTest/shared/java")
    }
}
