package com.cablebilling.designsystem.component

import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import com.cablebilling.designsystem.voice.Speaker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Records every haptic the UI asks for. */
class RecordingHaptics : HapticFeedback {
    val events = mutableListOf<HapticFeedbackType>()

    override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
        events += hapticFeedbackType
    }
}

/** A [Speaker] that remembers what it was asked to say (and, like the contract says, is silent when muted). */
class RecordingSpeaker : Speaker {
    private val muted = MutableStateFlow(false)
    val said = mutableListOf<String>()
    var stops = 0

    override val isMuted: StateFlow<Boolean> = muted

    override fun setMuted(muted: Boolean) {
        this.muted.value = muted
    }

    override fun say(text: String) {
        if (!muted.value) said += text
    }

    override fun stop() {
        stops++
    }
}

/** The style a Text node was laid out with (null if the node is not a Text). */
fun SemanticsNode.laidOutTextStyle(): TextStyle? {
    val results = mutableListOf<TextLayoutResult>()
    config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(results)
    return results.firstOrNull()?.layoutInput?.style
}

fun SemanticsNodeInteraction.laidOutTextStyle(): TextStyle = checkNotNull(fetchSemanticsNode().laidOutTextStyle())
