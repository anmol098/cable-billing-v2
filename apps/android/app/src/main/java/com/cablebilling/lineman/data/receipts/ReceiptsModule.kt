package com.cablebilling.lineman.data.receipts

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

private val Context.receiptRequestsDataStore: DataStore<Preferences> by preferencesDataStore(
    name = ReceiptRequestStore.FILE,
)

/** Hilt: receipt actions go to the Room outbox; sends are scheduled by [ReceiptSyncScheduler]. */
@Module
@InstallIn(SingletonComponent::class)
abstract class ReceiptsModule {
    @Binds
    abstract fun bindRecorder(impl: OutboxReceiptActions): ReceiptActionRecorder

    @Binds
    abstract fun bindTrigger(impl: ReceiptSyncScheduler): ReceiptSyncTrigger

    companion object {
        @Provides
        @Singleton
        @ReceiptRequestsDataStore
        fun provideRequestsDataStore(
            @ApplicationContext context: Context,
        ): DataStore<Preferences> = context.receiptRequestsDataStore
    }
}
