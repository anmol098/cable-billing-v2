package com.cablebilling.lineman.data.network

import java.io.File

/**
 * The mobile API contract in the monorepo (`packages/contracts`, T-051): `openapi.json` and the
 * example bodies in `fixtures/`. Found by walking up from the test's working directory, so the
 * tests run from Gradle (module dir) and from an IDE alike.
 */
object ContractFiles {
    val dir: File by lazy {
        generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "packages/contracts") }
            .firstOrNull { File(it, "openapi.json").isFile }
            ?: error("packages/contracts/openapi.json not found above ${System.getProperty("user.dir")}")
    }

    val openApi: File get() = File(dir, "openapi.json")

    val fixturesDir: File get() = File(dir, "fixtures")

    /** Every fixture file name (`login.response.json`, `error.APP_TOO_OLD.json`, …), sorted. */
    fun fixtureNames(): List<String> =
        fixturesDir
            .listFiles { file -> file.extension == "json" }
            .orEmpty()
            .map { it.name }
            .sorted()

    /** The text of one fixture, e.g. `fixture("login.response.json")`. */
    fun fixture(name: String): String = File(fixturesDir, name).readText()

    /** The app module directory (`apps/android/app`). */
    val appModuleDir: File by lazy { File(dir, "../../apps/android/app").canonicalFile }
}
