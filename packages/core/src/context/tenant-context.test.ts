/**
 * TenantContext is built only from the authenticated user's row (PLAN §9.1 item 1).
 */
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { seedTenant } from "../testing/fixtures";
import { newRequestId } from "./runtime";
import {
  assertIssuedTenantContext,
  isIssuedTenantContext,
  resolveTenantContext,
  sanitizeClientInfo,
  type TenantContext,
} from "./tenant-context";

describe("TenantContext cannot be made from request data", () => {
  it("an object literal is not assignable to TenantContext (type level)", () => {
    const fromRequest = {
      operatorId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      userId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
      role: "owner" as const,
      channel: "web" as const,
      requestId: "r1",
    };
    expectTypeOf(fromRequest).not.toExtend<TenantContext>();
    // @ts-expect-error -- the brand is missing: request data can't become a context.
    const ctx: TenantContext = fromRequest;
    // …and a cast doesn't get past the runtime check either.
    expect(isIssuedTenantContext(ctx)).toBe(false);
    expect(() => assertIssuedTenantContext(ctx)).toThrow(TypeError);
  });

  it("sanitizes client info for the audit trail", () => {
    expect(sanitizeClientInfo({ ip: "203.0.113.7", userAgent: "x".repeat(600) })).toEqual({
      ip: "203.0.113.7",
      userAgent: "x".repeat(512),
    });
    expect(sanitizeClientInfo({ ip: "2001:db8::1" })).toEqual({ ip: "2001:db8::1" });
    expect(sanitizeClientInfo({ ip: "not-an-ip'; drop" })).toBeUndefined();
    expect(sanitizeClientInfo(undefined)).toBeUndefined();
  });
});

describeDb("resolveTenantContext", () => {
  const t = useTestDatabase();
  const runtime = {
    get db() {
      return t.current.db;
    },
  };

  it("takes operatorId and role from the user's row (web owner/staff, mobile lineman)", async () => {
    const tenant = await seedTenant(t.current);
    const requestId = newRequestId();
    const owner = await resolveTenantContext(runtime, {
      userId: tenant.users.owner,
      channel: "web",
      requestId,
      client: { ip: "203.0.113.7", userAgent: "Mozilla" },
    });
    expect(owner.ok && owner.value).toEqual({
      operatorId: tenant.operatorId,
      userId: tenant.users.owner,
      role: "owner",
      channel: "web",
      requestId,
      client: { ip: "203.0.113.7", userAgent: "Mozilla" },
    });
    expect(owner.ok && Object.isFrozen(owner.value)).toBe(true);
    expect(owner.ok && isIssuedTenantContext(owner.value)).toBe(true);

    const lineman = await resolveTenantContext(runtime, {
      userId: tenant.users.lineman,
      channel: "mobile",
      deviceId: tenant.deviceId,
      requestId,
    });
    expect(lineman.ok && lineman.value).toMatchObject({
      operatorId: tenant.operatorId,
      role: "lineman",
      channel: "mobile",
      deviceId: tenant.deviceId,
    });
  });

  const reasonOf = (r: Awaited<ReturnType<typeof resolveTenantContext>>) =>
    r.ok ? "ok" : `${r.error.code}:${String(r.error.details?.reason)}`;

  it("refuses unknown users, disabled users and suspended operators", async () => {
    const tenant = await seedTenant(t.current);
    const base = { channel: "web" as const, requestId: newRequestId() };
    expect(
      reasonOf(
        await resolveTenantContext(runtime, {
          ...base,
          userId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        }),
      ),
    ).toBe("UNAUTHENTICATED:unknown_user");
    expect(reasonOf(await resolveTenantContext(runtime, { ...base, userId: "1 OR 1=1" }))).toBe(
      "UNAUTHENTICATED:unknown_user",
    );

    await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
      tenant.users.staff,
    ]);
    expect(
      reasonOf(await resolveTenantContext(runtime, { ...base, userId: tenant.users.staff })),
    ).toBe("ACCOUNT_DISABLED:user_disabled");

    await t.current.admin.query("UPDATE operators SET status = 'suspended' WHERE id = $1", [
      tenant.operatorId,
    ]);
    expect(
      reasonOf(await resolveTenantContext(runtime, { ...base, userId: tenant.users.owner })),
    ).toBe("ACCOUNT_DISABLED:operator_suspended");
  });

  it("refuses platform admins (no tenant) and roles on the wrong channel", async () => {
    const tenant = await seedTenant(t.current);
    const admin = await createUser(t.current, { operatorId: null });
    const requestId = newRequestId();
    expect(
      reasonOf(
        await resolveTenantContext(runtime, { userId: admin.userId, channel: "web", requestId }),
      ),
    ).toBe("FORBIDDEN:not_a_tenant_user");
    expect(
      reasonOf(
        await resolveTenantContext(runtime, {
          userId: tenant.users.lineman,
          channel: "web",
          requestId,
        }),
      ),
    ).toBe("FORBIDDEN:channel_not_allowed");
    expect(
      reasonOf(
        await resolveTenantContext(runtime, {
          userId: tenant.users.owner,
          channel: "mobile",
          deviceId: tenant.deviceId,
          requestId,
        }),
      ),
    ).toBe("FORBIDDEN:channel_not_allowed");
  });

  it("mobile needs a non-revoked device of the user's own tenant", async () => {
    const tenant = await seedTenant(t.current);
    const other = await seedTenant(t.current);
    const base = { userId: tenant.users.lineman, channel: "mobile" as const, requestId: "req-1" };
    expect(reasonOf(await resolveTenantContext(runtime, base))).toBe(
      "UNAUTHENTICATED:device_missing",
    );
    // Another tenant's device id: invisible under RLS, so it's simply unknown.
    expect(
      reasonOf(await resolveTenantContext(runtime, { ...base, deviceId: other.deviceId })),
    ).toBe("UNAUTHENTICATED:device_revoked");
    await t.current.admin.query("UPDATE devices SET revoked_at = now() WHERE id = $1", [
      tenant.deviceId,
    ]);
    expect(
      reasonOf(await resolveTenantContext(runtime, { ...base, deviceId: tenant.deviceId })),
    ).toBe("UNAUTHENTICATED:device_revoked");
  });

  it("rejects a malformed request id (log/header injection) by throwing", async () => {
    const tenant = await seedTenant(t.current);
    await expect(
      resolveTenantContext(runtime, {
        userId: tenant.users.owner,
        channel: "web",
        requestId: "bad id\nINJECTED",
      }),
    ).rejects.toThrow(TypeError);
  });
});
