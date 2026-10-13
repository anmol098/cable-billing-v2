package com.cablebilling.lineman.feature.collect

/** Test tags of the collect flow (Amount, Method, UPI reference, Confirm) and the Done screen. */
object CollectTags {
    const val AMOUNT_SCREEN = "collect_amount"
    const val METHOD_SCREEN = "collect_method"
    const val UPI_SCREEN = "collect_upi"
    const val CONFIRM_SCREEN = "collect_confirm"
    const val NOT_FOUND = "collect_not_found"

    const val BACK = "collect_back"
    const val CUSTOMER_NAME = "collect_customer_name"
    const val DUE_NOW = "collect_due_now"
    const val AMOUNT = "collect_amount_value"
    const val AMOUNT_HINT = "collect_amount_hint"
    const val NEXT = "collect_next"
    const val CASH = "collect_cash"
    const val UPI = "collect_upi_tile"
    const val UPI_FIELD = "collect_upi_field"
    const val UPI_SKIP = "collect_upi_skip"
    const val UPI_NEXT = "collect_upi_next"
    const val CONFIRM_CARD = "collect_confirm_card"
    const val SPEAK = "collect_speak"
    const val SAVE = "collect_save"
    const val PROBLEM = "collect_problem"

    const val DONE_SCREEN = "collect_done"
    const val DONE_AMOUNT = "collect_done_amount"
    const val DONE_NUMBER = "collect_done_number"
    const val DONE_STATUS = "collect_done_status"
    const val DONE_NOTE = "collect_done_note"
    const val PRINT = "collect_done_print"
    const val WHATSAPP = "collect_done_whatsapp"
    const val SMS = "collect_done_sms"
    const val FINISH = "collect_done_finish"
    const val PRINTER_SETUP = "collect_done_printer_setup"
    const val PRINT_PROBLEM = "collect_done_print_problem"

    /** Quick amount chip for [paise] (`collect_chip_45000`). */
    fun chip(paise: Long): String = "collect_chip_$paise"
}
