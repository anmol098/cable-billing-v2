package com.cablebilling.lineman.feature.today

import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.feature.today.TodayFixtures.DATE
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

/**
 * The handover flow's ViewModel: the expected cash pre-filled (office + not yet at the office, or the
 * phone's count offline), the discrepancy and its reason tiles, the request it saves, and process death.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class HandoverViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val data = FakeTodayData()
    private val voiceLines = VoiceLines(ApplicationProvider.getApplicationContext())

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        // The office has ₹500 + ₹200 cash and ₹450 UPI; the phone also holds ₹100 cash not sent yet,
        // and another lineman's ₹900 is held on this phone.
        data.office.value =
            officeDay(
                listOf(
                    officePayment("r", 50_000),
                    officePayment("s", 45_000, PaymentMethod.UPI),
                    officePayment("m", 20_000),
                ),
            )
        data.payments.value = listOf(payment("p", 10_000), payment("held", 90_000, collectorId = OTHER_USER))
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.newViewModel(saved: SavedStateHandle = SavedStateHandle()): HandoverViewModel {
        val viewModel = HandoverViewModel(DATE, data, voiceLines, saved)
        backgroundScope.launch { viewModel.state.collect {} }
        runCurrent()
        return viewModel
    }

    private fun HandoverViewModel.type(digits: String) = digits.forEach { onKey(NumberPadKey.Digit(it.digitToInt())) }

    @Test
    fun `pre-filled with the office's cash plus the cash still on the phone, never UPI`() =
        runTest(dispatcher) {
            val state = newViewModel().state.value
            val plan = state.plan!!
            assertEquals(80_000, plan.expectedPaise)
            assertEquals(70_000L, plan.officeCashPaise)
            assertEquals(10_000, plan.notInOfficeCashPaise)
            assertEquals(1, plan.unsyncedCount)
            assertEquals(TotalsSource.OfficeAndPhone, plan.source)
            assertEquals("800", state.digits)
            assertEquals(0L, state.discrepancyPaise)
            assertTrue(state.reasons.isEmpty())
        }

    @Test
    fun `matching cash goes straight to Confirm and saves pending_sync for the cash still on the phone`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.onAmountDone()
            runCurrent()
            assertEquals(HandoverStep.Confirm, viewModel.state.value.step)
            assertEquals(
                "eight hundred rupees cash to the office",
                viewModel.state.value.confirmVoice!!
                    .english,
            )
            viewModel.submit()
            runCurrent()
            val (date, request) = data.queuedRequests.single()
            assertEquals(DATE, date)
            assertEquals(80_000L, request.cashHandedOverPaise)
            assertEquals(DiscrepancyReason.PENDING_SYNC, request.discrepancyReason)
            assertEquals(1L, request.unsyncedPaymentCount)
            assertEquals(10_000L, request.unsyncedCashPaise)
            assertTrue(viewModel.state.value.saved)

            // A second tap saves nothing more.
            viewModel.submit()
            runCurrent()
            assertEquals(1, data.queuedRequests.size)
        }

    @Test
    fun `a different amount asks why - tiles by sign, a reason is needed, the note is optional`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.type("750") // the first key replaces the pre-fill
            runCurrent()
            assertEquals("750", viewModel.state.value.digits)
            assertEquals(-5_000L, viewModel.state.value.discrepancyPaise)
            viewModel.onAmountDone()
            runCurrent()
            assertEquals(HandoverStep.Reason, viewModel.state.value.step)
            assertEquals(SHORT_REASONS, viewModel.state.value.reasons)
            viewModel.onReasonDone()
            runCurrent()
            assertEquals(HandoverStep.Reason, viewModel.state.value.step)
            viewModel.onReason(DiscrepancyReason.EXTRA) // not offered for a short amount
            runCurrent()
            assertNull(viewModel.state.value.reason)

            viewModel.onReason(DiscrepancyReason.SHORT)
            viewModel.onNoteChange("gave change")
            viewModel.onReasonDone()
            runCurrent()
            assertEquals(HandoverStep.Confirm, viewModel.state.value.step)
            viewModel.submit()
            runCurrent()
            val request = data.queuedRequests.single().second
            assertEquals(75_000L, request.cashHandedOverPaise)
            assertEquals(DiscrepancyReason.SHORT, request.discrepancyReason)
            assertEquals("gave change", request.note)
        }

    @Test
    fun `going back to change something makes a new submission, a restore after process death keeps it`() =
        runTest(dispatcher) {
            val saved = SavedStateHandle()
            val viewModel = newViewModel(saved)
            viewModel.onAmountDone()
            runCurrent()
            val first = saved.get<String>(HandoverViewModel.KEY_SUBMISSION_ID)!!
            assertTrue(viewModel.onBack())
            assertNull(saved.get<String>(HandoverViewModel.KEY_SUBMISSION_ID))
            viewModel.onKey(NumberPadKey.Backspace)
            viewModel.onKey(NumberPadKey.Digit(0))
            viewModel.onAmountDone()
            runCurrent()
            val second = saved.get<String>(HandoverViewModel.KEY_SUBMISSION_ID)!!
            assertTrue(first != second)

            // Process death: a new ViewModel on the same saved state, while the day changed meanwhile.
            data.payments.value = emptyList()
            val restored = newViewModel(SavedStateHandle(saved.keys().associateWith { saved.get<Any?>(it) }))
            assertEquals(HandoverStep.Confirm, restored.state.value.step)
            assertEquals(
                80_000,
                restored.state.value.plan!!
                    .expectedPaise,
            ) // frozen
            restored.submit()
            runCurrent()
            assertEquals(
                second,
                data.queuedRequests
                    .single()
                    .second.submissionId,
            )
        }

    @Test
    fun `offline - the phone's count with its label, and problems from saving`() =
        runTest(dispatcher) {
            data.office.value = null
            data.payments.value =
                listOf(payment("p", 10_000), payment("q", 25_000), payment("u", 5_000, PaymentMethod.UPI))
            val viewModel = newViewModel()
            val plan = viewModel.state.value.plan!!
            assertEquals(35_000, plan.expectedPaise)
            assertEquals(TotalsSource.PhoneOnly, plan.source)
            assertNull(plan.officeCashPaise)

            data.queueResult = QueueResult.AlreadyAccepted
            viewModel.onAmountDone()
            viewModel.submit()
            runCurrent()
            assertEquals(HandoverProblem.AlreadyAccepted, viewModel.state.value.problem)
            assertFalse(viewModel.state.value.saved)
        }

    @Test
    fun `signed out - nothing to hand over`() =
        runTest(dispatcher) {
            data.sessionState.value = SessionState.SignedOut()
            val state = newViewModel().state.value
            assertNull(state.plan)
            assertEquals(HandoverProblem.SignedOut, state.problem)
        }
}
