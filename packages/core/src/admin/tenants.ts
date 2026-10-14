/**
 * Tenants list and tenant detail for the platform admin (T-086, PLAN §12.4).
 *
 * Platform path only (`withPlatform`, READ WRITE for the audit event): operators, subscriptions,
 * users, sessions, refresh tokens, jobs, Razorpay events, grants and offline payments are platform
 * readable; customers, billing runs and invariant checks only through the column grants of
 * `PLATFORM_READ_COLUMNS` (statuses, counts, times). Nothing here can read a customer's name, a
 * payment, an invoice or a balance: the database refuses those columns to `app_platform`.
 * Every call writes a platform audit event (`admin.tenants_listed`, `admin.tenant_viewed`).
 */
import {
  type BillingRunStatus,
  type BillingRunTrigger,
  type Language,
  OFFLINE_PAYMENT_METHODS,
  type OfflinePaymentMethod,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  type Tx,
} from "@cb/db";
import { err, ok } from "@cb/domain";
import { sql } from "drizzle-orm";
import * as z from "zod";
import { notFound } from "../errors/errors";
import { asDate, asInt } from "./rows";
import { defineAdminService } from "./service";

export const ADMIN_TENANTS_PAGE_SIZE = 50;

export interface AdminTenantRow {
  readonly operatorId: string;
  readonly name: string;
  readonly operatorStatus: "active" | "suspended";
  readonly createdAt: Date;
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly graceEndsAt: Date | null;
  readonly activeCustomers: number;
  readonly linemen: number;
  /** Latest web session activity or lineman token refresh (sign-in activity, not data). */
  readonly lastActivityAt: Date | null;
}

export const ListTenantsInput = z.object({
  /** Part of the business name. */
  q: z.string().trim().max(120).optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
});

/** Per-tenant aggregate columns, as SQL (shared by list and detail). */
const LAST_ACTIVITY = sql`greatest(
  (SELECT max(se.updated_at) FROM sessions se JOIN users su ON su.id = se.user_id
    WHERE su.operator_id = o.id),
  (SELECT max(m.created_at) FROM mobile_refresh_tokens m WHERE m.operator_id = o.id)
)`;

function tenantRow(r: Record<string, unknown>): AdminTenantRow {
  return {
    operatorId: String(r.operator_id),
    name: String(r.name),
    operatorStatus: r.operator_status === "suspended" ? "suspended" : "active",
    createdAt: asDate(r.created_at) ?? new Date(0),
    subscriptionStatus: (r.subscription_status as SubscriptionStatus | null) ?? null,
    trialEndsAt: asDate(r.trial_ends_at),
    currentPeriodEnd: asDate(r.current_period_end),
    graceEndsAt: asDate(r.grace_ends_at),
    activeCustomers: asInt(r.active_customers),
    linemen: asInt(r.linemen),
    lastActivityAt: asDate(r.last_activity_at),
  };
}

async function selectTenants(
  tx: Tx,
  where: ReturnType<typeof sql>,
  limit: number,
  offset: number,
): Promise<AdminTenantRow[]> {
  const result = await tx.execute(sql`
    SELECT o.id AS operator_id, o.name, o.status AS operator_status, o.created_at,
           s.status AS subscription_status, s.trial_ends_at, s.current_period_end, s.grace_ends_at,
           (SELECT count(*)::int FROM customers c
             WHERE c.operator_id = o.id AND c.status = 'active') AS active_customers,
           (SELECT count(*)::int FROM users u
             WHERE u.operator_id = o.id AND u.role = 'lineman' AND u.status = 'active') AS linemen,
           ${LAST_ACTIVITY} AS last_activity_at
      FROM operators o
      LEFT JOIN subscriptions s ON s.operator_id = o.id
     WHERE ${where}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${limit} OFFSET ${offset}`);
  return result.rows.map((r) => tenantRow(r as Record<string, unknown>));
}

