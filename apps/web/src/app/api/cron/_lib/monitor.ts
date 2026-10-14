/**
 * Sentry cron monitor check-ins for the Vercel crons (T-096a, PLAN §17).
 *
 * A crash already alerts (`cron-failed`). A cron that silently stops being called (cron disabled,
 * project paused, a deploy that dropped it from `vercel.json`) raises nothing by itself; Sentry's
 * cron monitors do: every monitored run checks in `in_progress` when it starts and `ok` / `error`
 * when it ends, and Sentry alerts when a check-in is missing, late, too long or `error`.
 *
 * The monitors themselves (schedule, margin, max runtime, alert threshold) are defined in
 * `docs/runbooks/monitoring/alerts.json` (`cronMonitors`, applied by `sentry-alerts.mjs --apply`),
 * so check-ins carry only the slug. `alerts.test.mjs` checks that every slug below has a monitor
 * there with `vercel.json`'s schedule, and the other way round.
 *
 * Without `SENTRY_DSN` nothing is sent and nothing extra runs. Check-ins never change a cron's
 * outcome: a failing or unreachable Sentry is logged and ignored.
 */
import type { Logger } from "@cb/core";
import * as Sentry from "@sentry/nextjs";
import { serverEnv } from "@/env";

/** `cronRoute` name → Sentry cron monitor slug. Crons not listed here are not monitored. */
export const CRON_MONITORS: Readonly<Record<string, string>> = {
  billing_scheduler: "cron-billing-scheduler",
  job_worker: "cron-job-worker",
  invariants: "cron-invariants",
  subscription_states: "cron-subscription-states",
};

/** The shapes of Sentry's `CheckIn` (`@sentry/core` types/checkin). */
export type CheckIn =
  | { readonly monitorSlug: string; readonly status: "in_progress" }
  | {
      readonly monitorSlug: string;
      readonly status: "ok" | "error";
      /** The id the `in_progress` check-in returned: closes that run. */
      readonly checkInId: string;
      /** Seconds. */
      readonly duration: number;
    }
  /** No open run to close (its `in_progress` failed): a plain heartbeat. */
  | { readonly monitorSlug: string; readonly status: "ok" | "error" };

/** Where check-ins go: Sentry's documented cron API, or a fake in tests. */
export interface CheckInSink {
  /** Returns the check-in id (Sentry: `captureCheckIn`). */
  capture(checkIn: CheckIn): string;
  /** Sends what is buffered; resolves false when the timeout passes first (Sentry: `flush`). */
  flush(timeoutMs: number): Promise<boolean>;
}

/** `@sentry/nextjs`'s `captureCheckIn` (cron monitors) and `flush`. */
export const sentryCheckIns: CheckInSink = {
  capture: (checkIn) => Sentry.captureCheckIn(checkIn),
  flush: (timeoutMs) => Sentry.flush(timeoutMs),
};

/** The sink to use for this request: Sentry when `SENTRY_DSN` is set, otherwise none. */
export function defaultCheckIns(): CheckInSink | undefined {
  return serverEnv.SENTRY_DSN ? sentryCheckIns : undefined;
}

/** How long a cron waits for its check-ins to leave before answering (serverless: send or lose). */
export const CHECK_IN_FLUSH_MS = 2_000;

export interface CronMonitorRun {
  /** True when check-ins are sent for this run (so `finish` flushes Sentry's buffer). */
  readonly monitored: boolean;
  /**
   * Sends `ok` or `error` with the run's duration, then flushes everything buffered (up to
   * {@link CHECK_IN_FLUSH_MS}). Never throws; never waits much longer than that.
   */
  finish(status: "ok" | "error"): Promise<void>;
}

const NOT_MONITORED: CronMonitorRun = { monitored: false, finish: async () => {} };

/**
 * Starts a monitored run of cron `name`: checks in `in_progress` now. Returns a no-op when the cron
 * is not monitored or there is no sink (no DSN).
 */
export function startCronMonitor(
  name: string,
  sink: CheckInSink | undefined,
  log: Logger,
  clock: () => number = Date.now,
): CronMonitorRun {
  const monitorSlug = CRON_MONITORS[name];
  if (!sink || !monitorSlug) return NOT_MONITORED;
  const started = clock();
  let checkInId: string | undefined;
  try {
    checkInId = sink.capture({ monitorSlug, status: "in_progress" });
  } catch (error) {
    log.warn("cron.check_in_failed", { monitor: monitorSlug, error_type: errorType(error) });
  }
  return {
    monitored: true,
    async finish(status) {
      try {
        sink.capture(
          checkInId
            ? { monitorSlug, status, checkInId, duration: (clock() - started) / 1000 }
            : { monitorSlug, status },
        );
      } catch (error) {
        log.warn("cron.check_in_failed", { monitor: monitorSlug, error_type: errorType(error) });
      }
      await flushQuietly(sink, log, monitorSlug);
    },
  };
}

async function flushQuietly(sink: CheckInSink, log: Logger, monitor: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Our own cap as well, in case a transport ignores the flush timeout.
  const cap = new Promise<"capped">((resolve) => {
    timer = setTimeout(() => resolve("capped"), CHECK_IN_FLUSH_MS + 500);
  });
  try {
    const sent = await Promise.race([sink.flush(CHECK_IN_FLUSH_MS), cap]);
    if (sent !== true) log.warn("cron.check_in_not_flushed", { monitor });
  } catch (error) {
    log.warn("cron.check_in_failed", { monitor, error_type: errorType(error) });
  } finally {
    clearTimeout(timer);
  }
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
