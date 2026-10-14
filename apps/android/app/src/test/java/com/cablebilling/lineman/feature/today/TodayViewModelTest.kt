package com.cablebilling.lineman.feature.today

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.feature.today.TodayFixtures.OTHER_USER
import com.cablebilling.lineman.feature.today.TodayFixtures.officeDay
import com.cablebilling.lineman.feature.today.TodayFixtures.officePayment
import com.cablebilling.lineman.feature.today.TodayFixtures.payment
import com.cablebilling.lineman.voice.VoiceLines
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/**
 * The Today tab's ViewModel: the signed-in lineman's India-time day with cash and UPI apart (another
 * lineman's held payments and other days left out), the office's numbers when it answers, and the
 * handover's state.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class TodayViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val data = FakeTodayData()
    private val voiceLines = VoiceLines(ApplicationProvider.getApplicationContext())

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.newViewModel(): TodayViewModel {
        val viewModel = TodayViewModel(data, voiceLines)
        backgroundScope.launch { viewModel.state.collect {} }
        runCurrent()
        return viewModel
    }

    @Test
    fun `local totals - cash and UPI apart, on the phone labelled, held payments of another lineman left out`() =
        runTest(dispatcher) {
            data.payments.value =
                listOf(
                    payment("a", 50_000),
                    payment("b", 45_000, PaymentMethod.UPI, state = PaymentState.SENT_TO_OFFICE),
                    payment("held", 90_000, collectorId = OTHER_USER),
                    payment("held-upi", 30_000, PaymentMethod.UPI, collectorId = OTHER_USER),
                )
            val state = newViewModel().state.value

            assertTrue(state.signedIn)
            assertEquals("2026-10-13", state.businessDate)
            val summary = state.summary!!
            assertEquals(MethodTotals(cashPaise = 50_000, upiPaise = 45_000, count = 2), summary.day)
            assertEquals(MethodTotals(cashPaise = 50_000, count = 1), summary.onPhone)
            assertEquals(TotalsSource.PhoneOnly, summary.source)
            assertEquals(listOf("b", "a").toSet(), summary.rows.map { it.id }.toSet())
            assertEquals(HandoverView.NotYet, state.handover)
            assertTrue(state.canHandOver)
            assertEquals("9800000001", state.officePhone)
            assertEquals("Today five hundred rupees cash, four hundred fifty rupees UPI", state.voice!!.english)
        }

    @Test
    fun `the day is today in India time - just after midnight IST is the new day, and showing again moves to it`() =
        runTest(dispatcher) {
            data.now = Instant.parse("2026-10-12T18:29:59Z").toEpochMilli() // 12 Oct 23:59:59 IST
            data.payments.value =
                listOf(
                    payment("late", 10_000, recordedAt = Instant.parse("2026-10-12T18:29:00Z").toEpochMilli()),
                    payment(
                        "early",
                        20_000,
                        PaymentMethod.UPI,
                        recordedAt = Instant.parse("2026-10-12T18:31:00Z").toEpochMilli(),
                    ),
                )
            val viewModel = newViewModel()
            assertEquals("2026-10-12", viewModel.state.value.businessDate)
            assertEquals(
                MethodTotals(cashPaise = 10_000, count = 1),
                viewModel.state.value.summary!!
                    .day,
            )

            data.now = Instant.parse("2026-10-12T18:30:00Z").toEpochMilli() // 13 Oct 00:00 IST
            viewModel.onShown()
            runCurrent()
            assertEquals("2026-10-13", viewModel.state.value.businessDate)
            assertEquals(
                MethodTotals(upiPaise = 20_000, count = 1),
                viewModel.state.value.summary!!
                    .day,
            )
            assertEquals(listOf("2026-10-13"), data.refreshes)
        }

    @Test
    fun `showing the screen asks the office and sends a waiting handover - offline says so honestly`() =
        runTest(dispatcher) {
            data.payments.value = listOf(payment("a", 50_000))
            val viewModel = newViewModel()
            viewModel.onShown()
            runCurrent()
            assertEquals(1, data.sends)
            assertEquals(OfficeCheck.NoInternet, viewModel.state.value.officeCheck)
            assertEquals(
                TotalsSource.PhoneOnly,
                viewModel.state.value.summary!!
                    .source,
            )

            // The office answers: its totals plus what it does not have.
            data.office.value =
                officeDay(listOf(officePayment("x", 20_000), officePayment("y", 30_000, PaymentMethod.UPI)))
            data.refreshResult = RefreshResult.Refreshed(data.office.value!!)
            viewModel.refresh()
            runCurrent()
            val state = viewModel.state.value
            assertEquals(OfficeCheck.Done, state.officeCheck)
            assertEquals(TotalsSource.OfficeAndPhone, state.summary!!.source)
            assertEquals(MethodTotals(cashPaise = 70_000, upiPaise = 30_000, count = 3), state.summary.day)
        }

    @Test
    fun `the handover's state - on the phone, at the office, sent back, accepted (no more handing over)`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            data.queued.value = QueuedHandover(HandoverRequest(SUBMISSION, 70_000, null, null, 0, 0), queuedAt = 1)
            runCurrent()
            assertEquals(HandoverView.OnPhone(70_000, sending = false), viewModel.state.value.handover)

            val handover =
                Handover(SUBMISSION, 70_000, 60_000, -10_000, DiscrepancyReason.SHORT, null, 0, 0, "x", null, null)
            data.queued.value = null
            data.office.value = officeDay(listOf(officePayment("x", 70_000)), HandoverStatus.SUBMITTED, handover)
            runCurrent()
            assertEquals(HandoverView.Submitted(handover), viewModel.state.value.handover)
            assertTrue(viewModel.state.value.canHandOver)

            val back = handover.copy(reviewNote = "Count again")
            data.office.value = data.office.value!!.copy(status = HandoverStatus.RETURNED, handover = back)
            runCurrent()
            assertEquals(HandoverView.SentBack(back), viewModel.state.value.handover)

            data.office.value = data.office.value!!.copy(status = HandoverStatus.ACCEPTED, handover = handover)
            runCurrent()
            assertEquals(HandoverView.Accepted(handover), viewModel.state.value.handover)
            assertFalse(viewModel.state.value.canHandOver)
        }

    @Test
    fun `signed out shows nothing of anybody`() =
        runTest(dispatcher) {
            data.sessionState.value = SessionState.SignedOut()
            data.payments.value = listOf(payment("a", 50_000))
            val state = newViewModel().state.value
            assertFalse(state.signedIn)
            assertNull(state.summary)
            assertFalse(state.canHandOver)
        }

    private companion object {
        const val SUBMISSION = "0192ab00-0000-7000-8000-000000000001"
    }
}
