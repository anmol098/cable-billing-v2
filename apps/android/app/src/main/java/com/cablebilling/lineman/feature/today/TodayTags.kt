package com.cablebilling.lineman.feature.today

/** Test tags of the Today and handover screens. */
object TodayTags {
    const val SCREEN = "screen_today"
    const val DATE = "today_date"
    const val CASH_TILE = "today_cash_tile"
    const val UPI_TILE = "today_upi_tile"
    const val COUNT = "today_count"
    const val PHONE_ONLY = "today_phone_only"
    const val ON_PHONE = "today_on_phone"
    const val PROBLEMS = "today_problems"
    const val CALL_OFFICE = "today_call_office"
    const val AT_OFFICE = "today_at_office"
    const val HANDOVER_CARD = "today_handover_card"
    const val HANDOVER_STATE = "today_handover_state"
    const val HANDOVER_REVIEW = "today_handover_review"
    const val HANDOVER_NOTE = "today_handover_note"
    const val HANDOVER_DIFFERENCE = "today_handover_difference"
    const val CHECK_AGAIN = "today_check_again"
    const val TRY_NOW = "today_try_now"
    const val NOTHING_YET = "today_nothing_yet"
    const val HAND_OVER = "today_hand_over"

    const val AMOUNT_SCREEN = "handover_amount_screen"
    const val REASON_SCREEN = "handover_reason_screen"
    const val CONFIRM_SCREEN = "handover_confirm_screen"
    const val BACK = "handover_back"
    const val EXPECTED = "handover_expected"
    const val SOURCE = "handover_source"
    const val AMOUNT = "handover_amount"
    const val DIFFERENCE = "handover_difference"
    const val NEXT = "handover_next"
    const val NOTE = "handover_note"
    const val CONFIRM_CARD = "handover_confirm_card"
    const val SUBMIT = "handover_submit"
    const val PROBLEM = "handover_problem"

    fun row(id: String): String = "today_row_$id"

    fun reason(wire: String): String = "handover_reason_$wire"
}
