package com.cablebilling.lineman.feature.receipt

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.receipts.OutboxReceiptActions
import com.cablebilling.lineman.data.receipts.ReceiptActionRecorder
import com.cablebilling.lineman.data.receipts.RecordingSyncTrigger
import com.cablebilling.lineman.data.receipts.testLog
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.collect.CollectDoneViewModel
import com.cablebilling.lineman.feature.collect.PrintState
import com.cablebilling.lineman.printing.FakeReceiptPrinter
import com.cablebilling.lineman.printing.PrintProblem
import com.cablebilling.lineman.printing.PrintResult
import com.cablebilling.lineman.voice.VoiceLines
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith

/**
 * The Done screen's Print tile records `printed` / `print_failed` in the receipt outbox (T-069 hook in
 * T-066's `CollectDoneViewModel.print()`), and a failed print never changes the payment (PRD §15 #10).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class PrintActionsTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val printer = FakeReceiptPrinter()
    private val trigger = RecordingSyncTrigger()
    private lateinit var network: TestNetwork
    private lateinit var payments: PaymentRepository

    /** The outbox recorder, remembering each write's job so the test can wait for it (no polling). */
    private val jobs = mutableListOf<Job>()
    private lateinit var recorder: ReceiptActionRecorder

    @Before
    fun setUp() {
        // ViewModel coroutines run on the thread that resumes them (Room's), not the paused main looper.
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.dispatcher = Routes { Fixtures.response("error.NOT_FOUND.json") }
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(PaymentFixtures.login) }
        payments = PaymentRepository(db, network.store, time, RecordingPushTrigger())
        val outbox = OutboxReceiptActions(db, time, trigger, testLog(folder.root))
        recorder =
            ReceiptActionRecorder { paymentId, action ->
                outbox.record(paymentId, action).also {
                    synchronized(jobs) {
                        jobs +=
                            it
                    }
                }
            }
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        network.close()
        server.close()
        db.close()
    }

    @Test
    fun `a failed print is recorded as print_failed and the payment stays as it was`() {
        val paymentId = (await { payments.save(PaymentFixtures.draft()) } as SaveResult.Saved).paymentId
        val before = await { payments.get(paymentId) }
        val viewModel =
            CollectDoneViewModel(
                paymentId,
                payments,
                network.store,
                printer,
                VoiceLines(ApplicationProvider.getApplicationContext()),
                NetworkModule.provideJson(),
                recorder,
            )
        await {
            val collector = kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch { viewModel.state.collect {} }
            printer.next = PrintResult.Failed(PrintProblem.NoPaper)
            viewModel.print()
            viewModel.state.first { it.print is PrintState.Failed }
            printer.next = PrintResult.Printed
            viewModel.print()
            viewModel.state.first { it.print == PrintState.Printed }
            collector.cancel()
        }
        await { synchronized(jobs) { jobs.toList() }.joinAll() }
        val recorded = await { db.receiptActionDao().oldestPending(10) }.map { it.action }
        assertEquals(setOf("print_failed", "printed"), recorded.toSet())
        assertEquals(2, recorded.size)
        assertEquals(before, await { payments.get(paymentId) })
        assertEquals(2, trigger.requests)
    }
}
