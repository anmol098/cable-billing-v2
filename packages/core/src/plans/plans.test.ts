/**
 * Plan services against a real database (T-031): list with connection counts, add, change name
 * and price (names unique among active plans, ignoring capitals), retire and restore (idempotent,
 * connections keep their plan and rent), Owner only, read-only mode (D-13) and the audit trail.
 * The bills side (a price change never rewrites a bill; retired plans can't be given to new
 * connections) is in `bills.test.ts`.
 */
import {
  auditEvents,
  createDb,
  type DbClient,
  plans,
  type SubscriptionStatus,
  uuidv7,
} from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addConnection, disconnectConnection, suspendConnection } from "../connections/services";
import { ist, newCustomer, setupTenant } from "../connections/test-support";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { databaseFingerprint } from "../testing/fingerprint";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import {
  createPlan,
  listPlans,
  PlanAmountPaise,
  PlanName,
  type PlanView,
  restorePlan,
  retirePlan,
  updatePlan,
} from "./plans";

const NOW = new Date("2026-10-13T06:00:00.000Z");

describe("plan input rules (pure)", () => {
  it("tidies the name", () => {
    expect(PlanName.parse("  Sports \t  HD ")).toBe("Sports HD");
    expect(PlanName.parse("बेसिक पैक")).toBe("बेसिक पैक");
  });

  it.each([
    ["", "too_small"],
    ["   ", "too_small"],
    ["x".repeat(61), "too_big"],
    ["Basic\u001b", "custom"],
  ])("refuses the name %j (%s)", (name, code) => {
    const result = PlanName.safeParse(name);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe(code);
  });

  it("takes whole rupees from ₹0 to ₹1,00,000", () => {
    for (const ok of [0, 100, 25_000, 10_000_000]) expect(PlanAmountPaise.parse(ok)).toBe(ok);
  });

  it.each([
    [-100, "too_small"],
    [10_000_100, "too_big"],
    [25_050, "not_multiple_of"],
    [250.5, "invalid_type"],
  ])("refuses the amount %j (%s)", (amount, code) => {
    const result = PlanAmountPaise.safeParse(amount);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe(code);
  });
});

