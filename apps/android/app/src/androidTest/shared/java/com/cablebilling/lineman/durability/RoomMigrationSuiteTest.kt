package com.cablebilling.lineman.durability

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.CableMigrations
import com.cablebilling.lineman.data.db.OutboxState
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.payments.PaymentReceipts
import com.cablebilling.lineman.data.payments.isHeldFor
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.durability.DurabilityFixtures.DAY
import com.cablebilling.lineman.durability.DurabilityFixtures.mohan
import com.cablebilling.lineman.durability.DurabilityFixtures.suresh
import com.cablebilling.lineman.durability.MigrationSeeds.ACTION
import com.cablebilling.lineman.durability.MigrationSeeds.HELD
import com.cablebilling.lineman.durability.MigrationSeeds.ON_PHONE
import com.cablebilling.lineman.durability.MigrationSeeds.REFUSED
import com.cablebilling.lineman.durability.MigrationSeeds.SENT
import com.cablebilling.lineman.feature.today.QueuedHandover
import com.cablebilling.lineman.feature.today.QueuedHandoverState
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Room migrations from schema v1 (PLAN §11.1, §16) with the exported schemas packaged in the test APK
 * (on a phone) or the debug assets (Robolectric): a phone that collected on an older app version keeps
 * every row of every table after the update, and the current code reads them, including the JSON
 * columns Room's schema check cannot see (`allocations_json`, `handover_json`, `queued_handover_json`).
 * A database is never wiped: payments may exist only on this phone (BR-11).
 *
 * Today there is only version 1, so "migrating" is opening a v1 file with the current code; the
 * suite already runs every step and fails when a new version comes without its seed (see
 * [MigrationSeeds]) or without a `Migration` in [CableMigrations.ALL].
 */
