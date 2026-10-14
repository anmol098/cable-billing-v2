// @vitest-environment node
/**
 * `POST /api/webhooks/razorpay` (T-085) through the route handler with real `Request`s, a real
 * test database and Razorpay test-mode style bodies: status codes for every refusal, idempotent
 * duplicate deliveries, the "working again" email after a reactivating charge, and 500 (nothing
 * stored, Razorpay retries) when the database fails.
 */
import {
  createRecordingEmailTransport,
  type RenderSubscriptionNotice,
  razorpayHmac,
} from "@cb/core";
import { captureLogs, seedTenant } from "@cb/core/testing";
import type { DbClient } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it, vi } from "vitest";
import { type RazorpayWebhookRouteDeps, razorpayWebhookHandler } from "./handler";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const SECRET = "whsec-web-test-0123456789";
const NOW = new Date("2026-11-13T04:10:00Z");
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const render: RenderSubscriptionNotice = ({ notice, missedRunPeriods }) => ({
  subject: notice.kind,
  text: missedRunPeriods.join(","),
});

function chargedBody(subscriptionId: string, operatorId: string) {
  return {
    entity: "event",
    account_id: "acc_TestRzp000001",
    event: "subscription.charged",
    contains: ["subscription", "payment"],
    payload: {
      subscription: {
        entity: {
          id: subscriptionId,
          entity: "subscription",
          plan_id: "plan_TestRzp472Mo",
          status: "active",
          current_start: unix("2026-11-13T04:05:00Z"),
          current_end: unix("2026-12-13T04:05:00Z"),
          notes: { operator_id: operatorId },
        },
      },
      payment: { entity: { id: "pay_TestWeb00001", amount: 47_200, currency: "INR" } },
    },
    created_at: unix("2026-11-13T04:05:12Z"),
  };
}

let eventSeq = 0;
function webhookRequest(
  body: string,
  headers: { signature?: string | null; eventId?: string | null } = {},
): Request {
  eventSeq += 1;
  const h = new Headers({ "content-type": "application/json" });
  const signature =
    headers.signature === undefined ? razorpayHmac(body, SECRET) : headers.signature;
  if (signature !== null) h.set("x-razorpay-signature", signature);
  const eventId =
    headers.eventId === undefined ? `evt_Web${eventSeq}x${Date.now()}` : headers.eventId;
  if (eventId !== null) h.set("x-razorpay-event-id", eventId);
  return new Request("http://localhost/api/webhooks/razorpay", {
    method: "POST",
    headers: h,
    body,
  });
}

