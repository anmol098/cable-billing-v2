package com.cablebilling.lineman.feature.waiting

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.sync.PushStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The Waiting tab's ViewModel: kinds and order, another lineman's held payments, Try now. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class WaitingViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val data = FakeWaitingData()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.newViewModel(): WaitingViewModel {
        val viewModel = WaitingViewModel(data)
        backgroundScope.launch { viewModel.state.collect {} }
        runCurrent()
        return viewModel
    }

    private fun payment(
        id: String,
        recordedAt: Long,
        state: PaymentState = PaymentState.SAVED_ON_PHONE,
        collectorId: String = PaymentFixtures.login.user.id,
    ): PaymentEntity =
        RosterFixtures
            .payment(
                id,
                RosterFixtures.ramesh.id,
                10_000,
                state,
                recordedAt = recordedAt,
            ).copy(collectorId = collectorId)

    @Test
    fun `problems first, then own payments on the phone, then another lineman's held ones, newest first`() =
        runTest(dispatcher) {
            data.payments.value =
                listOf(
                    payment("a", recordedAt = 1),
                    payment("b", recordedAt = 3),
                    payment("c", recordedAt = 2, state = PaymentState.NEEDS_OFFICE_HELP),
                    payment("d", recordedAt = 4, collectorId = PaymentFixtures.otherLogin.user.id),
                )
            val state = newViewModel().state.value

            assertEquals(listOf("c", "b", "a", "d"), state.items.map { it.id })
            assertEquals(
                listOf(WaitingKind.Problem, WaitingKind.OnPhone, WaitingKind.OnPhone, WaitingKind.Held),
                state.items.map { it.kind },
            )
            assertEquals(2, state.ownOnPhone)
            assertEquals(1, state.held)
            assertEquals("9800000001", state.officePhone)
            assertTrue(state.canTryNow)
            assertEquals("P-K7Q-a", state.items.last { it.id == "a" }.reference)
        }

    @Test
    fun `Try now pushes unless a push is running, and is off with only held or refused payments`() =
        runTest(dispatcher) {
            data.payments.value = listOf(payment("a", 1))
            val viewModel = newViewModel()
            viewModel.tryNow()
            assertEquals(1, data.tries)

            data.push.value = PushStatus.Running
            runCurrent()
            assertFalse(viewModel.state.value.canTryNow)
            viewModel.tryNow()
            assertEquals(1, data.tries)

            data.push.value = PushStatus.Idle
            data.payments.value =
                listOf(
                    payment("c", 2, state = PaymentState.NEEDS_OFFICE_HELP),
                    payment("d", 4, collectorId = PaymentFixtures.otherLogin.user.id),
                )
            runCurrent()
            assertFalse(viewModel.state.value.canTryNow)
        }

    @Test
    fun `all sent is said only when nothing of this lineman is left`() =
        runTest(dispatcher) {
            data.push.value = PushStatus.Finished
            data.payments.value = emptyList()
            val viewModel = newViewModel()
            assertTrue(viewModel.state.value.allSent)

            data.payments.value = listOf(payment("c", 2, state = PaymentState.NEEDS_OFFICE_HELP))
            runCurrent()
            assertFalse(viewModel.state.value.allSent)

            data.payments.value = listOf(payment("d", 4, collectorId = PaymentFixtures.otherLogin.user.id))
            runCurrent()
            assertTrue(viewModel.state.value.allSent) // the held one is not this lineman's
        }

    @Test
    fun `signed out - every payment on the phone is shown as on the phone, none is held`() =
        runTest(dispatcher) {
            data.session.value = SessionState.SignedOut()
            data.payments.value =
                listOf(payment("a", 1), payment("d", 4, collectorId = PaymentFixtures.otherLogin.user.id))
            val state = newViewModel().state.value
            assertEquals(listOf(WaitingKind.OnPhone, WaitingKind.OnPhone), state.items.map { it.kind })
        }

    private class FakeWaitingData : WaitingData {
        val payments = MutableStateFlow<List<PaymentEntity>>(emptyList())
        val session =
            MutableStateFlow<SessionState>(
                SessionState.SignedIn(
                    Session(PaymentFixtures.login.user, PaymentFixtures.login.operator, PaymentFixtures.login.device),
                ),
            )
        val push = MutableStateFlow<PushStatus>(PushStatus.Idle)
        var tries = 0

        override fun payments(): Flow<List<PaymentEntity>> = payments

        override fun session(): Flow<SessionState> = session

        override fun pushStatus(): Flow<PushStatus> = push

        override fun tryNow() {
            tries++
        }
    }
}
