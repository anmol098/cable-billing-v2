package com.cablebilling.lineman.data.payments

import com.cablebilling.lineman.data.sync.PaymentSyncScheduler
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/** Hilt: a save asks [PaymentSyncScheduler] for a push. */
@Module
@InstallIn(SingletonComponent::class)
abstract class PaymentsModule {
    @Binds
    abstract fun bindPushTrigger(impl: PaymentSyncScheduler): PaymentPushTrigger
}
