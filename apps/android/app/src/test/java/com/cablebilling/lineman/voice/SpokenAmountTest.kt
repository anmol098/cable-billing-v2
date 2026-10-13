package com.cablebilling.lineman.voice

import com.cablebilling.lineman.voice.VoiceLanguage.English
import com.cablebilling.lineman.voice.VoiceLanguage.Hindi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SpokenAmountTest {
    private fun rupees(value: Long): Long = value * 100

    @Test
    fun `the three amounts from the task, in Hindi and English`() {
        assertEquals("एक रुपया", SpokenAmount.words(rupees(1), Hindi))
        assertEquals("one rupee", SpokenAmount.words(rupees(1), English))
        assertEquals("चार सौ पचास रुपये", SpokenAmount.words(rupees(450), Hindi))
        assertEquals("four hundred fifty rupees", SpokenAmount.words(rupees(450), English))
        assertEquals("एक लाख रुपये", SpokenAmount.words(rupees(1_00_000), Hindi))
        assertEquals("one lakh rupees", SpokenAmount.words(rupees(1_00_000), English))
    }

    @Test
    fun `edge cases`() {
        val cases =
            listOf(
                0L to ("शून्य रुपये" to "zero rupees"),
                2L to ("दो रुपये" to "two rupees"),
                99L to ("निन्यानवे रुपये" to "ninety-nine rupees"),
                100L to ("एक सौ रुपये" to "one hundred rupees"),
                101L to ("एक सौ एक रुपये" to "one hundred one rupees"),
                500L to ("पाँच सौ रुपये" to "five hundred rupees"),
                1_000L to ("एक हज़ार रुपये" to "one thousand rupees"),
                1_050L to ("एक हज़ार पचास रुपये" to "one thousand fifty rupees"),
                10_000L to ("दस हज़ार रुपये" to "ten thousand rupees"),
                99_999L to
                    ("निन्यानवे हज़ार नौ सौ निन्यानवे रुपये" to "ninety-nine thousand nine hundred ninety-nine rupees"),
                1_00_001L to ("एक लाख एक रुपये" to "one lakh one rupees"),
                12_34_567L to (
                    "बारह लाख चौंतीस हज़ार पाँच सौ सड़सठ रुपये" to
                        "twelve lakh thirty-four thousand five hundred sixty-seven rupees"
                ),
                1_00_00_000L to ("एक करोड़ रुपये" to "one crore rupees"),
                2_50_00_000L to ("दो करोड़ पचास लाख रुपये" to "two crore fifty lakh rupees"),
                1_00_00_00_000L to ("एक सौ करोड़ रुपये" to "one hundred crore rupees"),
                12_34_56_78_901L to (
                    "एक हज़ार दो सौ चौंतीस करोड़ छप्पन लाख अठहत्तर हज़ार नौ सौ एक रुपये" to
                        "one thousand two hundred thirty-four crore fifty-six lakh " +
                        "seventy-eight thousand nine hundred one rupees"
                ),
            )
        for ((amount, expected) in cases) {
            assertEquals("₹$amount in Hindi", expected.first, SpokenAmount.words(rupees(amount), Hindi))
            assertEquals("₹$amount in English", expected.second, SpokenAmount.words(rupees(amount), English))
        }
    }

    @Test
    fun `the sign is dropped like Rupees format`() {
        assertEquals("चार सौ पचास रुपये", SpokenAmount.words(-rupees(450), Hindi))
        assertEquals("four hundred fifty rupees", SpokenAmount.words(-rupees(450), English))
    }

    @Test
    fun `paise are spoken rather than rounded away`() {
        assertEquals("बारह रुपये पचास पैसे", SpokenAmount.words(1_250, Hindi))
        assertEquals("twelve rupees and fifty paise", SpokenAmount.words(1_250, English))
        assertEquals("एक पैसा", SpokenAmount.words(1, Hindi))
        assertEquals("one paisa", SpokenAmount.words(1, English))
        assertEquals("निन्यानवे पैसे", SpokenAmount.words(-99, Hindi))
    }

    @Test
    fun `the largest amounts do not overflow`() {
        // Long.MIN_VALUE paise = -₹92,233,720,368,547,758.08: dividing first avoids abs() overflow.
        val words = SpokenAmount.words(Long.MIN_VALUE, English)
        assertEquals(true, words.endsWith("fifty-eight rupees and eight paise"))
        assertEquals(true, SpokenAmount.words(Long.MAX_VALUE, Hindi).endsWith("अट्ठावन रुपये सात पैसे"))
    }

    @Test
    fun `Hindi has a distinct word for every number below 100`() {
        assertEquals(100, SpokenAmount.HINDI_0_TO_99.size)
        assertEquals(100, SpokenAmount.HINDI_0_TO_99.toSet().size)
        assertEquals("पचास", SpokenAmount.number(50, Hindi))
        assertEquals("अठहत्तर", SpokenAmount.number(78, Hindi))
        assertEquals("उन्यासी", SpokenAmount.number(79, Hindi))
        assertEquals("इक्यानवे", SpokenAmount.number(91, Hindi))
    }

    @Test
    fun `English below 100`() {
        assertEquals("zero", SpokenAmount.number(0, English))
        assertEquals("nineteen", SpokenAmount.number(19, English))
        assertEquals("twenty", SpokenAmount.number(20, English))
        assertEquals("forty-two", SpokenAmount.number(42, English))
        assertEquals("ninety", SpokenAmount.number(90, English))
    }

    @Test
    fun `number rejects negative values`() {
        assertThrows(IllegalArgumentException::class.java) { SpokenAmount.number(-1, Hindi) }
    }
}
