package com.cablebilling.lineman.data.payments

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.time.Instant
import java.util.Random

/** Saving a payment on the phone: ids, provisional references, the commit-before-"Saved" rule, idempotency. */
@RunWith(AndroidJUnit4::class)
class PaymentRepositoryTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val db: CableDatabase = inMemoryDatabase()

    // 20:00 UTC is already the next day in India.
    private val time = FakeTime(Instant.parse("2026-10-13T20:00:00Z").toEpochMilli())
    private lateinit var network: TestNetwork

    /** Every push request must come after the payment is in Room. */
    private var committedAtPush = mutableListOf<Int>()
    private val pushes =
        RecordingPushTrigger {
            committedAtPush +=
                runBlocking { db.paymentDao().oldestSavedOnPhoneFor(PaymentFixtures.login.user.id, 100).size }
        }
    private lateinit var repository: PaymentRepository

    @Before
    fun setUp() {
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(PaymentFixtures.login) }
        repository = PaymentRepository(db, network.store, time, pushes)
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    @Test
    fun `UUIDv7 ids carry the time, version 7 and the RFC variant`() {
        val millis = Instant.parse("2026-10-13T11:30:00Z").toEpochMilli()
        val ids = (1..200).map { UuidV7.generate(millis + it) }
        ids.forEach { id ->
            assertTrue(id, UuidV7.isValid(id))
            assertEquals('7', id[14])
        }
        assertEquals(millis + 1, UuidV7.epochMillis(ids.first()))
        assertEquals(200, ids.toSet().size)
        // Later time sorts later (the payments' ids follow the order they were made).
        assertEquals(ids, ids.sorted())
        // Same time, different random bits: still unique.
        val random = Random(7)
        assertEquals(50, (1..50).map { UuidV7.generate(millis, random) }.toSet().size)
    }

    @Test
    fun `save commits the payment with its id, provisional reference and India date before asking for a push`() {
        val draft = PaymentFixtures.draft(amountPaise = 45_000)

        val result = await { repository.save(draft) }

        assertEquals(SaveResult.Saved(draft.id, "P-K7Q-0001", isNew = true), result)
        val row = await { db.paymentDao().get(draft.id) }!!
        assertEquals(PaymentState.SAVED_ON_PHONE, row.state)
        assertEquals(45_000L, row.amountPaise)
        assertEquals(PaymentMethod.CASH, row.method)
        assertNull(row.upiReference)
        assertEquals(time.now, row.recordedAt)
        assertEquals("2026-10-14", row.businessDate)
        assertEquals(PaymentFixtures.login.user.id, row.collectorId)
        assertEquals(PaymentFixtures.login.device.id, row.deviceId)
        assertEquals("Ramesh Kumar", row.customerName)
        assertEquals(1, pushes.requests)
        assertEquals(listOf(1), committedAtPush)
    }

    @Test
    fun `provisional references count up per device code and never repeat`() {
        val refs =
            (1..12).map {
                (
                    await {
                        repository.save(
                            PaymentFixtures.draft(),
                        )
                    } as SaveResult.Saved
                ).provisionalRef
            }

        assertEquals((1..12).map { "P-K7Q-%04d".format(it) }, refs)
        refs.forEach { assertTrue(it, PaymentRules.PROVISIONAL_REF.matches(it)) }

        // The office registers the phone again with a new code: a new sequence for the new prefix.
        await {
            network.store.signIn(
                PaymentFixtures.login.copy(device = PaymentFixtures.login.device.copy(deviceCode = "Z9X")),
            )
        }
        val next = await { repository.save(PaymentFixtures.draft()) } as SaveResult.Saved
        assertEquals("P-Z9X-0001", next.provisionalRef)
    }

    @Test
    fun `saving the same draft again (double tap, or after a restart) keeps one payment`() {
        val draft = PaymentFixtures.draft(method = PaymentMethod.UPI, upiReference = "  4298 ")

        val first = await { repository.save(draft) } as SaveResult.Saved
        val second = await { repository.save(draft) } as SaveResult.Saved
        val restarted = PaymentRepository(db, network.store, time, pushes)
        val third = await { restarted.save(draft.copy(amountPaise = 99_900)) } as SaveResult.Saved

        assertTrue(first.isNew)
        assertFalse(second.isNew)
        assertFalse(third.isNew)
        assertEquals(setOf("P-K7Q-0001"), setOf(first.provisionalRef, second.provisionalRef, third.provisionalRef))
        val row = await { db.paymentDao().get(draft.id) }!!
        assertEquals(50_000L, row.amountPaise)
        assertEquals("4298", row.upiReference)
        assertEquals(1, await { db.paymentDao().oldestSavedOnPhoneFor(PaymentFixtures.login.user.id, 100).size })
    }

    @Test
    fun `nothing is saved without a sign-in or with a draft the office would refuse`() {
        assertTrue(await { repository.save(PaymentFixtures.draft(amountPaise = 0)) } is SaveResult.Invalid)
        assertTrue(await { repository.save(PaymentFixtures.draft(amountPaise = 45_050)) } is SaveResult.Invalid)
        assertTrue(await { repository.save(PaymentFixtures.draft(id = "not-a-uuid")) } is SaveResult.Invalid)
        val longRef = "1".repeat(PaymentRules.MAX_UPI_REFERENCE + 1)
        assertTrue(
            await {
                repository.save(PaymentFixtures.draft(method = PaymentMethod.UPI, upiReference = longRef))
            } is SaveResult.Invalid,
        )

        await { network.store.end(SignOutReason.SESSION_EXPIRED) }
        assertEquals(SaveResult.NotSignedIn, await { repository.save(PaymentFixtures.draft()) })

        assertEquals(0, await { db.paymentDao().countWithRefPrefix("P-") })
        assertEquals(0, pushes.requests)
    }

    @Test
    fun `a cash payment never stores a UPI reference`() {
        val draft = PaymentFixtures.draft(method = PaymentMethod.CASH, upiReference = "4298")
        await { repository.save(draft) }
        assertNull(await { db.paymentDao().get(draft.id) }?.upiReference)
    }
}
