/**
 * Rental plans (T-031, FR-007, PLAN §7.2, §9.3): the monthly rents an operator offers. A connection
 * picks a plan (or an own amount) when it is added (T-034).
 *
 * - `plans.list` (`dashboard.view`: Owner and Staff): every plan with how many current connections
 *   are on it, and whether this user may change plans (Owner, tenant writable).
 * - `plans.create`, `plans.update`, `plans.retire`, `plans.restore` (`plans.manage`: Owner only,
 *   audited, refused in read-only mode).
 *
 * **A price change never rewrites history (FR-007, BR-07).** A connection copies the plan's amount
 * into its own `rental_amount_paise` when the plan is given to it (T-034), and the billing run
 * (T-044) reads that copy and copies it again into the bill's lines. So editing a plan's amount
 * changes neither a bill already made nor what the plan's existing connections pay: only
 * connections that get the plan from now on use the new amount. Moving existing connections to
 * the new amount is an explicit plan change per connection, with its own date (T-045); the page
 * says how many connections are on the plan (`connectionCount`).
 *
 * **There is no delete** (the database refuses it, T-022). A plan is taken out of use by retiring
 * it ("Hide" on the page): a retired plan is not offered for new connections and
 * `connections.add` / `connections.change_plan` refuse it (T-034), but the connections that have it
 * keep it and their rent. Retiring can be undone (`plans.restore`). Same pattern as areas (T-030).
 *
 * Names are unique per operator among **active** plans, ignoring capitals and outer spaces
 * (`plans_operator_active_name_unique`). A retired plan may share a name with an active one
 * ("Basic" at ₹250 retired, a new "Basic" at ₹300). Adding, renaming or restoring into a clash
 * gives CONFLICT with `details.reason = "name_taken"`.
 *
 * Amounts are integer paise in whole rupees (D-17): 0 (free connections exist) up to ₹1,00,000,
 * the same ceiling as a connection's own amount (T-034).
 */
import { type PlanStatus, plans, type Tx, uuidv7, vcAssignments } from "@cb/db";
import { err, ok, type Result } from "@cb/domain";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "../authz/capabilities";
import { readTenantMode } from "../authz/writable";
import { CONNECTION_LIMITS } from "../connections/rules";
import { defineService } from "../context/service";
import type { TenantContext } from "../context/tenant-context";
import { notFound, type ServiceError, serviceError } from "../errors/errors";
import type { SettingsAccess } from "../operators/access";
import { requiredLine } from "../operators/text";

/** Longest plan name. */
export const PLAN_NAME_MAX = 60;

/** Largest monthly amount of a plan: ₹1,00,000 (as for a connection's own amount). */
export const PLAN_AMOUNT_MAX_PAISE = CONNECTION_LIMITS.maxRentalPaise;

/** A plan name: one line, spaces collapsed, 1–60 characters, no control characters. */
export const PlanName = requiredLine(PLAN_NAME_MAX);

/** A plan's monthly amount: integer paise, whole rupees, 0 … ₹1,00,000. */
export const PlanAmountPaise = z
  .number()
  .int()
  .min(0)
  .max(PLAN_AMOUNT_MAX_PAISE)
  .multipleOf(100, { message: "whole_rupees" });

export interface PlanView {
  readonly id: string;
  readonly name: string;
  /** Integer paise (whole rupees). */
  readonly monthlyAmountPaise: number;
  /** `active`: offered for new connections. `retired`: hidden, kept by its connections. */
  readonly status: PlanStatus;
  /** Connections on this plan now: active or stopped, not removed. */
  readonly connectionCount: number;
}

export interface PlanListView extends SettingsAccess {
  /** Active plans first, then retired ones; each group by amount, then name. */
  readonly plans: readonly PlanView[];
}

/** A changed plan field (stored names, as in the audit event). */
export type PlanField = "name" | "monthly_amount_paise";

export interface PlanUpdateResult {
  readonly plan: PlanView;
  /** Empty when nothing changed (then nothing was written). */
  readonly changed: readonly PlanField[];
}

/** A name already used by another active plan of this operator. */
export type PlanNameTaken = ServiceError<"CONFLICT">;

/**
 * Whether the signed-in user may change plans right now: only the Owner (`plans.manage`), and not
 * while the tenant is read-only (D-13). The write services enforce the same on their own.
 */
