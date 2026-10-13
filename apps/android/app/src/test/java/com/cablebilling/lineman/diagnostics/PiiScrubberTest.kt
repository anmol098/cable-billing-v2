package com.cablebilling.lineman.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** What [PiiScrubber] removes, and what it keeps (codes, counts, status, line numbers). */
class PiiScrubberTest {
    private fun assertGone(
        secret: String,
        text: String,
    ) {
        val out = PiiScrubber.scrub(text)
        assertFalse("'$secret' left in: $out", out.contains(secret))
    }

    @Test
    fun `phone numbers in any shape are removed`() {
        assertGone("9876543210", "call 9876543210 now")
        assertGone("98765", "call +91 98765 43210 now")
        assertGone("43210", "call +91-98765-43210 now")
        assertEquals("tel:[number]", PiiScrubber.scrub("tel:9876543210"))
    }

    @Test
    fun `tokens are removed - bearer, JWT, refresh tokens, ids`() {
        assertGone("abc.def", "Authorization: Bearer abc.def.ghi")
        assertGone("eyJhbGciOiJIUzI1NiJ9", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")
        assertGone("rt_8f3k2j4h5g6f7d8s9a0", "refresh failed for rt_8f3k2j4h5g6f7d8s9a0")
        assertGone("01929a3e-5b10-7c4e-8a01-000000000002", "payment 01929a3e-5b10-7c4e-8a01-000000000002 failed")
    }

    @Test
    fun `values of personal fields are removed, whatever the format`() {
        assertEquals("customer_name=[removed] ok", PiiScrubber.scrub("customer_name=Ramesh ok"))
        assertEquals("{\"name\": [removed]}", PiiScrubber.scrub("{\"name\": \"Ramesh Kumar\"}"))
        assertGone("450", "amount_paise=45000 amount=450")
        assertGone("hunter2", "password: hunter2")
        assertGone("R-2610-00045", "receipt_number=R-2610-00045")
        assertGone("PAYTM", "upi_reference=PAYTM1234")
        assertGone("rt-1", "{\"refresh_token\":\"rt-1\"}")
    }

    @Test
    fun `e-mails, rupee amounts, URL queries and Hindi text are removed`() {
        assertEquals("mail [email]", PiiScrubber.scrub("mail owner@example.com"))
        assertEquals("took [amount] cash", PiiScrubber.scrub("took ₹1,23,456 cash"))
        assertGone("500", "took Rs. 500")
        assertEquals(
            "GET https://app.example/api?[removed]",
            PiiScrubber.scrub("GET https://app.example/api?phone=9876543210&q=ramesh"),
        )
        assertEquals("from [text] ok", PiiScrubber.scrub("from रमेश कुमार ok"))
    }

    @Test
    fun `codes, counts, statuses and stack frames stay readable`() {
        val text = "payment_push status=no_internet sent=3 needs_help=0 http=503"
        assertEquals(text, PiiScrubber.scrub(text))
        val frame = "at com.cablebilling.lineman.data.sync.PaymentSync.run(PaymentSync.kt:123)"
        assertEquals(frame, PiiScrubber.scrub(frame))
        assertEquals(
            "java.net.SocketTimeoutException: timeout",
            PiiScrubber.scrub("java.net.SocketTimeoutException: timeout"),
        )
        assertEquals("", PiiScrubber.scrub(null))
    }
}
