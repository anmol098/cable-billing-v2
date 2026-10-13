package com.cablebilling.lineman.feature.waiting

import android.content.Intent
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
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
import com.cablebilling.lineman.data.sync.PushStatus
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.login.OfficeDialer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.SocketEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * The Waiting tab in Hindi with the real payment queue and push: saved-on-phone rows, a refused
 * payment with "Call office", another lineman's held payments, "Try now" with no internet and then
 * with internet, and the empty state.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi-w360dp-h800dp")
class WaitingScreenTest {
    @get:Rule
    val folder = TemporaryFolder()

    @get:Rule
    val composeRule = createComposeRule()

    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val office = FakePaymentServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var online = true
    private val routes =
        Routes { request ->
            when {
                request.apiPath != "/payments:batch" -> Fixtures.response("error.NOT_FOUND.json")
                online -> office.handle(request)
                else -> MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()
            }
        }
    private lateinit var network: TestNetwork
    private lateinit var payments: PaymentRepository
    private lateinit var sync: PaymentSync

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        payments = PaymentRepository(db, network.store, time, RecordingPushTrigger())
        sync = PaymentSync(db, network.mobileApi, network.errors, network.store, time, NetworkModule.provideJson())
    }

    @After
    fun tearDown() {
        scope.cancel()
        network.close()
        server.close()
        db.close()
    }

    private inner class TestWaitingData : WaitingData {
        override fun payments(): Flow<List<PaymentEntity>> = payments.observeWaiting()

        override fun session(): Flow<SessionState> = network.store.state

        override fun pushStatus(): Flow<PushStatus> = sync.status

        override fun tryNow() {
            scope.launch { sync.run() }
        }
    }

    private fun show() {
        val viewModel = WaitingViewModel(TestWaitingData())
        composeRule.setContent { CableTheme { WaitingScreen(viewModel = viewModel) } }
    }

    private fun save(amountPaise: Long): String {
        time.now += 60_000
        return (await { payments.save(PaymentFixtures.draft(amountPaise)) } as SaveResult.Saved).paymentId
    }

    private fun signIn(login: LoginResponse) {
        await { network.store.end(SignOutReason.SIGNED_OUT) }
        await { network.store.signIn(login) }
    }

    private fun waitUntil(condition: () -> Boolean) {
        composeRule.waitUntil(TIMEOUT_MS) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(STEP_MS))
            condition()
        }
    }

    private fun shows(text: String) =
        composeRule.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty()

    private fun SemanticsNodeInteraction.hasTextInside(text: String) =
        assert(hasText(text, substring = true) or hasAnyDescendant(hasText(text, substring = true)))

    @Test
    fun `payments on the phone, a refused one and another lineman's - then Try now with and without internet`() {
        // Mohan used this phone first and left two payments on it.
        signIn(PaymentFixtures.otherLogin)
        save(20_000)
        save(30_000)
        // Suresh signs in: one payment refused by the office earlier, two waiting.
        signIn(PaymentFixtures.login)
        val refused = save(10_000)
        office.forced[refused] = PaymentOutcome.REJECTED
        await { sync.run() }
        val mine = listOf(save(45_000), save(50_000))
        show()
        // The list is lazy: wait until its rows are laid out (not just composed).
        waitUntil { composeRule.onAllNodesWithTag(WaitingTags.row(mine[1])).fetchSemanticsNodes().isNotEmpty() }

        composeRule.onNodeWithTag(WaitingTags.COUNT).assert(hasText("5 पेमेंट अभी ऑफिस नहीं पहुँचे"))
        // Another lineman's payments: held, explained, with Call office.
        composeRule
            .onNodeWithTag(
                WaitingTags.HELD,
            ).hasTextInside("दूसरे लाइनमैन के 2 पेमेंट")
            .hasTextInside("ऑफिस को फ़ोन करें")
        composeRule
            .onNodeWithTag(
                WaitingTags.row(refused),
            ).hasTextInside("₹100")
            .hasTextInside("दिक्कत")
            .hasTextInside("ऑफिस ने यह पेमेंट नहीं लिया")
        composeRule
            .onNodeWithTag(
                WaitingTags.row(mine[1]),
            ).hasTextInside("₹500")
            .hasTextInside("फ़ोन में सेव")
            .hasTextInside("P-K7Q-0005")
        composeRule.onNodeWithTag(WaitingTags.call(refused)).performClick()
        val dial = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(Intent.ACTION_DIAL, dial.action)
        assertEquals(OfficeDialer.intent("9800000001").data, dial.data)
        assertTouchTargets()

        // No internet: honest words, nothing changes.
        online = false
        composeRule
            .onNodeWithTag(WaitingTags.TRY_NOW)
            .hasTextInside("अभी भेजें")
            .assertIsEnabled()
            .performClick()
        waitUntil { shows("इंटरनेट नहीं है") }
        composeRule.onNodeWithTag(WaitingTags.PUSH).hasTextInside("इंटरनेट आने पर अपने-आप जाएगा")

        // Internet back: Suresh's two go; Mohan's stay held; the refused one stays.
        online = true
        composeRule.onNodeWithTag(WaitingTags.TRY_NOW).performClick()
        waitUntil { composeRule.onAllNodesWithTag(WaitingTags.row(mine[1])).fetchSemanticsNodes().isEmpty() }
        composeRule.onNodeWithTag(WaitingTags.COUNT).assert(hasText("3 पेमेंट अभी ऑफिस नहीं पहुँचे"))
        composeRule.onNodeWithTag(WaitingTags.TRY_NOW).assertDoesNotExist()
        assertEquals(mine.toSet(), office.postedIds())
        assertTrue(office.received.none { it.collectorId == PaymentFixtures.otherLogin.user.id })
        assertEquals(PaymentState.NEEDS_OFFICE_HELP, await { db.paymentDao().get(refused) }!!.state)
    }

    @Test
    fun `nothing waiting`() {
        await { network.store.signIn(PaymentFixtures.login) }
        show()
        waitUntil { composeRule.onAllNodesWithTag(WaitingTags.NOTHING).fetchSemanticsNodes().isNotEmpty() }
        composeRule.onNodeWithTag(WaitingTags.NOTHING).hasTextInside("कुछ इंतज़ार में नहीं")
        composeRule.onNodeWithTag(WaitingTags.TRY_NOW).assertDoesNotExist()
        composeRule.onNodeWithTag(WaitingTags.HELD).assertDoesNotExist()
    }

    private fun assertTouchTargets() {
        val minimum = CableSizes.TouchMin
        val tappable =
            composeRule
                .onAllNodes(
                    SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick),
                ).fetchSemanticsNodes()
        assertTrue(tappable.isNotEmpty())
        for (node in tappable) {
            val (width, height) = with(composeRule.density) { node.size.width.toDp() to node.size.height.toDp() }
            assertTrue("$width x $height too small: ${node.config}", width >= minimum && height >= minimum)
        }
    }

    private companion object {
        const val TIMEOUT_MS = 10_000L
        const val STEP_MS = 10L
    }
}
