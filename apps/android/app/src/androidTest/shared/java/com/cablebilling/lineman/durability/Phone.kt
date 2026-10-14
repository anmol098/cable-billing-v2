package com.cablebilling.lineman.durability

import android.content.Context
import android.os.Build
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.room.Room
import com.cablebilling.lineman.BuildConfig
import com.cablebilling.lineman.data.auth.InstallId
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.CableMigrations
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiModule
import com.cablebilling.lineman.data.network.MobileApi
import com.cablebilling.lineman.data.network.UpdateGate
import com.cablebilling.lineman.data.network.generated.UserInfo
import com.cablebilling.lineman.data.payments.PaymentDraft
import com.cablebilling.lineman.data.payments.PaymentPushTrigger
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.data.sync.PaymentSyncScheduler
import com.cablebilling.lineman.data.sync.RosterSync
import com.cablebilling.lineman.data.sync.RosterSyncScheduler
import com.cablebilling.lineman.di.NetworkModule
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplate
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.aead.PredefinedAeadParameters
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.File

/**
 * One phone: its private storage ([storage]: the Room file, the session DataStore) and the app
 * "process" running on it. [kill] ends the process the way Android does (nothing in memory survives,
 * no code runs after it), [start] starts a new one on the same files: what a swipe-away, `am kill`,
 * a crash or a reboot leaves behind.
 *
 * The process is wired by hand with the production classes and the production Hilt module functions
 * (NetworkModule, ApiModule; the Room builder is DatabaseModule's), pointed at [baseUrl] (a
 * MockWebServer) and at [storage] instead of the app's own files. On a phone the session is sealed with
 * a real Android Keystore key, which has to open the session again after every restart.
 */
