package com.cablebilling.lineman.feature.today

import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import com.cablebilling.lineman.feature.today.TodayFixtures.officeDay
import com.cablebilling.lineman.feature.today.TodayFixtures.officePayment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Discrepancy, reasons and the request sent with a handover; the handover's state as Today shows it. */
class HandoverRulesTest {
    private val plan =
        HandoverPlan(
            expectedPaise = 80_000,
            officeCashPaise = 70_000,
            notInOfficeCashPaise = 10_000,
            unsyncedCount = 1,
            unsyncedCashPaise = 10_000,
            source = TotalsSource.OfficeAndPhone,
        )
    private val allAtOffice =
        plan.copy(
            expectedPaise = 70_000,
            notInOfficeCashPaise = 0,
            unsyncedCount = 0,
            unsyncedCashPaise = 0,
        )

    @Test
    fun `discrepancy is handed over minus expected, and the reason tiles follow its sign`() {
        assertEquals(-5_000, HandoverRules.discrepancy(75_000, 80_000))
        assertEquals(5_000, HandoverRules.discrepancy(85_000, 80_000))
        assertEquals(0, HandoverRules.discrepancy(80_000, 80_000))
        assertEquals(SHORT_REASONS, HandoverRules.reasonsFor(-5_000))
        assertEquals(
            listOf(DiscrepancyReason.EXTRA, DiscrepancyReason.PENDING_SYNC, DiscrepancyReason.OTHER),
            HandoverRules.reasonsFor(5_000),
        )
        assertTrue(HandoverRules.reasonsFor(0).isEmpty())
    }

    @Test
    fun `matching cash with nothing on the phone sends no reason`() {
        val request = HandoverRules.request(ID, 70_000, null, "  ", allAtOffice)!!
        assertEquals(HandoverRequest(ID, 70_000, null, null, 0, 0), request)
    }

    @Test
    fun `matching the phone's count while cash is still on the phone sends pending_sync`() {
        // The office's total lacks the cash still on the phone, so it is lower than the handover.
        val request = HandoverRules.request(ID, 80_000, null, null, plan)!!
        assertEquals(DiscrepancyReason.PENDING_SYNC, request.discrepancyReason)
        assertEquals(1L, request.unsyncedPaymentCount)
        assertEquals(10_000L, request.unsyncedCashPaise)
        // This is the contract's own example (submitHandover.request.json): ₹800 against the office's ₹700.
        assertEquals(80_000L, request.cashHandedOverPaise)
    }

    @Test
    fun `a different amount needs a reason that fits its sign, and the note is trimmed and optional`() {
        assertNull(HandoverRules.request(ID, 75_000, null, null, plan))
        assertNull(HandoverRules.request(ID, 75_000, DiscrepancyReason.EXTRA, null, plan))
        val short = HandoverRules.request(ID, 75_000, DiscrepancyReason.SHORT, "  gave ₹50 change  ", plan)!!
        assertEquals(DiscrepancyReason.SHORT, short.discrepancyReason)
        assertEquals("gave ₹50 change", short.note)
        val long = HandoverRules.request(ID, 85_000, DiscrepancyReason.OTHER, "x".repeat(600), plan)!!
        assertEquals(HandoverRules.MAX_NOTE_LENGTH, long.note!!.length)
    }

    @Test
    fun `the state follows the newest truth - accepted is final, then the phone's handover, then the office`() {
        val handover =
            Handover(
                ID,
                70_000,
                60_000,
                -10_000,
                DiscrepancyReason.SHORT,
                null,
                0,
                0,
                "2026-10-13T12:00:00.000Z",
                null,
                null,
            )
        val office = officeDay(listOf(officePayment("a", 70_000)))
        val waiting = QueuedHandover(HandoverRequest(OTHER_ID, 70_000, null, null, 0, 0), queuedAt = 1)

        assertEquals(HandoverView.NotYet, HandoverView.of(null, null, sending = false))
        assertEquals(HandoverView.NotYet, HandoverView.of(office, null, sending = false))
        assertEquals(HandoverView.OnPhone(70_000, sending = true), HandoverView.of(office, waiting, sending = true))
        assertEquals(
            HandoverView.Refused(70_000, "server:VALIDATION"),
            HandoverView.of(
                office,
                waiting.copy(state = QueuedHandoverState.REFUSED, lastErrorCode = "server:VALIDATION"),
                false,
            ),
        )
        val submitted = office.copy(status = HandoverStatus.SUBMITTED, handover = handover)
        assertEquals(HandoverView.Submitted(handover), HandoverView.of(submitted, null, false))
        val returned =
            office.copy(
                status = HandoverStatus.RETURNED,
                handover = handover.copy(reviewNote = "Count again"),
            )
        assertEquals(HandoverView.SentBack(returned.handover!!), HandoverView.of(returned, null, false))
        // Sent back, then handed over again on the phone: the new one shows until the office has it.
        assertEquals(HandoverView.OnPhone(70_000, sending = false), HandoverView.of(returned, waiting, false))
        val accepted = office.copy(status = HandoverStatus.ACCEPTED, handover = handover)
        assertEquals(HandoverView.Accepted(handover), HandoverView.of(accepted, waiting, false))
        assertFalse(HandoverView.Accepted(handover).canHandOver)
        assertTrue(HandoverView.SentBack(handover).canHandOver)
    }

    private companion object {
        const val ID = "0192ab00-0000-7000-8000-000000000001"
        const val OTHER_ID = "0192ab00-0000-7000-8000-000000000002"
    }
}
