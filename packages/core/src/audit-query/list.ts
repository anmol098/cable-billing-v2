/**
 * "Who changed what" (T-035, FR-024, PLAN §9.3 "Audit log": Owner only): the tenant's audit
 * events, newest first, filtered by IST days, person, kind of thing, action or one thing's id,
 * with keyset pagination that stays fast on 100k+ events.
 *
 * Capability `audit.view` (Owner; a read, so it runs READ ONLY and works in read-only mode).
 * Staff and linemen get FORBIDDEN from the service itself, whatever the page does. A person filter
 * naming another tenant's user is NOT_FOUND, like a made-up id.
 *
 * Each event comes back ready to show: who did it (name + role at the time, or the app itself),
 * the action's sentence values (./actions.ts), the entity's name (./labels.ts) and the redacted,
 * masked change list (./present.ts). Raw `before`/`after`, IPs and user agents never leave here.
 */
import { auditEvents, type UserRole, users } from "@cb/db";
import { addDays, type BusinessDate, err, istStartOfDay, ok } from "@cb/domain";
import { and, asc, eq, gte, isNull, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDateInput, idInput } from "../collections/inputs";
import { defineService } from "../context/service";
import { notFound, serviceError } from "../errors/errors";
import {
  type AuditDetails,
  type AuditValue,
  auditDetails,
  isAuditEntityType,
  isKnownAuditAction,
} from "./actions";
import { type AuditCursor, decodeAuditCursor, encodeAuditCursor } from "./cursor";
import { loadEntityLabels } from "./labels";
import { type AuditChange, auditChanges } from "./present";

/** Events per page by default, and at most. */
export const AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 100;

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]*$/;

export const ListAuditEventsInput = z
  .object({
    /** First IST business date (inclusive). */
    from: businessDateInput.optional(),
    /** Last IST business date (inclusive). */
    to: businessDateInput.optional(),
    /** Who did it: a user of this business, or `system` (jobs, the app itself). */
    actor: z.union([z.literal("system"), idInput]).optional(),
    /** Kind of thing (`customer`, `payment`, …). */
    entityType: z.string().max(64).regex(ENTITY_TYPE).optional(),
    /** One thing's history (e.g. a customer's id). */
    entityId: idInput.optional(),
    /** One action (`customers.update_phone`). */
    action: z.string().max(100).regex(ACTION).optional(),
    /** `nextCursor` of the previous page. */
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(MAX_AUDIT_PAGE_SIZE).default(AUDIT_PAGE_SIZE),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "The last day is before the first day",
    path: ["to"],
  })
  // One thing's history uses `audit_events_operator_entity_idx (operator_id, entity_type,
  // entity_id, at)`, which needs the kind too (ids are only unique per table).
  .refine((value) => !value.entityId || value.entityType, {
    message: "Say what kind of thing the id is",
    path: ["entityType"],
  });

export type ListAuditEventsCommand = z.output<typeof ListAuditEventsInput>;

/** Who did it. `person` with `name: null` when the name can't be read (platform support). */
export type AuditActor =
  | {
      readonly kind: "person";
      readonly id: string;
      readonly name: string | null;
      readonly role: UserRole;
    }
  | { readonly kind: "system" };

export interface AuditEventView {
  readonly id: string;
  /** When it happened (UTC; the web shows IST). */
  readonly at: Date;
  readonly actor: AuditActor;
  readonly action: string;
  /** False for an action this viewer has no sentence for (shown with the generic sentence). */
  readonly known: boolean;
  readonly entityType: string;
  /** False for an entity type the viewer has no word for ("other"). */
  readonly knownEntityType: boolean;
  /** The entity's name, `null` when there is none or it no longer exists. */
  readonly target: AuditValue | null;
  /** Values for the action's sentence (amount, status, the customer of a connection, …). */
  readonly details: AuditDetails;
  /** Before/after rows, redacted and masked. */
  readonly changes: readonly AuditChange[];
}

/** Someone the "Who" filter offers. */
export interface AuditActorOption {
  readonly id: string;
  readonly name: string;
  readonly role: UserRole;
  readonly active: boolean;
}

export interface AuditEventPage {
  readonly events: readonly AuditEventView[];
  /** Pass as `cursor` for the next (older) page; `null` on the last page. */
  readonly nextCursor: string | null;
  readonly actors: readonly AuditActorOption[];
}

