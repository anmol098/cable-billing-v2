package com.cablebilling.lineman.feature.today

import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.NumberPadTags
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.today.TodayFixtures.DATE
import com.cablebilling.lineman.feature.today.TodayFixtures.OTHER_USER
import com.cablebilling.lineman.feature.today.TodayFixtures.payment
import com.cablebilling.lineman.ui.CableApp
import com.cablebilling.lineman.ui.PlaceholderScreen
import com.cablebilling.lineman.voice.VoiceLines
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration
import java.util.Collections
import java.util.concurrent.Executors

/**
 * The Today tab and the cash handover through the real app shell (CableApp's NavHost), the real
 * ViewModels and repository (in-memory Room) and a fake office on MockWebServer: Today's cash and UPI
 * tiles → Hand over cash → a short amount → reason → Confirm → saved on the phone (never "sent") → the
 * office takes it ("Sent to office", "Waiting for check") → sent back with a note → handed over again →
 * accepted. Hindi UI, a 360 × 800 dp phone.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi-w360dp-h800dp")
class TodayFlowTest {
    @get:Rule
    val folder = TemporaryFolder()

    @get:Rule
    val composeRule = createComposeRule()

    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val speaker = RecordingSpeaker()
    private val office = FakeHandoverOffice()
    private val routes =
        Routes { request ->
            when {
                request.apiPath.startsWith("/collections/") -> office.handle(request)
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }
    private lateinit var network: TestNetwork
    private lateinit var repository: TodayRepository

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(RosterFixtures.login) }
        repository = TodayRepository(db, network.mobileApi, network.errors, network.store, time, json) { }
        // The office has Ramesh ₹500 + Mohan ₹200 cash and Sunita ₹450 UPI. On the phone: Ramesh's ₹500
        // (sent), ₹100 cash not sent yet, and another lineman's ₹900 held on this shared phone.
        office.payments += FakeHandoverOffice.fixturePayments()
        await {
            db.paymentDao().insert(payment(RAMESH_PAYMENT, 50_000, state = PaymentState.SENT_TO_OFFICE))
            db.paymentDao().insert(payment(ON_PHONE, 10_000))
            db.paymentDao().insert(payment("01929b11-2c3d-7e4f-9a05-000000000099", 90_000, collectorId = OTHER_USER))
        }
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    /** The app's [TodayData] on the real repository; "send now" is recorded, the test sends by hand. */
    private inner class TestTodayData : TodayData {
        var sendRequests = 0

        override fun session(): Flow<SessionState> = network.store.state

        override fun day(
            collectorId: String,
            businessDate: String,
        ) = repository.observeDay(collectorId, businessDate)

        override suspend fun refresh(businessDate: String) = repository.refresh(businessDate)

        override suspend fun queueHandover(
            businessDate: String,
            request: HandoverRequest,
        ) = repository.queueHandover(businessDate, request)

        override fun sendNow() {
            sendRequests++
        }

        override fun newSubmissionId(): String =
            com.cablebilling.lineman.data.payments.UuidV7
                .generate(time.nowMillis())

        override fun nowMillis(): Long = time.nowMillis()
    }

    private fun showApp() {
        val voiceLines = VoiceLines(ApplicationProvider.getApplicationContext())
        val data = TestTodayData()
        composeRule.setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme {
                    CableApp(
                        searchHome = { _, _ -> PlaceholderScreen(title = "search", testTag = "screen_search") },
                        waitingScreen = { PlaceholderScreen(title = "waiting", testTag = "screen_waiting") },
                        todayScreen = { onHandOver ->
                            val viewModel = viewModel { TodayViewModel(data, voiceLines) }
                            TodayScreen(onHandOver, viewModel = viewModel)
                        },
                        handoverScreen = { businessDate, onDone, onBack ->
                            val viewModel =
                                viewModel(key = "handover-$businessDate") {
                                    HandoverViewModel(businessDate, data, voiceLines, createSavedStateHandle())
                                }
                            HandoverScreen(businessDate, onDone, onBack, viewModel = viewModel)
                        },
                    )
                }
            }
        }
    }

    @Test
    fun `today's cash and UPI apart, hand over a short amount with a reason, office review, hand over again`() {
        showApp()
        composeRule.onNodeWithTag("nav_today").performClick()
        waitForTag(TodayTags.CASH_TILE)
        composeRule.onNodeWithTag("nav_today").assertIsSelected()
        checkToday()
        handOverShortWithReason()
        officeTakesItThenSendsItBack()
        handOverAgainAndAccepted()
    }

    /** Today: tiles, what is on the phone, what the office has, read aloud. */
    private fun checkToday() {
        // Today: the office's ₹700 + ₹100 on the phone = ₹800 cash; UPI ₹450 on its own tile.
        waitUntil { node(TodayTags.CASH_TILE).has("₹800") }
        composeRule.onNodeWithTag(TodayTags.CASH_TILE).hasTextInside("नकद").hasTextInside("₹800")
        composeRule.onNodeWithTag(TodayTags.UPI_TILE).hasTextInside("UPI").hasTextInside("₹450")
        composeRule.onNodeWithTag(TodayTags.COUNT).assert(hasText("4 पेमेंट"))
        composeRule.onNodeWithTag(TodayTags.ON_PHONE).hasTextInside("1 पेमेंट सिर्फ़ फ़ोन में है").hasTextInside("₹100")
        composeRule.onNodeWithTag(TodayTags.AT_OFFICE).hasTextInside("ऑफिस में").hasTextInside("₹700")
        composeRule.onNodeWithTag(TodayTags.HANDOVER_STATE).hasTextInside("कैश नहीं दिया")
        assertFalse("another lineman's ₹900 is not this lineman's", shows("₹900"))
        assertFalse("never one mixed total", shows("₹1,250"))
        waitUntil { "आज आठ सौ रुपये नकद, चार सौ पचास रुपये UPI" in speaker.said }
        assertTouchTargets()
    }

    /** Hand over ₹750 (₹50 short), pick a reason, confirm: saved on the phone, never "sent". */
    private fun handOverShortWithReason() {
        // Hand over: pre-filled with the expected cash, where it comes from.
        composeRule
            .onNodeWithTag(
                TodayTags.HAND_OVER,
            ).assert(hasText("ऑफिस को कैश दें", substring = true))
            .performClick()
        waitForTag(TodayTags.AMOUNT_SCREEN)
        composeRule.onNodeWithTag(TodayTags.EXPECTED).hasTextInside("कितना कैश होना चाहिए ₹800")
        composeRule.onNodeWithTag(TodayTags.SOURCE).hasTextInside("₹700 ऑफिस में + ₹100 फ़ोन में")
        composeRule.onNodeWithTag(TodayTags.AMOUNT).hasTextInside("₹800")
        assertTouchTargets()
        tap("750")
        waitUntil { node(TodayTags.DIFFERENCE).has("₹50 कम") }
        composeRule.onNodeWithTag(TodayTags.NEXT).performClick()

        // Why is it different: icon tiles that fit "short", a reason is needed.
        waitForTag(TodayTags.REASON_SCREEN)
        assertTrue(shows("फ़र्क क्यों है?"))
        composeRule.onNodeWithTag(TodayTags.NEXT).assertIsNotEnabled()
        assertTrue(composeRule.onAllNodesWithTag(TodayTags.reason("extra")).fetchSemanticsNodes().isEmpty())
        composeRule.onNodeWithTag(TodayTags.reason("pending_sync")).hasTextInside("पेमेंट फ़ोन में हैं")
        composeRule.onNodeWithTag(TodayTags.reason("other")).hasTextInside("कुछ और")
        composeRule.onNodeWithTag(TodayTags.reason("short")).hasTextInside("कैश कम है").performClick()
        composeRule.onNodeWithTag(TodayTags.NEXT).assertIsEnabled()
        assertTouchTargets()
        composeRule.onNodeWithTag(TodayTags.NEXT).performClick()

        // Confirm, read aloud, then saved on the phone — Today says so, never "sent".
        waitForTag(TodayTags.CONFIRM_SCREEN)
        composeRule
            .onNodeWithTag(
                TodayTags.CONFIRM_CARD,
            ).hasTextInside("₹750")
            .hasTextInside("₹50 कम")
            .hasTextInside("कैश कम है")
        waitUntil { speaker.said.any { it.endsWith("कैश ऑफिस को") } }
        assertTouchTargets()
        composeRule.onNodeWithTag(TodayTags.SUBMIT).performClick()
        waitForTag(TodayTags.SCREEN)
        waitUntil { node(TodayTags.HANDOVER_STATE).has("फ़ोन में सेव") }
        composeRule.onNodeWithTag(TodayTags.HANDOVER_CARD).hasTextInside("आपने दिया ₹750")
        assertFalse(node(TodayTags.HANDOVER_CARD).has("ऑफिस पहुँच गया"))
        val saved = queuedNow()
        assertEquals(75_000L, saved.request.cashHandedOverPaise)
        assertEquals("short", saved.request.discrepancyReason?.wire)
        assertEquals(1L, saved.request.unsyncedPaymentCount)
        assertEquals(10_000L, saved.request.unsyncedCashPaise)
    }

    /** The office gets it (after the payment), then sends it back with a note. */
    private fun officeTakesItThenSendsItBack() {
        // Internet: the payment goes first (the office now has ₹800), then the handover.
        pushOnPhonePayment()
        sendQueued()
        waitUntil { node(TodayTags.HANDOVER_STATE).has("ऑफिस पहुँच गया") }
        composeRule.onNodeWithTag(TodayTags.HANDOVER_REVIEW).hasTextInside("जाँच बाकी")
        composeRule.onNodeWithTag(TodayTags.HANDOVER_DIFFERENCE).hasTextInside("₹50 कम")
        composeRule.onNodeWithTag(TodayTags.HANDOVER_CARD).hasTextInside("कितना कैश होना चाहिए ₹800")

        // The office sends it back with a note.
        office.sendBack("फिर से गिनें")
        composeRule.onNodeWithTag(TodayTags.CHECK_AGAIN).performScrollTo().performClick()
        waitUntil { node(TodayTags.HANDOVER_REVIEW).has("वापस भेजा") }
        composeRule.onNodeWithTag(TodayTags.HANDOVER_NOTE).assert(hasText("ऑफिस ने कहा: फिर से गिनें"))
    }

    /** Hand over again (the amount matches now), then the office accepts: no more handing over. */
    private fun handOverAgainAndAccepted() {
        // Hand over again: ₹800 now matches → straight to Confirm, no reason asked.
        composeRule
            .onNodeWithTag(
                TodayTags.HAND_OVER,
            ).assert(hasText("फिर से कैश दें", substring = true))
            .performClick()
        waitForTag(TodayTags.AMOUNT_SCREEN)
        composeRule.onNodeWithTag(TodayTags.AMOUNT).hasTextInside("₹800")
        composeRule.onNodeWithTag(TodayTags.DIFFERENCE).hasTextInside("कैश पूरा है")
        composeRule.onNodeWithTag(TodayTags.NEXT).performClick()
        waitForTag(TodayTags.CONFIRM_SCREEN)
        composeRule.onNodeWithTag(TodayTags.SUBMIT).performClick()
        waitForTag(TodayTags.SCREEN)
        sendQueued()
        waitUntil { node(TodayTags.HANDOVER_REVIEW).has("जाँच बाकी") }
        office.accept()
        composeRule.onNodeWithTag(TodayTags.CHECK_AGAIN).performScrollTo().performClick()
        waitUntil { node(TodayTags.HANDOVER_REVIEW).has("मंज़ूर") }
        composeRule.onNodeWithTag(TodayTags.HANDOVER_DIFFERENCE).hasTextInside("कैश पूरा है")
        assertTrue(composeRule.onAllNodesWithTag(TodayTags.HAND_OVER).fetchSemanticsNodes().isEmpty())
        assertEquals(2, office.submissions.size)
        assertTouchTargets()
    }

    @Test
    fun `offline - the phone's own count, labelled, and a handover that waits on the phone`() {
        server.close() // no office at all
        showApp()
        composeRule.onNodeWithTag("nav_today").performClick()
        waitForTag(TodayTags.CASH_TILE)
        waitUntil { node(TodayTags.PHONE_ONLY).has("इस फ़ोन में गिना") }
        composeRule.onNodeWithTag(TodayTags.CASH_TILE).hasTextInside("₹600")
        composeRule.onNodeWithTag(TodayTags.UPI_TILE).hasTextInside("₹0")
        assertTrue(composeRule.onAllNodesWithTag(TodayTags.AT_OFFICE).fetchSemanticsNodes().isEmpty())

        composeRule.onNodeWithTag(TodayTags.HAND_OVER).performClick()
        waitForTag(TodayTags.AMOUNT_SCREEN)
        composeRule.onNodeWithTag(TodayTags.EXPECTED).hasTextInside("₹600")
        composeRule.onNodeWithTag(TodayTags.SOURCE).hasTextInside("इस फ़ोन में गिना (इंटरनेट नहीं है)")
        composeRule.onNodeWithTag(TodayTags.NEXT).performClick()
        waitForTag(TodayTags.CONFIRM_SCREEN)
        composeRule.onNodeWithTag(TodayTags.SUBMIT).performClick()
        waitForTag(TodayTags.SCREEN)
        waitUntil { node(TodayTags.HANDOVER_STATE).has("इंटरनेट आने पर अपने-आप ऑफिस जाएगा") }
        val saved = queuedNow()
        assertEquals(60_000L, saved.request.cashHandedOverPaise)
        assertEquals("pending_sync", saved.request.discrepancyReason?.wire)
    }

    /** What the payment push does first (T-066): the ₹100 reaches the office and is marked sent on the phone. */
    private fun pushOnPhonePayment() {
        await {
            val row = db.paymentDao().get(ON_PHONE)!!
            db.paymentDao().update(row.copy(state = PaymentState.SENT_TO_OFFICE, receiptNumber = "R-2610-00047"))
        }
        office.payments += TodayFixtures.officePayment(ON_PHONE, 10_000)
    }

    /**
     * Sends the saved handovers off the main thread while the main looper keeps running (a day check the
     * screen started may be finishing on it), as the background work does in the app.
     */
    private fun sendQueued() {
        val sender = Executors.newSingleThreadExecutor()
        val done = sender.submit<HandoverSendResult> { await { repository.sendQueued() } }
        waitUntil { done.isDone }
        assertEquals(HandoverSendResult.Done(1, 0), done.get())
        sender.shutdown()
    }

    private fun queuedNow(): QueuedHandover =
        await { repository.observeDay(TodayFixtures.userId, DATE).first() }.queued!!

    private fun node(tag: String) = Found(tag)

    private inner class Found(
        private val tag: String,
    ) {
        fun has(text: String): Boolean =
            composeRule
                .onAllNodes(
                    androidx.compose.ui.test
                        .hasTestTag(tag) and
                        (hasText(text, substring = true) or hasAnyDescendant(hasText(text, substring = true))),
                ).fetchSemanticsNodes()
                .isNotEmpty()
    }

    private fun waitForTag(tag: String) =
        waitUntil {
            composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }

    private fun waitUntil(condition: () -> Boolean) {
        composeRule.waitUntil(TIMEOUT_MS) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(STEP_MS))
            condition()
        }
    }

    private fun tap(digits: String) =
        digits.forEach {
            composeRule.onNodeWithTag(NumberPadTags.digit(it.digitToInt())).performClick()
        }

    private fun SemanticsNodeInteraction.hasTextInside(text: String) =
        assert(hasText(text, substring = true) or hasAnyDescendant(hasText(text, substring = true)))

    private fun shows(text: String) =
        composeRule.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty()

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

    /** Remembers what it was asked to say. */
    private class RecordingSpeaker : Speaker {
        val said: MutableList<String> = Collections.synchronizedList(mutableListOf())
        private val muted = MutableStateFlow(false)
        override val isMuted: StateFlow<Boolean> = muted

        override fun setMuted(muted: Boolean) {
            this.muted.value = muted
        }

        override fun say(text: String) {
            said += text
        }

        override fun stop() = Unit
    }

    private companion object {
        const val TIMEOUT_MS = 10_000L
        const val STEP_MS = 10L
        const val RAMESH_PAYMENT = "01929b11-2c3d-7e4f-9a05-000000000001"
        const val ON_PHONE = "01929b11-2c3d-7e4f-9a05-000000000010"
    }
}
