/**
 * The cash handover against a real database (T-062, PLAN §8.7, J-05): the server computes the
 * discrepancy from its own expected cash, a reason when it isn't 0, idempotency on the
 * submission id, the state machine submit → return → resubmit → accept (final), stale and
 * repeated decisions, the append-only history, audit, roles and read-only mode.
 */
import {
  auditEvents,
  collectionSessions,
  handoverEvents,
  isImmutableRowError,
  uuidv7,
} from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { businessDate } from "@cb/domain";
import { and, asc, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import { getLinemanDay, getOwnCollectionDay } from "./day";
import { acceptHandover, returnHandover, submitHandover } from "./handover";
import { newCustomer, postField, reverse } from "./test-support";

const NOW = new Date("2026-10-13T12:30:00.000Z"); // 18:00 IST
const TODAY = businessDate("2026-10-13");
const earlier = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describeDb("collections: cash handover", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
    customerId: string;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db, { now: () => NOW });
    return {
      tenant,
      rt,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
      lineman: await contextFor(rt, tenant, "lineman"),
      customerId: await newCustomer(t.current.db, tenant),
    };
  }

  /** ₹500 cash + ₹300 cash + ₹200 UPI today: expected cash ₹800. */
  async function collect(s: Setup) {
    const cash1 = await postField(s.rt, s.lineman, s.customerId, 50_000, "cash", earlier(60));
    const cash2 = await postField(s.rt, s.lineman, s.customerId, 30_000, "cash", earlier(50));
    const upi = await postField(s.rt, s.lineman, s.customerId, 20_000, "upi", earlier(40));
    return { cash1, cash2, upi };
  }

  const handover = (extra: object = {}) => ({
    businessDate: TODAY,
    submissionId: uuidv7(),
    cashHandedOverPaise: 80_000,
    unsyncedPaymentCount: 0,
    unsyncedCashPaise: 0,
    ...extra,
  });

  const session = (s: Setup) =>
    t.current.db
      .withTenant(s.tenant.operatorId, (tx) =>
        tx
          .select()
          .from(collectionSessions)
          .where(eq(collectionSessions.collectorId, s.tenant.users.lineman)),
      )
      .then((rows) => rows.find((r) => r.businessDate === TODAY));

  const history = (s: Setup) =>
    t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx.select().from(handoverEvents).orderBy(asc(handoverEvents.at), asc(handoverEvents.id)),
    );

  const audits = (s: Setup, action: string) =>
    t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, action))),
    );

  it("exact cash: no reason needed (a sent reason is dropped); UPI is not expected as cash", async () => {
    const s = await setup();
    await collect(s);
    const input = handover({ discrepancyReason: "extra" });
    const result = await submitHandover.call(s.rt, s.lineman, input);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.outcome).toBe("submitted");
    expect(result.value.day).toMatchObject({
      cashExpectedPaise: 80_000,
      upiTotalPaise: 20_000,
      paymentCount: 3,
      status: "submitted",
      handover: {
        submissionId: input.submissionId,
        cashExpectedPaise: 80_000,
        cashHandedOverPaise: 80_000,
        discrepancyPaise: 0,
        discrepancyReason: null,
        note: null,
        submittedAt: NOW,
        reviewedAt: null,
      },
    });
    const [audit] = await audits(s, "handover.submit");
    expect(audit).toMatchObject({
      actorId: s.tenant.users.lineman,
      entityType: "collection_session",
      entityId: result.value.day.sessionId,
      after: {
        status: "submitted",
        cash_expected_paise: 80_000,
        cash_handed_over_paise: 80_000,
        discrepancy_paise: 0,
        discrepancy_reason: null,
        has_note: false,
      },
    });
  });

  it("the server's discrepancy: handed − expected (cash only, not reversed); a reason when ≠ 0", async () => {
    const s = await setup();
    const { cash2 } = await collect(s);
    await reverse(s.rt, s.owner, cash2); // expected cash ₹500 now
    // Handing over ₹800 (including the UPI the lineman never held) is ₹300 extra.
    const missing = await submitHandover.call(s.rt, s.lineman, handover());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("VALIDATION");
      expect(missing.error.details).toEqual({
        fields: [{ path: "discrepancyReason", code: "required" }],
        cashExpectedPaise: 50_000,
        discrepancyPaise: 30_000,
      });
    }
    expect((await session(s))?.status).toBe("open");
    expect(await history(s)).toEqual([]);

    const short = await submitHandover.call(
      s.rt,
      s.lineman,
      handover({ cashHandedOverPaise: 45_000, discrepancyReason: "short", note: "Gave change" }),
    );
    if (!short.ok) throw new Error(short.error.code);
    expect(short.value.day.handover).toMatchObject({
      cashExpectedPaise: 50_000,
      cashHandedOverPaise: 45_000,
      discrepancyPaise: -5_000,
      discrepancyReason: "short",
      note: "Gave change",
    });
  });

  it("is idempotent on the submission id, also for an older submission", async () => {
    const s = await setup();
    await collect(s);
    const first = handover({ cashHandedOverPaise: 70_000, discrepancyReason: "short" });
    const r1 = await submitHandover.call(s.rt, s.lineman, first);
    expect(r1.ok && r1.value.outcome).toBe("submitted");
    const again = await submitHandover.call(s.rt, s.lineman, {
      ...first,
      submissionId: first.submissionId.toUpperCase(),
    });
    expect(again.ok && again.value.outcome).toBe("duplicate");
    expect(again.ok && again.value.day).toEqual(r1.ok && r1.value.day);

    const second = handover();
    expect((await submitHandover.call(s.rt, s.lineman, second)).ok).toBe(true);
    // The phone retries the first (stale) submission: recognised, the current state returned.
    const stale = await submitHandover.call(s.rt, s.lineman, first);
    expect(stale.ok && stale.value.outcome).toBe("duplicate");
    expect(stale.ok && stale.value.day.handover?.submissionId).toBe(second.submissionId);

    const reused = await submitHandover.call(s.rt, s.lineman, {
      ...first,
      cashHandedOverPaise: 60_000,
      note: "x",
    });
    expect(!reused.ok && reused.error).toMatchObject({
      code: "ID_REUSED_WITH_DIFFERENT_DATA",
      details: { fields: ["cashHandedOverPaise", "note"] },
    });
    const otherDay = await submitHandover.call(s.rt, s.lineman, {
      ...first,
      businessDate: "2026-10-12",
    });
    expect(!otherDay.ok && otherDay.error.details).toMatchObject({ fields: ["businessDate"] });
    expect((await history(s)).map((e) => e.type)).toEqual(["submitted", "submitted"]);
    expect(await audits(s, "handover.submit")).toHaveLength(2);
  });

  it("submit → return (note) → resubmit → accept; accepted is final", async () => {
    const s = await setup();
    await collect(s);
    const first = handover({ cashHandedOverPaise: 75_000, discrepancyReason: "other" });
    expect((await submitHandover.call(s.rt, s.lineman, first)).ok).toBe(true);
    const sessionId = (await session(s))?.id ?? "";

    const noNote = await returnHandover.call(s.rt, s.staff, {
      sessionId,
      submissionId: first.submissionId,
      note: "  ",
    });
    expect(!noNote.ok && noNote.error.code).toBe("VALIDATION");

    const returned = await returnHandover.call(s.rt, s.staff, {
      sessionId,
      submissionId: first.submissionId,
      note: "Count the notes again",
    });
    expect(returned.ok && returned.value).toEqual({
      sessionId,
      submissionId: first.submissionId,
      status: "returned",
      reviewedAt: NOW,
      reviewedBy: s.tenant.users.staff,
      reviewNote: "Count the notes again",
    });
    const own = await getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: TODAY });
    expect(own.ok && own.value).toMatchObject({
      status: "returned",
      handover: { reviewNote: "Count the notes again", reviewedAt: NOW },
    });
    // Accepting the returned submission is refused.
    const late = await acceptHandover.call(s.rt, s.owner, {
      sessionId,
      submissionId: first.submissionId,
    });
    expect(!late.ok && late.error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "already_returned", status: "returned" },
    });

    const second = handover();
    const resubmitted = await submitHandover.call(s.rt, s.lineman, second);
    expect(resubmitted.ok && resubmitted.value.day.handover).toMatchObject({
      discrepancyPaise: 0,
      reviewedAt: null,
      reviewNote: null,
    });
    // The office still has the first submission open on screen: refused, nothing changes.
    const stale = await acceptHandover.call(s.rt, s.owner, {
      sessionId,
      submissionId: first.submissionId,
    });
    expect(!stale.ok && stale.error.details).toEqual({
      reason: "resubmitted",
      status: "submitted",
    });

    const accepted = await acceptHandover.call(s.rt, s.owner, {
      sessionId,
      submissionId: second.submissionId,
      note: "OK",
    });
    expect(accepted.ok && accepted.value).toMatchObject({ status: "accepted", reviewNote: "OK" });
    const twice = await acceptHandover.call(s.rt, s.owner, {
      sessionId,
      submissionId: second.submissionId,
    });
    expect(!twice.ok && twice.error.details).toEqual({
      reason: "already_accepted",
      status: "accepted",
    });
    const after = await submitHandover.call(s.rt, s.lineman, handover());
    expect(!after.ok && after.error.code).toBe("HANDOVER_ALREADY_ACCEPTED");
    // The replay of an accepted submission still answers with the current state.
    const replay = await submitHandover.call(s.rt, s.lineman, second);
    expect(replay.ok && replay.value.day.status).toBe("accepted");

    const events = await history(s);
    expect(events.map((e) => [e.type, e.submissionId, e.actorId, e.note])).toEqual([
      ["submitted", first.submissionId, s.tenant.users.lineman, null],
      ["returned", first.submissionId, s.tenant.users.staff, "Count the notes again"],
      ["submitted", second.submissionId, s.tenant.users.lineman, null],
      ["accepted", second.submissionId, s.tenant.users.owner, "OK"],
    ]);
    expect(events[0]).toMatchObject({ cashExpectedPaise: 80_000, discrepancyPaise: -5_000 });
    // History is append-only.
    await expect(
      t.current.db.withTenant(s.tenant.operatorId, (tx) =>
        tx
          .update(handoverEvents)
          .set({ note: "edited" })
          .where(eq(handoverEvents.id, events[0]?.id ?? "")),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    expect(await audits(s, "handover.return")).toHaveLength(1);
    const [acceptAudit] = await audits(s, "handover.accept");
    expect(acceptAudit).toMatchObject({
      actorId: s.tenant.users.owner,
      before: { status: "submitted" },
      after: { status: "accepted", submission_id: second.submissionId, discrepancy_paise: 0 },
    });

    const detail = await getLinemanDay.call(s.rt, s.owner, {
      linemanId: s.tenant.users.lineman,
      businessDate: TODAY,
    });
    expect(detail.ok && detail.value.history.map((h) => h.type)).toEqual([
      "submitted",
      "returned",
      "submitted",
      "accepted",
    ]);
  });

  it("a payment reversed or synced after the handover moves the total, never the snapshot", async () => {
    const s = await setup();
    const { cash1 } = await collect(s);
    const input = handover();
    expect((await submitHandover.call(s.rt, s.lineman, input)).ok).toBe(true);
    const sessionId = (await session(s))?.id ?? "";
    expect(
      (await acceptHandover.call(s.rt, s.owner, { sessionId, submissionId: input.submissionId }))
        .ok,
    ).toBe(true);
    await reverse(s.rt, s.owner, cash1);
    await postField(s.rt, s.lineman, s.customerId, 10_000, "cash", earlier(10));
    const detail = await getLinemanDay.call(s.rt, s.owner, {
      linemanId: s.tenant.users.lineman,
      businessDate: TODAY,
    });
    expect(detail.ok && detail.value).toMatchObject({
      changedSinceHandover: true,
      day: {
        status: "accepted",
        cashExpectedPaise: 40_000,
        handover: { cashExpectedPaise: 80_000, cashHandedOverPaise: 80_000, discrepancyPaise: 0 },
      },
    });
  });

  it("a handover on a day with no server payments (all still on the phone)", async () => {
    const s = await setup();
    const result = await submitHandover.call(
      s.rt,
      s.lineman,
      handover({
        cashHandedOverPaise: 25_000,
        discrepancyReason: "pending_sync",
        unsyncedPaymentCount: 3,
        unsyncedCashPaise: 25_000,
      }),
    );
    expect(result.ok && result.value.day).toMatchObject({
      cashExpectedPaise: 0,
      paymentCount: 0,
      status: "submitted",
      handover: {
        discrepancyPaise: 25_000,
        discrepancyReason: "pending_sync",
        unsyncedPaymentCount: 3,
        unsyncedCashPaise: 25_000,
      },
    });
  });

  it("validation, roles, NOT_FOUND and read-only mode", async () => {
    const s = await setup();
    const future = await submitHandover.call(
      s.rt,
      s.lineman,
      handover({ businessDate: "2026-10-14" }),
    );
    expect(!future.ok && future.error.details).toEqual({
      fields: [{ path: "businessDate", code: "future" }],
    });
    for (const bad of [
      { cashHandedOverPaise: -1 },
      { cashHandedOverPaise: 1.5 },
      { unsyncedPaymentCount: 10_001 },
      { note: "x".repeat(501) },
      { discrepancyReason: "lost" },
      { submissionId: "not-a-uuid" },
    ]) {
      const r = await submitHandover.call(s.rt, s.lineman, handover(bad) as never);
      expect(!r.ok && r.error.code, JSON.stringify(bad)).toBe("VALIDATION");
    }
    // Only the lineman hands over; only the office decides.
    const ownerSubmit = await submitHandover.call(s.rt, s.owner, handover());
    expect(!ownerSubmit.ok && ownerSubmit.error.code).toBe("FORBIDDEN");
    const input = handover({ cashHandedOverPaise: 0 });
    expect((await submitHandover.call(s.rt, s.lineman, input)).ok).toBe(true);
    const sessionId = (await session(s))?.id ?? "";
    const byLineman = await acceptHandover.call(s.rt, s.lineman, {
      sessionId,
      submissionId: input.submissionId,
    });
    expect(!byLineman.ok && byLineman.error.code).toBe("FORBIDDEN");
    const unknown = await acceptHandover.call(s.rt, s.owner, {
      sessionId: uuidv7(),
      submissionId: input.submissionId,
    });
    expect(!unknown.ok && unknown.error.code).toBe("NOT_FOUND");

    // Read-only tenant (D-13): the lineman still hands over; the office can't decide.
    await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
    const resubmit = handover({ cashHandedOverPaise: 0 });
    expect((await submitHandover.call(s.rt, s.lineman, resubmit)).ok).toBe(true);
    const blocked = await acceptHandover.call(s.rt, s.owner, {
      sessionId,
      submissionId: resubmit.submissionId,
    });
    expect(!blocked.ok && blocked.error.code).toBe("TENANT_READ_ONLY");
    const view = await getLinemanDay.call(s.rt, s.owner, {
      linemanId: s.tenant.users.lineman,
      businessDate: TODAY,
    });
    expect(view.ok).toBe(true);
  });

  it("an open day can't be accepted", async () => {
    const s = await setup();
    await collect(s);
    const sessionId = (await session(s))?.id ?? "";
    const result = await acceptHandover.call(s.rt, s.owner, { sessionId, submissionId: uuidv7() });
    expect(!result.ok && result.error.details).toEqual({ reason: "not_submitted", status: "open" });
  });

  it("another tenant's submission id makes an independent submission (keys are per tenant)", async () => {
    const a = await setup();
    const b = await setup();
    const input = handover({ cashHandedOverPaise: 0 });
    expect((await submitHandover.call(b.rt, b.lineman, input)).ok).toBe(true);
    const before = await history(b);
    const result = await submitHandover.call(a.rt, a.lineman, {
      ...input,
      cashHandedOverPaise: 0,
    });
    expect(result.ok && result.value.outcome).toBe("submitted");
    expect(result.ok && result.value.day.collectorId).toBe(a.tenant.users.lineman);
    expect(JSON.stringify(result.ok && result.value)).not.toContain(b.tenant.users.lineman);
    expect(await history(b)).toEqual(before);
    expect(await history(a)).toHaveLength(1);
  });
});
