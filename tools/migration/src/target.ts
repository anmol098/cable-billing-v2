/**
 * The Postgres database the legacy tables are copied into, and the guard that keeps the copy (real
 * customer data) away from production.
 *
 * The target comes from `MIGRATION_TARGET_URL` only. `DATABASE_URL` is deliberately ignored so a
 * URL left in a shell for other work is never picked up by accident.
 *
 * Guard rules (all must pass; none can be switched off except where noted):
 *
 * 1. **Not a production environment:** `VERCEL_ENV=production`, `NODE_ENV=production` or
 *    `CB_MIGRATION_FORBIDDEN=1` refuse.
 * 2. **A postgres:// URL** whose host, database and user names do not contain `prod`, `production`
 *    or `live` (Neon prod project / `main` branch names, a `cable_billing_prod` database …).
 * 3. **Local by default:** a non-local host is refused unless the caller passes the exact host name
 *    (`--allow-remote <host>`), which is a deliberate act for one specific Neon branch.
 * 4. **Remote targets must declare themselves non-production:** after connecting, the database
 *    setting `cb.migration_target` must be `non-prod`. A human sets it once on the Neon
 *    migration branch (`ALTER DATABASE neondb SET cb.migration_target = 'non-prod';`). The
 *    production project never has it, so even a production URL passed with `--allow-remote`
 *    is refused. (Checked in `assertTargetDeclaredNonProd`.)
 */
import type pg from "pg";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PROD_WORDS = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;

export const TARGET_MARKER_SETTING = "cb.migration_target";
export const TARGET_MARKER_VALUE = "non-prod";

export type TargetCheck =
  | { readonly ok: true; readonly url: string; readonly host: string; readonly local: boolean }
  | { readonly ok: false; readonly reason: string };

export function checkTarget(input: {
  readonly url: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The exact host the caller allows for a remote target (`--allow-remote <host>`). */
  readonly allowRemoteHost?: string | undefined;
}): TargetCheck {
  const { env } = input;
  if (
    env.VERCEL_ENV === "production" ||
    env.NODE_ENV === "production" ||
    env.CB_MIGRATION_FORBIDDEN === "1"
  ) {
    return {
      ok: false,
      reason:
        "Refusing: this looks like a production environment (VERCEL_ENV/NODE_ENV=production or " +
        "CB_MIGRATION_FORBIDDEN=1). Legacy staging runs on a developer machine or a secure runner.",
    };
  }
  if (!input.url) {
    return {
      ok: false,
      reason:
        "MIGRATION_TARGET_URL is not set. Point it at a local Postgres or a non-production Neon " +
        "branch, e.g. postgres://postgres:postgres@localhost:5432/cb_legacy_stage",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, reason: "MIGRATION_TARGET_URL is not a valid postgres:// URL." };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, reason: "MIGRATION_TARGET_URL must be a postgres:// URL." };
  }
  const host = parsed.hostname;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(parsed.username);
  for (const [what, value] of [
    ["host", host],
    ["database", database],
    ["user", user],
  ] as const) {
    if (PROD_WORDS.test(value)) {
      return {
        ok: false,
        reason: `Refusing: the target ${what} name "${value}" looks like production.`,
      };
    }
  }
  const local = LOCAL_HOSTS.has(host);
  if (!local && input.allowRemoteHost !== host) {
    return {
      ok: false,
      reason:
        `Refusing the remote host "${host}". Legacy data may only go to a non-production Neon ` +
        `branch: pass --allow-remote ${host} to confirm this exact host, and make sure the ` +
        `database has ${TARGET_MARKER_SETTING} = '${TARGET_MARKER_VALUE}' (see docs/migration/README.md).`,
    };
  }
  return { ok: true, url: input.url, host, local };
}

/** Rule 4: a remote database must carry the non-production marker. Local databases need not. */
export async function assertTargetDeclaredNonProd(
  client: pg.ClientBase,
  check: Extract<TargetCheck, { ok: true }>,
): Promise<void> {
  if (check.local) return;
  const result = await client.query<{ value: string | null }>(
    "SELECT current_setting($1, true) AS value",
    [TARGET_MARKER_SETTING],
  );
  const value = result.rows[0]?.value ?? null;
  if (value !== TARGET_MARKER_VALUE) {
    throw new Error(
      `Refusing: the remote database does not declare itself non-production ` +
        `(${TARGET_MARKER_SETTING} is ${value === null || value === "" ? "unset" : `"${value}"`}). ` +
        `On the Neon migration branch run: ALTER DATABASE <db> SET ${TARGET_MARKER_SETTING} = ` +
        `'${TARGET_MARKER_VALUE}'; then reconnect.`,
    );
  }
}

/** `host:port/database` for messages (no credentials). */
export function describeTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
}
