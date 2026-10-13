package com.cablebilling.lineman.printing

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import com.cablebilling.lineman.printing.bluetooth.AndroidBluetoothPrinters
import com.cablebilling.lineman.printing.bluetooth.AndroidSppSockets
import com.cablebilling.lineman.printing.bluetooth.BluetoothPrinters
import com.cablebilling.lineman.printing.transport.PrinterTransport
import com.cablebilling.lineman.printing.transport.SppTransport
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/** Bluetooth printing (T-068). Inject [ReceiptPrinter] to print, [PrinterSettings] for the chosen printer. */
@Module
@InstallIn(SingletonComponent::class)
object PrintingModule {
    @Provides
    @Singleton
    fun provideBluetoothPrinters(
        @ApplicationContext context: Context,
    ): BluetoothPrinters = AndroidBluetoothPrinters(context)

    @Provides
    @Singleton
    fun providePrinterTransport(
        @ApplicationContext context: Context,
    ): PrinterTransport = SppTransport(AndroidSppSockets(context))

    @Provides
    @Singleton
    fun providePrinterSettings(store: DataStore<Preferences>): PrinterSettings = DataStorePrinterSettings(store)

    @Provides
    @Singleton
    fun provideReceiptPrinter(
        @ApplicationContext context: Context,
        bluetooth: BluetoothPrinters,
        settings: PrinterSettings,
        transport: PrinterTransport,
    ): ReceiptPrinter = BluetoothReceiptPrinter(context, bluetooth, settings, transport)
}
