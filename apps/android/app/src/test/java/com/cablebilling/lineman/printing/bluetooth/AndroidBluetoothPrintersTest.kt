package com.cablebilling.lineman.printing.bluetooth

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.os.Build
import android.os.Parcel
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Permissions per API level and the paired-device list on Robolectric's Bluetooth adapter. */
@RunWith(AndroidJUnit4::class)
class AndroidBluetoothPrintersTest {
    private val app = RuntimeEnvironment.getApplication()
    private val adapter: BluetoothAdapter = app.getSystemService(BluetoothManager::class.java).adapter

    private fun device(
        address: String,
        name: String?,
        major: Int = BluetoothClass.Device.Major.UNCATEGORIZED,
    ): BluetoothDevice {
        val device = adapter.getRemoteDevice(address)
        shadowOf(device).setName(name)
        shadowOf(device).setBluetoothClass(bluetoothClass(major))
        return device
    }

    /** BluetoothClass has no public constructor; it is Parcelable as one int. */
    private fun bluetoothClass(deviceClass: Int): BluetoothClass {
        val parcel = Parcel.obtain()
        return try {
            parcel.writeInt(deviceClass)
            parcel.setDataPosition(0)
            BluetoothClass.CREATOR.createFromParcel(parcel)
        } finally {
            parcel.recycle()
        }
    }

    @Test
    fun permissionsPerApiLevel() {
        assertEquals(emptyList<String>(), PrinterPermissions.forPrinting(Build.VERSION_CODES.O))
        assertEquals(emptyList<String>(), PrinterPermissions.forPrinting(Build.VERSION_CODES.R))
        assertEquals(
            listOf(Manifest.permission.ACCESS_FINE_LOCATION),
            PrinterPermissions.forFinding(Build.VERSION_CODES.R),
        )
        assertTrue(PrinterPermissions.findingNeedsLocation(Build.VERSION_CODES.R))
        assertEquals(
            listOf(Manifest.permission.BLUETOOTH_CONNECT),
            PrinterPermissions.forPrinting(Build.VERSION_CODES.S),
        )
        assertEquals(
            listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN),
            PrinterPermissions.forFinding(36),
        )
        assertFalse(PrinterPermissions.findingNeedsLocation(36))
    }

    @Test
    fun withoutNearbyDevicesPermissionNothingIsListedOrFound() =
        runBlocking {
            shadowOf(adapter).setEnabled(true)
            shadowOf(adapter).setBondedDevices(setOf(device("00:11:22:33:44:55", "MTP-II")))
            val printers = AndroidBluetoothPrinters(app)
            assertFalse(printers.canPrint())
            assertEquals(emptyList<PrinterDevice>(), printers.paired())
            assertFalse(printers.isPaired("00:11:22:33:44:55"))
            assertEquals(emptyList<PrinterDevice>(), printers.find().toList())
            assertFalse(printers.pair("00:11:22:33:44:55"))
        }

    @Test
    fun pairedDevicesPrintersFirst() {
        shadowOf(app).grantPermissions(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        shadowOf(adapter).setEnabled(true)
        shadowOf(adapter).setBondedDevices(
            setOf(
                device("AA:00:00:00:00:01", "Boat Rockerz"),
                device("AA:00:00:00:00:02", "Printer001"),
                device("AA:00:00:00:00:03", "Shop", BluetoothClass.Device.Major.IMAGING),
                device("AA:00:00:00:00:04", null),
            ),
        )
        val printers = AndroidBluetoothPrinters(app)
        assertEquals(BluetoothAvailability.On, printers.availability())
        assertEquals(
            listOf(
                PrinterDevice("AA:00:00:00:00:02", "Printer001", looksLikePrinter = true),
                PrinterDevice("AA:00:00:00:00:03", "Shop", looksLikePrinter = true),
                PrinterDevice("AA:00:00:00:00:04", "AA:00:00:00:00:04", looksLikePrinter = false),
                PrinterDevice("AA:00:00:00:00:01", "Boat Rockerz", looksLikePrinter = false),
            ),
            printers.paired(),
        )
        assertTrue(printers.isPaired("AA:00:00:00:00:02"))
        assertFalse(printers.isPaired("AA:00:00:00:00:09"))
        assertFalse(printers.isPaired("not an address"))

        shadowOf(adapter).setEnabled(false)
        assertEquals(BluetoothAvailability.Off, printers.availability())
        assertEquals(emptyList<PrinterDevice>(), printers.paired())
    }

    @Test
    @Config(sdk = [Build.VERSION_CODES.O])
    fun oldPhonesPrintWithoutRuntimePermission() {
        shadowOf(adapter).setEnabled(true)
        shadowOf(adapter).setBondedDevices(setOf(device("00:11:22:33:44:55", "MTP-II")))
        val printers = AndroidBluetoothPrinters(app)
        assertTrue(printers.canPrint())
        // Finding new printers still needs location on API 26-30.
        assertFalse(printers.canFind())
        assertEquals(listOf("MTP-II"), printers.paired().map { it.name })
    }
}