describeDb("plan services", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(subscription?: SubscriptionStatus | null): Promise<Setup> {
    const tenant = await seedTenant(t.current, subscription === undefined ? {} : { subscription });
    const rt = testRuntime(t.current.db, { now: () => NOW });
    return {
      tenant,
      rt,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
      lineman: await contextFor(rt, tenant, "lineman"),
    };
  }

  async function add(s: Setup, name: string, monthlyAmountPaise: number): Promise<PlanView> {
    const result = await createPlan.call(s.rt, s.owner, { name, monthlyAmountPaise });
    if (!result.ok) throw new Error(`add ${name}: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  async function auditFor(s: Setup, planId: string) {
    return t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.operatorId, s.tenant.operatorId),
            eq(auditEvents.entityId, planId),
            like(auditEvents.action, "plans.%"),
          ),
        )
        .orderBy(auditEvents.at, auditEvents.id),
    );
  }

  async function list(s: Setup, ctx: TenantContext = s.owner, includeRetired = true) {
    const result = await listPlans.call(s.rt, ctx, { includeRetired });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  describe("plans.list", () => {
    it("lists active plans by price, then hidden ones, with current connections only", async () => {
      const c = await setupTenant(t.current);
      const owner = c.owner;
      const rt = c.rt(ist("2026-10-13"));
      const make = async (name: string, monthlyAmountPaise: number) => {
        const r = await createPlan.call(rt, owner, { name, monthlyAmountPaise });
        if (!r.ok) throw new Error(r.error.code);
        return r.value;
      };
      const sports = await make("Sports", 40_000);
      const basic = await make("basic", 25_000);
      const free = await make("Free", 0);
      const old = await make("Old pack", 10_000);
      const connect = async (planId: string) => {
        const customerId = await newCustomer(c, ist("2026-10-13"));
        const r = await addConnection.call(rt, owner, {
          customerId,
          vcNumber: `PL${uuidv7().slice(-8)}`,
          planId,
          startDate: "2026-10-13",
        });
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return r.value.connection.assignmentId;
      };
      await connect(basic.id);
      const stopped = await connect(basic.id);
      const removed = await connect(basic.id);
      await connect(old.id);
      expect(
        (
          await suspendConnection.call(rt, owner, {
            assignmentId: stopped,
            effectiveDate: "2026-10-13",
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await disconnectConnection.call(rt, owner, {
            assignmentId: removed,
            effectiveDate: "2026-10-13",
            reason: "moved_away",
          })
        ).ok,
      ).toBe(true);
      expect((await retirePlan.call(rt, owner, { planId: old.id })).ok).toBe(true);

      const result = await listPlans.call(rt, c.staff, {});
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.plans).toEqual([
        { id: free.id, name: "Free", monthlyAmountPaise: 0, status: "active", connectionCount: 0 },
        // Active + stopped count; the removed connection is history.
        {
          id: basic.id,
          name: "basic",
          monthlyAmountPaise: 25_000,
          status: "active",
          connectionCount: 2,
        },
        {
          id: sports.id,
          name: "Sports",
          monthlyAmountPaise: 40_000,
          status: "active",
          connectionCount: 0,
        },
        {
          id: old.id,
          name: "Old pack",
          monthlyAmountPaise: 10_000,
          status: "retired",
          connectionCount: 1,
        },
      ]);
      expect(result.value).toMatchObject({ editable: false, readOnlyReason: "not_owner" });

      const picker = await listPlans.call(rt, owner, { includeRetired: false });
      expect(picker.ok && picker.value.plans.map((p) => p.id)).toEqual([
        free.id,
        basic.id,
        sports.id,
      ]);
      expect(picker.ok && picker.value).toMatchObject({ editable: true, readOnlyReason: null });
    });

    it("is empty for a new tenant and refused for linemen", async () => {
      const s = await setup();
      expect((await list(s)).plans).toEqual([]);
      const lineman = await listPlans.call(s.rt, s.lineman, {});
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
    });

    it("tells the Owner when the tenant is read-only", async () => {
      const s = await setup("read_only");
      expect((await list(s)).readOnlyReason).toBe("tenant_read_only");
    });
  });

  describe("plans.create", () => {
    it("adds an active plan with a tidy name and audits it", async () => {
      const s = await setup();
      const plan = await add(s, "  Sports   HD ", 45_000);
      expect(plan).toMatchObject({
        name: "Sports HD",
        monthlyAmountPaise: 45_000,
        status: "active",
        connectionCount: 0,
      });
      const audit = await auditFor(s, plan.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "plans.create",
        entityType: "plan",
        actorId: s.tenant.users.owner,
        actorRole: "owner",
        before: null,
        after: { name: "Sports HD", monthly_amount_paise: 45_000 },
      });
    });

    it("allows a ₹0 plan", async () => {
      const s = await setup();
      expect((await add(s, "Free", 0)).monthlyAmountPaise).toBe(0);
    });

    it("refuses an active plan's name (any capitals) and writes nothing", async () => {
      const s = await setup();
      await add(s, "Basic", 25_000);
      const before = await databaseFingerprint(t.current);
      const clash = await createPlan.call(s.rt, s.owner, {
        name: " BASIC ",
        monthlyAmountPaise: 30_000,
      });
      expect(!clash.ok && clash.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "name_taken" },
      });
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it("allows a hidden plan's name (a new price under the old name)", async () => {
      const s = await setup();
      const old = await add(s, "Basic", 25_000);
      await retirePlan.call(s.rt, s.owner, { planId: old.id });
      const next = await add(s, "basic", 30_000);
      expect(next.status).toBe("active");
      expect((await list(s)).plans.map((p) => [p.name, p.status])).toEqual([
        ["basic", "active"],
        ["Basic", "retired"],
      ]);
    });

    it("allows the same name in another tenant", async () => {
      const a = await setup();
      const b = await setup();
      await add(a, "Basic", 25_000);
      const other = await createPlan.call(b.rt, b.owner, {
        name: "Basic",
        monthlyAmountPaise: 25_000,
      });
      expect(other.ok).toBe(true);
    });

    it("refuses bad input with VALIDATION (paths and codes only)", async () => {
      const s = await setup();
      const before = await databaseFingerprint(t.current);
      const blank = await createPlan.call(s.rt, s.owner, { name: " ", monthlyAmountPaise: 100 });
      expect(!blank.ok && blank.error).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "name", code: "too_small" }] },
      });
      const paise = await createPlan.call(s.rt, s.owner, {
        name: "Basic",
        monthlyAmountPaise: 25_050,
      });
      expect(!paise.ok && paise.error).toMatchObject({
        code: "VALIDATION",
        details: { fields: [{ path: "monthlyAmountPaise", code: "not_multiple_of" }] },
      });
      const negative = await createPlan.call(s.rt, s.owner, {
        name: "Basic",
        monthlyAmountPaise: -100,
      });
      expect(!negative.ok && negative.error.code).toBe("VALIDATION");
      const huge = await createPlan.call(s.rt, s.owner, {
        name: "Basic",
        monthlyAmountPaise: 10_000_100,
      });
      expect(!huge.ok && huge.error.code).toBe("VALIDATION");
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });
  });

  describe("plans.update", () => {
    it("changes name and price; the audit names only what changed", async () => {
      const s = await setup();
      const plan = await add(s, "Basc", 25_000);

      const renamed = await updatePlan.call(s.rt, s.owner, {
        planId: plan.id,
        name: "Basic",
        monthlyAmountPaise: 25_000,
      });
      expect(renamed.ok && renamed.value).toEqual({
        plan: { ...plan, name: "Basic" },
        changed: ["name"],
      });

      const priced = await updatePlan.call(s.rt, s.owner, {
        planId: plan.id,
        name: "Basic",
        monthlyAmountPaise: 30_000,
      });
      expect(priced.ok && priced.value.changed).toEqual(["monthly_amount_paise"]);
      expect(priced.ok && priced.value.plan.monthlyAmountPaise).toBe(30_000);

      const audit = await auditFor(s, plan.id);
      expect(audit.map((a) => [a.action, a.before, a.after])).toEqual([
        ["plans.create", null, { name: "Basc", monthly_amount_paise: 25_000 }],
        ["plans.update", { name: "Basc" }, { name: "Basic" }],
        [
          "plans.update",
          { monthly_amount_paise: 25_000 },
          { monthly_amount_paise: 30_000, connection_count: 0 },
        ],
      ]);
    });

    it("saving the same values writes nothing and no audit event", async () => {
      const s = await setup();
      const plan = await add(s, "Basic", 25_000);
      const before = await databaseFingerprint(t.current);
      const same = await updatePlan.call(s.rt, s.owner, {
        planId: plan.id,
        name: "  Basic ",
        monthlyAmountPaise: 25_000,
      });
      expect(same.ok && same.value).toEqual({ plan, changed: [] });
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it("allows changing only the capitals", async () => {
      const s = await setup();
      const plan = await add(s, "basic", 25_000);
      const caps = await updatePlan.call(s.rt, s.owner, {
        planId: plan.id,
        name: "Basic",
        monthlyAmountPaise: 25_000,
      });
      expect(caps.ok && caps.value.plan.name).toBe("Basic");
    });

    it("refuses another active plan's name and an unknown id; writes nothing", async () => {
      const s = await setup();
      const basic = await add(s, "Basic", 25_000);
      await add(s, "Sports", 40_000);
      const before = await databaseFingerprint(t.current);
      const clash = await updatePlan.call(s.rt, s.owner, {
        planId: basic.id,
        name: "sports",
        monthlyAmountPaise: 26_000,
      });
      expect(!clash.ok && clash.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "name_taken" },
      });
      const missing = await updatePlan.call(s.rt, s.owner, {
        planId: uuidv7(),
        name: "X",
        monthlyAmountPaise: 100,
      });
      expect(!missing.ok && missing.error).toEqual({ code: "NOT_FOUND" });
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it("a hidden plan may take an active plan's name (only active names are unique)", async () => {
      const s = await setup();
      const old = await add(s, "Old basic", 20_000);
      await add(s, "Basic", 25_000);
      await retirePlan.call(s.rt, s.owner, { planId: old.id });
      const renamed = await updatePlan.call(s.rt, s.owner, {
        planId: old.id,
        name: "Basic",
        monthlyAmountPaise: 20_000,
      });
      expect(renamed.ok && renamed.value.plan).toMatchObject({ name: "Basic", status: "retired" });
    });
  });

  describe("plans.retire / plans.restore", () => {
    it("hides and shows again (idempotent) with an exact audit trail", async () => {
      const s = await setup();
      const plan = await add(s, "Basic", 25_000);

      const hidden = await retirePlan.call(s.rt, s.owner, { planId: plan.id });
      expect(hidden.ok && hidden.value).toEqual({ ...plan, status: "retired" });
      // Hiding twice changes nothing and writes no second event.
      const again = await retirePlan.call(s.rt, s.owner, { planId: plan.id });
      expect(again.ok && again.value.status).toBe("retired");

      const shown = await restorePlan.call(s.rt, s.owner, { planId: plan.id });
      expect(shown.ok && shown.value.status).toBe("active");
      expect((await restorePlan.call(s.rt, s.owner, { planId: plan.id })).ok).toBe(true);

      const audit = await auditFor(s, plan.id);
      expect(audit.map((a) => [a.action, a.before, a.after])).toEqual([
        ["plans.create", null, { name: "Basic", monthly_amount_paise: 25_000 }],
        ["plans.retire", { status: "active" }, { status: "retired", connection_count: 0 }],
        ["plans.restore", { status: "retired" }, { status: "active" }],
      ]);
    });

    it("refuses to show a plan again while an active plan has its name; writes nothing", async () => {
      const s = await setup();
      const old = await add(s, "Basic", 25_000);
      await retirePlan.call(s.rt, s.owner, { planId: old.id });
      await add(s, "BASIC", 30_000);
      const before = await databaseFingerprint(t.current);
      const clash = await restorePlan.call(s.rt, s.owner, { planId: old.id });
      expect(!clash.ok && clash.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "name_taken" },
      });
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it("has no delete: the row stays", async () => {
      const s = await setup();
      const plan = await add(s, "Basic", 25_000);
      await retirePlan.call(s.rt, s.owner, { planId: plan.id });
      const rows = await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
        tx.select({ id: plans.id }).from(plans).where(eq(plans.id, plan.id)),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe("who may change plans", () => {
    it("Staff and linemen get FORBIDDEN for every change; nothing changes", async () => {
      const s = await setup();
      const plan = await add(s, "Basic", 25_000);
      const before = await databaseFingerprint(t.current);
      for (const ctx of [s.staff, s.lineman]) {
        const results = [
          await createPlan.call(s.rt, ctx, { name: "Sports", monthlyAmountPaise: 40_000 }),
          await updatePlan.call(s.rt, ctx, {
            planId: plan.id,
            name: "Basic",
            monthlyAmountPaise: 1_000,
          }),
          await retirePlan.call(s.rt, ctx, { planId: plan.id }),
          await restorePlan.call(s.rt, ctx, { planId: plan.id }),
        ];
        for (const result of results) {
          expect(!result.ok && result.error.code).toBe("FORBIDDEN");
        }
      }
      expect(await databaseFingerprint(t.current)).toEqual(before);
    });

    it.each(["read_only", "cancelled", null] as const)(
      "a %s tenant's Owner gets TENANT_READ_ONLY for every change",
      async (status) => {
        const s = await setup(status);
        const planId = uuidv7();
        await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
          tx.insert(plans).values({
            id: planId,
            operatorId: s.tenant.operatorId,
            name: "Basic",
            monthlyAmountPaise: 25_000,
          }),
        );
        const before = await databaseFingerprint(t.current);
        const results = [
          await createPlan.call(s.rt, s.owner, { name: "Sports", monthlyAmountPaise: 40_000 }),
          await updatePlan.call(s.rt, s.owner, {
            planId,
            name: "Basic",
            monthlyAmountPaise: 1_000,
          }),
          await retirePlan.call(s.rt, s.owner, { planId }),
          await restorePlan.call(s.rt, s.owner, { planId }),
        ];
        for (const result of results) {
          expect(!result.ok && result.error.code).toBe("TENANT_READ_ONLY");
        }
        expect(await databaseFingerprint(t.current)).toEqual(before);
        // Reading still works (read-only mode allows every read).
        expect((await listPlans.call(s.rt, s.owner, {})).ok).toBe(true);
      },
    );
  });

  describe("two saves at once", () => {
    let pool: DbClient;
    beforeAll(() => {
      pool = createDb({
        connectionString: t.current.url,
        driver: "pg",
        max: 8,
        onIdleError: () => {},
      });
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("adding the same name four times at once: exactly one plan, the rest CONFLICT", async () => {
      const tenant = await seedTenant(t.current);
      const rt = testRuntime(pool, { now: () => NOW });
      const owner = await contextFor(rt, tenant, "owner");
      const results = await Promise.all(
        ["Basic", "basic", " BASIC", "Basic "].map((name) =>
          createPlan.call(rt, owner, { name, monthlyAmountPaise: 25_000 }),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.error.code).toBe("CONFLICT");
      const rows = await pool.withTenant(tenant.operatorId, (tx) =>
        tx.select({ id: plans.id }).from(plans),
      );
      expect(rows).toHaveLength(1);
    }, 30_000);
  });
});
