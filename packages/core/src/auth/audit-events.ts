/**
 * Audit events for sign-in, sign-out, password reset and 2FA (FR-024).
 *
 * A tenant user's event goes into that tenant's log (`withTenant`, so the owner sees it in the
 * audit viewer); a platform admin's event is a platform event (`withPlatform`, `operator_id`
 * NULL). Events carry ids, the role, the request id, IP and user agent (the audit table's own
 * columns), and a small `after` with codes only: never a login, email, password or token.
 *
 * Writing the event never fails the request (the sign-in or sign-out already happened): a failure
 * is logged as `auth.audit_failed`.
 */
import type { DbClient, UserRole } from "@cb/db";
import { writeAuditEvent } from "../audit/audit";
import { errorLogFields, type Logger } from "../logging/logger";
import { clientInfo, requestIdFromHeaders } from "./request-info";

export const AUTH_AUDIT_ACTIONS = [
  "auth.signed_in",
  "auth.sign_in_blocked",
  "auth.signed_out",
  "auth.signed_out_everywhere",
  "auth.password_reset_requested",
  "auth.password_reset_completed",
  "auth.two_factor_enabled",
  /** T-086b: turning on TOTP ended the user's other sessions (`{ sessions, reason }`). */
  "auth.other_sessions_ended",
] as const;
export type AuthAuditAction = (typeof AUTH_AUDIT_ACTIONS)[number];

export interface AuthAuditSubject {
  readonly userId: string;
  readonly role: UserRole;
  /** `null` for a platform admin. */
  readonly operatorId: string | null;
}

export async function recordAuthEvent(
  deps: { db: Pick<DbClient, "withTenant" | "withPlatform">; logger: Logger },
  event: {
    action: AuthAuditAction;
    subject: AuthAuditSubject;
    headers: Headers;
    /** Codes/counts only (e.g. `{ method: "password" }`). */
    after?: Record<string, string | number | boolean>;
  },
): Promise<void> {
  const client = clientInfo(event.headers);
  const requestId = requestIdFromHeaders(event.headers);
  const { subject } = event;
  try {
    const write = (tx: Parameters<typeof writeAuditEvent>[0]) =>
      writeAuditEvent(tx, {
        operatorId: subject.operatorId,
        actorId: subject.userId,
        actorRole: subject.role,
        action: event.action,
        entityType: "user",
        entityId: subject.userId,
        after: event.after,
        ip: client?.ip ?? null,
        userAgent: client?.userAgent ?? null,
        requestId,
      });
    if (subject.operatorId === null) await deps.db.withPlatform(write);
    else await deps.db.withTenant(subject.operatorId, write);
  } catch (error) {
    deps.logger.error("auth.audit_failed", {
      action: event.action,
      user_id: subject.userId,
      request_id: requestId,
      ...errorLogFields(error),
    });
  }
}
