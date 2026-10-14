/**
 * Support access (T-086, PLAN §9.4, PRD §3): the only way a platform admin sees a tenant's own
 * records, and only a small, read-only support view of them.
 *
 * - **Open** (`admin.support_access_grant`): reason required (10–500 characters), time-boxed to
 *   {@link SUPPORT_ACCESS_MAX_MINUTES} (CHECK in the database). Written in the **tenant's**
 *   transaction with a `support.access_granted` event in the tenant's audit log, so the Owner sees
 *   who opened it, why and until when; then a platform event. One live grant per admin and tenant:
 *   opening again while one is live returns it unchanged (the expiry is never extended).
 * - **Use** (`admin.support_view`): every request checks, inside the same tenant transaction it
 *   reads in and against the server clock, that this admin has a grant for this tenant that is not
 *   ended and not expired; otherwise FORBIDDEN `support_access_required`. Each view writes
 *   `support.data_viewed` to the tenant's log (and a platform event).
 * - **End** (`admin.support_access_end`): ends a live grant early (`support.access_ended`).
 *
 * The view holds what support needs to help (team and sign-in state, plans, areas, bill runs and
 * their problems, failed jobs, the last books check) and **no** payments, invoices, ledger,
 * balances, customer names or phone numbers.
 */
import {
  operators,
  SUPPORT_ACCESS_MAX_MINUTES,
  SUPPORT_REASON_MAX_LENGTH,
  SUPPORT_REASON_MIN_LENGTH,
  supportAccessGrants,
  type Tx,
  uuidv7,
} from "@cb/db";
import { err, ok } from "@cb/domain";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import * as z from "zod";
import { notFound, serviceError } from "../errors/errors";
import type { AdminContext } from "./context";
import { asDate, asInt } from "./rows";
import { defineAdminService } from "./service";
import { type AdminBillingRunSummary, billingRunSummary } from "./tenants";

export const GrantSupportAccessInput = z.object({
  operatorId: z.uuid(),
  reason: z.string().trim().min(SUPPORT_REASON_MIN_LENGTH).max(SUPPORT_REASON_MAX_LENGTH),
  /** Default and maximum: SUPPORT_ACCESS_MAX_MINUTES. */
  minutes: z
    .number()
    .int()
    .min(15)
    .max(SUPPORT_ACCESS_MAX_MINUTES)
    .default(SUPPORT_ACCESS_MAX_MINUTES),
});

export interface SupportGrantView {
  readonly grantId: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
}

