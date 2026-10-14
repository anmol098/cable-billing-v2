package com.cablebilling.lineman.feature.today

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.NumberPad
import com.cablebilling.designsystem.component.NumberPadExtraKey
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.SpeakButton
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.feature.collect.InfoLine
import com.cablebilling.lineman.voice.SpeakOnShow
import com.cablebilling.lineman.voice.spokenText
import com.cablebilling.designsystem.R as DesignR

@Composable
internal fun ProblemLine(problem: HandoverProblem?) {
    val text =
        when (problem) {
            null -> return
            HandoverProblem.NotSaved -> R.string.mobile_today_handover_not_saved
            HandoverProblem.SignedOut -> R.string.mobile_today_handover_signed_out
            HandoverProblem.AlreadyAccepted -> R.string.mobile_today_handover_already_accepted
        }
    InfoLine(
        icon = painterResource(DesignR.drawable.ic_cb_danger),
        tint = CableTheme.semanticColors.danger,
        text = stringResource(text),
        modifier = Modifier.padding(horizontal = CableSpacing.S4).testTag(TodayTags.PROBLEM),
    )
}

@Composable
internal fun BackRow(
    onBack: () -> Unit,
    end: @Composable () -> Unit = {},
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = CableSpacing.S2, vertical = CableSpacing.S2),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack, modifier = Modifier.heightIn(min = CableSizes.TouchMin).testTag(TodayTags.BACK)) {
            Icon(
                painter = painterResource(DesignR.drawable.ic_cb_back),
                contentDescription = null,
                modifier = Modifier.size(CableSizes.Icon),
            )
            Spacer(Modifier.size(CableSpacing.S2))
            Text(text = stringResource(R.string.common_back), style = MaterialTheme.typography.labelLarge)
        }
        end()
    }
}
