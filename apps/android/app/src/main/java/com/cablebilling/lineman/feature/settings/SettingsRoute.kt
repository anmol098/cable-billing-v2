package com.cablebilling.lineman.feature.settings

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.lineman.R
import com.cablebilling.lineman.diagnostics.DiagnosticReport
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import com.cablebilling.designsystem.R as DesignR

/** Navigation route of the settings screen (from the gear on the search home). */
@Serializable
data object SettingsRoute

/** Settings with its ViewModel; "Share app report" opens the phone's share sheet. */
@Composable
fun Settings(
    onBack: () -> Unit,
    onPrinterSetup: () -> Unit,
    onOpenWaiting: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val subject = stringResource(R.string.mobile_settings_diagnostics_subject)
    val chooser = stringResource(R.string.mobile_settings_diagnostics_chooser)
    SettingsContent(
        state = state,
        onBack = onBack,
        onLanguage = viewModel::setLanguage,
        onPrinterSetup = onPrinterSetup,
        onSignOut = viewModel::signOut,
        onConfirmSignOut = viewModel::confirmSignOut,
        onCancelSignOut = viewModel::cancelSignOut,
        onTryNow = viewModel::tryNow,
        onOpenWaiting = onOpenWaiting,
        onShareReport = {
            scope.launch { context.share(DiagnosticReport.shareIntent(viewModel.report(), subject, chooser)) }
        },
    )
}

/**
 * The way into settings: a small gear (56dp tap area, muted), placed at the end of the search home's
 * query row. Settings is low-traffic, so it stays out of the way (PLAN §11.3 "less prominent").
 */
@Composable
fun SettingsButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    IconButton(onClick = onClick, modifier = modifier.size(CableSizes.TouchMin).testTag(SettingsTags.OPEN)) {
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_settings),
            contentDescription = stringResource(R.string.mobile_settings_open),
            tint = Tokens.Color.TextMuted,
            modifier = Modifier.size(CableSizes.Icon),
        )
    }
}

private fun Context.share(intent: Intent) {
    try {
        startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // No app can take text (very unusual phones): nothing to offer.
    }
}
