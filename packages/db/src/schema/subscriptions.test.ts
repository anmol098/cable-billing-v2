/**
 * subscriptions / subscription_events (FR-025, PLAN §13): tenant reads its own state, the
 * platform role reads and updates state, webhook events are stored once and never rewritten.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { subscriptionEvents, subscriptions } from "./subscriptions";

const RLS_VIOLATION = "42501";
const CHECK_VIOLATION = "23514";
const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;
const DAY = 86_400_000;

describeDb("subscriptions", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    for (const tenant of [a, b]) {
      // Provisioning creates the row inside the new tenant's own transaction.
      await t.current.db.withTenant(tenant.operatorId, (tx) =>
        tx.insert(subscriptions).values({
          operatorId: tenant.operatorId,
          trialEndsAt: new Date(Date.now() + 30 * DAY),
        }),
      );
    }
  });

  it("a tenant reads only its own subscription", async () => {
    const seen = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select().from(subscriptions),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ operatorId: a.operatorId, status: "trialing" });
  });

  it("the platform role reads and updates every subscription but can't create or delete one", async () => {
    const all = await t.current.db.withPlatform((tx) =>
      tx.select({ operatorId: subscriptions.operatorId }).from(subscriptions),
    );
    expect(all.map((s) => s.operatorId).sort()).toEqual([a.operatorId, b.operatorId].sort());
    const moved = await t.current.db.withPlatform((tx) =>
      tx
        .update(subscriptions)
        .set({ status: "grace", graceEndsAt: new Date(Date.now() + 15 * DAY) })
        .where(eq(subscriptions.operatorId, b.operatorId))
        .returning({ status: subscriptions.status }),
    );
    expect(moved).toEqual([{ status: "grace" }]);
    const ghost = await createTenant(t.current);
    await expect(
      t.current.db.withPlatform((tx) =>
        tx.insert(subscriptions).values({ operatorId: ghost.operatorId, status: "active" }),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    const deleted = await t.current.db.withPlatform((tx) => tx.delete(subscriptions).returning());
    expect(deleted).toEqual([]);
  });

  it("requires the end dates of trial and grace", async () => {
    const tenant = await createTenant(t.current);
    await expect(
      t.current.db.withTenant(tenant.operatorId, (tx) =>
        tx.insert(subscriptions).values({ operatorId: tenant.operatorId }),
      ),
    ).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.update(subscriptions).set({ status: "grace" }),
      ),
    ).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
  });

  it("stores each Razorpay event once; a duplicate delivery changes nothing", async () => {
    const deliver = () =>
      t.current.db.withPlatform((tx) =>
        tx
          .insert(subscriptionEvents)
          .values({
            id: uuidv7(),
            operatorId: a.operatorId,
            razorpayEventId: "evt_T021_1",
            type: "subscription.charged",
            payload: { event: "subscription.charged" },
          })
          .onConflictDoNothing({ target: subscriptionEvents.razorpayEventId })
          .returning({ id: subscriptionEvents.id }),
      );
    expect(await deliver()).toHaveLength(1);
    expect(await deliver()).toEqual([]);
    const count = await t.current.admin.query(
      "SELECT count(*)::int AS n FROM subscription_events WHERE razorpay_event_id = 'evt_T021_1'",
    );
    expect(count.rows[0]).toEqual({ n: 1 });
  });

  it("events are immutable except their processing outcome", async () => {
    await t.current.db.withPlatform((tx) =>
      tx
        .update(subscriptionEvents)
        .set({ processedAt: sql`now()`, processingError: null })
        .where(eq(subscriptionEvents.razorpayEventId, "evt_T021_1")),
    );
    await expect(
      t.current.db.withPlatform((tx) =>
        tx
          .update(subscriptionEvents)
          .set({ payload: { forged: true } })
          .where(eq(subscriptionEvents.razorpayEventId, "evt_T021_1")),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(t.current.admin.query("DELETE FROM subscription_events")).rejects.toSatisfy(
      isImmutableRowError,
    );
  });

  it("a tenant sees only its own events", async () => {
    await t.current.db.withPlatform((tx) =>
      tx.insert(subscriptionEvents).values([
        {
          id: uuidv7(),
          operatorId: b.operatorId,
          razorpayEventId: "evt_T021_2",
          type: "subscription.activated",
          payload: {},
        },
        { id: uuidv7(), razorpayEventId: "evt_T021_3", type: "payment.failed", payload: {} },
      ]),
    );
    const seen = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select({ eventId: subscriptionEvents.razorpayEventId }).from(subscriptionEvents),
    );
    expect(seen).toEqual([{ eventId: "evt_T021_1" }]);
  });
});
