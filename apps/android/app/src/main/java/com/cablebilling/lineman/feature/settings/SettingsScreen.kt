package com.cablebilling.lineman.feature.settings

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.VoiceToggle
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.feature.collect.InfoLine
import com.cablebilling.lineman.locale.AppLanguage
import com.cablebilling.designsystem.R as DesignR

/**
 * Settings without its ViewModel (PLAN §11.3): language हिंदी / English, voice on/off, printer, sign
 * out (with the explanation when payments are still on the phone), app version and "Share app report".
 * Opened from the small gear on the search home: low-traffic, out of the lineman's way.
 */
@Composable
fun SettingsContent(
    state: SettingsUiState,
    onBack: () -> Unit,
    onLanguage: (String) -> Unit,
    onPrinterSetup: () -> Unit,
    onSignOut: () -> Unit,
    onConfirmSignOut: () -> Unit,
    onCancelSignOut: () -> Unit,
    onTryNow: () -> Unit,
    onOpenWaiting: () -> Unit,
    onShareReport: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(CableSpacing.S4)
                .testTag(SettingsTags.SCREEN),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S4),
    ) {
        Header(onBack)
        Section(DesignR.drawable.ic_cb_language, stringResource(R.string.mobile_settings_language)) {
            Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
                LanguageButton(
                    // Each language is always written in its own script, so it can be found from the other one.
                    text = stringResource(R.string.common_language_hindi),
                    selected = state.language == AppLanguage.HINDI,
                    onClick = { onLanguage(AppLanguage.HINDI) },
                    modifier = Modifier.weight(1f).testTag(SettingsTags.LANGUAGE_HINDI),
                )
                LanguageButton(
                    text = stringResource(R.string.common_language_english),
                    selected = state.language == AppLanguage.ENGLISH,
                    onClick = { onLanguage(AppLanguage.ENGLISH) },
                    modifier = Modifier.weight(1f).testTag(SettingsTags.LANGUAGE_ENGLISH),
                )
            }
        }
        Section(DesignR.drawable.ic_cb_speaker, stringResource(R.string.mobile_settings_voice)) {
            VoiceToggle(
                onLabel = stringResource(R.string.mobile_designsystem_voice_on),
                offLabel = stringResource(R.string.mobile_designsystem_voice_off),
                modifier = Modifier.testTag(SettingsTags.VOICE),
            )
        }
        Section(DesignR.drawable.ic_cb_print, stringResource(R.string.mobile_settings_printer_title)) {
            Text(
                text = state.printerName ?: stringResource(R.string.mobile_settings_printer_none),
                style = MaterialTheme.typography.bodyLarge,
                color = if (state.printerName == null) Tokens.Color.TextMuted else Tokens.Color.Text,
                modifier = Modifier.testTag(SettingsTags.PRINTER_NAME),
            )
            BigButton(
                text = stringResource(R.string.mobile_settings_printer_set_up),
                icon = painterResource(DesignR.drawable.ic_cb_print),
                onClick = onPrinterSetup,
                style = BigButtonStyle.Secondary,
                modifier = Modifier.testTag(SettingsTags.PRINTER_SET_UP),
            )
        }
        Section(DesignR.drawable.ic_cb_logout, stringResource(R.string.mobile_settings_sign_out_button)) {
            state.userName?.let { name ->
                Text(
                    text = stringResource(R.string.mobile_settings_account_signed_in, name),
                    style = MaterialTheme.typography.bodyLarge,
                    color = Tokens.Color.Text,
                    modifier = Modifier.testTag(SettingsTags.SIGNED_IN),
                )
            }
            SignOut(state, onSignOut, onConfirmSignOut, onCancelSignOut, onTryNow, onOpenWaiting)
        }
        Section(DesignR.drawable.ic_cb_share, stringResource(R.string.mobile_settings_diagnostics_title)) {
            Text(
                text = stringResource(R.string.mobile_settings_diagnostics_explain),
                style = MaterialTheme.typography.bodyLarge,
                color = Tokens.Color.TextMuted,
            )
            BigButton(
                text = stringResource(R.string.mobile_settings_diagnostics_share),
                icon = painterResource(DesignR.drawable.ic_cb_share),
                onClick = onShareReport,
                style = BigButtonStyle.Secondary,
                modifier = Modifier.testTag(SettingsTags.SHARE_REPORT),
            )
        }
        Text(
            text = stringResource(R.string.mobile_settings_version, state.version),
            style = CableTheme.numericTypography.body,
            color = Tokens.Color.TextMuted,
            modifier = Modifier.testTag(SettingsTags.VERSION),
        )
    }
}

@Composable
private fun SignOut(
    state: SettingsUiState,
    onSignOut: () -> Unit,
    onConfirmSignOut: () -> Unit,
    onCancelSignOut: () -> Unit,
    onTryNow: () -> Unit,
    onOpenWaiting: () -> Unit,
) {
    when (state.signOut) {
        SignOutStep.Confirm -> {
            Card(Modifier.testTag(SettingsTags.CONFIRM)) {
                Text(
                    text = stringResource(R.string.mobile_settings_sign_out_confirm_title),
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    text = stringResource(R.string.mobile_settings_sign_out_confirm_body),
                    style = MaterialTheme.typography.bodyLarge,
                )
                BigButton(
                    text = stringResource(R.string.mobile_settings_sign_out_confirm_yes),
                    icon = painterResource(DesignR.drawable.ic_cb_logout),
                    onClick = onConfirmSignOut,
                    modifier = Modifier.testTag(SettingsTags.CONFIRM_YES),
                )
                BigButton(
                    text = stringResource(R.string.common_cancel),
                    icon = painterResource(DesignR.drawable.ic_cb_close),
                    onClick = onCancelSignOut,
                    style = BigButtonStyle.Secondary,
                    modifier = Modifier.testTag(SettingsTags.CONFIRM_CANCEL),
                )
            }
        }

        SignOutStep.Blocked -> {
            if (state.waiting >
                0
            ) {
                Blocked(state.waiting, onTryNow, onOpenWaiting, onCancelSignOut)
            } else {
                NowPossible(onSignOut)
            }
        }

        SignOutStep.Idle, SignOutStep.Checking, SignOutStep.SigningOut -> {
            SignOutButton(enabled = state.signOut == SignOutStep.Idle, onClick = onSignOut)
        }
    }
}

