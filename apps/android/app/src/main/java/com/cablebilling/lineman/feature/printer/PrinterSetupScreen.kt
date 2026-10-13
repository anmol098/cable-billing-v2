package com.cablebilling.lineman.feature.printer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.printing.bluetooth.PrinterDevice
import com.cablebilling.lineman.printing.bluetooth.PrinterPermissions
import com.cablebilling.designsystem.R as DesignR

/**
 * Printer setup (PLAN §11.8), one job at a time: explain and ask for Bluetooth permission (icons
 * first), ask to switch Bluetooth on, then pick a paired printer or find and pair a new one; picking
 * prints a test page. The chosen printer is remembered.
 */
@Composable
fun PrinterSetupScreen(
    state: PrinterSetupUiState,
    onBack: () -> Unit,
    onAllow: () -> Unit,
    onOpenSettings: () -> Unit,
    onTurnOnBluetooth: () -> Unit,
    onFind: () -> Unit,
    onCancelFind: () -> Unit,
    onChoose: (PrinterDevice) -> Unit,
    onPair: (PrinterDevice) -> Unit,
    onTestPrint: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(CableSpacing.S4)
                .testTag(PrinterSetupTags.SCREEN),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S4),
    ) {
        Header(onBack)
        when (state.step) {
            PrinterSetupStep.NoBluetooth -> {
                Notice(
                    icon = DesignR.drawable.ic_cb_bluetooth,
                    text = stringResource(R.string.mobile_printer_setup_no_bluetooth),
                    tint = CableTheme.semanticColors.danger,
                    modifier = Modifier.testTag(PrinterSetupTags.NO_BLUETOOTH),
                )
            }

            PrinterSetupStep.NeedsPermission -> {
                PermissionExplainer(
                    icons = listOf(DesignR.drawable.ic_cb_bluetooth, DesignR.drawable.ic_cb_print),
                    text = stringResource(R.string.mobile_printer_setup_permission_explain),
                    blocked = state.permissionBlocked,
                    onAllow = onAllow,
                    onOpenSettings = onOpenSettings,
                    onCancel = null,
                )
            }

            PrinterSetupStep.BluetoothOff -> {
                Notice(
                    icon = DesignR.drawable.ic_cb_bluetooth,
                    text = stringResource(R.string.mobile_printer_setup_bluetooth_off),
                    tint = CableTheme.semanticColors.danger,
                )
                BigButton(
                    text = stringResource(R.string.mobile_printer_setup_turn_on_bluetooth),
                    icon = painterResource(DesignR.drawable.ic_cb_bluetooth),
                    onClick = onTurnOnBluetooth,
                    modifier = Modifier.testTag(PrinterSetupTags.TURN_ON),
                )
            }

            PrinterSetupStep.Choose -> {
                if (state.explainFinding) {
                    val findingNeedsLocation = PrinterPermissions.findingNeedsLocation()
                    val permissionIcon =
                        if (findingNeedsLocation) DesignR.drawable.ic_cb_area else DesignR.drawable.ic_cb_bluetooth
                    PermissionExplainer(
                        icons =
                            listOf(
                                permissionIcon,
                                DesignR.drawable.ic_cb_search,
                                DesignR.drawable.ic_cb_print,
                            ),
                        text =
                            stringResource(
                                if (findingNeedsLocation) {
                                    R.string.mobile_printer_setup_location_explain
                                } else {
                                    R.string.mobile_printer_setup_permission_explain
                                },
                            ),
                        blocked = state.permissionBlocked,
                        onAllow = onAllow,
                        onOpenSettings = onOpenSettings,
                        onCancel = onCancelFind,
                    )
                } else {
                    ChoosePrinter(state, onFind, onChoose, onPair, onTestPrint)
                }
            }
        }
    }
}