/**
 * Newest first, exactly as `audit_events_operator_at_idx` is sorted (`at DESC NULLS LAST, id DESC
 * NULLS LAST`). A plain `DESC` means NULLS FIRST, which the index can't give, and Postgres then
 * reads and sorts every event of the tenant (seen on 100k events: a parallel seq scan + top-N
 * sort). Both columns are NOT NULL, so the order is the same.
 */
export const AUDIT_ORDER = [
  sql`${auditEvents.at} DESC NULLS LAST`,
  sql`${auditEvents.id} DESC NULLS LAST`,
] as const;

/** `YYYY-MM-DDTHH:MI:SS.US` + `Z`: the event time with Postgres's microseconds, for the cursor. */
const atText = sql<string>`to_char(${auditEvents.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function filters(operatorId: string, input: ListAuditEventsCommand, cursor: AuditCursor | null) {
  const conditions: SQL[] = [eq(auditEvents.operatorId, operatorId)];
  if (input.from) conditions.push(gte(auditEvents.at, istStartOfDay(input.from)));
  if (input.to) {
    conditions.push(lt(auditEvents.at, istStartOfDay(addDays(input.to as BusinessDate, 1))));
  }
  if (input.actor === "system") conditions.push(isNull(auditEvents.actorId));
  else if (input.actor) conditions.push(eq(auditEvents.actorId, input.actor));
  if (input.entityType) conditions.push(eq(auditEvents.entityType, input.entityType));
  if (input.entityId) conditions.push(eq(auditEvents.entityId, input.entityId));
  if (input.action) conditions.push(eq(auditEvents.action, input.action));
  if (cursor) {
    // A row comparison: one index range on (operator_id, at DESC, id DESC).
    conditions.push(
      sql`(${auditEvents.at}, ${auditEvents.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  return and(...conditions) as SQL;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const listAuditEvents = defineService({
  name: "audit.list",
  capability: "audit.view",
  input: ListAuditEventsInput,
  async run({ ctx, input, tx }) {
    const op = ctx.operatorId;
    let cursor: AuditCursor | null = null;
    if (input.cursor !== undefined) {
      cursor = decodeAuditCursor(input.cursor);
      if (!cursor) {
        return err(
          serviceError("VALIDATION", "Not a page cursor", {
            fields: [{ path: "cursor", code: "invalid" }],
          }),
        );
      }
    }

    const people = await tx
      .select({ id: users.id, name: users.name, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.operatorId, op))
      .orderBy(asc(users.name), asc(users.id));
    if (input.actor && input.actor !== "system" && !people.some((p) => p.id === input.actor)) {
      return err(notFound());
    }

    const found = await tx
      .select({
        id: auditEvents.id,
        at: auditEvents.at,
        atText,
        actorId: auditEvents.actorId,
        actorRole: auditEvents.actorRole,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        before: auditEvents.before,
        after: auditEvents.after,
      })
      .from(auditEvents)
      .where(filters(op, input, cursor))
      .orderBy(...AUDIT_ORDER)
      .limit(input.limit + 1);

    const page = found.slice(0, input.limit);
    const labels = await loadEntityLabels(tx, op, page);
    const names = new Map(people.map((p) => [p.id, p.name]));

    const events: AuditEventView[] = page.map((row) => {
      const before = asRecord(row.before);
      const after = asRecord(row.after);
      const label = row.entityId ? labels.get(`${row.entityType}:${row.entityId}`) : undefined;
      const known = isKnownAuditAction(row.action);
      const actor: AuditActor =
        row.actorId && row.actorRole
          ? {
              kind: "person",
              id: row.actorId,
              name: names.get(row.actorId) ?? null,
              role: row.actorRole,
            }
          : { kind: "system" };
      return {
        id: row.id,
        at: row.at,
        actor,
        action: row.action,
        known,
        entityType: row.entityType,
        knownEntityType: isAuditEntityType(row.entityType),
        target: label?.target ?? null,
        details: { ...(label?.extra ?? {}), ...auditDetails(row.action, { before, after }) },
        changes: auditChanges(before, after),
      };
    });

    const last = page.at(-1);
    const nextCursor =
      found.length > input.limit && last
        ? encodeAuditCursor({ at: last.atText, id: last.id })
        : null;
    const value: AuditEventPage = {
      events,
      nextCursor,
      actors: people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        active: p.status === "active",
      })),
    };
    return ok(value);
  },
});
