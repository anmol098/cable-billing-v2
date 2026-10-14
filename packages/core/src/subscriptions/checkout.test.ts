/**
 * Checkout against a real database and a fake Razorpay (never the real API): Owner only, new /
 * reused / replaced subscriptions, first charge after the trial or paid month, the plan-price
 * check, provider failures, and confirmation (signature, current subscription, state from the API).
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { describe, expect, it } from "vitest";
import { contextFor, seedTenant, testRuntime } from "../testing/fixtures";
import {
  confirmSubscriptionCheckout,
  firstChargeAt,
  planMatches,
  startSubscriptionCheckout,
} from "./checkout";
import { MONTHLY_PLAN } from "./plan";
import { createFakeRazorpayClient, FAKE_PLAN_ID } from "./razorpay/fake";
import { razorpayHmac } from "./razorpay/signature";
import { subscriptionOverview, subscriptionViewOf } from "./services";
import { KEY_SECRET, setSubscriptionRow, subscriptionRow } from "./test-support";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-01T06:00:00Z");
const TRIAL_END = at("2026-11-12T18:30:00Z");

describe("checkout rules (pure)", () => {
  it("the Razorpay plan must charge exactly ₹472 INR every month", () => {
    const good = { period: "monthly", interval: 1, item: { amount: 47_200, currency: "INR" } };
    expect(planMatches(good, MONTHLY_PLAN)).toBe(true);
    expect(planMatches({ ...good, item: { amount: 40_000, currency: "INR" } }, MONTHLY_PLAN)).toBe(
      false,
    );
    expect(planMatches({ ...good, item: { amount: 47_200, currency: "USD" } }, MONTHLY_PLAN)).toBe(
      false,
    );
    expect(planMatches({ ...good, period: "yearly" }, MONTHLY_PLAN)).toBe(false);
    expect(planMatches({ ...good, interval: 3 }, MONTHLY_PLAN)).toBe(false);
  });

  it("first charge waits for the end of the trial or of the paid month, if still ahead", () => {
    const base = subscriptionViewOf("00000000-0000-7000-8000-000000000001", null, []);
    const trial = { ...base, status: "trialing" as const, trialEndsAt: TRIAL_END };
    expect(firstChargeAt(trial, NOW)).toEqual(TRIAL_END);
    expect(firstChargeAt(trial, at("2026-11-12T18:20:00Z"))).toBeNull(); // too close: charge now
    const active = {
      ...base,
      status: "active" as const,
      currentPeriodEnd: at("2026-12-01T00:00:00Z"),
    };
    expect(firstChargeAt(active, NOW)).toEqual(at("2026-12-01T00:00:00Z"));
    for (const status of ["grace", "read_only", "cancelled"] as const) {
      expect(firstChargeAt({ ...base, status, trialEndsAt: TRIAL_END }, NOW)).toBeNull();
    }
  });
});

describeDb("subscription checkout", () => {
  const t = useTestDatabase();

  async function setup(status: "trialing" | "grace" | "read_only" | "active" = "trialing") {
    const tenant = await seedTenant(t.current, { subscription: status });
    await setSubscriptionRow(t.current, tenant.operatorId, {
      status,
      trialEndsAt: TRIAL_END,
      graceEndsAt: status === "grace" ? at("2026-11-27T18:30:00Z") : null,
      currentPeriodEnd: status === "active" ? at("2026-11-20T00:00:00Z") : null,
    });
    const runtime = testRuntime(t.current.db, { now: () => NOW });
    const owner = await contextFor(runtime, tenant, "owner");
    const razorpay = createFakeRazorpayClient({ now: () => NOW });
    const config = { razorpay, keyId: "rzp_test_Fake123", planId: FAKE_PLAN_ID };
    return { tenant, runtime, owner, razorpay, config };
  }

  it("Owner only: Staff get FORBIDDEN and Razorpay is never called", async () => {
    const { tenant, runtime, razorpay, config } = await setup();
    const staff = await contextFor(runtime, tenant, "staff");
    const result = await startSubscriptionCheckout(runtime, staff, config);
    expect(result.ok ? null : result.error.code).toBe("FORBIDDEN");
    expect(razorpay.calls).toEqual([]);
    const view = await subscriptionOverview.call(runtime, staff, {});
    expect(view.ok ? null : view.error.code).toBe("FORBIDDEN");
  });

  it("trial: creates a ₹472 monthly subscription starting when the trial ends, and records it", async () => {
    const { tenant, runtime, owner, razorpay, config } = await setup("trialing");
    const result = await startSubscriptionCheckout(runtime, owner, config);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({
      kind: "open_checkout",
      keyId: "rzp_test_Fake123",
      firstChargeAt: TRIAL_END,
      totalPaise: 47_200,
    });
    const created = razorpay.calls.find((c) => c.method === "createSubscription");
    expect(created?.input).toEqual({
      planId: FAKE_PLAN_ID,
      totalCount: 120,
      customerNotify: true,
      startAt: TRIAL_END,
      notes: { operator_id: tenant.operatorId, plan_code: MONTHLY_PLAN.code },
    });
    if (result.value.kind !== "open_checkout") throw new Error("expected checkout");
    expect(await subscriptionRow(t.current, tenant.operatorId)).toMatchObject({
      status: "trialing",
      razorpay_subscription_id: result.value.subscriptionId,
      razorpay_status: "created",
      plan_code: MONTHLY_PLAN.code,
    });
    const audit = await t.current.admin.query(
      `SELECT action, actor_id FROM audit_events WHERE operator_id = $1 AND action = 'subscriptions.checkout_started'`,
      [tenant.operatorId],
    );
    expect(audit.rows).toEqual([
      { action: "subscriptions.checkout_started", actor_id: tenant.users.owner },
    ]);

    // Pressing Pay again before finishing reuses the same subscription (no orphans).
    const again = await startSubscriptionCheckout(runtime, owner, config);
    if (!again.ok || again.value.kind !== "open_checkout") throw new Error("expected checkout");
    expect(again.value.subscriptionId).toBe(result.value.subscriptionId);
    expect(razorpay.calls.filter((c) => c.method === "createSubscription")).toHaveLength(1);
  });

  it("read-only tenants can pay (allowlisted) and are charged at once", async () => {
    const { runtime, owner, razorpay, config } = await setup("read_only");
    const result = await startSubscriptionCheckout(runtime, owner, config);
    expect(
      result.ok && result.value.kind === "open_checkout" ? result.value.firstChargeAt : "x",
    ).toBeNull();
    const created = razorpay.calls.find((c) => c.method === "createSubscription");
    expect(created?.input).not.toHaveProperty("startAt");
  });

  it("autopay already on: nothing to pay, the state is refreshed from Razorpay", async () => {
    const { tenant, runtime, owner, razorpay, config } = await setup("grace");
    const first = await startSubscriptionCheckout(runtime, owner, config);
    if (!first.ok || first.value.kind !== "open_checkout")
      throw new Error(`expected checkout: ${JSON.stringify(first)}`);
    razorpay.update(first.value.subscriptionId, {
      status: "active",
      currentEnd: at("2026-12-01T06:00:00Z"),
    });
    const second = await startSubscriptionCheckout(runtime, owner, config);
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.kind).toBe("autopay_on");
    expect(await subscriptionRow(t.current, tenant.operatorId)).toMatchObject({
      status: "active",
      current_period_end: at("2026-12-01T06:00:00Z"),
      razorpay_status: "active",
    });
  });

  it("a halted subscription is cancelled before a new one is made (no double charge)", async () => {
    const { tenant, runtime, owner, razorpay, config } = await setup("grace");
    const first = await startSubscriptionCheckout(runtime, owner, config);
    if (!first.ok || first.value.kind !== "open_checkout")
      throw new Error(`expected checkout: ${JSON.stringify(first)}`);
    const oldId = first.value.subscriptionId;
    razorpay.update(oldId, { status: "halted" });
    const second = await startSubscriptionCheckout(runtime, owner, config);
    if (!second.ok || second.value.kind !== "open_checkout") throw new Error("expected checkout");
    expect(second.value.subscriptionId).not.toBe(oldId);
    expect(razorpay.calls).toContainEqual({
      method: "cancelSubscription",
      id: oldId,
      input: { atCycleEnd: false },
    });
    expect((await subscriptionRow(t.current, tenant.operatorId)).razorpay_subscription_id).toBe(
      second.value.subscriptionId,
    );
    // If cancelling fails, no new subscription is made.
    razorpay.update(second.value.subscriptionId, { status: "pending" });
    razorpay.failNext("cancelSubscription");
    const third = await startSubscriptionCheckout(runtime, owner, config);
    expect(third.ok ? null : third.error.code).toBe("PAYMENT_PROVIDER_ERROR");
    expect(razorpay.calls.filter((c) => c.method === "createSubscription")).toHaveLength(2);
  });

  it("refuses when the Razorpay plan's price differs from the configured one", async () => {
    const { tenant, runtime, owner, razorpay, config } = await setup();
    razorpay.setPlan({
      id: FAKE_PLAN_ID,
      period: "monthly",
      interval: 1,
      item: { amount: 40_000, currency: "INR" },
    });
    const result = await startSubscriptionCheckout(runtime, owner, config);
    expect(result.ok ? null : result.error.code).toBe("PLAN_MISMATCH");
    expect(razorpay.calls.some((c) => c.method === "createSubscription")).toBe(false);
    expect(
      (await subscriptionRow(t.current, tenant.operatorId)).razorpay_subscription_id,
    ).toBeNull();
    expect(runtime.records.some((r) => r.event === "subscription.plan_mismatch")).toBe(true);
  });

  it("a Razorpay outage is PAYMENT_PROVIDER_ERROR and changes nothing", async () => {
    const { tenant, runtime, owner, razorpay, config } = await setup();
    razorpay.failNext("createSubscription");
    const result = await startSubscriptionCheckout(runtime, owner, config);
    expect(result.ok ? null : result.error).toMatchObject({
      code: "PAYMENT_PROVIDER_ERROR",
      details: { razorpayCode: "SERVER_ERROR", httpStatus: 502 },
    });
    expect(
      (await subscriptionRow(t.current, tenant.operatorId)).razorpay_subscription_id,
    ).toBeNull();
  });

  it("confirm: checks the signature and the subscription, then takes the state from Razorpay", async () => {
    const { tenant, runtime, owner, razorpay, config } = await setup("read_only");
    const started = await startSubscriptionCheckout(runtime, owner, config);
    if (!started.ok || started.value.kind !== "open_checkout") throw new Error("expected checkout");
    const subscriptionId = started.value.subscriptionId;
    const paymentId = "pay_TestConfirm01";
    const signature = razorpayHmac(`${paymentId}|${subscriptionId}`, KEY_SECRET);
    const confirmConfig = { razorpay, keySecret: KEY_SECRET };

    const forged = await confirmSubscriptionCheckout(runtime, owner, confirmConfig, {
      paymentId,
      subscriptionId,
      signature: razorpayHmac(`${paymentId}|${subscriptionId}`, "wrong-secret"),
    });
    expect(forged.ok ? null : forged.error.code).toBe("BAD_SIGNATURE");
    const otherSub = "sub_SomebodyElse1";
    const notMine = await confirmSubscriptionCheckout(runtime, owner, confirmConfig, {
      paymentId,
      subscriptionId: otherSub,
      signature: razorpayHmac(`${paymentId}|${otherSub}`, KEY_SECRET),
    });
    expect(notMine.ok ? null : notMine.error.code).toBe("NOT_FOUND");
    expect((await subscriptionRow(t.current, tenant.operatorId)).status).toBe("read_only");

    // The browser says "paid" but Razorpay doesn't (yet): nothing changes.
    const early = await confirmSubscriptionCheckout(runtime, owner, confirmConfig, {
      paymentId,
      subscriptionId,
      signature,
    });
    expect(early.ok && early.value.status).toBe("read_only");
    // Razorpay charged: active, missed bill months listed.
    await t.current.admin.query(
      `INSERT INTO billing_runs (id, operator_id, period, trigger, status, skip_reason, finished_at)
       VALUES (gen_random_uuid(), $1, '2026-11-01', 'cron', 'skipped', 'tenant_read_only', now())`,
      [tenant.operatorId],
    );
    razorpay.update(subscriptionId, { status: "active", currentEnd: at("2026-12-01T06:00:00Z") });
    const done = await confirmSubscriptionCheckout(runtime, owner, confirmConfig, {
      paymentId,
      subscriptionId,
      signature,
    });
    if (!done.ok) throw new Error(done.error.code);
    expect(done.value).toMatchObject({
      status: "active",
      mode: "normal",
      autopay: "on",
      accessLastDay: "2026-12-01",
      missedRunPeriods: ["2026-11-01"],
      canPay: false,
    });
    const audit = await t.current.admin.query(
      `SELECT actor_id, after->>'source' AS source FROM audit_events
        WHERE operator_id = $1 AND action = 'subscription.state_changed'`,
      [tenant.operatorId],
    );
    expect(audit.rows).toContainEqual({
      actor_id: tenant.users.owner,
      source: "checkout_confirmed",
    });
  });

  it("the overview fails closed without a subscription row", async () => {
    const tenant = await seedTenant(t.current, { subscription: null });
    const runtime = testRuntime(t.current.db, { now: () => NOW });
    const owner = await contextFor(runtime, tenant, "owner");
    const view = await subscriptionOverview.call(runtime, owner, {});
    expect(view.ok && view.value).toMatchObject({ status: null, mode: "read_only", canPay: false });
    const result = await startSubscriptionCheckout(runtime, owner, {
      razorpay: createFakeRazorpayClient(),
      keyId: "rzp_test_Fake123",
      planId: FAKE_PLAN_ID,
    });
    expect(result.ok ? null : result.error.code).toBe("INTERNAL");
  });
});
