package com.cablebilling.lineman.feature.today

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.applyTo
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.payments.PaymentRules
import com.cablebilling.lineman.voice.SpokenAmount
import com.cablebilling.lineman.voice.VoiceLine
import com.cablebilling.lineman.voice.VoiceLines
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** The handover flow's steps (PLAN §11.3 Today: number pad → reason if different → submit). */
enum class HandoverStep { Amount, Reason, Confirm }

/** Why the handover was not saved. */
enum class HandoverProblem { NotSaved, SignedOut, AlreadyAccepted }

/** Everything the handover screens show. Money is paise. */
data class HandoverUiState(
    val loading: Boolean = true,
    val plan: HandoverPlan? = null,
    val step: HandoverStep = HandoverStep.Amount,
    val digits: String = "",
    val reason: DiscrepancyReason? = null,
    val note: String = "",
    val saving: Boolean = false,
    val problem: HandoverProblem? = null,
    /** The handover is committed on the phone: leave the flow (Today shows its state). */
    val saved: Boolean = false,
    val confirmVoice: VoiceLine? = null,
) {
    val handedPaise: Long get() = (digits.toLongOrNull() ?: 0L) * PaymentRules.PAISE_PER_RUPEE

    /** Handed over minus expected; null before the plan is known. */
    val discrepancyPaise: Long? get() = plan?.let { HandoverRules.discrepancy(handedPaise, it.expectedPaise) }

    /** The reason tiles for the current difference (none when the cash matches). */
    val reasons: List<DiscrepancyReason> get() = discrepancyPaise?.let(HandoverRules::reasonsFor).orEmpty()

    val canContinue: Boolean get() = plan != null && handedPaise > 0

    val canFinishReason: Boolean get() = reason != null && reason in reasons
}

/**
 * Hand over the day's cash (PLAN §8.7, §11.3 Today; FR-022): the number pad pre-filled with the expected
 * cash (the office's cash plus cash it does not have yet, or the cash counted on this phone when there is
 * no office answer), then — only if the amount differs — a reason from icon tiles and an optional note,
 * then Confirm (read aloud) → saved on the phone and sent by itself.
 *
 * The expected cash is frozen when the flow opens, and everything typed, the step and the submission id
 * live in [SavedStateHandle] (process death). The submission id is made when Confirm opens and dropped
 * when the lineman goes back to change something: one submission id = one exact request, so a second
 * tap, or Save after a restart, saves the same handover once.
 */
