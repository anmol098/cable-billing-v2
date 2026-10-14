package com.cablebilling.lineman.feature.today

import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Where a handover saved on the phone stands. */
@Serializable
enum class QueuedHandoverState {
    /** Not accepted by the server yet: sent by itself when there is internet (and resent after a timeout). */
    @SerialName("waiting")
    WAITING,

    /** The server refused it for good ([QueuedHandover.lastErrorCode]); never resent. Hand over again. */
    @SerialName("refused")
    REFUSED,
}

/**
 * A cash handover saved on the phone (stored as JSON in `collection_day.queued_handover_json`). The
 * [request] is **frozen** when it is saved: every attempt sends the identical body with the same
 * `submission_id`, so a resend after a lost answer is a duplicate on the server, never a second
 * handover (T-062: idempotent on `submission_id`; different data → ID_REUSED_WITH_DIFFERENT_DATA).
 */
@Serializable
data class QueuedHandover(
    @SerialName("request") val request: HandoverRequest,
    /** Phone clock when the lineman saved it (epoch ms). */
    @SerialName("queued_at") val queuedAt: Long,
    @SerialName("state") val state: QueuedHandoverState = QueuedHandoverState.WAITING,
    @SerialName("attempt_count") val attemptCount: Int = 0,
    @SerialName("last_attempt_at") val lastAttemptAt: Long? = null,
    /** The last failure: `offline`, `server:<CODE>`, `malformed`, … (diagnostics and wording). */
    @SerialName("last_error_code") val lastErrorCode: String? = null,
) {
    val submissionId: String get() = request.submissionId
}

/**
 * What the handover screen pre-fills, frozen when it opens (PLAN §11.3 Today: "number pad pre-filled
 * with the expected cash"). Money is paise.
 *
 * @property expectedPaise all cash of the day: the office's cash plus cash it does not have yet, or the
 *   cash counted on this phone when there is no office answer ([source]).
 * @property officeCashPaise the office's part (null when there is no fresh office answer).
 * @property notInOfficeCashPaise cash the office's total does not include yet.
 * @property unsyncedCount / [unsyncedCashPaise] the day's payments still only on the phone, sent with
 *   the handover as a warning for the office (contract `unsynced_payment_count` / `unsynced_cash_paise`).
 */
data class HandoverPlan(
    val expectedPaise: Long,
    val officeCashPaise: Long?,
    val notInOfficeCashPaise: Long,
    val unsyncedCount: Int,
    val unsyncedCashPaise: Long,
    val source: TotalsSource,
) {
    companion object {
        fun from(summary: DaySummary): HandoverPlan =
            HandoverPlan(
                expectedPaise = summary.cashToHandOverPaise,
                officeCashPaise =
                    summary.office?.totals?.cashPaise?.takeIf {
                        summary.source ==
                            TotalsSource.OfficeAndPhone
                    },
                notInOfficeCashPaise = summary.notInOffice.cashPaise,
                unsyncedCount = summary.notAtOffice.count,
                unsyncedCashPaise = summary.notAtOffice.cashPaise,
                source = summary.source,
            )
    }
}

/** The handover rules the phone applies before sending (the server checks them again, T-062). */
object HandoverRules {
    /** Longest note (contract `HandoverRequest.note`). */
    const val MAX_NOTE_LENGTH: Int = 500

    /** Handed over minus expected (PLAN §8.7): negative = short, positive = extra. */
    fun discrepancy(
        handedPaise: Long,
        expectedPaise: Long,
    ): Long = Math.subtractExact(handedPaise, expectedPaise)

    /**
     * The reasons the lineman can pick for [discrepancyPaise] (icon tiles): the one that matches the
     * sign, "payments on phone" and "other". None when the cash matches.
     */
    fun reasonsFor(discrepancyPaise: Long): List<DiscrepancyReason> =
        when {
            discrepancyPaise < 0 -> {
                listOf(
                    DiscrepancyReason.SHORT,
                    DiscrepancyReason.PENDING_SYNC,
                    DiscrepancyReason.OTHER,
                )
            }

            discrepancyPaise > 0 -> {
                listOf(
                    DiscrepancyReason.EXTRA,
                    DiscrepancyReason.PENDING_SYNC,
                    DiscrepancyReason.OTHER,
                )
            }

            else -> {
                emptyList()
            }
        }

