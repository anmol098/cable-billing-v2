import io.gitlab.arturbosch.detekt.Detekt

// Root build: plugin versions for every module, plus the two style checks that run over the whole
// project (`./gradlew ktlintCheck detekt`). Module builds live in app/ and core/designsystem/.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.room) apply false
    alias(libs.plugins.detekt)
}

// Kotlin sources checked by ktlint and detekt. Add a new module's src/ here.
val lintedSources = listOf("app/src", "core/designsystem/src", "detekt-rules/src")
val generatedCode = listOf("**/generated/**", "**/build/**")

// ---- detekt -------------------------------------------------------------------------------------
// Runs once from the root (not per Android module): detekt 1.23's per-variant Android tasks use the
// AGP variant API that AGP 9 removed, and plain source analysis is all we need.
detekt {
    buildUponDefaultConfig = true
    config.setFrom(files("config/detekt/detekt.yml"))
    source.setFrom(files(lintedSources))
    basePath = projectDir.absolutePath
    parallel = true
}

dependencies {
    // Our own rules (raw colour / dp literals outside core/designsystem). Not transitive: detekt
    // brings its own Kotlin runtime, and a second kotlin-stdlib on its classpath breaks it.
    detektPlugins(project(":detekt-rules")) { isTransitive = false }
}

tasks.withType<Detekt>().configureEach {
    exclude(generatedCode)
    jvmTarget = "17"
    reports {
        html.required.set(true)
        xml.required.set(true)
        sarif.required.set(false)
        md.required.set(false)
        txt.required.set(false)
    }
}

// ---- ktlint -------------------------------------------------------------------------------------
// The ktlint CLI through JavaExec (pinterest's documented "custom Gradle integration"): it does not
// depend on the Kotlin Android plugin, which AGP 9's built-in Kotlin no longer applies.
val ktlint: Configuration = configurations.create("ktlint")

dependencies {
    ktlint(libs.ktlint.cli) {
        attributes {
            attribute(Bundling.BUNDLING_ATTRIBUTE, objects.named(Bundling.EXTERNAL))
        }
    }
}

val ktlintPatterns =
    lintedSources.map { "$it/**/*.kt" } +
        listOf("*.kts", "app/*.kts", "core/designsystem/*.kts", "detekt-rules/*.kts") +
        generatedCode.map { "!$it" }

tasks.register<JavaExec>("ktlintCheck") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Checks Kotlin code style with ktlint."
    classpath = ktlint
    mainClass.set("com.pinterest.ktlint.Main")
    jvmArgs("--add-opens=java.base/java.lang=ALL-UNNAMED")
    args(listOf("--relative") + ktlintPatterns)
    inputs.files(
        fileTree(".") {
            include(ktlintPatterns.filterNot { it.startsWith("!") })
            exclude(generatedCode)
        },
    )
    inputs.files(".editorconfig", "../../.editorconfig")
    val marker = layout.buildDirectory.file("ktlint/check.ok")
    outputs.file(marker)
    doLast { marker.get().asFile.writeText("ok\n") }
}

tasks.register<JavaExec>("ktlintFormat") {
    group = "formatting"
    description = "Fixes Kotlin code style with ktlint."
    classpath = ktlint
    mainClass.set("com.pinterest.ktlint.Main")
    jvmArgs("--add-opens=java.base/java.lang=ALL-UNNAMED")
    args(listOf("--relative", "-F") + ktlintPatterns)
}
