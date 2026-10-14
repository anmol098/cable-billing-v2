/**
 * "Who changed what" on 100k events (T-035 acceptance: "paginates 100k events smoothly"). One
 * tenant gets 100,000 events over a year (45 actions, 4 people + the app, 11 kinds of thing), a
 * second tenant 20,000 more. Every page the viewer asks for (first, next, deep, and each filter)
 * is timed through the real service (RLS, READ ONLY transaction, name lookups) and its plan is
 * checked: a keyset index range on `audit_events_operator_at_idx` (or the action, person or
 * entity index), never a scan of the whole table or a sort of the whole tenant's events.
 *
 * Timings and plans are written to stdout (`[audit-perf]` lines) for the completion notes. The
 * time limit is loose on purpose (shared CI machines); the plan checks are the real guard.
 */
import { auditEvents, type Tx } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { KNOWN_AUDIT_ACTIONS } from "./actions";
import { encodeAuditCursor } from "./cursor";
import { AUDIT_ORDER, listAuditEvents } from "./list";

type AuditListInput = Parameters<typeof listAuditEvents.call>[2];

const EVENTS = 100_000;
const NOISE = 20_000;
/** Generous: a page takes a few milliseconds locally (see the completion notes). */
const PAGE_BUDGET_MS = 750;

function report(line: string) {
  process.stdout.write(`[audit-perf] ${line}\n`);
}

