package com.cablebilling.lineman.data.network

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import com.cablebilling.lineman.data.auth.AuthRepository
import com.cablebilling.lineman.data.auth.DeviceInfoSource
import com.cablebilling.lineman.data.auth.InstallId
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.network.generated.LoginRequest
import com.cablebilling.lineman.di.NetworkModule
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.aead.PredefinedAeadParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.MediaType.Companion.toMediaType
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.File
import java.util.Collections

/**
 * The real network + auth stack (the same classes and the same wiring as ApiModule / NetworkModule /
 * AuthModule) against a [MockWebServer] that answers with the contract fixtures. One instance is
 * one "app process"; [restart] makes a new one on the same storage files, like a phone restart.
 */
class TestNetwork(
    val server: MockWebServer,
    private val storageDir: File,
    val versionCode: Long = 1,
    /** Keyset shared across restarts (the Keystore key survives a restart on a real phone). */
    val aead: Aead = testAead(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val json: Json = NetworkModule.provideJson()
    val prefs: DataStore<Preferences> =
        PreferenceDataStoreFactory.create(scope = scope) { File(storageDir, "session.preferences_pb") }
    val store = SessionStore(prefs, { aead }, json)
    val installId = InstallId(prefs)
    val errors = ApiErrorParser(json)
    val gate = UpdateGate(prefs, versionCode)
    private val appVersion = AppVersionInterceptor(versionCode, gate, errors)
    private val baseClient = NetworkModule.provideOkHttpClient(appVersion)
    private val retrofit: Retrofit =
        Retrofit
            .Builder()
            .baseUrl(server.url("/api/mobile/v1/"))
            .client(baseClient)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    val authApi: AuthApi = ApiModule.provideAuthApi(retrofit)
    val refresher = ApiModule.provideTokenRefresher(store, authApi, installId, errors)
    val mobileApi: MobileApi =
        ApiModule.provideMobileApi(retrofit, ApiModule.provideAuthenticatedClient(baseClient, store, refresher, errors))
    val auth = AuthRepository(authApi, store, installId, deviceInfo, errors)
    val appConfig = AppConfigRepository(mobileApi, gate, store, errors)

    /** Ends this "process" (closes the DataStore) and starts a new one on the same files. */
    fun restart(): TestNetwork {
        close()
        return TestNetwork(server, storageDir, versionCode, aead)
    }

    fun close() = await { scope.coroutineContext.job.cancelAndJoin() }

    companion object {
        private const val TIMEOUT_MS = 20_000L

        /** The phone from `login.request.json`, with this install's id. */
        val deviceInfo =
            DeviceInfoSource { installId ->
                Fixtures.decode(LoginRequest.serializer(), "login.request.json").device.copy(installId = installId)
            }

        fun testAead(): Aead {
            AeadConfig.register()
            return KeysetHandle
                .generateNew(PredefinedAeadParameters.AES256_GCM)
                .getPrimitive(RegistryConfiguration.get(), Aead::class.java)
        }

        fun <T> await(block: suspend () -> T): T = runBlocking(Dispatchers.IO) { withTimeout(TIMEOUT_MS) { block() } }
    }
}

/** The contract fixtures (`packages/contracts/fixtures`), decoded with the app's own Json. */
object Fixtures {
    private val json = NetworkModule.provideJson()

    fun text(name: String): String = ContractFiles.fixture(name)

    fun <T> decode(
        serializer: KSerializer<T>,
        name: String,
    ): T = json.decodeFromString(serializer, text(name))

    /** A response whose body is the fixture [name] (error fixtures get their code's HTTP status). */
    fun response(
        name: String,
        code: Int = statusFor(name),
    ): MockResponse =
        MockResponse
            .Builder()
            .code(code)
            .setHeader("Content-Type", "application/json")
            .body(text(name))
            .build()

    /** HTTP status of an error fixture (`error.<CODE>.json`), from the contract's ERROR_CODE_INFO. */
    fun statusFor(name: String): Int {
        if (!name.startsWith("error.")) return HTTP_OK
        return ERROR_STATUS.getValue(name.removePrefix("error.").removeSuffix(".json"))
    }

    /** JSON with every `null` member removed (absent and null mean the same on the wire). */
    fun withoutNulls(element: JsonElement): JsonElement =
        when (element) {
            is JsonObject -> JsonObject(element.filterValues { it !is JsonNull }.mapValues { withoutNulls(it.value) })
            is JsonArray -> JsonArray(element.map(::withoutNulls))
            else -> element
        }

    private const val HTTP_OK = 200

    /** packages/contracts/src/errors.ts ERROR_CODE_INFO statuses. */
    val ERROR_STATUS =
        mapOf(
            "VALIDATION" to 400,
            "NOT_FOUND" to 404,
            "FORBIDDEN" to 403,
            "UNAUTHENTICATED" to 401,
            "CONFLICT" to 409,
            "TENANT_READ_ONLY" to 403,
            "ID_REUSED_WITH_DIFFERENT_DATA" to 409,
            "INVARIANT_VIOLATION" to 500,
            "APP_TOO_OLD" to 426,
            "INVALID_CREDENTIALS" to 401,
            "ACCOUNT_DISABLED" to 403,
            "ROLE_NOT_ALLOWED" to 403,
            "REFRESH_TOKEN_INVALID" to 401,
            "DEVICE_REVOKED" to 401,
            "RATE_LIMITED" to 429,
            "CURSOR_INVALID" to 400,
            "CUSTOMER_NOT_FOUND" to 404,
            "PAYMENT_NOT_FOUND" to 404,
            "HANDOVER_ALREADY_ACCEPTED" to 409,
            "INTERNAL" to 500,
        )
}

/** A MockWebServer dispatcher from a function, recording every request (thread-safe). */
class Routes(
    private val handler: (RecordedRequest) -> MockResponse,
) : Dispatcher() {
    val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())

    override fun dispatch(request: RecordedRequest): MockResponse {
        requests += request
        return handler(request)
    }

    fun requestsTo(pathSuffix: String): List<RecordedRequest> =
        synchronized(requests) { requests.filter { it.url.encodedPath.endsWith(pathSuffix) } }
}

/** The request body as text. */
val RecordedRequest.bodyText: String get() = body?.utf8().orEmpty()

/** The path below `/api/mobile/v1`. */
val RecordedRequest.apiPath: String get() = url.encodedPath.removePrefix("/api/mobile/v1")
