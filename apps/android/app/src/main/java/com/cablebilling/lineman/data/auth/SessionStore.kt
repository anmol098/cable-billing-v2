package com.cablebilling.lineman.data.auth

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.data.network.generated.OperatorInfo
import com.cablebilling.lineman.data.network.generated.TokenPair
import com.google.crypto.tink.Aead
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The signed-in session on this phone, and the only place its tokens live (PLAN §11.1: tokens
 * encrypted with a Keystore-backed Tink key).
 *
 * The whole session (token pair, user, operator, device) is one JSON blob sealed with the Tink
 * [Aead] from `StorageModule` (keyset wrapped by an Android Keystore key) and stored base64 in the
 * `session` DataStore. Every change rewrites the blob in one DataStore transaction, so the
 * single-use refresh token is replaced atomically. Nothing here is backed up (data extraction
 * rules exclude everything).
 *
 * The disk side is [SealedSessionFile]. If the Keystore fails (some phones lose or break it), the
 * session still works from memory until the app is closed, and the failure goes to Sentry. A blob
 * that cannot be decrypted any more is dropped and the app asks for a sign-in
 * ([SignOutReason.STORAGE_RESET]).
 *
 * Thread-safe. Suspend functions for coroutines; [tokensBlocking] for OkHttp threads.
 */
@Singleton
class SessionStore
    @Inject
    constructor(
        @param:SessionPreferences prefs: DataStore<Preferences>,
        aead: dagger.Lazy<Aead>,
        json: Json,
    ) {
        private val file = SealedSessionFile(prefs, aead, json)
        private val mutex = Mutex()
        private val mutableState = MutableStateFlow<SessionState>(SessionState.Loading)

        @Volatile
        private var current: PersistedSession? = null

        /** The sign-in state; [SessionState.Loading] until [load] (or a token read) has run. */
        val state: StateFlow<SessionState> = mutableState.asStateFlow()

        /** The signed-in session, or null. */
        val session: Session? get() = (state.value as? SessionState.SignedIn)?.session

        /**
         * The operator's office phone from the last sign-in or /app/config. Kept after sign-out so
         * the login screen can still offer "Call office" (PLAN §11.6). Null if never known.
         */
        val officePhone: Flow<String?> = file.officePhone

        /** Reads the stored session (once; later calls return the current state). */
        suspend fun load(): SessionState =
            mutex.withLock {
                if (mutableState.value != SessionState.Loading) return@withLock mutableState.value
                val loaded =
                    when (val stored = file.read()) {
                        StoredBlob.None -> {
                            SessionState.SignedOut()
                        }

                        StoredBlob.Unreadable -> {
                            file.remove()
                            SessionState.SignedOut(SignOutReason.STORAGE_RESET)
                        }

                        is StoredBlob.Found -> {
                            current = stored.session
                            SessionState.SignedIn(stored.session.toSession())
                        }
                    }
                mutableState.value = loaded
                loaded
            }

        /** The current token pair, reading storage first if needed. Blocks: for OkHttp threads. */
        fun tokensBlocking(): TokenPair? {
            if (mutableState.value == SessionState.Loading) runBlocking { load() }
            return current?.tokens
        }

        /** The current token pair (for sign-out), reading storage first if needed. */
        suspend fun currentTokens(): TokenPair? {
            load()
            return current?.tokens
        }

        /** Why the app is signed out right now (for a request made without a session). */
        fun signOutReason(): SignOutReason =
            (state.value as? SessionState.SignedOut)?.reason ?: SignOutReason.SIGNED_OUT

        /** Stores a new sign-in (replacing any earlier session) and switches to [SessionState.SignedIn]. */
        suspend fun signIn(response: LoginResponse): Session =
            mutex.withLock {
                val persisted = PersistedSession(response.tokens, response.user, response.operator, response.device)
                file.write(persisted)
                file.writeOfficePhone(response.operator.officePhone)
                current = persisted
                val session = persisted.toSession()
                mutableState.value = SessionState.SignedIn(session)
                session
            }

        /**
         * Replaces [used] with [fresh] after a refresh. Does nothing (returns false) if the session
         * changed meanwhile (signed out, or someone else already replaced these tokens).
         */
        suspend fun replaceTokens(
            used: TokenPair,
            fresh: TokenPair,
        ): Boolean =
            mutex.withLock {
                val now = current ?: return@withLock false
                if (now.tokens.refreshToken != used.refreshToken) return@withLock false
                val next = now.copy(tokens = fresh)
                file.write(next)
                current = next
                true
            }

        /** Keeps the operator details fresh (from /app/config). */
        suspend fun updateOperator(operator: OperatorInfo) {
            mutex.withLock {
                val now = current ?: return@withLock
                if (now.operator == operator) return@withLock
                val next = now.copy(operator = operator)
                file.write(next)
                file.writeOfficePhone(operator.officePhone)
                current = next
                mutableState.value = SessionState.SignedIn(next.toSession())
            }
        }

        /**
         * Ends the session: removes the tokens and switches to [SessionState.SignedOut] with [reason].
         * With [onlyIfTokens], only if the session still uses those tokens (a late refresh failure
         * must not sign out a lineman who has just signed in again). Returns whether it ended.
         * The install id, the office phone and everything outside this store (queued payments) stay.
         */
        suspend fun end(
            reason: SignOutReason,
            onlyIfTokens: TokenPair? = null,
        ): Boolean =
            mutex.withLock {
                if (onlyIfTokens != null && current?.tokens?.refreshToken != onlyIfTokens.refreshToken) {
                    return@withLock false
                }
                current = null
                file.remove()
                mutableState.value = SessionState.SignedOut(reason)
                true
            }
    }
