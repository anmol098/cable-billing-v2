package com.cablebilling.lineman.feature.printer

/** Test tags of the printer setup screen. */
object PrinterSetupTags {
    const val SCREEN = "printer_setup"
    const val BACK = "printer_setup_back"
    const val NO_BLUETOOTH = "printer_setup_no_bluetooth"
    const val ALLOW = "printer_setup_allow"
    const val OPEN_SETTINGS = "printer_setup_open_settings"
    const val TURN_ON = "printer_setup_turn_on"
    const val SAVED = "printer_setup_saved"
    const val TEST_PRINT = "printer_setup_test_print"
    const val TEST_STATUS = "printer_setup_test_status"
    const val FIND = "printer_setup_find"
    const val FIND_STATUS = "printer_setup_find_status"
    const val PAIR_STATUS = "printer_setup_pair_status"
    const val CANCEL = "printer_setup_cancel"

    fun paired(address: String) = "printer_setup_paired_$address"

    fun found(address: String) = "printer_setup_found_$address"
}
