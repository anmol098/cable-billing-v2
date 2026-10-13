package com.cablebilling.lineman.catalogue

import android.content.res.Configuration
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.AmountTone
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.ConfirmCard
import com.cablebilling.designsystem.component.CustomerRow
import com.cablebilling.designsystem.component.MethodButton
import com.cablebilling.designsystem.component.NumberPad
import com.cablebilling.designsystem.component.NumberPadExtraKey
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.designsystem.component.PaymentStatus
import com.cablebilling.designsystem.component.ReceiptActionTile
import com.cablebilling.designsystem.component.SpeakButton
import com.cablebilling.designsystem.component.StatusChip
import com.cablebilling.designsystem.component.SyncBanner
import com.cablebilling.designsystem.component.SyncState
import com.cablebilling.designsystem.component.VoiceToggle
import com.cablebilling.designsystem.component.applyTo
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import java.util.Locale
import com.cablebilling.designsystem.R as DesignR

// One function per catalogue section (see ComponentCatalogue), with sample data.

/** Amounts on the Amount screen stay below ₹1 crore in the catalogue (feature screens pick their own). */
private const val AMOUNT_MAX_DIGITS = 7

private const val SAMPLE_DUE_PAISE = 45_000L
private const val SAMPLE_BIG_PAISE = 12_345_600L
private const val SAMPLE_CREDIT_PAISE = -20_000L
private const val SAMPLE_WAITING_COUNT = 3

