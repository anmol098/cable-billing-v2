/**
 * Customer import services against a real database (T-084): the preview writes nothing and names
 * every problem; the import goes through the customer and connection services (audit events,
 * counters, VC assets, hooks); one customer is all-or-nothing; uploading again skips existing
 * codes and changes nothing; names are matched only inside the tenant; roles and read-only mode.
 */
import { areas, assignmentEvents, auditEvents, customers, vcAssets, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { err } from "@cb/domain";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionHooks } from "../connections/hooks";
import { addConnection } from "../connections/services";
import { addPlan, type ConnectionSetup, ist, setupTenant } from "../connections/test-support";
import { createCustomer, updateCustomer } from "../customers/customers";
import { serviceError } from "../errors/errors";
import { changedTables, databaseFingerprint } from "../testing/fingerprint";
import { setSubscriptionStatus } from "../testing/fixtures";
import { IMPORT_FIELDS, type ImportField } from "./columns";
import type { ImportLine } from "./file";
import { applyCustomerImport, checkCustomerImport, importSteps } from "./services";
import type { ImportCheckResult, ImportLineResult } from "./types";

const NOW = ist("2026-10-14");
const TODAY = "2026-10-14";

function line(n: number, values: Partial<Record<ImportField, string>>): ImportLine {
  const all = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ""])) as Record<ImportField, string>;
  return { line: n, values: { ...all, ...values } };
}

function byLine(result: ImportCheckResult): Map<number, ImportLineResult> {
  return new Map(result.lines.map((l) => [l.line, l]));
}

