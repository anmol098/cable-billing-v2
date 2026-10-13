/**
 * Read-only mode (D-13, PLAN §9.4, §13). The expected allowlist is written out here by hand.
 */
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { describe, expect, it } from "vitest";
import { seedTenant, setSubscriptionStatus } from "../testing/fixtures";
import { CAPABILITY_NAMES, type Capability } from "./capabilities";
import { assertWritable, isAllowedInMode, readTenantMode, tenantModeOf } from "./writable";

/**
 * Allowed while read-only: every read ("viewing") plus collections (D-13: payments, receipt
 * links/actions, handover submit) and paying the subscription (PLAN §9.4).
 */
const ALLOWED_WHEN_READ_ONLY: Readonly<Record<Capability, boolean>> = {
  "dashboard.view": true,
  "customers.view": true,
  "customers.manage": false,
  "customers.phone.update": false, // the one mobile write that gets TENANT_READ_ONLY (T-051)
  "connections.status.change": false,
  "plans.manage": false,
  "payments.record": true,
  "receipts.share": true,
  "payments.reverse": false,
  "adjustments.manage": false,
  "billing.preview": true,
  "billing.run": false, // D-13: billing runs pause
  "handover.submit": true,
  "handover.review": false,
  "reports.view": true,
  "reports.own_day.view": true,
  "exports.csv": true, // a read (audited)
  "team.manage": false,
  "subscription.manage": true,
  "business_profile.manage": false,
  "audit.view": true,
};

describe("tenantModeOf", () => {
  const expected: Record<SubscriptionStatus, "normal" | "read_only"> = {
    trialing: "normal",
    active: "normal",
    grace: "normal",
    read_only: "read_only",
    cancelled: "read_only",
  };
  it.each(SUBSCRIPTION_STATUSES)("%s", (status) => {
    expect(tenantModeOf(status)).toBe(expected[status]);
  });
  it("no subscription row fails closed (read-only)", () => {
    expect(tenantModeOf(null)).toBe("read_only");
    expect(tenantModeOf(undefined)).toBe("read_only");
  });
});

describe("isAllowedInMode", () => {
  it("covers every capability", () => {
    expect(Object.keys(ALLOWED_WHEN_READ_ONLY).sort()).toEqual([...CAPABILITY_NAMES].sort());
  });
  it.each(CAPABILITY_NAMES)("%s: normal → allowed; read_only → per D-13", (capability) => {
    expect(isAllowedInMode(capability, "normal")).toBe(true);
    expect(isAllowedInMode(capability, "read_only")).toBe(ALLOWED_WHEN_READ_ONLY[capability]);
  });
});

describeDb("assertWritable / readTenantMode (subscription row, RLS)", () => {
  const t = useTestDatabase();

  it("reads the tenant's own subscription and blocks only non-allowlisted writes", async () => {
    const a = await seedTenant(t.current, { subscription: "read_only" });
    const b = await seedTenant(t.current, { subscription: "active" });
    const check = (operatorId: string, capability: Capability) =>
      t.current.db.withTenant(operatorId, (tx) => assertWritable(tx, capability));

    expect(await t.current.db.withTenant(a.operatorId, readTenantMode)).toBe("read_only");
    expect(await t.current.db.withTenant(b.operatorId, readTenantMode)).toBe("normal");

    expect(await check(a.operatorId, "customers.manage")).toEqual({
      ok: false,
      error: {
        code: "TENANT_READ_ONLY",
        message: "Tenant is in read-only mode",
        details: { capability: "customers.manage" },
      },
    });
    expect((await check(a.operatorId, "payments.record")).ok).toBe(true);
    expect((await check(a.operatorId, "dashboard.view")).ok).toBe(true);
    // B's active subscription is not A's: B can write.
    expect((await check(b.operatorId, "customers.manage")).ok).toBe(true);
  });

  it("follows status changes and treats a missing row as read-only", async () => {
    const tenant = await seedTenant(t.current, { subscription: null });
    const mode = () => t.current.db.withTenant(tenant.operatorId, readTenantMode);
    expect(await mode()).toBe("read_only");
    for (const status of ["trialing", "grace", "cancelled", "active"] as const) {
      await setSubscriptionStatus(t.current, tenant.operatorId, status);
      expect(await mode()).toBe(tenantModeOf(status));
    }
  });
});
