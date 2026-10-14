package com.cablebilling.lineman.durability

import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.data.network.generated.OperatorInfo
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.network.generated.RegisteredDevice
import com.cablebilling.lineman.data.network.generated.TokenPair
import com.cablebilling.lineman.data.network.generated.UserInfo
import com.cablebilling.lineman.data.network.generated.UserInfoLanguage
import com.cablebilling.lineman.data.payments.PaymentDraft
import com.cablebilling.lineman.data.payments.UuidV7
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * The people, phone and payments of the durability suite. Built in code (not from the contract
 * fixture files) so the same tests run on a phone, where `packages/contracts` does not exist. The ids
 * match the contract fixtures (`login.response.json`).
 */
object DurabilityFixtures {
    const val OPERATOR_ID = "01929a3e-5b10-7c4e-8a01-000000000001"
    const val DEVICE_ID = "01929a3e-5b10-7c4e-8a01-000000000003"
    const val DEVICE_CODE = "K7Q"

    /** The lineman of most tests. */
    val suresh = UserInfo("01929a3e-5b10-7c4e-8a01-000000000002", "Suresh Yadav", "9876501234", UserInfoLanguage.HI)

    /** A second lineman of the same operator, signing in on the same phone (PLAN §9.2). */
    val mohan = UserInfo("01929a3e-5b10-7c4e-8a01-000000000009", "Mohan Lal", "9876509999", UserInfoLanguage.HI)

    /** A customer id per customer code (the queue does not need the roster to save or send). */
    fun customerId(code: Int): String = "01929a3e-5b10-7c4e-8a03-%012d".format(code)

    /** What `POST /auth/login` answers for [user] on this phone. Refresh is reactive, so expiry does not matter. */
    fun login(user: UserInfo = suresh): LoginResponse =
        LoginResponse(
            serverTime = "2026-10-13T03:30:00.000Z",
            tokens =
                TokenPair(
                    tokenType = "Bearer",
                    accessToken = "access-${user.login}",
                    accessTokenExpiresAt = "2026-10-13T03:45:00.000Z",
                    refreshToken = "refresh-${user.login}",
                    refreshTokenExpiresAt = "2027-04-11T03:30:00.000Z",
                ),
            user = user,
            operator = OperatorInfo(OPERATOR_ID, "Shiv Cable Network", "9800000001", null),
            device = RegisteredDevice(DEVICE_ID, DEVICE_CODE),
        )

    private val ids = AtomicLong(0)

    /**
     * A payment as the Confirm step builds it: the UUIDv7 is made before Save (and kept in
     * `SavedStateHandle`, so a Save after process death reuses it).
     */
    fun draft(
        code: Int = 1045,
        amountRupees: Long = 500,
        method: PaymentMethod = PaymentMethod.CASH,
        upiReference: String? = null,
        id: String = UuidV7.generate(ID_BASE_MILLIS + ids.incrementAndGet()),
    ): PaymentDraft =
        PaymentDraft(
            id = id,
            customerId = customerId(code),
            customerCode = code.toString(),
            customerName = "Customer $code",
            amountPaise = amountRupees * PAISE_PER_RUPEE,
            method = method,
            upiReference = upiReference,
        )

    const val PAISE_PER_RUPEE = 100L

    /** 09:00 India time on 13 Oct 2026, the start of the field day. */
    val MORNING: Long = Instant.parse("2026-10-13T03:30:00Z").toEpochMilli()

    /** The India-time business date of [MORNING]. */
    const val DAY = "2026-10-13"

    private const val ID_BASE_MILLIS = 1_791_000_000_000L
}

/** The phone's clock, moved by the test (no real waiting). Survives a "process restart" like the real clock. */
class TestClock(
    start: Long = DurabilityFixtures.MORNING,
) : TimeSource {
    private val now = AtomicLong(start)

    override fun nowMillis(): Long = now.get()

    fun advanceMinutes(minutes: Long) {
        now.addAndGet(minutes * MILLIS_PER_MINUTE)
    }

    private companion object {
        const val MILLIS_PER_MINUTE = 60_000L
    }
}

/** Counts to make unique names (database files, folders) inside one test run. */
internal val uniqueNames = AtomicInteger(0)
