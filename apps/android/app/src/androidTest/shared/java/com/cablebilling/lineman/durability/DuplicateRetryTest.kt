package com.cablebilling.lineman.durability

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.durability.DurabilityFixtures.draft
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PRD §15 #8 "…and is not duplicated when the sync request is retried": answers lost after the office
 * saved the payment, 503s, kills and reboots in between. The phone resends the identical items with
 * the same ids; the office answers `duplicate` and still has one payment each.
 */
@RunWith(AndroidJUnit4::class)
class DuplicateRetryTest : DurabilityTest() {
    @Test
    fun aLostAnswerIsResentWithIdenticalItems_andCountedOnce() {
        val ids = List(3) { app.saved(draft(code = 1400 + it, amountRupees = 200L + it)) }
        work.awaitQueued()
        office.loseAnswers()
        work.networkBlip()
        assertEquals("the office saved them", 3, office.posted().size)
        assertEquals("the phone does not know it", 3, app.countIn(PaymentState.SAVED_ON_PHONE))
        val firstSend = office.received.take(3)

        office.answerAgain()
        work.networkBack()

        assertEquals(ids, firstSend.map { it.id })
        val resent = office.received.drop(3)
        assertEquals(firstSend, resent.takeLast(3)) // byte-for-byte the same items
        assertEverythingAtTheOfficeOnce(3)
    }

    @Test
    fun theSamePaymentThroughLostAnswers503sKillsAndReboots_isOnePayment() {
        val id = app.saved(draft(amountRupees = 750))
        work.awaitQueued()
        repeat(ROUNDS) {
            office.loseAnswers()
            work.networkBlip()
            office.answerAgain()
            office.failNext = 1
            work.networkBlip()
            phone.restart()
        }
        assertEquals(PaymentState.SAVED_ON_PHONE, app.payment(id)!!.state)
        assertTrue(office.received.size >= ROUNDS)

        work.networkBack()

        assertEverythingAtTheOfficeOnce(1)
        assertTrue(office.received.all { it == office.received.first() })
        assertTrue(app.payment(id)!!.attemptCount > ROUNDS)
    }

    @Test
    fun aDoubleTapOnSave_isOnePayment() {
        val tapped = draft(amountRupees = 300)
        val results =
            await { coroutineScope { List(2) { async { app.repository.save(tapped) } }.awaitAll() } }
                .map { it as SaveResult.Saved }

        assertEquals(1, results.count { it.isNew })
        assertEquals(1, results.map { it.provisionalRef }.distinct().size)
        assertEquals(1, app.allPayments().size)
        work.awaitQueued()
        work.networkBack()
        assertEverythingAtTheOfficeOnce(1)
        assertEquals(1, office.received.size)
    }

    private companion object {
        const val ROUNDS = 3
    }
}