export async function plansAccess(tx: Tx, ctx: TenantContext): Promise<SettingsAccess> {
  if (!can(ctx.role, "plans.manage")) return { editable: false, readOnlyReason: "not_owner" };
  if ((await readTenantMode(tx)) === "read_only") {
    return { editable: false, readOnlyReason: "tenant_read_only" };
  }
  return { editable: true, readOnlyReason: null };
}

const planColumns = {
  id: plans.id,
  name: plans.name,
  monthlyAmountPaise: plans.monthlyAmountPaise,
  status: plans.status,
};

type PlanRow = { id: string; name: string; monthlyAmountPaise: number; status: PlanStatus };

const toView = (row: PlanRow, connectionCount: number): PlanView => ({
  id: row.id,
  name: row.name,
  monthlyAmountPaise: Number(row.monthlyAmountPaise),
  status: row.status,
  connectionCount,
});

/** A connection that is still a customer's (active or stopped). Removed ones are history. */
const currentConnection = ne(vcAssignments.status, "disconnected");

async function connectionCountOf(tx: Tx, planId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(vcAssignments)
    .where(and(eq(vcAssignments.planId, planId), currentConnection));
  return row?.n ?? 0;
}

/** CONFLICT `name_taken` when another **active** plan has this name (capitals ignored). */
async function checkNameFree(
  tx: Tx,
  name: string,
  exceptId?: string,
): Promise<Result<void, PlanNameTaken>> {
  const [clash] = await tx
    .select({ id: plans.id })
    .from(plans)
    .where(
      and(
        eq(plans.status, "active"),
        sql`lower(btrim(${plans.name})) = lower(btrim(${name}))`,
        exceptId === undefined ? undefined : ne(plans.id, exceptId),
      ),
    )
    .limit(1);
  if (!clash) return ok(undefined);
  return err(
    serviceError("CONFLICT", "Another plan in use already has this name", {
      reason: "name_taken",
    }),
  );
}

/** Locks one plan of the tenant (another tenant's id is simply not there: NOT_FOUND). */
async function lockPlan(tx: Tx, planId: string): Promise<PlanRow | undefined> {
  const [row] = await tx
    .select(planColumns)
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1)
    .for("update");
  return row;
}

/** Every plan of the tenant with its connection count, and whether this user may change them. */
export const listPlans = defineService({
  name: "plans.list",
  capability: "dashboard.view",
  input: z.object({
    /** False: only active plans (for pickers). Default true (the settings page). */
    includeRetired: z.boolean().default(true),
  }),
  async run({ ctx, input, tx }) {
    const rows = await tx
      .select({ ...planColumns, connectionCount: count(vcAssignments.id) })
      .from(plans)
      .leftJoin(
        vcAssignments,
        and(
          eq(vcAssignments.operatorId, plans.operatorId),
          eq(vcAssignments.planId, plans.id),
          currentConnection,
        ),
      )
      .where(input.includeRetired ? undefined : eq(plans.status, "active"))
      .groupBy(plans.id)
      .orderBy(
        sql`${plans.status} <> 'active'`,
        asc(plans.monthlyAmountPaise),
        sql`lower(${plans.name})`,
        asc(plans.id),
      );
    const view: PlanListView = {
      plans: rows.map((row) => toView(row, row.connectionCount)),
      ...(await plansAccess(tx, ctx)),
    };
    return ok(view);
  },
});

