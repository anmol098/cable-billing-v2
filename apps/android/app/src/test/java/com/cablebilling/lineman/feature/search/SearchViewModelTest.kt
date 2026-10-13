package com.cablebilling.lineman.feature.search

import androidx.lifecycle.SavedStateHandle
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.SyncState
import com.cablebilling.lineman.data.db.CustomerSummary
import com.cablebilling.lineman.data.db.ProjectedBalance
import com.cablebilling.lineman.data.db.RosterSyncStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
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

/** The search home's ViewModel on virtual time (StandardTestDispatcher): debounce, keys, modes, banner. */
@OptIn(ExperimentalCoroutinesApi::class)
class SearchViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val data = FakeSearchData()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.newViewModel(saved: SavedStateHandle = SavedStateHandle()): SearchViewModel {
        val viewModel = SearchViewModel(data, saved)
        // The screen's collector (stateIn WhileSubscribed).
        backgroundScope.launch { viewModel.state.collect {} }
        runCurrent()
        return viewModel
    }

    private fun SearchViewModel.type(digits: String) = digits.forEach { onKey(NumberPadKey.Digit(it.digitToInt())) }

    @Test
    fun `four quick digits start one search, after the pause`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()

            viewModel.type("1045")
            runCurrent()
            assertEquals("1045", viewModel.state.value.query)
            assertEquals(emptyList<String>(), data.searches)
            assertFalse("no 'not found' while the search is pending", viewModel.state.value.showsNoResults)

            advanceTimeBy(SearchViewModel.DIGITS_DEBOUNCE_MS - 1)
            runCurrent()
            assertEquals(emptyList<String>(), data.searches)

            advanceTimeBy(2)
            runCurrent()
            assertEquals(listOf("1045"), data.searches)
            assertEquals(
                listOf("Ramesh Kumar"),
                viewModel.state.value.results
                    .map { it.name },
            )
            assertEquals("1045", viewModel.state.value.resultsFor)
        }

    @Test
    fun `slow typing searches after every digit, newest wins`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()

            viewModel.type("1")
            advanceTimeBy(SearchViewModel.DIGITS_DEBOUNCE_MS + 1)
            runCurrent()
            assertEquals(
                listOf("Ramesh Kumar", "Sunita Devi"),
                viewModel.state.value.results
                    .map { it.name },
            )

            viewModel.type("046")
            advanceTimeBy(SearchViewModel.DIGITS_DEBOUNCE_MS + 1)
            runCurrent()
            assertEquals(listOf("1", "1046"), data.searches)
            assertEquals(
                listOf("Sunita Devi"),
                viewModel.state.value.results
                    .map { it.name },
            )
        }

    @Test
    fun `backspace, long-press clear and the digit limit`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()

            viewModel.type("0981")
            viewModel.onKey(NumberPadKey.Backspace)
            runCurrent()
            assertEquals("098", viewModel.state.value.query)
            assertEquals(
                "a phone may start with 0",
                '0',
                viewModel.state.value.query
                    .first(),
            )

            viewModel.onKey(NumberPadKey.Clear)
            runCurrent()
            assertEquals("", viewModel.state.value.query)
            assertTrue(viewModel.state.value.isBlank)
            assertEquals(emptyList<CustomerSummary>(), viewModel.state.value.results)

            viewModel.type("1".repeat(SearchViewModel.MAX_DIGITS + 5))
            runCurrent()
            assertEquals(SearchViewModel.MAX_DIGITS, viewModel.state.value.query.length)
        }

    @Test
    fun `clearing shows nothing at once and never searches for blank`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.type("10")
            advanceTimeBy(SearchViewModel.DIGITS_DEBOUNCE_MS + 1)
            runCurrent()
            assertEquals(2, viewModel.state.value.results.size)

            viewModel.onKey(NumberPadKey.Clear)
            runCurrent()
            assertEquals(emptyList<CustomerSummary>(), viewModel.state.value.results)
            assertEquals(listOf("10"), data.searches)
        }

    @Test
    fun `no customer found shows only once the search has answered`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.type("777")
            runCurrent()
            assertFalse(viewModel.state.value.showsNoResults)

            advanceTimeBy(SearchViewModel.DIGITS_DEBOUNCE_MS + 1)
            runCurrent()
            assertTrue(viewModel.state.value.showsNoResults)
        }

    @Test
    fun `ABC switches to name search with a longer pause, 123 goes back keeping the digits`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            viewModel.type("10")
            viewModel.onKey(NumberPadKey.Letters)
            runCurrent()
            assertEquals(SearchMode.Letters, viewModel.state.value.mode)
            assertEquals("the typed digits stay", "10", viewModel.state.value.query)

            advanceTimeBy(SearchViewModel.DIGITS_DEBOUNCE_MS + 1)
            runCurrent()
            data.searches.clear()

            viewModel.onTextChange("Sun")
            advanceTimeBy(SearchViewModel.LETTERS_DEBOUNCE_MS - 1)
            runCurrent()
            assertEquals(emptyList<String>(), data.searches)
            advanceTimeBy(2)
            runCurrent()
            assertEquals(listOf("Sun"), data.searches)
            assertEquals(
                listOf("Sunita Devi"),
                viewModel.state.value.results
                    .map { it.name },
            )

            viewModel.onTextChange("Sunita 1046")
            viewModel.onShowNumberPad()
            runCurrent()
            assertEquals(SearchMode.Digits, viewModel.state.value.mode)
            assertEquals("1046", viewModel.state.value.query)
        }

    @Test
    fun `what is typed survives process death`() =
        runTest(dispatcher) {
            val saved = SavedStateHandle()
            val first = newViewModel(saved)
            first.type("1045")
            first.onKey(NumberPadKey.Letters)

            val second = newViewModel(saved)
            assertEquals("1045", second.state.value.query)
            assertEquals(SearchMode.Letters, second.state.value.mode)
        }

    @Test
    fun `banner follows the sync status, and a tap asks for a sync`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            assertNull(viewModel.state.value.banner)

            data.status.value = status(minutesAgo = 5)
            runCurrent()
            assertEquals(SearchBanner.Updated(5), viewModel.state.value.banner)

            data.status.value = status(minutesAgo = 5, savedOnPhone = 3)
            runCurrent()
            assertEquals(SearchBanner.PaymentsOnPhone(3), viewModel.state.value.banner)

            viewModel.onRefresh()
            assertEquals(1, data.syncRequests)
        }

    @Test
    fun `banner wording rules`() {
        assertEquals(SearchBanner.FirstDownload, SearchBanner.from(status(minutesAgo = null, syncing = true)))
        assertEquals(SearchBanner.NeverDownloaded, SearchBanner.from(status(minutesAgo = null)))
        assertEquals(SearchBanner.NeverDownloaded, SearchBanner.from(status(minutesAgo = null, failure = "offline")))
        assertEquals(
            SearchBanner.Updated(12, SearchBanner.UpdateProblem.NoInternet),
            SearchBanner.from(status(minutesAgo = 12, failure = "offline")),
        )
        assertEquals(
            SearchBanner.Updated(12, SearchBanner.UpdateProblem.Failed),
            SearchBanner.from(status(minutesAgo = 12, failure = "server:INTERNAL")),
        )
        assertEquals(
            SearchBanner.Updated(12),
            SearchBanner.from(status(minutesAgo = 12, failure = "offline", syncing = true)),
        )
        assertEquals(SearchBanner.PaymentsOnPhone(1), SearchBanner.from(status(minutesAgo = null, savedOnPhone = 1)))

        // Colour: green only while fresh and fine.
        assertEquals(SyncState.Updated, SearchBanner.Updated(60).state)
        assertEquals(SyncState.Waiting, SearchBanner.Updated(61).state)
        assertEquals(
            SyncState.Waiting,
            SearchBanner.Updated(1, SearchBanner.UpdateProblem.NoInternet).state,
        )
        assertEquals(SyncState.Waiting, SearchBanner.PaymentsOnPhone(2).state)
    }

    @Test
    fun `rows show the due, else the advance as credit, after the phone's payments`() {
        assertEquals(45_000L, summary("1", "A", balance = 45_000).rowAmountPaise)
        assertEquals(-5_000L, summary("2", "B", balance = -5_000, credit = 5_000).rowAmountPaise)
        assertEquals(0L, summary("3", "C", balance = 0).rowAmountPaise)
        // ₹450 due, ₹500 saved on the phone: nothing due, ₹50 advance.
        assertEquals(-5_000L, summary("4", "D", balance = 45_000, pending = 50_000).rowAmountPaise)
    }

    private fun status(
        minutesAgo: Long?,
        savedOnPhone: Int = 0,
        syncing: Boolean = false,
        failure: String? = null,
    ) = RosterSyncStatus(
        lastUpdatedAt = minutesAgo?.let { 1_000L },
        minutesAgo = minutesAgo,
        syncing = syncing,
        lastFailure = failure,
        savedOnPhoneCount = savedOnPhone,
    )
}

fun summary(
    code: String,
    name: String,
    balance: Long,
    credit: Long = 0,
    pending: Long = 0,
) = CustomerSummary(
    id = "id-$code",
    code = code,
    name = name,
    areaName = "Shiv Nagar",
    phone = null,
    balance = ProjectedBalance(balance, credit, pending, if (pending > 0) 1 else 0),
)

/** A tiny in-memory roster: digits match the code, letters match the name. Records every search. */
class FakeSearchData : SearchData {
    val roster =
        listOf(
            summary("1045", "Ramesh Kumar", balance = 45_000),
            summary("1046", "Sunita Devi", balance = -5_000, credit = 5_000),
        )
    val searches = mutableListOf<String>()
    val status = MutableStateFlow<RosterSyncStatus?>(null)
    var syncRequests = 0

    override fun search(query: String): Flow<List<CustomerSummary>> {
        searches += query
        val lower = query.lowercase()
        return MutableStateFlow(roster.filter { it.code.contains(query) || it.name.lowercase().contains(lower) })
            .map { it }
    }

    override fun syncStatus(): Flow<RosterSyncStatus> = status.filterNotNull()

    override fun requestSync() {
        syncRequests++
    }
}
