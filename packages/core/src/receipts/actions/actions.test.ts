/**
 * `receipts.record_action` against a real database (T-061): honest actions stored with the
 * signed-in user and device, idempotent on the phone's id (duplicate / ID_REUSED), concurrent
 * replays, NOT_FOUND for unknown or another tenant's payments, per-tenant keys, append-only rows,
 * every role and read-only tenants (D-13).
 */
import { type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { describe, expect, it } from "vitest";
import type { ServiceRuntime } from "../../context/runtime";
import type { TenantContext } from "../../context/tenant-context";
import { postPayment } from "../../payments/post-payment";
import { insertCustomer } from "../../payments/test-support";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../../testing/fixtures";
import { recordReceiptAction } from "./record";

const NOW = new Date("2026-10-13T06:00:00.000Z");
const AT = "2026-10-13T05:58:12.345Z";

describeDb("receipt actions (T-061)", () => {
  const t = useTestDatabase();

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    lineman: TenantContext;
    owner: TenantContext;
    paymentId: string;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db, { now: () => NOW });
    const lineman = await contextFor(rt, tenant, "lineman");
    const owner = await contextFor(rt, tenant, "owner");
    const customerId = await t.current.db.withTenant(tenant.operatorId, (tx: Tx) =>
      insertCustomer(tx, tenant.operatorId),
    );
    const posted = await postPayment.call(rt, lineman, {
      id: uuidv7(),
      customerId,
      amountPaise: 50_000,
      method: "cash",
      recordedAt: "2026-10-13T05:55:00.000Z",
      provisionalRef: "P-K7Q-0001",
    });
    if (!posted.ok) throw new Error(`post: ${posted.error.code}`);
    return { tenant, rt, lineman, owner, paymentId: posted.value.payment.id };
  }

  const rows = async (operatorId: string) =>
    (
      await t.current.admin.query<{
        id: string;
        receipt_id: string;
        action: string;
        device_id: string | null;
        actor_id: string | null;
        at: Date;
        received_at: Date;
      }>(
        "SELECT id, receipt_id, action, device_id, actor_id, at, received_at FROM receipt_actions WHERE operator_id = $1 ORDER BY id",
        [operatorId],
      )
    ).rows;

  it("stores an action with the signed-in user and device; a replay is a duplicate", async () => {
    const s = await setup();
    const id = uuidv7();
    const input = { id, paymentId: s.paymentId, action: "printed" as const, at: AT };
    const first = await recordReceiptAction.call(s.rt, s.lineman, input);
    expect(first.ok && first.value.outcome).toBe("recorded");
    const again = await recordReceiptAction.call(s.rt, s.lineman, input);
    expect(again.ok && again.value.outcome).toBe("duplicate");
    if (!first.ok || !again.ok) throw new Error("unreachable");
    expect(again.value.receiptId).toBe(first.value.receiptId);

    const stored = await rows(s.tenant.operatorId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id,
      action: "printed",
      actor_id: s.tenant.users.lineman,
      device_id: s.tenant.deviceId,
    });
    expect(stored[0]?.at.toISOString()).toBe(AT);
    expect(stored[0]?.received_at.toISOString()).toBe(NOW.toISOString());
  }, 60_000);

  it("accepts every honest action; the same id with other data is ID_REUSED (names only)", async () => {
    const s = await setup();
    for (const action of [
      "printed",
      "print_failed",
      "whatsapp_opened",
      "sms_opened",
      "pdf_shared",
    ] as const) {
      const r = await recordReceiptAction.call(s.rt, s.lineman, {
        id: uuidv7(),
        paymentId: s.paymentId,
        action,
        at: AT,
      });
      expect(r.ok && r.value.outcome, action).toBe("recorded");
    }
    for (const action of ["sent", "delivered", "whatsapp_sent"]) {
      const r = await recordReceiptAction.call(s.rt, s.lineman, {
        id: uuidv7(),
        paymentId: s.paymentId,
        // biome-ignore lint/suspicious/noExplicitAny: proving dishonest values are refused.
        action: action as any,
        at: AT,
      });
      expect(!r.ok && r.error.code, action).toBe("VALIDATION");
    }

    const id = uuidv7();
    await recordReceiptAction.call(s.rt, s.lineman, {
      id,
      paymentId: s.paymentId,
      action: "printed",
      at: AT,
    });
    const other = await recordReceiptAction.call(s.rt, s.lineman, {
      id,
      paymentId: s.paymentId,
      action: "print_failed",
      at: "2026-10-13T05:59:00.000Z",
    });
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error("unreachable");
    expect(other.error.code).toBe("ID_REUSED_WITH_DIFFERENT_DATA");
    expect(other.error.details?.fields).toEqual(["action", "at"]);
    expect(await rows(s.tenant.operatorId)).toHaveLength(6);
  }, 60_000);

  it("NOT_FOUND for an unknown payment or another tenant's payment; nothing written", async () => {
    const s = await setup();
    const other = await setup();
    for (const paymentId of [uuidv7(), other.paymentId]) {
      const r = await recordReceiptAction.call(s.rt, s.lineman, {
        id: uuidv7(),
        paymentId,
        action: "printed",
        at: AT,
      });
      expect(!r.ok && r.error.code).toBe("NOT_FOUND");
    }
    expect(await rows(s.tenant.operatorId)).toHaveLength(0);
    expect(await rows(other.tenant.operatorId)).toHaveLength(0);
  }, 60_000);

  it("action ids are per tenant: another tenant's id is a new action there", async () => {
    const a = await setup();
    const b = await setup();
    const id = uuidv7();
    const inA = await recordReceiptAction.call(a.rt, a.lineman, {
      id,
      paymentId: a.paymentId,
      action: "printed",
      at: AT,
    });
    const inB = await recordReceiptAction.call(b.rt, b.lineman, {
      id,
      paymentId: b.paymentId,
      action: "sms_opened",
      at: AT,
    });
    expect(inA.ok && inA.value.outcome).toBe("recorded");
    expect(inB.ok && inB.value.outcome).toBe("recorded");
    expect((await rows(a.tenant.operatorId)).map((r) => r.action)).toEqual(["printed"]);
    expect((await rows(b.tenant.operatorId)).map((r) => r.action)).toEqual(["sms_opened"]);
  }, 60_000);

  it("concurrent identical actions store one row; every caller gets recorded or duplicate", async () => {
    const s = await setup();
    const input = { id: uuidv7(), paymentId: s.paymentId, action: "whatsapp_opened", at: AT };
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        recordReceiptAction.call(s.rt, s.lineman, input as typeof input & { action: "printed" }),
      ),
    );
    const outcomes = results.map((r) => (r.ok ? r.value.outcome : r.error.code)).sort();
    expect(outcomes.filter((o) => o === "recorded")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(5);
    expect(await rows(s.tenant.operatorId)).toHaveLength(1);
  }, 60_000);

  it("works for every role and in a read-only tenant (D-13); rows are append-only", async () => {
    const s = await setup();
    const staff = await contextFor(s.rt, s.tenant, "staff");
    for (const ctx of [s.owner, staff, s.lineman]) {
      const r = await recordReceiptAction.call(s.rt, ctx, {
        id: uuidv7(),
        paymentId: s.paymentId,
        action: "printed",
        at: AT,
      });
      expect(r.ok, ctx.role).toBe(true);
    }
    const ownerRow = (await rows(s.tenant.operatorId)).find(
      (r) => r.actor_id === s.tenant.users.owner,
    );
    expect(ownerRow?.device_id).toBeNull();

    await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
    const readOnly = await recordReceiptAction.call(s.rt, s.lineman, {
      id: uuidv7(),
      paymentId: s.paymentId,
      action: "pdf_shared",
      at: AT,
    });
    expect(readOnly.ok && readOnly.value.outcome).toBe("recorded");

    await expect(
      t.current.admin.query(
        "UPDATE receipt_actions SET action = 'printed' WHERE operator_id = $1",
        [s.tenant.operatorId],
      ),
    ).rejects.toThrow();
    await expect(
      t.current.admin.query("DELETE FROM receipt_actions WHERE operator_id = $1", [
        s.tenant.operatorId,
      ]),
    ).rejects.toThrow();
  }, 60_000);

  describe("validation", () => {
    it("refuses malformed input before touching the database", async () => {
      const s = await setup();
      for (const input of [
        { id: "nope", paymentId: s.paymentId, action: "printed", at: AT },
        { id: uuidv7(), paymentId: "nope", action: "printed", at: AT },
        { id: uuidv7(), paymentId: s.paymentId, action: "printed", at: "yesterday" },
      ]) {
        // biome-ignore lint/suspicious/noExplicitAny: malformed on purpose.
        const r = await recordReceiptAction.call(s.rt, s.lineman, input as any);
        expect(!r.ok && r.error.code).toBe("VALIDATION");
      }
      expect(await rows(s.tenant.operatorId)).toHaveLength(0);
    }, 60_000);
  });
});