/** Adds an active plan. Owner only. */
export const createPlan = defineService({
  name: "plans.create",
  capability: "plans.manage",
  input: z.object({ name: PlanName, monthlyAmountPaise: PlanAmountPaise }),
  async run({ ctx, input, tx, audit, now }) {
    const free = await checkNameFree(tx, input.name);
    if (!free.ok) return err(free.error);
    const [row] = await tx
      .insert(plans)
      .values({
        id: uuidv7(),
        operatorId: ctx.operatorId,
        name: input.name,
        monthlyAmountPaise: input.monthlyAmountPaise,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning(planColumns);
    if (!row) throw new Error("plan insert returned no row");
    await audit.record({
      entityType: "plan",
      entityId: row.id,
      after: { name: row.name, monthly_amount_paise: Number(row.monthlyAmountPaise) },
    });
    return ok(toView(row, 0));
  },
});

/**
 * Changes a plan's name and/or monthly amount. The new amount is used only by connections that
 * get the plan from now on: bills already made and the plan's existing connections keep their
 * amounts (see the module comment). Saving the same values writes nothing. Owner only.
 */
export const updatePlan = defineService({
  name: "plans.update",
  capability: "plans.manage",
  input: z.object({ planId: z.uuid(), name: PlanName, monthlyAmountPaise: PlanAmountPaise }),
  async run({ input, tx, audit, now }) {
    const before = await lockPlan(tx, input.planId);
    if (!before) return err(notFound());
    const connectionCount = await connectionCountOf(tx, before.id);
    const changed: PlanField[] = [];
    if (before.name !== input.name) changed.push("name");
    if (Number(before.monthlyAmountPaise) !== input.monthlyAmountPaise) {
      changed.push("monthly_amount_paise");
    }
    if (changed.length === 0) {
      audit.skip("no_change");
      const result: PlanUpdateResult = { plan: toView(before, connectionCount), changed };
      return ok(result);
    }
    if (changed.includes("name") && before.status === "active") {
      const free = await checkNameFree(tx, input.name, before.id);
      if (!free.ok) return err(free.error);
    }
    const [after] = await tx
      .update(plans)
      .set({ name: input.name, monthlyAmountPaise: input.monthlyAmountPaise, updatedAt: now })
      .where(eq(plans.id, before.id))
      .returning(planColumns);
    if (!after) return err(notFound());
    const beforeAudit: Record<string, unknown> = {};
    const afterAudit: Record<string, unknown> = {};
    if (changed.includes("name")) {
      beforeAudit.name = before.name;
      afterAudit.name = after.name;
    }
    if (changed.includes("monthly_amount_paise")) {
      beforeAudit.monthly_amount_paise = Number(before.monthlyAmountPaise);
      afterAudit.monthly_amount_paise = Number(after.monthlyAmountPaise);
      // The connections that keep the old amount (nothing is applied to them).
      afterAudit.connection_count = connectionCount;
    }
    await audit.record({
      entityType: "plan",
      entityId: after.id,
      before: beforeAudit,
      after: afterAudit,
    });
    const result: PlanUpdateResult = { plan: toView(after, connectionCount), changed };
    return ok(result);
  },
});

const PlanIdInput = z.object({ planId: z.uuid() });

/**
 * Retires a plan ("Hide"): no longer offered for new connections; its connections keep it and
 * their rent. Retiring a retired plan changes nothing. Owner only.
 */
export const retirePlan = defineService({
  name: "plans.retire",
  capability: "plans.manage",
  input: PlanIdInput,
  async run({ input, tx, audit, now }) {
    const before = await lockPlan(tx, input.planId);
    if (!before) return err(notFound());
    const connectionCount = await connectionCountOf(tx, before.id);
    if (before.status === "retired") {
      audit.skip("no_change");
      return ok(toView(before, connectionCount));
    }
    const [after] = await tx
      .update(plans)
      .set({ status: "retired", updatedAt: now })
      .where(eq(plans.id, before.id))
      .returning(planColumns);
    if (!after) return err(notFound());
    await audit.record({
      entityType: "plan",
      entityId: after.id,
      before: { status: "active" },
      after: { status: "retired", connection_count: connectionCount },
    });
    return ok(toView(after, connectionCount));
  },
});

/**
 * Puts a retired plan back in use ("Show again"). CONFLICT `name_taken` when an active plan has
 * its name meanwhile. Restoring an active plan changes nothing. Owner only.
 */
export const restorePlan = defineService({
  name: "plans.restore",
  capability: "plans.manage",
  input: PlanIdInput,
  async run({ input, tx, audit, now }) {
    const before = await lockPlan(tx, input.planId);
    if (!before) return err(notFound());
    const connectionCount = await connectionCountOf(tx, before.id);
    if (before.status === "active") {
      audit.skip("no_change");
      return ok(toView(before, connectionCount));
    }
    const free = await checkNameFree(tx, before.name, before.id);
    if (!free.ok) return err(free.error);
    const [after] = await tx
      .update(plans)
      .set({ status: "active", updatedAt: now })
      .where(eq(plans.id, before.id))
      .returning(planColumns);
    if (!after) return err(notFound());
    await audit.record({
      entityType: "plan",
      entityId: after.id,
      before: { status: "retired" },
      after: { status: "active" },
    });
    return ok(toView(after, connectionCount));
  },
});
