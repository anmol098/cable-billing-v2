package com.cablebilling.lineman.feature.settings

import com.cablebilling.lineman.data.auth.AuthRepository
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.payments.isHeldFor
import com.cablebilling.lineman.data.sync.PaymentSyncScheduler
import com.cablebilling.lineman.diagnostics.AppInfo
import com.cablebilling.lineman.diagnostics.DiagnosticLog
import com.cablebilling.lineman.diagnostics.DiagnosticReport
import com.cablebilling.lineman.diagnostics.QueueCounts
import com.cablebilling.lineman.locale.AppLanguage
import com.cablebilling.lineman.printing.PrinterSettings
import com.cablebilling.lineman.printing.SavedPrinter
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.components.ViewModelComponent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import java.time.Instant
import javax.inject.Inject

/** What the settings screen reads and does (the app: [AppSettingsData]; ViewModel tests: a fake). */
interface SettingsData {
    fun session(): Flow<SessionState>

    fun printer(): Flow<SavedPrinter?>

    /** How many of [userId]'s payments are still on the phone, live. */
    fun waitingCount(userId: String): Flow<Int>

    /** The sign-out check: true while any payment [userId] took is still only on this phone. */
    suspend fun hasPaymentsOnPhone(userId: String): Boolean

    /** Ends the session on this phone (and on the server, best effort). Never touches payments. */
    suspend fun signOut()

    /** Push this lineman's payments now ("Try now"). */
    fun tryNow()

    /** The app language now (`hi` / `en`). */
    val language: String

    fun setLanguage(language: String)

    /** `0.1.0 (1)`. */
    val version: String

    /** The app report (app, phone, queue counts, diagnostic log). */
    suspend fun report(): String

    /** Writes a settings event (a code, nothing personal) to the diagnostic log. */
    fun note(event: String)
}

/** "Push now" (PaymentSyncScheduler.tryNow in the app), separate so tests need no WorkManager. */
fun interface PushNow {
    fun tryNow()
}

class AppSettingsData
    @Inject
    constructor(
        private val db: CableDatabase,
        private val auth: AuthRepository,
        private val printers: PrinterSettings,
        private val push: PushNow,
        private val log: DiagnosticLog,
        private val app: AppInfo,
    ) : SettingsData {
        private val payments get() = db.paymentDao()

        override fun session(): Flow<SessionState> = auth.state

        override fun printer(): Flow<SavedPrinter?> = printers.printer

        override fun waitingCount(userId: String): Flow<Int> =
            payments
                .observeNotSent()
                .map { rows -> rows.count { it.collectorId == userId && it.state == PaymentState.SAVED_ON_PHONE } }
                .distinctUntilChanged()

        // T-066: the push queue's own query (oldest SAVED_ON_PHONE payment of this collector).
        override suspend fun hasPaymentsOnPhone(userId: String): Boolean =
            payments.oldestSavedOnPhoneFor(userId, 1).isNotEmpty()

        override suspend fun signOut() {
            log.info("sign_out")
            auth.signOut()
        }

        override fun tryNow() {
            log.info("sign_out_try_now")
            push.tryNow()
        }

        override val language: String get() = AppLanguage.current()

        override fun setLanguage(language: String) {
            log.info("language", "app=$language")
            AppLanguage.set(language)
        }

        override val version: String get() = app.version

        override suspend fun report(): String =
            withContext(Dispatchers.IO) {
                val userId = (auth.state.value as? SessionState.SignedIn)?.session?.user?.id
                val rows = payments.observeNotSent().first()
                val queue =
                    QueueCounts(
                        waiting = rows.count { it.state == PaymentState.SAVED_ON_PHONE && !it.isHeldFor(userId) },
                        needsHelp = rows.count { it.state == PaymentState.NEEDS_OFFICE_HELP },
                        otherLineman = rows.count { it.state == PaymentState.SAVED_ON_PHONE && it.isHeldFor(userId) },
                    )
                log.info("report")
                log.flush()
                DiagnosticReport.build(app, AppLanguage.current(), queue, log.lines(), Instant.now())
            }

        override fun note(event: String) = log.info(event)
    }

@Module
@InstallIn(ViewModelComponent::class)
abstract class SettingsDataModule {
    @Binds
    abstract fun bindSettingsData(impl: AppSettingsData): SettingsData

    companion object {
        @Provides
        fun providePushNow(scheduler: PaymentSyncScheduler): PushNow = PushNow { scheduler.tryNow() }
    }
}
