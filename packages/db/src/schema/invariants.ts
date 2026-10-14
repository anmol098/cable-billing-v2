/**
 * Nightly invariant check results (T-052, PLAN §14 `invariants`, PLAN §8.4 invariants 1–4).
 *
 * **`invariant_checks`**: one row per tenant per check run. The nightly job
 * (`packages/core/src/invariants`) checks each tenant's books with set-based SQL and stores what it
 * found here, in that tenant's `withTenant` transaction:
 * - `run_id`: the check run (the platform job's id). UNIQUE per tenant, so a re-run of the same job
 *   (lease expiry) can't store a tenant twice.
 * - `status`: `ok` (nothing found) or `breach` (`violation_count` > 0); CHECK keeps them in step.
 * - `counts`: violation code → number of violating rows (codes: `INVARIANT_CODES` in @cb/core).
 * - `samples`: up to a fixed number of violating rows per code, **ids and paise amounts only**
 *   (no names, phone numbers or free text), for whoever investigates.
 *
 * Tenant table (standard tenant policy). T-086 (`./platform-admin.ts`) lets `app_platform` read the
 * status and counts for the admin console, never `samples`. **Append-only** (custom migration): a
 * check result is evidence of the state of the books at that time and is never edited or deleted.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { operators } from "./tenancy";

/** `invariant_checks.status`. */
export const INVARIANT_CHECK_STATUSES = ["ok", "breach"] as const;
export type InvariantCheckStatus = (typeof INVARIANT_CHECK_STATUSES)[number];
export const invariantCheckStatusEnum = pgEnum("invariant_check_status", INVARIANT_CHECK_STATUSES);

/** One stored violation sample (ids and paise amounts only). */
export interface InvariantCheckSample {
  readonly code: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly customerId: string | null;
  readonly details: Readonly<Record<string, string | number>>;
}

export const invariantChecks = pgTable(
  "invariant_checks",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    /** The check run (the `invariants.check` job's id). */
    runId: uuid("run_id").notNull(),
    /** When the tenant was checked (the job's clock). */
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    status: invariantCheckStatusEnum("status").notNull(),
    violationCount: integer("violation_count").notNull(),
    /** Violation code → count. */
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    /** A bounded sample of violating rows per code. */
    samples: jsonb("samples").$type<InvariantCheckSample[]>().notNull().default([]),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    unique("invariant_checks_one_per_run").on(t.operatorId, t.runId),
    index("invariant_checks_checked_at_idx").on(t.operatorId, t.checkedAt),
    check("invariant_checks_violation_count_not_negative", sql`${t.violationCount} >= 0`),
    check(
      "invariant_checks_status_matches_count",
      sql`(${t.status} = 'ok') = (${t.violationCount} = 0)`,
    ),
    check("invariant_checks_counts_object", sql`jsonb_typeof(${t.counts}) = 'object'`),
    check("invariant_checks_samples_array", sql`jsonb_typeof(${t.samples}) = 'array'`),
    check("invariant_checks_duration_not_negative", sql`${t.durationMs} >= 0`),
    ...tenantPolicies(t),
  ],
).enableRLS();
