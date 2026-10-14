package com.cablebilling.lineman.durability

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.DatabaseModule
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The app's real database provider ([DatabaseModule], file `cable.db`) never trades payments for a
 * working app: a database it cannot migrate (here: one written by a newer app version, e.g. after a
 * rollback) is refused loudly, and the file with its payments stays. Also records the SQLite settings
 * the phone writes payments with (journal mode and `synchronous`).
 *
 * On a phone this touches the app's own `cable.db`, so it runs only when that file does not exist (a
 * fresh install of the test build; the suite's runner never starts the real app) and deletes it after.
 */
@RunWith(AndroidJUnit4::class)
class DatabaseSafetyTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val file get() = context.getDatabasePath(CableDatabase.NAME)

    @Before
    fun onlyOnAPhoneWithoutRealData() {
        assumeFalse("never touch a real app database", file.exists())
    }

    @After
    fun removeTheTestDatabase() {
        context.deleteDatabase(CableDatabase.NAME)
    }

    @Test
    fun aDatabaseFromANewerAppVersionIsRefused_neverWiped() {
        val first = DatabaseModule.provideDatabase(context)
        await { first.paymentDao().insert(payment()) }
        first.close()
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use {
            it.version = CableDatabase.VERSION + 1
        }

        val second = DatabaseModule.provideDatabase(context)
        val refused = assertThrows(IllegalStateException::class.java) { second.openHelper.writableDatabase }
        second.close()

        assertTrue(refused.message.orEmpty(), refused.message.orEmpty().contains("migration", ignoreCase = true))
        SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT amount_paise, state FROM payments", null).use { rows ->
                assertEquals(1, rows.count)
                rows.moveToFirst()
                assertEquals(45_000L, rows.getLong(0))
                assertEquals("SAVED_ON_PHONE", rows.getString(1))
            }
        }
    }

    @Test
    fun paymentsAreWrittenWithAJournalAndSynchronousWrites() {
        val db = DatabaseModule.provideDatabase(context)
        try {
            val sqlite = db.openHelper.writableDatabase
            val journal =
                sqlite.query("PRAGMA journal_mode").use {
                    it.moveToFirst()
                    it.getString(0)
                }
            val synchronous =
                sqlite.query("PRAGMA synchronous").use {
                    it.moveToFirst()
                    it.getInt(0)
                }
            // Shown in the instrumented run's logcat: WAL with synchronous=1 (NORMAL) can lose the last
            // commits on a power cut (not on a crash); see the field UAT "power cut" step.
            Log.i(
                TAG,
                "cable.db journal_mode=$journal synchronous=$synchronous sdk=${android.os.Build.VERSION.SDK_INT}",
            )
            // Robolectric's SQLite runs with synchronous=OFF; only a real phone's settings mean anything.
            assumeFalse("SQLite settings are checked on a phone or emulator only", Phone.onRobolectric)
            assertTrue("journal mode $journal", journal.lowercase() in setOf("wal", "delete", "truncate", "persist"))
            assertTrue("synchronous=$synchronous (0 = OFF loses commits on a crash)", synchronous >= SYNCHRONOUS_NORMAL)
        } finally {
            db.close()
        }
    }

    private fun payment() =
        PaymentEntity(
            id = "01929a3e-5b10-7c4e-8a06-000000000001",
            customerId = DurabilityFixtures.customerId(1045),
            customerCode = "1045",
            customerName = "Ramesh Kumar",
            amountPaise = 45_000L,
            method = PaymentMethod.CASH,
            upiReference = null,
            notes = null,
            recordedAt = DurabilityFixtures.MORNING,
            businessDate = DurabilityFixtures.DAY,
            provisionalRef = "P-K7Q-0001",
            collectorId = DurabilityFixtures.suresh.id,
            deviceId = DurabilityFixtures.DEVICE_ID,
            state = PaymentState.SAVED_ON_PHONE,
        )

    private companion object {
        const val TAG = "CableDurability"
        const val SYNCHRONOUS_NORMAL = 1
    }
}
