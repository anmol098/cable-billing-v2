package com.cablebilling.lineman.printing.bluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Runtime permissions for printing, by Android version (PLAN §11.8):
 *
 * - API 31+: `BLUETOOTH_CONNECT` to talk to a paired printer, `BLUETOOTH_SCAN` (declared
 *   `neverForLocation`) to find new ones. Both are the "Nearby devices" prompt.
 * - API 26–30: `BLUETOOTH` / `BLUETOOTH_ADMIN` are granted at install (manifest only, capped with
 *   `maxSdkVersion="30"`); finding new printers needs location (`ACCESS_FINE_LOCATION`) and the
 *   phone's location switched on. Printing to a paired printer needs nothing at run time.
 */
@SuppressLint("InlinedApi") // The API 31 names are only returned when sdk >= 31.
object PrinterPermissions {
    /** Permissions to print to a paired printer on [sdk]. */
    fun forPrinting(sdk: Int = Build.VERSION.SDK_INT): List<String> =
        if (sdk >= Build.VERSION_CODES.S) listOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyList()

    /** Permissions to find and pair new printers on [sdk] (includes [forPrinting]). */
    fun forFinding(sdk: Int = Build.VERSION.SDK_INT): List<String> =
        if (sdk >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    /** True if finding printers needs the location explainer (API 26–30). */
    fun findingNeedsLocation(sdk: Int = Build.VERSION.SDK_INT): Boolean = sdk < Build.VERSION_CODES.S

    fun granted(
        context: Context,
        permissions: List<String>,
    ): Boolean = permissions.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
}
