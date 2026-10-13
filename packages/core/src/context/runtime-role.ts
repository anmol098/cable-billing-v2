/**
 * Production boot check of the database runtime role (T-020a "shape B"): reports, through the
 * structured logger, when the app connects as a role that owns tables, is superuser, has
 * BYPASSRLS, … (`checkRuntimeRole` from @cb/db).
 *
 * Runs only in production and staging (`VERCEL_ENV=production` or `VERCEL_TARGET_ENV=staging`):
 * previews, local and CI connect with the owner URL on purpose (shape A), which would always be
 * flagged. Once per process, never awaited at boot, never throws.
 *
 * apps/web (out of T-025's scope) wires it like this, next to its runtime singleton:
 *
 * ```ts
 * startRuntimeRoleCheck(runtime, {
 *   onUnsafe: (report) => Sentry.captureMessage("unsafe DB runtime role", {
 *     extra: { issues: report.issues.map((i) => i.code) },
 *   }),
 * });
 * ```
 */
import { checkRuntimeRole, type RuntimeRoleReport } from "@cb/db";
import { errorLogFields } from "../logging/logger";
import type { ServiceRuntime } from "./runtime";

type Env = Readonly<Record<string, string | undefined>>;

/** True in production and staging deployments, where the runtime role must be shape B. */
export function shouldCheckRuntimeRole(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.VERCEL_TARGET_ENV === "staging";
}

export interface RuntimeRoleCheckOptions {
  /** Called when the role is unsafe (e.g. report to Sentry). Errors it throws are logged. */
  readonly onUnsafe?: (report: RuntimeRoleReport) => void;
}

/**
 * Runs `checkRuntimeRole` and logs the outcome: `db.runtime_role_unsafe` (error) with the issue
 * codes and messages, `db.runtime_role_warning` (warn) for warnings only, `db.runtime_role_ok`
 * (info), or `db.runtime_role_check_failed` (error) when the check itself fails. Never rejects.
 */
export async function logRuntimeRoleCheck(
  runtime: Pick<ServiceRuntime, "db" | "logger">,
  options: RuntimeRoleCheckOptions = {},
): Promise<RuntimeRoleReport | undefined> {
  const { logger } = runtime;
  let report: RuntimeRoleReport;
  try {
    report = await checkRuntimeRole(runtime.db);
  } catch (error) {
    logger.error("db.runtime_role_check_failed", errorLogFields(error));
    return undefined;
  }
  const fields = {
    db_role: report.sessionUser,
    database: report.database,
    issue_codes: report.issues.map((issue) => issue.code),
    issue_messages: report.issues.map((issue) => issue.message),
  };
  if (!report.ok) {
    logger.error("db.runtime_role_unsafe", fields);
    try {
      options.onUnsafe?.(report);
    } catch (error) {
      logger.error("db.runtime_role_hook_failed", errorLogFields(error));
    }
  } else if (report.issues.length > 0) {
    logger.warn("db.runtime_role_warning", fields);
  } else {
    logger.info("db.runtime_role_ok", { db_role: report.sessionUser });
  }
  return report;
}

const STARTED = Symbol.for("@cb/core/runtime-role-check-started");

/**
 * Starts {@link logRuntimeRoleCheck} in the background, once per process, only when
 * {@link shouldCheckRuntimeRole}. Returns whether it started.
 */
export function startRuntimeRoleCheck(
  runtime: Pick<ServiceRuntime, "db" | "logger">,
  options: RuntimeRoleCheckOptions & { readonly env?: Env } = {},
): boolean {
  if (!shouldCheckRuntimeRole(options.env)) return false;
  const holder = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (holder[STARTED]) return false;
  holder[STARTED] = true;
  void logRuntimeRoleCheck(runtime, options);
  return true;
}