@Composable
internal fun Buttons() {
    Section("BigButton") {
        BigButton(
            text = stringResource(R.string.common_collect),
            icon = painterResource(DesignR.drawable.ic_cb_collect),
            onClick = {},
        )
        BigButton(
            text = stringResource(R.string.common_save),
            icon = painterResource(DesignR.drawable.ic_cb_success),
            onClick = {},
            style = BigButtonStyle.Success,
        )
        BigButton(
            text = stringResource(R.string.common_back),
            icon = painterResource(DesignR.drawable.ic_cb_back),
            onClick = {},
            style = BigButtonStyle.Secondary,
        )
        BigButton(
            text = stringResource(R.string.common_save),
            icon = painterResource(DesignR.drawable.ic_cb_success),
            onClick = {},
            enabled = false,
        )
    }
    Section("MethodButton") {
        Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
            MethodButton(
                method = PaymentMethod.Cash,
                text = stringResource(R.string.common_cash),
                onClick = {},
                modifier = Modifier.weight(1f),
            )
            MethodButton(
                method = PaymentMethod.Upi,
                text = stringResource(R.string.common_upi),
                onClick = {},
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
internal fun Amounts() {
    Section("AmountDisplay") {
        AmountDisplay(amountPaise = SAMPLE_BIG_PAISE)
        AmountDisplay(
            amountPaise = SAMPLE_DUE_PAISE,
            tone = AmountTone.Balance,
            dueLabel = stringResource(R.string.common_due),
        )
        AmountDisplay(
            amountPaise = SAMPLE_CREDIT_PAISE,
            tone = AmountTone.Balance,
            creditLabel = stringResource(R.string.common_credit),
        )
    }
}

@Composable
internal fun NumberPads() {
    Section("NumberPad") {
        var amountDigits by rememberSaveable { mutableStateOf("") }
        Column(
            modifier = Modifier.testTag(CatalogueTags.AMOUNT_ENTRY),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
        ) {
            AmountDisplay(amountPaise = Rupees.digitsToPaise(amountDigits) ?: 0L)
            NumberPad(
                onKey = { key ->
                    amountDigits = key.applyTo(amountDigits, maxLength = AMOUNT_MAX_DIGITS, trimLeadingZeros = true)
                },
                deleteLabel = stringResource(R.string.mobile_designsystem_numpad_delete),
            )
        }
        var searchDigits by rememberSaveable { mutableStateOf("") }
        Column(
            modifier = Modifier.testTag(CatalogueTags.SEARCH_ENTRY),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
        ) {
            Text(
                text = searchDigits,
                style = CableTheme.numericTypography.key,
                modifier = Modifier.testTag(CatalogueTags.SEARCH_DIGITS),
            )
            NumberPad(
                onKey = { key -> searchDigits = key.applyTo(searchDigits) },
                deleteLabel = stringResource(R.string.mobile_designsystem_numpad_delete),
                extraKey = NumberPadExtraKey.Letters(stringResource(R.string.mobile_designsystem_numpad_letters)),
            )
        }
    }
}

@Composable
internal fun States() {
    Section("StatusChip") {
        StatusChip(PaymentStatus.SavedOnPhone, stringResource(R.string.common_saved_on_phone))
        StatusChip(PaymentStatus.Sent, stringResource(R.string.common_sent_to_office))
        StatusChip(PaymentStatus.NeedsHelp, stringResource(R.string.common_problem))
    }
    Section("SyncBanner") {
        SyncBanner(SyncState.Updated, stringResource(R.string.mobile_designsystem_catalogue_sample_updated))
        SyncBanner(
            state = SyncState.Waiting,
            text =
                pluralStringResource(
                    R.plurals.mobile_designsystem_catalogue_sample_on_phone,
                    SAMPLE_WAITING_COUNT,
                    SAMPLE_WAITING_COUNT,
                ),
            onClick = {},
        )
        SyncBanner(SyncState.Problem, stringResource(R.string.common_no_internet))
    }
}

@Composable
internal fun Rows() {
    Section("CustomerRow") {
        val name = stringResource(R.string.mobile_designsystem_catalogue_sample_customer_name)
        val area = stringResource(R.string.mobile_designsystem_catalogue_sample_area)
        val due = stringResource(R.string.common_due)
        val credit = stringResource(R.string.common_credit)
        Column {
            CustomerRow(
                name = name,
                code = "C-0042",
                balancePaise = SAMPLE_DUE_PAISE,
                onClick = {},
                area = area,
                dueLabel = due,
                creditLabel = credit,
            )
            CustomerRow(
                name = name,
                code = "C-0043",
                balancePaise = SAMPLE_CREDIT_PAISE,
                onClick = {},
                area = area,
                dueLabel = due,
                creditLabel = credit,
            )
            CustomerRow(name = name, code = "C-0044", balancePaise = 0L, onClick = {}, area = area)
        }
    }
}

@Composable
internal fun Confirm() {
    Section("ConfirmCard") {
        ConfirmCard(
            customerName = stringResource(R.string.mobile_designsystem_catalogue_sample_customer_name),
            amountPaise = SAMPLE_DUE_PAISE,
            method = PaymentMethod.Cash,
            methodLabel = stringResource(R.string.common_cash),
        )
    }
}

@Composable
internal fun ReceiptActions() {
    Section("ReceiptActionTile") {
        Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
            ReceiptActionTile(
                text = stringResource(R.string.common_print),
                icon = painterResource(DesignR.drawable.ic_cb_print),
                onClick = {},
                modifier = Modifier.weight(1f),
            )
            ReceiptActionTile(
                text = stringResource(R.string.mobile_designsystem_catalogue_sample_whatsapp),
                icon = painterResource(DesignR.drawable.ic_cb_whatsapp),
                onClick = {},
                modifier = Modifier.weight(1f),
                stateText = stringResource(R.string.common_whatsapp_opened),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
            ReceiptActionTile(
                text = stringResource(R.string.mobile_designsystem_catalogue_sample_sms),
                icon = painterResource(DesignR.drawable.ic_cb_sms),
                onClick = {},
                modifier = Modifier.weight(1f),
            )
            ReceiptActionTile(
                text = stringResource(R.string.common_done),
                icon = painterResource(DesignR.drawable.ic_cb_success),
                onClick = {},
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
internal fun Voice() {
    Section("SpeakButton") {
        Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
            SpeakButton(
                text = stringResource(R.string.mobile_designsystem_catalogue_sample_speech),
                label = stringResource(R.string.mobile_designsystem_speak),
            )
            VoiceToggle(
                onLabel = stringResource(R.string.mobile_designsystem_voice_on),
                offLabel = stringResource(R.string.mobile_designsystem_voice_off),
            )
        }
    }
}
