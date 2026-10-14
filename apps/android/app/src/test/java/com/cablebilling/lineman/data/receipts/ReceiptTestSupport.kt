package com.cablebilling.lineman.data.receipts

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.ItemError
import com.cablebilling.lineman.data.network.generated.ReceiptActionItem
import com.cablebilling.lineman.data.network.generated.ReceiptActionOutcome
import com.cablebilling.lineman.data.network.generated.ReceiptActionResult
import com.cablebilling.lineman.data.network.generated.ReceiptActionsRequest
import com.cablebilling.lineman.data.network.generated.ReceiptActionsResponse
import com.cablebilling.lineman.data.network.generated.ReceiptLink
import com.cablebilling.lineman.data.network.generated.ReceiptLinkResponse
import com.cablebilling.lineman.data.network.generated.UpdatePhoneRequest
import com.cablebilling.lineman.data.network.generated.UpdatePhoneResponse
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.diagnostics.DiagnosticLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import java.io.File
import java.util.Collections
import java.util.concurrent.Executor

/**
 * A stand-in for the receipt endpoints with the server's rules (T-061): receipt actions are
 * idempotent on their id (`recorded`, then `duplicate`) and `retry_later` PAYMENT_NOT_FOUND for a
 * payment the office does not have; links are made only for payments the [payments] office posted
 * (404 PAYMENT_NOT_FOUND before), a new https link per call; phone changes take a 10-digit number.
 * [online] false cuts every connection.
 */
