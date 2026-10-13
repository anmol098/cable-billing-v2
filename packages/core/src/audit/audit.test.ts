import { auditEvents } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contextFor, seedTenant } from "../testing/fixtures";
import { createAuditRecorder, writeAuditEvent } from "./audit";
import { isSensitiveAuditKey, REDACTED, redactForAudit } from "./redact";

describe("redactForAudit", () => {
  it("redacts credentials, secrets and KYC at any depth; keeps business values", () => {
    const input = {
      name: "Ramesh",
      phone: "9876543210",
      password: "hunter2",
      passwordHash: "$argon2id$…",
      account: { refresh_token: "abc", tokenHash: "f00", nested: [{ otp: "123456" }] },
      kyc: { aadhaar: "1234 5678 9012" },
      panNumber: "ABCDE1234F",
      amount_paise: 50000,
      at: new Date("2026-10-13T00:00:00.000Z"),
      big: 12n,
      fn: () => 1,
      gone: undefined,
    };
    expect(redactForAudit(input)).toEqual({
      name: "Ramesh",
      phone: "9876543210",
      password: REDACTED,
      passwordHash: REDACTED,
      account: { refresh_token: REDACTED, tokenHash: REDACTED, nested: [{ otp: REDACTED }] },
      kyc: REDACTED,
      panNumber: REDACTED,
      amount_paise: 50000,
      at: "2026-10-13T00:00:00.000Z",
      big: "12",
    });
  });

  it("sensitive keys", () => {
    for (const key of ["password", "api_key", "apiKey", "secret", "cookie", "Authorization"]) {
      expect(isSensitiveAuditKey(key), key).toBe(true);
    }
    for (const key of ["phone", "name", "status", "amount_paise", "panel"]) {
      expect(isSensitiveAuditKey(key), key).toBe(false);
    }
  });

  it("bounds depth", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20; i += 1) deep = { d: deep };
    expect(JSON.stringify(redactForAudit(deep))).toContain(REDACTED);
  });
});

describeDb("audit writer", () => {
  const t = useTestDatabase();

  it("records actor, tenant, request and redacted diff in the caller's transaction", async () => {
    const tenant = await seedTenant(t.current);
    const ctx = await contextFor(t.current, tenant, "owner");
    const entityId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    await t.current.db.withTenant(tenant.operatorId, async (tx) => {
      const audit = createAuditRecorder(tx, ctx, "team.reset_password");
      await audit.record({
        entityType: "user",
        entityId,
        before: { status: "active" },
        after: { status: "active", password: "new-secret" },
      });
      expect(audit.recorded).toBe(1);
    });
    const rows = await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, entityId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operatorId: tenant.operatorId,
      actorId: tenant.users.owner,
      actorRole: "owner",
      action: "team.reset_password",
      entityType: "user",
      before: { status: "active" },
      after: { status: "active", password: REDACTED },
      requestId: ctx.requestId,
    });
  });

  it("rolls back with the transaction", async () => {
    const tenant = await seedTenant(t.current);
    const ctx = await contextFor(t.current, tenant, "owner");
    const entityId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
    await expect(
      t.current.db.withTenant(tenant.operatorId, async (tx) => {
        await createAuditRecorder(tx, ctx, "team.manage").record({ entityType: "user", entityId });
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    const rows = await t.current.admin.query("SELECT 1 FROM audit_events WHERE entity_id = $1", [
      entityId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("refuses malformed action and entity type", async () => {
    const tenant = await seedTenant(t.current);
    await t.current.db.withTenant(tenant.operatorId, async (tx) => {
      const row = {
        operatorId: tenant.operatorId,
        actorId: null,
        actorRole: null,
      } as const;
      await expect(
        writeAuditEvent(tx, { ...row, action: "Changed phone", entityType: "customer" }),
      ).rejects.toThrow(TypeError);
      await expect(
        writeAuditEvent(tx, { ...row, action: "customers.update", entityType: "Customer" }),
      ).rejects.toThrow(TypeError);
    });
  });
});
