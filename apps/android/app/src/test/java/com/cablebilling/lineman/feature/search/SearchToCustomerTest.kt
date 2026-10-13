package com.cablebilling.lineman.feature.search

import android.content.Intent
import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.NumberPadTags
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.data.db.CustomerSummary
import com.cablebilling.lineman.data.db.FakeTime
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
import com.cablebilling.lineman.feature.customer.CustomerScreen
import com.cablebilling.lineman.feature.customer.CustomerTags
import com.cablebilling.lineman.feature.customer.CustomerViewModel
import com.cablebilling.lineman.feature.customer.RosterCustomerData
import com.cablebilling.lineman.ui.CableApp
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
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * Search → customer through the real app shell (CableApp's NavHost), the real ViewModels and the real
 * offline roster (in-memory Room, contract fixtures; the customer refresh answers from MockWebServer).
 * Hindi UI, Robolectric.
 */
@RunWith(AndroidJUnit4::class)
// A common budget phone (360 x 800 dp): the number pad takes about half the screen.
@Config(qualifiers = "hi-w360dp-h800dp")
class SearchToCustomerTest {
    @get:Rule
    val folder = TemporaryFolder()

    @get:Rule
    val composeRule = createComposeRule()

    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val speaker = RecordingSpeaker()
    private val routes =
        Routes { request ->
            when {
                request.apiPath.startsWith("/customers/") -> Fixtures.response("getCustomer.response.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }
    private lateinit var network: TestNetwork
    private lateinit var roster: RosterRepository
    private lateinit var searchViewModel: SearchViewModel
    private val status = MutableStateFlow(RosterSyncStatus(0, 5, false, null, 0))
    private var refreshRequests = 0
    private val ramesh = RosterFixtures.ramesh
    private val sunita = RosterFixtures.sunita

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(RosterFixtures.login) }
        roster = RosterRepository(db, RosterStore(db, time), network.store, network.mobileApi, network.errors, time)
        await { db.putRoster(RosterFixtures.login.operator.id, RosterFixtures.page.customers) }
        searchViewModel = SearchViewModel(TestSearchData(), SavedStateHandle())
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    /** Search data on the real roster; the strip's status is set by the test. */
    private inner class TestSearchData : SearchData {
        override fun search(query: String): Flow<List<CustomerSummary>> = roster.search(query, SearchData.SEARCH_LIMIT)

        override fun syncStatus(): Flow<RosterSyncStatus> = status

        override fun requestSync() {
            refreshRequests++
        }
    }

    private fun showApp() {
        val voiceLines = VoiceLines(ApplicationProvider.getApplicationContext())
        composeRule.setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme {
                    CableApp(
                        searchHome = { onOpenCustomer, onOpenWaiting ->
                            SearchScreen(onOpenCustomer, onOpenWaiting, viewModel = searchViewModel)
                        },
                        customerScreen = { customerId, onCollect, onBack ->
                            val customerViewModel =
                                // Scoped to the screen's back-stack entry, like hiltViewModel in the app.
                                viewModel(key = customerId) {
                                    CustomerViewModel(customerId, RosterCustomerData(roster), voiceLines)
                                }
                            CustomerScreen(customerId, onCollect, onBack, viewModel = customerViewModel)
                        },
                    )
                }
            }
        }
    }

    /** Lets the main looper run (Robolectric's clock: debounce pauses) until [tag] shows. */
    private fun waitForTag(tag: String) {
        composeRule.waitUntil(TIMEOUT_MS) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(STEP_MS))
            composeRule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
        }
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

    /** The node, or something inside it, shows [text]. */
    private fun SemanticsNodeInteraction.hasTextInside(text: String) =
        assert(hasText(text, substring = true) or hasAnyDescendant(hasText(text, substring = true)))

    private fun shows(text: String) =
        composeRule.onAllNodes(hasText(text, substring = true)).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun `type 1045 on the pad, open Ramesh, see and hear his due, then collect`() {
        showApp()
        composeRule.onNodeWithTag(SearchTags.HINT).assert(hasText("कोड, फ़ोन या VC नंबर लिखें"))
        composeRule.onNodeWithTag(SearchTags.BANNER).hasTextInside("5 मिनट पहले अपडेट हुआ")

        tap("1045")
        composeRule.onNodeWithTag(SearchTags.QUERY).hasTextInside("1045")
        waitForTag(SearchTags.result(ramesh.id))
        composeRule
            .onNodeWithTag(SearchTags.result(ramesh.id))
            .hasTextInside("Ramesh Kumar")
            .hasTextInside("Shiv Nagar")
            .hasTextInside("₹900")
            .hasTextInside("बाकी")

        composeRule.onNodeWithTag(SearchTags.result(ramesh.id)).performClick()
        waitForTag(CustomerTags.NAME)
        composeRule.onNodeWithTag("nav_search").assertIsSelected()
        composeRule.onNodeWithTag(CustomerTags.NAME).assert(hasText("Ramesh Kumar"))
        composeRule.onNodeWithTag(CustomerTags.CODE).assert(hasText("1045"))
        composeRule.onNodeWithTag(CustomerTags.AREA).hasTextInside("Shiv Nagar")
        composeRule.onNodeWithTag(CustomerTags.CONNECTIONS).hasTextInside("2 कनेक्शन")
        composeRule.onNodeWithTag(CustomerTags.DUE).hasTextInside("₹900").hasTextInside("बाकी")
        composeRule.onNodeWithTag(CustomerTags.CREDIT).assertDoesNotExist()
        composeRule.onNodeWithTag(CustomerTags.call(0)).hasTextInside("9876543210").hasTextInside("फ़ोन करें")
        composeRule.onNodeWithTag(CustomerTags.COLLECT).assert(hasText("पैसे लें")).assertIsDisplayed()

        // Tap-to-call opens the dialer with the number (ACTION_DIAL: no call permission).
        composeRule.onNodeWithTag(CustomerTags.call(0)).performClick()
        val dial = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(Intent.ACTION_DIAL, dial.action)
        assertEquals("tel:9876543210", dial.data.toString())

        // Spoken when the screen shows, without ₹ or digits; the office was asked for a fresh copy.
        waitUntil { speaker.said.isNotEmpty() }
        assertTrue(speaker.said.first(), speaker.said.first().startsWith("Ramesh Kumar, "))
        assertTrue(speaker.said.first(), speaker.said.first().none { it == '₹' || it.isDigit() })
        waitUntil { routes.requestsTo("/customers/${ramesh.id}").isNotEmpty() }

        composeRule.onNodeWithTag(CustomerTags.COLLECT).performClick()
        waitForTag("screen_collect")
        composeRule.onNodeWithTag("nav_search").assertIsSelected()
    }

    @Test
    fun `back and the Search tab return to the search with the digits still typed`() {
        showApp()
        tap("1046")
        waitForTag(SearchTags.result(sunita.id))
        // Sunita has an advance: green, with its word.
        composeRule.onNodeWithTag(SearchTags.result(sunita.id)).hasTextInside("₹50").hasTextInside("एडवांस")

        composeRule.onNodeWithTag(SearchTags.result(sunita.id)).performClick()
        waitForTag(CustomerTags.CREDIT)
        composeRule.onNodeWithTag(CustomerTags.DUE).hasTextInside("₹0").hasTextInside("कुछ बाकी नहीं")
        composeRule.onNodeWithTag(CustomerTags.CREDIT).hasTextInside("₹50").hasTextInside("एडवांस")
        composeRule.onNodeWithTag(CustomerTags.call(0)).assertDoesNotExist()

        composeRule.onNodeWithTag(CustomerTags.BACK).assert(hasText("पीछे")).performClick()
        waitForTag(SearchTags.QUERY)
        composeRule.onNodeWithTag(SearchTags.QUERY).hasTextInside("1046")

        composeRule.onNodeWithTag(SearchTags.result(sunita.id)).performClick()
        waitForTag(CustomerTags.NAME)
        composeRule.onNodeWithTag("nav_search").performClick()
        waitForTag(SearchTags.QUERY)
        composeRule.onNodeWithTag(CustomerTags.SCREEN).assertDoesNotExist()
    }

    @Test
    fun `ABC opens name search, 123 brings the pad back`() {
        showApp()
        composeRule.onNodeWithTag(NumberPadTags.LETTERS).assert(hasText("ABC")).performClick()
        composeRule.onNodeWithTag(SearchTags.TEXT_FIELD).performTextInput("sunita")
        waitForTag(SearchTags.result(sunita.id))
        composeRule.onNodeWithTag(SearchTags.result(ramesh.id)).assertDoesNotExist()
        composeRule.onNodeWithTag(NumberPadTags.digit(1)).assertDoesNotExist()

        composeRule.onNodeWithTag(SearchTags.NUMBERS_KEY).assert(hasText("123")).performClick()
        waitForTag(NumberPadTags.digit(1))
        composeRule.onNodeWithTag(SearchTags.HINT).assertIsDisplayed()
    }

    @Test
    fun `nobody found, and the strip tells the truth`() {
        showApp()
        tap("5555")
        waitForTag(SearchTags.NO_RESULTS)
        composeRule.onNodeWithTag(SearchTags.NO_RESULTS).hasTextInside("कोई ग्राहक नहीं मिला")

        status.value = RosterSyncStatus(0, 12, false, "offline", 0)
        waitUntil { shows("इंटरनेट नहीं है · 12 मिनट पहले अपडेट हुआ") }
        composeRule.onNodeWithTag(SearchTags.BANNER).performClick()
        assertEquals(1, refreshRequests)

        status.value = RosterSyncStatus(0, 12, false, null, 3)
        waitUntil { shows("फ़ोन में 3 पेमेंट") }
        composeRule.onNodeWithTag(SearchTags.BANNER).performClick()
        waitForTag("screen_waiting")
        assertEquals("a tap with payments waiting opens Waiting, no sync", 1, refreshRequests)
    }

    @Test
    fun `every tappable thing on both screens is at least the minimum touch size`() {
        showApp()
        tap("1045")
        waitForTag(SearchTags.result(ramesh.id))
        assertTouchTargets()
        composeRule.onNodeWithTag(SearchTags.result(ramesh.id)).performClick()
        waitForTag(CustomerTags.COLLECT)
        assertTouchTargets()
    }

    private fun assertTouchTargets() {
        val minimum = com.cablebilling.designsystem.theme.CableSizes.TouchMin
        val tappable =
            composeRule
                .onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick))
                .fetchSemanticsNodes()
        assertTrue(tappable.isNotEmpty())
        for (node in tappable) {
            val (width, height) = with(composeRule.density) { node.size.width.toDp() to node.size.height.toDp() }
            assertTrue("$width x $height too small: ${node.config}", width >= minimum && height >= minimum)
        }
    }

    /** Remembers what it was asked to say. */
    private class RecordingSpeaker : Speaker {
        val said = mutableListOf<String>()
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
