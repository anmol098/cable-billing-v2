/**
 * Support access (T-086, PLAN §9.4) against a real database with an injected clock:
 * grant → use → expires → refused, ended early → refused, scoped to one admin and one tenant,
 * and every step visible in the tenant's own audit log (what the Owner sees, T-035). Also the
 * AdminContext gate: tenant users, admins without TOTP, disabled admins and forged contexts.
 */
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { newRequestId } from "../context/runtime";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { type AdminContext, resolveAdminContext } from "./context";
import { endSupportAccess, grantSupportAccess, supportView } from "./support";
import { tenantDetail } from "./tenants";
import { adminContextFor, platformAuditActions, seedPlatformAdmin } from "./test-support";

const T0 = new Date("2026-11-02T05:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const REASON = "Owner called: the lineman cannot sign in";

describeDb("support access (T-086)", () => {
  const t = useTestDatabase();
  let clock = T0;
  let a: SeededTenant;
  let b: SeededTenant;
  let adminId: string;
  let otherAdminId: string;
  let ctx: AdminContext;
  let otherCtx: AdminContext;
  const rt = () => testRuntime(t.current.db, { now: () => clock });

  beforeAll(async () => {
    a = await seedTenant(t.current);
    b = await seedTenant(t.current);
    adminId = await seedPlatformAdmin(t.current, { name: "Asha Admin" });
    otherAdminId = await seedPlatformAdmin(t.current);
    ctx = await adminContextFor(rt(), adminId);
    otherCtx = await adminContextFor(rt(), otherAdminId);
    // Something a support view must never show: a customer's name and phone.
    await t.current.admin.query(
      `INSERT INTO customers (id, operator_id, customer_code, name, phone)
       VALUES (gen_random_uuid(), $1, 'S-1', 'Secret Sharma', '9811122233')`,
      [a.operatorId],
    );
  });

  /** The tenant's audit log as the tenant itself reads it (RLS, `withTenant`). */
  async function tenantLog(operatorId: string) {
    return t.current.db.withTenant(operatorId, async (tx) => {
      const { auditEvents } = await import("@cb/db");
      return tx
        .select({
          action: auditEvents.action,
          actorId: auditEvents.actorId,
          actorRole: auditEvents.actorRole,
          entityId: auditEvents.entityId,
          after: auditEvents.after,
        })
        .from(auditEvents);
    });
  }

  it("without a grant the support view is refused, and nothing is written to the tenant", async () => {
    clock = T0;
    const result = await supportView.call(rt(), ctx, { operatorId: a.operatorId });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", details: { reason: "support_access_required" } },
    });
    expect((await tenantLog(a.operatorId)).filter((e) => e.action.startsWith("support."))).toEqual(
      [],
    );
  });

  it("grant → use → expires after 2 hours → refused; the Owner sees all of it", async () => {
    clock = T0;
    const granted = await grantSupportAccess.call(rt(), ctx, {
      operatorId: a.operatorId,
      reason: REASON,
    });
    if (!granted.ok) throw new Error(granted.error.code);
    expect(granted.value.status).toBe("opened");
    expect(granted.value.grant.expiresAt).toEqual(minutes(120));
    const grantId = granted.value.grant.grantId;

    clock = minutes(119);
    const view = await supportView.call(rt(), ctx, { operatorId: a.operatorId });
    if (!view.ok) throw new Error(view.error.code);
    expect(view.value.operator.name).toBe(a.name);
    expect(view.value.team.map((m) => m.role).sort()).toEqual(["lineman", "owner", "staff"]);
    // No customer names, phones or money records in the support view.
    const text = JSON.stringify(view.value);
    expect(text).not.toContain("Secret Sharma");
    expect(text).not.toContain("9811122233");

    // Exactly at the expiry, and after it: refused (checked on every request, server clock).
    for (const at of [minutes(120), minutes(121), minutes(60 * 24)]) {
      clock = at;
      const late = await supportView.call(rt(), ctx, { operatorId: a.operatorId });
      expect(late, at.toISOString()).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", details: { reason: "support_access_required" } },
      });
    }

    const log = (await tenantLog(a.operatorId)).filter((e) => e.action.startsWith("support."));
    expect(log.map((e) => e.action)).toEqual(["support.access_granted", "support.data_viewed"]);
    for (const event of log) {
      expect(event.actorId).toBe(adminId);
      expect(event.actorRole).toBe("platform_admin");
      expect(event.entityId).toBe(grantId);
    }
    expect(log[0]?.after).toMatchObject({ reason: REASON, minutes: 120 });
    // Tenant B's log has none of it.
    expect((await tenantLog(b.operatorId)).some((e) => e.action.startsWith("support."))).toBe(
      false,
    );
    // The platform log has the grant and the view.
    const platform = await platformAuditActions(t.current, adminId);
    expect(platform).toContain("admin.support_access_granted");
    expect(platform).toContain("admin.support_data_viewed");
  });

  it("a grant is for one admin and one tenant only", async () => {
    clock = minutes(300);
    const granted = await grantSupportAccess.call(rt(), ctx, {
      operatorId: a.operatorId,
      reason: REASON,
      minutes: 30,
    });
    expect(granted.ok).toBe(true);
    clock = minutes(310);
    expect((await supportView.call(rt(), ctx, { operatorId: a.operatorId })).ok).toBe(true);
    expect(await supportView.call(rt(), ctx, { operatorId: b.operatorId })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await supportView.call(rt(), otherCtx, { operatorId: a.operatorId })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    // Asking again while live returns the same grant; the expiry never moves.
    const again = await grantSupportAccess.call(rt(), ctx, {
      operatorId: a.operatorId,
      reason: "A second, different reason",
    });
    if (!again.ok || !granted.ok) throw new Error("grant failed");
    expect(again.value.status).toBe("already_open");
    expect(again.value.grant.grantId).toBe(granted.value.grant.grantId);
    expect(again.value.grant.expiresAt).toEqual(minutes(330));
  });

  it("ending early refuses the next request and is in the tenant's log", async () => {
    clock = minutes(1000);
    const granted = await grantSupportAccess.call(rt(), ctx, {
      operatorId: b.operatorId,
      reason: REASON,
    });
    if (!granted.ok) throw new Error(granted.error.code);
    clock = minutes(1010);
    const ended = await endSupportAccess.call(rt(), ctx, {
      operatorId: b.operatorId,
      grantId: granted.value.grant.grantId,
    });
    expect(ended.ok).toBe(true);
    expect(await supportView.call(rt(), ctx, { operatorId: b.operatorId })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const twice = await endSupportAccess.call(rt(), ctx, {
      operatorId: b.operatorId,
      grantId: granted.value.grant.grantId,
    });
    expect(twice).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const actions = (await tenantLog(b.operatorId)).map((e) => e.action);
    expect(actions).toContain("support.access_granted");
    expect(actions).toContain("support.access_ended");
  });

  it("a reason is required; at most 2 hours; unknown tenants are NOT_FOUND", async () => {
    clock = minutes(2000);
    for (const input of [
      { operatorId: a.operatorId, reason: "" },
      { operatorId: a.operatorId, reason: "too short" },
      { operatorId: a.operatorId, reason: REASON, minutes: 121 },
      { operatorId: "not-a-uuid", reason: REASON },
    ]) {
      const result = await grantSupportAccess.call(rt(), ctx, input);
      expect(result, JSON.stringify(input)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
    }
    const unknown = await grantSupportAccess.call(rt(), ctx, {
      operatorId: "0193a000-0000-7000-8000-000000000000",
      reason: REASON,
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("the tenant detail lists grants with their state", async () => {
    clock = minutes(2100);
    const detail = await tenantDetail.call(rt(), ctx, { operatorId: a.operatorId });
    if (!detail.ok) throw new Error(detail.error.code);
    expect(detail.value.supportGrants.length).toBeGreaterThanOrEqual(2);
    expect(detail.value.supportGrants.every((g) => g.active === false)).toBe(true);
    expect(detail.value.supportGrants[0]?.adminName).toBe("Asha Admin");
  });
});

describeDb("AdminContext gate (T-086)", () => {
  const t = useTestDatabase();
  const rt = () => testRuntime(t.current.db);
  let tenant: SeededTenant;

  beforeAll(async () => {
    tenant = await seedTenant(t.current);
  });

  const principal = (userId: string, twoFactorEnabled = true) => ({
    userId,
    twoFactorEnabled,
    requestId: newRequestId(),
  });

  it("tenant users (owner, staff, lineman) never get an admin context", async () => {
    for (const role of ["owner", "staff", "lineman"] as const) {
      const result = await resolveAdminContext(rt(), principal(tenant.users[role]));
      expect(result, role).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", details: { reason: "not_a_platform_admin" } },
      });
    }
  });

  it("an admin without TOTP (row or session) is refused; a disabled admin too", async () => {
    const noTotp = await seedPlatformAdmin(t.current, { twoFactor: false });
    expect(await resolveAdminContext(rt(), principal(noTotp))).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", details: { reason: "two_factor_required" } },
    });
    const withTotp = await seedPlatformAdmin(t.current);
    expect(await resolveAdminContext(rt(), principal(withTotp, false))).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", details: { reason: "two_factor_required" } },
    });
    expect((await resolveAdminContext(rt(), principal(withTotp))).ok).toBe(true);
    await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [withTotp]);
    expect(await resolveAdminContext(rt(), principal(withTotp))).toMatchObject({
      ok: false,
      error: { code: "ACCOUNT_DISABLED" },
    });
    const unknown = await resolveAdminContext(
      rt(),
      principal("0193a000-0000-7000-8000-000000000001"),
    );
    expect(unknown).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    // A lineman-like row without a tenant can't exist; a tenant user with TOTP is still refused.
    const owner2 = await createUser(t.current, { operatorId: tenant.operatorId, role: "owner" });
    await t.current.admin.query("UPDATE users SET two_factor_enabled = true WHERE id = $1", [
      owner2.userId,
    ]);
    expect(await resolveAdminContext(rt(), principal(owner2.userId))).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", details: { reason: "not_a_platform_admin" } },
    });
  });

  it("services refuse forged contexts and tenant contexts (a programming error, thrown)", async () => {
    const forged = { userId: tenant.users.owner, requestId: newRequestId() } as never;
    await expect(supportView.call(rt(), forged, { operatorId: tenant.operatorId })).rejects.toThrow(
      /AdminContext was not issued/,
    );
    const ownerCtx = (await contextFor(rt(), tenant, "owner")) as never;
    await expect(
      tenantDetail.call(rt(), ownerCtx, { operatorId: tenant.operatorId }),
    ).rejects.toThrow(/AdminContext was not issued/);
  });
});

describe("support access input", () => {
  it("defaults to the maximum of 120 minutes", async () => {
    const { GrantSupportAccessInput } = await import("./support");
    const parsed = GrantSupportAccessInput.parse({
      operatorId: "0193a000-0000-7000-8000-000000000000",
      reason: REASON,
    });
    expect(parsed.minutes).toBe(120);
  });
});
