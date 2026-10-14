/**
 * The daily `subscription-states` job against a real database, an injected clock, a fake Razorpay
 * and a recording email transport: date transitions, reconciliation (missed webhook), reminders
 * once each (T-7, T-1, grace start), "working again" with missed bill runs, Razorpay outages,
 * suspended operators, idempotency and the time budget. The job covers every tenant in the
 * database, so each test checks its own tenants only.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import { createRecordingEmailTransport } from "../jobs/alerts";
import { captureLogs, seedTenant } from "../testing/fixtures";
import { runSubscriptionStates } from "./daily";
import type { RenderSubscriptionNotice } from "./notices";
import { createFakeRazorpayClient } from "./razorpay/fake";
import { giveOwnerEmail, setSubscriptionRow, subscriptionRow } from "./test-support";

const at = (iso: string) => new Date(iso);
const TRIAL_END = at("2026-11-12T18:30:00Z"); // 00:00 IST 13 Nov
/** The cron's time: 06:00 IST. */
const cronOn = (day: string) => at(`${day}T00:30:00Z`);

const render: RenderSubscriptionNotice = ({ language, notice, plan, missedRunPeriods }) => ({
  subject: `${language}:${notice.kind}`,
  text: [
    notice.key,
    notice.lastDay,
    notice.daysLeft,
    plan.totalPaise,
    missedRunPeriods.join(","),
  ].join("|"),
});

