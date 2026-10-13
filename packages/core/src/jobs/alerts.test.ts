/**
 * Failure alerts against Postgres: who is emailed (active platform admins + the failed tenant's
 * active owners with an email, in their language), what is captured, and that logs carry no PII.
 */
import { createTenant, createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import { captureLogs } from "../testing/fixtures";
import {
  createJobFailureNotifier,
  createRecordingEmailTransport,
  type JobFailureEvent,
  type RenderJobAlertArgs,
} from "./alerts";
import type { JobFailure } from "./failure";

describeDb("job failure alerts", () => {
  const t = useTestDatabase();
  const ids = {
    tenantA: "",
    tenantB: "",
    ownerA: "",
    admin: "",
  };
  const setEmail = (userId: string, email: string) =>
    t.current.admin.query("UPDATE users SET email = $1 WHERE id = $2", [email, userId]);

  beforeAll(async () => {
    const a = await createTenant(t.current);
    const b = await createTenant(t.current);
    ids.tenantA = a.operatorId;
    ids.tenantB = b.operatorId;
    const ownerA = await createUser(t.current, {
      operatorId: a.operatorId,
      role: "owner",
      language: "hi",
    });
    const ownerANoEmail = await createUser(t.current, { operatorId: a.operatorId, role: "owner" });
    const staffA = await createUser(t.current, { operatorId: a.operatorId, role: "staff" });
    const ownerB = await createUser(t.current, { operatorId: b.operatorId, role: "owner" });
    const admin = await createUser(t.current, { operatorId: null, login: "alerts_admin" });
    const retired = await createUser(t.current, { operatorId: null, login: "alerts_retired" });
    await setEmail(ownerA.userId, "owner.a@example.test");
    await setEmail(staffA.userId, "staff.a@example.test");
    await setEmail(ownerB.userId, "owner.b@example.test");
    await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
      retired.userId,
    ]);
    ids.ownerA = ownerA.userId;
    ids.admin = admin.userId;
    expect(ownerANoEmail.userId).toBeTruthy();
  });

  const failure = (overrides: Partial<JobFailure> = {}): JobFailure => ({
    jobId: "0199c4f6-0000-7000-8000-000000000001",
    type: "billing.run",
    operatorId: ids.tenantA,
    attempts: 5,
    maxAttempts: 5,
    reason: "max_attempts",
    lastError: "Error: timeout",
    failedAt: new Date("2026-10-13T00:00:00Z"),
    notifyOwner: true,
    ...overrides,
  });

  function setup(failFor: string[] = []) {
    const transport = createRecordingEmailTransport({ failFor });
    const rendered: RenderJobAlertArgs[] = [];
    const captured: JobFailureEvent[] = [];
    const logs = captureLogs(); // strict: an email or name in a log line throws
    const notify = createJobFailureNotifier({
      db: t.current.db,
      transport,
      logger: logs.logger,
      render: (args) => {
        rendered.push(args);
        return { subject: `${args.audience}/${args.language}`, text: args.failure.type };
      },
      capture: (event) => captured.push(event),
    });
    return { notify, transport, rendered, captured, records: logs.records };
  }

  it("emails the active platform admins and the tenant's owners with an email, in their language", async () => {
    const { notify, transport, captured, records } = setup();
    const report = await notify(failure());
    expect(report).toEqual({ sent: 2, failed: 0, recipients: 2 });
    expect(transport.sent).toEqual([
      {
        to: "alerts_admin@admin.test",
        subject: "platform_admin/en",
        text: "billing.run",
        idempotencyKey: `job-failed/${failure().jobId}/${ids.admin}`,
      },
      {
        to: "owner.a@example.test",
        subject: "owner/hi",
        text: "billing.run",
        idempotencyKey: `job-failed/${failure().jobId}/${ids.ownerA}`,
      },
    ]);
    expect(captured).toEqual([
      {
        message: "job.failed",
        tags: { job_type: "billing.run", reason: "max_attempts" },
        extra: {
          job_id: failure().jobId,
          operator_id: ids.tenantA,
          attempts: 5,
          last_error: "Error: timeout",
        },
      },
    ]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("@");
    expect(records.filter((r) => r.event === "job.alert_sent")).toHaveLength(2);
  });

  it("platform jobs and notifyOwner: false alert the platform admins only", async () => {
    for (const f of [failure({ operatorId: null }), failure({ notifyOwner: false })]) {
      const { notify, transport } = setup();
      await notify(f);
      expect(transport.sent.map((m) => m.to)).toEqual(["alerts_admin@admin.test"]);
    }
  });

  it("another tenant's failure never reaches this tenant's owner", async () => {
    const { notify, transport } = setup();
    await notify(failure({ operatorId: ids.tenantB }));
    expect(transport.sent.map((m) => m.to).sort()).toEqual([
      "alerts_admin@admin.test",
      "owner.b@example.test",
    ]);
  });

  it("a failed send is logged and captured; the other recipients still get theirs", async () => {
    const { notify, transport, captured, records } = setup(["alerts_admin@admin.test"]);
    const report = await notify(failure());
    expect(report).toEqual({ sent: 1, failed: 1, recipients: 2 });
    expect(transport.sent.map((m) => m.to)).toEqual(["owner.a@example.test"]);
    expect(captured.map((c) => c.message)).toEqual(["job.failed", "job.alert_send_failed"]);
    expect(records.find((r) => r.event === "job.alert_send_failed")).toMatchObject({
      user_id: ids.admin,
      audience: "platform_admin",
      error_type: "EmailSendError",
    });
  });
});
