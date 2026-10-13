package com.cablebilling.lineman.feature.search

import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.lineman.data.db.CustomerSummary
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.RosterFixtures.customer
import com.cablebilling.lineman.data.db.RosterFixtures.customerId
import com.cablebilling.lineman.data.db.RosterRepository
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.db.RosterSyncStatus
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.db.putRoster
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.generated.AreaRef
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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
import java.time.Duration

/**
 * T-065 acceptance, measured on the JVM: a 4-digit number-pad search over a 7,616-customer roster (the
 * largest legacy operator). Robolectric's SQLite on a desktop CPU is not a low-end phone, so the timings
 * are printed for the completion notes and the bounds are loose (no flaky timing assertion); the
 * emulator / phone measurement is left for a human.
 */
@RunWith(AndroidJUnit4::class)
class SearchPerformanceTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private lateinit var network: TestNetwork
    private lateinit var roster: RosterRepository

    @Before
    fun setUp() {
        server.dispatcher = Routes { Fixtures.response("error.NOT_FOUND.json") }
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(RosterFixtures.login) }
        roster = RosterRepository(db, RosterStore(db, time), network.store, network.mobileApi, network.errors, time)
        val customers =
            (1..ROSTER_SIZE).map { n ->
                customer(n, code = n.toString(), name = "Customer $n", phone = "9%09d".format(n * 7L))
                    .copy(area = AreaRef("a${n % 40}", "Area ${n % 40}"))
            }
        await { db.putRoster(RosterFixtures.login.operator.id, customers) }
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    @Test
    fun `4 digits over 7,616 customers - repository query`() {
        repeat(WARM_UP) { await { roster.search("4521").first() } }
        val runs =
            (1..RUNS).map {
                val start = System.nanoTime()
                val rows = await { roster.search("4521").first() }
                val millis = (System.nanoTime() - start) / NANOS_PER_MS
                assertEquals(customerId(4521), rows.first().id)
                millis
            }
        report("repository search(\"4521\")", runs)
        assertTrue("median ${runs.median()} ms", runs.median() < LOOSE_BOUND_MS)
    }

    @Test
    fun `4 digits over 7,616 customers - key press to results in the ViewModel`() {
        val viewModel = SearchViewModel(RosterOnly(roster), SavedStateHandle())
        val states = mutableListOf<SearchUiState>()
        val looper = shadowOf(Looper.getMainLooper())
        val scope = MainScope()
        scope.launch { viewModel.state.collect { states += it } }
        val runs =
            (1..(WARM_UP + RUNS))
                .map {
                    viewModel.onKey(NumberPadKey.Clear)
                    looper.idle()
                    "452".forEach { digit -> viewModel.onKey(NumberPadKey.Digit(digit.digitToInt())) }
                    viewModel.onKey(NumberPadKey.Digit(1))
                    // The debounce pause runs on Robolectric's clock (not counted); then the query itself.
                    looper.idleFor(Duration.ofMillis(SearchViewModel.DIGITS_DEBOUNCE_MS))
                    val start = System.nanoTime()
                    while (states.lastOrNull()?.let { it.resultsFor == "4521" && it.results.isNotEmpty() } != true) {
                        check(System.nanoTime() - start < GIVE_UP_MS * NANOS_PER_MS) { "no results in $GIVE_UP_MS ms" }
                        looper.idleFor(Duration.ofMillis(1))
                        Thread.yield()
                    }
                    val millis = (System.nanoTime() - start) / NANOS_PER_MS
                    assertEquals(
                        "4521",
                        states
                            .last()
                            .results
                            .first()
                            .code,
                    )
                    millis
                }.drop(WARM_UP)
        scope.cancel()
        report("key press → results (after the ${SearchViewModel.DIGITS_DEBOUNCE_MS} ms pause)", runs)
        assertTrue("median ${runs.median()} ms", runs.median() < LOOSE_BOUND_MS)
    }

    private fun report(
        what: String,
        runs: List<Long>,
    ) = println(
        "T-065 perf: $what over $ROSTER_SIZE customers: median ${runs.median()} ms, " +
            "max ${runs.max()} ms, runs $runs (Robolectric SQLite on the JVM, not a phone)",
    )

    private fun List<Long>.median(): Long = sorted()[size / 2]

    /** [SearchData] straight on the repository (no WorkManager in this test). */
    private class RosterOnly(
        private val roster: RosterRepository,
    ) : SearchData {
        override fun search(query: String): Flow<List<CustomerSummary>> = roster.search(query, SearchData.SEARCH_LIMIT)

        override fun syncStatus(): Flow<RosterSyncStatus> = emptyFlow()

        override fun requestSync() = Unit
    }

    private companion object {
        const val ROSTER_SIZE = 7_616
        const val WARM_UP = 3
        const val RUNS = 15
        const val NANOS_PER_MS = 1_000_000L
        const val GIVE_UP_MS = 30_000L

        /** Loose on purpose: catches a broken query (a full scan per row, N+1), not normal jitter. */
        const val LOOSE_BOUND_MS = 1_000L
    }
}
