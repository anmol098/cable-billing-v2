package com.cablebilling.lineman.diagnostics

import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/**
 * The local diagnostic log (PLAN §11.1): what the app did, for support, shared by the lineman from
 * settings ("Share app report"). It never holds personal data: events are short codes with counts
 * (`payment_push status=no_internet`), and every line also goes through [PiiScrubber].
 *
 * A ring buffer on disk with a hard size cap: lines are appended to `current.log`; when it reaches
 * half of [maxBytes] it becomes `previous.log` (replacing the older one) and a new `current.log`
 * starts. So the log never exceeds [maxBytes] and keeps the newest lines. Writes run on [writer]
 * (one background thread in the app), so callers never wait for the disk; [crash] writes at once
 * because the process is about to die.
 */
class DiagnosticLog(
    private val dir: File,
    private val maxBytes: Int = DEFAULT_MAX_BYTES,
    private val clock: () -> Long = System::currentTimeMillis,
    private val writer: Executor = Executors.newSingleThreadExecutor { Thread(it, "diagnostic-log") },
) {
    private val lock = Any()
    private val current = File(dir, CURRENT)
    private val previous = File(dir, PREVIOUS)

    init {
        require(maxBytes >= MIN_MAX_BYTES) { "maxBytes too small: $maxBytes" }
    }

    /** Something normal happened: [event] is a `snake_case` code, [detail] short `key=value` pairs. */
    fun info(
        event: String,
        detail: String = "",
    ) = record(Level.INFO, event, detail)

    /** Something went wrong but the app carries on (a failed push, a print problem …). */
    fun warn(
        event: String,
        detail: String = "",
    ) = record(Level.WARN, event, detail)

    /** An error with its exception: class names and the top stack frames (no messages). */
    fun error(
        event: String,
        error: Throwable,
    ) = record(Level.ERROR, event, describe(error))

    /** The app is crashing: written before returning (the background writer would not get to run). */
    fun crash(error: Throwable) {
        val line = line(Level.ERROR, "crash", describe(error))
        synchronized(lock) { append(line) }
    }

    /** Every line, oldest first. */
    fun lines(): List<String> = synchronized(lock) { read(previous) + read(current) }

    /** Waits for writes already handed to the background writer (tests, and before sharing). */
    fun flush() {
        val done = CountDownLatch(1)
        writer.execute { done.countDown() }
        done.await(FLUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    private fun record(
        level: Level,
        event: String,
        detail: String,
    ) {
        val line = line(level, event, detail)
        try {
            writer.execute { synchronized(lock) { append(line) } }
        } catch (_: RejectedExecutionException) {
            // Shutting down: losing a diagnostic line is fine.
        }
    }

    private fun line(
        level: Level,
        event: String,
        detail: String,
    ): String {
        val name = event.takeIf { EVENT_NAME.matches(it) } ?: "event"
        val text =
            PiiScrubber
                .scrub(detail)
                .replace('\n', ' ')
                .replace('\r', ' ')
                .trim()
        val time = TIME.format(Instant.ofEpochMilli(clock()))
        val limit = if (level == Level.ERROR) MAX_ERROR_LINE_CHARS else MAX_LINE_CHARS
        return "$time ${level.letter} $name $text".trimEnd().take(limit)
    }

    private fun append(line: String) {
        try {
            dir.mkdirs()
            val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
            if (current.exists() && current.length() + bytes.size > maxBytes / 2) {
                previous.delete()
                if (!current.renameTo(previous)) current.delete()
            }
            current.appendBytes(bytes)
        } catch (_: IOException) {
            // A full or broken disk must never break the app because of the diagnostic log.
        }
    }

    private fun read(file: File): List<String> =
        try {
            if (file.exists()) file.readLines(Charsets.UTF_8).filter { it.isNotBlank() } else emptyList()
        } catch (_: IOException) {
            emptyList()
        }

    private enum class Level(
        val letter: Char,
    ) {
        INFO('I'),
        WARN('W'),
        ERROR('E'),
    }

    companion object {
        /** 64 KiB: a few hundred lines, small enough to share as plain text. */
        const val DEFAULT_MAX_BYTES = 64 * 1024
        const val MAX_LINE_CHARS = 400

        /** Errors keep their stack frames. */
        const val MAX_ERROR_LINE_CHARS = 2_000
        const val CURRENT = "current.log"
        const val PREVIOUS = "previous.log"

        /** Room for two full error lines of 3-byte characters per half, so one line always fits in a half. */
        private const val MIN_MAX_BYTES = 8 * MAX_ERROR_LINE_CHARS
        private const val MAX_FRAMES = 8
        private const val MAX_CAUSES = 3
        private const val FLUSH_TIMEOUT_SECONDS = 5L
        private val EVENT_NAME = Regex("[a-z][a-z0-9_]{0,39}")
        private val TIME: DateTimeFormatter =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC)

        /**
         * `java.io.IOException at a.B.c(B.kt:12) … caused by …`: exception types and where they happened.
         * Never the messages: they are free text and may hold a name the scrubber cannot recognise.
         */
        fun describe(error: Throwable): String {
            val parts = mutableListOf<String>()
            var cause: Throwable? = error
            var depth = 0
            while (cause != null && depth < MAX_CAUSES) {
                val head = cause.javaClass.name
                val frames = cause.stackTrace.take(MAX_FRAMES).joinToString(" ") { "at $it" }
                parts += if (depth == 0) "$head $frames" else "caused by $head $frames"
                cause = cause.cause.takeIf { it !== cause }
                depth++
            }
            return parts.joinToString(" ")
        }
    }
}
