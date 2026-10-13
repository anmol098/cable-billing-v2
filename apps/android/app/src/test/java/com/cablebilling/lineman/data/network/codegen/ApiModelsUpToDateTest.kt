package com.cablebilling.lineman.data.network.codegen

import com.cablebilling.lineman.data.network.ContractFiles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The committed DTOs (`data/network/generated/ApiModels.kt`) are exactly what [ApiModelGenerator]
 * makes from the committed `packages/contracts/openapi.json`. This is the drift check (CI runs it
 * with the unit tests). After a contract change, regenerate with
 * `./gradlew :app:testDevDebugUnitTest --tests '*ApiModelsUpToDateTest' -Pcb.writeApiModels=true`.
 */
class ApiModelsUpToDateTest {
    private val target =
        File(
            ContractFiles.appModuleDir,
            "src/main/java/" + ApiModelGenerator.PACKAGE.replace('.', '/') + "/ApiModels.kt",
        )

    @Test
    fun `generated DTOs match openapi json`() {
        val expected = ApiModelGenerator.generate(ContractFiles.openApi.readText())
        if (System.getProperty("cb.writeApiModels") == "true") {
            target.parentFile.mkdirs()
            target.writeText(expected)
        }
        assertTrue("missing $target: regenerate (see KDoc)", target.isFile)
        assertEquals(
            "ApiModels.kt is stale or hand-edited: regenerate it (see this test's KDoc)",
            expected,
            target.readText(),
        )
    }

    @Test
    fun `generation is deterministic`() {
        val source = ContractFiles.openApi.readText()
        assertEquals(ApiModelGenerator.generate(source), ApiModelGenerator.generate(source))
    }

    @Test(expected = IllegalStateException::class)
    fun `refuses a float amount`() {
        ApiModelGenerator.generate(
            """
            {"info": {"title": "t", "version": "1"}, "components": {"schemas": {
              "Bad": {"type": "object", "properties": {"amount": {"type": "number"}}, "required": ["amount"]}
            }}}
            """.trimIndent(),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `refuses a oneOf-like anyOf`() {
        ApiModelGenerator.generate(
            """
            {"info": {"title": "t", "version": "1"}, "components": {"schemas": {
              "Bad": {"type": "object", "properties": {"x": {"anyOf": [{"type": "string"}, {"type": "integer"}]}}}
            }}}
            """.trimIndent(),
        )
    }
}
