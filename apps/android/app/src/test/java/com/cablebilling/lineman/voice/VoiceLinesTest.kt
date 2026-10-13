package com.cablebilling.lineman.voice

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.PaymentMethod
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Read-outs come in both languages whatever the app language is (here: English resources). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "en")
class VoiceLinesTest {
    private val lines = VoiceLines(RuntimeEnvironment.getApplication())

    @Test
    fun `customer due (PLAN 11_3 Customer screen)`() {
        assertEquals(
            VoiceLine(
                hindi = "रमेश कुमार, चार सौ पचास रुपये बाकी",
                english = "रमेश कुमार, four hundred fifty rupees due",
            ),
            lines.customerDue("रमेश कुमार", 45_000),
        )
        assertEquals("Ramesh Kumar, one lakh rupees due", lines.customerDue("Ramesh Kumar", 1_00_000_00).english)
    }

    @Test
    fun `collected cash and UPI (Confirm screen)`() {
        assertEquals(
            VoiceLine(hindi = "रमेश से पाँच सौ रुपये नकद", english = "five hundred rupees cash from रमेश"),
            lines.collected("रमेश", 50_000, PaymentMethod.Cash),
        )
        assertEquals(
            VoiceLine(hindi = "Ramesh से एक रुपया UPI", english = "one rupee UPI from Ramesh"),
            lines.collected("Ramesh", 100, PaymentMethod.Upi),
        )
    }

    @Test
    fun `money saved, amount alone, any string`() {
        assertEquals(VoiceLine("पैसे फ़ोन में सेव हो गए", "Money saved on phone"), lines.moneySaved())
        assertEquals(VoiceLine("एक लाख रुपये", "one lakh rupees"), lines.amount(1_00_000_00))
        assertEquals(
            VoiceLine("बाद में", "Later"),
            lines.line(com.cablebilling.lineman.R.string.mobile_voice_hindi_voice_later),
        )
    }
}
