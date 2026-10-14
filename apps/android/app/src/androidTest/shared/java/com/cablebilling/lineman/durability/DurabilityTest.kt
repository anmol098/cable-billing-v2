package com.cablebilling.lineman.durability

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.cablebilling.lineman.data.db.PaymentState
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * Base of the durability scenarios (PRD §15 #8, PLAN §16): one [phone] with a signed-in lineman
 * (Suresh), the [office] behind a MockWebServer, and WorkManager driven by its test driver ([work]).
 * Each test is a field story: save, kill, reboot, lose the network, lose answers, and then checks
 * that every payment is still on the phone and reaches the office exactly once.
 */
abstract class DurabilityTest {
    @get:Rule
    val folder = TemporaryFolder()

    protected val context: Context = ApplicationProvider.getApplicationContext()
    protected val office = FakeOffice()
    private val server = MockWebServer()
    protected lateinit var phone: Phone
    protected val work = PushWork(context) { phone }

    /** The app process running now. */
    protected val app: PhoneProcess get() = phone.process

    @Before
    fun startPhone() {
        server.dispatcher = office
        server.start()
        work.install()
        // "localhost": the dev flavour's network security config allows plain HTTP only to it (and 10.0.2.2).
        val baseUrl =
            server
                .url(FakeOffice.API_PREFIX + "/")
                .newBuilder()
                .host("localhost")
                .build()
        phone = Phone(context, folder.newFolder("phone"), baseUrl)
        phone.start().signIn()
    }

    @After
    fun stopPhone() {
        phone.forget()
        server.close()
    }

    /** Every payment of the phone reached the office exactly once, with the office's receipt number. */
    protected fun assertEverythingAtTheOfficeOnce(expected: Int) {
        val rows = app.allPayments()
        assertEquals("payments on the phone", expected, rows.size)
        assertEquals("payments the office saved", expected, office.posted().size)
        assertEquals("the office never saw a changed payment", 0, office.reusedIds)
        rows.forEach { row ->
            assertEquals(row.provisionalRef, PaymentState.SENT_TO_OFFICE, row.state)
            assertEquals(row.provisionalRef, office.receiptOf(row.id), row.receiptNumber)
        }
        val posted = office.posted().associateBy { it.id }
        rows.forEach { row ->
            val item = posted.getValue(row.id)
            assertEquals(row.amountPaise, item.amountPaise)
            assertEquals(row.provisionalRef, item.provisionalRef)
            assertEquals(row.collectorId, item.collectorId)
        }
    }
}
