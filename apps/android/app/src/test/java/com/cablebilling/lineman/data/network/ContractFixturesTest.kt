package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.network.generated.AppConfigResponse
import com.cablebilling.lineman.data.network.generated.CollectionDayResponse
import com.cablebilling.lineman.data.network.generated.CustomerDetailResponse
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.ErrorResponse
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverResponse
import com.cablebilling.lineman.data.network.generated.LoginRequest
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.data.network.generated.LogoutRequest
import com.cablebilling.lineman.data.network.generated.LogoutResponse
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.network.generated.PaymentBatchResponse
import com.cablebilling.lineman.data.network.generated.PaymentOutcome
import com.cablebilling.lineman.data.network.generated.ReceiptActionsRequest
import com.cablebilling.lineman.data.network.generated.ReceiptActionsResponse
import com.cablebilling.lineman.data.network.generated.ReceiptLinkResponse
import com.cablebilling.lineman.data.network.generated.RefreshRequest
import com.cablebilling.lineman.data.network.generated.RefreshResponse
import com.cablebilling.lineman.data.network.generated.SyncCustomersResponse
import com.cablebilling.lineman.data.network.generated.UpdatePhoneRequest
import com.cablebilling.lineman.data.network.generated.UpdatePhoneResponse
import com.cablebilling.lineman.di.NetworkModule
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every contract fixture (`packages/contracts/fixtures`, all requests, responses and error bodies)
 * decodes into the generated DTOs with the app's own Json, and encodes back to the same JSON. The
 * DTO for each fixture is looked up in openapi.json (operation → request/200 schema), so a new
 * fixture or endpoint without a matching DTO fails here.
 */
class ContractFixturesTest {
    private val json: Json = NetworkModule.provideJson()

    /** Schema name → generated serializer, for every request and response body in the contract. */
    private val serializers: Map<String, KSerializer<*>> =
        mapOf(
            "LoginRequest" to LoginRequest.serializer(),
            "LoginResponse" to LoginResponse.serializer(),
            "RefreshRequest" to RefreshRequest.serializer(),
            "RefreshResponse" to RefreshResponse.serializer(),
            "LogoutRequest" to LogoutRequest.serializer(),
            "LogoutResponse" to LogoutResponse.serializer(),
            "AppConfigResponse" to AppConfigResponse.serializer(),
            "SyncCustomersResponse" to SyncCustomersResponse.serializer(),
            "CustomerDetailResponse" to CustomerDetailResponse.serializer(),
            "UpdatePhoneRequest" to UpdatePhoneRequest.serializer(),
            "UpdatePhoneResponse" to UpdatePhoneResponse.serializer(),
            "PaymentBatchRequest" to PaymentBatchRequest.serializer(),
            "PaymentBatchResponse" to PaymentBatchResponse.serializer(),
            "CollectionDayResponse" to CollectionDayResponse.serializer(),
            "HandoverRequest" to HandoverRequest.serializer(),
            "HandoverResponse" to HandoverResponse.serializer(),
            "ReceiptLinkResponse" to ReceiptLinkResponse.serializer(),
            "ReceiptActionsRequest" to ReceiptActionsRequest.serializer(),
            "ReceiptActionsResponse" to ReceiptActionsResponse.serializer(),
            "ErrorResponse" to ErrorResponse.serializer(),
        )

    /** operationId → (request schema or null, 200 response schema), read from openapi.json. */
    private val operations: Map<String, Pair<String?, String>> by lazy {
        val paths =
            Json
                .parseToJsonElement(ContractFiles.openApi.readText())
                .jsonObject
                .getValue("paths")
                .jsonObject
        paths.values
            .flatMap { it.jsonObject.values }
            .map { it.jsonObject }
            .associate { op ->
                val request = op["requestBody"]?.let { schemaRef(it.jsonObject) }
                val response =
                    schemaRef(
                        op
                            .getValue("responses")
                            .jsonObject
                            .getValue("200")
                            .jsonObject,
                    )
                op.getValue("operationId").jsonPrimitive.content to (request to response)
            }
    }

