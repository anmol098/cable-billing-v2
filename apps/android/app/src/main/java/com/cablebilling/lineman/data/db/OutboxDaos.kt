package com.cablebilling.lineman.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/** Sync bookkeeping rows ([SyncMetaEntity]). */
@Dao
interface SyncMetaDao {
    @Query("SELECT * FROM sync_meta WHERE stream = :stream")
    suspend fun get(stream: String): SyncMetaEntity?

    @Query("SELECT * FROM sync_meta WHERE stream = :stream")
    fun observe(stream: String): Flow<SyncMetaEntity?>

    @Upsert
    suspend fun upsert(meta: SyncMetaEntity)
}

/** Receipt actions waiting to be sent (T-069). No delete: sent rows stay as the record of what happened. */
@Dao
interface ReceiptActionDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(action: ReceiptActionOutboxEntity)

    @Update
    suspend fun update(actions: List<ReceiptActionOutboxEntity>): Int

    /** The oldest [limit] pending actions, oldest first. */
    @Query("SELECT * FROM receipt_actions_outbox WHERE state = 'PENDING' ORDER BY at, id LIMIT :limit")
    suspend fun oldestPending(limit: Int): List<ReceiptActionOutboxEntity>

    @Query("SELECT * FROM receipt_actions_outbox WHERE payment_id = :paymentId ORDER BY at, id")
    fun observeForPayment(paymentId: String): Flow<List<ReceiptActionOutboxEntity>>

    /**
     * T-069: the oldest [limit] pending actions the server can take now: their payment is at the
     * office (else it answers retry_later) and was taken by [collectorId] (the signed-in lineman).
     */
    @Query(
        "SELECT o.* FROM receipt_actions_outbox o JOIN payments p ON p.id = o.payment_id " +
            "WHERE o.state = 'PENDING' AND p.state = 'SENT_TO_OFFICE' AND p.collector_id = :collectorId " +
            "ORDER BY o.at, o.id LIMIT :limit",
    )
    suspend fun oldestSendable(
        collectorId: String,
        limit: Int,
    ): List<ReceiptActionOutboxEntity>

    /** T-069: how many actions are still pending (any payment). */
    @Query("SELECT COUNT(*) FROM receipt_actions_outbox WHERE state = 'PENDING'")
    suspend fun countPending(): Int

    @Query("SELECT * FROM receipt_actions_outbox WHERE id = :id")
    suspend fun get(id: String): ReceiptActionOutboxEntity?
}

/** The server's view of the lineman's day (T-070). */
@Dao
interface CollectionDayDao {
    @Upsert
    suspend fun upsert(day: CollectionDayEntity)

    @Query("SELECT * FROM collection_day WHERE collector_id = :collectorId AND business_date = :businessDate")
    suspend fun get(
        collectorId: String,
        businessDate: String,
    ): CollectionDayEntity?

    @Query("SELECT * FROM collection_day WHERE collector_id = :collectorId AND business_date = :businessDate")
    fun observe(
        collectorId: String,
        businessDate: String,
    ): Flow<CollectionDayEntity?>

    /** T-070: [collectorId]'s days with a handover saved on the phone (sent or refused later), oldest day first. */
    @Query(
        "SELECT * FROM collection_day WHERE collector_id = :collectorId AND queued_handover_json IS NOT NULL " +
            "ORDER BY business_date",
    )
    suspend fun withQueuedHandover(collectorId: String): List<CollectionDayEntity>
}
