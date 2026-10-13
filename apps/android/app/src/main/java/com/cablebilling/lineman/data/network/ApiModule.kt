package com.cablebilling.lineman.data.network

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import com.cablebilling.lineman.BuildConfig
import com.cablebilling.lineman.data.auth.InstallId
import com.cablebilling.lineman.data.auth.SessionPreferences
import com.cablebilling.lineman.data.auth.SessionStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.create
import javax.inject.Qualifier
import javax.inject.Singleton

/** The OkHttp client with the bearer token and refresh (MobileApi). The unqualified one has neither. */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class Authenticated

/**
 * The API services on top of `di/NetworkModule` (T-008):
 *
 * - plain client (`OkHttpClient`, `Retrofit`): version header + APP_TOO_OLD watch → [AuthApi];
 * - `@Authenticated` client: the plain one plus [AuthInterceptor] (bearer, single-flight refresh,
 *   one retry) → [MobileApi].
 *
 * Both share one connection pool (`newBuilder`).
 */
@Module
@InstallIn(SingletonComponent::class)
object ApiModule {
    @Provides
    @Singleton
    fun provideUpdateGate(
        @SessionPreferences prefs: DataStore<Preferences>,
    ): UpdateGate = UpdateGate(prefs, installedVersionCode = BuildConfig.VERSION_CODE.toLong())

    @Provides
    @Singleton
    fun provideAppVersionInterceptor(
        gate: UpdateGate,
        errors: ApiErrorParser,
    ): AppVersionInterceptor = AppVersionInterceptor(BuildConfig.VERSION_CODE.toLong(), gate, errors)

    @Provides
    @Singleton
    fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create()

    @Provides
    @Singleton
    fun provideTokenRefresher(
        store: SessionStore,
        authApi: AuthApi,
        installId: InstallId,
        errors: ApiErrorParser,
    ): TokenRefresher = TokenRefresher(store, authApi, installId, errors)

    @Provides
    @Singleton
    @Authenticated
    fun provideAuthenticatedClient(
        client: OkHttpClient,
        store: SessionStore,
        refresher: TokenRefresher,
        errors: ApiErrorParser,
    ): OkHttpClient = client.newBuilder().addInterceptor(AuthInterceptor(store, refresher, errors)).build()

    @Provides
    @Singleton
    fun provideMobileApi(
        retrofit: Retrofit,
        @Authenticated client: OkHttpClient,
    ): MobileApi =
        retrofit
            .newBuilder()
            .client(client)
            .build()
            .create()
}