describeDb("customer import services", () => {
  const t = useTestDatabase();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup() {
    const s = await setupTenant(t.current);
    const basic = await addPlan(s, "Basic Pack", 30_000);
    await addPlan(s, "Old Pack", 20_000, "retired");
    const north = await s.tx(async (tx) => {
      const [row] = await tx
        .insert(areas)
        .values({ operatorId: s.op, name: "Ward 5" })
        .returning({ id: areas.id });
      await tx.insert(areas).values({ operatorId: s.op, name: "Old Town", archivedAt: NOW });
      return row?.id ?? "";
    });
    return { s, basic, north };
  }

  const check = (s: ConnectionSetup, lines: ImportLine[], ctx = s.owner) =>
    checkCustomerImport.call(s.rt(NOW), ctx, { lines });
  const apply = (s: ConnectionSetup, lines: ImportLine[], ctx = s.owner) =>
    applyCustomerImport.call(s.rt(NOW), ctx, { lines });

  async function ok<T>(promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>) {
    const result = await promise;
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    return result.value;
  }

  const customerRows = (s: ConnectionSetup) =>
    s.tx((tx) =>
      tx
        .select()
        .from(customers)
        .where(eq(customers.operatorId, s.op))
        .orderBy(asc(customers.customerCodeNorm)),
    );

  const GOOD: ImportLine[] = [
    line(2, {
      code: "101",
      name: "Ramesh Kumar",
      phone: "+91 98765 43210",
      address: "Gali 4",
      area: "ward 5",
      vcNumber: "0001-2345",
      plan: "basic pack",
      startDate: "01/10/2026",
    }),
    line(3, { code: "101", vcNumber: "0001 9999", rent: "₹250" }),
    line(4, { code: "102", name: "Sunita Devi" }),
  ];

  it("previews without writing: ready, existing (skipped) and every kind of problem", async () => {
    const { s } = await setup();
    // An existing customer with a VC (to be found "in use").
    const existing = await ok(
      createCustomer.call(s.rt(NOW), s.owner, { customerCode: "500", name: "Old Customer" }),
    );
    await ok(
      addConnection.call(s.rt(NOW), s.owner, {
        customerId: existing.customer.id,
        vcNumber: "TAKEN-1",
        rentalPaise: 10_000,
        startDate: "2026-09-01",
      }),
    );
    const before = await databaseFingerprint(t.current);
    const result = await ok(
      check(s, [
        ...GOOD,
        line(5, { code: " 500 ", name: "Someone Else", vcNumber: "X1", rent: "100" }),
        line(6, { code: "103", name: "Area Missing", area: "Ward 9" }),
        line(7, { code: "104", name: "Hidden Area", area: "old town" }),
        line(8, { code: "105", name: "Plan Missing", vcNumber: "V105", plan: "Gold" }),
        line(9, { code: "106", name: "Plan Retired", vcNumber: "V106", plan: "Old Pack" }),
        line(10, {
          code: "107",
          name: "Rent Differs",
          vcNumber: "V107",
          plan: "Basic Pack",
          rent: "200",
        }),
        line(11, { code: "108", name: "Taken Box", vcNumber: "taken 1", rent: "100" }),
        line(12, { code: "109", name: "Bad Phone", phone: "12" }),
        line(13, { code: "109", vcNumber: "V109", rent: "100" }),
        line(14, { code: "", name: "No Code" }),
        line(15, {
          code: "110",
          name: "Same Rent",
          vcNumber: "V110",
          plan: "Basic Pack",
          rent: "300",
        }),
      ]),
    );
    expect(changedTables(before, await databaseFingerprint(t.current))).toEqual([]);
    expect(result.today).toBe(TODAY);
    const lines = byLine(result);
    expect(lines.get(2)).toMatchObject({
      status: "ready",
      group: 0,
      problems: [],
      hasConnection: true,
    });
    expect(lines.get(3)).toMatchObject({ status: "ready", group: 0 });
    expect(lines.get(4)).toMatchObject({ status: "ready", group: 1, hasConnection: false });
    expect(lines.get(5)).toMatchObject({
      status: "exists",
      customer: { id: existing.customer.id, code: "500", name: "Old Customer" },
    });
    expect(lines.get(6)?.problems).toEqual([
      { field: "area", code: "not_found", params: { area: "Ward 9" } },
    ]);
    expect(lines.get(7)?.problems).toEqual([
      { field: "area", code: "hidden", params: { area: "old town" } },
    ]);
    expect(lines.get(8)?.problems).toEqual([
      { field: "plan", code: "not_found", params: { plan: "Gold" } },
    ]);
    expect(lines.get(9)?.problems).toEqual([
      { field: "plan", code: "retired", params: { plan: "Old Pack" } },
    ]);
    expect(lines.get(10)?.problems).toEqual([
      { field: "rent", code: "rent_differs", params: { amount: "₹300" } },
    ]);
    expect(lines.get(11)?.problems).toEqual([
      { field: "vcNumber", code: "in_use", params: { code: "500", from: "" } },
    ]);
    expect(lines.get(12)?.problems).toEqual([{ field: "phone", code: "invalid" }]);
    expect(lines.get(13)?.problems).toEqual([
      { field: "line", code: "same_customer", params: { lines: "12" } },
    ]);
    expect(lines.get(14)?.problems).toEqual([{ field: "code", code: "required" }]);
    expect(lines.get(15)).toMatchObject({ status: "ready" });
    expect(result.counts).toEqual({
      customers: { ready: 3, created: 0, exists: 1, problem: 8 },
      connections: 3,
    });
  });

  it("imports through the services: customers, connections, VC assets, events and audit", async () => {
    const { s, basic, north } = await setup();
    const result = await ok(apply(s, GOOD));
    expect(result.counts).toEqual({
      customers: { ready: 0, created: 2, exists: 0, problem: 0 },
      connections: 2,
    });
    const lines = byLine(result);
    expect(lines.get(2)?.status).toBe("created");
    expect(lines.get(3)?.customer).toEqual(lines.get(2)?.customer);
    const rows = await customerRows(s);
    expect(rows.map((r) => [r.customerCode, r.name, r.phone, r.address, r.areaId])).toEqual([
      ["101", "Ramesh Kumar", "9876543210", "Gali 4", north],
      ["102", "Sunita Devi", null, null, null],
    ]);
    const ramesh = rows[0]?.id ?? "";
    expect(lines.get(2)?.customer?.id).toBe(ramesh);
    const assignments = await s.tx((tx) =>
      tx
        .select({
          vc: vcAssets.vcNumber,
          planId: vcAssignments.planId,
          rent: vcAssignments.rentalAmountPaise,
          start: vcAssignments.startDate,
          status: vcAssignments.status,
        })
        .from(vcAssignments)
        .innerJoin(vcAssets, eq(vcAssets.id, vcAssignments.vcAssetId))
        .where(eq(vcAssignments.customerId, ramesh))
        .orderBy(asc(vcAssignments.startDate)),
    );
    expect(assignments).toEqual([
      { vc: "0001-2345", planId: basic, rent: 30_000, start: "2026-10-01", status: "active" },
      { vc: "0001 9999", planId: null, rent: 25_000, start: TODAY, status: "active" },
    ]);
    const events = await s.tx((tx) =>
      tx.select().from(assignmentEvents).where(eq(assignmentEvents.operatorId, s.op)),
    );
    expect(events.map((e) => [e.type, e.actorId])).toEqual([
      ["activated", s.owner.userId],
      ["activated", s.owner.userId],
    ]);
    const audit = await s.tx((tx) =>
      tx
        .select({
          action: auditEvents.action,
          after: auditEvents.after,
          requestId: auditEvents.requestId,
        })
        .from(auditEvents)
        .where(eq(auditEvents.operatorId, s.op))
        .orderBy(asc(auditEvents.id)),
    );
    expect(audit.map((a) => a.action)).toEqual([
      "customers.create",
      "connections.add",
      "connections.add",
      "customers.create",
      "imports.customers.apply",
    ]);
    expect(new Set(audit.map((a) => a.requestId)).size).toBe(1);
    expect(audit.at(-1)?.after).toEqual({
      lines: 3,
      created: 2,
      connections: 2,
      skipped: 0,
      problems: 0,
    });
  });

  it("uploading the same file again changes nothing (matched on code; existing kept as they are)", async () => {
    const { s } = await setup();
    const first = await ok(apply(s, GOOD));
    const rameshId = first.lines[0]?.customer?.id ?? "";
    // The office corrects Ramesh's phone after the first import.
    await ok(
      updateCustomer.call(s.rt(NOW), s.owner, { customerId: rameshId, phone: "9000000001" }),
    );
    const before = await databaseFingerprint(t.current, { operatorId: s.op });
    // Same file, codes typed differently (spaces, case), one more line with a box.
    const again = await ok(
      apply(s, [
        ...GOOD.map((l) => line(l.line, { ...l.values, code: ` ${l.values.code} ` })),
        line(9, { code: "102", vcNumber: "NEW-BOX", rent: "100" }),
      ]),
    );
    expect(
      changedTables(before, await databaseFingerprint(t.current, { operatorId: s.op })),
    ).toEqual([]);
    expect(again.counts.customers).toEqual({ ready: 0, created: 0, exists: 2, problem: 0 });
    expect(again.lines.every((l) => l.status === "exists")).toBe(true);
    const rows = await customerRows(s);
    expect(rows.find((r) => r.id === rameshId)?.phone).toBe("9000000001");
    // A third upload with a fixed line adds only that customer.
    const third = await ok(apply(s, [...GOOD, line(5, { code: "103", name: "New Person" })]));
    expect(third.counts.customers).toEqual({ ready: 0, created: 1, exists: 2, problem: 0 });
    expect((await customerRows(s)).map((r) => r.customerCode)).toEqual(["101", "102", "103"]);
  });

  it("one customer is all or nothing: a refused second box leaves no customer and no first box", async () => {
    const { s } = await setup();
    const real = connectionHooks.onAssignmentStarted;
    vi.spyOn(connectionHooks, "onAssignmentStarted").mockImplementation(async (hc, event) => {
      // Stand-in for a refusal only the database can give (e.g. the VC taken a moment ago).
      if (event.assignment.rentalPaise === 25_000) {
        return err(
          serviceError("CONFLICT", "taken", {
            reason: "vc_in_use",
            holderCustomerCode: "77",
            earliestStart: null,
          }),
        );
      }
      return real(hc, event);
    });
    const before = await databaseFingerprint(t.current, { operatorId: s.op });
    const result = await ok(apply(s, GOOD));
    const lines = byLine(result);
    expect(lines.get(2)).toMatchObject({
      status: "problem",
      problems: [{ field: "line", code: "same_customer", params: { lines: "3" } }],
    });
    expect(lines.get(3)).toMatchObject({
      status: "problem",
      problems: [{ field: "vcNumber", code: "in_use", params: { code: "77", from: "" } }],
    });
    expect(lines.get(4)?.status).toBe("created");
    // Only Sunita (no box) was saved: no Ramesh, no VC asset, no assignment, no event.
    expect((await customerRows(s)).map((r) => r.customerCode)).toEqual(["102"]);
    const changed = changedTables(
      before,
      await databaseFingerprint(t.current, { operatorId: s.op }),
    );
    expect(changed).not.toContain("vc_assets");
    expect(changed).not.toContain("vc_assignments");
    expect(changed).not.toContain("assignment_events");
    const audit = await s.tx((tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.operatorId, s.op)),
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      "customers.create",
      "imports.customers.apply",
    ]);
  });

  it("a line with a problem never imports partly; the rest of the step is saved", async () => {
    const { s } = await setup();
    const result = await ok(
      apply(s, [
        line(2, { code: "201", name: "Box Problem" }),
        line(3, { code: "201", vcNumber: "B1", rent: "100" }),
        line(4, { code: "201", vcNumber: "B2", plan: "Nope" }),
        line(5, { code: "202", name: "Fine" }),
      ]),
    );
    expect(result.counts.customers).toEqual({ ready: 0, created: 1, exists: 0, problem: 1 });
    expect((await customerRows(s)).map((r) => r.customerCode)).toEqual(["202"]);
    const assets = await s.tx((tx) =>
      tx.select().from(vcAssets).where(eq(vcAssets.operatorId, s.op)),
    );
    expect(assets).toEqual([]);
  });

  it("two imports of the same file at once add each customer once", async () => {
    const { s } = await setup();
    const [a, b] = await Promise.all([ok(apply(s, GOOD)), ok(apply(s, GOOD))]);
    expect(a.counts.customers.created + b.counts.customers.created).toBe(2);
    expect(a.counts.customers.exists + b.counts.customers.exists).toBe(2);
    expect((await customerRows(s)).map((r) => r.customerCode)).toEqual(["101", "102"]);
  }, 60_000);

  it("matches names only inside the tenant (areas, plans, codes, VCs of another business)", async () => {
    const { s } = await setup();
    const other = await setupTenant(t.current);
    await addPlan(other, "Gold", 50_000);
    await other.tx((tx) => tx.insert(areas).values({ operatorId: other.op, name: "Ward 9" }));
    const theirs = await ok(
      createCustomer.call(other.rt(NOW), other.owner, {
        customerCode: "900",
        name: "Their Customer",
      }),
    );
    await ok(
      addConnection.call(other.rt(NOW), other.owner, {
        customerId: theirs.customer.id,
        vcNumber: "THEIR-VC",
        rentalPaise: 10_000,
        startDate: "2026-09-01",
      }),
    );
    const result = await ok(
      check(s, [
        line(2, { code: "900", name: "Mine", vcNumber: "THEIR-VC", rent: "100" }),
        line(3, { code: "901", name: "Area", area: "Ward 9" }),
        line(4, { code: "902", name: "Plan", vcNumber: "P1", plan: "Gold" }),
      ]),
    );
    const lines = byLine(result);
    expect(lines.get(2)?.status).toBe("ready");
    expect(lines.get(3)?.problems).toEqual([
      { field: "area", code: "not_found", params: { area: "Ward 9" } },
    ]);
    expect(lines.get(4)?.problems).toEqual([
      { field: "plan", code: "not_found", params: { plan: "Gold" } },
    ]);
    expect(JSON.stringify(result)).not.toContain(theirs.customer.id);
    const applied = await ok(
      apply(s, [line(2, { code: "900", name: "Mine", vcNumber: "THEIR-VC", rent: "100" })]),
    );
    expect(applied.counts.customers.created).toBe(1);
    const [theirAssignment] = await other.tx((tx) =>
      tx
        .select()
        .from(vcAssignments)
        .where(and(eq(vcAssignments.customerId, theirs.customer.id))),
    );
    expect(theirAssignment?.status).toBe("active");
  });

  it("is for the Owner and Staff, and refused in read-only mode", async () => {
    const { s } = await setup();
    expect((await check(s, GOOD, s.staff)).ok).toBe(true);
    const staff = await ok(apply(s, [line(2, { code: "301", name: "By Staff" })], s.staff));
    expect(staff.counts.customers.created).toBe(1);
    for (const call of [check(s, GOOD, s.lineman), apply(s, GOOD, s.lineman)]) {
      const result = await call;
      expect(result.ok ? "ok" : result.error.code).toBe("FORBIDDEN");
    }
    await setSubscriptionStatus(t.current, s.op, "read_only");
    for (const call of [check(s, GOOD), apply(s, GOOD)]) {
      const result = await call;
      expect(result.ok ? "ok" : result.error.code).toBe("TENANT_READ_ONLY");
    }
  });

  it("refuses bad input shapes (too many lines per step, repeated line numbers)", async () => {
    const { s } = await setup();
    const many = Array.from({ length: 251 }, (_, i) => line(i + 2, { code: String(i), name: "N" }));
    const tooMany = await apply(s, many);
    expect(tooMany.ok ? "ok" : tooMany.error.code).toBe("VALIDATION");
    const repeated = await check(s, [
      line(2, { code: "1", name: "A" }),
      line(2, { code: "2", name: "B" }),
    ]);
    expect(repeated.ok ? "ok" : repeated.error.code).toBe("VALIDATION");
  });

  it("the preview says how to send the ready customers in steps", async () => {
    const { s } = await setup();
    const preview = await ok(check(s, GOOD));
    expect(preview.steps).toEqual([[2, 3, 4]]);
  });
});

describe("importSteps", () => {
  const result = (line: number, group: number, status: ImportLineResult["status"] = "ready") =>
    ({
      line,
      group,
      status,
      problems: [],
      customer: null,
      hasConnection: false,
    }) as ImportLineResult;

  it("sends whole customers, ready lines only, at most max lines per step", () => {
    const lines = [
      result(2, 0),
      result(3, 0),
      result(4, 1, "problem"),
      result(5, 2),
      result(6, 3),
      result(7, 3),
      result(8, 4, "exists"),
      result(9, 5),
    ];
    expect(importSteps(lines, 3)).toEqual([
      [2, 3, 5],
      [6, 7, 9],
    ]);
    expect(importSteps(lines, 2)).toEqual([[2, 3], [5], [6, 7], [9]]);
    expect(importSteps([], 2)).toEqual([]);
  });
});
