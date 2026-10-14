package com.cablebilling.lineman.durability

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.durability.DurabilityFixtures.draft
import com.cablebilling.lineman.durability.DurabilityFixtures.suresh
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * PRD §15 #8 "an offline payment survives app restart": the app process dies at every awkward moment
 * around Save and the push, and a cold start on the same files finds every payment and sends it
 * exactly once. (On a phone this runs on the real SQLite, file system and Keystore; the kill itself is
 * simulated in-process. The field UAT script repeats it with a real force stop, swipe-away and reboot.)
 */
@RunWith(AndroidJUnit4::class)
class ProcessDeathTest : DurabilityTest() {
    @Test
    fun killedRightAfterSaveBeforeThePushWasAskedFor_theNextStartFindsAndSendsIt() {
        val id = app.saveWithoutPushRequest(draft()).let { (it as SaveResult.Saved).paymentId }
        phone.kill()
        assertTrue("nothing was queued before the app died", work.runs().isEmpty())

        val restarted = phone.start()
        assertEquals(suresh.id, (restarted.storedSession() as SessionState.SignedIn).session.user.id)
        val row = restarted.payment(id)!!
        assertEquals(PaymentState.SAVED_ON_PHONE, row.state)
        assertEquals("P-K7Q-0001", row.provisionalRef)
        work.appStart(restarted) // CableApplication.onCreate: PaymentSyncScheduler.start()
        work.awaitQueued()
        work.networkBack()

        assertEquals(1, office.received.size)
        assertEverythingAtTheOfficeOnce(1)
        assertEquals("P-K7Q-0001", app.payment(id)!!.provisionalRef) // the temporary number stays linked

        // Another cold start: nothing left, nothing sent again.
        val again = phone.restart()
        assertFalse(await { again.scheduler.pushIfOwnPayments(suresh.id) })
        assertEquals(1, office.received.size)
    }

    @Test
    fun killedWithThePushQueued_workManagerRunsItInTheNextProcess() {
        val id = app.saved(draft())
        work.awaitQueued()
        phone.kill()

        phone.start() // no screen, no start(): WorkManager starts the process for the queued work
        work.networkBack()

        assertEquals(PaymentState.SENT_TO_OFFICE, app.payment(id)!!.state)
        assertEverythingAtTheOfficeOnce(1)
    }

    @Test
    fun saveTappedAgainOnTheRestoredConfirmScreen_staysOnePayment() {
        // The Confirm step keeps the draft (and its id) in SavedStateHandle across process death.
        val confirm = draft(amountRupees = 450)
        val first = app.save(confirm) as SaveResult.Saved
        phone.restart()

        val second = app.save(confirm) as SaveResult.Saved
        assertFalse(second.isNew)
        assertEquals(first.paymentId, second.paymentId)
        assertEquals(first.provisionalRef, second.provisionalRef)
        assertEquals(1, app.allPayments().size)

        work.awaitQueued()
        work.networkBack()
        assertEverythingAtTheOfficeOnce(1)
    }

    @Test
    fun aDayOfSavesAndKills_losesNothingAndNeverRepeatsATemporaryNumber() {
        office.airplaneMode = true
        val amounts = mutableListOf<Long>()
        repeat(KILLS) { round ->
            repeat(SAVES_PER_ROUND) { n ->
                phone.clock.advanceMinutes(5)
                val rupees = 100L + round * 10 + n
                app.saved(draft(code = 1000 + round * SAVES_PER_ROUND + n, amountRupees = rupees))
                amounts += rupees * DurabilityFixtures.PAISE_PER_RUPEE
            }
            phone.restart()
        }

        val rows = app.allPayments()
        assertEquals(KILLS * SAVES_PER_ROUND, rows.size)
        assertEquals((1..KILLS * SAVES_PER_ROUND).map { "P-K7Q-%04d".format(it) }, rows.map { it.provisionalRef })
        assertEquals(amounts, rows.map { it.amountPaise })
        assertEquals(rows.size, app.onPhoneCount())

        office.airplaneMode = false
        work.awaitQueued()
        work.networkBack()
        assertEverythingAtTheOfficeOnce(KILLS * SAVES_PER_ROUND)
        assertEquals(amounts.sum(), office.posted().sumOf { it.amountPaise })
    }

    @Test
    fun killedAfterTheOfficeSavedABatchButBeforeThePhoneStoredTheAnswer_postedOnce() {
        // Saved without the background push request, then one push queued: no run can start mid-way.
        repeat(MANY) { app.saveWithoutPushRequest(draft(code = 2000 + it, amountRupees = 100L + it)) }
        assertTrue(await { app.scheduler.enqueue() })
        office.loseAnswersFromBatch = 2 // batch 2 (of 50) is saved at the office, its answer never arrives
        work.networkBlip()
        assertEquals(BATCH, app.countIn(PaymentState.SENT_TO_OFFICE))
        assertEquals(2 * BATCH, office.posted().size)
        val firstSecondBatch = office.received.subList(BATCH, 2 * BATCH).toList()
        phone.kill() // before the retry

        office.answerAgain()
        phone.start()
        work.networkBack()

        assertEverythingAtTheOfficeOnce(MANY)
        // Batch 2 went again with identical items (answered as duplicates), so the office read more
        // items than it saved: never a second payment.
        assertTrue(office.received.size >= MANY + BATCH)
        val resent = office.received.filter { item -> firstSecondBatch.any { it.id == item.id } }
        assertTrue(resent.size >= 2 * BATCH)
        assertTrue(resent.all { item -> item == firstSecondBatch.single { it.id == item.id } })
        assertEquals(office.batches.size, office.batches.count { it <= BATCH })
    }

    private companion object {
        const val KILLS = 8
        const val SAVES_PER_ROUND = 3
        const val MANY = 120
        const val BATCH = 50
    }
}
