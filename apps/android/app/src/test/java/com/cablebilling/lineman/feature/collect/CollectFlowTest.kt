package com.cablebilling.lineman.feature.collect

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
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.NumberPadTags
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.data.db.CustomerSummary
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.RosterRepository
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.db.RosterSyncStatus
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.db.putRoster
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.customer.CustomerScreen
import com.cablebilling.lineman.feature.customer.CustomerTags
import com.cablebilling.lineman.feature.customer.CustomerViewModel
import com.cablebilling.lineman.feature.customer.RosterCustomerData
import com.cablebilling.lineman.feature.search.SearchData
import com.cablebilling.lineman.feature.search.SearchScreen
import com.cablebilling.lineman.feature.search.SearchTags
import com.cablebilling.lineman.feature.search.SearchViewModel
import com.cablebilling.lineman.printing.FakeReceiptPrinter
import com.cablebilling.lineman.printing.PrintProblem
import com.cablebilling.lineman.printing.PrintResult
import com.cablebilling.lineman.printing.receipt.ReceiptNumber
import com.cablebilling.lineman.ui.CableApp
import com.cablebilling.lineman.ui.PlaceholderScreen
import com.cablebilling.lineman.ui.navigation.CollectRoute
import com.cablebilling.lineman.ui.navigation.SearchRoute
import com.cablebilling.lineman.voice.VoiceLines
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * The whole collect journey through the real app shell (CableApp's NavHost), the real ViewModels, the
 * real offline roster and payment queue (in-memory Room), and the push against a fake office on
 * MockWebServer: search → customer → Amount → Method → Confirm → Save → Done (temporary number) →
 * push → Done shows the office's receipt number → Print → Done. Hindi UI, a 360 × 800 dp phone.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi-w360dp-h800dp")
class CollectFlowTest {
    @get:Rule
    val folder = TemporaryFolder()

    @get:Rule
    val composeRule = createComposeRule()

    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val speaker = RecordingSpeaker()
    private val office = FakePaymentServer()
    private val printer = FakeReceiptPrinter()
    private val pushes = RecordingPushTrigger()
    private val routes =
        Routes { request ->
            when {
                request.apiPath == "/payments:batch" -> office.handle(request)
                request.apiPath.startsWith("/customers/") -> Fixtures.response("getCustomer.response.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }
    private lateinit var network: TestNetwork
    private lateinit var roster: RosterRepository
    private lateinit var payments: PaymentRepository
    private lateinit var sync: PaymentSync
    private lateinit var navController: NavHostController
    private val ramesh = RosterFixtures.ramesh

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(RosterFixtures.login) }
        roster = RosterRepository(db, RosterStore(db, time), network.store, network.mobileApi, network.errors, time)
        payments = PaymentRepository(db, network.store, time, pushes)
        sync = PaymentSync(db, network.mobileApi, network.errors, network.store, time, json)
        await { db.putRoster(RosterFixtures.login.operator.id, RosterFixtures.page.customers) }
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    private fun showApp() {
        val voiceLines = VoiceLines(ApplicationProvider.getApplicationContext())
        val searchViewModel = SearchViewModel(TestSearchData(), SavedStateHandle())
        composeRule.setContent {
            navController = rememberNavController()
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme {
                    CableApp(
                        navController = navController,
                        searchHome = { onOpenCustomer, onOpenWaiting ->
                            SearchScreen(onOpenCustomer, onOpenWaiting, viewModel = searchViewModel)
                        },
                        customerScreen = { customerId, onCollect, onBack ->
                            val viewModel =
                                viewModel(
                                    key = customerId,
                                ) { CustomerViewModel(customerId, RosterCustomerData(roster), voiceLines) }
                            CustomerScreen(customerId, onCollect, onBack, viewModel = viewModel)
                        },
                        collectScreen = { customerId, onSaved, onBack ->
                            val viewModel =
                                viewModel(key = "collect-$customerId") {
                                    CollectViewModel(
                                        customerId,
                                        AppCollectData(roster, payments, time),
                                        voiceLines,
                                        createSavedStateHandle(),
                                    )
                                }
                            CollectScreen(customerId, onSaved, onBack, viewModel = viewModel)
                        },
                        collectDone = { paymentId, onPrinterSetup, onFinish ->
                            val viewModel =
                                viewModel(key = "done-$paymentId") {
                                    CollectDoneViewModel(paymentId, payments, network.store, printer, voiceLines, json)
                                }
                            CollectDoneScreen(paymentId, onPrinterSetup, onFinish, viewModel = viewModel)
                        },
                        waitingScreen = { PlaceholderScreen(title = "waiting", testTag = "screen_waiting") },
                    )
                }
            }
        }
    }

    private inner class TestSearchData : SearchData {
        override fun search(query: String): Flow<List<CustomerSummary>> = roster.search(query, SearchData.SEARCH_LIMIT)

        override fun syncStatus(): Flow<RosterSyncStatus> = MutableStateFlow(RosterSyncStatus(0, 5, false, null, 0))

        override fun requestSync() = Unit
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

    /** Search home → Ramesh → Collect: the Amount screen. */
    private fun openCollectForRamesh() {
        showApp()
        tap("1045")
        waitForTag(SearchTags.result(ramesh.id))
        composeRule.onNodeWithTag(SearchTags.result(ramesh.id)).performClick()
        waitForTag(CustomerTags.COLLECT)
        composeRule.onNodeWithTag(CustomerTags.COLLECT).performClick()
        waitForTag(CollectTags.AMOUNT_SCREEN)
    }

    /** Amount (₹500 chip) → Method (Cash) → Confirm, checking each screen, then Save. */
    private fun collectFiveHundredInCash() {
        composeRule.onNodeWithTag("nav_search").assertIsSelected()
        // Amount: pre-filled with the full due, the due line, quick amounts.
        composeRule.onNodeWithTag(CollectTags.CUSTOMER_NAME).assert(hasText("Ramesh Kumar"))
        composeRule.onNodeWithTag(CollectTags.DUE_NOW).assert(hasText("अभी बाकी: ₹900"))
        composeRule.onNodeWithTag(CollectTags.AMOUNT).hasTextInside("₹900")
        composeRule.onNodeWithTag(CollectTags.chip(90_000)).hasTextInside("पूरा बाकी ₹900")
        assertTrue(shows("कितने पैसे?"))
        assertTouchTargets()
        composeRule.onNodeWithTag(CollectTags.chip(50_000)).hasTextInside("₹500").performClick()
        waitUntil { shows("₹500") }
        composeRule.onNodeWithTag(CollectTags.AMOUNT).hasTextInside("₹500")
        composeRule.onNodeWithTag(CollectTags.NEXT).assert(hasText("आगे")).performClick()

        // Method: two giant tiles.
        waitForTag(CollectTags.METHOD_SCREEN)
        assertTrue(shows("पैसे कैसे दिए?"))
        composeRule.onNodeWithTag(CollectTags.UPI).hasTextInside("UPI")
        assertTouchTargets()
        composeRule.onNodeWithTag(CollectTags.CASH).hasTextInside("नकद").performClick()

        // Confirm: the card, read aloud, the big Save.
        waitForTag(CollectTags.CONFIRM_SCREEN)
        composeRule
            .onNodeWithTag(
                CollectTags.CONFIRM_CARD,
            ).hasTextInside("Ramesh Kumar")
            .hasTextInside("₹500")
            .hasTextInside("नकद")
        waitUntil { "Ramesh Kumar से पाँच सौ रुपये नकद" in speaker.said }
        assertTouchTargets()
        assertEquals(0, await { db.paymentDao().countWithRefPrefix("P-") })
        composeRule.onNodeWithTag(CollectTags.SAVE).assert(hasText("सेव करें")).performClick()
    }

    @Test
    fun `cash - search, customer, amount, method, confirm, save, done, sent to office, print, done`() {
        openCollectForRamesh()
        collectFiveHundredInCash()

        // Done: only after the commit; the temporary number, saved on phone, spoken.
        waitForTag(CollectTags.DONE_SCREEN)
        val row = await { db.paymentDao().oldestSavedOnPhone(10) }.single()
        assertEquals(50_000L, row.amountPaise)
        assertEquals(PaymentMethod.CASH, row.method)
        assertEquals(ramesh.id, row.customerId)
        assertEquals(1, pushes.requests)
        composeRule.onNodeWithTag(CollectTags.DONE_AMOUNT).hasTextInside("₹500")
        composeRule.onNodeWithTag(CollectTags.DONE_NUMBER).hasTextInside("अस्थायी नं.").hasTextInside("P-K7Q-0001")
        composeRule.onNodeWithTag(CollectTags.DONE_STATUS).hasTextInside("फ़ोन में सेव")
        composeRule.onNodeWithTag(CollectTags.DONE_NOTE).hasTextInside("इंटरनेट आने पर")
        waitUntil { "पैसे फ़ोन में सेव हो गए" in speaker.said }
        assertTrue(speaker.said.none { it.contains("भेज") || it.contains("sent", ignoreCase = true) })
        composeRule.onNodeWithTag("nav_search").assertIsSelected()
        // The collect flow is gone from the back stack: Back from Done can never reach Save again.
        assertTrue(navController.currentBackStack.value.none { it.destination.hasRoute(CollectRoute::class) })
        composeRule.onNodeWithTag(CollectTags.WHATSAPP).assertIsNotEnabled()
        composeRule.onNodeWithTag(CollectTags.SMS).assertIsNotEnabled()
        assertTouchTargets()

        // The push reaches the office: the screen switches to the permanent number by itself.
        await { sync.run() }
        waitUntil { shows("R-2610-00045") }
        composeRule.onNodeWithTag(CollectTags.DONE_NUMBER).hasTextInside("रसीद नं.").hasTextInside("R-2610-00045")
        composeRule.onNodeWithTag(CollectTags.DONE_STATUS).hasTextInside("ऑफिस पहुँच गया")
        composeRule.onNodeWithTag(CollectTags.DONE_NOTE).assertDoesNotExist()
        assertEquals(PaymentState.SENT_TO_OFFICE, await { db.paymentDao().get(row.id) }!!.state)

        // Print: the receipt carries the permanent number and the bill it paid.
        composeRule.onNodeWithTag(CollectTags.PRINT).assertIsEnabled().performClick()
        waitUntil { shows("प्रिंटर को मिल गया") }
        val receipt = printer.receipts.single()
        assertEquals(ReceiptNumber.Permanent("R-2610-00045"), receipt.number)
        assertEquals(50_000L, receipt.amountPaise)
        assertEquals("Suresh Yadav", receipt.linemanName)
        assertEquals("Shiv Cable Network", receipt.operatorName)
        assertEquals(1, receipt.bills.size)

        // Done: back to the search home for the next customer.
        composeRule.onNodeWithTag(CollectTags.FINISH).hasTextInside("हो गया").performClick()
        waitForTag(SearchTags.QUERY)
        assertTrue(
            navController.currentBackStack.value
                .last()
                .destination
                .hasRoute(SearchRoute::class),
        )
        assertEquals(1, office.postedCount)
    }

    @Test
    fun `UPI with a reference, a failed print says the payment is safe and offers printer setup`() {
        printer.next = PrintResult.Failed(PrintProblem.NotPaired)
        openCollectForRamesh()
        tap("300") // the first key replaces the pre-filled due
        composeRule.onNodeWithTag(CollectTags.AMOUNT).hasTextInside("₹300")
        composeRule.onNodeWithTag(CollectTags.NEXT).performClick()
        waitForTag(CollectTags.METHOD_SCREEN)
        composeRule.onNodeWithTag(CollectTags.UPI).performClick()

        waitForTag(CollectTags.UPI_SCREEN)
        assertTrue(shows("UPI रेफ़. नं."))
        composeRule.onNodeWithTag(CollectTags.UPI_NEXT).assertIsNotEnabled()
        composeRule.onNodeWithTag(CollectTags.UPI_SKIP).hasTextInside("छोड़ें")
        composeRule.onNodeWithTag(CollectTags.UPI_FIELD).performTextInput("429876123456")
        composeRule.onNodeWithTag(CollectTags.UPI_NEXT).assertIsEnabled().performClick()

        waitForTag(CollectTags.CONFIRM_SCREEN)
        composeRule
            .onNodeWithTag(
                CollectTags.CONFIRM_CARD,
            ).hasTextInside("₹300")
            .hasTextInside("UPI रेफ़.: 429876123456")
        waitUntil { "Ramesh Kumar से तीन सौ रुपये UPI" in speaker.said }
        composeRule.onNodeWithTag(CollectTags.SAVE).performClick()

        waitForTag(CollectTags.DONE_SCREEN)
        val row = await { db.paymentDao().oldestSavedOnPhone(10) }.single()
        assertEquals(PaymentMethod.UPI, row.method)
        assertEquals("429876123456", row.upiReference)
        assertEquals(30_000L, row.amountPaise)

        composeRule.onNodeWithTag(CollectTags.PRINT).performClick()
        waitForTag(CollectTags.PRINT_PROBLEM)
        composeRule.onNodeWithTag(CollectTags.PRINT_PROBLEM).hasTextInside("पेमेंट सेव है। सिर्फ़ प्रिंट नहीं हुआ।")
        composeRule.onNodeWithTag(CollectTags.PRINTER_SETUP).hasTextInside("प्रिंटर लगाएँ")
        assertEquals(ReceiptNumber.Provisional("P-K7Q-0001"), printer.receipts.single().number)
        assertTrue(
            printer.receipts
                .single()
                .bills
                .isEmpty(),
        )
        // Printing never touches the payment (RULE-18).
        assertEquals(PaymentState.SAVED_ON_PHONE, await { db.paymentDao().get(row.id) }!!.state)
    }

    @Test
    fun `back on Method returns to Amount, and back on Amount returns to the customer`() {
        openCollectForRamesh()
        composeRule.onNodeWithTag(CollectTags.NEXT).performClick()
        waitForTag(CollectTags.METHOD_SCREEN)
        composeRule.onNodeWithTag(CollectTags.BACK).hasTextInside("पीछे").performClick()
        waitForTag(CollectTags.AMOUNT_SCREEN)
        composeRule.onNodeWithTag(CollectTags.AMOUNT).hasTextInside("₹900")
        composeRule.onNodeWithTag(CollectTags.BACK).performClick()
        waitForTag(CustomerTags.COLLECT)
        assertEquals(0, await { db.paymentDao().countWithRefPrefix("P-") })
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

    /** Remembers what it was asked to say. */
    private class RecordingSpeaker : Speaker {
        val said: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())
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
    }
}
