/** Test helpers for the admin services (Vitest only). */
import { randomBytes } from "node:crypto";
import { sessions, uuidv7 } from "@cb/db";
import { createUser, type TestDatabase } from "@cb/db/testing";
import type { ServiceRuntime } from "../context/runtime";
import { newRequestId } from "../context/runtime";
import { type AdminContext, resolveAdminContext } from "./context";

/** A platform admin user (no tenant), with TOTP on unless `twoFactor: false`. */
export async function seedPlatformAdmin(
  database: Pick<TestDatabase, "admin">,
  options: { twoFactor?: boolean; name?: string } = {},
): Promise<string> {
  const admin = await createUser(database, {
    operatorId: null,
    ...(options.name ? { name: options.name } : {}),
  });
  if (options.twoFactor !== false) {
    await database.admin.query("UPDATE users SET two_factor_enabled = true WHERE id = $1", [
      admin.userId,
    ]);
  }
  return admin.userId;
}

/**
 * A web session row for `userId` (8 hours), as Better Auth would store it. `totp: false` makes a
 * password-only session (T-086b); by default it passed TOTP. Returns the session id.
 */
export async function seedWebSession(
  runtime: Pick<ServiceRuntime, "db">,
  userId: string,
  options: { totp?: boolean; expiresAt?: Date } = {},
): Promise<string> {
  const id = uuidv7();
  await runtime.db.withPlatform((tx) =>
    tx.insert(sessions).values({
      id,
      userId,
      token: randomBytes(24).toString("base64url"),
      expiresAt: options.expiresAt ?? new Date(Date.now() + 8 * 3_600_000),
      twoFactorVerifiedAt: options.totp === false ? null : new Date(),
    }),
  );
  return id;
}

/** A real AdminContext (through `resolveAdminContext`, over a TOTP-verified session). */
export async function adminContextFor(
  runtime: Pick<ServiceRuntime, "db">,
  userId: string,
): Promise<AdminContext> {
  const result = await resolveAdminContext(runtime, {
    userId,
    sessionId: await seedWebSession(runtime, userId),
    requestId: newRequestId(),
  });
  if (!result.ok) throw new Error(`adminContextFor: ${result.error.code}`);
  return result.value;
}

/** Platform audit events (operator_id NULL), oldest first, read through the owner pool. */
export async function platformAuditActions(
  database: Pick<TestDatabase, "admin">,
  actorId: string,
): Promise<string[]> {
  const rows = await database.admin.query<{ action: string }>(
    "SELECT action FROM audit_events WHERE operator_id IS NULL AND actor_id = $1 ORDER BY at, id",
    [actorId],
  );
  return rows.rows.map((r) => r.action);
}
