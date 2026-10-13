package com.cablebilling.lineman.data.db

import android.database.sqlite.SQLiteConstraintException
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.RosterFixtures.customer
import com.cablebilling.lineman.data.db.RosterFixtures.customerId
import com.cablebilling.lineman.data.db.RosterFixtures.payment
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.generated.AreaRef
import com.cablebilling.lineman.data.network.generated.RosterCustomer
import kotlinx.coroutines.flow.first
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import kotlin.system.measureTimeMillis

/**
 * The DAOs on a real (Robolectric) SQLite: number-pad and name search, ranking, the projected
 * balance rule, customer detail, and the payment queue's guarantees.
 */
@RunWith(AndroidJUnit4::class)
class RosterDaoTest {
    private val db = inMemoryDatabase()
    private val customers = db.customerDao()
    private val payments = db.paymentDao()

    @After
    fun tearDown() = db.close()

    private fun put(vararg list: RosterCustomer) = await { db.putRoster("op", list.toList()) }

    private fun digits(query: String) = await { customers.searchByDigits(query, 50).first() }

    private fun name(query: String) =
        await { customers.searchByName(SearchText.escapeLike(SearchText.normaliseText(query)), 50).first() }

    @Test
    fun `digits match any part of the code, a phone or a VC number`() {
        put(RosterFixtures.ramesh, RosterFixtures.sunita)

        assertEquals(listOf("1045"), digits("1045").map { it.code })
        assertEquals(listOf("1045"), digits("4321").map { it.code }) // phone 9876543210
        assertEquals(listOf("1045"), digits("456790").map { it.code }) // second VC
        assertEquals(listOf("1046"), digits("450001").map { it.code }) // Sunita's VC
        assertEquals(listOf("1045", "1046"), digits("104").map { it.code })
        assertEquals(emptyList<String>(), digits("99999"))
    }

    @Test
    fun `a match never spans two numbers`() {
        // Code 1045 followed by phone 9876543210: "459876" only exists across the boundary.
        put(RosterFixtures.ramesh)
        assertEquals(emptyList<CustomerSearchRow>(), digits("459876"))
    }

    @Test
    fun `phones are matched on their digits only`() {
        put(customer(1, phone = "+91 98765-11111"))
        assertEquals(1, digits("9876511111").size)
        assertEquals(1, digits("919876").size)
    }

    @Test
    fun `exact code first, then a whole phone or VC, then a number starting with it, then the rest`() {
        put(
            customer(1, code = "5005", name = "A contains", phone = "9800170019"),
            customer(2, code = "7002", name = "B starts", phone = "7001555555"),
            customer(3, code = "7001", name = "C exact"),
            customer(4, code = "7003", name = "D whole VC", vcNumbers = listOf("7001")),
        )

        assertEquals(listOf("C exact", "D whole VC", "B starts", "A contains"), digits("7001").map { it.name })
    }

    @Test
    fun `name search ignores case and spacing, matches inside words, and escapes wildcards`() {
        put(
            RosterFixtures.ramesh,
            RosterFixtures.sunita,
            customer(3, name = "रमेश  यादव"),
            customer(4, name = "100% Cable_Shop"),
        )

        assertEquals(listOf("Ramesh Kumar"), name("RAMESH").map { it.name })
        assertEquals(listOf("Sunita Devi"), name("devi").map { it.name })
        assertEquals(listOf("रमेश  यादव"), name("रमेश यादव").map { it.name })
        assertEquals(listOf("100% Cable_Shop"), name("0% c").map { it.name })
        assertEquals(listOf("100% Cable_Shop"), name("e_s").map { it.name })
        assertEquals(emptyList<CustomerSearchRow>(), name("e%s"))
        // Names starting with the text come before names that only contain it.
        put(customer(5, name = "Kumar Singh"))
        assertEquals(listOf("Kumar Singh", "Ramesh Kumar"), name("kumar").map { it.name })
    }

    @Test
    fun `a search row carries the area and the unsynced payments`() {
        put(RosterFixtures.ramesh)
        await { payments.insert(payment("p1", RosterFixtures.ramesh.id, 20_000)) }

        val row = digits("1045").single()
        assertEquals("Shiv Nagar", row.areaName)
        assertEquals(90_000, row.balancePaise)
        assertEquals(20_000, row.pendingPaise)
        assertEquals(1, row.pendingCount)
    }

    @Test
    fun `pending = on the phone, or posted after the roster row was last updated`() {
        val ramesh = RosterFixtures.ramesh // updated_at 2026-10-01T00:20:11Z
        put(ramesh)
        val rowUpdated = Instant.parse(ramesh.updatedAt).toEpochMilli()
        await {
            payments.insert(payment("p1", ramesh.id, 10_000))
            payments.insert(payment("p2", ramesh.id, 20_000, PaymentState.SENT_TO_OFFICE, postedAt = rowUpdated + 1))
            // Already in the server balance the roster has.
            payments.insert(payment("p3", ramesh.id, 40_000, PaymentState.SENT_TO_OFFICE, postedAt = rowUpdated))
            // Rejected: the office sorts it out; not subtracted.
            payments.insert(payment("p4", ramesh.id, 80_000, PaymentState.NEEDS_OFFICE_HELP))
            // Another customer's payment.
            payments.insert(payment("p5", RosterFixtures.sunita.id, 5_000))
        }

        val detail = await { customers.observeDetail(ramesh.id).first() }!!
        assertEquals(30_000, detail.pendingPaise)
        assertEquals(2, detail.pendingCount)
    }