class FakeReceiptOffice(
    private val payments: FakePaymentServer,
) {
    private val json = NetworkModule.provideJson()

    @Volatile
    var online = true

    /** Answer to `PATCH /customers/{id}/phone` instead of taking it (e.g. a 404 while T-060 is not deployed). */
    @Volatile
    var phoneAnswer: (() -> MockResponse)? = null

    /** Answer the next N action batches after storing them, then cut the connection (a lost answer). */
    @Volatile
    var dropActionAnswers = 0

    /** Action ids → item, as stored (each once). */
    val actions: MutableMap<String, ReceiptActionItem> = Collections.synchronizedMap(LinkedHashMap())

    /** Every action batch received (incl. repeats). */
    val actionBatches: MutableList<ReceiptActionsRequest> = Collections.synchronizedList(mutableListOf())

    /** Forced outcome for an action id. */
    val forced: MutableMap<String, ReceiptActionOutcome> = Collections.synchronizedMap(mutableMapOf())

    /** Payment ids a link was asked for (each call). */
    val linkCalls: MutableList<String> = Collections.synchronizedList(mutableListOf())

    /** customer id → phone, as the office stores them. */
    val phones: MutableMap<String, String> = Collections.synchronizedMap(mutableMapOf())

    /** Every phone request body received. */
    val phoneCalls: MutableList<Pair<String, String>> = Collections.synchronizedList(mutableListOf())

    /** Handles the receipt and phone endpoints; null for anything else. */
    fun handle(request: RecordedRequest): MockResponse? {
        val path = request.apiPath
        val handled =
            path == "/receipts/actions:batch" ||
                (path.startsWith("/receipts/") && path.endsWith("/link")) ||
                (path.startsWith("/customers/") && path.endsWith("/phone"))
        return when {
            !handled -> null
            !online -> offline()
            path == "/receipts/actions:batch" -> actions(request)
            path.endsWith("/link") -> link(path.removePrefix("/receipts/").removeSuffix("/link"))
            else -> phone(path.removePrefix("/customers/").removeSuffix("/phone"), request)
        }
    }

    private fun actions(request: RecordedRequest): MockResponse {
        val batch = json.decodeFromString(ReceiptActionsRequest.serializer(), request.bodyText)
        actionBatches += batch
        val results =
            batch.actions.map { item ->
                val forcedOutcome = forced[item.id]
                when {
                    forcedOutcome == ReceiptActionOutcome.REJECTED -> {
                        ReceiptActionResult(item.id, forcedOutcome, ItemError("VALIDATION", "bad"))
                    }

                    forcedOutcome == ReceiptActionOutcome.RETRY_LATER -> {
                        ReceiptActionResult(item.id, forcedOutcome, ItemError("INTERNAL", "busy"))
                    }

                    item.paymentId !in payments.postedIds() -> {
                        ReceiptActionResult(
                            item.id,
                            ReceiptActionOutcome.RETRY_LATER,
                            ItemError("PAYMENT_NOT_FOUND", "not yet"),
                        )
                    }

                    actions.containsKey(item.id) -> {
                        ReceiptActionResult(item.id, ReceiptActionOutcome.DUPLICATE)
                    }

                    else -> {
                        actions[item.id] = item
                        ReceiptActionResult(item.id, ReceiptActionOutcome.RECORDED)
                    }
                }
            }
        if (dropActionAnswers > 0) {
            dropActionAnswers--
            return offline()
        }
        return ok(
            json.encodeToString(ReceiptActionsResponse.serializer(), ReceiptActionsResponse(SERVER_TIME, results)),
        )
    }

    private fun link(paymentId: String): MockResponse {
        linkCalls += paymentId
        val receipt = payments.receiptOf(paymentId) ?: return Fixtures.response("error.PAYMENT_NOT_FOUND.json")
        val link = ReceiptLink("https://cablebilling.example/r/token${linkCalls.size}", LINK_EXPIRES, receipt)
        return ok(json.encodeToString(ReceiptLinkResponse.serializer(), ReceiptLinkResponse(SERVER_TIME, link)))
    }

    private fun phone(
        customerId: String,
        request: RecordedRequest,
    ): MockResponse {
        val body = json.decodeFromString(UpdatePhoneRequest.serializer(), request.bodyText)
        phoneCalls += customerId to body.phone
        val forced = phoneAnswer
        return when {
            forced != null -> forced()
            !PhoneNumbers.isValid(body.phone) -> Fixtures.response("error.VALIDATION.json")
            else -> takePhone(customerId, body.phone)
        }
    }

    private fun takePhone(
        customerId: String,
        phone: String,
    ): MockResponse {
        val body = UpdatePhoneRequest(phone)
        val changed = phones[customerId] != body.phone
        phones[customerId] = body.phone
        val customer = RosterFixtures.ramesh.copy(id = customerId, phone = body.phone, updatedAt = SERVER_TIME)
        return ok(
            json.encodeToString(UpdatePhoneResponse.serializer(), UpdatePhoneResponse(SERVER_TIME, changed, customer)),
        )
    }

    private fun ok(body: String): MockResponse =
        MockResponse
            .Builder()
            .code(HTTP_OK)
            .setHeader("Content-Type", "application/json")
            .body(body)
            .build()

    companion object {
        const val SERVER_TIME = "2026-10-13T11:30:00.000Z"
        const val LINK_EXPIRES = "2027-01-11T11:30:00.000Z"
        private const val HTTP_OK = 200

        fun offline(): MockResponse = MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()
    }
}

/** Counts sync requests. */
class RecordingSyncTrigger : ReceiptSyncTrigger {
    @Volatile
    var requests = 0

    override fun requestSync() {
        requests++
    }
}

/** A [ReceiptRequestStore] on a file in [dir]; [close] ends its "process" (like the app being killed). */
class TestRequestStore(
    private val dir: File,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val store =
        ReceiptRequestStore(
            PreferenceDataStoreFactory.create(scope = scope) { File(dir, "receipt_requests.preferences_pb") },
        )

    fun close() = await { scope.coroutineContext.job.cancelAndJoin() }
}

/** A diagnostic log in [dir] that writes at once (no background thread). */
fun testLog(dir: File): DiagnosticLog = DiagnosticLog(File(dir, "diagnostics"), writer = Executor { it.run() })

/**
 * Robolectric gives every test a new data dir, but `FileProvider` caches each authority's roots in a
 * static map for the whole JVM: forget them so the provider resolves this test's cache dir.
 */
fun resetFileProviderRoots() {
    val field = androidx.core.content.FileProvider::class.java.getDeclaredField("sCache")
    field.isAccessible = true
    val cache = field.get(null) as MutableMap<*, *>
    synchronized(cache) { cache.clear() }
}