class Phone(
    private val context: Context,
    private val storage: File,
    private val baseUrl: HttpUrl,
    val clock: TestClock = TestClock(),
) {
    private val keysetName = "cb_durability_${uniqueNames.incrementAndGet()}"
    private var robolectricAead: Aead? = if (onRobolectric) tinkKeyset() else null
    private var current: PhoneProcess? = null

    /** The running process; fails if the app is not running. */
    val process: PhoneProcess get() = checkNotNull(current) { "the app is not running" }

    /** Starts the app (a cold start on the files the last process left). */
    fun start(): PhoneProcess {
        check(current == null) { "the app is already running" }
        return PhoneProcess(context, storage, baseUrl, aead(), clock).also { current = it }
    }

    /** The app process dies: open connections are cut, the database and DataStore files are closed. */
    fun kill() {
        current?.kill()
        current = null
    }

    /** Kill + cold start. */
    fun restart(): PhoneProcess {
        kill()
        return start()
    }

    /**
     * The phone loses the key that seals the session (a Keystore reset after an OS update or a removed
     * lock screen): the next start cannot open the stored sign-in. Call while the app is not running.
     */
    fun loseKey() {
        check(current == null) { "kill the app first" }
        if (onRobolectric) robolectricAead = tinkKeyset() else removeKeyset()
    }

    /** Ends the app and removes this phone's sealed keyset (the shared test Keystore key stays). */
    fun forget() {
        kill()
        if (!onRobolectric) removeKeyset()
    }

    private fun removeKeyset() {
        context
            .getSharedPreferences(KEYSET_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(keysetName)
            .commit()
    }

    private fun aead(): Aead =
        robolectricAead ?: run {
            // A new process reads the keyset from disk and unseals it with the Keystore master key.
            AeadConfig.register()
            AndroidKeysetManager
                .Builder()
                .withSharedPref(context, keysetName, KEYSET_PREFS)
                .withKeyTemplate(KeyTemplate.createFrom(PredefinedAeadParameters.AES256_GCM))
                .withMasterKeyUri(MASTER_KEY_URI)
                .build()
                .keysetHandle
                .getPrimitive(RegistryConfiguration.get(), Aead::class.java)
        }

    companion object {
        /** True on Robolectric (JVM), false on an emulator or phone. */
        val onRobolectric: Boolean get() = Build.FINGERPRINT == "robolectric"

        private const val KEYSET_PREFS = "cb_durability_keysets"
        private const val MASTER_KEY_URI = "android-keystore://cb_durability_master_key"

        /** Robolectric has no Android Keystore: a plain Tink keyset that "survives" restarts in memory. */
        private fun tinkKeyset(): Aead {
            AeadConfig.register()
            return KeysetHandle
                .generateNew(PredefinedAeadParameters.AES256_GCM)
                .getPrimitive(RegistryConfiguration.get(), Aead::class.java)
        }
    }
}

/** One run of the app on a [Phone]: the objects Hilt would make, on the phone's files. */
class PhoneProcess(
    context: Context,
    storage: File,
    baseUrl: HttpUrl,
    aead: Aead,
    val clock: TestClock,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = NetworkModule.provideJson()
    private val prefs: DataStore<Preferences> =
        PreferenceDataStoreFactory.create(scope = scope) { File(storage, "session.preferences_pb") }
    val sessions = SessionStore(prefs, { aead }, json)
    private val errors = ApiErrorParser(json)
    private val client: OkHttpClient =
        NetworkModule.provideOkHttpClient(
            ApiModule.provideAppVersionInterceptor(UpdateGate(prefs, BuildConfig.VERSION_CODE.toLong()), errors),
        )
    private val retrofit: Retrofit =
        Retrofit
            .Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    private val authApi = ApiModule.provideAuthApi(retrofit)
    private val authenticated =
        ApiModule.provideAuthenticatedClient(
            client,
            sessions,
            ApiModule.provideTokenRefresher(sessions, authApi, InstallId(prefs), errors),
            errors,
        )
    val api: MobileApi = ApiModule.provideMobileApi(retrofit, authenticated)

    /** The same builder as DatabaseModule, on this phone's file (no destructive fallback). */
    val db: CableDatabase =
        Room
            .databaseBuilder(context, CableDatabase::class.java, File(storage, CableDatabase.NAME).absolutePath)
            .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
            .build()

    val sync = PaymentSync(db, api, errors, sessions, clock, json)
    private val rosterSync = RosterSync(api, errors, sessions, RosterStore(db, clock))
    val roster = RosterSyncScheduler(context, { rosterSync }, sessions)
    val scheduler = PaymentSyncScheduler(context, db, sessions, { sync }, roster)

    /** The collect flow's save: commits, then asks for a push (WorkManager), like the app. */
    val repository = PaymentRepository(db, sessions, clock, scheduler)

    /** Saves [draft] like [repository], but the app dies before the push was asked for (after the commit). */
    fun saveWithoutPushRequest(draft: PaymentDraft): SaveResult =
        await { PaymentRepository(db, sessions, clock, PaymentPushTrigger { }).save(draft) }

    fun save(draft: PaymentDraft): SaveResult = await { repository.save(draft) }

    /** Saves and returns the payment id; fails the test if it was not saved. */
    fun saved(draft: PaymentDraft): String {
        val result = save(draft)
        check(result is SaveResult.Saved) { "not saved: $result" }
        return result.paymentId
    }

    fun signIn(user: UserInfo = DurabilityFixtures.suresh) {
        await { sessions.signIn(DurabilityFixtures.login(user)) }
    }

    /** The session stored on disk, as a cold start reads it. */
    fun storedSession(): SessionState = await { sessions.load() }

    fun payment(id: String): PaymentEntity? = await { db.paymentDao().get(id) }

    /** Every payment ever saved on this phone (rows are never deleted), oldest first. */
    fun allPayments(): List<PaymentEntity> {
        val ids =
            await {
                db.query("SELECT id FROM payments ORDER BY recorded_at, id", null).use { cursor ->
                    buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
                }
            }
        return ids.map { checkNotNull(payment(it)) }
    }

    fun onPhoneCount(): Int = await { db.paymentDao().observeSavedOnPhoneCount().first() }

    fun countIn(state: PaymentState): Int = allPayments().count { it.state == state }

    internal fun kill() {
        // Like Android killing the process: open calls are cut and no later code of this process runs.
        client.dispatcher.cancelAll()
        authenticated.dispatcher.cancelAll()
        db.close()
        await { scope.coroutineContext.job.cancelAndJoin() }
        client.connectionPool.evictAll()
    }
}

/** Runs [block] to completion on an IO thread (the tests themselves are plain blocking JUnit tests). */
fun <T> await(block: suspend () -> T): T = runBlocking(Dispatchers.IO) { withTimeout(AWAIT_TIMEOUT_MS) { block() } }

private const val AWAIT_TIMEOUT_MS = 30_000L
