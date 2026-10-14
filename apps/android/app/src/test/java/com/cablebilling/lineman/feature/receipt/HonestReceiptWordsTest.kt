package com.cablebilling.lineman.feature.receipt

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.db.OutboxState
import com.cablebilling.lineman.data.network.generated.ReceiptActionType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

/**
 * PRD §15 #11 / RULE-19: nothing in the receipt flow says a WhatsApp or SMS message was sent or
 * delivered, in English or Hindi: every `mobile_receipt_*` string, the shared "opened" words the
 * screen shows, and every state the phone records or shows.
 */
@RunWith(AndroidJUnit4::class)
class HonestReceiptWordsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private val forbiddenEnglish =
        Regex("\\b(sent|send|delivered|deliver|delivery|received by)\\b", RegexOption.IGNORE_CASE)

    /** "भेजा / भेज दिया / भेजें" (sent / send), "डिलीवर", "पहुँच गया / पहुंच गया" (reached), "मिल गया" (got it). */
    private val forbiddenHindi = Regex("भेज|डिलीवर|पहुँच गया|पहुंच गया|पहुँचा|मिल गया|मिल गई")

    private fun strings(locale: String): Map<String, String> {
        val config = Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag(locale)) }
        val res = context.createConfigurationContext(config).resources
        val shown = setOf("common_whatsapp_opened", "common_sms_opened")
        return R.string::class.java.fields
            .filter { it.name.startsWith("mobile_receipt_") || it.name in shown }
            .associate { it.name to res.getString(it.getInt(null)) }
    }

    @Test
    fun `no receipt string says sent or delivered, in English or Hindi`() {
        val english = strings("en")
        val hindi = strings("hi")
        assertTrue("the namespace is there: ${english.keys}", english.size >= 20)
        assertEquals(english.keys, hindi.keys)
        english.forEach { (key, text) -> assertTrue("$key: $text", !forbiddenEnglish.containsMatchIn(text)) }
        hindi.forEach { (key, text) ->
            assertTrue("$key: $text", !forbiddenHindi.containsMatchIn(text))
            assertTrue("$key: $text", !forbiddenEnglish.containsMatchIn(text))
        }
        assertEquals("WhatsApp opened", english.getValue("common_whatsapp_opened"))
        assertEquals("WhatsApp खुल गया", hindi.getValue("common_whatsapp_opened"))
    }

    @Test
    fun `the states the phone records and shows are only observable ones`() {
        val names =
            ReceiptActionType.entries.map { it.wire } +
                OutboxState.entries.map { it.name } +
                Opened.entries.map { it.name } +
                ShareProblem.entries.map { it.name } +
                listOf(LinkView.Queued, LinkView.Getting, LinkView.None, LinkView.Unavailable).map { it.toString() }
        names.forEach { name ->
            assertTrue(name, !Regex("sent|deliver", RegexOption.IGNORE_CASE).containsMatchIn(name))
        }
        assertEquals(
            setOf("printed", "print_failed", "whatsapp_opened", "sms_opened", "pdf_shared"),
            ReceiptActionType.entries.map { it.wire }.toSet(),
        )
        // Each opened state is shown with an "opened / shared" word.
        Opened.entries.forEach { opened ->
            val word = context.getString(opened.word)
            assertTrue(word, word.contains("opened") || word.contains("shared"))
        }
    }
}
