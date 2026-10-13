package com.cablebilling.lineman.voice

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.window.Dialog
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.lineman.R
import com.cablebilling.designsystem.R as DesignR

/**
 * One-time prompt when the phone has no Hindi voice (PLAN §11.3): icons first (speaker + download),
 * one short sentence, a big "Download" button that opens the phone's voice download screen, and
 * "Later". Never blocks: back, a tap outside and "Later" all close it, and the app keeps working
 * (in English voice until Hindi is there). [VoiceHost] shows it at most once.
 */
@Composable
fun HindiVoicePrompt(
    onDownload: () -> Unit,
    onLater: () -> Unit,
) {
    Dialog(onDismissRequest = onLater) {
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.background,
            modifier = Modifier.testTag(HindiVoicePromptTags.PROMPT),
        ) {
            Column(
                modifier = Modifier.padding(CableSpacing.S6),
                verticalArrangement = Arrangement.spacedBy(CableSpacing.S4),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S4)) {
                    PromptIcon(DesignR.drawable.ic_cb_speaker)
                    PromptIcon(DesignR.drawable.ic_cb_export)
                }
                Text(
                    text = stringResource(R.string.mobile_voice_hindi_voice_missing),
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onBackground,
                    textAlign = TextAlign.Center,
                )
                BigButton(
                    text = stringResource(R.string.mobile_voice_hindi_voice_download),
                    icon = painterResource(DesignR.drawable.ic_cb_export),
                    onClick = onDownload,
                    modifier = Modifier.fillMaxWidth().testTag(HindiVoicePromptTags.DOWNLOAD),
                )
                BigButton(
                    text = stringResource(R.string.mobile_voice_hindi_voice_later),
                    icon = painterResource(DesignR.drawable.ic_cb_close),
                    onClick = onLater,
                    modifier = Modifier.fillMaxWidth().testTag(HindiVoicePromptTags.LATER),
                    style = BigButtonStyle.Secondary,
                )
            }
        }
    }
}

@Composable
private fun PromptIcon(icon: Int) {
    Icon(
        painter = painterResource(icon),
        contentDescription = null,
        tint = MaterialTheme.colorScheme.onBackground,
        modifier = Modifier.size(CableSizes.IconLarge),
    )
}
