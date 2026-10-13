package com.cablebilling.lineman.diagnostics

import android.content.Context
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.data.sync.PushStatus
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Writes what the app does to the [DiagnosticLog] without the features knowing: app start, sign-in
 * state changes (with the reason a session ended), payment push results, and crashes. Only codes and
 * counts, never who or how much. Started once from `CableApplication.onCreate`.
 */
@Singleton
class DiagnosticsRecorder
    @Inject
    constructor(
        private val log: DiagnosticLog,
        private val sessions: SessionStore,
        private val sync: dagger.Lazy<PaymentSync>,
        private val app: AppInfo,
    ) {
        private val started = AtomicBoolean(false)
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        fun start() {
            if (!started.compareAndSet(false, true)) return
            log.info("app_start", "app=${app.version} flavor=${app.flavor} sdk=${app.sdk}")
            recordCrashes()
            scope.launch { sessionEvents(sessions.state).collect { (event, detail) -> log.info(event, detail) } }
            // PaymentSync builds the network stack: do it off the main thread.
            scope.launch { pushEvents(sync.get().status).collect { (event, detail) -> log.info(event, detail) } }
        }

        private fun recordCrashes() {
            val current = Thread.getDefaultUncaughtExceptionHandler()
            if (current is CrashRecordingHandler) {
                // Installed already (a second Application in the same JVM, e.g. tests): point it at this log.
                current.log = log
            } else {
                Thread.setDefaultUncaughtExceptionHandler(CrashRecordingHandler(log, current))
            }
        }

        companion object {
            /** `session signed_in` / `session signed_out reason=session_expired`, once per change. */
            fun sessionEvents(states: Flow<SessionState>): Flow<Pair<String, String>> =
                states
                    .map { state ->
                        when (state) {
                            SessionState.Loading -> {
                                null
                            }

                            is SessionState.SignedIn -> {
                                "signed_in"
                            }

                            is SessionState.SignedOut -> {
                                "signed_out reason=${state.reason?.name?.lowercase() ?: "none"}"
                            }
                        }
                    }.filterNotNull()
                    .distinctUntilChanged()
                    .map { "session" to it }

            /** `payment_push status=no_internet`, once per change (Idle is not interesting). */
            fun pushEvents(statuses: Flow<PushStatus>): Flow<Pair<String, String>> =
                statuses
                    .map { status ->
                        when (status) {
                            PushStatus.Idle -> null
                            PushStatus.Running -> "running"
                            PushStatus.Finished -> "finished"
                            PushStatus.NoInternet -> "no_internet"
                            PushStatus.Failed -> "failed"
                        }
                    }.filterNotNull()
                    .distinctUntilChanged()
                    .map { "payment_push" to "status=$it" }
        }
    }

/** Writes the crash to the log at once, then lets the previous handler (Sentry, then Android) finish. */
private class CrashRecordingHandler(
    @Volatile var log: DiagnosticLog,
    private val previous: Thread.UncaughtExceptionHandler?,
) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(
        thread: Thread,
        error: Throwable,
    ) {
        runCatching { log.crash(error) }
        previous?.uncaughtException(thread, error)
    }
}

/** The diagnostic log lives in `noBackupFilesDir/diagnostics` (never in a cloud backup). */
@Module
@InstallIn(SingletonComponent::class)
object DiagnosticsModule {
    @Provides
    @Singleton
    fun provideDiagnosticLog(
        @ApplicationContext context: Context,
    ): DiagnosticLog = DiagnosticLog(File(context.noBackupFilesDir, "diagnostics"))

    @Provides
    fun provideAppInfo(): AppInfo = AppInfo.current()
}
