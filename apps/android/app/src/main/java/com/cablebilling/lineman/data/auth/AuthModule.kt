package com.cablebilling.lineman.data.auth

import android.content.Context
import android.os.Build
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile
import com.cablebilling.lineman.BuildConfig
import com.cablebilling.lineman.data.network.generated.DeviceInfo
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Qualifier
import javax.inject.Singleton

/**
 * The `session` DataStore: the sealed session blob, the install id, the last office phone and the
 * last known minimum app version. Separate from the `settings` DataStore (StorageModule) so sign-in
 * data and user preferences never share a file.
 */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class SessionPreferences

/** Describes this phone for `DeviceInfo` at login (model, Android version, app version). */
fun interface DeviceInfoSource {
    fun deviceInfo(installId: String): DeviceInfo
}

@Module
@InstallIn(SingletonComponent::class)
object AuthModule {
    private const val SESSION_STORE_NAME = "session"
    private const val MAX_MODEL_LENGTH = 100
    private const val MAX_OS_LENGTH = 50

    @Provides
    @Singleton
    @SessionPreferences
    fun provideSessionPreferences(
        @ApplicationContext context: Context,
    ): DataStore<Preferences> =
        PreferenceDataStoreFactory.create { context.preferencesDataStoreFile(SESSION_STORE_NAME) }

    @Provides
    fun provideDeviceInfoSource(): DeviceInfoSource =
        DeviceInfoSource { installId ->
            DeviceInfo(
                installId = installId,
                model =
                    listOf(Build.MANUFACTURER, Build.MODEL)
                        .filterNot { it.isNullOrBlank() }
                        .joinToString(" ")
                        .ifBlank { "Android" }
                        .take(MAX_MODEL_LENGTH),
                os = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})".take(MAX_OS_LENGTH),
                appVersion = BuildConfig.VERSION_NAME,
                appVersionCode = BuildConfig.VERSION_CODE.toLong(),
            )
        }
}
