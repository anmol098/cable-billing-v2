package com.cablebilling.lineman.feature.settings

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.printing.SavedPrinter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The settings ViewModel: what it shows, language, and the sign-out check (blocked / confirm / re-check). */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class SettingsViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val data = FakeSettingsData()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.newViewModel(): SettingsViewModel {
        val viewModel = SettingsViewModel(data)
        backgroundScope.launch { viewModel.state.collect {} }
        runCurrent()
        return viewModel
    }

    @Test
    fun `shows language, printer, who is signed in, version and this lineman's payments on the phone`() =
        runTest(dispatcher) {
            data.printer.value = SavedPrinter("00:11:22:33:44:55", "RPP02N")
            data.waiting.value = 2
            val state = newViewModel().state.value

            assertEquals("hi", state.language)
            assertEquals("RPP02N", state.printerName)
            assertEquals(PaymentFixtures.login.user.name, state.userName)
            assertEquals("0.1.0-dev (1)", state.version)
            assertEquals(2, state.waiting)
            assertEquals(SignOutStep.Idle, state.signOut)
        }

    @Test
    fun `switching language changes the app language once, and only to a supported one`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.setLanguage("en")
            viewModel.setLanguage("en")
            viewModel.setLanguage("fr")
            runCurrent()

            assertEquals(listOf("en"), data.languageChanges)
            assertEquals("en", viewModel.state.value.language)
        }

    @Test
    fun `sign-out is blocked while this lineman has payments on the phone - nothing is signed out`() =
        runTest(dispatcher) {
            data.waiting.value = 3
            val viewModel = newViewModel()
            viewModel.signOut()
            runCurrent()

            assertEquals(SignOutStep.Blocked, viewModel.state.value.signOut)
            assertEquals(3, viewModel.state.value.waiting)
            assertEquals(0, data.signOuts)
            assertEquals(listOf("sign_out_blocked"), data.notes)

            // Try now pushes; when the payments reached the office the count drops and sign-out is possible.
            viewModel.tryNow()
            assertEquals(1, data.tries)
            data.waiting.value = 0
            runCurrent()
            viewModel.signOut()
            runCurrent()
            assertEquals(SignOutStep.Confirm, viewModel.state.value.signOut)
        }

    @Test
    fun `no payments on the phone - confirm, then sign out`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.signOut()
            runCurrent()
            assertEquals(SignOutStep.Confirm, viewModel.state.value.signOut)

            viewModel.confirmSignOut()
            runCurrent()
            assertEquals(1, data.signOuts)
        }

    @Test
    fun `a payment saved while the question was open blocks the sign-out at Yes`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.signOut()
            runCurrent()
            data.waiting.value = 1 // saved meanwhile (e.g. from another screen before coming back)

            viewModel.confirmSignOut()
            runCurrent()
            assertEquals(SignOutStep.Blocked, viewModel.state.value.signOut)
            assertEquals(0, data.signOuts)
        }

    @Test
    fun `cancel returns to the button, and Yes without the question does nothing`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.confirmSignOut()
            runCurrent()
            assertEquals(0, data.signOuts)

            viewModel.signOut()
            runCurrent()
            viewModel.cancelSignOut()
            runCurrent()
            assertEquals(SignOutStep.Idle, viewModel.state.value.signOut)
        }

    @Test
    fun `nobody signed in - no name, nothing to sign out`() =
        runTest(dispatcher) {
            data.session.value = SessionState.SignedOut()
            val viewModel = newViewModel()
            viewModel.signOut()
            runCurrent()

            assertNull(viewModel.state.value.userName)
            assertEquals(SignOutStep.Idle, viewModel.state.value.signOut)
            assertEquals(0, data.signOuts)
        }
}

/** In-memory [SettingsData]: [waiting] is this lineman's payments still on the phone. */
class FakeSettingsData : SettingsData {
    val session =
        MutableStateFlow<SessionState>(
            SessionState.SignedIn(
                Session(PaymentFixtures.login.user, PaymentFixtures.login.operator, PaymentFixtures.login.device),
            ),
        )
    val printer = MutableStateFlow<SavedPrinter?>(null)
    val waiting = MutableStateFlow(0)
    var appLanguage = "hi"
    val languageChanges = mutableListOf<String>()
    var signOuts = 0
    var tries = 0
    val notes = mutableListOf<String>()
    var reportText = "report"

    override fun session(): Flow<SessionState> = session

    override fun printer(): Flow<SavedPrinter?> = printer

    override fun waitingCount(userId: String): Flow<Int> = waiting.map { it }

    override suspend fun hasPaymentsOnPhone(userId: String): Boolean = waiting.value > 0

    override suspend fun signOut() {
        signOuts++
        session.value = SessionState.SignedOut()
    }

    override fun tryNow() {
        tries++
    }

    override val language: String get() = appLanguage

    override fun setLanguage(language: String) {
        languageChanges += language
        appLanguage = language
    }

    override val version: String = "0.1.0-dev (1)"

    override suspend fun report(): String = reportText

    override fun note(event: String) {
        notes += event
    }
}
