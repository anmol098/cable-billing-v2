package com.cablebilling.lineman.feature.today

import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.DayPayment
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import com.cablebilling.lineman.data.network.generated.PaymentMethod

/**
 * Cash and UPI of some payments, **kept apart** (PRD §15 #12, BRD B-014): there is deliberately no
 * property that adds cash and UPI together. Money is integer paise; [count] counts payments of both.
 */
data class MethodTotals(
    val cashPaise: Long = 0,
    val upiPaise: Long = 0,
    val count: Int = 0,
) {
    operator fun plus(other: MethodTotals): MethodTotals =
        MethodTotals(
            cashPaise = Math.addExact(cashPaise, other.cashPaise),
            upiPaise = Math.addExact(upiPaise, other.upiPaise),
            count = Math.addExact(count, other.count),
        )

    val isEmpty: Boolean get() = count == 0

    companion object {
        val ZERO = MethodTotals()

        /** One payment of [amountPaise] by [method]. */
        fun of(
            method: PaymentMethod,
            amountPaise: Long,
        ): MethodTotals =
            when (method) {
                PaymentMethod.CASH -> MethodTotals(cashPaise = amountPaise, count = 1)
                PaymentMethod.UPI -> MethodTotals(upiPaise = amountPaise, count = 1)
            }

        fun ofPayments(payments: Iterable<PaymentEntity>): MethodTotals =
            payments.fold(ZERO) { sum, payment -> sum + of(payment.method, payment.amountPaise) }
    }
}

/**
 * The office's answer for one of the lineman's days (`GET /collections/{date}`, T-061/T-062): its totals
 * count only payments the office has, not cancelled ones (UPI is never expected as cash).
 */
data class OfficeDay(
    val businessDate: String,
    val totals: MethodTotals,
    val status: HandoverStatus,
    val handover: Handover?,
    /**
     * The payments the office has for the day (including cancelled ones, flagged), when this answer
     * came in during this app run; null when only the totals stored on the phone are known.
     */
    val payments: List<DayPayment>?,
    /** Server clock of the answer (epoch ms). */
    val serverTime: Long,
) {
    /** True when the office's payment list is known, so the phone can tell which payments it lacks. */
    val isFresh: Boolean get() = payments != null
}

/** Where the Today totals come from. */
enum class TotalsSource {
    /** The office's answer plus the payments it does not have yet (on the phone, refused, or just sent). */
    OfficeAndPhone,

    /** Only the payments on this phone: no answer from the office in this app run (offline). */
    PhoneOnly,
}

/** A row's state on the Today list (icon + colour + word, PLAN §2.2). */
enum class DayRowStatus {
    /** Saved on the phone, not at the office yet (amber clock). */
    OnPhone,

    /** The office has it (green tick). */
    Sent,

    /** The office refused it: call the office (red). */
    Problem,

    /** The owner cancelled it at the office; it is not in any total (red, "रद्द / Cancelled"). */
    Cancelled,
}

/** One payment of the day as the Today list shows it. Money is paise; [recordedAt] epoch ms UTC. */
data class DayRow(
    val id: String,
    val customerName: String,
    val customerCode: String,
    val amountPaise: Long,
    val method: PaymentMethod,
    /** Permanent receipt number when known, else the provisional `P-…` reference. */
    val reference: String,
    val recordedAt: Long,
    val status: DayRowStatus,
)

/**
 * The lineman's day as the Today screen shows it (PLAN §8.7, §11.3). Every number is cash and UPI kept
 * apart ([MethodTotals]).
 *
 * @property day the day's totals (the big tiles): the office's totals plus what it does not have yet, or,
 *   with no office answer in this app run, the payments on this phone.
 * @property onPhone this lineman's payments saved on the phone and not at the office yet.
 * @property problems this lineman's payments the office refused (still only on the phone).
 * @property office the office's answer (fresh, or the last one stored on the phone), if any.
 * @property notInOffice payments the office's totals do not include yet (cash of these makes the office's
 *   expected cash lower than the cash the lineman holds).
 */
data class DaySummary(
    val businessDate: String,
    val day: MethodTotals,
    val onPhone: MethodTotals,
    val problems: MethodTotals,
    val office: OfficeDay?,
    val source: TotalsSource,
    val notInOffice: MethodTotals,
    val rows: List<DayRow>,
) {
    /** Payments of the day still only on the phone (saved or refused): reported with the handover. */
    val notAtOffice: MethodTotals get() = onPhone + problems

    /** The cash the lineman should hand over: all cash of the day, never UPI. */
    val cashToHandOverPaise: Long get() = day.cashPaise
}

