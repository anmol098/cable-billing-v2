package com.cablebilling.lineman.printing.receipt

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.printing.permanentReceipt
import com.cablebilling.lineman.printing.provisionalReceipt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import java.time.Instant
import java.time.YearMonth

/** The receipt's words and order (PLAN §11.8 layout), from the real `mobile_printer` strings. */
@RunWith(AndroidJUnit4::class)
class ReceiptContentTest {
    private val english = ReceiptStrings.load(RuntimeEnvironment.getApplication(), ReceiptLanguage.English)
    private val hindi = ReceiptStrings.load(RuntimeEnvironment.getApplication(), ReceiptLanguage.Hindi)

    @Test
    fun permanentUpiReceiptInEnglish() {
        val lines = ReceiptContent.receipt(permanentReceipt(), english).lines
        assertEquals(
            listOf(
                ReceiptLine.Text("Shree Ganesh Cable Network", ReceiptTextStyle.Title, ReceiptAlign.Center),
                ReceiptLine.Text("Phone: 9800000001", ReceiptTextStyle.Body, ReceiptAlign.Center),
                ReceiptLine.Text("Receipt", ReceiptTextStyle.Strong, ReceiptAlign.Center),
                ReceiptLine.Rule,
                ReceiptLine.Field("Receipt no.", "R-2610-00045"),
                ReceiptLine.Field("Date", "12 Oct 2026, 4:05 PM"),
                ReceiptLine.Rule,
                ReceiptLine.Field("Customer", "Ramesh Kumar"),
                ReceiptLine.Field("Code", "C-0045"),
                ReceiptLine.Rule,
                ReceiptLine.Amount("₹500"),
                ReceiptLine.Text("UPI", ReceiptTextStyle.Strong, ReceiptAlign.Center),
                ReceiptLine.Field("UPI ref.", "UTR 4521 8890"),
                ReceiptLine.Rule,
                ReceiptLine.Text("Oct 2026 bill paid"),
                ReceiptLine.Text("Nov 2026 bill: ₹50 left"),
                ReceiptLine.Field("Due now", "₹50"),
                ReceiptLine.Rule,
                ReceiptLine.Field("Lineman", "Suresh"),
                ReceiptLine.Text("Thank you. Call us for any problem.", ReceiptTextStyle.Small, ReceiptAlign.Center),
            ),
            lines,
        )
    }

    @Test
    fun provisionalCashReceiptInHindiIsMarkedTemporaryAndGuessesNothing() {
        val lines = ReceiptContent.receipt(provisionalReceipt(), hindi).lines
        assertEquals(
            listOf(
                ReceiptLine.Text("श्री गणेश केबल", ReceiptTextStyle.Title, ReceiptAlign.Center),
                ReceiptLine.Text("रसीद", ReceiptTextStyle.Strong, ReceiptAlign.Center),
                ReceiptLine.Rule,
                ReceiptLine.Field("रसीद नं.", "P-K7Q-0012"),
                ReceiptLine.Text("अस्थायी नं. पक्का नं. ऑफिस देगा।", ReceiptTextStyle.Small),
                ReceiptLine.Field("तारीख", "12 अक्टू 2026, 4:05 PM"),
                ReceiptLine.Rule,
                ReceiptLine.Field("ग्राहक", "रमेश कुमार"),
                ReceiptLine.Field("कोड", "C-0045"),
                ReceiptLine.Rule,
                // Indian grouping, Latin digits in Hindi too (PLAN §11.4).
                ReceiptLine.Amount("₹1,23,456"),
                ReceiptLine.Text("नकद", ReceiptTextStyle.Strong, ReceiptAlign.Center),
                // No bill split and no balance: the office has not posted it yet.
                ReceiptLine.Rule,
                ReceiptLine.Field("लाइनमैन", "सुरेश"),
            ),
            lines,
        )
    }