@RunWith(AndroidJUnit4::class)
class RoomMigrationSuiteTest {
    @get:Rule
    val helper = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), CableDatabase::class.java)

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val json: Json = NetworkModule.provideJson()

    @Test
    fun everySchemaVersionIsPackagedAndHasASeedAndAMigrationStep() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val packaged =
            assets
                .list(CableDatabase::class.java.name)
                .orEmpty()
                .map { it.removeSuffix(".json").toInt() }
                .sorted()
        assertEquals("exported schemas in the test APK", (1..CableDatabase.VERSION).toList(), packaged)
        assertEquals("a seed per schema version (MigrationSeeds)", packaged.toSet(), MigrationSeeds.byVersion.keys)
        val steps = CableMigrations.ALL.map { it.startVersion to it.endVersion }
        assertEquals((1 until CableDatabase.VERSION).map { it to it + 1 }, steps)
    }

    @Test
    fun theCurrentCodeCreatesExactlyTheNewestCommittedSchema() {
        // Room rewrites the newest JSON on every build; a changed entity without a version bump would ship
        // a schema that phones on that version do not have. The identity hash of a fresh database must
        // be the committed one.
        val name = "fresh-${uniqueNames.incrementAndGet()}.db"
        val room = currentDatabase(name)
        try {
            val actual =
                room.openHelper.writableDatabase.query("SELECT identity_hash FROM room_master_table").use {
                    it.moveToFirst()
                    it.getString(0)
                }
            assertEquals(committedIdentityHash(CableDatabase.VERSION), actual)
        } finally {
            room.close()
            context.deleteDatabase(name)
        }
    }

    @Test
    fun aPhoneOnEveryOlderVersionKeepsAllItsDataAfterTheUpdate() {
        for ((version, seed) in MigrationSeeds.byVersion.toSortedMap()) {
            val name = "upgrade-from-$version.db"
            helper.createDatabase(name, version).use(seed)

            // Room checks every table against the newest exported schema after running the migrations.
            helper.runMigrationsAndValidate(name, CableDatabase.VERSION, true, *CableMigrations.ALL).close()

            val room = currentDatabase(name)
            try {
                assertTheSeedSurvived(room, "from v$version")
            } finally {
                room.close()
            }
        }
    }

    @Test
    fun everyOlderVersionUpgradesOneStepAtATime() {
        // With versions 1…N each step N-1 → N is validated on its own (a phone may skip app updates,
        // but every step must be right). Nothing to do while VERSION is 1.
        for (version in 1 until CableDatabase.VERSION) {
            val name = "step-from-$version.db"
            helper.createDatabase(name, version).use(MigrationSeeds.byVersion.getValue(version))
            helper.runMigrationsAndValidate(name, version + 1, true, *CableMigrations.ALL).close()
        }
    }

    private fun currentDatabase(name: String): CableDatabase =
        Room
            .databaseBuilder(context, CableDatabase::class.java, name)
            .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
            .build()

    private fun committedIdentityHash(version: Int): String {
        val text =
            InstrumentationRegistry
                .getInstrumentation()
                .context.assets
                .open("${CableDatabase::class.java.name}/$version.json")
                .bufferedReader()
                .use { it.readText() }
        val database =
            json
                .parseToJsonElement(text)
                .jsonObject
                .getValue("database")
                .jsonObject
        assertEquals(version, database.getValue("version").jsonPrimitive.int)
        return database.getValue("identityHash").jsonPrimitive.content
    }

    /** What [MigrationSeeds] wrote, read with today's DAOs and JSON classes. */
    private fun assertTheSeedSurvived(
        db: CableDatabase,
        where: String,
    ) {
        val payments = db.paymentDao()
        val onPhone = await { payments.get(ON_PHONE) }!!
        assertEquals(where, PaymentState.SAVED_ON_PHONE, onPhone.state)
        assertEquals(where, 45_000L, onPhone.amountPaise)
        assertEquals(where, PaymentMethod.CASH, onPhone.method)
        assertEquals(where, listOf(ON_PHONE), await { payments.oldestSavedOnPhoneFor(suresh.id, 10) }.map { it.id })

        val sent = await { payments.get(SENT) }!!
        assertEquals(where, PaymentState.SENT_TO_OFFICE, sent.state)
        assertEquals(where, "R-2610-00045", sent.receiptNumber)
        assertEquals(where, "P-K7Q-0002", sent.provisionalRef)
        assertEquals(
            where,
            "INV-2609-00098",
            PaymentReceipts.decodeAllocations(json, sent.allocationsJson).single().invoiceNumber,
        )

        assertEquals(where, PaymentState.NEEDS_OFFICE_HELP, await { payments.get(REFUSED) }!!.state)
        val held = await { payments.get(HELD) }!!
        assertTrue(where, held.isHeldFor(suresh.id))
        assertEquals(where, mohan.id, held.collectorId)
        assertEquals(where, "412345678901", held.upiReference)
        // The next temporary number continues after the old ones (never repeats on this phone).
        assertEquals(where, 4, await { payments.countWithRefPrefix("P-K7Q-") })

        // Projected due: the two payments on the phone count, the one posted before the roster row does not.
        val customer = await { db.customerDao().searchByDigits(MigrationSeeds.CUSTOMER_CODE, 10).first() }.single()
        assertEquals(where, 65_000L, customer.pendingPaise)
        assertEquals(where, 2, customer.pendingCount)
        val detail = await { db.customerDao().observeDetail(MigrationSeeds.customer).first() }!!
        assertEquals(where, "1234567890", detail.connections.single().vcNumber)
        assertEquals(where, 90_000L, detail.openBills.single().outstandingPaise)

        val action = await { db.receiptActionDao().get(ACTION) }!!
        assertEquals(where, OutboxState.PENDING, action.state)
        assertEquals(where, listOf(ACTION), await { db.receiptActionDao().oldestSendable(suresh.id, 10) }.map { it.id })

        val day = await { db.collectionDayDao().withQueuedHandover(suresh.id) }.single()
        assertEquals(where, DAY, day.businessDate)
        val queued = json.decodeFromString(QueuedHandover.serializer(), day.queuedHandoverJson!!)
        assertEquals(where, MigrationSeeds.SUBMISSION, queued.submissionId)
        assertEquals(where, QueuedHandoverState.WAITING, queued.state)
        assertEquals(where, DiscrepancyReason.PENDING_SYNC, queued.request.discrepancyReason)
        val handover = json.decodeFromString(Handover.serializer(), day.handoverJson!!)
        assertEquals(where, -5_000L, handover.discrepancyPaise)

        val meta = await { db.syncMetaDao().get("roster") }
        assertNotNull(where, meta)
        assertEquals(where, MigrationSeeds.CURSOR, meta!!.cursor)
        assertEquals(where, DurabilityFixtures.OPERATOR_ID, meta.scope)
    }
}
