package com.cablebilling.lineman.data.db

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.room.migration.Migration

/**
 * The app's one Room database (PLAN §11.5): roster cache, payment queue, receipt-action outbox,
 * collection day and sync bookkeeping. Schemas are exported to `apps/android/app/schemas/` and
 * committed; [CableMigrations] must take every exported version to [VERSION].
 *
 * Changing an entity: bump [VERSION], add a `Migration(old, new)` to [CableMigrations.ALL], build (Room
 * writes `schemas/…/<new>.json`), commit the new JSON, and run `CableDatabaseMigrationTest`. Never
 * use a destructive fallback: it would delete payments that only exist on this phone (BR-11).
 */
@Database(
    entities = [
        CustomerEntity::class,
        CustomerVcEntity::class,
        OpenBillEntity::class,
        PaymentEntity::class,
        ReceiptActionOutboxEntity::class,
        CollectionDayEntity::class,
        SyncMetaEntity::class,
    ],
    version = CableDatabase.VERSION,
    exportSchema = true,
)
@TypeConverters(Converters::class)
abstract class CableDatabase : RoomDatabase() {
    abstract fun customerDao(): CustomerDao

    abstract fun rosterWriteDao(): RosterWriteDao

    abstract fun paymentDao(): PaymentDao

    abstract fun syncMetaDao(): SyncMetaDao

    abstract fun receiptActionDao(): ReceiptActionDao

    abstract fun collectionDayDao(): CollectionDayDao

    companion object {
        /** File name in the app's database directory. */
        const val NAME = "cable.db"

        /** Current schema version. 1 = T-064. */
        const val VERSION = 1
    }
}

/** Every migration between exported schema versions, in order. Empty while only version 1 exists. */
object CableMigrations {
    val ALL: Array<Migration> = emptyArray()
}
