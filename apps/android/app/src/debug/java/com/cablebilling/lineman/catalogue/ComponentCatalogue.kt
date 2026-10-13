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

private const val HINDI = "hi"
private const val ENGLISH = "en"

/**
 * Every design-system component with real strings, in Hindi or English (switch at the top). The
 * section headings are the component names from code, so they are not translated.
 */
@Composable
fun ComponentCatalogue(initialLanguage: String = HINDI) {
    var language by rememberSaveable { mutableStateOf(initialLanguage) }
    ProvideLanguage(language) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .safeDrawingPadding()
                        .verticalScroll(rememberScrollState())
                        .padding(CableSpacing.S4)
                        .testTag(CatalogueTags.ROOT),
                verticalArrangement = Arrangement.spacedBy(CableSpacing.S6),
            ) {
                Text(
                    text = stringResource(R.string.mobile_designsystem_catalogue_title),
                    style = MaterialTheme.typography.headlineLarge,
                )
                LanguageSwitch(language = language, onSelect = { language = it })
                Buttons()
                Amounts()
                NumberPads()
                States()
                Rows()
                Confirm()
                ReceiptActions()
                Voice()
            }
        }
    }
}

@Composable
private fun LanguageSwitch(
    language: String,
    onSelect: (String) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2)) {
        val languages = listOf(HINDI to R.string.common_language_hindi, ENGLISH to R.string.common_language_english)
        languages.forEach { (code, label) ->
            BigButton(
                text = stringResource(label),
                icon = painterResource(DesignR.drawable.ic_cb_language),
                onClick = { onSelect(code) },
                style = if (code == language) BigButtonStyle.Primary else BigButtonStyle.Secondary,
                modifier = Modifier.weight(1f).testTag(CatalogueTags.language(code)),
            )
        }
    }
}

@Composable
internal fun Section(
    name: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().testTag(CatalogueTags.section(name)),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
    ) {
        Text(text = name, style = MaterialTheme.typography.titleLarge, color = Tokens.Color.TextMuted)
        HorizontalDivider(thickness = Tokens.Border.Hairline, color = Tokens.Color.Border)
        content()
    }
}
