/**
 * Razorpay webhooks against a real database (T-085): signature (valid / invalid / missing /
 * other secret / body changed), idempotent storage (duplicate delivery, concurrent duplicates,
 * replay under a new event id), the state machine driven by Razorpay test-mode fixtures, unmatched
 * and unreadable events, append-only storage, and tenant isolation.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import { changedTables, databaseFingerprint } from "../testing/fingerprint";
import { captureLogs, type SeededTenant, seedTenant } from "../testing/fixtures";
import { razorpayHmac } from "./razorpay/signature";
import {
  type FixtureName,
  newEventId,
  newSubscriptionId,
  razorpayFixture,
  setSubscriptionRow,
  signedDelivery,
  subscriptionRow,
  WEBHOOK_SECRET,
} from "./test-support";
import { handleRazorpayWebhook } from "./webhook";

const at = (iso: string) => new Date(iso);
/** Just after the fixtures' first charge (04:05 UTC, 13 Nov 2026). */
const NOW = at("2026-11-13T04:10:00Z");
const PAID_END = at("2026-12-13T04:05:00Z");

describeDb("Razorpay webhook", () => {
  const t = useTestDatabase();

  function deps(now: Date = NOW) {
    const logs = captureLogs();
    return {
      deps: { db: t.current.db, log: logs.logger, now: () => now, secret: WEBHOOK_SECRET },
      logs,
    };
  }

  async function tenantWithSubscription(
    status: "trialing" | "grace" | "read_only" | "active" | "cancelled" = "trialing",
  ): Promise<{ tenant: SeededTenant; subscriptionId: string }> {
    const tenant = await seedTenant(t.current, { subscription: status });
    const subscriptionId = newSubscriptionId();
    await setSubscriptionRow(t.current, tenant.operatorId, {
      status,
      trialEndsAt: at("2026-11-20T18:30:00Z"),
      graceEndsAt: status === "grace" ? at("2026-11-27T18:30:00Z") : null,
      currentPeriodEnd: status === "active" ? PAID_END : null,
      razorpaySubscriptionId: subscriptionId,
      razorpayStatus: "created",
      razorpayStatusAt: at("2026-11-13T04:00:00Z"),
    });
    return { tenant, subscriptionId };
  }

  async function events(operatorId: string | null) {
    const result = await t.current.admin.query<{
      razorpay_event_id: string;
      type: string;
      operator_id: string | null;
      processed_at: Date | null;
      processing_error: string | null;
    }>(
      `SELECT razorpay_event_id, type, operator_id, processed_at, processing_error
         FROM subscription_events WHERE operator_id IS NOT DISTINCT FROM $1 ORDER BY received_at, id`,
      [operatorId],
    );
    return result.rows;
  }

  function deliver(
    name: FixtureName,
    subscriptionId: string,
    operatorId: string | null,
    eventId = newEventId(),
  ) {
    return signedDelivery(razorpayFixture(name, { subscriptionId, operatorId }), eventId);
  }

  it("refuses a missing, wrong or other-secret signature and a changed body: 401, nothing stored", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("grace");
    const good = deliver("subscription.charged", subscriptionId, tenant.operatorId);
    const before = await databaseFingerprint(t.current);
    const { deps: d, logs } = deps();
    const attempts = [
      { ...good, signature: null },
      { ...good, signature: "" },
      { ...good, signature: "not-hex" },
      { ...good, signature: "0".repeat(64) },
      {
        ...good,
        signature: signedDelivery(JSON.parse(good.rawBody), good.eventId, "another-secret-123456")
          .signature,
      },
      { ...good, rawBody: good.rawBody.replace("47200", "1") },
      { ...good, rawBody: `${good.rawBody} ` },
    ];
    for (const attempt of attempts) {
      const result = await handleRazorpayWebhook(d, attempt);
      expect(result).toEqual({ httpStatus: 401, outcome: "invalid_signature" });
    }
    expect(changedTables(before, await databaseFingerprint(t.current))).toEqual([]);
    expect((await subscriptionRow(t.current, tenant.operatorId)).status).toBe("grace");
    expect(logs.records.filter((r) => r.event === "razorpay.webhook_bad_signature")).toHaveLength(
      attempts.length,
    );
    // An empty secret never verifies anything.
    const unset = await handleRazorpayWebhook({ ...d, secret: "" }, good);
    expect(unset.httpStatus).toBe(401);
  });

  it("a charge activates the tenant; the same delivery again has no effect", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("grace");
    const delivery = deliver("subscription.charged", subscriptionId, tenant.operatorId);
    const { deps: d } = deps();
    const first = await handleRazorpayWebhook(d, delivery);
    expect(first).toMatchObject({
      httpStatus: 200,
      outcome: "applied",
      eventType: "subscription.charged",
      operatorId: tenant.operatorId,
      reactivated: false,
    });
    const row = await subscriptionRow(t.current, tenant.operatorId);
    expect(row).toMatchObject({
      status: "active",
      current_period_end: PAID_END,
      grace_ends_at: null,
      razorpay_status: "active",
    });
    const stored = await events(tenant.operatorId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ type: "subscription.charged", processing_error: null });
    expect(stored[0]?.processed_at).toEqual(NOW);

    const before = await databaseFingerprint(t.current);
    for (let i = 0; i < 3; i += 1) {
      const again = await handleRazorpayWebhook(d, delivery);
      expect(again).toMatchObject({ httpStatus: 200, outcome: "duplicate" });
    }
    expect(changedTables(before, await databaseFingerprint(t.current))).toEqual([]);
  });

  it("8 concurrent deliveries of one event: stored once, applied once, one audit event", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("read_only");
    const delivery = deliver("subscription.charged", subscriptionId, tenant.operatorId);
    const { deps: d } = deps();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => handleRazorpayWebhook(d, delivery)),
    );
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(7);
    expect(results.filter((r) => r.reactivated)).toHaveLength(1);
    expect(await events(tenant.operatorId)).toHaveLength(1);
    const audit = await t.current.admin.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE operator_id = $1 AND action = 'subscription.state_changed'`,
      [tenant.operatorId],
    );
    expect(audit.rows[0]).toEqual({ n: 1 });
    expect((await subscriptionRow(t.current, tenant.operatorId)).status).toBe("active");
  }, 60_000);

  it("a body replayed under a new event id is stored but changes nothing", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("grace");
    const body = razorpayFixture("subscription.charged", {
      subscriptionId,
      operatorId: tenant.operatorId,
    });
    const { deps: d } = deps();
    await handleRazorpayWebhook(d, signedDelivery(body, newEventId()));
    const row = await subscriptionRow(t.current, tenant.operatorId);
    const replay = await handleRazorpayWebhook(d, signedDelivery(body, newEventId()));
    expect(replay.outcome).toBe("no_change");
    expect(await subscriptionRow(t.current, tenant.operatorId)).toEqual(row);
    // Weeks later, after the paid month ended and the tenant fell back to grace, a replay of the
    // old charge does not reactivate it.
    const later = at("2026-12-20T00:00:00Z");
    await setSubscriptionRow(t.current, tenant.operatorId, {
      status: "grace",
      graceEndsAt: at("2026-12-28T18:30:00Z"),
      currentPeriodEnd: PAID_END,
      razorpaySubscriptionId: subscriptionId,
      razorpayStatus: "halted",
      razorpayStatusAt: at("2026-12-16T04:06:00Z"),
    });
    const stale = await handleRazorpayWebhook(deps(later).deps, signedDelivery(body, newEventId()));
    expect(stale.httpStatus).toBe(200);
    expect(await subscriptionRow(t.current, tenant.operatorId)).toMatchObject({
      status: "grace",
      razorpay_status: "halted",
    });
  });

  it("drives the lifecycle with the test-mode fixtures, in and out of order", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("trialing");
    const op = tenant.operatorId;
    const send = (name: FixtureName, now: Date) =>
      handleRazorpayWebhook(deps(now).deps, deliver(name, subscriptionId, op));

    // Autopay authorised during the trial: still trialing.
    expect((await send("subscription.authenticated", at("2026-11-13T04:02:30Z"))).outcome).toBe(
      "applied",
    );
    expect(await subscriptionRow(t.current, op)).toMatchObject({
      status: "trialing",
      razorpay_status: "authenticated",
    });
    // charged arrives before activated (Razorpay doesn't promise order).
    await send("subscription.charged", NOW);
    const afterCharge = await subscriptionRow(t.current, op);
    expect(afterCharge).toMatchObject({ status: "active", current_period_end: PAID_END });
    expect((await send("subscription.activated", NOW)).outcome).toBe("no_change");
    expect(await subscriptionRow(t.current, op)).toEqual(afterCharge);
    // The renewal charge fails: pending right after the paid end → grace.
    await send("subscription.pending", at("2026-12-13T04:07:00Z"));
    expect(await subscriptionRow(t.current, op)).toMatchObject({
      status: "grace",
      grace_ends_at: at("2026-12-28T18:30:00Z"),
      razorpay_status: "pending",
    });
    await send("subscription.halted", at("2026-12-16T04:07:00Z"));
    expect(await subscriptionRow(t.current, op)).toMatchObject({
      status: "grace",
      razorpay_status: "halted",
    });
    // An older event delivered late doesn't overwrite Razorpay's newer status.
    await send("subscription.pending", at("2026-12-16T05:00:00Z"));
    expect((await subscriptionRow(t.current, op)).razorpay_status).toBe("halted");
    // Cancelled while in grace: cancelled (read-only, data kept).
    await send("subscription.cancelled", at("2026-12-17T00:00:00Z"));
    expect((await subscriptionRow(t.current, op)).status).toBe("grace");
    // (The fixture's cancellation is dated 1 Dec, older than "halted": ignored. A newer one counts.)
    const newer = razorpayFixture("subscription.cancelled", {
      subscriptionId,
      operatorId: op,
      createdAt: at("2026-12-17T00:00:00Z"),
    });
    await handleRazorpayWebhook(
      deps(at("2026-12-17T00:00:05Z")).deps,
      signedDelivery(newer, newEventId()),
    );
    expect(await subscriptionRow(t.current, op)).toMatchObject({
      status: "cancelled",
      razorpay_status: "cancelled",
    });
    expect((await events(op)).map((e) => e.type)).toEqual([
      "subscription.authenticated",
      "subscription.charged",
      "subscription.activated",
      "subscription.pending",
      "subscription.halted",
      "subscription.pending",
      "subscription.cancelled",
      "subscription.cancelled",
    ]);
  });

  it("a payment after read-only reactivates and lists the skipped bill months (D-25)", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("read_only");
    await t.current.admin.query(
      `INSERT INTO billing_runs (id, operator_id, period, trigger, status, skip_reason, finished_at)
       VALUES (gen_random_uuid(), $1, '2026-10-01', 'cron', 'skipped', 'tenant_read_only', now()),
              (gen_random_uuid(), $1, '2026-11-01', 'cron', 'skipped', 'tenant_read_only', now())`,
      [tenant.operatorId],
    );
    const result = await handleRazorpayWebhook(
      deps().deps,
      deliver("subscription.charged", subscriptionId, tenant.operatorId),
    );
    expect(result).toMatchObject({
      outcome: "applied",
      reactivated: true,
      missedRunPeriods: ["2026-10-01", "2026-11-01"],
    });
    expect(result.state?.status).toBe("active");
  });

  it("unmatched, unreadable and subscription-less events are stored once, changing no tenant", async () => {
    const { tenant } = await tenantWithSubscription("grace");
    const { deps: d } = deps();
    const before = await subscriptionRow(t.current, tenant.operatorId);
    const unknown = deliver("subscription.charged", newSubscriptionId(), null);
    expect(await handleRazorpayWebhook(d, unknown)).toMatchObject({
      httpStatus: 200,
      outcome: "unmatched",
    });
    expect((await handleRazorpayWebhook(d, unknown)).outcome).toBe("duplicate");
    const failed = signedDelivery(razorpayFixture("payment.failed"), newEventId());
    expect((await handleRazorpayWebhook(d, failed)).outcome).toBe("unmatched");
    const odd = signedDelivery({ entity: "event", event: "weird", payload: 3 }, newEventId());
    expect(await handleRazorpayWebhook(d, odd)).toMatchObject({
      httpStatus: 200,
      outcome: "unmatched",
    });
    const signedNotJson = {
      rawBody: "{nope",
      signature: razorpayHmac("{nope", WEBHOOK_SECRET),
      eventId: newEventId(),
    };
    expect(await handleRazorpayWebhook(d, signedNotJson)).toEqual({
      httpStatus: 400,
      outcome: "bad_request",
    });
    const noId = { ...deliver("subscription.charged", newSubscriptionId(), null), eventId: "" };
    expect((await handleRazorpayWebhook(d, noId)).httpStatus).toBe(400);

    const platform = await events(null);
    expect(platform.map((e) => [e.type, e.processing_error])).toEqual(
      expect.arrayContaining([
        ["subscription.charged", "unmatched_subscription"],
        ["payment.failed", "no_subscription"],
        ["weird", "unreadable_payload"],
      ]),
    );
    expect(await subscriptionRow(t.current, tenant.operatorId)).toEqual(before);
  });

  it("an event whose notes name another tenant is not applied (operator_mismatch)", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("grace");
    const other = await seedTenant(t.current);
    const result = await handleRazorpayWebhook(
      deps().deps,
      deliver("subscription.charged", subscriptionId, other.operatorId),
    );
    expect(result.outcome).toBe("unmatched");
    expect((await subscriptionRow(t.current, tenant.operatorId)).status).toBe("grace");
    expect((await subscriptionRow(t.current, other.operatorId)).status).toBe("active");
  });

  it("isolation: an event for tenant A changes only A; B never sees A's events", async () => {
    const a = await tenantWithSubscription("grace");
    const b = await tenantWithSubscription("grace");
    const beforeB = await databaseFingerprint(t.current, { operatorId: b.tenant.operatorId });
    await handleRazorpayWebhook(
      deps().deps,
      deliver("subscription.charged", a.subscriptionId, a.tenant.operatorId),
    );
    expect((await subscriptionRow(t.current, a.tenant.operatorId)).status).toBe("active");
    expect(
      changedTables(
        beforeB,
        await databaseFingerprint(t.current, { operatorId: b.tenant.operatorId }),
      ),
    ).toEqual([]);
    const seenByB = await t.current.db.withTenant(b.tenant.operatorId, (tx) =>
      tx.query.subscriptionEvents.findMany(),
    );
    expect(seenByB).toEqual([]);
  });

  it("stored events are append-only (only the processing columns may change)", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("grace");
    await handleRazorpayWebhook(
      deps().deps,
      deliver("subscription.charged", subscriptionId, tenant.operatorId),
    );
    await expect(
      t.current.admin.query("UPDATE subscription_events SET type = 'x' WHERE operator_id = $1", [
        tenant.operatorId,
      ]),
    ).rejects.toThrow();
    await expect(
      t.current.admin.query("DELETE FROM subscription_events WHERE operator_id = $1", [
        tenant.operatorId,
      ]),
    ).rejects.toThrow();
  });

  it("logs no personal data (strict logger) and only ids and codes", async () => {
    const { tenant, subscriptionId } = await tenantWithSubscription("grace");
    const { deps: d, logs } = deps();
    await handleRazorpayWebhook(
      d,
      deliver("subscription.charged", subscriptionId, tenant.operatorId),
    );
    const line = logs.records.find((r) => r.event === "razorpay.webhook_processed");
    expect(line).toMatchObject({
      event_type: "subscription.charged",
      outcome: "applied",
      status_before: "grace",
      status_after: "active",
    });
    expect(JSON.stringify(logs.records)).not.toContain("void@example.com");
  });
});
