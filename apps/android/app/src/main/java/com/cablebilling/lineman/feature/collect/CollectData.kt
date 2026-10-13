package com.cablebilling.lineman.feature.collect

import com.cablebilling.lineman.data.db.RosterRepository
import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.payments.PaymentDraft
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.payments.UuidV7
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.android.components.ViewModelComponent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject

/** The customer as the collect flow needs it. Money is integer paise. */
data class CollectCustomer(
    val id: String,
    val name: String,
    val code: String,
    /** Due now, after the phone's unsent payments (the Amount screen's pre-fill). */
    val duePaise: Long,
)

/**
 * What the collect flow reads and writes. The app uses [AppCollectData] (offline roster + payment
 * queue); ViewModel tests use a fake.
 */
interface CollectData {
    /** The customer from the phone's list; null when not on it. */
    fun customer(id: String): Flow<CollectCustomer?>

    /** A new payment id (UUIDv7), made before the payment is saved. */
    fun newPaymentId(): String

    /** Saves the payment on the phone (commits before returning). */
    suspend fun save(draft: PaymentDraft): SaveResult
}

class AppCollectData
    @Inject
    constructor(
        private val roster: RosterRepository,
        private val payments: PaymentRepository,
        private val time: TimeSource,
    ) : CollectData {
        override fun customer(id: String): Flow<CollectCustomer?> =
            roster.customer(id).map { detail ->
                detail?.let {
                    CollectCustomer(
                        id = it.customer.id,
                        name = it.customer.name,
                        code = it.customer.code,
                        duePaise = it.balance.duePaise,
                    )
                }
            }

        override fun newPaymentId(): String = UuidV7.generate(time.nowMillis())

        override suspend fun save(draft: PaymentDraft): SaveResult = payments.save(draft)
    }

@Module
@InstallIn(ViewModelComponent::class)
abstract class CollectDataModule {
    @Binds
    abstract fun bindCollectData(impl: AppCollectData): CollectData
}
