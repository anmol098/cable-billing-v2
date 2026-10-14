package com.cablebilling.lineman.data.receipts

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.feature.receipt.ActivityShareLauncher
import com.cablebilling.lineman.printing.permanentReceipt
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.net.URLDecoder

/** Phone numbers, the message text and the WhatsApp / SMS / PDF intents (PLAN §11.7). */
@RunWith(AndroidJUnit4::class)
class ReceiptIntentsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `phone numbers are normalised to ten digits starting with 6 to 9`() {
        assertEquals("9876543210", PhoneNumbers.normalize("9876543210"))
        assertEquals("9876543210", PhoneNumbers.normalize("+91 98765-43210"))
        assertEquals("9876543210", PhoneNumbers.normalize("919876543210"))
        assertEquals("9876543210", PhoneNumbers.normalize("09876543210"))
        assertEquals("9876543210", PhoneNumbers.normalize("0091 98765 43210"))
        assertEquals("6000000000", PhoneNumbers.normalize("(600) 000-0000"))
        assertNull(PhoneNumbers.normalize(null))
        assertNull(PhoneNumbers.normalize(""))
        assertNull(PhoneNumbers.normalize("5876543210")) // not a mobile prefix
        assertNull(PhoneNumbers.normalize("987654321")) // 9 digits
        assertNull(PhoneNumbers.normalize("0120 2345678")) // landline
        assertNull(PhoneNumbers.normalize("449876543210")) // another country
        assertTrue(PhoneNumbers.isValid("7000000000"))
        assertFalse(PhoneNumbers.isValid("+919876543210"))
        assertEquals("98765 43210", PhoneNumbers.display("9876543210"))
        assertEquals("98765", PhoneNumbers.display("98765"))
        assertEquals("919876543210", PhoneNumbers.international("9876543210"))
    }

    @Test
    fun `wa_me link carries the number with 91 and the Hindi text percent-encoded as UTF-8`() {
        val text = "शर्मा केबल: रसीद R-2610-00045। रमेश से ₹500 मिले। रसीद देखें: https://x.example/r/a?b=1&c=2+3"
        val url = ReceiptIntents.whatsAppUrl("9876543210", text)
        assertTrue(url.startsWith("https://wa.me/919876543210?text="))
        val encoded = url.substringAfter("?text=")
        // Only unreserved characters and %XX: no raw space, '+', '&', '?', '=' or Devanagari.
        assertTrue(encoded, encoded.matches(Regex("[A-Za-z0-9._~%-]*")))
        assertTrue(encoded.startsWith("%E0%A4%B6%E0%A4%B0")) // "शर" in UTF-8
        assertTrue(encoded.contains("%20"))
        assertTrue(encoded.contains("%2B3"))
        assertTrue(encoded.contains("%26c%3D2"))
        assertEquals(text, URLDecoder.decode(encoded, Charsets.UTF_8.name()))
        // Android parses it back to the same text.
        assertEquals(text, Uri.parse(url).getQueryParameter("text"))
    }

    @Test
    fun `WhatsApp intents open the chat in WhatsApp, then WhatsApp Business, never a browser`() {
        val intents = ReceiptIntents.whatsApp("9876543210", "Receipt R-1")
        assertEquals(listOf("com.whatsapp", "com.whatsapp.w4b"), intents.map { it.`package` })
        intents.forEach { intent ->
            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals("https://wa.me/919876543210?text=Receipt%20R-1", intent.dataString)
        }
    }

    @Test
    fun `SMS intent is smsto with the number and the text`() {
        val intent = ReceiptIntents.sms("9876543210", "रसीद https://x.example/r/a").single()
        assertEquals(Intent.ACTION_SENDTO, intent.action)
        assertEquals("smsto:9876543210", intent.dataString)
        assertEquals("रसीद https://x.example/r/a", intent.getStringExtra(ReceiptIntents.EXTRA_SMS_BODY))
    }

    @Test
    fun `PDF intents go to WhatsApp, then WhatsApp Business, then the share sheet, with read access`() {
        val pdf = Uri.parse("content://com.cablebilling.lineman.dev.receipts/receipts/x/Receipt-R-1.pdf")
        val intents = ReceiptIntents.pdf(pdf, "text", "Share PDF")
        assertEquals(3, intents.size)
        intents.take(2).forEachIndexed { i, intent ->
            assertEquals(ReceiptIntents.WHATSAPP_PACKAGES[i], intent.`package`)
            assertEquals(Intent.ACTION_SEND, intent.action)
            assertEquals("application/pdf", intent.type)
            @Suppress("DEPRECATION")
            assertEquals(pdf, intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            assertEquals(pdf, intent.clipData!!.getItemAt(0).uri)
            assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        }
        val chooser = intents.last()
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        assertTrue(chooser.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        @Suppress("DEPRECATION")
        val inner = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertNull(inner.`package`)
        assertEquals("application/pdf", inner.type)
    }

    @Test
    fun `message text in Hindi and English names the receipt, amount and link, and claims nothing else`() {
        val messages = ReceiptMessages(context)
        val receipt = permanentReceipt()
        val hi = messages.withLink(receipt, "https://x.example/r/t", ReceiptLanguage.Hindi)
        assertEquals(
            "${receipt.operatorName}: रसीद ${receipt.number.text}। ${receipt.customerName} से ₹500 मिले। " +
                "रसीद देखें: https://x.example/r/t",
            hi,
        )
        val en = messages.withLink(receipt, "https://x.example/r/t", ReceiptLanguage.English)
        assertEquals(
            "${receipt.operatorName}: Receipt ${receipt.number.text}. ₹500 received from ${receipt.customerName}. " +
                "See the receipt: https://x.example/r/t",
            en,
        )
    }

    @Test
    fun `the launcher tries each candidate and reports whether an app opened`() {
        val app = RuntimeEnvironment.getApplication()
        shadowOf(app).checkActivities(true)
        val launcher = ActivityShareLauncher(app)
        val intents = ReceiptIntents.whatsApp("9876543210", "hi").map { it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        // No WhatsApp on this phone.
        assertFalse(launcher.launch(intents))
        assertNull(shadowOf(app).nextStartedActivity)

        // WhatsApp Business only: the second candidate opens.
        val pm = shadowOf(app.packageManager)
        val component = ComponentName("com.whatsapp.w4b", "com.whatsapp.Main")
        pm.addActivityIfNotPresent(component)
        pm.addIntentFilterForActivity(
            component,
            IntentFilter(Intent.ACTION_VIEW).apply {
                addCategory(Intent.CATEGORY_DEFAULT)
                addDataScheme("https")
                addDataAuthority("wa.me", null)
            },
        )
        assertTrue(launcher.launch(intents))
        assertEquals("com.whatsapp.w4b", shadowOf(app).nextStartedActivity.`package`)
    }

    @Test
    fun `a launcher failure is a false, never a crash`() {
        val failing =
            ActivityShareLauncher(
                object : android.content.ContextWrapper(context) {
                    override fun startActivity(intent: Intent?) = throw ActivityNotFoundException()
                },
            )
        assertFalse(failing.launch(ReceiptIntents.sms("9876543210", "x")))
    }
}
