package com.cablebilling.lineman.feature.customer

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.CustomerDetail
import com.cablebilling.lineman.data.db.ProjectedBalance
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.connectionEntities
import com.cablebilling.lineman.data.db.toEntity
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.voice.VoiceLines
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filter
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

/** The customer screen's ViewModel: cached copy first, refresh from the office, read-out, not found. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class CustomerViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val data = FakeCustomerData()
    private val voiceLines = VoiceLines(ApplicationProvider.getApplicationContext())

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.newViewModel(): CustomerViewModel {
        val viewModel = CustomerViewModel(RAMESH_ID, data, voiceLines)
        backgroundScope.launch { viewModel.state.collect {} }
        runCurrent()
        return viewModel
    }

    @Test
    fun `shows the phone's copy at once and asks the office once`() =
        runTest(dispatcher) {
            data.cached.value = Cached(ramesh())
            val viewModel = newViewModel()

            val state = viewModel.state.value
            assertFalse(state.loading)
            assertEquals(listOf(RAMESH_ID), data.refreshes)
            assertEquals(CustomerRefresh.Running, state.refresh)
            val customer = checkNotNull(state.customer)
            assertEquals("Ramesh Kumar", customer.name)
            assertEquals("1045", customer.code)
            assertEquals("Shiv Nagar", customer.areaName)
            assertEquals(listOf("9876543210"), customer.phones)
            assertEquals(2, customer.connectionCount)
            assertEquals(90_000L, customer.duePaise)
            assertEquals(0L, customer.creditPaise)
            assertFalse(customer.includesPhonePayments)

            data.answer.complete(ApiResult.Success(Unit))
            runCurrent()
            assertEquals(CustomerRefresh.Done, viewModel.state.value.refresh)
        }

    @Test
    fun `reads out the name and the due in words, in both languages`() =
        runTest(dispatcher) {
            data.cached.value = Cached(ramesh(balance = 45_000))
            val viewModel = newViewModel()

            val line = checkNotNull(viewModel.state.value.voiceLine)
            assertEquals("Ramesh Kumar, चार सौ पचास रुपये बाकी", line.hindi)
            assertEquals("Ramesh Kumar, four hundred fifty rupees due", line.english)
            assertFalse("never ₹ or digits in speech", line.hindi.any { it == '₹' || it.isDigit() })
        }

    @Test
    fun `the office's answer updates the screen and the read-out`() =
        runTest(dispatcher) {
            data.cached.value = Cached(ramesh(balance = 90_000))
            val viewModel = newViewModel()

            data.cached.value = Cached(ramesh(balance = 45_000))
            data.answer.complete(ApiResult.Success(Unit))
            runCurrent()
            assertEquals(
                45_000L,
                viewModel.state.value.customer
                    ?.duePaise,
            )
            assertEquals(
                "Ramesh Kumar, four hundred fifty rupees due",
                viewModel.state.value.voiceLine
                    ?.english,
            )
        }

    @Test
    fun `offline keeps the phone's copy and says no internet`() =
        runTest(dispatcher) {
            data.cached.value = Cached(ramesh())
            val viewModel = newViewModel()

            data.answer.complete(ApiResult.Failure(ApiFailure.Offline(java.io.IOException("airplane mode"))))
            runCurrent()
            val state = viewModel.state.value
            assertEquals(CustomerRefresh.NoInternet, state.refresh)
            assertEquals(90_000L, state.customer?.duePaise)
            assertFalse(state.notFound)
        }

    @Test
    fun `payments saved on the phone are taken off, with the label, and extra becomes credit`() =
        runTest(dispatcher) {
            data.cached.value = Cached(ramesh(balance = 45_000, pending = 50_000))
            val viewModel = newViewModel()

            val customer = checkNotNull(viewModel.state.value.customer)
            assertEquals(0L, customer.duePaise)
            assertEquals(5_000L, customer.creditPaise)
            assertTrue(customer.includesPhonePayments)
        }

    @Test
    fun `loading, then not found once the office cannot give it either`() =
        runTest(dispatcher) {
            val viewModel = newViewModel()
            assertTrue(viewModel.state.value.loading)
            assertFalse(viewModel.state.value.notFound)

            data.cached.value = Cached(null)
            runCurrent()
            assertFalse("still asking the office", viewModel.state.value.notFound)

            data.answer.complete(ApiResult.Failure(ApiFailure.Offline(java.io.IOException("offline"))))
            runCurrent()
            assertTrue(viewModel.state.value.notFound)
            assertNull(viewModel.state.value.voiceLine)
        }

    @Test
    fun `a second refresh asks again`() =
        runTest(dispatcher) {
            data.cached.value = Cached(ramesh())
            val viewModel = newViewModel()
            data.answer.complete(ApiResult.Failure(ApiFailure.Malformed(IllegalStateException("bad body"))))
            runCurrent()
            assertEquals(CustomerRefresh.Failed, viewModel.state.value.refresh)

            data.answer = CompletableDeferred()
            viewModel.refresh()
            runCurrent()
            assertEquals(CustomerRefresh.Running, viewModel.state.value.refresh)
            assertEquals(listOf(RAMESH_ID, RAMESH_ID), data.refreshes)
        }

    /** Wraps the cached value so "not emitted yet" differs from "not on the phone". */
    data class Cached(
        val detail: CustomerDetail?,
    )

    class FakeCustomerData : CustomerData {
        val cached = MutableStateFlow<Cached?>(null)
        val refreshes = mutableListOf<String>()
        var answer = CompletableDeferred<ApiResult<*>>()

        override fun customer(id: String): Flow<CustomerDetail?> = cached.filter { it != null }.map { it?.detail }

        override suspend fun refresh(id: String): ApiResult<*> {
            refreshes += id
            return answer.await()
        }
    }

    private companion object {
        val RAMESH_ID: String = RosterFixtures.ramesh.id

        /** Ramesh from the contract fixture (2 connections, ₹900 due) as Room returns him. */
        fun ramesh(
            balance: Long = 90_000,
            pending: Long = 0,
        ): CustomerDetail {
            val customer = RosterFixtures.ramesh.copy(balancePaise = balance).toEntity(0)
            return CustomerDetail(
                customer = customer,
                connections = RosterFixtures.ramesh.connectionEntities(),
                openBills = emptyList(),
                balance = ProjectedBalance(balance, customer.creditPaise, pending, if (pending > 0) 1 else 0),
            )
        }
    }
}
