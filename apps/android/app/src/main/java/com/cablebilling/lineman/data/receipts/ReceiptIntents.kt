package com.cablebilling.lineman.data.receipts

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.core.net.toUri
import java.net.URLEncoder

/**
 * The intents that hand a receipt to another app (PLAN §11.7). The app only ever **opens** WhatsApp,
 * the SMS app or the share sheet with the message ready; the lineman presses Send there. Nothing
 * here can know whether a message was sent or delivered (RULE-19), so callers record only
 * `whatsapp_opened` / `sms_opened` / `pdf_shared`.
 *
 * Each builder returns the candidates in the order to try: the first one an installed app accepts
 * is the one that opens (see `ShareLauncher`).
 */
object ReceiptIntents {
    /** WhatsApp, then WhatsApp Business. */
    val WHATSAPP_PACKAGES = listOf("com.whatsapp", "com.whatsapp.w4b")

    /** `sms_body`: the extra SMS apps read the prefilled text from. */
    const val EXTRA_SMS_BODY = "sms_body"

    const val PDF_MIME = "application/pdf"

    /**
     * `https://wa.me/91XXXXXXXXXX?text=…`: opens the customer's chat with [text] typed in. The text
     * is UTF-8 percent-encoded (Hindi included); spaces become `%20`, never `+`, which WhatsApp would
     * show as a plus sign.
     */
    fun whatsAppUrl(
        phone: String,
        text: String,
    ): String = "https://wa.me/${PhoneNumbers.international(phone)}?text=${percentEncode(text)}"

    /** Opens the chat in WhatsApp (or WhatsApp Business) only: never a browser page instead. */
    fun whatsApp(
        phone: String,
        text: String,
    ): List<Intent> {
        val uri = whatsAppUrl(phone, text).toUri()
        return WHATSAPP_PACKAGES.map { pkg -> Intent(Intent.ACTION_VIEW, uri).setPackage(pkg) }
    }

    /** `smsto:<phone>` with [text] prefilled (`ACTION_SENDTO`, so only SMS apps answer). */
    fun sms(
        phone: String,
        text: String,
    ): List<Intent> =
        listOf(
            Intent(Intent.ACTION_SENDTO, "smsto:$phone".toUri()).putExtra(EXTRA_SMS_BODY, text),
        )

    /**
     * The receipt PDF ([pdf] is a `content://` FileProvider uri) for WhatsApp, WhatsApp Business,
     * then the share sheet. Read permission is granted to whichever app takes it.
     */
    fun pdf(
        pdf: Uri,
        text: String?,
        chooserTitle: String,
    ): List<Intent> {
        val direct = WHATSAPP_PACKAGES.map { pkg -> pdfSend(pdf, text).setPackage(pkg) }
        val chooser =
            Intent
                .createChooser(pdfSend(pdf, text), chooserTitle)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return direct + chooser
    }

    private fun pdfSend(
        pdf: Uri,
        text: String?,
    ): Intent =
        Intent(Intent.ACTION_SEND)
            .setType(PDF_MIME)
            .putExtra(Intent.EXTRA_STREAM, pdf)
            .apply {
                if (text != null) putExtra(Intent.EXTRA_TEXT, text)
                // ClipData carries the uri grant through the chooser on API 26+.
                clipData = ClipData.newRawUri(null, pdf)
            }.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

    /** RFC 3986 percent-encoding of UTF-8 bytes (space → `%20`). */
    fun percentEncode(text: String): String =
        URLEncoder
            .encode(text, Charsets.UTF_8.name())
            .replace("+", "%20")
            .replace("*", "%2A")
            .replace("%7E", "~")
}
