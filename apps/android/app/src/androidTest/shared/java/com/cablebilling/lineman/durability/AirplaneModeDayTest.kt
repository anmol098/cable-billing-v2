package com.cablebilling.lineman.durability

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.durability.DurabilityFixtures.DAY
import com.cablebilling.lineman.durability.DurabilityFixtures.PAISE_PER_RUPEE
import com.cablebilling.lineman.durability.DurabilityFixtures.draft
import com.cablebilling.lineman.durability.DurabilityFixtures.suresh
import kotlinx.coroutines.flow.first
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A whole collection day without internet (PLAN §16 "airplane-mode collection"): 60 payments from 9:00
 * to 17:00 India time, cash and UPI, the phone now and then seeing a network that does not reach the
 * office, the app killed twice. Nothing reaches the office and nothing is lost during the day; in the
 * evening every payment reaches the office once, oldest first, in batches of at most 50.
 */
@RunWith(AndroidJUnit4::class)
class AirplaneModeDayTest : DurabilityTest() {
    @Test
    fun aWholeDayInAirplaneMode_everyPaymentStaysOnThePhoneAndReachesTheOfficeOnceInTheEvening() {
        office.airplaneMode = true
        val expected = mutableListOf<Expected>()
        for (n in 1..PAYMENTS) {
            phone.clock.advanceMinutes(MINUTES_BETWEEN)
            val upi = n % UPI_EVERY == 0
            val rupees = 100L + n * 10
            val id =
                app.saved(
                    draft(
                        code = 3000 + n,
                        amountRupees = rupees,
                        method = if (upi) PaymentMethod.UPI else PaymentMethod.CASH,
                        upiReference = if (upi) "4123456789$n" else null,
                    ),
                )
            expected += Expected(id, rupees * PAISE_PER_RUPEE, upi)
            if (n % BLIP_EVERY == 0) {
                work.awaitQueued()
                work.networkBlip() // a bar of signal, or Wi-Fi without internet: tried, failed, kept
            }
            if (n % KILL_EVERY == 0) phone.restart()
        }

        // During the day: everything on the phone, counted for Today and the Waiting badge.
        assertTrue(office.posted().isEmpty())
        assertTrue(office.received.isEmpty())
        assertTrue(office.unreachable > 0)
        assertEquals(PAYMENTS, app.onPhoneCount())
        val today =
            await {
                app.db
                    .paymentDao()
                    .observeDay(suresh.id, DAY)
                    .first()
            }
        assertEquals(PAYMENTS, today.size)
        val (upiToday, cashToday) = today.partition { it.method == PaymentMethod.UPI }
        assertEquals(expected.filterNot { it.upi }.sumOf { it.paise }, cashToday.sumOf { it.amountPaise })
        assertEquals(expected.filter { it.upi }.sumOf { it.paise }, upiToday.sumOf { it.amountPaise })
        assertTrue(today.all { it.state == PaymentState.SAVED_ON_PHONE && it.businessDate == DAY })

        // Evening: airplane mode off.
        office.airplaneMode = false
        work.awaitQueued()
        work.networkBack()

        assertEverythingAtTheOfficeOnce(PAYMENTS)
        assertEquals("nothing was sent twice: no answer was lost", PAYMENTS, office.received.size)
        assertEquals("oldest first", expected.map { it.id }, office.received.map { it.id })
        assertEquals(listOf(50, PAYMENTS - 50), office.batches)
        assertEquals(expected.sumOf { it.paise }, office.posted().sumOf { it.amountPaise })
        assertEquals(0, app.onPhoneCount())
        assertEquals(
            (1..PAYMENTS).map { "P-K7Q-%04d".format(it) },
            app.allPayments().map { it.provisionalRef },
        )
    }

    private data class Expected(
        val id: String,
        val paise: Long,
        val upi: Boolean,
    )

    private companion object {
        const val PAYMENTS = 60
        const val MINUTES_BETWEEN = 8L // 60 × 8 min: 9:08 to 17:00 India time, one business day
        const val UPI_EVERY = 4
        const val BLIP_EVERY = 15
        const val KILL_EVERY = 25
    }
}
