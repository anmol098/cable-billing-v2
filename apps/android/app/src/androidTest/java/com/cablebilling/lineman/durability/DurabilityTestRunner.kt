package com.cablebilling.lineman.durability

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner

/**
 * The instrumentation runner of the app's androidTest suite (`testInstrumentationRunner`). It starts
 * the app process with a plain [Application] instead of `CableApplication`: the durability suite wires
 * the production classes by hand on its own files (like the JVM tests do), so Hilt, Sentry and the
 * real sync schedulers must not start against the app's own database, session and WorkManager.
 *
 * A future Compose/Hilt instrumented test needs a Hilt runner (`HiltTestApplication`); that task can
 * replace this one, keeping a plain application for `com.cablebilling.lineman.durability`.
 */
class DurabilityTestRunner : AndroidJUnitRunner() {
    override fun newApplication(
        cl: ClassLoader?,
        className: String?,
        context: Context?,
    ): Application = super.newApplication(cl, Application::class.java.name, context)
}