    @Test
    fun `customer detail has connections and cached bills`() {
        put(RosterFixtures.ramesh)
        await {
            db.rosterWriteDao().insertOpenBills(
                listOf(
                    OpenBillEntity("b1", RosterFixtures.ramesh.id, "INV-1", "regular", "2026-09-01", 45_000, 45_000, 0),
                ),
            )
        }

        val detail = await { customers.observeDetail(RosterFixtures.ramesh.id).first() }!!
        assertEquals("1045", detail.customer.code)
        assertEquals(
            listOf("000123456789", "000123456790"),
            detail.connections.sortedBy { it.position }.map { it.vcNumber },
        )
        assertEquals(listOf("active", "suspended"), detail.connections.sortedBy { it.position }.map { it.status })
        assertEquals(listOf("INV-1"), detail.openBills.map { it.invoiceNumber })
        assertEquals(0, detail.pendingCount)
        assertNull(await { customers.observeDetail("unknown").first() })
    }

    @Test
    fun `the search Flow updates when a payment is saved`() {
        put(RosterFixtures.ramesh)
        val flow = customers.searchByDigits("1045", 50)
        assertEquals(0, await { flow.first() }.single().pendingPaise)

        await { payments.insert(payment("p1", RosterFixtures.ramesh.id, 45_000)) }

        assertEquals(45_000, await { flow.first() }.single().pendingPaise)
    }

    @Test
    fun `a payment id or provisional ref is never saved twice`() {
        await { payments.insert(payment("p1", RosterFixtures.ramesh.id, 1_000)) }
        try {
            await { payments.insert(payment("p1", RosterFixtures.ramesh.id, 2_000)) }
            fail("same id inserted twice")
        } catch (expected: SQLiteConstraintException) {
            // The first row stays as it was.
        }
        try {
            await { payments.insert(payment("p2", RosterFixtures.ramesh.id, 2_000).copy(provisionalRef = "P-K7Q-p1")) }
            fail("same provisional ref inserted twice")
        } catch (expected: SQLiteConstraintException) {
            // Kept unique.
        }
        assertEquals(1_000, await { payments.get("p1") }!!.amountPaise)
    }

    @Test
    fun `queue reads oldest first and counts what is still on the phone`() {
        await {
            payments.insert(payment("b", "c1", 1_000, recordedAt = 2_000))
            payments.insert(payment("a", "c1", 1_000, recordedAt = 1_000))
            payments.insert(payment("c", "c1", 1_000, PaymentState.SENT_TO_OFFICE, postedAt = 5))
            payments.insert(payment("d", "c1", 1_000, PaymentState.NEEDS_OFFICE_HELP))
        }

        assertEquals(listOf("a", "b"), await { payments.oldestSavedOnPhone(50) }.map { it.id })
        assertEquals(2, await { payments.observeSavedOnPhoneCount().first() })
        assertEquals(setOf("a", "b", "d"), await { payments.observeNotSent().first() }.map { it.id }.toSet())
        assertEquals(
            4,
            await { payments.observeDay("01929a3e-5b10-7c4e-8a01-000000000002", "2026-10-13").first() }.size,
        )
    }

    @Test
    fun `payment method is stored as its wire value`() {
        await { payments.insert(payment("p1", "c1", 1_000)) }
        val cursor = db.openHelper.readableDatabase.query("SELECT method, state FROM payments")
        cursor.use {
            assertTrue(it.moveToFirst())
            assertEquals("cash", it.getString(0))
            assertEquals("SAVED_ON_PHONE", it.getString(1))
        }
    }

    @Test
    fun `searching a 7,616-customer roster by 4 digits stays fast`() {
        // The largest legacy operator snapshot (PRD: 7,616 customers). Robolectric's SQLite on a busy CI
        // machine is no phone, so the bound is loose; T-065 measures on a low-end emulator profile.
        val roster =
            (1..7_616).map { n ->
                customer(n, code = n.toString(), name = "Customer $n", phone = "9%09d".format(n * 7L))
                    .copy(area = AreaRef("a${n % 40}", "Area ${n % 40}"))
            }
        await { db.putRoster("op", roster) }

        repeat(3) { digits("4521") } // warm up
        val results: List<CustomerSearchRow>
        val millis = measureTimeMillis { results = digits("4521") }

        assertEquals("4521", results.first().code)
        assertTrue(results.size in 2..50)
        assertTrue("4-digit search took $millis ms", millis < 1_000)
        println("4-digit search over ${roster.size} customers: $millis ms")
        assertEquals(customerId(4521), results.first().id)
    }
}
