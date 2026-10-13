package com.cablebilling.lineman.feature.customer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.lineman.data.db.CustomerDetail
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.voice.VoiceLines
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * The customer screen (PLAN §11.3 Customer): shows the phone's copy at once (works offline) and asks
 * the office for a fresh one when it opens; the screen updates when that arrives.
 */
@HiltViewModel(assistedFactory = CustomerViewModel.Factory::class)
class CustomerViewModel
    @AssistedInject
    constructor(
        @Assisted val customerId: String,
        private val data: CustomerData,
        private val voiceLines: VoiceLines,
    ) : ViewModel() {
        private val refreshState = MutableStateFlow(CustomerRefresh.Running)

        /** Wraps the cached row so "not read yet" (null) differs from "not on the phone" (Cached(null)). */
        private data class Cached(
            val detail: CustomerDetail?,
        )

        val state: StateFlow<CustomerUiState> =
            combine(
                data.customer(customerId).map { Cached(it) }.onStart<Cached?> { emit(null) },
                refreshState,
            ) { cached, refresh ->
                val view = cached?.detail?.let(CustomerView::from)
                CustomerUiState(
                    loading = cached == null,
                    customer = view,
                    refresh = refresh,
                    voiceLine = view?.let { voiceLines.customerDue(it.name, it.duePaise) },
                )
            }.stateIn(
                scope = viewModelScope,
                started = SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS),
                initialValue = CustomerUiState(),
            )

        init {
            refresh()
        }

        /** Ask the office for this customer's latest due (the phone's copy stays if it cannot answer). */
        fun refresh() {
            refreshState.value = CustomerRefresh.Running
            viewModelScope.launch {
                refreshState.value =
                    when (val result = data.refresh(customerId)) {
                        is ApiResult.Success -> {
                            CustomerRefresh.Done
                        }

                        is ApiResult.Failure -> {
                            val offline = result.failure is ApiFailure.Offline
                            if (offline) CustomerRefresh.NoInternet else CustomerRefresh.Failed
                        }
                    }
            }
        }

        @AssistedFactory
        interface Factory {
            fun create(customerId: String): CustomerViewModel
        }

        private companion object {
            const val STOP_TIMEOUT_MS = 5_000L
        }
    }
