package com.cablebilling.lineman.data.db

import androidx.room.TypeConverter
import com.cablebilling.lineman.data.network.generated.PaymentMethod

/**
 * Room column converters. Contract enums are stored as their wire value (`cash`, `upi`), so a row
 * reads the same as the API. [PaymentState] and [OutboxState] use Room's built-in enum-name mapping.
 */
class Converters {
    @TypeConverter
    fun paymentMethodToWire(method: PaymentMethod): String = method.wire

    @TypeConverter
    fun paymentMethodFromWire(wire: String): PaymentMethod =
        requireNotNull(PaymentMethod.fromWire(wire)) { "Unknown payment method '$wire' in Room" }
}