@Suppress("TooManyFunctions") // One small function per thing the lineman can do on these screens.
@HiltViewModel(assistedFactory = HandoverViewModel.Factory::class)
class HandoverViewModel
    @AssistedInject
    constructor(
        @Assisted val businessDate: String,
        private val data: TodayData,
        private val voiceLines: VoiceLines,
        private val saved: SavedStateHandle,
    ) : ViewModel() {
        private val saving = MutableStateFlow(SaveState())

        private data class SaveState(
            val running: Boolean = false,
            val problem: HandoverProblem? = null,
            val saved: Boolean = false,
        )

        private val plan = MutableStateFlow(restorePlan())

        val state: StateFlow<HandoverUiState> =
            combine(
                plan,
                saved.getStateFlow(KEY_STEP, HandoverStep.Amount.name),
                saved.getStateFlow(KEY_DIGITS, ""),
                combine(saved.getStateFlow<String?>(KEY_REASON, null), saved.getStateFlow(KEY_NOTE, "")) { r, n ->
                    r to
                        n
                },
                saving,
            ) { plan, step, digits, (reason, note), save -> snapshot(plan, step, digits, reason, note, save) }
                .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), HandoverUiState())

        /** The state now, read straight from the saved state (actions must not depend on a collector). */
        private fun current(): HandoverUiState =
            snapshot(
                plan.value,
                saved[KEY_STEP] ?: HandoverStep.Amount.name,
                saved[KEY_DIGITS] ?: "",
                saved[KEY_REASON],
                saved[KEY_NOTE] ?: "",
                saving.value,
            )

        private fun snapshot(
            plan: HandoverPlan?,
            step: String,
            digits: String,
            reason: String?,
            note: String,
            save: SaveState,
        ): HandoverUiState {
            val current = HandoverStep.valueOf(step)
            val handed = (digits.toLongOrNull() ?: 0L) * PaymentRules.PAISE_PER_RUPEE
            return HandoverUiState(
                loading = plan == null,
                plan = plan,
                step = current,
                digits = digits,
                reason = reason?.let(DiscrepancyReason::fromWire),
                note = note,
                saving = save.running,
                problem = save.problem,
                saved = save.saved,
                confirmVoice = if (current == HandoverStep.Confirm) handoverVoice(handed) else null,
            )
        }

        init {
            if (plan.value == null) {
                viewModelScope.launch {
                    val userId =
                        (data.session().first { it != SessionState.Loading } as? SessionState.SignedIn)
                            ?.session
                            ?.user
                            ?.id
                    if (userId == null) {
                        saving.value = SaveState(problem = HandoverProblem.SignedOut)
                        return@launch
                    }
                    val inputs = data.day(userId, businessDate).first()
                    val frozen = HandoverPlan.from(summarizeDay(userId, businessDate, inputs.payments, inputs.office))
                    storePlan(frozen)
                    saved[KEY_DIGITS] = rupeesRoundedUp(frozen.expectedPaise).takeIf { it > 0 }?.toString() ?: ""
                    saved[KEY_FRESH] = true
                    plan.value = frozen
                }
            }
        }

        private val step: HandoverStep get() = HandoverStep.valueOf(saved[KEY_STEP] ?: HandoverStep.Amount.name)

        /** A number-pad key. The first key after the pre-fill types a new amount. */
        fun onKey(key: NumberPadKey) {
            if (step != HandoverStep.Amount || plan.value == null) return
            val fresh = saved.get<Boolean>(KEY_FRESH) == true
            val start =
                if (fresh &&
                    (key is NumberPadKey.Digit || key == NumberPadKey.DoubleZero)
                ) {
                    ""
                } else {
                    saved[KEY_DIGITS] ?: ""
                }
            saved[KEY_DIGITS] = key.applyTo(start, maxLength = PaymentRules.MAX_RUPEE_DIGITS, trimLeadingZeros = true)
            saved[KEY_FRESH] = false
            clearProblem()
        }

        /** Amount → Reason when the cash differs from the expected cash, else straight to Confirm. */
        fun onAmountDone() {
            val current = current()
            if (step != HandoverStep.Amount || !current.canContinue) return
            val reasons = current.reasons
            if (current.reason !in reasons) saved[KEY_REASON] = null
            if (reasons.isEmpty()) toConfirm() else saved[KEY_STEP] = HandoverStep.Reason.name
        }

        /** A reason tile. */
        fun onReason(reason: DiscrepancyReason) {
            if (step != HandoverStep.Reason || reason !in current().reasons) return
            saved[KEY_REASON] = reason.wire
        }

        fun onNoteChange(text: String) {
            if (step == HandoverStep.Reason) saved[KEY_NOTE] = text.take(HandoverRules.MAX_NOTE_LENGTH)
        }

        fun onReasonDone() {
            if (step == HandoverStep.Reason && current().canFinishReason) toConfirm()
        }

        /** One step back; false on the Amount step (the caller leaves the flow). */
        fun onBack(): Boolean {
            if (saving.value.running) return true
            val previous =
                when (step) {
                    HandoverStep.Amount -> {
                        null
                    }

                    HandoverStep.Reason -> {
                        HandoverStep.Amount
                    }

                    HandoverStep.Confirm -> {
                        if (current().reasons.isEmpty()) HandoverStep.Amount else HandoverStep.Reason
                    }
                }
            if (previous != null) {
                // Something may change now: the next Confirm is a new submission.
                if (step == HandoverStep.Confirm) saved[KEY_SUBMISSION_ID] = null
                saved[KEY_STEP] = previous.name
                clearProblem()
            }
            return previous != null
        }

        /** Saves the handover on the phone; [HandoverUiState.saved] follows only after Room committed it. */
        fun submit() {
            val request = readyRequest() ?: return
            saving.value = SaveState(running = true)
            viewModelScope.launch {
                saving.value =
                    when (data.queueHandover(businessDate, request)) {
                        is QueueResult.Queued -> SaveState(saved = true)
                        QueueResult.AlreadyAccepted -> SaveState(problem = HandoverProblem.AlreadyAccepted)
                        QueueResult.NotSignedIn -> SaveState(problem = HandoverProblem.SignedOut)
                        is QueueResult.Failed -> SaveState(problem = HandoverProblem.NotSaved)
                    }
            }
        }

        /** The request to save, or null when Confirm is not showing, a save runs or is done, or a reason is missing. */
        private fun readyRequest(): HandoverRequest? {
            val current = current()
            val frozen = current.plan
            val submissionId = saved.get<String>(KEY_SUBMISSION_ID)
            val ready = step == HandoverStep.Confirm && !saving.value.running && !saving.value.saved
            if (!ready || frozen == null || submissionId == null) return null
            return HandoverRules.request(
                submissionId = submissionId,
                handedPaise = current.handedPaise,
                chosenReason = current.reason,
                note = current.note,
                plan = frozen,
            )
        }

        private fun toConfirm() {
            if (saved.get<String>(KEY_SUBMISSION_ID) == null) saved[KEY_SUBMISSION_ID] = data.newSubmissionId()
            saved[KEY_STEP] = HandoverStep.Confirm.name
        }

        private fun clearProblem() {
            if (saving.value.problem != null) saving.value = SaveState()
        }

        private fun handoverVoice(handedPaise: Long): VoiceLine =
            voiceLines.line { language ->
                voiceLines.text(
                    language,
                    R.string.mobile_today_handover_voice,
                    SpokenAmount.words(handedPaise, language),
                )
            }

        private fun storePlan(plan: HandoverPlan) {
            saved[KEY_PLAN_EXPECTED] = plan.expectedPaise
            saved[KEY_PLAN_OFFICE] = plan.officeCashPaise
            saved[KEY_PLAN_NOT_IN_OFFICE] = plan.notInOfficeCashPaise
            saved[KEY_PLAN_UNSYNCED_COUNT] = plan.unsyncedCount
            saved[KEY_PLAN_UNSYNCED_CASH] = plan.unsyncedCashPaise
            saved[KEY_PLAN_SOURCE] = plan.source.name
        }

        private fun restorePlan(): HandoverPlan? {
            val expected = saved.get<Long>(KEY_PLAN_EXPECTED) ?: return null
            return HandoverPlan(
                expectedPaise = expected,
                officeCashPaise = saved[KEY_PLAN_OFFICE],
                notInOfficeCashPaise = saved[KEY_PLAN_NOT_IN_OFFICE] ?: 0L,
                unsyncedCount = saved[KEY_PLAN_UNSYNCED_COUNT] ?: 0,
                unsyncedCashPaise = saved[KEY_PLAN_UNSYNCED_CASH] ?: 0L,
                source = TotalsSource.valueOf(saved[KEY_PLAN_SOURCE] ?: TotalsSource.PhoneOnly.name),
            )
        }

        @AssistedFactory
        interface Factory {
            fun create(businessDate: String): HandoverViewModel
        }

        companion object {
            const val KEY_STEP = "handover_step"
            const val KEY_DIGITS = "handover_digits"
            const val KEY_FRESH = "handover_fresh"
            const val KEY_REASON = "handover_reason"
            const val KEY_NOTE = "handover_note"
            const val KEY_SUBMISSION_ID = "handover_submission_id"
            const val KEY_PLAN_EXPECTED = "handover_plan_expected"
            const val KEY_PLAN_OFFICE = "handover_plan_office"
            const val KEY_PLAN_NOT_IN_OFFICE = "handover_plan_not_in_office"
            const val KEY_PLAN_UNSYNCED_COUNT = "handover_plan_unsynced_count"
            const val KEY_PLAN_UNSYNCED_CASH = "handover_plan_unsynced_cash"
            const val KEY_PLAN_SOURCE = "handover_plan_source"
            private const val STOP_TIMEOUT_MS = 5_000L

            /** Whole rupees for the pad (D-17), rounded up so the pre-fill never hands over less. */
            fun rupeesRoundedUp(paise: Long): Long =
                (paise + PaymentRules.PAISE_PER_RUPEE - 1) / PaymentRules.PAISE_PER_RUPEE
        }
    }
