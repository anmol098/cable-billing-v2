package com.cablebilling.lineman.durability

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.payments.isHeldFor
import com.cablebilling.lineman.durability.DurabilityFixtures.draft
import com.cablebilling.lineman.durability.DurabilityFixtures.mohan
import com.cablebilling.lineman.durability.DurabilityFixtures.suresh
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Two linemen on one phone, one of them switched off by the office (PLAN §9.2, T-066/T-071): a
 * lineman's payments never leave under another lineman's sign-in, survive restarts while held, and go
 * once when their own lineman signs in again. Sign-out (for any reason, including a phone whose
 * Keystore lost the key that seals the sign-in) never deletes a payment.
 */
@RunWith(AndroidJUnit4::class)
class SharedPhoneTest : DurabilityTest() {
    @Test
    fun aSwitchedOffLinemansPaymentsStayHeldAcrossRestarts_andGoOnceWithTheirOwnSignIn() {
        office.airplaneMode = true
        val sureshs = List(2) { app.saved(draft(code = 1500 + it)) }
        work.awaitQueued()

        // The office switches Suresh off. The next push ends his session; his payments stay.
        office.disabledLogins += suresh.login
        office.airplaneMode = false
        work.networkBlip()
        assertEquals(SessionState.SignedOut(SignOutReason.ACCOUNT_DISABLED), app.storedSession())
        assertTrue(office.posted().isEmpty())
        phone.restart()
        assertEquals(sureshs, app.allPayments().map { it.id })
        assertTrue(app.storedSession() is SessionState.SignedOut)

        // Mohan signs in on the same phone and collects. Only his payment leaves.
        app.signIn(mohan)
        val mohans = app.saved(draft(code = 1600))
        work.awaitQueued()
        work.networkBack()
        assertEquals(listOf(mohans), office.posted().map { it.id })
        assertEquals(mohan.id, office.posted().single().collectorId)
        val held = app.allPayments().filter { it.isHeldFor(mohan.id) }
        assertEquals(sureshs, held.map { it.id })
        phone.restart()
        assertEquals(2, app.countIn(PaymentState.SAVED_ON_PHONE))

        // The office switches Suresh on again; Mohan signs out (nothing of his on the phone), Suresh signs in.
        office.disabledLogins -= suresh.login
        await { app.sessions.end(SignOutReason.SIGNED_OUT) }
        app.signIn(suresh)
        assertTrue(await { app.scheduler.pushIfOwnPayments(suresh.id) })
        work.networkBack()

        assertEverythingAtTheOfficeOnce(3)
        assertEquals(
            sureshs.toSet(),
            office
                .posted()
                .filter { it.collectorId == suresh.id }
                .map { it.id }
                .toSet(),
        )
        assertEquals(3, office.received.size)
    }

    @Test
    fun theKeyStoreLosesItsKey_theLinemanSignsInAgainAndThePaymentsAreStillThere() {
        office.airplaneMode = true
        val ids = List(2) { app.saved(draft(code = 1700 + it)) }
        work.awaitQueued()

        phone.kill()
        phone.loseKey() // some phones reset their Keystore (OS update, lock screen removed)
        phone.start()
        assertEquals(SessionState.SignedOut(SignOutReason.STORAGE_RESET), app.storedSession())
        assertEquals(ids, app.allPayments().map { it.id })

        app.signIn(suresh)
        office.airplaneMode = false
        work.networkBack()
        assertEverythingAtTheOfficeOnce(2)
    }
}
