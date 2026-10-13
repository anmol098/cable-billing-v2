package com.cablebilling.lineman.feature.customer

import com.cablebilling.lineman.data.db.CustomerDetail
import com.cablebilling.lineman.voice.VoiceLine

/** How fetching the customer from the office went (the screen shows the phone's copy meanwhile). */
enum class CustomerRefresh {
    Running,
    Done,

    /** No internet: the phone's copy stays on screen, with an honest "no internet" line. */
    NoInternet,

    /** Any other failure (server trouble, signed out …): the phone's copy stays, nothing else to say. */
    Failed,
}

/** The customer as the screen shows it. Money is integer paise. */
data class CustomerView(
    val id: String,
    val name: String,
    val code: String,
    val areaName: String?,
    /** Numbers to call (main phone first), as stored. */
    val phones: List<String>,
    val connectionCount: Int,
    /** What is due now, after the phone's unsent payments: show it huge and red. */
    val duePaise: Long,
    /** Advance, shown separately in green when above zero. */
    val creditPaise: Long,
    /** The amounts already include payments saved on this phone: say so. */
    val includesPhonePayments: Boolean,
) {
    companion object {
        fun from(detail: CustomerDetail): CustomerView {
            val customer = detail.customer
            return CustomerView(
                id = customer.id,
                name = customer.name,
                code = customer.code,
                areaName = customer.areaName,
                phones = listOfNotNull(customer.phone, customer.altPhone).filter { it.isNotBlank() }.distinct(),
                connectionCount = detail.connections.size,
                duePaise = detail.balance.duePaise,
                creditPaise = detail.balance.creditPaise,
                includesPhonePayments = detail.balance.includesPhonePayments,
            )
        }
    }
}

/** Everything the customer screen shows. */
data class CustomerUiState(
    /** The phone's copy has not been read yet. */
    val loading: Boolean = true,
    val customer: CustomerView? = null,
    val refresh: CustomerRefresh = CustomerRefresh.Running,
    /** "रमेश कुमार, चार सौ पचास रुपये बाकी": spoken when the screen shows and by the speak button. */
    val voiceLine: VoiceLine? = null,
) {
    /** Not on the phone, and the office could not give it either (removed, or offline). */
    val notFound: Boolean get() = !loading && customer == null && refresh != CustomerRefresh.Running
}
