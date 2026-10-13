package com.cablebilling.lineman.feature.customer

/** Test tags of the customer screen. */
object CustomerTags {
    const val SCREEN = "screen_customer"
    const val BACK = "customer_back"
    const val SPEAK = "customer_speak"
    const val NAME = "customer_name"
    const val CODE = "customer_code"
    const val AREA = "customer_area"
    const val CONNECTIONS = "customer_connections"
    const val DUE = "customer_due"
    const val CREDIT = "customer_credit"
    const val PHONE_PAYMENTS = "customer_phone_payments"
    const val NO_INTERNET = "customer_no_internet"
    const val NOT_FOUND = "customer_not_found"
    const val COLLECT = "customer_collect"

    fun call(index: Int): String = "customer_call_$index"
}
