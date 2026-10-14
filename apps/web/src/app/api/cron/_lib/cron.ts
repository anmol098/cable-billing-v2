/**
 * Shared plumbing for `/api/cron/*` routes (T-043, PLAN §14).
 *
 * ```ts
 * // apps/web/src/app/api/cron/<name>/route.ts
 * export const runtime = "nodejs";
 * export const dynamic = "force-dynamic";
 * export const maxDuration = 300; // seconds; set per route (no `functions` block in vercel.json)
 * export const GET = cronRoute("billing_scheduler", async ({ db, log, requestId }) => {
 *   return { enqueued: 12 };       // JSON body of the 200 response
 * });
 * ```
 *
 * `cronRoute` checks `Authorization: Bearer <CRON_SECRET>` (503 when the secret is unset, 401 on a
 * wrong header), creates the database client on first use, logs `cron.started` / `cron.finished`
 * (JSON lines, also added as Sentry breadcrumbs), and on an exception logs `cron.failed`, sends it
 * to Sentry and answers 500. Crons listed in `CRON_MONITORS` (`./monitor`) also check in with a
 * Sentry cron monitor when `SENTRY_DSN` is set (T-096a). Nothing here reads the environment at
 * import time.
 */
import { createLogger, errorLogFields, jsonLineSink, type Logger, requestIdFrom } from "@cb/core";
import { createDb, type DbClient } from "@cb/db";
import * as Sentry from "@sentry/nextjs";
import { requireServerEnv, serverEnv } from "@/env";
import { checkCronAuthorization, cronAuthResponse } from "./auth";
import { type CheckInSink, defaultCheckIns, startCronMonitor } from "./monitor";

/** JSON-line logs that also become Sentry breadcrumbs (records are PII-free by construction). */
export function createCronLogger(): Logger {
  return createLogger({
    sink: (record) => {
      jsonLineSink(record);
      Sentry.addBreadcrumb({
        category: record.event,
        level: record.level === "warn" ? "warning" : record.level,
        data: record,
      });
    },
  });
}

let db: DbClient | undefined;

/** One database client per server instance, created on first use (not at import). */
export function cronDb(): DbClient {
  if (!db) {
    const { DATABASE_URL } = requireServerEnv("DATABASE_URL");
    db = createDb({ connectionString: DATABASE_URL });
  }
  return db;
}

export interface CronRunArgs {
  readonly request: Request;
  readonly requestId: string;
  readonly log: Logger;
  /** The database client (created on first call). */
  readonly db: () => DbClient;
}

export type CronResult = Record<string, unknown> | Response;

export interface CronRouteOptions {
  /** Default: `CRON_SECRET`. */
  readonly secret?: () => string | undefined;
  /**
   * Where Sentry cron check-ins go (T-096a). Default: Sentry when `SENTRY_DSN` is set, else none.
   * Only crons listed in `CRON_MONITORS` (`./monitor`) check in.
   */
  readonly checkIns?: () => CheckInSink | undefined;
}

/**
 * `name`: snake_case, used in logs and Sentry tags, and the key of its cron monitor in
 * `CRON_MONITORS`. A monitored cron checks in `in_progress` after the secret check (an
 * unauthenticated call never checks in), then `ok` for a 2xx answer, `error` for anything else
 * (an exception's 500, a stub's 501).
 */
export function cronRoute(
  name: string,
  run: (args: CronRunArgs) => Promise<CronResult>,
  options: CronRouteOptions = {},
): (request: Request) => Promise<Response> {
  const secret = options.secret ?? (() => serverEnv.CRON_SECRET);
  const checkIns = options.checkIns ?? defaultCheckIns;
  return async (request) => {
    const auth = checkCronAuthorization(request.headers.get("authorization"), secret());
    const requestId = requestIdFrom(request.headers.get("x-vercel-id"));
    const log = createCronLogger().child({ cron: name, request_id: requestId });
    if (auth !== "ok") {
      if (auth === "not_configured") log.error("cron.refused_no_secret", {});
      else log.warn("cron.unauthorized", {});
      return cronAuthResponse(auth);
    }
    const started = Date.now();
    log.info("cron.started", {});
    const monitor = startCronMonitor(name, checkIns(), log);
    let response: Response;
    let failed = false;
    try {
      const result = await run({ request, requestId, log, db: cronDb });
      log.info("cron.finished", { duration_ms: Date.now() - started });
      response =
        result instanceof Response
          ? result
          : Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      failed = true;
      log.error("cron.failed", { duration_ms: Date.now() - started, ...errorLogFields(error) });
      Sentry.captureException(error, { tags: { cron: name }, extra: { request_id: requestId } });
      response = Response.json(
        { error: "INTERNAL", requestId },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Flushes the exception too when monitored; otherwise flush it here as before.
    await monitor.finish(response.ok ? "ok" : "error");
    if (failed && !monitor.monitored) await Sentry.flush(2_000);
    return response;
  };
}

/**
 * Placeholder for a scheduler route another task implements (`owner`: that task's id). It
 * authenticates like a real route, logs `cron.not_implemented` and answers 501, so the Vercel cron
 * log shows honestly that nothing ran. The owning task replaces the route file.
 */
export function cronStub(name: string, owner: string): (request: Request) => Promise<Response> {
  return cronRoute(name, async ({ log }) => {
    log.warn("cron.not_implemented", { owner_task: owner });
    return Response.json(
      { error: "NOT_IMPLEMENTED", cron: name, ownerTask: owner },
      { status: 501, headers: { "Cache-Control": "no-store" } },
    );
  });
}