    /**
     * The reason sent with the handover. The server compares the cash with **its** expected cash, which
     * lacks the cash still on the phone; a handover that matches the phone's count but not the office's
     * total must still carry a reason (else VALIDATION), so it gets `pending_sync`. When the office has
     * everything by the time it reads the handover, it drops the reason (T-062).
     */
    fun reasonToSend(
        discrepancyPaise: Long,
        chosen: DiscrepancyReason?,
        notInOfficeCashPaise: Long,
    ): DiscrepancyReason? =
        when {
            discrepancyPaise != 0L -> chosen
            notInOfficeCashPaise > 0 -> DiscrepancyReason.PENDING_SYNC
            else -> null
        }

    /** The request for a handover of [handedPaise] against [plan]; null if a needed reason is missing. */
    fun request(
        submissionId: String,
        handedPaise: Long,
        chosenReason: DiscrepancyReason?,
        note: String?,
        plan: HandoverPlan,
    ): HandoverRequest? {
        require(handedPaise >= 0) { "cash handed over must not be negative" }
        val discrepancy = discrepancy(handedPaise, plan.expectedPaise)
        if (discrepancy != 0L && chosenReason !in reasonsFor(discrepancy)) return null
        return HandoverRequest(
            submissionId = submissionId,
            cashHandedOverPaise = handedPaise,
            discrepancyReason = reasonToSend(discrepancy, chosenReason, plan.notInOfficeCashPaise),
            note =
                note
                    ?.trim()
                    ?.take(MAX_NOTE_LENGTH)
                    ?.trim()
                    ?.takeIf { it.isNotEmpty() },
            unsyncedPaymentCount = plan.unsyncedCount.toLong(),
            unsyncedCashPaise = plan.unsyncedCashPaise,
        )
    }
}

/** Where the day's handover stands, as the Today screen says it (honest states, PLAN §2.2 rule 8). */
sealed interface HandoverView {
    /** Nothing handed over yet. */
    data object NotYet : HandoverView

    /** Saved on the phone; the server has not accepted the request yet ("Saved on phone", never "sent"). */
    data class OnPhone(
        val handedPaise: Long,
        val sending: Boolean,
    ) : HandoverView

    /** The server refused the saved handover ([code]); it is not sent again. */
    data class Refused(
        val handedPaise: Long,
        val code: String?,
    ) : HandoverView

    /** The server has it ("Sent to office"); the office has not checked it ("Waiting for check"). */
    data class Submitted(
        val handover: Handover,
    ) : HandoverView

    /** The office accepted it (final). */
    data class Accepted(
        val handover: Handover,
    ) : HandoverView

    /** The office sent it back with a note: hand over again. */
    data class SentBack(
        val handover: Handover,
    ) : HandoverView

    /** Whether a (new) handover can be made now. */
    val canHandOver: Boolean get() = this !is Accepted

    companion object {
        /**
         * The newest truth first: an accepted day is final; then a handover saved on the phone (newer than
         * anything the office said, which is why it is still kept); then the office's status.
         */
        fun of(
            office: OfficeDay?,
            queued: QueuedHandover?,
            sending: Boolean,
        ): HandoverView {
            val handover = office?.handover
            return when {
                office?.status == HandoverStatus.ACCEPTED && handover != null -> {
                    Accepted(handover)
                }

                queued?.state == QueuedHandoverState.WAITING -> {
                    OnPhone(queued.request.cashHandedOverPaise, sending)
                }

                queued?.state == QueuedHandoverState.REFUSED -> {
                    Refused(queued.request.cashHandedOverPaise, queued.lastErrorCode)
                }

                handover == null -> {
                    NotYet
                }

                office?.status == HandoverStatus.RETURNED -> {
                    SentBack(handover)
                }

                office?.status == HandoverStatus.SUBMITTED -> {
                    Submitted(handover)
                }

                else -> {
                    NotYet
                }
            }
        }
    }
}