@Composable
private fun Header(onBack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(
            onClick = onBack,
            modifier = Modifier.size(CableSizes.TouchMin).testTag(PrinterSetupTags.BACK),
        ) {
            Icon(
                painter = painterResource(DesignR.drawable.ic_cb_back),
                contentDescription = stringResource(R.string.common_back),
                modifier = Modifier.size(CableSizes.Icon),
            )
        }
        Spacer(Modifier.width(CableSpacing.S2))
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_print),
            contentDescription = null,
            modifier = Modifier.size(CableSizes.IconLarge),
        )
        Spacer(Modifier.width(CableSpacing.S3))
        Text(text = stringResource(R.string.mobile_printer_setup_title), style = MaterialTheme.typography.headlineLarge)
    }
}

/** Icons first, one sentence, one big "Allow" button (PLAN §11.8: explainer before each system prompt). */
@Composable
private fun PermissionExplainer(
    icons: List<Int>,
    text: String,
    blocked: Boolean,
    onAllow: () -> Unit,
    onOpenSettings: () -> Unit,
    onCancel: (() -> Unit)?,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S4)) {
        icons.forEach { icon ->
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(CableSizes.IconLarge))
        }
    }
    Text(text = text, style = MaterialTheme.typography.titleMedium)
    if (blocked) {
        Notice(
            icon = DesignR.drawable.ic_cb_danger,
            text = stringResource(R.string.mobile_printer_setup_permission_denied),
            tint = CableTheme.semanticColors.danger,
        )
        BigButton(
            text = stringResource(R.string.mobile_printer_setup_open_settings),
            icon = painterResource(DesignR.drawable.ic_cb_settings),
            onClick = onOpenSettings,
            modifier = Modifier.testTag(PrinterSetupTags.OPEN_SETTINGS),
        )
    }
    BigButton(
        text = stringResource(R.string.mobile_printer_setup_allow),
        icon = painterResource(DesignR.drawable.ic_cb_success),
        onClick = onAllow,
        style = if (blocked) BigButtonStyle.Secondary else BigButtonStyle.Primary,
        modifier = Modifier.testTag(PrinterSetupTags.ALLOW),
    )
    if (onCancel != null) {
        BigButton(
            text = stringResource(R.string.common_back),
            icon = painterResource(DesignR.drawable.ic_cb_back),
            onClick = onCancel,
            style = BigButtonStyle.Secondary,
            modifier = Modifier.testTag(PrinterSetupTags.CANCEL),
        )
    }
}