describeDb("audit viewer on 100k events (T-035)", () => {
  const t = useTestDatabase();
  let tenant: SeededTenant;
  let rt: ServiceRuntime;
  let owner: TenantContext;
  let customerId: string;
  let deepCursor: string;

  beforeAll(async () => {
    tenant = await seedTenant(t.current);
    const other = await seedTenant(t.current);
    rt = testRuntime(t.current.db);
    owner = await contextFor(rt, tenant, "owner");
    const actions = KNOWN_AUDIT_ACTIONS.filter((a) => a !== "auth.two_factor_enabled");
    const entityTypes = [
      "customer",
      "vc_assignment",
      "payment",
      "receipt",
      "receipt_link",
      "collection_session",
      "billing_run",
      "user",
      "device",
      "area",
      "operator",
    ];
    const started = performance.now();
    // One statement per tenant: 100k events over 365 days, newest at 2026-10-13.
    const seed = (operatorId: string, users: SeededTenant["users"], count: number) =>
      t.current.admin.query(
        `INSERT INTO audit_events
           (id, operator_id, actor_id, actor_role, action, entity_type, entity_id, before, after, at)
         SELECT gen_random_uuid(), $1,
                (ARRAY[$2, $3, $4, NULL]::uuid[])[g % 5 + 1 - (g % 5 = 4)::int],
                (ARRAY['owner', 'staff', 'lineman', NULL]::user_role[])[g % 5 + 1 - (g % 5 = 4)::int],
                ($5::text[])[g % array_length($5::text[], 1) + 1],
                ($6::text[])[g % 11 + 1],
                gen_random_uuid(),
                jsonb_build_object('phone', '98765' || lpad((g % 100000)::text, 5, '0')),
                jsonb_build_object('phone', '91234' || lpad((g % 100000)::text, 5, '0'), 'amount_paise', g),
                timestamptz '2026-10-13 12:00:00+05:30' - (g * interval '315 seconds')
         FROM generate_series(1, $7::int) AS g`,
        [operatorId, users.owner, users.staff, users.lineman, actions, entityTypes, count],
      );
    await seed(tenant.operatorId, tenant.users, EVENTS);
    await seed(other.operatorId, other.users, NOISE);
    // A rare action (10 events spread over the year) and one customer's history (25 events).
    await t.current.admin.query(
      `INSERT INTO audit_events (id, operator_id, actor_id, actor_role, action, entity_type, at)
       SELECT gen_random_uuid(), $1, $2, 'owner', 'auth.two_factor_enabled', 'user',
              timestamptz '2026-10-13 00:00:00+05:30' - (g * interval '36 days')
       FROM generate_series(0, 9) AS g`,
      [tenant.operatorId, tenant.users.owner],
    );
    const customer = await t.current.admin.query<{ id: string }>("SELECT gen_random_uuid() AS id");
    customerId = customer.rows[0]?.id ?? "";
    await t.current.admin.query(
      `INSERT INTO audit_events (id, operator_id, actor_id, actor_role, action, entity_type, entity_id, at)
       SELECT gen_random_uuid(), $1, $2, 'staff', 'customers.update', 'customer', $3,
              timestamptz '2026-10-13 00:00:00+05:30' - (g * interval '14 days')
       FROM generate_series(0, 24) AS g`,
      [tenant.operatorId, tenant.users.staff, customerId],
    );
    await t.current.admin.query("ANALYZE audit_events");
    report(
      `seeded ${EVENTS + 35} + ${NOISE} events in ${Math.round(performance.now() - started)} ms`,
    );

    // The cursor of the 50,000th event (a deep page).
    const mid = await t.current.admin.query<{ at: string; id: string }>(
      `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, id
       FROM audit_events WHERE operator_id = $1 ORDER BY at DESC, id DESC OFFSET 50000 LIMIT 1`,
      [tenant.operatorId],
    );
    const row = mid.rows[0];
    if (!row) throw new Error("no middle event");
    deepCursor = encodeAuditCursor(row);
  }, 300_000);

  /** Best of 3 calls (the first warms caches), through the real service. */
  async function timed(name: string, input: AuditListInput) {
    let best = Number.POSITIVE_INFINITY;
    let count = 0;
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const result = await listAuditEvents.call(rt, owner, input);
      const elapsed = performance.now() - started;
      if (!result.ok) throw new Error(`${name}: ${result.error.code}`);
      count = result.value.events.length;
      best = Math.min(best, elapsed);
    }
    report(`${name}: ${count} events, best of 3 = ${best.toFixed(1)} ms (whole service call)`);
    return { best, count };
  }

  /** EXPLAIN ANALYZE of the page query as the app role (RLS on). */
  async function plan(name: string, where: (tx: Tx) => ReturnType<typeof and>) {
    return t.current.db.withTenant(tenant.operatorId, async (tx) => {
      const query = tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(where(tx))
        .orderBy(...AUDIT_ORDER)
        .limit(51)
        .toSQL();
      const result = await tx.execute(
        sql.raw(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query.sql.replace(/\$(\d+)/g, (_m, n) => {
            const value = query.params[Number(n) - 1];
            return typeof value === "number" ? String(value) : `'${String(value)}'`;
          })}`,
        ),
      );
      const lines = (result.rows as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]);
      report(`plan ${name}:\n    ${lines.join("\n    ")}`);
      return lines.join("\n");
    });
  }

  it("pages the newest events, the next page and a deep page quickly", async () => {
    const first = await timed("first page", {});
    expect(first.count).toBe(50);
    const firstPage = await listAuditEvents.call(rt, owner, {});
    if (!firstPage.ok || !firstPage.value.nextCursor) throw new Error("no next page");
    const second = await timed("second page", { cursor: firstPage.value.nextCursor });
    const deep = await timed("page after 50,000 events", { cursor: deepCursor });
    expect(deep.count).toBe(50);
    for (const run of [first, second, deep]) expect(run.best).toBeLessThan(PAGE_BUDGET_MS);

    const op = tenant.operatorId;
    const firstPlan = await plan("first page", () => eq(auditEvents.operatorId, op));
    const deepPlan = await plan("deep page", () =>
      and(
        eq(auditEvents.operatorId, op),
        sql`(${auditEvents.at}, ${auditEvents.id}) < (${"2026-04-01T00:00:00.000000Z"}::timestamptz, ${"ffffffff-ffff-ffff-ffff-ffffffffffff"}::uuid)`,
      ),
    );
    for (const text of [firstPlan, deepPlan]) {
      expect(text).toContain("audit_events_operator_at_idx");
      expect(text).not.toMatch(/Seq Scan|Sort Method/);
    }
    // The keyset bound is an index condition, not a filter over skipped rows.
    expect(deepPlan).toMatch(/Index Cond: .*ROW\(at, id\) < ROW/);
  }, 120_000);

  it("filters by person, the app, kind, action, one thing and one day quickly", async () => {
    const cases: [string, AuditListInput, number][] = [
      ["by person (staff)", { actor: tenant.users.staff }, 50],
      ["by the app itself", { actor: "system" }, 50],
      ["by kind (payment)", { entityType: "payment" }, 50],
      ["by action (customers.update_phone)", { action: "customers.update_phone" }, 50],
      ["by a rare action (10 in a year)", { action: "auth.two_factor_enabled" }, 10],
      ["one customer's history", { entityType: "customer", entityId: customerId }, 25],
      ["one day", { from: "2026-08-01", to: "2026-08-01" }, 50],
      [
        "staff + payment + 3 months",
        { actor: tenant.users.staff, entityType: "payment", from: "2026-07-01", to: "2026-09-30" },
        50,
      ],
    ];
    for (const [name, input, expected] of cases) {
      const run = await timed(name, input);
      expect(run.count, name).toBe(expected);
      expect(run.best, name).toBeLessThan(PAGE_BUDGET_MS);
    }
    const op = tenant.operatorId;
    const rarePlan = await plan("rare action", () =>
      and(eq(auditEvents.operatorId, op), eq(auditEvents.action, "auth.two_factor_enabled")),
    );
    const personPlan = await plan("by person", () =>
      and(eq(auditEvents.operatorId, op), eq(auditEvents.actorId, tenant.users.staff)),
    );
    const entityPlan = await plan("one customer", () =>
      and(
        eq(auditEvents.operatorId, op),
        eq(auditEvents.entityType, "customer"),
        eq(auditEvents.entityId, customerId),
      ),
    );
    for (const text of [rarePlan, personPlan, entityPlan]) {
      expect(text).not.toContain("Seq Scan");
    }
    // A rare action reads only its own events (migration 0012), not every tenant's.
    expect(rarePlan).toContain("audit_events_operator_action_idx");
    expect(entityPlan).toContain("audit_events_operator_entity_idx");
  }, 120_000);
});
