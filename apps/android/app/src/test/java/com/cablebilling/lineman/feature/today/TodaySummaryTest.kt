package com.cablebilling.lineman.feature.today

import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.feature.today.TodayFixtures.DATE
import com.cablebilling.lineman.feature.today.TodayFixtures.OTHER_USER
import com.cablebilling.lineman.feature.today.TodayFixtures.officeDay
import com.cablebilling.lineman.feature.today.TodayFixtures.officePayment
import com.cablebilling.lineman.feature.today.TodayFixtures.payment
import com.cablebilling.lineman.feature.today.TodayFixtures.userId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.lang.reflect.Modifier
import java.time.Instant

/**
 * The Today totals (PLAN §8.7, PRD §15 #12): cash and UPI never mixed, payments on the phone labelled,
 * another lineman's held payments and other India-time days left out, the office's numbers combined
 * with what it does not have yet, cancelled payments counted nowhere.
 */
class TodaySummaryTest {
    @Test
    fun `cash and UPI are kept apart and there is no total that adds them`() {
        val summary =
            summarizeDay(
                userId,
                DATE,
                listOf(
                    payment("a", 50_000),
                    payment("b", 45_000, PaymentMethod.UPI),
                    payment("c", 20_000, state = PaymentState.SENT_TO_OFFICE),
                    payment("d", 10_000, PaymentMethod.UPI, state = PaymentState.SENT_TO_OFFICE),
                ),
                null,
            )
        assertEquals(MethodTotals(cashPaise = 70_000, upiPaise = 55_000, count = 4), summary.day)
        assertEquals(70_000, summary.cashToHandOverPaise)
        assertEquals(MethodTotals(cashPaise = 50_000, upiPaise = 45_000, count = 2), summary.onPhone)
        assertEquals(TotalsSource.PhoneOnly, summary.source)
        // The type itself has no "total of both" to show by mistake.
        val fields = MethodTotals::class.java.declaredFields.filterNot { Modifier.isStatic(it.modifiers) }
        assertEquals(setOf("cashPaise", "upiPaise", "count"), fields.map { it.name }.toSet())
    }

    @Test
    fun `another lineman's held payments on a shared phone and other days are not this lineman's`() {
        val summary =
            summarizeDay(
                userId,
                DATE,
                listOf(
                    payment("mine", 30_000),
                    payment("held", 90_000, collectorId = OTHER_USER),
                    payment("heldUpi", 40_000, PaymentMethod.UPI, collectorId = OTHER_USER),
                    payment("yesterday", 70_000, recordedAt = Instant.parse("2026-10-12T10:00:00Z").toEpochMilli()),
                ),
                null,
            )
        assertEquals(MethodTotals(cashPaise = 30_000, count = 1), summary.day)
        assertEquals(MethodTotals(cashPaise = 30_000, count = 1), summary.onPhone)
        assertEquals(listOf("mine"), summary.rows.map { it.id })
        assertEquals(30_000, HandoverPlan.from(summary).unsyncedCashPaise)
        assertEquals(1, HandoverPlan.from(summary).unsyncedCount)
    }

    @Test
    fun `the day is the India-time day - 23-59-59 IST is the day before 00-00 IST`() {
        val lastSecond = Instant.parse("2026-10-12T18:29:59Z").toEpochMilli() // 12 Oct 23:59:59 IST
        val midnight = Instant.parse("2026-10-12T18:30:00Z").toEpochMilli() // 13 Oct 00:00:00 IST
        val endOfDay = Instant.parse("2026-10-13T18:29:59Z").toEpochMilli() // 13 Oct 23:59:59 IST
        val nextDay = Instant.parse("2026-10-13T18:30:00Z").toEpochMilli() // 14 Oct 00:00 IST
        val payments =
            listOf(
                payment("late", 10_000, recordedAt = lastSecond),
                payment("first", 20_000, recordedAt = midnight),
                payment("last", 40_000, PaymentMethod.UPI, recordedAt = endOfDay),
                payment("tomorrow", 80_000, recordedAt = nextDay),
            )
        assertEquals("2026-10-12", payments[0].businessDate)
        val today = summarizeDay(userId, DATE, payments, null)
        assertEquals(MethodTotals(cashPaise = 20_000, upiPaise = 40_000, count = 2), today.day)
        assertEquals(listOf("last", "first"), today.rows.map { it.id })
        assertEquals(
            MethodTotals(cashPaise = 10_000, count = 1),
            summarizeDay(userId, "2026-10-12", payments, null).day,
        )
        assertEquals(
            MethodTotals(cashPaise = 80_000, count = 1),
            summarizeDay(userId, "2026-10-14", payments, null).day,
        )
    }

