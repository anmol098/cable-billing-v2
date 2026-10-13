package com.cablebilling.lineman.data.db

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.cablebilling.lineman.data.network.ContractFiles
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Room migration baseline (PLAN §11.1, T-072 extends it): every exported schema version upgrades to
 * [CableDatabase.VERSION] through [CableMigrations.ALL], the result matches the entities, and a payment
 * saved on the oldest version is still there afterwards (BR-11).
 *
 * Adding version N: bump VERSION, add `Migration(N-1, N)`, build (Room writes `schemas/…/N.json`), and
 * add a step to [insertPaymentAt] if the payments columns changed. This test then covers 1…N-1 → N.
 */
@RunWith(AndroidJUnit4::class)
class CableDatabaseMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), CableDatabase::class.java)

    private val schemaDir: File by lazy {
        File(ContractFiles.appModuleDir, "schemas/${CableDatabase::class.java.name}")
    }

    private fun schema(version: Int): JsonObject =
        Json
            .parseToJsonElement(File(schemaDir, "$version.json").readText())
            .jsonObject
            .getValue("database")
            .jsonObject

    @Test
    fun `the exported schema of every version is committed`() {
        val versions =
            schemaDir
                .listFiles()
                .orEmpty()
                .map { it.nameWithoutExtension.toInt() }
                .sorted()
        assertEquals((1..CableDatabase.VERSION).toList(), versions)
        assertEquals(CableDatabase.VERSION, schema(CableDatabase.VERSION).getValue("version").jsonPrimitive.int)
    }

    @Test
    fun `a schema version never changes once it exists`() {
        // Room rewrites schemas/…/<VERSION>.json on every build. If an entity changes without a new
        // version, that file changes and this fails: bump VERSION and add a migration instead (phones
        // already have the old tables). Add each new version's identityHash here.
        val frozen = mapOf(1 to "bd437c6be2e0148a6e7a767a234e0198")
        assertEquals(CableDatabase.VERSION, frozen.keys.max())
        frozen.forEach { (version, hash) ->
            assertEquals("schema v$version", hash, schema(version).getValue("identityHash").jsonPrimitive.content)
        }
    }

    @Test
    fun `every version migrates to the current one and keeps its payments`() {
        for (version in 1..CableDatabase.VERSION) {
            val name = "migration-$version.db"
            helper.createDatabase(name, version).use { db -> insertPaymentAt(version, db) }

            helper.runMigrationsAndValidate(name, CableDatabase.VERSION, true, *CableMigrations.ALL).close()

            val room =
                Room
                    .databaseBuilder(ApplicationProvider.getApplicationContext(), CableDatabase::class.java, name)
                    .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
                    .build()
            try {
                val payment = await { room.paymentDao().get("01929a3e-5b10-7c4e-8a06-000000000001") }
                assertEquals("payment saved on schema v$version", 45_000L, payment?.amountPaise)
                assertEquals(PaymentState.SAVED_ON_PHONE, payment?.state)
            } finally {
                room.close()
            }
        }
    }

    @Test
    fun `there is one migration step for every older version`() {
        val migrations = CableMigrations.ALL.map { it.startVersion to it.endVersion }
        // A path from every older version to the current one, one step at a time.
        for (version in 1 until CableDatabase.VERSION) assertTrue(migrations.contains(version to version + 1))
        assertEquals(CableDatabase.VERSION - 1, migrations.size)
    }

    /** One payment row as the payments table looked at [version]. */
    private fun insertPaymentAt(
        version: Int,
        db: androidx.sqlite.db.SupportSQLiteDatabase,
    ) {
        check(version >= 1)
        val values =
            ContentValues().apply {
                put("id", "01929a3e-5b10-7c4e-8a06-000000000001")
                put("customer_id", "01929a3e-5b10-7c4e-8a03-000000000001")
                put("customer_code", "1045")
                put("customer_name", "Ramesh Kumar")
                put("amount_paise", 45_000L)
                put("method", "cash")
                put("recorded_at", 1_760_352_000_000L)
                put("business_date", "2026-10-13")
                put("provisional_ref", "P-K7Q-0012")
                put("collector_id", "01929a3e-5b10-7c4e-8a01-000000000002")
                put("device_id", "01929a3e-5b10-7c4e-8a01-000000000003")
                put("state", "SAVED_ON_PHONE")
                put("attempt_count", 0)
            }
        db.insert("payments", SQLiteDatabase.CONFLICT_ABORT, values)
    }
}