/**
 * Builds the Today summary for [userId]'s India-time day [businessDate] from the phone's payments and the
 * office's answer.
 *
 * - Only [userId]'s payments of that day count: another lineman's payments held on a shared phone
 *   (PLAN §9.2) and other days are left out, whatever [local] contains.
 * - With a fresh office answer: day = office totals + this phone's payments the office does not list
 *   (on the phone, refused, or sent after the answer). Payments the office cancelled are in its list
 *   and in none of its totals, so they count nowhere.
 * - Without one: day = this phone's payments (labelled "counted on this phone").
 */
fun summarizeDay(
    userId: String,
    businessDate: String,
    local: List<PaymentEntity>,
    office: OfficeDay?,
): DaySummary {
    val mine = local.filter { it.collectorId == userId && it.businessDate == businessDate }
    val onPhone = MethodTotals.ofPayments(mine.filter { it.state == PaymentState.SAVED_ON_PHONE })
    val problems = MethodTotals.ofPayments(mine.filter { it.state == PaymentState.NEEDS_OFFICE_HELP })
    val officeList = office?.payments
    val sameDayOffice = office?.takeIf { it.businessDate == businessDate }
    return if (officeList != null && sameDayOffice != null) {
        val officeIds = officeList.associateBy { it.paymentId.lowercase() }
        val missing = mine.filter { it.id.lowercase() !in officeIds }
        val notInOffice = MethodTotals.ofPayments(missing)
        DaySummary(
            businessDate = businessDate,
            day = sameDayOffice.totals + notInOffice,
            onPhone = onPhone,
            problems = problems,
            office = sameDayOffice,
            source = TotalsSource.OfficeAndPhone,
            notInOffice = notInOffice,
            rows = rows(mine, officeIds, officeList),
        )
    } else {
        // Without the office's list the phone cannot tell which sent payments the stored totals include.
        DaySummary(
            businessDate = businessDate,
            day = MethodTotals.ofPayments(mine),
            onPhone = onPhone,
            problems = problems,
            office = sameDayOffice,
            source = TotalsSource.PhoneOnly,
            notInOffice = MethodTotals.ofPayments(mine.filter { it.state != PaymentState.SENT_TO_OFFICE }),
            rows = rows(mine, emptyMap(), emptyList()),
        )
    }
}

private fun rows(
    mine: List<PaymentEntity>,
    officeById: Map<String, DayPayment>,
    officeList: List<DayPayment>,
): List<DayRow> {
    val localIds = mine.map { it.id.lowercase() }.toSet()
    val fromPhone =
        mine.map { payment ->
            val atOffice = officeById[payment.id.lowercase()]
            DayRow(
                id = payment.id,
                customerName = payment.customerName,
                customerCode = payment.customerCode,
                amountPaise = payment.amountPaise,
                method = payment.method,
                reference = atOffice?.receiptNumber ?: payment.receiptNumber ?: payment.provisionalRef,
                recordedAt = payment.recordedAt,
                status =
                    when {
                        atOffice?.reversed == true -> DayRowStatus.Cancelled
                        atOffice != null -> DayRowStatus.Sent
                        payment.state == PaymentState.SENT_TO_OFFICE -> DayRowStatus.Sent
                        payment.state == PaymentState.NEEDS_OFFICE_HELP -> DayRowStatus.Problem
                        else -> DayRowStatus.OnPhone
                    },
            )
        }
    // Payments the office has that this phone does not (e.g. taken on another phone).
    val officeOnly =
        officeList
            .filter { it.paymentId.lowercase() !in localIds }
            .map { payment ->
                DayRow(
                    id = payment.paymentId,
                    customerName = payment.customerName,
                    customerCode = payment.customerCode,
                    amountPaise = payment.amountPaise,
                    method = payment.method,
                    reference = payment.receiptNumber,
                    recordedAt = parseInstantMillis(payment.recordedAt) ?: 0L,
                    status = if (payment.reversed) DayRowStatus.Cancelled else DayRowStatus.Sent,
                )
            }
    return (fromPhone + officeOnly).sortedWith(compareByDescending<DayRow> { it.recordedAt }.thenBy { it.id })
}

/** An ISO-8601 instant from the server as epoch ms, or null if it cannot be read. */
internal fun parseInstantMillis(text: String): Long? =
    try {
        java.time.Instant
            .parse(text)
            .toEpochMilli()
    } catch (ignored: java.time.format.DateTimeParseException) {
        null
    }