/** This lineman's payments are still on the phone: why sign-out waits, and what to do about it. */
@Composable
private fun Blocked(
    waiting: Int,
    onTryNow: () -> Unit,
    onOpenWaiting: () -> Unit,
    onCancel: () -> Unit,
) {
    Card(Modifier.testTag(SettingsTags.BLOCKED)) {
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_danger),
            tint = CableTheme.semanticColors.danger,
            text = stringResource(R.string.mobile_settings_sign_out_blocked_title),
        )
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_pending),
            tint = CableTheme.semanticColors.pending,
            text = pluralStringResource(R.plurals.mobile_settings_sign_out_blocked_count, waiting, waiting),
        )
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_success),
            tint = CableTheme.semanticColors.success,
            text = stringResource(R.string.mobile_settings_sign_out_blocked_safe),
        )
        BigButton(
            text = stringResource(R.string.mobile_settings_sign_out_try_now),
            icon = painterResource(DesignR.drawable.ic_cb_next),
            onClick = onTryNow,
            modifier = Modifier.testTag(SettingsTags.TRY_NOW),
        )
        BigButton(
            text = stringResource(R.string.mobile_settings_sign_out_open_waiting),
            icon = painterResource(DesignR.drawable.ic_cb_waiting),
            onClick = onOpenWaiting,
            style = BigButtonStyle.Secondary,
            modifier = Modifier.testTag(SettingsTags.OPEN_WAITING),
        )
        BigButton(
            text = stringResource(R.string.common_cancel),
            icon = painterResource(DesignR.drawable.ic_cb_close),
            onClick = onCancel,
            style = BigButtonStyle.Secondary,
            modifier = Modifier.testTag(SettingsTags.CONFIRM_CANCEL),
        )
    }
}

/** The payments reached the office while the explanation was showing: sign-out is possible now. */
@Composable
private fun NowPossible(onSignOut: () -> Unit) {
    InfoLine(
        icon = painterResource(DesignR.drawable.ic_cb_success),
        tint = CableTheme.semanticColors.success,
        text = stringResource(R.string.mobile_settings_sign_out_now_possible),
        modifier = Modifier.testTag(SettingsTags.NOW_POSSIBLE),
    )
    SignOutButton(enabled = true, onClick = onSignOut)
}

@Composable
private fun SignOutButton(
    enabled: Boolean,
    onClick: () -> Unit,
) {
    BigButton(
        text = stringResource(R.string.mobile_settings_sign_out_button),
        icon = painterResource(DesignR.drawable.ic_cb_logout),
        onClick = onClick,
        enabled = enabled,
        style = BigButtonStyle.Secondary,
        modifier = Modifier.testTag(SettingsTags.SIGN_OUT),
    )
}

@Composable
private fun LanguageButton(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BigButton(
        text = text,
        icon = painterResource(if (selected) DesignR.drawable.ic_cb_success else DesignR.drawable.ic_cb_language),
        onClick = onClick,
        style = if (selected) BigButtonStyle.Primary else BigButtonStyle.Secondary,
        modifier =
            modifier.semantics {
                this.selected = selected
                role = Role.RadioButton
            },
    )
}

@Composable
private fun Header(onBack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack, modifier = Modifier.size(CableSizes.TouchMin).testTag(SettingsTags.BACK)) {
            Icon(
                painter = painterResource(DesignR.drawable.ic_cb_back),
                contentDescription = stringResource(R.string.common_back),
                modifier = Modifier.size(CableSizes.Icon),
            )
        }
        Spacer(Modifier.width(CableSpacing.S2))
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_settings),
            contentDescription = null,
            modifier = Modifier.size(CableSizes.IconLarge),
        )
        Spacer(Modifier.width(CableSpacing.S3))
        Text(text = stringResource(R.string.mobile_settings_title), style = MaterialTheme.typography.headlineLarge)
    }
}

/** An icon + a short heading, then the section's content (PLAN §2.2 rule 3: never words alone). */
@Composable
private fun Section(
    @DrawableRes icon: Int,
    title: String,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(CableSpacing.S2)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(painter = painterResource(icon), contentDescription = null, modifier = Modifier.size(CableSizes.Icon))
            Spacer(Modifier.width(CableSpacing.S2))
            Text(text = title, style = MaterialTheme.typography.titleMedium, color = Tokens.Color.Text)
        }
        content()
    }
}

@Composable
private fun Card(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val shape = MaterialTheme.shapes.large
    Column(
        modifier =
            modifier
                .fillMaxWidth()
                .background(Tokens.Color.Surface, shape)
                .border(Tokens.Border.Hairline, Tokens.Color.Border, shape)
                .padding(CableSpacing.S4),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
    ) {
        content()
    }
}
