package com.cablebilling.lineman.data.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.RosterFixtures.customer
import com.cablebilling.lineman.data.db.RosterFixtures.customerId
import com.cablebilling.lineman.data.db.RosterFixtures.payment
import com.cablebilling.lineman.data.db.RosterRepository
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.db.SyncStreams
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.db.putRoster
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.generated.CustomerDetailResponse
import com.cablebilling.lineman.data.network.generated.SyncCustomersResponse
import kotlinx.coroutines.flow.first
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.time.Instant

/**
 * Roster sync against MockWebServer with the contract fixtures (`syncCustomers.response*.json`,
 * `getCustomer.response.json`, `error.CURSOR_INVALID.json`): full and delta sync, paging,
 * tombstones, CURSOR_INVALID, offline, operator change, and that local payments always survive.
 */
@RunWith(AndroidJUnit4::class)
class RosterSyncTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val db: CableDatabase = inMemoryDatabase()
    private val time = FakeTime()
    private lateinit var network: TestNetwork
    private lateinit var store: RosterStore
    private lateinit var sync: RosterSync
    private lateinit var roster: RosterRepository

    /** What `GET /sync/customers` answers. */
    @Volatile
    private var syncAnswer: (RecordedRequest) -> MockResponse = { page(RosterFixtures.page) }

    /** What `GET /customers/{id}` answers. */
    @Volatile
    private var detailAnswer: (RecordedRequest) -> MockResponse = { Fixtures.response("getCustomer.response.json") }

    private val routes =
        Routes { request ->
            when {
                request.apiPath == "/sync/customers" -> syncAnswer(request)
                request.apiPath.startsWith("/customers/") -> detailAnswer(request)
                request.apiPath == "/app/config" -> Fixtures.response("getAppConfig.response.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }

    private val payments get() = db.paymentDao()
    private val operatorId get() = RosterFixtures.login.operator.id

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(RosterFixtures.login) }
        store = RosterStore(db, time)
        sync = RosterSync(network.mobileApi, network.errors, network.store, store)
        roster = RosterRepository(db, store, network.store, network.mobileApi, network.errors, time)
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    private fun page(body: SyncCustomersResponse): MockResponse =
        MockResponse
            .Builder()
            .code(HTTP_OK)
            .setHeader("Content-Type", "application/json")
            .body(network.json.encodeToString(SyncCustomersResponse.serializer(), body))
            .build()

    private fun dropConnection(): MockResponse =
        MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()

    private fun syncRequests() = routes.requestsTo("/sync/customers")

    private val RecordedRequest.cursor: String? get() = url.queryParameter("cursor")

    private fun run() = await { sync.run() }

    private fun search(query: String) = await { roster.search(query).first() }

    private fun meta() = await { db.syncMetaDao().get(SyncStreams.ROSTER) }!!

    @Test
    fun `the first sync stores the roster, the cursor and when it happened`() {
        val result = run()

        assertEquals(RosterSyncResult.Synced(fullSync = true, pages = 1, upserted = 2, removed = 0), result)
        val request = syncRequests().single()
        assertNull(request.cursor)
        assertEquals("500", request.url.queryParameter("limit"))
        assertEquals("Bearer example-access-token-1", request.headers["Authorization"])

        val ramesh = search("1045").single()
        assertEquals("Ramesh Kumar", ramesh.name)
        assertEquals("Shiv Nagar", ramesh.areaName)
        assertEquals(90_000, ramesh.balance.duePaise)
        val sunita = search("sunita").single()
        assertEquals(0, sunita.balance.duePaise)
        assertEquals(5_000, sunita.balance.creditPaise)

        val meta = meta()
        assertEquals(RosterFixtures.page.nextCursor, meta.cursor)
        assertEquals(operatorId, meta.scope)
        assertEquals(time.now, meta.lastSuccessAt)
        assertEquals(Instant.parse(RosterFixtures.page.serverTime).toEpochMilli(), meta.lastServerTime)
        assertNull(meta.lastFailure)
    }

    @Test
    fun `a delta sync applies changes and tombstones but keeps the tombstoned customer's payments`() {
        run()
        await { payments.insert(payment("p1", RosterFixtures.sunita.id, 5_000)) }
        val changed = RosterFixtures.ramesh.copy(balancePaise = 45_000, updatedAt = "2026-10-13T11:00:00.000Z")
        syncAnswer = {
            page(
                RosterFixtures.emptyPage.copy(
                    customers = listOf(changed),
                    removedCustomerIds = listOf(RosterFixtures.sunita.id),
                    nextCursor = "cursor-2",
                ),
            )
        }
        time.advanceMinutes(30)

        val result = run()

        assertEquals(RosterSyncResult.Synced(fullSync = false, pages = 1, upserted = 1, removed = 1), result)
        assertEquals(RosterFixtures.page.nextCursor, syncRequests().last().cursor)
        assertEquals(45_000, search("1045").single().balance.duePaise)
        assertEquals(emptyList<Any>(), search("sunita"))
        assertNotNull("a tombstone never deletes a payment", await { payments.get("p1") })
        assertEquals("cursor-2", meta().cursor)
        assertEquals(time.now, meta().lastSuccessAt)
    }

    @Test
    fun `a full sync pages until has_more is false and then drops customers it did not receive`() {
        await {
            db.putRoster(operatorId, listOf(customer(9)))
            store.clearCursor()
        }
        syncAnswer = { request ->
            when (request.cursor) {
                null -> {
                    page(
                        RosterFixtures.emptyPage.copy(
                            customers = listOf(customer(1), customer(2)),
                            nextCursor = "page-2",
                            hasMore = true,
                        ),
                    )
                }

                "page-2" -> {
                    page(RosterFixtures.emptyPage.copy(customers = listOf(customer(3)), nextCursor = "end"))
                }

                else -> {
                    Fixtures.response("error.CURSOR_INVALID.json")
                }
            }
        }

        val result = run()

        assertEquals(RosterSyncResult.Synced(fullSync = true, pages = 2, upserted = 3, removed = 1), result)
        assertEquals(listOf(null, "page-2"), syncRequests().map { it.cursor })
        assertEquals(setOf(customerId(1), customerId(2), customerId(3)), await { db.customerDao().allIds() }.toSet())
        assertEquals("end", meta().cursor)
    }

    @Test
    fun `CURSOR_INVALID starts a full resync that keeps every local payment`() {
        await {
            db.putRoster(operatorId, listOf(RosterFixtures.ramesh, customer(9)))
            payments.insert(payment("p1", customerId(9), 10_000))
            payments.insert(payment("p2", customerId(9), 20_000, PaymentState.SENT_TO_OFFICE, postedAt = 1))
        }
        syncAnswer = { request ->
            if (request.cursor ==
                "cursor-1"
            ) {
                Fixtures.response("error.CURSOR_INVALID.json")
            } else {
                page(RosterFixtures.page)
            }
        }

        val result = run()

        assertEquals(RosterSyncResult.Synced(fullSync = true, pages = 1, upserted = 2, removed = 1), result)
        assertEquals(listOf("cursor-1", null), syncRequests().map { it.cursor })
        assertEquals(emptyList<Any>(), search("Customer 9"))
        assertNotNull(await { payments.get("p1") })
        assertNotNull(await { payments.get("p2") })
        assertEquals(RosterFixtures.page.nextCursor, meta().cursor)
    }

    @Test
    fun `airplane mode - search works with the last data and says how long ago it was updated`() {
        assertTrue(run() is RosterSyncResult.Synced)
        val updatedAt = time.now
        time.advanceMinutes(12)
        server.close() // no network at all

        val result = run()

        assertTrue(result.toString(), (result as RosterSyncResult.Failed).failure is ApiFailure.Offline)
        assertEquals("Ramesh Kumar", search("4321").single().name)
        assertEquals("Ramesh Kumar", search("rame").single().name)
        val status = await { roster.syncStatus().first() }
        assertEquals(updatedAt, status.lastUpdatedAt)
        assertEquals(12L, status.minutesAgo)
        assertEquals("offline", status.lastFailure)
        assertEquals(false, status.syncing)
        assertEquals(RosterFixtures.page.nextCursor, meta().cursor)
    }

    @Test
    fun `an interrupted full sync keeps the old roster and no cursor`() {
        await {
            db.putRoster(operatorId, listOf(customer(9)))
            store.clearCursor()
        }
        syncAnswer = { request ->
            if (request.cursor == null) {
                page(
                    RosterFixtures.emptyPage.copy(
                        customers = listOf(customer(1)),
                        nextCursor = "page-2",
                        hasMore = true,
                    ),
                )
            } else {
                dropConnection()
            }
        }

        val result = run()

        assertTrue(result.toString(), (result as RosterSyncResult.Failed).failure is ApiFailure.Offline)
        assertEquals(setOf(customerId(1), customerId(9)), await { db.customerDao().allIds() }.toSet())
        assertNull(meta().cursor)
        assertEquals(0L, meta().lastSuccessAt)
        assertEquals("offline", meta().lastFailure)
    }

    @Test
    fun `an older copy of a customer never replaces a newer one`() {
        run()
        val older = RosterFixtures.ramesh.copy(balancePaise = 1, updatedAt = "2026-09-01T00:00:00.000Z")
        syncAnswer = { page(RosterFixtures.emptyPage.copy(customers = listOf(older))) }

        val result = run()

        assertEquals(RosterSyncResult.Synced(fullSync = false, pages = 1, upserted = 0, removed = 0), result)
        assertEquals(90_000, search("1045").single().balance.duePaise)
    }

    @Test
    fun `another operator's roster is never shown and is replaced, but payments stay`() {
        await {
            db.putRoster("another-operator", listOf(customer(9)))
            payments.insert(payment("p1", customerId(9), 10_000))
        }
        assertEquals("hidden before the sync", emptyList<Any>(), search("Customer 9"))
        assertNull(await { roster.syncStatus().first() }.lastUpdatedAt)

        val result = run()

        assertEquals(RosterSyncResult.Synced(fullSync = true, pages = 1, upserted = 2, removed = 0), result)
        assertNull(syncRequests().single().cursor)
        assertEquals(
            setOf(RosterFixtures.ramesh.id, RosterFixtures.sunita.id),
            await { db.customerDao().allIds() }.toSet(),
        )
        assertNotNull(await { payments.get("p1") })
        assertEquals(operatorId, meta().scope)
    }

    @Test
    fun `nothing is requested when nobody is signed in`() {
        val signedOut = TestNetwork(server, folder.newFolder())
        val idle = RosterSync(signedOut.mobileApi, signedOut.errors, signedOut.store, store)

        assertEquals(RosterSyncResult.NotSignedIn, await { idle.run() })
        assertEquals(emptyList<Any>(), syncRequests())
        signedOut.close()
    }

    @Test
    fun `a request during a sync makes it pull once more`() {
        syncAnswer = {
            if (syncRequests().size == 1) sync.markStale()
            page(RosterFixtures.page)
        }

        assertTrue(run() is RosterSyncResult.Synced)

        assertEquals(listOf(null, RosterFixtures.page.nextCursor), syncRequests().map { it.cursor })
    }

    @Test
    fun `the projected balance subtracts payments saved on the phone`() {
        run()
        await { payments.insert(payment("p1", RosterFixtures.ramesh.id, 100_000)) }

        val row = search("1045").single().balance
        assertEquals(90_000, row.serverBalancePaise)
        assertEquals(-10_000, row.balancePaise)
        assertEquals(0, row.duePaise)
        assertEquals(10_000, row.creditPaise)
        assertTrue(row.includesPhonePayments)
        val detail = await { roster.customer(RosterFixtures.ramesh.id).first() }!!
        assertEquals(row, detail.balance)
        assertEquals(1, await { roster.syncStatus().first() }.savedOnPhoneCount)
    }

    @Test
    fun `refreshing a customer stores the open bills, and CUSTOMER_NOT_FOUND drops the customer`() {
        run()
        val id = RosterFixtures.ramesh.id
        assertEquals(emptyList<Any>(), await { roster.customer(id).first() }!!.openBills)

        val fresh = await { roster.refreshCustomer(id) }

        assertTrue(fresh is ApiResult.Success)
        val detail = await { roster.customer(id).first() }!!
        val expected = Fixtures.decode(CustomerDetailResponse.serializer(), "getCustomer.response.json").openBills
        assertEquals(expected.map { it.invoiceNumber }, detail.openBills.map { it.invoiceNumber })
        assertEquals(listOf(45_000L, 45_000L), detail.openBills.map { it.outstandingPaise })
        assertEquals(2, detail.connections.size)
        assertEquals("/customers/$id", routes.requests.last().apiPath)

        detailAnswer = { Fixtures.response("error.CUSTOMER_NOT_FOUND.json") }
        val gone = await { roster.refreshCustomer(id) }

        assertTrue(gone is ApiResult.Failure)
        assertNull(await { roster.customer(id).first() })
    }

    @Test
    fun `refreshing offline keeps the cached customer`() {
        run()
        detailAnswer = { dropConnection() }

        val result = await { roster.refreshCustomer(RosterFixtures.ramesh.id) }

        assertTrue(((result as ApiResult.Failure).failure) is ApiFailure.Offline)
        assertEquals("1045", await { roster.customer(RosterFixtures.ramesh.id).first() }!!.customer.code)
    }

    private companion object {
        const val HTTP_OK = 200
    }
}
