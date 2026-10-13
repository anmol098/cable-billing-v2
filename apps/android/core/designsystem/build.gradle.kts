// core/designsystem: generated Tokens.kt (packages/design-tokens), the Compose theme (CableTheme),
// bundled fonts, ic_cb_* icons (T-003) and the low-literacy components (T-009). The only module
// allowed to turn literals into Color / dp / sp (detekt `cable` rules).
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.cablebilling.designsystem"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // Component tests run on Robolectric at the app's targetSdk (API 36), which needs JDK 21.
        targetSdk = 36
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
        checkDependencies = false
        lintConfig = file("../../config/lint/lint.xml")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// The project's check command is `./gradlew … testDevDebugUnitTest`. This library has no flavours,
// so its debug unit tests (the component tests) are hooked onto that name to run with it.
tasks.register("testDevDebugUnitTest") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Runs this library's debug unit tests (alias so the app's check command covers them)."
    dependsOn("testDebugUnitTest")
}

dependencies {
    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.compose.ui)
    api(libs.androidx.compose.ui.graphics)
    api(libs.androidx.compose.ui.text)
    api(libs.androidx.compose.ui.unit)
    api(libs.androidx.compose.foundation)
    api(libs.androidx.compose.material3)
    // Speaker.isMuted is a StateFlow.
    api(libs.kotlinx.coroutines.core)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
