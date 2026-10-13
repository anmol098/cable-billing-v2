package com.cablebilling.lineman.printing.receipt

/**
 * A receipt as a list of lines, before any drawing. The thermal renderer draws it on a 384-dot
 * bitmap; T-069 can draw the same lines into a PDF page. Built by [ReceiptContent].
 */
data class ReceiptDocument(
    val lines: List<ReceiptLine>,
)

/** One block of a [ReceiptDocument]. Text wraps to the paper width. */
sealed interface ReceiptLine {
    /** Running text. */
    data class Text(
        val text: String,
        val style: ReceiptTextStyle = ReceiptTextStyle.Body,
        val align: ReceiptAlign = ReceiptAlign.Start,
    ) : ReceiptLine

    /** "Label ........ value" on one line; the value moves under the label when it does not fit. */
    data class Field(
        val label: String,
        val value: String,
        val valueStyle: ReceiptTextStyle = ReceiptTextStyle.Strong,
    ) : ReceiptLine

    /** The amount, large and centred, in the numeric font (`₹1,23,456`). */
    data class Amount(
        val text: String,
    ) : ReceiptLine

    /** A full-width line between sections. */
    data object Rule : ReceiptLine
}

enum class ReceiptTextStyle {
    /** Small print: notes, the footer. */
    Small,

    /** Normal text. */
    Body,

    /** Bold normal-size text: values, the method. */
    Strong,

    /** The operator's name at the top. */
    Title,
}

enum class ReceiptAlign { Start, Center }