    @Test
    fun billLinesAndBalances() {
        val model =
            permanentReceipt().copy(
                bills = listOf(ReceiptBill(null, 0), ReceiptBill(null, 20_000), ReceiptBill(YearMonth.of(2027, 1), 0)),
                balanceAfter = ReceiptBalance.Credit(10_000),
            )
        val texts = ReceiptContent.receipt(model, hindi).lines
        assertTrue(ReceiptLine.Text("पुराना बाकी पूरा") in texts)
        assertTrue(ReceiptLine.Text("पुराना बाकी: ₹200") in texts)
        assertTrue(ReceiptLine.Text("जन 2027 का बिल पूरा") in texts)
        assertTrue(ReceiptLine.Field("एडवांस", "₹100") in texts)

        val clear =
            ReceiptContent.receipt(
                permanentReceipt().copy(bills = emptyList(), balanceAfter = ReceiptBalance.Clear),
                english,
            )
        assertTrue(ReceiptLine.Text("Nothing due", ReceiptTextStyle.Strong) in clear.lines)

        assertEquals(ReceiptBalance.Due(5), ReceiptBalance.of(balanceAfterPaise = 5, creditAfterPaise = 0))
        assertEquals(ReceiptBalance.Credit(7), ReceiptBalance.of(balanceAfterPaise = 0, creditAfterPaise = 7))
        assertEquals(ReceiptBalance.Clear, ReceiptBalance.of(balanceAfterPaise = 0, creditAfterPaise = 0))
    }

    @Test
    fun cashNeverShowsAUpiReference() {
        val model = permanentReceipt().copy(method = ReceiptMethod.Cash, upiReference = "UTR 1")
        val lines = ReceiptContent.receipt(model, english).lines
        assertFalse(lines.any { it is ReceiptLine.Field && it.label == "UPI ref." })
        assertTrue(ReceiptLine.Text("Cash", ReceiptTextStyle.Strong, ReceiptAlign.Center) in lines)
    }

    @Test
    fun timesAreIndiaTimeOnATwelveHourClock() {
        fun at(utc: String) = ReceiptContent.dateTime(Instant.parse(utc), english)
        assertEquals("13 Oct 2026, 12:00 AM", at("2026-10-12T18:30:00Z"))
        assertEquals("12 Oct 2026, 12:00 PM", at("2026-10-12T06:30:00Z"))
        assertEquals("1 Jan 2027, 5:29 AM", at("2026-12-31T23:59:00Z"))
        assertEquals("12 अक्टू 2026, 11:59 PM", ReceiptContent.dateTime(Instant.parse("2026-10-12T18:29:00Z"), hindi))
    }

    @Test
    fun testPageHasHindiAndEnglishSamplesInEitherLanguage() {
        val at = Instant.parse("2026-10-12T10:35:00Z")
        listOf(english, hindi).forEach { strings ->
            val lines = ReceiptContent.testPage("MTP-II", at, strings).lines
            val text = lines.joinToString("\n") { it.toString() }
            assertTrue(text, text.contains("हिंदी: रसीद"))
            assertTrue(text, text.contains("English: Receipt"))
            assertTrue(ReceiptLine.Amount("₹1,23,456") in lines)
            assertTrue(lines.any { it is ReceiptLine.Field && it.value == "MTP-II" })
        }
    }

    @Test
    fun receiptNeverClaimsToBeATaxInvoiceOrThatAMessageWasSent() {
        // B-019 (not a GST tax invoice) and the honest-state rule, in both languages.
        val banned = listOf("invoice", "tax", "gst", "इनवॉइस", "टैक्स", "sent", "delivered", "भेजा")
        listOf(english, hindi).forEach { strings ->
            listOf(permanentReceipt(), provisionalReceipt()).forEach { model ->
                val all =
                    ReceiptContent
                        .receipt(model, strings)
                        .lines
                        .joinToString("\n")
                        .lowercase()
                banned.forEach { word -> assertFalse("'$word' in $all", all.contains(word)) }
            }
        }
    }
}
