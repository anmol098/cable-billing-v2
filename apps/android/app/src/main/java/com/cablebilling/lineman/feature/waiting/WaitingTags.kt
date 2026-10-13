package com.cablebilling.lineman.feature.waiting

/** Test tags of the Waiting screen. */
object WaitingTags {
    const val SCREEN = "screen_waiting"
    const val COUNT = "waiting_count"
    const val NOTHING = "waiting_nothing"
    const val PUSH = "waiting_push"
    const val HELD = "waiting_held"
    const val TRY_NOW = "waiting_try_now"
    const val CALL_OFFICE = "waiting_call_office"

    fun row(id: String): String = "waiting_row_$id"

    fun call(id: String): String = "waiting_call_$id"
}
