/**
 * Connection services against a real database (T-034): add (plan / own amount, find-or-create the
 * VC), every transition valid and invalid, the date rules, plan changes, the hooks, "Add customer"
 * with connections in one transaction, the timeline read, roles and read-only mode.
 */
import { assignmentEvents, auditEvents, customers, vcAssets, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { err, validateAssignmentTimeline } from "@cb/domain";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSubscriptionStatus } from "../testing/fixtures";
import { connectionHooks } from "./hooks";
import { connectionFormOptions, listConnections } from "./queries";
import {
  addConnection,
  changeConnectionPlan,
  createCustomerWithConnections,
  disconnectConnection,
  reactivateConnection,
  suspendConnection,
} from "./services";
import { toTimeline } from "./store";
import { addPlan, type ConnectionSetup, ist, newCustomer, setupTenant } from "./test-support";

const OCT_13 = ist("2026-10-13");
const TODAY = "2026-10-13";

describeDb("connection services", () => {
  const t = useTestDatabase();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const setup = () => setupTenant(t.current);

  async function assignmentRow(s: ConnectionSetup, id: string) {
    const [row] = await s.tx((tx) =>
      tx.select().from(vcAssignments).where(eq(vcAssignments.id, id)),
    );
    if (!row) throw new Error("no assignment");
    return row;
  }

  const eventsOf = (s: ConnectionSetup, assignmentId: string) =>
    s.tx((tx) =>
      tx
        .select()
        .from(assignmentEvents)
        .where(eq(assignmentEvents.assignmentId, assignmentId))
        .orderBy(asc(assignmentEvents.at), asc(assignmentEvents.id)),
    );

  /** Adds a VC with an own amount of ₹300 (as the Owner) and returns the assignment id. */
  async function connect(
    s: ConnectionSetup,
    customerId: string,
    vcNumber: string,
    startDate = "2026-09-05",
    now = OCT_13,
  ) {
    const result = await addConnection.call(s.rt(now), s.owner, {
      customerId,
      vcNumber,
      rentalPaise: 30_000,
      startDate,
    });
    if (!result.ok) throw new Error(`addConnection: ${JSON.stringify(result.error)}`);
    return result.value.connection.assignmentId;
  }

  describe("add", () => {
    it("copies the plan's rent, creates the VC, records the start and audits it", async () => {
      const s = await setup();
      const planId = await addPlan(s, "Basic", 25_000);
      const customerId = await newCustomer(s, OCT_13);
      const started = vi.spyOn(connectionHooks, "onAssignmentStarted");

      const result = await addConnection.call(s.rt(OCT_13), s.staff, {
        customerId,
        vcNumber: "  0001 2345-6789 ",
        planId,
        startDate: TODAY,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { connection, vcAssetCreated, previous } = result.value;
      expect(vcAssetCreated).toBe(true);
      expect(previous).toBeNull();
      expect(connection).toMatchObject({
        customerId,
        vcNumber: "0001 2345-6789",
        status: "active",
        planId,
        rentalPaise: 25_000,
        startDate: TODAY,
        endDate: null,
      });

      const [asset] = await s.tx((tx) =>
        tx.select().from(vcAssets).where(eq(vcAssets.id, connection.vcAssetId)),
      );
      expect(asset?.vcNumberNorm).toBe("000123456789");
      const events = await eventsOf(s, connection.assignmentId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "activated",
        effectiveDate: TODAY,
        actorId: s.tenant.users.staff,
      });
      const audit = await s.tx((tx) =>
        tx.select().from(auditEvents).where(eq(auditEvents.entityId, connection.assignmentId)),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "connections.add", entityType: "vc_assignment" });
      expect(audit[0]?.after).toMatchObject({ rentalPaise: 25_000, vcAssetCreated: true });
      const [customer] = await s.tx((tx) =>
        tx.select().from(customers).where(eq(customers.id, customerId)),
      );
      expect(customer?.updatedAt.toISOString()).toBe(OCT_13.toISOString());

      expect(started).toHaveBeenCalledTimes(1);
      const [hc, event] = started.mock.calls[0] ?? [];
      expect(hc?.today).toBe(TODAY);
      expect(event).toMatchObject({
        eventId: events[0]?.id,
        effectiveDate: TODAY,
        assignment: { id: connection.assignmentId, customerId, rentalPaise: 25_000 },
      });
    });

    it("takes an own amount (₹0 too) and a start tomorrow", async () => {
      const s = await setup();
      const customerId = await newCustomer(s, OCT_13);
      const free = await addConnection.call(s.rt(OCT_13), s.owner, {
        customerId,
        vcNumber: "FREE-1",
        rentalPaise: 0,
        startDate: "2026-10-14",
      });
      expect(free.ok && free.value.connection).toMatchObject({
        planId: null,
        rentalPaise: 0,
        startDate: "2026-10-14",
      });
    });

    it("refuses bad input field by field", async () => {
      const s = await setup();
      const customerId = await newCustomer(s, OCT_13);
      const retired = await addPlan(s, "Old", 20_000, "retired");
      const planId = await addPlan(s, "Basic", 25_000);
      const call = (input: Record<string, unknown>) =>
        addConnection.call(s.rt(OCT_13), s.owner, {
          customerId,
          vcNumber: "VC-1",
          rentalPaise: 30_000,
          startDate: TODAY,
          ...input,
        } as never);
      const fieldsOf = async (input: Record<string, unknown>) => {
        const result = await call(input);
        expect(result.ok).toBe(false);
        return result.ok ? null : { code: result.error.code, fields: result.error.details?.fields };
      };

      expect(await fieldsOf({ planId })).toEqual({
        code: "VALIDATION",
        fields: [{ path: "planId", code: "custom" }],
      });
      expect(await fieldsOf({ rentalPaise: null })).toEqual({
        code: "VALIDATION",
        fields: [{ path: "planId", code: "custom" }],
      });
      expect((await fieldsOf({ vcNumber: " - " }))?.fields).toEqual([
        { path: "vcNumber", code: "custom" },
      ]);
      expect((await fieldsOf({ rentalPaise: -100 }))?.fields).toEqual([
        { path: "rentalPaise", code: "too_small" },
      ]);
      expect((await fieldsOf({ rentalPaise: 150.5 }))?.code).toBe("VALIDATION");
      expect((await fieldsOf({ startDate: "2026-02-30" }))?.fields).toEqual([
        { path: "startDate", code: "custom" },
      ]);
      expect((await fieldsOf({ startDate: "2026-10-15" }))?.fields).toEqual([
        { path: "startDate", code: "in_future" },
      ]);
      expect((await fieldsOf({ startDate: "1999-01-01" }))?.fields).toEqual([
        { path: "startDate", code: "too_old" },
      ]);
      expect((await fieldsOf({ planId: retired, rentalPaise: undefined }))?.fields).toEqual([
        { path: "planId", code: "retired" },
      ]);
      // Nothing was written by any refusal.
      const assets = await s.tx((tx) => tx.select().from(vcAssets));
      expect(assets).toHaveLength(0);
    });

    it("refuses a closed customer, a lineman and a read-only business", async () => {
      const s = await setup();
      const customerId = await newCustomer(s, OCT_13);
      await s.tx((tx) =>
        tx.update(customers).set({ status: "inactive" }).where(eq(customers.id, customerId)),
      );
      const input = { customerId, vcNumber: "VC-9", rentalPaise: 1000, startDate: TODAY };
      const closed = await addConnection.call(s.rt(OCT_13), s.owner, input);
      expect(!closed.ok && closed.error.details?.reason).toBe("customer_closed");
      const lineman = await addConnection.call(s.rt(OCT_13), s.lineman, input as never);
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
      await setSubscriptionStatus(t.current, s.op, "read_only");
      const readOnly = await addConnection.call(s.rt(OCT_13), s.owner, input);
      expect(!readOnly.ok && readOnly.error.code).toBe("TENANT_READ_ONLY");
    });

    it("refuses a VC that is still with a customer and says who has it until when", async () => {
      const s = await setup();
      const ramesh = await newCustomer(s, OCT_13, "Ramesh");
      const suresh = await newCustomer(s, OCT_13, "Suresh");
      const first = await connect(s, ramesh, "000123456789");

      // Same card typed differently (spaces, dashes, lower case) is the same VC.
      const busy = await addConnection.call(s.rt(OCT_13), s.owner, {
        customerId: suresh,
        vcNumber: "0001-2345-6789",
        rentalPaise: 30_000,
        startDate: TODAY,
      });
      expect(busy.ok).toBe(false);
      if (busy.ok) return;
      expect(busy.error.code).toBe("CONFLICT");
      expect(busy.error.details).toMatchObject({
        reason: "vc_in_use",
        holderAssignmentId: first,
        holderCustomerId: ramesh,
        holderName: "Ramesh",
        holderStatus: "active",
        until: null,
        earliestStart: null,
        sameCustomer: false,
      });
      const again = await addConnection.call(s.rt(OCT_13), s.owner, {
        customerId: ramesh,
        vcNumber: "000123456789",
        rentalPaise: 30_000,
        startDate: TODAY,
      });
      expect(!again.ok && again.error.details?.sameCustomer).toBe(true);

      // A stopped VC is still the customer's (T-022 decision 2).
      await suspendConnection.call(s.rt(OCT_13), s.owner, {
        assignmentId: first,
        effectiveDate: TODAY,
      });
      const stopped = await addConnection.call(s.rt(OCT_13), s.owner, {
        customerId: suresh,
        vcNumber: "000123456789",
        rentalPaise: 30_000,
        startDate: TODAY,
      });
      expect(!stopped.ok && stopped.error.details?.holderStatus).toBe("suspended");
    });

    it("the same VC number at another business is a different VC", async () => {
      const a = await setup();
      const b = await setupTenant(t.current);
      await connect(a, await newCustomer(a, OCT_13), "SHARED-1");
      const other = await addConnection.call(b.rt(OCT_13), b.owner, {
        customerId: await newCustomer(b, OCT_13),
        vcNumber: "SHARED-1",
        rentalPaise: 30_000,
        startDate: TODAY,
      });
      expect(other.ok && other.value.vcAssetCreated).toBe(true);
    });

    it("a hook error rolls the whole change back", async () => {
      const s = await setup();
      const customerId = await newCustomer(s, OCT_13);
      vi.spyOn(connectionHooks, "onAssignmentStarted").mockResolvedValue(
        err({ code: "CONFLICT", message: "hook said no", details: { reason: "hook" } }),
      );
      const result = await addConnection.call(s.rt(OCT_13), s.owner, {
        customerId,
        vcNumber: "HOOKED",
        rentalPaise: 30_000,
        startDate: TODAY,
      });
      expect(!result.ok && result.error.details?.reason).toBe("hook");
      expect(await s.tx((tx) => tx.select().from(vcAssets))).toHaveLength(0);
      expect(await s.tx((tx) => tx.select().from(vcAssignments))).toHaveLength(0);
    });
  });

  describe("status changes", () => {
    it("stop → start again → stop → remove, each an event, status in step", async () => {
      const s = await setup();
      const customerId = await newCustomer(s, OCT_13);
      const id = await connect(s, customerId, "VC-100", "2026-08-10", ist("2026-08-10"));
      const reactivated = vi.spyOn(connectionHooks, "onAssignmentReactivated");

      const stop = await suspendConnection.call(s.rt(ist("2026-09-01")), s.staff, {
        assignmentId: id,
        effectiveDate: "2026-09-01",
        reason: "not_paying",
      });
      expect(stop.ok && stop.value.connection.status).toBe("suspended");
      const start = await reactivateConnection.call(s.rt(ist("2026-09-20")), s.staff, {
        assignmentId: id,
        effectiveDate: "2026-09-20",
      });
      expect(start.ok && start.value.connection.status).toBe("active");
      expect(reactivated).toHaveBeenCalledTimes(1);
      expect(reactivated.mock.calls[0]?.[1]).toMatchObject({
        effectiveDate: "2026-09-20",
        assignment: { id, status: "active" },
      });
      const stopAgain = await suspendConnection.call(s.rt(OCT_13), s.owner, {
        assignmentId: id,
        effectiveDate: "2026-10-01",
      });
      expect(stopAgain.ok).toBe(true);
      const remove = await disconnectConnection.call(s.rt(OCT_13), s.owner, {
        assignmentId: id,
        effectiveDate: TODAY,
        reason: "other",
        note: " shop closed ",
      });
      expect(remove.ok && remove.value.connection).toMatchObject({
        status: "disconnected",
        endDate: TODAY,
      });

      const row = await assignmentRow(s, id);
      expect(row).toMatchObject({ status: "disconnected", endDate: TODAY });
      const events = await eventsOf(s, id);
      expect(events.map((e) => [e.type, e.effectiveDate, e.reason])).toEqual([
        ["activated", "2026-08-10", null],
        ["suspended", "2026-09-01", "not_paying"],
        ["reactivated", "2026-09-20", null],
        ["suspended", "2026-10-01", null],
        ["disconnected", TODAY, "other: shop closed"],
      ]);
      // The stored history is a valid T-040 timeline.
      expect(validateAssignmentTimeline(toTimeline(row, events)).ok).toBe(true);
      const audit = await s.tx((tx) =>
        tx
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(and(eq(auditEvents.entityId, id)))
          .orderBy(asc(auditEvents.at), asc(auditEvents.id)),
      );
      expect(audit.map((a) => a.action)).toEqual([
        "connections.add",
        "connections.suspend",
        "connections.reactivate",
        "connections.suspend",
        "connections.disconnect",
      ]);
    });

    it("rejects invalid transitions and writes nothing", async () => {
      const s = await setup();
      const customerId = await newCustomer(s, OCT_13);
      const id = await connect(s, customerId, "VC-200");
      const rt = s.rt(OCT_13);
      const at = { assignmentId: id, effectiveDate: TODAY };

      const reactivateActive = await reactivateConnection.call(rt, s.owner, at);
      expect(!reactivateActive.ok && reactivateActive.error.details).toMatchObject({
        reason: "invalid_transition",
        from: "active",
        action: "reactivate",
      });
      await suspendConnection.call(rt, s.owner, at);
      const suspendTwice = await suspendConnection.call(rt, s.owner, at);
      expect(!suspendTwice.ok && suspendTwice.error.details?.from).toBe("suspended");
      // Removing a stopped connection is allowed.
      expect(
        (await disconnectConnection.call(rt, s.owner, { ...at, reason: "moved_away" })).ok,
      ).toBe(true);

      const before = await eventsOf(s, id);
      for (const call of [
        () => reactivateConnection.call(rt, s.owner, at),
        () => suspendConnection.call(rt, s.owner, at),
        () => disconnectConnection.call(rt, s.owner, { ...at, reason: "moved_away" }),
        () => changeConnectionPlan.call(rt, s.owner, { ...at, rentalPaise: 1000 }),
      ]) {
        const result = await call();
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe("CONFLICT");
        expect(result.error.details).toMatchObject({
          reason: "invalid_transition",
          from: "disconnected",
        });
      }
      expect(await eventsOf(s, id)).toHaveLength(before.length);
      expect((await assignmentRow(s, id)).status).toBe("disconnected");
    });

    it("checks the effective date: not in the future, not before the start or the last change", async () => {
      const s = await setup();
      const customerId = await newCustomer(s, OCT_13);
      const id = await connect(s, customerId, "VC-300", "2026-10-05");
      const rt = s.rt(OCT_13);
      const fieldOf = async (effectiveDate: string) => {
        const result = await suspendConnection.call(rt, s.owner, {
          assignmentId: id,
          effectiveDate,
        });
        return result.ok ? null : result.error.details?.fields;
      };
      expect(await fieldOf("2026-10-14")).toEqual([{ path: "effectiveDate", code: "in_future" }]);
      expect(await fieldOf("2026-10-04")).toEqual([
        { path: "effectiveDate", code: "before_start" },
      ]);
      await suspendConnection.call(rt, s.owner, { assignmentId: id, effectiveDate: "2026-10-10" });
      const early = await reactivateConnection.call(rt, s.owner, {
        assignmentId: id,
        effectiveDate: "2026-10-09",
      });
      expect(!early.ok && early.error.details?.fields).toEqual([
        { path: "effectiveDate", code: "before_last_change" },
      ]);
      // The same day as the last change is fine (stop and start again on one day).
      const sameDay = await reactivateConnection.call(rt, s.owner, {
        assignmentId: id,
        effectiveDate: "2026-10-10",
      });
      expect(sameDay.ok).toBe(true);
    });

    it("needs a reason to remove; a lineman can't change status", async () => {
      const s = await setup();
      const id = await connect(s, await newCustomer(s, OCT_13), "VC-400");
      const noReason = await disconnectConnection.call(s.rt(OCT_13), s.owner, {
        assignmentId: id,
        effectiveDate: TODAY,
      } as never);
      expect(!noReason.ok && noReason.error.details?.fields).toEqual([
        { path: "reason", code: "invalid_value" },
      ]);
      const lineman = await suspendConnection.call(s.rt(OCT_13), s.lineman, {
        assignmentId: id,
        effectiveDate: TODAY,
      });
      expect(!lineman.ok && lineman.error.code).toBe("FORBIDDEN");
    });
  });

  describe("plan change", () => {
    it("records from/to, calls the hook, and a repeat changes nothing", async () => {
      const s = await setup();
      const planId = await addPlan(s, "Gold", 45_000);
      const id = await connect(s, await newCustomer(s, OCT_13), "VC-500");
      const changed = vi.spyOn(connectionHooks, "onAssignmentPlanChanged");

      const result = await changeConnectionPlan.call(s.rt(OCT_13), s.staff, {
        assignmentId: id,
        effectiveDate: "2026-10-10",
        planId,
      });
      expect(result.ok && result.value).toMatchObject({
        changed: true,
        connection: { planId, rentalPaise: 45_000, status: "active" },
      });
      const events = await eventsOf(s, id);
      expect(events.at(-1)).toMatchObject({
        type: "plan_changed",
        effectiveDate: "2026-10-10",
        fromPlanId: null,
        toPlanId: planId,
        fromRentalPaise: 30_000,
        toRentalPaise: 45_000,
      });
      expect(changed.mock.calls[0]?.[1]).toMatchObject({
        fromPlanId: null,
        toPlanId: planId,
        fromRentalPaise: 30_000,
        toRentalPaise: 45_000,
        effectiveDate: "2026-10-10",
      });

      const repeat = await changeConnectionPlan.call(s.rt(OCT_13), s.staff, {
        assignmentId: id,
        effectiveDate: TODAY,
        planId,
      });
      expect(repeat.ok && repeat.value).toMatchObject({ changed: false, eventId: null });
      expect(await eventsOf(s, id)).toHaveLength(events.length);
      expect(changed).toHaveBeenCalledTimes(1);
    });
  });

  describe("add customer with connections", () => {
    it("saves the customer and its connections in one transaction", async () => {
      const s = await setup();
      const planId = await addPlan(s, "Basic", 25_000);
      const result = await createCustomerWithConnections.call(s.rt(OCT_13), s.staff, {
        customer: { name: "Meena", phone: "98765 43210" },
        connections: [
          { vcNumber: "M-1", planId, startDate: TODAY },
          { vcNumber: "M-2", rentalPaise: 15_000, startDate: TODAY },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.autoCode).toBe(true);
      expect(result.value.connections.map((c) => c.connection.rentalPaise)).toEqual([
        25_000, 15_000,
      ]);
    });

    it("a refused connection saves nothing and says which one", async () => {
      const s = await setup();
      const result = await createCustomerWithConnections.call(s.rt(OCT_13), s.staff, {
        customer: { customerCode: "X-1", name: "Twice" },
        connections: [
          { vcNumber: "DUP-1", rentalPaise: 10_000, startDate: TODAY },
          { vcNumber: "dup 1", rentalPaise: 10_000, startDate: TODAY },
        ],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.details).toMatchObject({
        reason: "vc_in_use",
        connectionIndex: 1,
        sameCustomer: true,
      });
      expect(await s.tx((tx) => tx.select().from(customers))).toHaveLength(0);
      expect(await s.tx((tx) => tx.select().from(vcAssets))).toHaveLength(0);

      const bad = await createCustomerWithConnections.call(s.rt(OCT_13), s.staff, {
        customer: { name: "Bad date" },
        connections: [{ vcNumber: "OK-1", rentalPaise: 10_000, startDate: "2027-01-01" }],
      });
      expect(!bad.ok && bad.error.details).toMatchObject({
        connectionIndex: 0,
        fields: [{ path: "connections.0.startDate", code: "in_future" }],
      });
    });
  });

  describe("timeline and form options", () => {
    it("lists current and past connections with their history, names and allowed actions", async () => {
      const s = await setup();
      const planId = await addPlan(s, "Basic", 25_000);
      const customerId = await newCustomer(s, OCT_13);
      const current = await connect(s, customerId, "NOW-1", "2026-09-01");
      const old = await connect(s, customerId, "OLD-1", "2026-08-01");
      await changeConnectionPlan.call(s.rt(OCT_13), s.owner, {
        assignmentId: current,
        effectiveDate: "2026-10-01",
        planId,
      });
      await disconnectConnection.call(s.rt(OCT_13), s.staff, {
        assignmentId: old,
        effectiveDate: "2026-09-30",
        reason: "moved_away",
      });
      // Stopped today: still running until the end of today.
      await suspendConnection.call(s.rt(OCT_13), s.staff, {
        assignmentId: current,
        effectiveDate: TODAY,
        reason: "customer_asked",
      });

      const result = await listConnections.call(s.rt(OCT_13), s.lineman, { customerId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const list = result.value;
      expect(list).toMatchObject({ customerId, customerActive: true, today: TODAY });
      expect(list.latestBilledPeriod).toBeNull();
      expect(list.current).toHaveLength(1);
      expect(list.current[0]).toMatchObject({
        assignmentId: current,
        vcNumber: "NOW-1",
        status: "suspended",
        statusToday: "active",
        planName: "Basic",
        rentalPaise: 25_000,
        actions: ["reactivate", "disconnect", "change_plan"],
        earliestChangeDate: TODAY,
      });
      expect(list.current[0]?.events.map((e) => e.type)).toEqual([
        "activated",
        "plan_changed",
        "suspended",
      ]);
      expect(list.current[0]?.events[1]).toMatchObject({
        toPlanName: "Basic",
        fromRentalPaise: 30_000,
        toRentalPaise: 25_000,
      });
      expect(list.current[0]?.events[2]?.reason).toEqual({ code: "customer_asked", note: null });
      expect(list.current[0]?.events[0]?.actorName).toEqual(expect.any(String));
      expect(list.past).toHaveLength(1);
      expect(list.past[0]).toMatchObject({
        assignmentId: old,
        status: "disconnected",
        statusToday: "disconnected",
        endDate: "2026-09-30",
        actions: [],
      });
    });

    it("form options: active plans, start dates, NOT_FOUND for an unknown customer", async () => {
      const s = await setup();
      await addPlan(s, "Gold", 45_000);
      await addPlan(s, "Basic", 25_000);
      await addPlan(s, "Old", 10_000, "retired");
      const customerId = await newCustomer(s, OCT_13);
      const result = await connectionFormOptions.call(s.rt(OCT_13), s.staff, { customerId });
      expect(result.ok && result.value).toMatchObject({
        today: TODAY,
        latestStartDate: "2026-10-14",
        earliestStartDate: null,
      });
      expect(result.ok && result.value.plans.map((p) => p.name)).toEqual(["Basic", "Gold"]);
      const unknown = await connectionFormOptions.call(s.rt(OCT_13), s.staff, {
        customerId: "0190f5e0-0000-7000-8000-000000000000",
      });
      expect(!unknown.ok && unknown.error.code).toBe("NOT_FOUND");
    });
  });
});