describeDb("subscription-states job", () => {
  const t = useTestDatabase();

  async function tenant(
    fields: Parameters<typeof setSubscriptionRow>[2],
    email: string | null = null,
  ) {
    const seeded = await seedTenant(t.current, { subscription: fields.status });
    await setSubscriptionRow(t.current, seeded.operatorId, fields);
    if (email) await giveOwnerEmail(t.current, seeded.users.owner, email);
    return seeded;
  }

  function run(now: Date, extra: Partial<Parameters<typeof runSubscriptionStates>[0]> = {}) {
    const transport = createRecordingEmailTransport();
    const logs = captureLogs();
    const promise = runSubscriptionStates({
      db: t.current.db,
      now: () => now,
      log: logs.logger,
      razorpay: null,
      notifier: { transport, render },
      ...extra,
    });
    return { promise, transport, logs };
  }

  const sentTo = (transport: ReturnType<typeof createRecordingEmailTransport>, email: string) =>
    transport.sent.filter((m) => m.to === email).map((m) => m.subject);

  it("moves trialing → grace → read_only by date, and is idempotent", async () => {
    const a = await tenant({ status: "trialing", trialEndsAt: TRIAL_END });
    const first = run(cronOn("2026-11-13"));
    const report = await first.promise;
    expect(report.transitions["trialing->grace"]).toBeGreaterThanOrEqual(1);
    expect(await subscriptionRow(t.current, a.operatorId)).toMatchObject({
      status: "grace",
      grace_ends_at: at("2026-11-27T18:30:00Z"),
    });
    const audit = async () =>
      (
        await t.current.admin.query(
          `SELECT count(*)::int AS n FROM audit_events WHERE operator_id = $1 AND action = 'subscription.state_changed'`,
          [a.operatorId],
        )
      ).rows[0];
    expect(await audit()).toEqual({ n: 1 });
    await run(cronOn("2026-11-13")).promise;
    expect(await audit()).toEqual({ n: 1 });
    // Last grace day (27 Nov) still grace; 28 Nov → read_only.
    await run(cronOn("2026-11-27")).promise;
    expect((await subscriptionRow(t.current, a.operatorId)).status).toBe("grace");
    await run(cronOn("2026-11-28")).promise;
    expect((await subscriptionRow(t.current, a.operatorId)).status).toBe("read_only");
  });

  it("active → grace after the paid month; with autopay cancelled → cancelled", async () => {
    const paidEnd = at("2026-11-20T04:05:00Z");
    const lapsing = await tenant({ status: "active", currentPeriodEnd: paidEnd });
    const stopping = await tenant({
      status: "active",
      currentPeriodEnd: paidEnd,
      cancelledAt: at("2026-11-10T00:00:00Z"),
    });
    await run(cronOn("2026-11-21")).promise;
    expect(await subscriptionRow(t.current, lapsing.operatorId)).toMatchObject({
      status: "grace",
      grace_ends_at: at("2026-12-05T18:30:00Z"),
    });
    expect((await subscriptionRow(t.current, stopping.operatorId)).status).toBe("cancelled");
  });

  it("reminders: T-7, T-1 and grace start, each exactly once, in the owner's language", async () => {
    const email = "owner-reminders@example.test";
    const a = await tenant({ status: "trialing", trialEndsAt: TRIAL_END }, email);
    await giveOwnerEmail(t.current, a.users.owner, email, "hi");
    const days: [string, string[]][] = [
      ["2026-11-05", []], // 8 days left
      ["2026-11-06", ["hi:trial_ending"]], // 7 days left
      ["2026-11-07", []],
      ["2026-11-12", ["hi:trial_ending"]], // 1 day left
      ["2026-11-12", []], // second run the same day
      ["2026-11-13", ["hi:grace_started"]],
      ["2026-11-14", []],
      ["2026-11-21", ["hi:grace_ending"]], // 7 days before 28 Nov
      ["2026-11-27", ["hi:grace_ending"]],
      ["2026-11-28", []], // read-only: no more reminders
    ];
    for (const [day, expected] of days) {
      const r = run(cronOn(day));
      await r.promise;
      expect([day, sentTo(r.transport, email)]).toEqual([day, expected]);
    }
    const keys = await t.current.admin.query(
      `SELECT after->>'key' AS key FROM audit_events
        WHERE operator_id = $1 AND action = 'subscription.notice_sent' ORDER BY at, id`,
      [a.operatorId],
    );
    expect(keys.rows.map((r) => r.key)).toEqual([
      "trial_ending:7:2026-11-13",
      "trial_ending:1:2026-11-13",
      "grace_started:0:2026-11-28",
      "grace_ending:7:2026-11-28",
      "grace_ending:1:2026-11-28",
    ]);
  }, 60_000);

  it("a failed send is tried again on the next run; no owner email → nothing recorded", async () => {
    const email = "owner-fail@example.test";
    const a = await tenant({ status: "trialing", trialEndsAt: TRIAL_END }, email);
    const failing = createRecordingEmailTransport({ failFor: [email] });
    const r1 = run(cronOn("2026-11-06"), { notifier: { transport: failing, render } });
    expect((await r1.promise).noticeFailures).toBeGreaterThanOrEqual(1);
    const r2 = run(cronOn("2026-11-07"));
    await r2.promise;
    expect(sentTo(r2.transport, email)).toEqual(["en:trial_ending"]);
    const silent = await tenant({ status: "trialing", trialEndsAt: TRIAL_END });
    const r3 = run(cronOn("2026-11-06"));
    await r3.promise;
    const recorded = await t.current.admin.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE operator_id = $1 AND action = 'subscription.notice_sent'`,
      [silent.operatorId],
    );
    expect(recorded.rows[0]).toEqual({ n: 0 });
    expect(r3.logs.records.some((l) => l.event === "subscription.notice_no_recipients")).toBe(true);
    expect(JSON.stringify(r3.logs.records)).not.toContain("@example.test");
    void a;
  });

  it("reconciles a missed webhook: a charge Razorpay knows about reactivates the tenant", async () => {
    const now = cronOn("2026-12-02");
    const razorpay = createFakeRazorpayClient({ now: () => now });
    const created = await razorpay.createSubscription({
      planId: "plan_FakeMonthly",
      totalCount: 120,
      customerNotify: true,
      notes: {},
    });
    const email = "owner-back@example.test";
    const a = await tenant(
      {
        status: "read_only",
        trialEndsAt: TRIAL_END,
        razorpaySubscriptionId: created.id,
        razorpayStatus: "created",
        razorpayStatusAt: at("2026-12-01T00:00:00Z"),
      },
      email,
    );
    await t.current.admin.query(
      `INSERT INTO billing_runs (id, operator_id, period, trigger, status, skip_reason, finished_at)
       VALUES (gen_random_uuid(), $1, '2026-12-01', 'cron', 'skipped', 'tenant_read_only', now())`,
      [a.operatorId],
    );
    razorpay.update(created.id, { status: "active", currentEnd: at("2027-01-01T05:00:00Z") });
    const r = run(now, { razorpay });
    const report = await r.promise;
    expect(report.reactivated).toBeGreaterThanOrEqual(1);
    expect(await subscriptionRow(t.current, a.operatorId)).toMatchObject({
      status: "active",
      current_period_end: at("2027-01-01T05:00:00Z"),
      razorpay_status: "active",
    });
    const mail = r.transport.sent.find((m) => m.to === email);
    expect(mail?.subject).toBe("en:reactivated");
    expect(mail?.text.split("|").at(-1)).toBe("2026-12-01");
    expect(mail?.idempotencyKey).toMatch(
      new RegExp(`^subscription-notice/${a.operatorId}/reactivated:`),
    );
  });

  it("asks Razorpay only when something can change, and survives a Razorpay outage", async () => {
    const now = cronOn("2026-12-02");
    const razorpay = createFakeRazorpayClient({ now: () => now });
    const mk = async () =>
      (
        await razorpay.createSubscription({
          planId: "plan_FakeMonthly",
          totalCount: 120,
          customerNotify: true,
          notes: {},
        })
      ).id;
    const midMonth = await mk();
    const renewing = await mk();
    const finished = await mk();
    const failingId = await mk();
    await tenant({
      status: "active",
      currentPeriodEnd: at("2026-12-20T00:00:00Z"),
      razorpaySubscriptionId: midMonth,
      razorpayStatus: "active",
    });
    await tenant({
      status: "active",
      currentPeriodEnd: at("2026-12-02T12:00:00Z"),
      razorpaySubscriptionId: renewing,
      razorpayStatus: "active",
    });
    await tenant({
      status: "cancelled",
      razorpaySubscriptionId: finished,
      razorpayStatus: "cancelled",
    });
    const broken = await tenant({
      status: "grace",
      graceEndsAt: at("2026-12-01T18:30:00Z"),
      razorpaySubscriptionId: failingId,
      razorpayStatus: "halted",
    });
    razorpay.failNext("fetchSubscription");
    const r = run(now, { razorpay, concurrency: 1 });
    const report = await r.promise;
    const asked = razorpay.calls.filter((c) => c.method === "fetchSubscription").map((c) => c.id);
    expect(asked).toContain(renewing);
    expect(asked).toContain(failingId);
    expect(asked).not.toContain(midMonth);
    expect(asked).not.toContain(finished);
    expect(report.reconcileErrors).toBe(1);
    expect(report.failed).toBe(0);
    // The outage hit the first tenant asked (nearest deadline: the grace one); its dates still applied.
    expect((await subscriptionRow(t.current, broken.operatorId)).status).toBe("read_only");
  });

  it("ignores suspended operators and stops starting tenants when the budget is used up", async () => {
    const suspended = await tenant({ status: "trialing", trialEndsAt: TRIAL_END });
    await t.current.admin.query("UPDATE operators SET status = 'suspended' WHERE id = $1", [
      suspended.operatorId,
    ]);
    await run(cronOn("2026-11-14")).promise;
    expect((await subscriptionRow(t.current, suspended.operatorId)).status).toBe("trialing");

    let clock = 0;
    const r = run(cronOn("2026-11-14"), { budgetMs: 10, elapsed: () => (clock += 6) });
    const report = await r.promise;
    expect(report.stoppedBy).toBe("budget");
    expect(report.processed).toBeLessThan(report.tenants);
  });
});
