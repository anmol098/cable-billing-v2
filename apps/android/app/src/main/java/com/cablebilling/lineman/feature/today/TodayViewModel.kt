package com.cablebilling.lineman.feature.today

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.payments.PaymentRules
import com.cablebilling.lineman.voice.SpokenAmount
import com.cablebilling.lineman.voice.VoiceLine
import com.cablebilling.lineman.voice.VoiceLines
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** How the last "ask the office" went (this screen only). */
enum class OfficeCheck {
    /** Not asked yet. */
    Idle,

    /** Asking now. */
    Running,

    /** The office answered. */
    Done,

    /** No internet (or a timeout): the numbers are the phone's. */
    NoInternet,

    /** Another failure; the numbers are the phone's. */
    Failed,
}

/** Everything the Today screen shows. */
data class TodayUiState(
    val loading: Boolean = true,
    val signedIn: Boolean = false,
    /** India-time day shown (`YYYY-MM-DD`). */
    val businessDate: String = "",
    val summary: DaySummary? = null,
    val handover: HandoverView = HandoverView.NotYet,
    val officeCheck: OfficeCheck = OfficeCheck.Idle,
    val officePhone: String? = null,
    /** "Today ₹X cash, ₹Y UPI" read out (PLAN §11.3 Today: reads totals); null until the numbers settle. */
    val voice: VoiceLine? = null,
) {
    /** The bottom button: hand over (again), unless the office already accepted the day. */
    val canHandOver: Boolean get() = signedIn && summary != null && handover.canHandOver
}

/**
 * The Today tab (PLAN §8.7, §11.3 Today; FR-022, J-05): the signed-in lineman's India-time day with
 * cash and UPI kept apart, payments still on the phone labelled as such, the office's numbers when it
 * answers, today's payments, and where the cash handover stands after the office's check.
 *
 * Call [onShown] whenever the screen shows: it moves to the new day after midnight, asks the office, and
 * sends a handover still waiting on the phone.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class TodayViewModel
    @Inject
    constructor(
        private val data: TodayData,
        private val voiceLines: VoiceLines,
    ) : ViewModel() {
        private val date = MutableStateFlow(today())
        private val officeCheck = MutableStateFlow(OfficeCheck.Idle)

        private data class Who(
            val userId: String?,
            val officePhone: String?,
            val loaded: Boolean,
        )

        private val who =
            data
                .session()
                .map { session ->
                    val signedIn = (session as? SessionState.SignedIn)?.session
                    Who(signedIn?.user?.id, signedIn?.operator?.officePhone, session != SessionState.Loading)
                }.distinctUntilChanged()

        val state: StateFlow<TodayUiState> =
            combine(who, date) { who, date -> who to date }
                .flatMapLatest { (who, date) ->
                    val userId = who.userId
                    if (userId == null) {
                        flowOf(TodayUiState(loading = !who.loaded, businessDate = date))
                    } else {
                        combine(data.day(userId, date), officeCheck) { inputs, check ->
                            val summary = summarizeDay(userId, date, inputs.payments, inputs.office)
                            TodayUiState(
                                loading = false,
                                signedIn = true,
                                businessDate = date,
                                summary = summary,
                                handover = HandoverView.of(summary.office, inputs.queued, inputs.sending),
                                officeCheck = check,
                                officePhone = who.officePhone,
                                voice = if (check == OfficeCheck.Running) null else totalsVoice(summary.day),
                            )
                        }
                    }
                }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), TodayUiState())

        /** The screen shows (again): today's date, the office's numbers, and a waiting handover sent. */
        fun onShown() {
            date.value = today()
            refresh()
            data.sendNow()
        }

        /** Asks the office for the day ("Check again" after a handover). */
        fun refresh() {
            if (officeCheck.value == OfficeCheck.Running) return
            officeCheck.value = OfficeCheck.Running
            val day = date.value
            viewModelScope.launch {
                officeCheck.value =
                    when (val result = data.refresh(day)) {
                        is RefreshResult.Refreshed -> {
                            OfficeCheck.Done
                        }

                        RefreshResult.NotSignedIn -> {
                            OfficeCheck.Idle
                        }

                        is RefreshResult.Failed -> {
                            if (result.failure is ApiFailure.Offline) OfficeCheck.NoInternet else OfficeCheck.Failed
                        }
                    }
            }
        }

        /** "Try now" for a handover saved on the phone. */
        fun tryNow() {
            data.sendNow()
        }

        private fun today(): String = PaymentRules.businessDate(data.nowMillis())

        private fun totalsVoice(day: MethodTotals): VoiceLine =
            voiceLines.line { language ->
                voiceLines.text(
                    language,
                    R.string.mobile_today_voice_totals,
                    SpokenAmount.words(day.cashPaise, language),
                    SpokenAmount.words(day.upiPaise, language),
                )
            }

        private companion object {
            const val STOP_TIMEOUT_MS = 5_000L
        }
    }
