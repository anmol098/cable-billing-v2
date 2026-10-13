package com.cablebilling.lineman.di

import com.cablebilling.lineman.BuildConfig
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.time.Duration
import javax.inject.Singleton

/**
 * Retrofit + OkHttp + kotlinx.serialization for `/api/mobile/v1` (PLAN §10.2). The base URL comes
 * from the build flavour (BuildConfig.API_BASE_URL). T-063 adds the auth interceptor and services.
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    private val CONNECT_TIMEOUT: Duration = Duration.ofSeconds(15)
    private val READ_TIMEOUT: Duration = Duration.ofSeconds(30)

    @Provides
    @Singleton
    fun provideJson(): Json =
        Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient =
        OkHttpClient
            .Builder()
            .connectTimeout(CONNECT_TIMEOUT)
            .readTimeout(READ_TIMEOUT)
            .apply {
                if (BuildConfig.DEBUG) {
                    // BASIC: method, URL, status and size only; never headers or bodies (tokens, PII).
                    addInterceptor(HttpLoggingInterceptor().setLevel(HttpLoggingInterceptor.Level.BASIC))
                }
            }.build()

    @Provides
    @Singleton
    fun provideRetrofit(
        client: OkHttpClient,
        json: Json,
    ): Retrofit =
        Retrofit
            .Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
}