export const listTenants = defineAdminService({
  name: "admin.tenants_list",
  input: ListTenantsInput,
  async run({ input, runtime, audit }) {
    return ok(
      await runtime.db.withPlatform(async (tx) => {
        const filters = [sql`true`];
        if (input.q) {
          const pattern = `%${input.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
          filters.push(sql`o.name ILIKE ${pattern}`);
        }
        if (input.status) filters.push(sql`s.status = ${input.status}`);
        const where = sql.join(filters, sql` AND `);
        const offset = (input.page - 1) * ADMIN_TENANTS_PAGE_SIZE;
        const rows = await selectTenants(tx, where, ADMIN_TENANTS_PAGE_SIZE + 1, offset);
        const totals = await tx.execute(sql`
          SELECT coalesce(s.status::text, 'none') AS status, count(*)::int AS n
            FROM operators o LEFT JOIN subscriptions s ON s.operator_id = o.id
           GROUP BY 1`);
        const byStatus: Record<string, number> = {};
        for (const r of totals.rows as Record<string, unknown>[]) {
          byStatus[String(r.status)] = asInt(r.n);
        }
        await audit.platform(tx, {
          action: "admin.tenants_listed",
          entityType: "operator",
          after: { page: input.page, status: input.status ?? null, searched: Boolean(input.q) },
        });
        return {
          rows: rows.slice(0, ADMIN_TENANTS_PAGE_SIZE),
          page: input.page,
          hasMore: rows.length > ADMIN_TENANTS_PAGE_SIZE,
          countsByStatus: byStatus,
        };
      }),
    );
  },
});

export interface AdminTenantDetail {
  readonly tenant: AdminTenantRow;
  readonly businessPhone: string | null;
  readonly defaultLanguage: Language | null;
  /** Our customer's contact (the operator's owners): platform account data, not tenant records. */
  readonly owners: readonly {
    readonly userId: string;
    readonly name: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly status: "active" | "disabled";
  }[];
  readonly subscription: {
    readonly cancelledAt: Date | null;
    readonly razorpayStatus: string | null;
    readonly planCode: string | null;
  } | null;
  readonly counts: {
    readonly customers: { readonly active: number; readonly inactive: number };
    readonly users: Readonly<Record<"owner" | "staff" | "lineman", number>>;
  };
  readonly billingRuns: readonly AdminBillingRunSummary[];
  readonly latestInvariantCheck: {
    readonly checkedAt: Date;
    readonly status: "ok" | "breach";
    readonly violationCount: number;
    readonly counts: Readonly<Record<string, number>>;
  } | null;
  readonly failedJobs: number;
  readonly offlinePayments: readonly {
    readonly id: string;
    readonly amountPaise: number;
    readonly method: OfflinePaymentMethod;
    readonly reference: string | null;
    readonly receivedOn: string;
    readonly months: number;
    readonly paidUntil: Date;
    readonly recordedAt: Date;
    readonly recordedByName: string | null;
  }[];
  readonly supportGrants: readonly AdminSupportGrant[];
  /** Platform audit events about this tenant, newest first. */
  readonly timeline: readonly AdminTimelineEvent[];
}

export interface AdminBillingRunSummary {
  readonly runId: string;
  readonly period: string;
  readonly status: BillingRunStatus;
  readonly trigger: BillingRunTrigger;
  readonly customerCount: number;
  readonly createdCount: number;
  readonly alreadyExistsCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly finishedAt: Date | null;
}

export interface AdminSupportGrant {
  readonly grantId: string;
  readonly adminUserId: string;
  readonly adminName: string | null;
  readonly reason: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
  /** Not ended and not expired at the time of the read. */
  readonly active: boolean;
}

export interface AdminTimelineEvent {
  readonly id: string;
  readonly action: string;
  readonly at: Date;
  readonly actorName: string | null;
  readonly after: unknown;
}

export const TenantDetailInput = z.object({ operatorId: z.uuid() });

export function billingRunSummary(r: Record<string, unknown>): AdminBillingRunSummary {
  return {
    runId: String(r.id),
    period: String(r.period),
    status: String(r.status) as BillingRunStatus,
    trigger: String(r.trigger) as BillingRunTrigger,
    customerCount: asInt(r.customer_count),
    createdCount: asInt(r.created_count),
    alreadyExistsCount: asInt(r.already_exists_count),
    skippedCount: asInt(r.skipped_count),
    failedCount: asInt(r.failed_count),
    finishedAt: asDate(r.finished_at),
  };
}

export function supportGrantOf(r: Record<string, unknown>, now: Date): AdminSupportGrant {
  const expiresAt = asDate(r.expires_at) ?? new Date(0);
  const endedAt = asDate(r.ended_at);
  return {
    grantId: String(r.id),
    adminUserId: String(r.admin_user_id),
    adminName: r.admin_name === null || r.admin_name === undefined ? null : String(r.admin_name),
    reason: String(r.reason),
    grantedAt: asDate(r.granted_at) ?? new Date(0),
    expiresAt,
    endedAt,
    active: endedAt === null && expiresAt.getTime() > now.getTime(),
  };
}

export const tenantDetail = defineAdminService({
  name: "admin.tenant_detail",
  input: TenantDetailInput,
  async run({ input, runtime, audit, now }) {
    const op = input.operatorId;
    const detail = await runtime.db.withPlatform(async (tx) => {
      const base = await selectTenants(tx, sql`o.id = ${op}`, 1, 0);
      const tenant = base[0];
      if (!tenant) return null;
      const extra = await tx.execute(sql`
        SELECT o.phone, o.settings->>'default_language' AS default_language,
               s.cancelled_at, s.razorpay_status, s.plan_code, (s.operator_id IS NOT NULL) AS has_sub
          FROM operators o LEFT JOIN subscriptions s ON s.operator_id = o.id
         WHERE o.id = ${op}`);
      const e = (extra.rows[0] ?? {}) as Record<string, unknown>;
      const owners = await tx.execute(sql`
        SELECT id, name, email, phone, status FROM users
         WHERE operator_id = ${op} AND role = 'owner' ORDER BY created_at, id`);
      const customerCounts = await tx.execute(sql`
        SELECT status::text AS status, count(*)::int AS n FROM customers
         WHERE operator_id = ${op} GROUP BY status`);
      const userCounts = await tx.execute(sql`
        SELECT role::text AS role, count(*)::int AS n FROM users
         WHERE operator_id = ${op} AND status = 'active' GROUP BY role`);
      const runs = await tx.execute(sql`
        SELECT id, period::text AS period, status, trigger, customer_count, created_count, already_exists_count,
               skipped_count, failed_count, finished_at
          FROM billing_runs WHERE operator_id = ${op} ORDER BY period DESC LIMIT 6`);
      const invariant = await tx.execute(sql`
        SELECT checked_at, status, violation_count, counts FROM invariant_checks
         WHERE operator_id = ${op} ORDER BY checked_at DESC, id DESC LIMIT 1`);
      const failedJobs = await tx.execute(sql`
        SELECT count(*)::int AS n FROM jobs WHERE operator_id = ${op} AND status = 'failed'`);
      const offline = await tx.execute(sql`
        SELECT p.id, p.amount_paise, p.method, p.reference, p.received_on::text AS received_on, p.months, p.paid_until,
               p.recorded_at, u.name AS recorded_by_name
          FROM subscription_offline_payments p LEFT JOIN users u ON u.id = p.recorded_by
         WHERE p.operator_id = ${op} ORDER BY p.recorded_at DESC, p.id DESC LIMIT 20`);
      const grants = await tx.execute(sql`
        SELECT g.id, g.admin_user_id, u.name AS admin_name, g.reason, g.granted_at, g.expires_at,
               g.ended_at
          FROM support_access_grants g LEFT JOIN users u ON u.id = g.admin_user_id
         WHERE g.operator_id = ${op} ORDER BY g.granted_at DESC, g.id DESC LIMIT 20`);
      const timeline = await tx.execute(sql`
        SELECT a.id, a.action, a.at, a.after, u.name AS actor_name
          FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.operator_id IS NULL AND a.entity_type = 'operator' AND a.entity_id = ${op}
           AND a.action NOT IN ('admin.tenant_viewed', 'admin.support_data_viewed')
         ORDER BY a.at DESC, a.id DESC LIMIT 30`);
      await audit.platform(tx, {
        action: "admin.tenant_viewed",
        entityType: "operator",
        entityId: op,
      });

      const customers = { active: 0, inactive: 0 };
      for (const r of customerCounts.rows as Record<string, unknown>[]) {
        if (r.status === "active") customers.active = asInt(r.n);
        else customers.inactive += asInt(r.n);
      }
      const users = { owner: 0, staff: 0, lineman: 0 };
      for (const r of userCounts.rows as Record<string, unknown>[]) {
        const role = String(r.role);
        if (role === "owner" || role === "staff" || role === "lineman") users[role] = asInt(r.n);
      }
      const inv = invariant.rows[0] as Record<string, unknown> | undefined;
      const language = e.default_language;
      const result: AdminTenantDetail = {
        tenant,
        businessPhone: e.phone === null || e.phone === undefined ? null : String(e.phone),
        defaultLanguage: language === "hi" || language === "en" ? language : null,
        owners: (owners.rows as Record<string, unknown>[]).map((r) => ({
          userId: String(r.id),
          name: String(r.name),
          email: r.email === null ? null : String(r.email),
          phone: r.phone === null ? null : String(r.phone),
          status: r.status === "disabled" ? ("disabled" as const) : ("active" as const),
        })),
        subscription: e.has_sub
          ? {
              cancelledAt: asDate(e.cancelled_at),
              razorpayStatus: e.razorpay_status === null ? null : String(e.razorpay_status),
              planCode: e.plan_code === null ? null : String(e.plan_code),
            }
          : null,
        counts: { customers, users },
        billingRuns: (runs.rows as Record<string, unknown>[]).map(billingRunSummary),
        latestInvariantCheck: inv
          ? {
              checkedAt: asDate(inv.checked_at) ?? new Date(0),
              status: inv.status === "breach" ? "breach" : "ok",
              violationCount: asInt(inv.violation_count),
              counts: (inv.counts ?? {}) as Record<string, number>,
            }
          : null,
        failedJobs: asInt((failedJobs.rows[0] as Record<string, unknown> | undefined)?.n),
        offlinePayments: (offline.rows as Record<string, unknown>[]).map((r) => ({
          id: String(r.id),
          amountPaise: asInt(r.amount_paise),
          method: (OFFLINE_PAYMENT_METHODS as readonly string[]).includes(String(r.method))
            ? (r.method as OfflinePaymentMethod)
            : "bank_transfer",
          reference: r.reference === null ? null : String(r.reference),
          receivedOn: String(r.received_on),
          months: asInt(r.months),
          paidUntil: asDate(r.paid_until) ?? new Date(0),
          recordedAt: asDate(r.recorded_at) ?? new Date(0),
          recordedByName: r.recorded_by_name === null ? null : String(r.recorded_by_name),
        })),
        supportGrants: (grants.rows as Record<string, unknown>[]).map((r) =>
          supportGrantOf(r, now),
        ),
        timeline: (timeline.rows as Record<string, unknown>[]).map((r) => ({
          id: String(r.id),
          action: String(r.action),
          at: asDate(r.at) ?? new Date(0),
          actorName: r.actor_name === null ? null : String(r.actor_name),
          after: r.after ?? null,
        })),
      };
      return result;
    });
    return detail ? ok(detail) : err(notFound());
  },
});
