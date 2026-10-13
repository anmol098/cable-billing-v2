package com.cablebilling.lineman.printing.render

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import androidx.core.graphics.createBitmap
import androidx.core.graphics.withTranslation
import com.cablebilling.lineman.printing.receipt.ReceiptAlign
import com.cablebilling.lineman.printing.receipt.ReceiptDocument
import com.cablebilling.lineman.printing.receipt.ReceiptLine
import com.cablebilling.lineman.printing.receipt.ReceiptTextStyle
import kotlin.math.ceil
import kotlin.math.max

/**
 * Draws a [ReceiptDocument] black on white with the bundled fonts (PLAN §11.8): Hindi is shaped by
 * Android's text stack and sent to the printer as a picture, so it prints on printers that have no
 * Devanagari font. Text wraps to the width; nothing is cut off.
 *
 * Deterministic: the same document, fonts, metrics and width give the same pixels (no clock, no
 * system fonts, no density or font-scale dependence). [render] gives the bitmap for the printer
 * (`MonoBitmap.from` then `EscPosRasterEncoder`); [draw] draws onto any canvas, e.g. a PDF page
 * (T-069), and returns the height used.
 */
class ReceiptRenderer(
    private val fonts: ReceiptFonts,
    private val metrics: ReceiptMetrics = ReceiptMetrics.Default,
) {
    /** A white [widthDots]-wide ARGB bitmap, as tall as the receipt. */
    fun render(
        document: ReceiptDocument,
        widthDots: Int,
    ): Bitmap {
        require(widthDots > 0) { "width must be positive" }
        val blocks = layout(document, widthDots)
        val height = ceil(totalHeight(blocks)).toInt()
        val bitmap = createBitmap(widthDots, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        drawBlocks(canvas, blocks)
        return bitmap
    }

    /** Draws onto [canvas] (origin top-left, [widthDots] wide) and returns the height used. */
    fun draw(
        canvas: Canvas,
        document: ReceiptDocument,
        widthDots: Int,
    ): Int {
        val blocks = layout(document, widthDots)
        drawBlocks(canvas, blocks)
        return ceil(totalHeight(blocks)).toInt()
    }

    private fun totalHeight(blocks: List<Block>): Float =
        metrics.edge * 2 + blocks.sumOf { it.height.toDouble() }.toFloat() + spacing * max(0, blocks.size - 1)

    private fun drawBlocks(
        canvas: Canvas,
        blocks: List<Block>,
    ) {
        var top = metrics.edge
        blocks.forEach { block ->
            block.draw(canvas, top)
            top += block.height + spacing
        }
    }

    private val spacing: Float get() = metrics.gap / 2

    private fun layout(
        document: ReceiptDocument,
        widthDots: Int,
    ): List<Block> {
        val content = max(1, (widthDots - 2 * metrics.margin).toInt())
        return document.lines.map { line ->
            when (line) {
                is ReceiptLine.Text -> textBlock(line, content)
                is ReceiptLine.Field -> fieldBlock(line, content)
                is ReceiptLine.Amount -> amountBlock(line, content)
                ReceiptLine.Rule -> ruleBlock(widthDots)
            }
        }
    }

    private fun textBlock(
        line: ReceiptLine.Text,
        width: Int,
    ): Block {
        val align =
            if (line.align ==
                ReceiptAlign.Center
            ) {
                Layout.Alignment.ALIGN_CENTER
            } else {
                Layout.Alignment.ALIGN_NORMAL
            }
        val text = staticLayout(line.text, paint(line.style), width, align)
        return Block(text.height.toFloat()) { canvas, top -> text.drawAt(canvas, metrics.margin, top) }
    }

    private fun fieldBlock(
        line: ReceiptLine.Field,
        width: Int,
    ): Block {
        val labelPaint = paint(ReceiptTextStyle.Body)
        val valuePaint = paint(line.valueStyle)
        val labelWidth = ceil(labelPaint.measureText(line.label)).toInt()
        val valueWidth = ceil(valuePaint.measureText(line.value)).toInt()
        val between = ceil(metrics.gap).toInt()
        return if (labelWidth + between + valueWidth <= width) {
            // One line: label on the left, value on the right.
            val label = staticLayout(line.label, labelPaint, labelWidth, Layout.Alignment.ALIGN_NORMAL)
            val valueBox = width - labelWidth - between
            val value = staticLayout(line.value, valuePaint, valueBox, Layout.Alignment.ALIGN_OPPOSITE)
            Block(max(label.height, value.height).toFloat()) { canvas, top ->
                label.drawAt(canvas, metrics.margin, top)
                value.drawAt(canvas, metrics.margin + labelWidth + between, top)
            }
        } else {
            // Too long (a long name): the value goes under its label, right-aligned, wrapping.
            val label = staticLayout(line.label, labelPaint, width, Layout.Alignment.ALIGN_NORMAL)
            val value = staticLayout(line.value, valuePaint, width, Layout.Alignment.ALIGN_OPPOSITE)
            Block((label.height + value.height).toFloat()) { canvas, top ->
                label.drawAt(canvas, metrics.margin, top)
                value.drawAt(canvas, metrics.margin, top + label.height)
            }
        }
    }

    private fun amountBlock(
        line: ReceiptLine.Amount,
        width: Int,
    ): Block {
        val paint = textPaint(fonts.numericStrong, metrics.amount)
        val text = staticLayout(line.text, paint, width, Layout.Alignment.ALIGN_CENTER)
        return Block(text.height.toFloat()) { canvas, top -> text.drawAt(canvas, metrics.margin, top) }
    }

    private fun ruleBlock(widthDots: Int): Block {
        val paint = Paint().apply { color = Color.BLACK }
        return Block(metrics.rule + metrics.gap) { canvas, top ->
            val y = top + metrics.gap / 2
            canvas.drawRect(0f, y, widthDots.toFloat(), y + metrics.rule, paint)
        }
    }

    private fun paint(style: ReceiptTextStyle): TextPaint =
        when (style) {
            ReceiptTextStyle.Small, ReceiptTextStyle.Body -> textPaint(fonts.text, metrics.textSize(style))
            ReceiptTextStyle.Strong, ReceiptTextStyle.Title -> textPaint(fonts.textStrong, metrics.textSize(style))
        }

    private class Block(
        val height: Float,
        val draw: (canvas: Canvas, top: Float) -> Unit,
    )
}

private fun textPaint(
    typeface: Typeface,
    size: Float,
): TextPaint =
    TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        this.typeface = typeface
        textSize = size
        color = Color.BLACK
    }

private fun staticLayout(
    text: String,
    paint: TextPaint,
    width: Int,
    alignment: Layout.Alignment,
): StaticLayout =
    StaticLayout.Builder
        .obtain(text, 0, text.length, paint, max(1, width))
        .setAlignment(alignment)
        .setIncludePad(false)
        // The builder's defaults stay: simple line breaking and no hyphenation (same result on every phone).
        .build()

private fun StaticLayout.drawAt(
    canvas: Canvas,
    left: Float,
    top: Float,
) {
    canvas.withTranslation(left, top) { draw(this) }
}
