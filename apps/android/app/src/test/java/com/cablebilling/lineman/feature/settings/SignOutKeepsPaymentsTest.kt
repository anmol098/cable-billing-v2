package com.cablebilling.lineman.feature.settings

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.data.network.generated.PaymentOutcome
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.diagnostics.AppInfo
import com.cablebilling.lineman.diagnostics.DiagnosticLog
import com.cablebilling.lineman.printing.DataStorePrinterSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.SocketEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.Executor

/**
 * Sign-out with the real payment queue, session store, push and logout call (MockWebServer):
 * blocked while this lineman's payments are on the phone, possible once they reached the office,
 * and it never deletes a payment, including another lineman's held ones and refused ones.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class SignOutKeepsPaymentsTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val office = FakePaymentServer()

    @Volatile
    private var online = true
    private val routes =
        Routes { request ->
            when {
                !online -> MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()
                request.apiPath == "/payments:batch" -> office.handle(request)
                request.apiPath == "/auth/logout" -> Fixtures.response("logout.response.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }
    private lateinit var network: TestNetwork
    private lateinit var payments: PaymentRepository
    private lateinit var sync: PaymentSync
    private lateinit var data: AppSettingsData
    private var pushes = 0

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.newFolder("network"))
        payments = PaymentRepository(db, network.store, time, RecordingPushTrigger())
        sync = PaymentSync(db, network.mobileApi, network.errors, network.store, time, NetworkModule.provideJson())
        data =
            AppSettingsData(
                db = db,
                auth = network.auth,
                printers = DataStorePrinterSettings(network.prefs),
                push = PushNow { pushes++ },
                log = DiagnosticLog(File(folder.root, "diagnostics"), writer = Executor { it.run() }),
                app = AppInfo("0.1.0-dev", 1, "dev", "14", 34, "Xiaomi", "Redmi 9A"),
            )
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
        Dispatchers.resetMain()
    }

    private fun signIn(login: LoginResponse) {
        await { network.store.end(SignOutReason.SIGNED_OUT) }
        await { network.store.signIn(login) }
    }

    private fun save(amountPaise: Long): String {
        time.now += 60_000
        return (await { payments.save(PaymentFixtures.draft(amountPaise)) } as SaveResult.Saved).paymentId.also {
            saved +=
                it
        }
    }

    /** Every id saved in this test. */
    private val saved = mutableListOf<String>()

    /** Every payment row on the phone, by id (and no row that this test did not save). */
    private fun rows(): Map<String, PaymentEntity> {
        val count =
            await {
                db.query("SELECT COUNT(*) FROM payments", null).use {
                    it.moveToFirst()
                    it.getInt(0)
                }
            }
        assertEquals(saved.size, count)
        return saved.associateWith { id -> await { db.paymentDao().get(id) } ?: error("payment $id is gone") }
    }

    private fun SettingsViewModel.awaitStep(step: SignOutStep) = await { state.first { it.signOut == step } }

    @Test
    fun `blocked while own payments are on the phone, then signed out - every payment is still there`() {
        // Mohan used this phone first and left two payments on it (held while someone else is signed in).
        signIn(PaymentFixtures.otherLogin)
        val mohans = listOf(save(20_000), save(30_000))
        // Suresh: one payment refused by the office, two waiting for internet.
        signIn(PaymentFixtures.login)
        val refused = save(10_000)
        office.forced[refused] = PaymentOutcome.REJECTED
        await { sync.run() }
        online = false
        val sureshs = listOf(save(45_000), save(50_000))
        await { sync.run() } // no internet: they stay on the phone
        val before = rows()
        assertEquals(5, before.size)

        val viewModel = SettingsViewModel(data)
        viewModel.signOut()
        viewModel.awaitStep(SignOutStep.Blocked)
        assertEquals(2, await { viewModel.state.first { it.waiting == 2 } }.waiting)
        assertTrue(network.store.state.value is SessionState.SignedIn)
        assertEquals(before, rows())

        // "Try now" asks for a push; the internet is back and the push gets Suresh's payments to the office.
        viewModel.tryNow()
        assertEquals(1, pushes)
        online = true
        await { sync.run() }
        await { viewModel.state.first { it.waiting == 0 } }

        // Mohan's held payments do not block Suresh: sign-out is asked, then done.
        viewModel.signOut()
        viewModel.awaitStep(SignOutStep.Confirm)
        viewModel.confirmSignOut()
        viewModel.awaitStep(SignOutStep.Idle) // signOut() returned, incl. the logout call
        assertEquals(SessionState.SignedOut(SignOutReason.SIGNED_OUT), network.store.state.value)
        assertEquals(1, routes.requestsTo("/auth/logout").size)

        // Nothing deleted: Mohan's held payments are unchanged, the refused one stays for the office.
        val after = rows()
        assertEquals(before.keys, after.keys)
        mohans.forEach { assertEquals(before.getValue(it), after.getValue(it)) }
        assertEquals(PaymentState.NEEDS_OFFICE_HELP, after.getValue(refused).state)
        sureshs.forEach { assertEquals(PaymentState.SENT_TO_OFFICE, after.getValue(it).state) }

        // Mohan signs in again on this phone: his payments are still there and go to the office.
        signIn(PaymentFixtures.otherLogin)
        assertTrue(await { data.hasPaymentsOnPhone(PaymentFixtures.otherLogin.user.id) })
        await { sync.run() }
        assertTrue(office.postedIds().containsAll(mohans))
    }

    @Test
    fun `even a sign-out that skips the check deletes nothing`() {
        signIn(PaymentFixtures.login)
        online = false
        val mine = listOf(save(45_000), save(50_000))
        val before = rows()

        await { data.signOut() } // the session ends; the queue is not touched
        assertTrue(network.store.state.value is SessionState.SignedOut)
        assertEquals(before, rows())
        mine.forEach { assertEquals(PaymentState.SAVED_ON_PHONE, rows().getValue(it).state) }

        // The same lineman signs in again: still blocked from signing out until they are sent.
        signIn(PaymentFixtures.login)
        assertTrue(await { data.hasPaymentsOnPhone(PaymentFixtures.login.user.id) })
        assertFalse(await { data.hasPaymentsOnPhone(PaymentFixtures.otherLogin.user.id) })
    }
}
