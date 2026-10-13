package com.cablebilling.lineman.feature.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.core.net.toUri
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.lineman.R
import com.cablebilling.designsystem.R as DesignR

/** Test tags of the force-update screen. */
object UpdateTags {
    const val SCREEN = "screen_update"
    const val BUTTON = "update_button"
}

/** The force-update screen with the Play Store as the target (used by SessionGate). */
@Composable
fun UpdateRoute() {
    val context = LocalContext.current
    UpdateScreen(onUpdate = { PlayStore.open(context) })
}

/**
 * Force update (PLAN §11.9): this app version is below the server's `min_app_version_code`. One
 * job, one button: "Update app" opens the Play Store. The sentence says what matters to the
 * lineman: payments saved on the phone are safe and go to the office after the update.
 */
@Composable
fun UpdateScreen(
    onUpdate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(CableSpacing.S4)
                .testTag(UpdateTags.SCREEN),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S6, Alignment.CenterVertically),
    ) {
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_export),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(CableSizes.IconLarge),
        )
        Text(
            text = stringResource(R.string.mobile_login_update_title),
            style = MaterialTheme.typography.headlineLarge,
            textAlign = TextAlign.Center,
        )
        Text(
            text = stringResource(R.string.mobile_login_update_body),
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.size(CableSpacing.S4))
        BigButton(
            text = stringResource(R.string.mobile_login_update_button),
            icon = painterResource(DesignR.drawable.ic_cb_export),
            onClick = onUpdate,
            modifier = Modifier.testTag(UpdateTags.BUTTON),
        )
    }
}

/** Opens this app's Play Store page (the Play Store app, or the web page without it). */
object PlayStore {
    fun intents(packageName: String): List<Intent> =
        listOf(
            Intent(Intent.ACTION_VIEW, "market://details?id=$packageName".toUri()),
            Intent(Intent.ACTION_VIEW, "https://play.google.com/store/apps/details?id=$packageName".toUri()),
        ).onEach { it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }

    fun open(context: Context): Boolean =
        intents(context.packageName).any { intent ->
            try {
                context.startActivity(intent)
                true
            } catch (ignored: ActivityNotFoundException) {
                false
            }
        }
}
