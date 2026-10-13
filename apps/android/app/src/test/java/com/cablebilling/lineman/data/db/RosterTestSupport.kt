package com.cablebilling.lineman.data.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.generated.Connection
import com.cablebilling.lineman.data.network.generated.ConnectionStatus
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.network.generated.RosterCustomer
import com.cablebilling.lineman.data.network.generated.SyncCustomersResponse
import java.time.Instant

/** A phone clock the test moves by hand. */
class FakeTime(
    @Volatile var now: Long = Instant.parse("2026-10-13T11:30:00Z").toEpochMilli(),
) : TimeSource {
    override fun nowMillis(): Long = now

    fun advanceMinutes(minutes: Long) {
        now += minutes * 60_000
    }
}

/** A fresh in-memory [CableDatabase] (Robolectric). */
fun inMemoryDatabase(): CableDatabase =
    Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), CableDatabase::class.java).build()

/** Roster data built from the contract fixtures, so every row has the server's shape. */
object RosterFixtures {
    /** `syncCustomers.response.json`: Ramesh (1045) and Sunita (1046), one tombstone, has_more false. */
    val page: SyncCustomersResponse get() =
        Fixtures.decode(
            SyncCustomersResponse.serializer(),
            "syncCustomers.response.json",
        )

    val emptyPage: SyncCustomersResponse
        get() = Fixtures.decode(SyncCustomersResponse.serializer(), "syncCustomers.response.empty.json")

    /** `login.response.json`: lineman of operator `…8a01-000000000001`. */
    val login: LoginResponse get() = Fixtures.decode(LoginResponse.serializer(), "login.response.json")

    val ramesh: RosterCustomer get() = page.customers[0]
    val sunita: RosterCustomer get() = page.customers[1]

    /** A customer id like the fixtures', numbered. */
    fun customerId(n: Int): String = "01929a3e-5b10-7c4e-8a03-%012d".format(n)

    /** Ramesh's row reshaped into customer number [n]. */
    fun customer(
        n: Int,
        code: String = (2000 + n).toString(),
        name: String = "Customer $n",
        phone: String? = "98%08d".format(n),
        vcNumbers: List<String> = listOf("0007%08d".format(n)),
        balancePaise: Long = 45_000,
        updatedAt: String = "2026-10-12T09:00:00.000Z",
    ): RosterCustomer =
        ramesh.copy(
            id = customerId(n),
            code = code,
            name = name,
            phone = phone,
            altPhone = null,
            connections = vcNumbers.map { Connection(it, ConnectionStatus.ACTIVE) },
            balancePaise = balancePaise,
            creditPaise = 0,
            updatedAt = updatedAt,
        )

    /** A payment row as T-066 will save it. */
    fun payment(
        id: String,
        customerId: String,
        amountPaise: Long,
        state: PaymentState = PaymentState.SAVED_ON_PHONE,
        postedAt: Long? = null,
        recordedAt: Long = Instant.parse("2026-10-13T10:00:00Z").toEpochMilli(),
    ): PaymentEntity =
        PaymentEntity(
            id = id,
            customerId = customerId,
            customerCode = "1045",
            customerName = "Ramesh Kumar",
            amountPaise = amountPaise,
            method = PaymentMethod.CASH,
            upiReference = null,
            notes = null,
            recordedAt = recordedAt,
            businessDate = "2026-10-13",
            provisionalRef = "P-K7Q-$id",
            collectorId = "01929a3e-5b10-7c4e-8a01-000000000002",
            deviceId = "01929a3e-5b10-7c4e-8a01-000000000003",
            state = state,
            receiptNumber = if (state == PaymentState.SENT_TO_OFFICE) "R-2610-$id" else null,
            postedAt = postedAt,
        )
}

/** Rows straight into Room (as a finished sync would leave them). */
suspend fun CableDatabase.putRoster(
    operatorId: String,
    customers: List<RosterCustomer>,
    now: Long = 0,
) {
    syncMetaDao().upsert(
        SyncMetaEntity(SyncStreams.ROSTER, operatorId, "cursor-1", now, now, now, null),
    )
    rosterWriteDao().upsert(customers.map { it.toEntity(now) })
    rosterWriteDao().insertConnections(customers.flatMap { it.connectionEntities() })
}