/** This admin's live grant on the tenant of `tx` (a `withTenant` transaction), or null. */
async function liveGrant(tx: Tx, ctx: AdminContext, now: Date): Promise<SupportGrantView | null> {
  const rows = await tx
    .select({
      grantId: supportAccessGrants.id,
      operatorId: supportAccessGrants.operatorId,
      reason: supportAccessGrants.reason,
      grantedAt: supportAccessGrants.grantedAt,
      expiresAt: supportAccessGrants.expiresAt,
    })
    .from(supportAccessGrants)
    .where(
      and(
        eq(supportAccessGrants.adminUserId, ctx.userId),
        isNull(supportAccessGrants.endedAt),
        gt(supportAccessGrants.expiresAt, now),
        // Not granted in the future either (a clock that went backwards).
        sql`${supportAccessGrants.grantedAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(supportAccessGrants.expiresAt))
    .limit(1);
  return rows[0] ?? null;
}

async function operatorExists(tx: Tx, operatorId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: operators.id })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .limit(1);
  return rows.length > 0;
}

export const grantSupportAccess = defineAdminService({
  name: "admin.support_access_grant",
  input: GrantSupportAccessInput,
  async run({ ctx, input, runtime, audit, now }) {
    const op = input.operatorId;
    const outcome = await runtime.db.withTenant(op, async (tx) => {
      if (!(await operatorExists(tx, op))) return null;
      const existing = await liveGrant(tx, ctx, now);
      if (existing) return { status: "already_open" as const, grant: existing };
      const grant: SupportGrantView = {
        grantId: uuidv7(),
        operatorId: op,
        reason: input.reason,
        grantedAt: now,
        expiresAt: new Date(now.getTime() + input.minutes * 60_000),
      };
      await tx.insert(supportAccessGrants).values({
        id: grant.grantId,
        operatorId: op,
        adminUserId: ctx.userId,
        reason: grant.reason,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
      });
      await audit.tenant(tx, op, {
        action: "support.access_granted",
        entityType: "support_access",
        entityId: grant.grantId,
        after: { reason: grant.reason, minutes: input.minutes, expires_at: grant.expiresAt },
      });
      return { status: "opened" as const, grant };
    });
    if (!outcome) return err(notFound());
    await runtime.db.withPlatform((tx) =>
      audit.platform(tx, {
        action: "admin.support_access_granted",
        entityType: "operator",
        entityId: op,
        after: {
          grant_id: outcome.grant.grantId,
          status: outcome.status,
          reason: outcome.grant.reason,
          expires_at: outcome.grant.expiresAt,
        },
      }),
    );
    return ok(outcome);
  },
});

export const EndSupportAccessInput = z.object({ operatorId: z.uuid(), grantId: z.uuid() });

export const endSupportAccess = defineAdminService({
  name: "admin.support_access_end",
  input: EndSupportAccessInput,
  async run({ ctx, input, runtime, audit, now }) {
    const op = input.operatorId;
    const ended = await runtime.db.withTenant(op, async (tx) => {
      const rows = await tx
        .update(supportAccessGrants)
        .set({ endedAt: now, endedBy: ctx.userId })
        .where(
          and(
            eq(supportAccessGrants.id, input.grantId),
            isNull(supportAccessGrants.endedAt),
            gt(supportAccessGrants.expiresAt, now),
          ),
        )
        .returning({ id: supportAccessGrants.id });
      if (rows.length === 0) return false;
      await audit.tenant(tx, op, {
        action: "support.access_ended",
        entityType: "support_access",
        entityId: input.grantId,
        after: { ended_at: now },
      });
      return true;
    });
    if (!ended) {
      return err(serviceError("CONFLICT", "No live support access to end", { reason: "not_live" }));
    }
    await runtime.db.withPlatform((tx) =>
      audit.platform(tx, {
        action: "admin.support_access_ended",
        entityType: "operator",
        entityId: op,
        after: { grant_id: input.grantId },
      }),
    );
    return ok({ grantId: input.grantId, endedAt: now });
  },
});

export interface SupportView {
  readonly grant: SupportGrantView;
  readonly operator: {
    readonly name: string;
    readonly phone: string | null;
    readonly status: string;
  };
  readonly team: readonly {
    readonly name: string;
    readonly login: string;
    readonly role: "owner" | "staff" | "lineman";
    readonly status: "active" | "disabled";
    readonly lastWebActivityAt: Date | null;
    readonly activePhones: number;
  }[];
  readonly plans: readonly {
    readonly name: string;
    readonly monthlyAmountPaise: number;
    readonly status: string;
  }[];
  readonly areaCount: number;
  readonly billingRuns: readonly AdminBillingRunSummary[];
  /** Failed items of those runs: the customer code and the reason only. */
  readonly billingProblems: readonly {
    readonly period: string;
    readonly customerCode: string;
    readonly reason: string;
    readonly attempts: number;
  }[];
  readonly failedJobs: readonly {
    readonly jobId: string;
    readonly type: string;
    readonly attempts: number;
    readonly lastError: string | null;
    readonly finishedAt: Date | null;
  }[];
  readonly latestInvariantCheck: {
    readonly checkedAt: Date;
    readonly status: string;
    readonly counts: Readonly<Record<string, number>>;
  } | null;
}

export const SupportViewInput = z.object({ operatorId: z.uuid() });

export const supportView = defineAdminService({
  name: "admin.support_view",
  input: SupportViewInput,
  async run({ ctx, input, runtime, audit, now }) {
    const op = input.operatorId;
    const view = await runtime.db.withTenant(op, async (tx) => {
      const grant = await liveGrant(tx, ctx, now);
      if (!grant) return null;
      const operator = await tx.execute(sql`
        SELECT name, phone, status::text AS status FROM operators WHERE id = ${op}`);
      const team = await tx.execute(sql`
        SELECT u.name, u.login, u.role::text AS role, u.status::text AS status,
               (SELECT max(se.updated_at) FROM sessions se WHERE se.user_id = u.id) AS last_web,
               (SELECT count(*)::int FROM devices d
                 WHERE d.user_id = u.id AND d.operator_id = u.operator_id AND d.revoked_at IS NULL)
                 AS phones
          FROM users u WHERE u.operator_id = ${op}
         ORDER BY u.role, u.name, u.id LIMIT 200`);
      const plans = await tx.execute(sql`
        SELECT name, monthly_amount_paise, status::text AS status FROM plans
         WHERE operator_id = ${op} ORDER BY status, name LIMIT 200`);
      const areas = await tx.execute(sql`
        SELECT count(*)::int AS n FROM areas WHERE operator_id = ${op}`);
      const runs = await tx.execute(sql`
        SELECT id, period::text AS period, status, trigger, customer_count, created_count,
               already_exists_count, skipped_count, failed_count, finished_at
          FROM billing_runs WHERE operator_id = ${op} ORDER BY period DESC LIMIT 6`);
      const problems = await tx.execute(sql`
        SELECT r.period::text AS period, c.customer_code, i.reason, i.attempts
          FROM billing_run_items i
          JOIN billing_runs r ON r.operator_id = i.operator_id AND r.id = i.run_id
          JOIN customers c ON c.operator_id = i.operator_id AND c.id = i.customer_id
         WHERE i.operator_id = ${op} AND i.outcome = 'failed'
         ORDER BY r.period DESC, c.customer_code LIMIT 100`);
      const jobs = await tx.execute(sql`
        SELECT id, type, attempts, last_error, finished_at FROM jobs
         WHERE operator_id = ${op} AND status = 'failed'
         ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 20`);
      const invariant = await tx.execute(sql`
        SELECT checked_at, status::text AS status, counts FROM invariant_checks
         WHERE operator_id = ${op} ORDER BY checked_at DESC, id DESC LIMIT 1`);
      await audit.tenant(tx, op, {
        action: "support.data_viewed",
        entityType: "support_access",
        entityId: grant.grantId,
        after: { expires_at: grant.expiresAt },
      });
      const o = (operator.rows[0] ?? {}) as Record<string, unknown>;
      const inv = invariant.rows[0] as Record<string, unknown> | undefined;
      const result: SupportView = {
        grant,
        operator: {
          name: String(o.name ?? ""),
          phone: o.phone === null || o.phone === undefined ? null : String(o.phone),
          status: String(o.status ?? ""),
        },
        team: (team.rows as Record<string, unknown>[]).map((r) => ({
          name: String(r.name),
          login: String(r.login),
          role: r.role === "owner" || r.role === "staff" ? r.role : "lineman",
          status: r.status === "disabled" ? "disabled" : "active",
          lastWebActivityAt: asDate(r.last_web),
          activePhones: asInt(r.phones),
        })),
        plans: (plans.rows as Record<string, unknown>[]).map((r) => ({
          name: String(r.name),
          monthlyAmountPaise: asInt(r.monthly_amount_paise),
          status: String(r.status),
        })),
        areaCount: asInt((areas.rows[0] as Record<string, unknown> | undefined)?.n),
        billingRuns: (runs.rows as Record<string, unknown>[]).map(billingRunSummary),
        billingProblems: (problems.rows as Record<string, unknown>[]).map((r) => ({
          period: String(r.period),
          customerCode: String(r.customer_code),
          reason: String(r.reason ?? ""),
          attempts: asInt(r.attempts),
        })),
        failedJobs: (jobs.rows as Record<string, unknown>[]).map((r) => ({
          jobId: String(r.id),
          type: String(r.type),
          attempts: asInt(r.attempts),
          lastError: r.last_error === null ? null : String(r.last_error),
          finishedAt: asDate(r.finished_at),
        })),
        latestInvariantCheck: inv
          ? {
              checkedAt: asDate(inv.checked_at) ?? new Date(0),
              status: String(inv.status),
              counts: (inv.counts ?? {}) as Record<string, number>,
            }
          : null,
      };
      return result;
    });
    if (!view) {
      return err(
        serviceError("FORBIDDEN", "No live support access", {
          reason: "support_access_required",
        }),
      );
    }
    await runtime.db.withPlatform((tx) =>
      audit.platform(tx, {
        action: "admin.support_data_viewed",
        entityType: "operator",
        entityId: op,
        after: { grant_id: view.grant.grantId },
      }),
    );
    return ok(view);
  },
});