    private fun schemaRef(holder: JsonObject): String =
        holder
            .getValue("content")
            .jsonObject
            .getValue("application/json")
            .jsonObject
            .getValue("schema")
            .jsonObject
            .getValue("\$ref")
            .jsonPrimitive.content
            .removePrefix("#/components/schemas/")

    /**
     * The schema a fixture holds: `error.<CODE>.json`, `<operationId>.request[.variant].json` or
     * `<operationId>.response[.variant].json`.
     */
    private fun schemaFor(fixture: String): String {
        val parts = fixture.removeSuffix(".json").split('.')
        if (parts.first() == "error") return "ErrorResponse"
        val (request, response) = operations[parts[0]] ?: error("$fixture: no operation ${parts[0]} in openapi.json")
        return when (parts[1]) {
            "request" -> request ?: error("$fixture: ${parts[0]} has no request body")
            "response" -> response
            else -> error("$fixture: expected request or response, got ${parts[1]}")
        }
    }

    @Test
    fun `every fixture decodes into its DTO and encodes back to the same JSON`() {
        val names = ContractFiles.fixtureNames()
        assertTrue("expected the T-051 fixtures, found ${names.size}", names.size >= MIN_FIXTURES)
        for (name in names) {
            val schema = schemaFor(name)

            @Suppress("UNCHECKED_CAST")
            val serializer =
                serializers[schema] as KSerializer<Any>? ?: error("$name: no DTO serializer mapped for $schema")
            val original = Json.parseToJsonElement(Fixtures.text(name))
            val decoded = json.decodeFromString(serializer, Fixtures.text(name))
            val encoded = json.encodeToJsonElement(serializer, decoded)
            assertEquals("$name round trip", Fixtures.withoutNulls(original), Fixtures.withoutNulls(encoded))
        }
    }

    @Test
    fun `every operation has a response fixture`() {
        val names = ContractFiles.fixtureNames().toSet()
        for (operationId in operations.keys) {
            assertTrue("$operationId.response.json missing", "$operationId.response.json" in names)
        }
    }

    @Test
    fun `every error code has a fixture with that code and the contract status`() {
        for (code in ErrorCode.entries) {
            val name = "error.${code.wire}.json"
            val body = Fixtures.decode(ErrorResponse.serializer(), name)
            assertEquals(code.wire, body.error.code)
            assertEquals(code, ErrorCode.fromWire(body.error.code))
            assertNotNull("status for ${code.wire}", Fixtures.ERROR_STATUS[code.wire])
        }
        assertEquals(ErrorCode.entries.size, Fixtures.ERROR_STATUS.size)
        val tooOld = Fixtures.decode(ErrorResponse.serializer(), "error.APP_TOO_OLD.json").error
        assertEquals(3L, tooOld.minAppVersionCode)
    }

    @Test
    fun `money is Long paise and every payment outcome decodes`() {
        val batch = Fixtures.decode(PaymentBatchResponse.serializer(), "postPaymentBatch.response.json")
        assertEquals(PaymentOutcome.entries.toSet(), batch.results.map { it.outcome }.toSet())
        val posted = batch.results.first { it.outcome == PaymentOutcome.POSTED }.payment!!
        assertTrue(posted.amountPaise > 0)
        assertEquals(0L, posted.amountPaise % PAISE_PER_RUPEE)
    }

    @Test
    fun `an unknown error code and unknown response fields still decode`() {
        val body =
            """
            {"server_time": "2026-10-13T11:30:00.000Z", "new_field": 1,
             "error": {"code": "SOMETHING_NEW", "message": "m", "request_id": "r", "extra": true}}
            """.trimIndent()
        val decoded = json.decodeFromString(ErrorResponse.serializer(), body)
        assertEquals("SOMETHING_NEW", decoded.error.code)
        assertEquals(null, ErrorCode.fromWire(decoded.error.code))
    }

    private companion object {
        const val MIN_FIXTURES = 42
        const val PAISE_PER_RUPEE = 100L
    }
}
