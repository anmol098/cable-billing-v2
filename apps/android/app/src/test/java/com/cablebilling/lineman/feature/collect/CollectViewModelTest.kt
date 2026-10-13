package com.cablebilling.lineman.feature.collect

import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.lineman.data.payments.PaymentDraft
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.payments.UuidV7
import com.cablebilling.lineman.voice.VoiceLines
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
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
import com.cablebilling.lineman.data.network.generated.PaymentMethod as WireMethod

/** The collect flow's ViewModel: pre-fill, number pad, chips, steps, back, Save (once), saved state. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class CollectViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val data = FakeCollectData()
    private val voiceLines = VoiceLines(ApplicationProvider.getApplicationContext())

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.newViewModel(saved: SavedStateHandle = SavedStateHandle()): CollectViewModel {
        val viewModel = CollectViewModel(RAMESH, data, voiceLines, saved)
        backgroundScope.launch { viewModel.state.collect {} }
        runCurrent()
        return viewModel
    }

    private fun CollectViewModel.type(digits: String) = digits.forEach { onKey(NumberPadKey.Digit(it.digitToInt())) }

    @Test
    fun `the amount starts as the full due, and the first key types a new amount`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            val state = viewModel.state.value
            assertFalse(state.loading)
            assertEquals(CollectStep.Amount, state.step)
            assertEquals("900", state.amountDigits)
            assertEquals(90_000L, state.amountPaise)
            assertEquals(listOf(90_000L, 10_000L, 20_000L, 50_000L), state.quickAmountsPaise)

            viewModel.type("5")
            runCurrent()
            assertEquals("5", viewModel.state.value.amountDigits)
            viewModel.onKey(NumberPadKey.DoubleZero)
            runCurrent()
            assertEquals("500", viewModel.state.value.amountDigits)
            viewModel.onKey(NumberPadKey.Backspace)
            runCurrent()
            assertEquals("50", viewModel.state.value.amountDigits)
        }

    @Test
    fun `a due with paise is pre-filled rounded up to whole rupees, and no due means an empty amount`() =
        runTest(dispatcher) {
            data.customer.value = Cached(CollectCustomer(RAMESH, "Ramesh Kumar", "1045", 45_050))
            assertEquals("451", newViewModel().state.value.amountDigits)

            data.customer.value = Cached(CollectCustomer(RAMESH, "Ramesh Kumar", "1045", 0))
            val noDue = newViewModel()
            assertEquals("", noDue.state.value.amountDigits)
            assertFalse(noDue.state.value.canContinue)
            assertEquals(listOf(10_000L, 20_000L, 50_000L), noDue.state.value.quickAmountsPaise)
            noDue.onAmountDone()
            runCurrent()
            assertEquals(CollectStep.Amount, noDue.state.value.step)
        }

    @Test
    fun `chips replace the amount, leading zeros are dropped and the pad stops at 7 digits`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.onQuickAmount(20_000)
            runCurrent()
            assertEquals("200", viewModel.state.value.amountDigits)
            viewModel.type("3") // after a chip, a key starts afresh
            runCurrent()
            assertEquals("3", viewModel.state.value.amountDigits)

            viewModel.onKey(NumberPadKey.Clear)
            viewModel.type("0")
            viewModel.onKey(NumberPadKey.DoubleZero)
            runCurrent()
            assertEquals("", viewModel.state.value.amountDigits)
            viewModel.type("123456789")
            runCurrent()
            assertEquals("1234567", viewModel.state.value.amountDigits)
        }

    @Test
    fun `cash goes straight to Confirm with a read-out, and Save saves once with the flow's id`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.onAmountDone()
            runCurrent()
            assertEquals(CollectStep.Method, viewModel.state.value.step)
            viewModel.onMethod(PaymentMethod.Cash)
            runCurrent()
            val confirm = viewModel.state.value
            assertEquals(CollectStep.Confirm, confirm.step)
            assertEquals("Ramesh Kumar से नौ सौ रुपये नकद", confirm.confirmVoice?.hindi)
            assertEquals("nine hundred rupees cash from Ramesh Kumar", confirm.confirmVoice?.english)

            viewModel.save()
            viewModel.save() // a second tap while saving
            runCurrent()
            assertTrue(viewModel.state.value.saving)
            assertNull(viewModel.state.value.savedPaymentId) // never "Saved" before the commit
            data.answer.complete(Unit)
            runCurrent()

            val draft = data.saved.single()
            assertTrue(UuidV7.isValid(draft.id))
            assertEquals(PaymentDraft(draft.id, RAMESH, "1045", "Ramesh Kumar", 90_000, WireMethod.CASH, null), draft)
            assertEquals(draft.id, viewModel.state.value.savedPaymentId)
            assertFalse(viewModel.state.value.saving)
            viewModel.save()
            runCurrent()
            assertEquals(1, data.saved.size)
        }

    @Test
    fun `UPI asks for the optional reference - Skip or type it`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.onAmountDone()
            viewModel.onMethod(PaymentMethod.Upi)
            runCurrent()
            assertEquals(CollectStep.UpiReference, viewModel.state.value.step)
            viewModel.onUpiReferenceChange("4298 7612 3456" + "9".repeat(80))
            runCurrent()
            assertEquals(64, viewModel.state.value.upiReference.length)
            viewModel.onUpiSkip()
            runCurrent()
            assertEquals(CollectStep.Confirm, viewModel.state.value.step)
            assertEquals("", viewModel.state.value.upiReference)

            assertTrue(viewModel.onBack())
            runCurrent()
            assertEquals(CollectStep.UpiReference, viewModel.state.value.step)
            viewModel.onUpiReferenceChange("429876123456")
            viewModel.onUpiDone()
            runCurrent()
            assertEquals(CollectStep.Confirm, viewModel.state.value.step)
            assertEquals(
                "nine hundred rupees UPI from Ramesh Kumar",
                viewModel.state.value.confirmVoice
                    ?.english,
            )

            viewModel.save()
            data.answer.complete(Unit)
            runCurrent()
            assertEquals(WireMethod.UPI, data.saved.single().method)
            assertEquals("429876123456", data.saved.single().upiReference)
        }

    @Test
    fun `back walks the steps, and leaves only from the Amount screen`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.onAmountDone()
            viewModel.onMethod(PaymentMethod.Cash)
            runCurrent()
            assertTrue(viewModel.onBack())
            runCurrent()
            assertEquals(CollectStep.Method, viewModel.state.value.step)
            assertTrue(viewModel.onBack())
            runCurrent()
            assertEquals(CollectStep.Amount, viewModel.state.value.step)
            assertFalse(viewModel.onBack())
        }

    @Test
    fun `after process death the flow comes back with the same payment id, so a second Save is the same payment`() =
        runTest(dispatcher) {
            val saved = SavedStateHandle()
            val first = newViewModel(saved)
            first.type("4")
            first.onKey(NumberPadKey.DoubleZero)
            first.onAmountDone()
            first.onMethod(PaymentMethod.Cash)
            first.save()
            data.answer.complete(Unit)
            runCurrent()
            val id = data.saved.single().id

            // The process dies before Done showed; the system restores the screen's saved state.
            val restored = newViewModel(SavedStateHandle(saved.keys().associateWith { saved.get<Any>(it) }))
            assertEquals(CollectStep.Confirm, restored.state.value.step)
            assertEquals("400", restored.state.value.amountDigits)
            assertEquals(PaymentMethod.Cash, restored.state.value.method)
            restored.save()
            runCurrent()
            assertEquals(listOf(id, id), data.saved.map { it.id })
            assertEquals(id, restored.state.value.savedPaymentId)
        }

    @Test
    fun `when saving fails nothing is called saved, and Save can be tried again`() =
        runTest(dispatcher) {
            data.result = SaveResult.Failed(android.database.sqlite.SQLiteFullException("disk full"))
            val viewModel = newViewModel()
            viewModel.onAmountDone()
            viewModel.onMethod(PaymentMethod.Cash)
            viewModel.save()
            data.answer.complete(Unit)
            runCurrent()
            assertEquals(CollectProblem.NotSaved, viewModel.state.value.problem)
            assertNull(viewModel.state.value.savedPaymentId)

            data.result = SaveResult.NotSignedIn
            viewModel.save()
            runCurrent()
            assertEquals(CollectProblem.SignedOut, viewModel.state.value.problem)

            data.result = null
            viewModel.save()
            runCurrent()
            assertEquals(3, data.saved.size)
            assertEquals(
                1,
                data.saved
                    .map { it.id }
                    .toSet()
                    .size,
            )
            assertEquals(data.saved.last().id, viewModel.state.value.savedPaymentId)
        }

    @Test
    fun `a customer who is not on the phone shows not found`() =
        runTest(dispatcher) {
            data.customer.value = Cached(null)
            val viewModel = newViewModel()
            assertTrue(viewModel.state.value.notFound)
        }

    private data class Cached(
        val customer: CollectCustomer?,
    )

    private class FakeCollectData : CollectData {
        val customer = MutableStateFlow<Cached?>(Cached(CollectCustomer(RAMESH, "Ramesh Kumar", "1045", 90_000)))
        val saved = mutableListOf<PaymentDraft>()

        /** Completes the first save (later saves answer at once). */
        val answer = CompletableDeferred<Unit>()

        /** What save answers; null = Saved. */
        var result: SaveResult? = null
        private var counter = 0L

        override fun customer(id: String): Flow<CollectCustomer?> = customer.filterNotNull().map { it.customer }

        override fun newPaymentId(): String = UuidV7.generate(1_791_000_000_000L + counter++)

        override suspend fun save(draft: PaymentDraft): SaveResult {
            saved += draft
            answer.await()
            return result ?: SaveResult.Saved(draft.id, "P-K7Q-0001", isNew = saved.size == 1)
        }
    }

    private companion object {
        const val RAMESH = "01929a3e-5b10-7c4e-8a03-000000000001"
    }
}
