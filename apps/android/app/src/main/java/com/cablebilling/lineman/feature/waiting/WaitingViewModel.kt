package com.cablebilling.lineman.feature.waiting

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.isHeldFor
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.data.sync.PaymentSyncScheduler
import com.cablebilling.lineman.data.sync.PushStatus
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.android.components.ViewModelComponent
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject
import com.cablebilling.lineman.data.network.generated.PaymentMethod as WireMethod

/** Why a payment is on the Waiting list. */
enum class WaitingKind {
    /** Saved on the phone; goes to the office by itself (amber clock). */
    OnPhone,

    /** Another lineman's payment on this phone: held, never sent with this sign-in (PLAN §9.2). */
    Held,

    /** The office refused it (`rejected`): call the office (red). */
    Problem,
}

/** One row of the Waiting list. Money is integer paise; [recordedAt] is epoch ms UTC. */
data class WaitingItem(
    val id: String,
    val customerName: String,
    val customerCode: String,
    val amountPaise: Long,
    val method: PaymentMethod,
    /** The provisional `P-…` reference the customer got. */
    val reference: String,
    val recordedAt: Long,
    val kind: WaitingKind,
)

/** Everything the Waiting screen shows. */
data class WaitingUiState(
    val loading: Boolean = true,
    /** Problems first, then this lineman's payments on the phone, then held ones; newest first in each. */
    val items: List<WaitingItem> = emptyList(),
    val push: PushStatus = PushStatus.Idle,
    val officePhone: String? = null,
) {
    val ownOnPhone: Int get() = items.count { it.kind == WaitingKind.OnPhone }
    val held: Int get() = items.count { it.kind == WaitingKind.Held }

    /** "Try now" makes sense: this lineman has payments on the phone and no push is running. */
    val canTryNow: Boolean get() = ownOnPhone > 0 && push != PushStatus.Running

    /** Everything this lineman saved reached the office in the last push (honest: nothing of theirs is left). */
    val allSent: Boolean get() =
        push == PushStatus.Finished && ownOnPhone == 0 &&
            items.none { it.kind == WaitingKind.Problem }
}

/** What the Waiting screen reads (the app: [AppWaitingData]; tests: a fake). */
interface WaitingData {
    /** Payments the office does not have: on the phone, held, or refused. */
    fun payments(): Flow<List<PaymentEntity>>

    fun session(): Flow<SessionState>

    fun pushStatus(): Flow<PushStatus>

    /** Push now (and keep trying in the background if it cannot). */
    fun tryNow()
}

class AppWaitingData
    @Inject
    constructor(
        private val payments: PaymentRepository,
        private val sessions: SessionStore,
        private val sync: PaymentSync,
        private val scheduler: PaymentSyncScheduler,
    ) : WaitingData {
        override fun payments(): Flow<List<PaymentEntity>> = payments.observeWaiting()

        override fun session(): Flow<SessionState> = sessions.state

        override fun pushStatus(): Flow<PushStatus> = sync.status

        override fun tryNow() {
            scheduler.tryNow()
        }
    }

@Module
@InstallIn(ViewModelComponent::class)
abstract class WaitingDataModule {
    @Binds
    abstract fun bindWaitingData(impl: AppWaitingData): WaitingData
}

/**
 * The Waiting tab (PLAN §11.3 Waiting): payments not at the office yet, with honest state chips, a
 * "Try now" button, and "Call office" for problems and for another lineman's held payments.
 */
@HiltViewModel
class WaitingViewModel
    @Inject
    constructor(
        private val data: WaitingData,
    ) : ViewModel() {
        val state: StateFlow<WaitingUiState> =
            combine(data.payments(), data.session(), data.pushStatus()) { payments, session, push ->
                val signedIn = (session as? SessionState.SignedIn)?.session
                WaitingUiState(
                    loading = false,
                    items = payments.map { it.toItem(signedIn?.user?.id) }.sortedWith(ORDER),
                    push = push,
                    officePhone = signedIn?.operator?.officePhone,
                )
            }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), WaitingUiState())

        fun tryNow() {
            if (state.value.push != PushStatus.Running) data.tryNow()
        }

        private companion object {
            const val STOP_TIMEOUT_MS = 5_000L

            val ORDER: Comparator<WaitingItem> =
                compareBy<WaitingItem> { it.kind.ordinalForList }.thenByDescending { it.recordedAt }.thenBy { it.id }

            val WaitingKind.ordinalForList: Int
                get() =
                    when (this) {
                        WaitingKind.Problem -> 0
                        WaitingKind.OnPhone -> 1
                        WaitingKind.Held -> 2
                    }
        }
    }

private fun PaymentEntity.toItem(signedInUserId: String?): WaitingItem =
    WaitingItem(
        id = id,
        customerName = customerName,
        customerCode = customerCode,
        amountPaise = amountPaise,
        method = if (method == WireMethod.UPI) PaymentMethod.Upi else PaymentMethod.Cash,
        reference = provisionalRef,
        recordedAt = recordedAt,
        kind =
            when {
                state == PaymentState.NEEDS_OFFICE_HELP -> WaitingKind.Problem
                isHeldFor(signedInUserId) -> WaitingKind.Held
                else -> WaitingKind.OnPhone
            },
    )
