package com.cablebilling.lineman.printing

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import com.cablebilling.lineman.printing.escpos.PrinterProfile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** The chosen printer survives an app restart (PLAN §11.8 "the printer is remembered"). Plain JVM. */
class PrinterSettingsTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun <T> withStore(
        file: File,
        block: suspend (
            DataStorePrinterSettings,
            androidx.datastore.core.DataStore<androidx.datastore.preferences.core.Preferences>,
        ) -> T,
    ): T {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = PreferenceDataStoreFactory.create(scope = scope) { file }
        return try {
            runBlocking { block(DataStorePrinterSettings(store), store) }
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun savedPrinterIsRememberedAcrossRestarts() {
        val file = File(folder.root, "settings.preferences_pb")
        withStore(file) { settings, _ ->
            assertNull(settings.printer.first())
            settings.save(SavedPrinter(PRINTER_ADDRESS, "MTP-II", PrinterProfile.Generic58Cutter))
        }
        // A new DataStore on the same file = the app started again.
        withStore(file) { settings, _ ->
            assertEquals(
                SavedPrinter(PRINTER_ADDRESS, "MTP-II", PrinterProfile.Generic58Cutter),
                settings.printer.first(),
            )
            settings.forget()
            assertNull(settings.printer.first())
        }
    }

    @Test
    fun unknownProfileFallsBackToTheDefault() {
        val file = File(folder.root, "settings.preferences_pb")
        withStore(file) { settings, store ->
            store.edit {
                it[DataStorePrinterSettings.ADDRESS] = PRINTER_ADDRESS
                it[DataStorePrinterSettings.PROFILE] = "from-a-newer-app"
            }
            assertEquals(
                SavedPrinter(PRINTER_ADDRESS, PRINTER_ADDRESS, PrinterProfile.Generic58),
                settings.printer.first(),
            )
        }
    }
}
