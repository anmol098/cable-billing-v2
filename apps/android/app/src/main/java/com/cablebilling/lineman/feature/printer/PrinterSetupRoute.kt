package com.cablebilling.lineman.feature.printer

import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.lineman.printing.bluetooth.PrinterPermissions
import kotlinx.serialization.Serializable

/** Navigation route of printer setup: `navController.navigate(PrinterSetupRoute)` (settings T-071, receipt T-069). */
@Serializable
data object PrinterSetupRoute

/** Printer setup with its ViewModel, the permission prompt and the "turn on Bluetooth" prompt. */
@Composable
fun PrinterSetup(
    onBack: () -> Unit,
    viewModel: PrinterSetupViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val activity = LocalActivity.current
    val askPermissions =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { answers ->
            val granted = answers.isNotEmpty() && answers.values.all { it }
            viewModel.onPermissionResult(granted = granted, canAskAgain = activity.canAskAgain(answers.keys))
        }
    val turnOnBluetooth =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { viewModel.refresh() }
    // Back from the system settings or the Bluetooth switch: look again.
    LifecycleResumeEffect(viewModel) {
        viewModel.refresh()
        onPauseOrDispose {}
    }
    PrinterSetupScreen(
        state = state,
        onBack = onBack,
        onAllow = { askPermissions.launch(PrinterPermissions.forFinding().toTypedArray()) },
        onOpenSettings = { context.openAppSettings() },
        onTurnOnBluetooth = {
            try {
                turnOnBluetooth.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
            } catch (_: ActivityNotFoundException) {
                viewModel.refresh()
            } catch (_: SecurityException) {
                viewModel.refresh()
            }
        },
        onFind = viewModel::find,
        onCancelFind = viewModel::dismissFindExplainer,
        onChoose = viewModel::choose,
        onPair = viewModel::pairAndChoose,
        onTestPrint = viewModel::testPrint,
    )
}

/** True unless Android will no longer show the prompt for any of [permissions]. */
private fun Activity?.canAskAgain(permissions: Collection<String>): Boolean =
    this == null || permissions.any { shouldShowRequestPermissionRationale(it) }

private fun Context.openAppSettings() {
    val intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // No settings screen (very unusual phones): nothing else to offer.
    }
}
