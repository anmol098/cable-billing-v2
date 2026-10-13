package com.cablebilling.lineman.data.auth

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import com.cablebilling.lineman.data.network.generated.OperatorInfo
import com.cablebilling.lineman.data.network.generated.RegisteredDevice
import com.cablebilling.lineman.data.network.generated.TokenPair
import com.cablebilling.lineman.data.network.generated.UserInfo
import com.google.crypto.tink.Aead
import io.sentry.Sentry
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException
import java.security.GeneralSecurityException
import java.util.Base64

/** What is sealed on disk. Wire DTOs inside: the contract only grows within v1 (contracts README). */
@Serializable
internal data class PersistedSession(
    @SerialName("tokens") val tokens: TokenPair,
    @SerialName("user") val user: UserInfo,
    @SerialName("operator") val operator: OperatorInfo,
    @SerialName("device") val device: RegisteredDevice,
) {
    fun toSession() = Session(user, operator, device)
}

/** Result of reading the sealed session. */
internal sealed interface StoredBlob {
    data object None : StoredBlob

    /** There is a blob, but it does not open any more (new key, corrupt data). */
    data object Unreadable : StoredBlob

    data class Found(
        val session: PersistedSession,
    ) : StoredBlob
}

/**
 * The `session` DataStore entries owned by [SessionStore]: the session blob sealed with the Tink
 * [Aead] (base64 of the ciphertext, bound to its purpose by associated data) and the plain office
 * phone. Storage and key failures never throw: they go to Sentry and the caller carries on.
 */
internal class SealedSessionFile(
    private val prefs: DataStore<Preferences>,
    private val aead: dagger.Lazy<Aead>,
    private val json: Json,
) {
    val officePhone: Flow<String?> =
        prefs.data
            .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
            .map { it[OFFICE_PHONE] }
            .distinctUntilChanged()

    suspend fun read(): StoredBlob {
        val blob =
            try {
                prefs.data.first()[SESSION]
            } catch (e: IOException) {
                Sentry.captureException(e)
                null
            } ?: return StoredBlob.None
        return open(blob)?.let(StoredBlob::Found) ?: StoredBlob.Unreadable
    }

    /** Seals and stores [session]. Without a working key, removes any older blob instead (memory only). */
    suspend fun write(session: PersistedSession) {
        val sealed = seal(session)
        edit { if (sealed == null) it.remove(SESSION) else it[SESSION] = sealed }
    }

    suspend fun remove() = edit { it.remove(SESSION) }

    suspend fun writeOfficePhone(phone: String?) =
        edit { if (phone.isNullOrBlank()) it.remove(OFFICE_PHONE) else it[OFFICE_PHONE] = phone }

    @Suppress("TooGenericExceptionCaught")
    private fun open(blob: String): PersistedSession? =
        try {
            val plain = aead.get().decrypt(Base64.getDecoder().decode(blob), ASSOCIATED_DATA)
            json.decodeFromString(PersistedSession.serializer(), plain.decodeToString())
        } catch (e: GeneralSecurityException) {
            Sentry.captureException(e)
            null
        } catch (e: RuntimeException) {
            // Bad base64 / JSON, or Keystore trouble (ProviderException, IllegalStateException …).
            Sentry.captureException(e)
            null
        }

    @Suppress("TooGenericExceptionCaught")
    private fun seal(session: PersistedSession): String? =
        try {
            val plain = json.encodeToString(PersistedSession.serializer(), session).encodeToByteArray()
            Base64.getEncoder().encodeToString(aead.get().encrypt(plain, ASSOCIATED_DATA))
        } catch (e: GeneralSecurityException) {
            Sentry.captureException(e)
            null
        } catch (e: RuntimeException) {
            Sentry.captureException(e)
            null
        }

    private suspend fun edit(change: (MutablePreferences) -> Unit) {
        try {
            prefs.edit { change(it) }
        } catch (e: IOException) {
            Sentry.captureException(e)
        }
    }

    companion object {
        /** The sealed session blob. */
        val SESSION = stringPreferencesKey("session_v1")

        /** Plain: the office phone for "Call office" on the login screen (a business number, not secret). */
        val OFFICE_PHONE = stringPreferencesKey("office_phone")

        /** Binds the ciphertext to its purpose, so no other blob sealed with the same key fits here. */
        private val ASSOCIATED_DATA = "cb.session.v1".encodeToByteArray()
    }
}
