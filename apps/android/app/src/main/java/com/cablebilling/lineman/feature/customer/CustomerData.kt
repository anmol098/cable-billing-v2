package com.cablebilling.lineman.feature.customer

import com.cablebilling.lineman.data.db.CustomerDetail
import com.cablebilling.lineman.data.db.RosterRepository
import com.cablebilling.lineman.data.network.ApiResult
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.android.components.ViewModelComponent
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject

/**
 * What the customer screen reads. The app uses [RosterCustomerData] (the offline roster from T-064);
 * ViewModel tests use a fake.
 */
interface CustomerData {
    /** The cached customer with the projected balance; null when not in the phone's list. Updates live. */
    fun customer(id: String): Flow<CustomerDetail?>

    /** Fetches the customer from the office (online) and stores it; [customer] then updates. */
    suspend fun refresh(id: String): ApiResult<*>
}

/** [CustomerData] on [RosterRepository]. */
class RosterCustomerData
    @Inject
    constructor(
        private val roster: RosterRepository,
    ) : CustomerData {
        override fun customer(id: String): Flow<CustomerDetail?> = roster.customer(id)

        override suspend fun refresh(id: String): ApiResult<*> = roster.refreshCustomer(id)
    }

@Module
@InstallIn(ViewModelComponent::class)
abstract class CustomerDataModule {
    @Binds
    abstract fun bindCustomerData(impl: RosterCustomerData): CustomerData
}
