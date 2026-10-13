package com.cablebilling.lineman.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

/**
 * The local payment queue (T-066 builds the collect flow and push on it). There is deliberately **no
 * delete** (BR-11: a payment taken on the phone is never discarded) and no "replace" insert.
 */
@Dao
interface PaymentDao {
    /** Saves a new payment. Fails (SQLiteConstraintException) if the id or provisional ref already exists. */
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(payment: PaymentEntity)

    /** Stores new sync fields of an existing payment (state, receipt number, attempts …). */
    @Update
    suspend fun update(payment: PaymentEntity): Int

    @Query("SELECT * FROM payments WHERE id = :id")
    suspend fun get(id: String): PaymentEntity?

    @Query("SELECT * FROM payments WHERE id = :id")
    fun observe(id: String): Flow<PaymentEntity?>

    /** The oldest [limit] payments still on the phone, oldest first (the order the server posts them). */
    @Query("SELECT * FROM payments WHERE state = 'SAVED_ON_PHONE' ORDER BY recorded_at, id LIMIT :limit")
    suspend fun oldestSavedOnPhone(limit: Int): List<PaymentEntity>

    /** Payments not yet accepted by the server: on the phone or needing office help (Waiting screen), newest first. */
    @Query("SELECT * FROM payments WHERE state != 'SENT_TO_OFFICE' ORDER BY recorded_at DESC, id")
    fun observeNotSent(): Flow<List<PaymentEntity>>

    /** How many payments are still on the phone ("3 payments on phone", Waiting tab badge). */
    @Query("SELECT COUNT(*) FROM payments WHERE state = 'SAVED_ON_PHONE'")
    fun observeSavedOnPhoneCount(): Flow<Int>

    /** One lineman's payments of one India-time day, newest first (Today screen). */
    @Query(
        "SELECT * FROM payments WHERE collector_id = :collectorId AND business_date = :businessDate " +
            "ORDER BY recorded_at DESC, id",
    )
    fun observeDay(
        collectorId: String,
        businessDate: String,
    ): Flow<List<PaymentEntity>>
}
