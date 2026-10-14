package com.cablebilling.lineman.durability

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.durability.DurabilityFixtures.draft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device reboots with payments on the phone (PLAN §16 "reboot"). A reboot kills the app process;
 * WorkManager keeps its queue in its own database and starts the queued push again once the network
 * constraint is met, in a fresh process that only has the files. The driver plays the network; the
 * office decides whether it is reachable.
 */
@RunWith(AndroidJUnit4::class)
class RebootTest : DurabilityTest() {
    @Test
    fun aPushQueuedBeforeARebootRunsAfterIt_inAProcessThatOnlyHasTheFiles() {
        office.airplaneMode = true
        val ids = List(3) { app.saved(draft(code = 1100 + it)) }
        work.awaitQueued()

        phone.kill() // reboot: the app is gone, WorkManager's queue stays
        office.airplaneMode = false
        phone.start() // started by WorkManager after boot, no screen
        assertTrue(app.storedSession() is SessionState.SignedIn) // the sealed sign-in opens after the reboot
        assertTrue(work.isQueued())
        work.networkBack()

        assertEquals(ids, app.allPayments().map { it.id })
        assertEverythingAtTheOfficeOnce(3)
    }

    @Test
    fun rebootsWhileTheOfficeCannotBeReached_loseNothingAndSendNothing() {
        office.airplaneMode = true
        val ids = List(2) { app.saved(draft(code = 1200 + it)) }
        work.awaitQueued()
        repeat(REBOOTS) {
            work.networkBlip() // the phone sees a network (Wi-Fi without internet): the push fails, retried later
            phone.restart()
        }

        assertTrue(office.unreachable >= REBOOTS)
        assertTrue(office.posted().isEmpty())
        assertEquals(ids, app.allPayments().map { it.id })
        assertTrue(app.allPayments().all { it.state == PaymentState.SAVED_ON_PHONE && it.attemptCount >= 1 })
        assertTrue("the push is still queued after the reboots", work.isQueued())

        office.airplaneMode = false
        work.networkBack()
        assertEquals(ids.size, office.received.size)
        assertEverythingAtTheOfficeOnce(ids.size)
    }

    @Test
    fun aPhoneThatLostItsScheduledPush_sendsAtTheNextAppStart() {
        val ids = List(2) { app.saved(draft(code = 1300 + it)) }
        work.awaitQueued()
        phone.kill()
        // Force stop (or an OEM "cleaner") cancels the app's jobs: WorkManager's queue is gone.
        work.install()
        assertTrue(work.runs().isEmpty())

        val restarted = phone.start()
        work.appStart(restarted) // the lineman opens the app
        work.awaitQueued()
        work.networkBack()

        assertEquals(ids, app.allPayments().map { it.id })
        assertEverythingAtTheOfficeOnce(2)
    }

    private companion object {
        const val REBOOTS = 3
    }
}
