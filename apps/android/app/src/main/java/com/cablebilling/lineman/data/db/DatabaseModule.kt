package com.cablebilling.lineman.data.db

import android.content.Context
import androidx.room.Room
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * The Room database and its DAOs (T-064). Opened lazily on first injection. No destructive
 * migration fallback: a missing migration crashes loudly in testing instead of deleting payments
 * that exist only on this phone (BR-11).
 */
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {
    @Provides
    @Singleton
    fun provideDatabase(
        @ApplicationContext context: Context,
    ): CableDatabase =
        Room
            .databaseBuilder(context, CableDatabase::class.java, CableDatabase.NAME)
            .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
            .build()

    @Provides
    fun provideCustomerDao(db: CableDatabase): CustomerDao = db.customerDao()

    @Provides
    fun provideRosterWriteDao(db: CableDatabase): RosterWriteDao = db.rosterWriteDao()

    @Provides
    fun providePaymentDao(db: CableDatabase): PaymentDao = db.paymentDao()

    @Provides
    fun provideSyncMetaDao(db: CableDatabase): SyncMetaDao = db.syncMetaDao()

    @Provides
    fun provideReceiptActionDao(db: CableDatabase): ReceiptActionDao = db.receiptActionDao()

    @Provides
    fun provideCollectionDayDao(db: CableDatabase): CollectionDayDao = db.collectionDayDao()

    @Provides
    fun provideTimeSource(): TimeSource = TimeSource.System
}