describeDb("POST /api/webhooks/razorpay (T-085)", () => {
  const t = useTestDatabase();

  function handler(overrides: Partial<RazorpayWebhookRouteDeps> = {}) {
    const transport = createRecordingEmailTransport();
    const tasks: Promise<unknown>[] = [];
    const logs = captureLogs();
    const deps: RazorpayWebhookRouteDeps = {
      db: t.current.db,
      log: logs.logger,
      now: () => NOW,
      secret: SECRET,
      notifier: { transport, render },
      afterResponse: (task) => {
        tasks.push(task());
      },
      ...overrides,
    };
    return { POST: razorpayWebhookHandler(() => deps), transport, tasks, logs };
  }

  async function tenant(status: "grace" | "read_only") {
    const seeded = await seedTenant(t.current, { subscription: status });
    const subscriptionId = `sub_Web${Date.now().toString(36)}${eventSeq}`;
    await t.current.admin.query(
      `UPDATE subscriptions SET razorpay_subscription_id = $2, razorpay_status = 'created',
              razorpay_status_at = '2026-11-13T04:00:00Z', grace_ends_at = '2026-11-27T18:30:00Z'
        WHERE operator_id = $1`,
      [seeded.operatorId, subscriptionId],
    );
    return { seeded, subscriptionId };
  }

  const status = async (operatorId: string) =>
    (
      await t.current.admin.query<{ status: string }>(
        "SELECT status FROM subscriptions WHERE operator_id = $1",
        [operatorId],
      )
    ).rows[0]?.status;

  it("401 without or with a wrong signature, 400 without an event id, 503 without a secret, 413 when huge", async () => {
    const { seeded, subscriptionId } = await tenant("grace");
    const { POST } = handler();
    const body = JSON.stringify(chargedBody(subscriptionId, seeded.operatorId));
    expect((await POST(webhookRequest(body, { signature: null }))).status).toBe(401);
    expect((await POST(webhookRequest(body, { signature: "f".repeat(64) }))).status).toBe(401);
    expect(
      (await POST(webhookRequest(body, { signature: razorpayHmac(body, "other-secret-0123") })))
        .status,
    ).toBe(401);
    expect((await POST(webhookRequest(body, { eventId: null }))).status).toBe(400);
    const notConfigured = handler({ secret: undefined }).POST;
    const refused = await notConfigured(webhookRequest(body));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "WEBHOOK_NOT_CONFIGURED" });
    const huge = `{"x":"${"a".repeat(300 * 1024)}"}`;
    expect((await POST(webhookRequest(huge))).status).toBe(413);
    expect(await status(seeded.operatorId)).toBe("grace");
  });

  it("200 applied, then 200 duplicate for the same delivery (no second change)", async () => {
    const { seeded, subscriptionId } = await tenant("grace");
    const { POST } = handler();
    const body = JSON.stringify(chargedBody(subscriptionId, seeded.operatorId));
    const eventId = `evt_WebDup${Date.now()}`;
    const first = await POST(webhookRequest(body, { eventId }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, outcome: "applied" });
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await status(seeded.operatorId)).toBe("active");
    for (let i = 0; i < 2; i += 1) {
      const again = await POST(webhookRequest(body, { eventId }));
      expect(await again.json()).toEqual({ ok: true, outcome: "duplicate" });
    }
    const stored = await t.current.admin.query(
      "SELECT count(*)::int AS n FROM subscription_events WHERE razorpay_event_id = $1",
      [eventId],
    );
    expect(stored.rows[0]).toEqual({ n: 1 });
  });

  it("a reactivating charge emails the owner after the response, with the missed bill months", async () => {
    const { seeded, subscriptionId } = await tenant("read_only");
    await t.current.admin.query("UPDATE users SET email = 'owner-web@example.test' WHERE id = $1", [
      seeded.users.owner,
    ]);
    await t.current.admin.query(
      `INSERT INTO billing_runs (id, operator_id, period, trigger, status, skip_reason, finished_at)
       VALUES (gen_random_uuid(), $1, '2026-11-01', 'cron', 'skipped', 'tenant_read_only', now())`,
      [seeded.operatorId],
    );
    const { POST, transport, tasks } = handler();
    const response = await POST(
      webhookRequest(JSON.stringify(chargedBody(subscriptionId, seeded.operatorId))),
    );
    expect(response.status).toBe(200);
    await Promise.all(tasks);
    expect(transport.sent).toEqual([
      expect.objectContaining({
        to: "owner-web@example.test",
        subject: "reactivated",
        text: "2026-11-01",
      }),
    ]);
  });

  it("500 when the database fails (nothing stored, so Razorpay's retry processes it)", async () => {
    const { seeded, subscriptionId } = await tenant("grace");
    const broken: Pick<DbClient, "withTenant" | "withPlatform"> = {
      withTenant: () => Promise.reject(new Error("connection lost")),
      withPlatform: () => Promise.reject(new Error("connection lost")),
    };
    const { POST } = handler({ db: broken });
    const response = await POST(
      webhookRequest(JSON.stringify(chargedBody(subscriptionId, seeded.operatorId))),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "INTERNAL" });
    expect(await status(seeded.operatorId)).toBe("grace");
  });
});
