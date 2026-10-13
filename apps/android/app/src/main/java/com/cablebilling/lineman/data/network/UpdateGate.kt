package com.cablebilling.lineman.data.network

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import io.sentry.Sentry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/** The force-update gate's view (PLAN §11.9). */
data class UpdateState(
    /** This app's Android versionCode (`BuildConfig.VERSION_CODE`). */
    val installedVersionCode: Long,
    /** The lowest versionCode the server accepts, as last heard; null if never heard. */
    val minimumVersionCode: Long? = null,
) {
    /** True: show only the full-screen "Update app" screen. Queued payments stay on the phone. */
    val updateRequired: Boolean get() = minimumVersionCode != null && installedVersionCode < minimumVersionCode
}

/**
 * Whether this app version is still accepted. Fed by `GET /app/config` (`min_app_version_code`,
 * authoritative: it can also lower the minimum again) and by any APP_TOO_OLD (426) answer, which
 * [AppVersionInterceptor] reports. The last minimum is kept in the `session` DataStore, so the
 * update screen also shows after a restart without internet; installing the update raises
 * [UpdateState.installedVersionCode] and opens the gate by itself.
 */
class UpdateGate(
    private val prefs: DataStore<Preferences>,
    installedVersionCode: Long,
) {
    private val mutex = Mutex()
    private val mutableState = MutableStateFlow(UpdateState(installedVersionCode))
    private var loaded = false

    val state: StateFlow<UpdateState> = mutableState.asStateFlow()

    /** Reads the stored minimum (once). A minimum heard before this keeps precedence. */
    suspend fun load() {
        mutex.withLock {
            if (loaded) return
            loaded = true
            val stored =
                try {
                    prefs.data.first()[MIN_VERSION_CODE]
                } catch (e: IOException) {
                    Sentry.captureException(e)
                    null
                }
            val heardNothingYet = mutableState.value.minimumVersionCode == null
            if (stored != null && heardNothingYet) mutableState.update { it.copy(minimumVersionCode = stored) }
        }
    }

    /** From `/app/config`: the server's current minimum (may be lower than before). */
    suspend fun onMinimumFromConfig(minimumVersionCode: Long) = set(minimumVersionCode)

    /**
     * From an APP_TOO_OLD answer: at least [minimumVersionCode], or "newer than this one" when the
     * answer did not say.
     */
    suspend fun onAppTooOld(minimumVersionCode: Long?) {
        val installed = mutableState.value.installedVersionCode
        val atLeast = maxOf(minimumVersionCode ?: (installed + 1), installed + 1)
        set(maxOf(atLeast, mutableState.value.minimumVersionCode ?: 0))
    }

    private suspend fun set(minimum: Long) {
        mutex.withLock {
            loaded = true
            if (mutableState.value.minimumVersionCode == minimum) return
            mutableState.update { it.copy(minimumVersionCode = minimum) }
            try {
                prefs.edit { it[MIN_VERSION_CODE] = minimum }
            } catch (e: IOException) {
                Sentry.captureException(e)
            }
        }
    }

    companion object {
        val MIN_VERSION_CODE = longPreferencesKey("min_app_version_code")
    }
}