@Composable
private fun ChoosePrinter(
    state: PrinterSetupUiState,
    onFind: () -> Unit,
    onChoose: (PrinterDevice) -> Unit,
    onPair: (PrinterDevice) -> Unit,
    onTestPrint: () -> Unit,
) {
    val saved = state.saved
    if (saved != null) {
        Column(
            modifier = Modifier.fillMaxWidth().testTag(PrinterSetupTags.SAVED),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
        ) {
            Text(
                text = stringResource(R.string.mobile_printer_setup_your_printer),
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(text = saved.name, style = MaterialTheme.typography.titleLarge)
        }
        BigButton(
            text = stringResource(R.string.mobile_printer_setup_test_print),
            icon = painterResource(DesignR.drawable.ic_cb_print),
            onClick = onTestPrint,
            style = BigButtonStyle.Success,
            enabled = !state.busy,
            modifier = Modifier.testTag(PrinterSetupTags.TEST_PRINT),
        )
    } else {
        Text(
            text = stringResource(R.string.mobile_printer_setup_no_printer_yet),
            style = MaterialTheme.typography.titleMedium,
        )
    }
    TestStatus(state.test)

    if (state.paired.isNotEmpty()) {
        SectionTitle(stringResource(R.string.mobile_printer_setup_paired))
        state.paired.forEach { device ->
            DeviceRow(
                device = device,
                chosen = device.address == saved?.address,
                enabled = !state.busy,
                onClick = { onChoose(device) },
                tag = PrinterSetupTags.paired(device.address),
            )
        }
    }

    BigButton(
        text = stringResource(R.string.mobile_printer_setup_find),
        icon = painterResource(DesignR.drawable.ic_cb_search),
        onClick = onFind,
        style = BigButtonStyle.Secondary,
        enabled = !state.busy && !state.finding,
        modifier = Modifier.testTag(PrinterSetupTags.FIND),
    )
    when {
        state.finding -> {
            Notice(
                icon = DesignR.drawable.ic_cb_search,
                text = stringResource(R.string.mobile_printer_setup_finding),
                modifier = Modifier.testTag(PrinterSetupTags.FIND_STATUS),
            )
        }

        state.foundNone -> {
            Notice(
                icon = DesignR.drawable.ic_cb_danger,
                text = stringResource(R.string.mobile_printer_setup_found_none),
                tint = CableTheme.semanticColors.danger,
                modifier = Modifier.testTag(PrinterSetupTags.FIND_STATUS),
            )
        }
    }
    PairStatus(state)
    if (state.found.isNotEmpty()) {
        SectionTitle(stringResource(R.string.mobile_printer_setup_found))
        state.found.forEach { device ->
            DeviceRow(
                device = device,
                chosen = false,
                enabled = !state.busy,
                onClick = { onPair(device) },
                tag = PrinterSetupTags.found(device.address),
            )
        }
    }
}

@Composable
private fun PairStatus(state: PrinterSetupUiState) {
    when {
        state.pairing != null -> {
            Column(
                modifier = Modifier.testTag(PrinterSetupTags.PAIR_STATUS),
                verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
            ) {
                Notice(
                    icon = DesignR.drawable.ic_cb_bluetooth,
                    text = stringResource(R.string.mobile_printer_setup_pairing),
                    tint = CableTheme.semanticColors.pending,
                )
                Text(
                    text = stringResource(R.string.mobile_printer_setup_pin_hint),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }

        state.pairFailed -> {
            Notice(
                icon = DesignR.drawable.ic_cb_danger,
                text = stringResource(R.string.mobile_printer_setup_pair_failed),
                tint = CableTheme.semanticColors.danger,
                modifier = Modifier.testTag(PrinterSetupTags.PAIR_STATUS),
            )
        }
    }
}

@Composable
private fun TestStatus(test: TestPrint) {
    val modifier = Modifier.testTag(PrinterSetupTags.TEST_STATUS)
    when (test) {
        // Nothing printed yet: no status line.
        TestPrint.Idle -> {}

        TestPrint.Printing -> {
            Notice(
                icon = DesignR.drawable.ic_cb_print,
                text = stringResource(R.string.mobile_printer_setup_printing),
                tint = CableTheme.semanticColors.pending,
                modifier = modifier,
            )
        }

        TestPrint.Printed -> {
            Notice(
                icon = DesignR.drawable.ic_cb_success,
                text = stringResource(R.string.mobile_printer_setup_printed),
                tint = CableTheme.semanticColors.success,
                modifier = modifier,
            )
        }

        is TestPrint.Failed -> {
            Notice(
                icon = DesignR.drawable.ic_cb_danger,
                text = stringResource(test.problem.message),
                tint = CableTheme.semanticColors.danger,
                modifier = modifier,
            )
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text = text, style = MaterialTheme.typography.titleMedium)
}

/** A device: printer icon + name, ≥ 56dp, tap to use it; a green tick on the chosen one. */
@Composable
private fun DeviceRow(
    device: PrinterDevice,
    chosen: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    tag: String,
) {
    Column {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = CableSizes.TouchMin)
                    .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                    .testTag(tag),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter =
                    painterResource(
                        if (device.looksLikePrinter) DesignR.drawable.ic_cb_print else DesignR.drawable.ic_cb_bluetooth,
                    ),
                contentDescription = null,
                modifier = Modifier.size(CableSizes.Icon),
            )
            Spacer(Modifier.width(CableSpacing.S3))
            Text(text = device.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            if (chosen) {
                Icon(
                    painter = painterResource(DesignR.drawable.ic_cb_success),
                    contentDescription = stringResource(R.string.mobile_printer_setup_your_printer),
                    tint = CableTheme.semanticColors.success,
                    modifier = Modifier.size(CableSizes.Icon),
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    }
}

/** Icon + sentence (colour never alone: the icon and the words carry the meaning too). */
@Composable
private fun Notice(
    icon: Int,
    text: String,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurface,
) {
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(CableSizes.IconLarge),
        )
        Spacer(Modifier.width(CableSpacing.S3))
        Text(text = text, style = MaterialTheme.typography.titleMedium)
    }
}
