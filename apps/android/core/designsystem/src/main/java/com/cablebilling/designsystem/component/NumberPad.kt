package com.cablebilling.designsystem.component

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme

/** A key press on the [NumberPad]. */
sealed interface NumberPadKey {
    /** 0–9. */
    data class Digit(
        val value: Int,
    ) : NumberPadKey {
        init {
            require(value in 0..MAX_DIGIT) { "not a digit: $value" }
        }
    }

    /** "00" (amount entry). */
    data object DoubleZero : NumberPadKey

    /** ⌫: remove the last digit. */
    data object Backspace : NumberPadKey

    /** Long press on ⌫: remove everything. */
    data object Clear : NumberPadKey

    /** "ABC": switch to the system keyboard for a name search (PLAN §11.3 Search). */
    data object Letters : NumberPadKey

    private companion object {
        const val MAX_DIGIT = 9
    }
}

/** The key left of 0 on the bottom row. */
sealed interface NumberPadExtraKey {
    /** "00": for amounts. */
    data object DoubleZero : NumberPadExtraKey

    /** "ABC" with this label (`R.string.mobile_designsystem_numpad_letters`): for search. */
    data class Letters(
        val label: String,
    ) : NumberPadExtraKey

    /** An empty space. */
    data object None : NumberPadExtraKey
}

/** Test tags of the [NumberPad] keys: `numpad_key_0` … `numpad_key_9`, `numpad_key_00`, … */
object NumberPadTags {
    const val DOUBLE_ZERO = "numpad_key_00"
    const val BACKSPACE = "numpad_key_backspace"
    const val LETTERS = "numpad_key_letters"

    fun digit(value: Int): String = "numpad_key_$value"
}

/**
 * Applies a key to the digits typed so far and returns the new digits. [NumberPadKey.Letters]
 * changes nothing (the screen switches keyboards). Typing stops at [maxLength] digits.
 *
 * @param trimLeadingZeros `true` for amounts ("0" then "5" gives "5", "00" on nothing gives
 *   nothing); `false` for search, where a phone number may start with 0.
 */
fun NumberPadKey.applyTo(
    digits: String,
    maxLength: Int = Int.MAX_VALUE,
    trimLeadingZeros: Boolean = false,
): String {
    val next =
        when (this) {
            is NumberPadKey.Digit -> digits + value
            NumberPadKey.DoubleZero -> digits + "00"
            NumberPadKey.Backspace -> digits.dropLast(1)
            NumberPadKey.Clear -> ""
            NumberPadKey.Letters -> digits
        }
    val trimmed = if (trimLeadingZeros) next.trimStart('0') else next
    return if (trimmed.length > maxLength) digits else trimmed
}

/**
 * The big on-screen number pad (PLAN §11.3: Search home and Amount): 1–9 in three rows, then
 * [extraKey], 0 and ⌫. Every key is [CableSizes.NumberPadKey] (64dp) tall and gives haptic
 * feedback (a keyboard tap; a long press on ⌫ sends [NumberPadKey.Clear]).
 *
 * The pad holds no text: keep the digits in your state and update them with [NumberPadKey.applyTo].
 *
 * @param deleteLabel spoken name of ⌫ (`R.string.mobile_designsystem_numpad_delete`).
 */
@Composable
fun NumberPad(
    onKey: (NumberPadKey) -> Unit,
    deleteLabel: String,
    modifier: Modifier = Modifier,
    extraKey: NumberPadExtraKey = NumberPadExtraKey.DoubleZero,
    enabled: Boolean = true,
) {
    val haptics = LocalHapticFeedback.current
    val press: (NumberPadKey) -> Unit = { key ->
        val type = if (key == NumberPadKey.Clear) HapticFeedbackType.LongPress else HapticFeedbackType.KeyboardTap
        haptics.performHapticFeedback(type)
        onKey(key)
    }
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
    ) {
        DIGIT_ROWS.forEach { row ->
            KeyRow {
                row.forEach { value -> DigitKey(value, enabled, press) }
            }
        }
        KeyRow {
            when (extraKey) {
                NumberPadExtraKey.DoubleZero -> {
                    PadKey(NumberPadTags.DOUBLE_ZERO, enabled, onClick = { press(NumberPadKey.DoubleZero) }) {
                        Text(text = "00", style = CableTheme.numericTypography.key)
                    }
                }

                is NumberPadExtraKey.Letters -> {
                    PadKey(NumberPadTags.LETTERS, enabled, onClick = { press(NumberPadKey.Letters) }) {
                        Text(text = extraKey.label, style = MaterialTheme.typography.titleMedium)
                    }
                }

                NumberPadExtraKey.None -> {
                    Spacer(Modifier.weight(1f))
                }
            }
            DigitKey(0, enabled, press)
            PadKey(
                tag = NumberPadTags.BACKSPACE,
                enabled = enabled,
                onClick = { press(NumberPadKey.Backspace) },
                onLongClick = { press(NumberPadKey.Clear) },
                description = deleteLabel,
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_cb_backspace),
                    contentDescription = null,
                    modifier = Modifier.size(CableSizes.IconLarge),
                )
            }
        }
    }
}

private val DIGIT_ROWS = listOf(listOf(1, 2, 3), listOf(4, 5, 6), listOf(7, 8, 9))

@Composable
private fun KeyRow(content: @Composable RowScope.() -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
        content = content,
    )
}

@Composable
private fun RowScope.DigitKey(
    value: Int,
    enabled: Boolean,
    press: (NumberPadKey) -> Unit,
) {
    PadKey(NumberPadTags.digit(value), enabled, onClick = { press(NumberPadKey.Digit(value)) }) {
        Text(text = value.toString(), style = CableTheme.numericTypography.key)
    }
}

@Composable
private fun RowScope.PadKey(
    tag: String,
    enabled: Boolean,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    description: String? = null,
    content: @Composable () -> Unit,
) {
    val shape = MaterialTheme.shapes.medium
    Box(
        modifier =
            Modifier
                .weight(1f)
                .heightIn(min = CableSizes.NumberPadKey)
                .clip(shape)
                .background(Tokens.Color.Surface, shape)
                .border(Tokens.Border.Hairline, Tokens.Color.Border, shape)
                .combinedClickable(
                    enabled = enabled,
                    role = Role.Button,
                    // The pad gives its own feedback (press) so every key feels the same.
                    hapticFeedbackEnabled = false,
                    onLongClick = onLongClick,
                    onClick = onClick,
                ).then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)
                .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        val color = if (enabled) Tokens.Color.Text else Tokens.Color.TextMuted
        CompositionLocalProvider(LocalContentColor provides color, content = content)
    }
}
