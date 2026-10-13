/**
 * The collection day reads against a real database (T-062, PLAN §8.7, FR-022): per lineman per
 * IST day, expected cash = cash payments not reversed (UPI apart, never handed over), counts,
 * the Linemen page cards and order, the review screen, the phone warning from `last_seen_at`,
 * and the lineman's own day.
 */
import { users, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { businessDate } from "@cb/domain";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { getLinemanDay, getLinemenDay, getOwnCollectionDay } from "./day";
import { submitHandover } from "./handover";
import { PHONE_STALE_AFTER_MS } from "./rules";
import {
  addLineman,
  newCustomer,
  postField,
  recomputeTotals,
  reverse,
  setLastSeen,
} from "./test-support";

const NOW = new Date("2026-10-13T12:30:00.000Z"); // 18:00 IST, 13 Oct 2026
const TODAY = businessDate("2026-10-13");
const YESTERDAY = businessDate("2026-10-12");
const minutes = (n: number) => n * 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describeDb("collections: day totals and the Linemen page", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
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
    };
  }

  const linemenDay = async (s: Setup, date: string, ctx = s.owner) => {
    const result = await getLinemenDay.call(s.rt, ctx, { businessDate: date });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };

  it("expected cash excludes UPI and reversed payments; equals the payments recomputed", async () => {
    const s = await setup();
    const customer = await newCustomer(t.current.db, s.tenant);
    const cash1 = await postField(s.rt, s.lineman, customer, 50_000, "cash", at(-minutes(60)));
    const cash2 = await postField(s.rt, s.lineman, customer, 30_000, "cash", at(-minutes(50)));
    await postField(s.rt, s.lineman, customer, 20_000, "upi", at(-minutes(40)));
    const upi2 = await postField(s.rt, s.lineman, customer, 15_000, "upi", at(-minutes(30)));
    // Yesterday's (IST) payment belongs to yesterday's session.
    await postField(s.rt, s.lineman, customer, 7_000, "cash", new Date("2026-10-12T18:00:00Z"));
    // A web counter payment by the owner is not a lineman's cash (T-046 decision 3).
    const counter = await postPayment.call(s.rt, s.owner, {
      id: uuidv7(),
      customerId: customer,
      amountPaise: 99_900,
      method: "cash",
    });
    expect(counter.ok).toBe(true);
    await reverse(s.rt, s.owner, cash2);
    await reverse(s.rt, s.owner, upi2);

    const own = await getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: TODAY });
    if (!own.ok) throw new Error(own.error.code);
    expect(own.value).toMatchObject({
      collectorId: s.tenant.users.lineman,
      businessDate: TODAY,
      cashExpectedPaise: 50_000,
      upiTotalPaise: 20_000,
      paymentCount: 2,
      status: "open",
      handover: null,
    });
    // Newest first, reversed ones listed and flagged; only this lineman's Android payments.
    expect(own.value.payments.map((p) => [p.amountPaise, p.method, p.reversed])).toEqual([
      [15_000, "upi", true],
      [20_000, "upi", false],
      [30_000, "cash", true],
      [50_000, "cash", false],
    ]);
    expect(own.value.payments.find((p) => p.paymentId === cash1)).toMatchObject({
      customerId: customer,
      receiptNumber: expect.stringMatching(/^R-2610-\d{5}$/),
      provisionalRef: "P-TST-0001",
      needsReview: false,
    });

    const recomputed = await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      recomputeTotals(tx, s.tenant.operatorId, s.tenant.users.lineman, TODAY),
    );
    expect(recomputed).toEqual({ cash: 50_000, upi: 20_000, count: 2 });

    const yesterday = await getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: YESTERDAY });
    expect(yesterday.ok && yesterday.value.cashExpectedPaise).toBe(7_000);

    const page = await linemenDay(s, TODAY);
    expect(page.totals).toEqual({
      cashExpectedPaise: 50_000,
      upiTotalPaise: 20_000,
      paymentCount: 2,
      waitingCount: 0,
    });
    expect(page.isToday).toBe(true);
    expect(page.linemen).toHaveLength(1);
    expect(page.linemen[0]).toMatchObject({
      linemanId: s.tenant.users.lineman,
      active: true,
      cashExpectedPaise: 50_000,
      upiTotalPaise: 20_000,
      paymentCount: 2,
      status: "open",
      handover: null,
      changedSinceHandover: false,
    });
  }, 60_000);

  it("a day with nothing is all zero and open; future days are VALIDATION", async () => {
    const s = await setup();
    const own = await getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: "2026-10-01" });
    expect(own.ok && own.value).toMatchObject({
      sessionId: null,
      cashExpectedPaise: 0,
      upiTotalPaise: 0,
      paymentCount: 0,
      status: "open",
      handover: null,
      payments: [],
    });
    // Owner/Staff may call it too: always their own (empty) day.
    const ownerDay = await getOwnCollectionDay.call(s.rt, s.owner, { businessDate: TODAY });
    expect(ownerDay.ok && ownerDay.value.collectorId).toBe(s.tenant.users.owner);

    for (const call of [
      getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: "2026-10-14" }),
      getLinemenDay.call(s.rt, s.owner, { businessDate: "2026-10-14" }),
      getLinemanDay.call(s.rt, s.owner, {
        linemanId: s.tenant.users.lineman,
        businessDate: "2026-10-14",
      }),
    ]) {
      const result = await call;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.details).toEqual({
          fields: [{ path: "businessDate", code: "future" }],
        });
      }
    }
    const bad = await getLinemenDay.call(s.rt, s.owner, { businessDate: "2026-02-30" });
    expect(!bad.ok && bad.error.code).toBe("VALIDATION");
  });

  it("cards: one per active lineman, deactivated only with a session, waiting first", async () => {
    const s = await setup();
    const customer = await newCustomer(t.current.db, s.tenant);
    const ravi = await addLineman(t.current, s.rt, s.tenant, { name: "Ravi", deviceCode: "R1V" });
    const amit = await addLineman(t.current, s.rt, s.tenant, { name: "Amit", deviceCode: "A1M" });
    const gone = await addLineman(t.current, s.rt, s.tenant, { name: "Gopal", deviceCode: "G0P" });
    const idle = await addLineman(t.current, s.rt, s.tenant, { name: "Inder", deviceCode: "I9D" });
    await postField(s.rt, ravi.ctx, customer, 10_000, "cash", at(-minutes(90)));
    await postField(s.rt, amit.ctx, customer, 20_000, "cash", at(-minutes(80)));
    await postField(s.rt, gone.ctx, customer, 40_000, "upi", at(-minutes(70)));
    const submitted = await submitHandover.call(s.rt, ravi.ctx, {
      businessDate: TODAY,
      submissionId: uuidv7(),
      cashHandedOverPaise: 10_000,
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    });
    expect(submitted.ok).toBe(true);
    // Gopal and Inder are deactivated; only Gopal collected today.
    await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = ANY($1)", [
      [gone.userId, idle.userId],
    ]);

    const page = await linemenDay(s, TODAY);
    expect(page.linemen.map((c) => [c.name, c.status, c.active])).toEqual([
      ["Ravi", "submitted", true],
      ["Amit", "open", true],
      ["Gopal", "open", false],
      [expect.stringMatching(/^Test User/), "open", true], // the seeded lineman, nothing today
    ]);
    expect(page.totals).toEqual({
      cashExpectedPaise: 30_000,
      upiTotalPaise: 40_000,
      paymentCount: 3,
      waitingCount: 1,
    });
    const raviCard = page.linemen[0];
    expect(raviCard?.handover).toMatchObject({
      cashExpectedPaise: 10_000,
      cashHandedOverPaise: 10_000,
      discrepancyPaise: 0,
      discrepancyReason: null,
    });

    // Staff sees the same page; a lineman may not (dashboard.view).
    expect((await linemenDay(s, TODAY, s.staff)).linemen).toHaveLength(4);
    const forbidden = await getLinemenDay.call(s.rt, s.lineman, { businessDate: TODAY });
    expect(!forbidden.ok && forbidden.error.code).toBe("FORBIDDEN");

    // Another day: the deactivated linemen without a session there are gone.
    const other = await linemenDay(s, YESTERDAY);
    expect(other.linemen.map((c) => c.name).sort()).toEqual(
      ["Amit", "Ravi", expect.stringMatching(/^Test User/)].sort(),
    );
    expect(other.isToday).toBe(false);
  }, 60_000);

  it("phone warning: last contact older than 30 min before the day's end (or now)", async () => {
    const s = await setup();
    const card = async (date: string) => {
      const page = await linemenDay(s, date);
      const found = page.linemen.find((c) => c.linemanId === s.tenant.users.lineman);
      if (!found) throw new Error("no card");
      return found.phone;
    };
    // Never seen (no sign-in recorded): nothing can be waiting on a phone.
    await setLastSeen(t.current, s.tenant.users.lineman, null);
    expect(await card(TODAY)).toMatchObject({ lastSeenAt: null, phoneNotSeen: false });

    // Today: compared with now.
    await setLastSeen(t.current, s.tenant.users.lineman, at(-PHONE_STALE_AFTER_MS));
    expect((await card(TODAY)).phoneNotSeen).toBe(false);
    await setLastSeen(t.current, s.tenant.users.lineman, at(-PHONE_STALE_AFTER_MS - 1));
    expect(await card(TODAY)).toMatchObject({
      lastSeenAt: at(-PHONE_STALE_AFTER_MS - 1),
      lastContactAt: at(-PHONE_STALE_AFTER_MS - 1),
      phoneNotSeen: true,
    });

    // Yesterday: compared with the end of yesterday in IST (13 Oct 00:00 IST = 12 Oct 18:30 UTC).
    const yesterdayEnd = new Date("2026-10-12T18:30:00.000Z");
    await setLastSeen(
      t.current,
      s.tenant.users.lineman,
      new Date(yesterdayEnd.getTime() - minutes(31)),
    );
    expect((await card(YESTERDAY)).phoneNotSeen).toBe(true);
    await setLastSeen(
      t.current,
      s.tenant.users.lineman,
      new Date(yesterdayEnd.getTime() - minutes(29)),
    );
    expect((await card(YESTERDAY)).phoneNotSeen).toBe(false);

    // A signed-out phone doesn't count.
    await t.current.admin.query("UPDATE devices SET revoked_at = now() WHERE user_id = $1", [
      s.tenant.users.lineman,
    ]);
    expect(await card(TODAY)).toMatchObject({ lastSeenAt: null, phoneNotSeen: false });
  }, 60_000);

  it("the handover counts as a contact and carries the phone's unsynced report", async () => {
    const s = await setup();
    await setLastSeen(t.current, s.tenant.users.lineman, at(-minutes(120)));
    const rt = testRuntime(t.current.db, { now: () => at(-minutes(5)) });
    const submitted = await submitHandover.call(rt, s.lineman, {
      businessDate: TODAY,
      submissionId: uuidv7(),
      cashHandedOverPaise: 5_000,
      discrepancyReason: "pending_sync",
      unsyncedPaymentCount: 2,
      unsyncedCashPaise: 5_000,
    });
    expect(submitted.ok).toBe(true);
    const page = await linemenDay(s, TODAY);
    expect(page.linemen[0]?.phone).toEqual({
      lastSeenAt: at(-minutes(120)),
      lastContactAt: at(-minutes(5)),
      phoneNotSeen: false,
      reportedUnsyncedCount: 2,
      reportedUnsyncedCashPaise: 5_000,
    });
  });

  it("review screen: payments, handover, history; NOT_FOUND for non-linemen and unknown ids", async () => {
    const s = await setup();
    const customer = await newCustomer(t.current.db, s.tenant);
    await postField(s.rt, s.lineman, customer, 12_300, "cash", at(-minutes(20)));
    const submissionId = uuidv7();
    const submitted = await submitHandover.call(s.rt, s.lineman, {
      businessDate: TODAY,
      submissionId,
      cashHandedOverPaise: 12_000,
      discrepancyReason: "short",
      note: "Change given",
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    });
    expect(submitted.ok).toBe(true);
    const day = await getLinemanDay.call(s.rt, s.staff, {
      linemanId: s.tenant.users.lineman,
      businessDate: TODAY,
    });
    if (!day.ok) throw new Error(day.error.code);
    const [lineman] = await t.current.db.withTenant(s.tenant.operatorId, (tx) =>
      tx.select({ name: users.name }).from(users).where(eq(users.id, s.tenant.users.lineman)),
    );
    expect(day.value).toMatchObject({
      linemanId: s.tenant.users.lineman,
      name: lineman?.name,
      active: true,
      isToday: true,
      changedSinceHandover: false,
      day: {
        cashExpectedPaise: 12_300,
        status: "submitted",
        handover: {
          submissionId,
          cashExpectedPaise: 12_300,
          cashHandedOverPaise: 12_000,
          discrepancyPaise: -300,
          discrepancyReason: "short",
          note: "Change given",
          submittedAt: NOW,
          reviewedAt: null,
        },
      },
      history: [
        {
          type: "submitted",
          submissionId,
          actorId: s.tenant.users.lineman,
          actorName: lineman?.name,
          cashExpectedPaise: 12_300,
          cashHandedOverPaise: 12_000,
          discrepancyPaise: -300,
          discrepancyReason: "short",
          note: "Change given",
          at: NOW,
        },
      ],
    });
    expect(day.value.day.payments).toHaveLength(1);

    for (const linemanId of [s.tenant.users.owner, uuidv7()]) {
      const missing = await getLinemanDay.call(s.rt, s.owner, { linemanId, businessDate: TODAY });
      expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
    }
    // A lineman with nothing that day still opens (zeros).
    const empty = await getLinemanDay.call(s.rt, s.owner, {
      linemanId: s.tenant.users.lineman,
      businessDate: YESTERDAY,
    });
    expect(empty.ok && empty.value.day).toMatchObject({ sessionId: null, status: "open" });
  });
});
