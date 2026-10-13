package com.cablebilling.lineman.printing

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import com.cablebilling.lineman.printing.escpos.PrinterProfile
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import java.io.IOException

/** The printer chosen in setup (PLAN §11.8: "the printer is remembered"). */
data class SavedPrinter(
    val address: String,
    val name: String,
    val profile: PrinterProfile = PrinterProfile.Default,
)

/** Where the chosen printer is remembered between app starts. */
interface PrinterSettings {
    /** The chosen printer, or null before setup. */
    val printer: Flow<SavedPrinter?>

    suspend fun save(printer: SavedPrinter)

    suspend fun forget()
}

/** [PrinterSettings] in the app's `settings` DataStore (StorageModule). A read error counts as "none". */
class DataStorePrinterSettings(
    private val store: DataStore<Preferences>,
) : PrinterSettings {
    override val printer: Flow<SavedPrinter?> =
        store.data
            .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
            .map { prefs ->
                val address = prefs[ADDRESS] ?: return@map null
                SavedPrinter(
                    address = address,
                    name = prefs[NAME] ?: address,
                    profile = PrinterProfile.fromId(prefs[PROFILE]),
                )
            }.distinctUntilChanged()

    override suspend fun save(printer: SavedPrinter) {
        store.edit {
            it[ADDRESS] = printer.address
            it[NAME] = printer.name
            it[PROFILE] = printer.profile.id
        }
    }

    override suspend fun forget() {
        store.edit {
            it.remove(ADDRESS)
            it.remove(NAME)
            it.remove(PROFILE)
        }
    }

    companion object {
        val ADDRESS = stringPreferencesKey("printer_address")
        val NAME = stringPreferencesKey("printer_name")
        val PROFILE = stringPreferencesKey("printer_profile")
    }
}
