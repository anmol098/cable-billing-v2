/**
 * Audit trail writer (FR-024, PLAN §7.2 `audit_events`).
 *
 * Inside a service, use the `audit` recorder `defineService` passes to `run`: the event is written
 * in the service's own transaction (it commits or rolls back with the change) and the actor,
 * tenant, request id, IP and user agent come from the TenantContext.
 *
 * ```ts
 * await audit.record({
 *   entityType: "area",
 *   entityId: area.id,
 *   before: { name: old.name },
 *   after: { name: area.name },
 * });
 * ```
 *
 * For an audited capability (`CAPABILITIES[c].audited`) a successful service must call
 * `audit.record` at least once, or `audit.skip(reason)` when it changed nothing (an idempotent
 * replay); otherwise the transaction is rolled back and the call fails with INTERNAL.
 */
import { auditEvents, type Tx, type UserRole, uuidv7 } from "@cb/db";
import type { TenantContext } from "../context/tenant-context";
import { redactForAudit } from "./redact";

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]*$/;

export interface AuditEventInput {
  /** Dotted snake_case. Default: the service name (e.g. `areas.rename`). */
  readonly action?: string;
  /** snake_case entity type: `customer`, `vc_assignment`, `payment` … */
  readonly entityType: string;
  /** The entity's id (a UUID), when there is one. */
  readonly entityId?: string | null;
  /** Meaningful values before the change (redacted: see ./redact.ts). */
  readonly before?: unknown;
  /** Meaningful values after the change. */
  readonly after?: unknown;
}

/** Why an audited service wrote no event. Only for calls that changed nothing. */
export type AuditSkipReason = "idempotent_replay" | "no_change";

export interface AuditRecorder {
  /** Writes one audit event in the current transaction. */
  record(event: AuditEventInput): Promise<void>;
  /** Declares that this call changed nothing, so no event is due. */
  skip(reason: AuditSkipReason): void;
}

/** A complete audit row, for writers outside `defineService` (e.g. platform events, T-086). */
export interface AuditRow {
  readonly operatorId: string | null;
  readonly actorId: string | null;
  readonly actorRole: UserRole | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

/**
 * Inserts one audit event with `before`/`after` redacted. `tx` must be the transaction of the
 * change being audited (`withTenant` for tenant events; `withPlatform` with `operatorId: null` for
 * platform events). Returns the event id.
 */
export async function writeAuditEvent(tx: Tx, row: AuditRow): Promise<string> {
  if (!ACTION.test(row.action)) {
    throw new TypeError(`audit action must be dotted snake_case, got "${row.action}"`);
  }
  if (!ENTITY_TYPE.test(row.entityType)) {
    throw new TypeError(`audit entityType must be snake_case, got "${row.entityType}"`);
  }
  const id = uuidv7();
  await tx.insert(auditEvents).values({
    id,
    operatorId: row.operatorId,
    actorId: row.actorId,
    actorRole: row.actorRole,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? null,
    before: row.before === undefined ? null : redactForAudit(row.before),
    after: row.after === undefined ? null : redactForAudit(row.after),
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    requestId: row.requestId ?? null,
  });
  return id;
}

/** The recorder state `defineService` inspects after `run`. */
export interface TrackedAuditRecorder extends AuditRecorder {
  readonly recorded: number;
  readonly skipped: AuditSkipReason | undefined;
}

/** A recorder bound to one service call (context, transaction, default action). */
export function createAuditRecorder(
  tx: Tx,
  ctx: TenantContext,
  defaultAction: string,
): TrackedAuditRecorder {
  let recorded = 0;
  let skipped: AuditSkipReason | undefined;
  return {
    get recorded() {
      return recorded;
    },
    get skipped() {
      return skipped;
    },
    async record(event) {
      await writeAuditEvent(tx, {
        operatorId: ctx.operatorId,
        actorId: ctx.userId,
        actorRole: ctx.role,
        action: event.action ?? defaultAction,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        before: event.before,
        after: event.after,
        ip: ctx.client?.ip ?? null,
        userAgent: ctx.client?.userAgent ?? null,
        requestId: ctx.requestId,
      });
      recorded += 1;
    },
    skip(reason) {
      skipped = reason;
    },
  };
}
