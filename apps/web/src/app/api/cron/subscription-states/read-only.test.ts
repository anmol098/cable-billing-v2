// @vitest-environment node
/**
 * Read-only mode end to end (T-085 acceptance, D-13): a tenant whose trial ends is moved to grace
 * and then to read-only by the daily job; from then on the web's mutations are refused
 * (TENANT_READ_ONLY) while the **Android payment sync keeps working** through the real T-061
 * `/payments:batch` handler, and the Owner can still pay. A Razorpay charge (webhook) ends
 * read-only mode and the same mutation works again.
 */
import {
  createFakeRazorpayClient,
  handleRazorpayWebhook,
  razorpayHmac,
  runSubscriptionStates,
  startBillingRun,
  startSubscriptionCheckout,
  updateBusinessProfile,
} from "@cb/core";
import { captureLogs, contextFor } from "@cb/core/testing";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it, vi } from "vitest";
import { paymentBatchHandler } from "@/app/api/mobile/v1/payments/_lib/batch";
import {
  insertCustomer,
  mobileApiHarness,
  mobileRequest,
  paymentItem,
  tenantWithLineman,
} from "@/app/api/mobile/v1/payments/_lib/test-support";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const PHONE_NOW = new Date("2026-11-10T06:00:00.000Z");
const TRIAL_END = new Date("2026-11-12T18:30:00Z");
const WEBHOOK_SECRET = "whsec-readonly-test-0123";

const PROFILE = {
  name: "Read Only Cable",
  phone: "+91 98765 43210",
  address: "",
  receiptFooter: "Thank you",
  invoicePrefix: "RO",
  defaultLanguage: "en" as const,
  midMonthStartPolicy: "charge_full_month" as const,
};

describeDb("read-only mode: web blocked, phone payments still sync (T-085)", () => {
  const t = useTestDatabase();

  it("trial ends → grace → read_only; payments sync, web edits refused, paying restores", async () => {
    const h = mobileApiHarness(t.current, PHONE_NOW);
    const POST = paymentBatchHandler(h.getDeps);
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const op = tenant.operatorId;
    await t.current.admin.query(
      "UPDATE subscriptions SET status = 'trialing', trial_ends_at = $2, grace_ends_at = NULL WHERE operator_id = $1",
      [op, TRIAL_END],
    );
    const customer = await insertCustomer(t.current, op);
    const runtime = h.getDeps().runtime;
    const owner = await contextFor(runtime, tenant, "owner");
    const staff = await contextFor(runtime, tenant, "staff");
    const job = (now: Date) =>
      runSubscriptionStates({
        db: t.current.db,
        now: () => now,
        log: captureLogs().logger,
        razorpay: null,
        notifier: null,
      });
    const statusOf = async () =>
      (
        await t.current.admin.query<{ status: string }>(
          "SELECT status FROM subscriptions WHERE operator_id = $1",
          [op],
        )
      ).rows[0]?.status;
    const sync = async (n: number) => {
      const items = [paymentItem(lineman, customer, { amount_paise: 10_000 }, n)];
      const response = await POST(
        mobileRequest("/payments:batch", { token: lineman.accessToken, body: { payments: items } }),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { results: { outcome: string }[] }).results[0]?.outcome;
    };

    // 06:00 IST, 13 Nov: the trial ended at midnight → grace (full access).
    await job(new Date("2026-11-13T00:30:00Z"));
    expect(await statusOf()).toBe("grace");
    expect(await sync(1)).toMatch(/^posted/);
    expect((await updateBusinessProfile.call(runtime, owner, PROFILE)).ok).toBe(true);

    // 06:00 IST, 28 Nov: 15 days of grace are over → read_only.
    await job(new Date("2026-11-28T00:30:00Z"));
    expect(await statusOf()).toBe("read_only");

    // The phone's payment sync still posts (D-13).
    expect(await sync(2)).toMatch(/^posted/);
    // Web mutations are refused, for the Owner and for Staff.
    const profile = await updateBusinessProfile.call(runtime, owner, { ...PROFILE, name: "X" });
    expect(profile.ok ? "ok" : profile.error.code).toBe("TENANT_READ_ONLY");
    const run = await startBillingRun.call(runtime, owner, { period: "2026-11-01" });
    expect(run.ok ? "ok" : run.error.code).toBe("TENANT_READ_ONLY");
    const staffEdit = await updateBusinessProfile.call(runtime, staff, PROFILE);
    expect(staffEdit.ok ? "ok" : staffEdit.error.code).not.toBe("ok");
    // The Owner can still pay (subscription.manage is allowlisted).
    const razorpay = createFakeRazorpayClient();
    const checkout = await startSubscriptionCheckout(runtime, owner, {
      razorpay,
      keyId: "rzp_test_Fake123",
      planId: "plan_FakeMonthly",
    });
    if (!checkout.ok || checkout.value.kind !== "open_checkout") throw new Error("checkout");

    // Razorpay charges and tells us by webhook: active again.
    const body = JSON.stringify({
      entity: "event",
      event: "subscription.charged",
      contains: ["subscription", "payment"],
      payload: {
        subscription: {
          entity: {
            id: checkout.value.subscriptionId,
            status: "active",
            current_end: Math.floor(new Date("2026-12-28T05:00:00Z").getTime() / 1000),
            notes: { operator_id: op },
          },
        },
      },
      created_at: Math.floor(new Date("2026-11-28T05:00:00Z").getTime() / 1000),
    });
    const hook = await handleRazorpayWebhook(
      {
        db: t.current.db,
        log: captureLogs().logger,
        now: () => new Date("2026-11-28T05:00:05Z"),
        secret: WEBHOOK_SECRET,
      },
      {
        rawBody: body,
        signature: razorpayHmac(body, WEBHOOK_SECRET),
        eventId: "evt_ReadOnlyBack01",
      },
    );
    expect(hook).toMatchObject({ outcome: "applied", reactivated: true });
    expect(await statusOf()).toBe("active");
    const again = await updateBusinessProfile.call(runtime, owner, { ...PROFILE, name: "Back" });
    expect(again.ok).toBe(true);
    expect(await sync(3)).toMatch(/^posted/);
  }, 120_000);
});
