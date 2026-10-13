package com.cablebilling.lineman.data.auth

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import io.sentry.Sentry
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The random UUID that identifies this installation to the server (`DeviceInfo.install_id`, sent
 * at login and bound to the refresh token). Made once, kept across sign-outs, gone on uninstall or
 * "clear data" (never backed up: a restored copy on another phone would share it).
 */
@Singleton
class InstallId
    @Inject
    constructor(
        @param:SessionPreferences private val prefs: DataStore<Preferences>,
    ) {
        private val mutex = Mutex()

        @Volatile
        private var cached: String? = null

        suspend fun get(): String =
            cached ?: mutex.withLock {
                cached ?: (readStored() ?: create()).also { cached = it }
            }

        /** [get] for OkHttp threads. */
        fun getBlocking(): String = cached ?: runBlocking { get() }

        private suspend fun readStored(): String? =
            try {
                prefs.data.first()[KEY]?.takeIf(::isUuid)
            } catch (e: IOException) {
                Sentry.captureException(e)
                null
            }

        private suspend fun create(): String {
            val id = UUID.randomUUID().toString()
            try {
                prefs.edit { it[KEY] = id }
            } catch (e: IOException) {
                // Still usable for this run; the next start makes a new one (a new device row on login).
                Sentry.captureException(e)
            }
            return id
        }

        private fun isUuid(value: String): Boolean = runCatching { UUID.fromString(value) }.isSuccess

        companion object {
            val KEY = stringPreferencesKey("install_id")
        }
    }
