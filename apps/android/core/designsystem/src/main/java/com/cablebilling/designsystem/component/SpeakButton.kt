package com.cablebilling.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.Speaker

/**
 * Replays a read-out (PLAN §11.3 Customer: "Speaker button to replay"): speaker icon + word
 * ("सुनें / Listen"), [CableSizes.TouchMin] tall. While voice is off it shows the muted icon, and a
 * tap switches voice back on and speaks, so one tap always gives sound.
 *
 * @param text what to say, already phrased in the app language.
 * @param label the button's word (`R.string.mobile_designsystem_speak`).
 */
@Composable
fun SpeakButton(
    text: String,
    label: String,
    modifier: Modifier = Modifier,
    speaker: Speaker = LocalSpeaker.current,
) {
    val muted by speaker.isMuted.collectAsState()
    VoicePill(
        icon = if (muted) R.drawable.ic_cb_mute else R.drawable.ic_cb_speaker,
        label = label,
        modifier = modifier,
        interaction =
            Modifier.clickable(role = Role.Button) {
                if (speaker.isMuted.value) speaker.setMuted(false)
                speaker.say(text)
            },
    )
}

/**
 * The always-visible voice on/off switch (PLAN §11.3: "A mute toggle is always visible"). Shows the
 * current state as icon + word and flips [Speaker.setMuted] on tap.
 *
 * @param onLabel "आवाज़ चालू / Voice on" (`mobile_designsystem_voice_on`).
 * @param offLabel "आवाज़ बंद / Voice off" (`mobile_designsystem_voice_off`).
 */
@Composable
fun VoiceToggle(
    onLabel: String,
    offLabel: String,
    modifier: Modifier = Modifier,
    speaker: Speaker = LocalSpeaker.current,
) {
    val muted by speaker.isMuted.collectAsState()
    VoicePill(
        icon = if (muted) R.drawable.ic_cb_mute else R.drawable.ic_cb_speaker,
        label = if (muted) offLabel else onLabel,
        modifier = modifier,
        interaction =
            Modifier.toggleable(value = !muted, role = Role.Switch) { on ->
                if (!on) speaker.stop()
                speaker.setMuted(!on)
            },
    )
}

@Composable
private fun VoicePill(
    @DrawableRes icon: Int,
    label: String,
    modifier: Modifier,
    interaction: Modifier,
) {
    val shape = RoundedCornerShape(Tokens.Radius.Full)
    Row(
        modifier =
            modifier
                .heightIn(min = CableSizes.TouchMin)
                .clip(shape)
                .border(Tokens.Border.Strong, Tokens.Color.Border, shape)
                .then(interaction)
                .padding(horizontal = CableSpacing.S4),
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = null,
            tint = Tokens.Color.Text,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Text(text = label, style = MaterialTheme.typography.labelLarge, color = Tokens.Color.Text)
    }
}
