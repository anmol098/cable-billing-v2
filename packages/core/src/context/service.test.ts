/**
 * defineService pipeline: context check → role → validation → withTenant → writable → run →
 * audit → error mapping → log.
 */
import { areas, auditEvents, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { err, ok } from "@cb/domain";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Capability } from "../authz/capabilities";
import { notFound } from "../errors/errors";
import { PiiInLogError } from "../logging/logger";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { defineService, isService } from "./service";
import type { TenantContext } from "./tenant-context";

describe("defineService definition checks", () => {
  const base = { capability: "dashboard.view" as Capability, input: z.object({}) };
  const run = async () => ok(1);

  it("requires a dotted snake_case name and a known capability", () => {
    expect(() => defineService({ ...base, name: "NoDots", run })).toThrow(TypeError);
    expect(() => defineService({ ...base, name: "a.B", run })).toThrow(TypeError);
    expect(() =>
      defineService({ ...base, capability: "god.mode" as Capability, name: "a.b", run }),
    ).toThrow(TypeError);
    const service = defineService({ ...base, name: "areas.get", run });
    expect(isService(service)).toBe(true);
    expect(Object.isFrozen(service)).toBe(true);
  });
});

describeDb("defineService pipeline", () => {
  const t = useTestDatabase();
  const fixedNow = new Date("2026-10-13T06:00:00.000Z");
  const runtime = () => testRuntime(t.current.db, { now: () => fixedNow });

  const areaCount = async (operatorId: string) => {
    const r = await t.current.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM areas WHERE operator_id = $1",
      [operatorId],
    );
    return r.rows[0]?.n ?? -1;
  };

  async function setup(subscription: "active" | "read_only" = "active") {
    const tenant = await seedTenant(t.current, { subscription });
    const rt = runtime();
    const owner = await contextFor(rt, tenant, "owner");
    return { tenant, rt, owner };
  }

  const createArea = defineService({
    name: "tests.create_area",
    capability: "business_profile.manage",
    input: z.object({ name: z.string().min(1).max(60) }),
    async run({ ctx, input, tx, audit, now }) {
      const id = uuidv7();
      await tx.insert(areas).values({ id, operatorId: ctx.operatorId, name: input.name });
      await audit.record({ entityType: "area", entityId: id, after: { name: input.name } });
      return ok({ id, at: now.toISOString() });
    },
  });

  it("runs inside the tenant, audits in the same transaction and logs request/operator ids", async () => {
    const { tenant, rt, owner } = await setup();
    const result = await createArea.call(rt, owner, { name: "North" });
    expect(result).toEqual({
      ok: true,
      value: { id: expect.any(String), at: fixedNow.toISOString() },
    });
    if (!result.ok) return;
    const events = await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, result.value.id)),
    );
    expect(events).toEqual([
      expect.objectContaining({
        action: "tests.create_area",
        actorId: tenant.users.owner,
        actorRole: "owner",
        requestId: owner.requestId,
      }),
    ]);
    expect(rt.records).toEqual([
      expect.objectContaining({
        level: "info",
        event: "service.completed",
        request_id: owner.requestId,
        operator_id: tenant.operatorId,
        user_id: tenant.users.owner,
        service: "tests.create_area",
        capability: "business_profile.manage",
        duration_ms: expect.any(Number),
      }),
    ]);
  });

  it("refuses a context that resolveTenantContext did not issue", async () => {
    const { tenant, rt } = await setup();
    const forged = {
      operatorId: tenant.operatorId,
      userId: tenant.users.owner,
      role: "owner",
      channel: "web",
      requestId: "r1",
    } as unknown as TenantContext;
    await expect(createArea.call(rt, forged, { name: "x" })).rejects.toThrow(TypeError);
    expect(await areaCount(tenant.operatorId)).toBe(0);
  });

  it("checks the role before the input, and never runs for a forbidden role", async () => {
    const tenant = await seedTenant(t.current);
    const rt = runtime();
    const staff = await contextFor(rt, tenant, "staff");
    const run = vi.fn(async () => ok(1));
    const service = defineService({
      name: "tests.owner_only",
      capability: "plans.manage",
      input: z.object({ planId: z.uuid() }),
      run,
    });
    const result = await service.call(rt, staff, { planId: "not-a-uuid" });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "FORBIDDEN",
        details: { capability: "plans.manage" },
      }),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns VALIDATION (paths and codes only) without running", async () => {
    const { rt, owner } = await setup();
    const result = await createArea.call(rt, owner, { name: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.details).toEqual({ fields: [{ path: "name", code: "too_small" }] });
  });

  it("read-only tenant: blocks writes off the allowlist, allows reads and collections", async () => {
    const { tenant, rt, owner } = await setup("read_only");
    const blocked = await createArea.call(rt, owner, { name: "North" });
    expect(blocked.ok || blocked.error.code).toBe("TENANT_READ_ONLY");
    expect(await areaCount(tenant.operatorId)).toBe(0);

    const record = defineService({
      name: "tests.record_payment",
      capability: "payments.record",
      input: z.object({}),
      async run({ audit }) {
        audit.skip("no_change");
        return ok("recorded");
      },
    });
    const lineman = await contextFor(rt, tenant, "lineman");
    expect(await record.call(rt, lineman, {})).toEqual({ ok: true, value: "recorded" });

    const view = defineService({
      name: "tests.view",
      capability: "dashboard.view",
      input: z.object({}),
      run: async () => ok("viewed"),
    });
    expect(await view.call(rt, owner, {})).toEqual({ ok: true, value: "viewed" });
  });

  it("an err result rolls back everything the call wrote", async () => {
    const { tenant, rt, owner } = await setup();
    const service = defineService({
      name: "tests.write_then_fail",
      capability: "business_profile.manage",
      input: z.object({}),
      async run({ ctx, tx, audit }) {
        const id = uuidv7();
        await tx.insert(areas).values({ id, operatorId: ctx.operatorId, name: "Temp" });
        await audit.record({ entityType: "area", entityId: id });
        return err(notFound());
      },
    });
    expect(await service.call(rt, owner, {})).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await areaCount(tenant.operatorId)).toBe(0);
    const audits = await t.current.admin.query(
      "SELECT 1 FROM audit_events WHERE operator_id = $1",
      [tenant.operatorId],
    );
    expect(audits.rowCount).toBe(0);
  });

  it("an audited capability without an audit event fails with INTERNAL and rolls back", async () => {
    const { tenant, rt, owner } = await setup();
    const service = defineService({
      name: "tests.forgot_audit",
      capability: "business_profile.manage",
      input: z.object({}),
      async run({ ctx, tx }) {
        await tx.insert(areas).values({ id: uuidv7(), operatorId: ctx.operatorId, name: "A" });
        return ok(1);
      },
    });
    const result = await service.call(rt, owner, {});
    expect(result.ok || result.error.code).toBe("INTERNAL");
    expect(await areaCount(tenant.operatorId)).toBe(0);
    expect(rt.records.at(-1)).toMatchObject({
      level: "error",
      event: "service.failed",
      error_code: "INTERNAL",
      error_type: "AuditMissingError",
    });
  });

  it("read capabilities run in a READ ONLY transaction", async () => {
    const { tenant, rt, owner } = await setup();
    const sneaky = defineService({
      name: "tests.sneaky_view",
      capability: "dashboard.view",
      input: z.object({}),
      async run({ ctx, tx }) {
        await tx.insert(areas).values({ id: uuidv7(), operatorId: ctx.operatorId, name: "B" });
        return ok(1);
      },
    });
    expect((await sneaky.call(rt, owner, {})).ok).toBe(false);
    expect(await areaCount(tenant.operatorId)).toBe(0);
  });

  it("an operator_id taken from the input can't write into another tenant (→ NOT_FOUND)", async () => {
    const { tenant, rt, owner } = await setup();
    const victim: SeededTenant = await seedTenant(t.current);
    const trusting = defineService({
      name: "tests.trusting_create_area",
      capability: "business_profile.manage",
      input: z.object({ operatorId: z.uuid(), name: z.string() }),
      async run({ input, tx, audit }) {
        await tx
          .insert(areas)
          .values({ id: uuidv7(), operatorId: input.operatorId, name: input.name });
        await audit.record({ entityType: "area" });
        return ok(1);
      },
    });
    const result = await trusting.call(rt, owner, { operatorId: victim.operatorId, name: "Evil" });
    expect(result).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await areaCount(victim.operatorId)).toBe(0);
    expect(await areaCount(tenant.operatorId)).toBe(0);
  });

  it("maps a unique violation to CONFLICT with the constraint name", async () => {
    const { rt, owner } = await setup();
    expect((await createArea.call(rt, owner, { name: "Dup" })).ok).toBe(true);
    expect(await createArea.call(rt, owner, { name: "dup" })).toEqual({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Unique or exclusion constraint violated",
        details: { constraint: "areas_operator_name_unique" },
      },
    });
  });

  it("sees only its own tenant's rows (RLS under the service)", async () => {
    const { rt, owner, tenant } = await setup();
    const other = await seedTenant(t.current);
    await t.current.admin.query(
      "INSERT INTO areas (id, operator_id, name) VALUES (gen_random_uuid(), $1, 'Theirs'), (gen_random_uuid(), $2, 'Ours')",
      [other.operatorId, tenant.operatorId],
    );
    const list = defineService({
      name: "tests.list_areas",
      capability: "dashboard.view",
      input: z.object({}),
      async run({ tx }) {
        return ok(await tx.select({ name: areas.name }).from(areas));
      },
    });
    expect(await list.call(rt, owner, {})).toEqual({ ok: true, value: [{ name: "Ours" }] });
  });

  it("unexpected errors become INTERNAL; the log has safe fields only", async () => {
    const { rt, owner } = await setup();
    const boom = defineService({
      name: "tests.boom",
      capability: "dashboard.view",
      input: z.object({}),
      async run({ tx }) {
        await tx.execute(sql`select 1/0`);
        return ok(1);
      },
    });
    expect(await boom.call(rt, owner, {})).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Unexpected error" },
    });
    expect(rt.records.at(-1)).toMatchObject({
      level: "error",
      event: "service.failed",
      error_code: "INTERNAL",
      sqlstate: "22012",
    });
  });

  it("logging PII inside a service fails the call loudly in tests", async () => {
    const { rt, owner } = await setup();
    const leaky = defineService({
      name: "tests.leaky_log",
      capability: "dashboard.view",
      input: z.object({}),
      async run({ log }) {
        log.info("tests.leak", { customer_phone: "9876543210" });
        return ok(1);
      },
    });
    await expect(leaky.call(rt, owner, {})).rejects.toThrow(PiiInLogError);
  });
});