    @Test
    fun `with the office's answer - office totals plus what it does not have yet, cancelled counted nowhere`() {
        val office =
            officeDay(
                listOf(
                    officePayment("sent-1", 50_000),
                    officePayment("sent-2", 45_000, PaymentMethod.UPI),
                    officePayment("cancelled", 30_000, reversed = true),
                    officePayment("other-phone", 20_000),
                ),
            )
        val summary =
            summarizeDay(
                userId,
                DATE,
                listOf(
                    payment("sent-1", 50_000, state = PaymentState.SENT_TO_OFFICE),
                    payment("sent-2", 45_000, PaymentMethod.UPI, state = PaymentState.SENT_TO_OFFICE),
                    payment("cancelled", 30_000, state = PaymentState.SENT_TO_OFFICE),
                    // Sent after the office's answer: not in its list yet, so it is added.
                    payment("just-sent", 5_000, state = PaymentState.SENT_TO_OFFICE),
                    payment("on-phone", 10_000),
                    payment("on-phone-upi", 15_000, PaymentMethod.UPI),
                    payment("refused", 7_000, state = PaymentState.NEEDS_OFFICE_HELP),
                ),
                office,
            )
        assertEquals(TotalsSource.OfficeAndPhone, summary.source)
        assertEquals(MethodTotals(cashPaise = 70_000, upiPaise = 45_000, count = 3), summary.office!!.totals)
        assertEquals(MethodTotals(cashPaise = 22_000, upiPaise = 15_000, count = 4), summary.notInOffice)
        assertEquals(MethodTotals(cashPaise = 92_000, upiPaise = 60_000, count = 7), summary.day)
        assertEquals(MethodTotals(cashPaise = 10_000, upiPaise = 15_000, count = 2), summary.onPhone)
        assertEquals(MethodTotals(cashPaise = 7_000, count = 1), summary.problems)
        val statuses = summary.rows.associate { it.id to it.status }
        assertEquals(DayRowStatus.Cancelled, statuses["cancelled"])
        assertEquals(DayRowStatus.Sent, statuses["other-phone"])
        assertEquals(DayRowStatus.Sent, statuses["just-sent"])
        assertEquals(DayRowStatus.OnPhone, statuses["on-phone"])
        assertEquals(DayRowStatus.Problem, statuses["refused"])
        assertEquals("R-2610-ent-1", summary.rows.first { it.id == "sent-1" }.reference)

        val plan = HandoverPlan.from(summary)
        assertEquals(92_000, plan.expectedPaise)
        assertEquals(70_000L, plan.officeCashPaise)
        assertEquals(22_000, plan.notInOfficeCashPaise)
        assertEquals(3, plan.unsyncedCount)
        assertEquals(17_000, plan.unsyncedCashPaise)
    }

    @Test
    fun `stored office totals without the list are shown apart, and the day is counted on the phone`() {
        val stored = officeDay(listOf(officePayment("sent-1", 50_000)), fresh = false)
        val summary =
            summarizeDay(
                userId,
                DATE,
                listOf(payment("sent-1", 50_000, state = PaymentState.SENT_TO_OFFICE), payment("on-phone", 10_000)),
                stored,
            )
        assertEquals(TotalsSource.PhoneOnly, summary.source)
        assertEquals(MethodTotals(cashPaise = 60_000, count = 2), summary.day)
        assertEquals(MethodTotals(cashPaise = 50_000, count = 1), summary.office!!.totals)
        assertNull(HandoverPlan.from(summary).officeCashPaise)
        assertEquals(10_000, HandoverPlan.from(summary).notInOfficeCashPaise)
    }

    @Test
    fun `nothing today is all zeros`() {
        val summary = summarizeDay(userId, DATE, emptyList(), null)
        assertEquals(MethodTotals.ZERO, summary.day)
        assertEquals(0, summary.rows.size)
    }
}
