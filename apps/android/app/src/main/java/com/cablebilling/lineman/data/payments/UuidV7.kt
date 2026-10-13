package com.cablebilling.lineman.data.payments

import java.security.SecureRandom
import java.util.Random
import java.util.UUID

/**
 * UUID version 7 (RFC 9562): 48 bits of Unix time in milliseconds, then random bits. A payment's id
 * is one of these, made on the phone **before** the payment is saved (FR-015): it is the idempotency
 * key the server deduplicates on, so it never changes, and ids sort by the time they were made.
 */
object UuidV7 {
    private val secureRandom: Random by lazy { SecureRandom() }

    /** A new UUIDv7 for [epochMillis], lower case (`01929a3e-5b10-7c4e-8a03-…`). */
    fun generate(
        epochMillis: Long,
        random: Random = secureRandom,
    ): String {
        require(epochMillis in 0..MAX_MILLIS) { "time out of range: $epochMillis" }
        val randA = random.nextInt() and RAND_A_MASK
        val msb = (epochMillis shl TIME_SHIFT) or VERSION_BITS or randA.toLong()
        val lsb = (random.nextLong() and RAND_B_MASK) or VARIANT_BITS
        return UUID(msb, lsb).toString()
    }

    /** True for a lower-case UUIDv7 string. */
    fun isValid(id: String): Boolean = PATTERN.matches(id)

    /** The millisecond timestamp inside a UUIDv7. */
    fun epochMillis(id: String): Long = UUID.fromString(id).mostSignificantBits ushr TIME_SHIFT

    private const val TIME_SHIFT = 16
    private const val MAX_MILLIS = (1L shl 48) - 1
    private const val VERSION_BITS = 0x7000L
    private const val RAND_A_MASK = 0x0FFF
    private const val RAND_B_MASK = 0x3FFF_FFFF_FFFF_FFFFL
    private const val VARIANT_BITS = Long.MIN_VALUE // binary 10 in the top two bits
    private val PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
}
