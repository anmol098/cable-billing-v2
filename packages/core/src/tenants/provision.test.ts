/**
 * Tenant provisioning against a real database (T-027): everything a tenant needs in one
 * transaction, idempotent on retry and under concurrent calls, all-or-nothing on failure, audited,
 * and unable to touch or reveal another tenant.
 */
import { randomInt } from "node:crypto";
import {
  auditEvents,
  counters,
  nextCounter,
  operators,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuthService } from "../auth/auth";
import { hashPassword } from "../auth/password";
import { createMemoryRateLimiter } from "../auth/rate-limit";
import { resolveTenantContext } from "../context/tenant-context";
import { changedTables, databaseFingerprint, seedTenant, testRuntime } from "../testing";
import { type ProvisionTenantInput, provisionTenant } from "./provision";

const PASSWORD = "provision pass 123";
/** 13 Oct 2026, 10:00 IST. */
const NOW = new Date("2026-10-13T04:30:00Z");

const randomMobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

describeDb("provisionTenant", () => {
  const t = useTestDatabase();
  let passwordHash: string;
  const runtime = () => testRuntime(t.current.db, { now: () => NOW });

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  const input = (overrides: Partial<ProvisionTenantInput> = {}): ProvisionTenantInput => {
    const mobile = randomMobile();
    return {
      operatorId: uuidv7(),
      business: { name: "Anmol Cable Network" },
      owner: {
        name: "Anmol Singh",
        email: `owner-${mobile}@Cable.Test`,
        emailVerified: true,
        phone: `+91 ${mobile}`,
        language: "hi",
        passwordHash,
      },
      actor: { kind: "self_signup" },
      request: { requestId: uuidv7(), ip: "203.0.113.7", userAgent: "vitest" },
      ...overrides,
    };
  };

  const ownerRows = (operatorId: string) =>
    t.current.admin.query<{
      id: string;
      role: string;
      login: string;
      email: string | null;
      email_verified: boolean;
      phone: string | null;
      language: string;
      status: string;
    }>(
      "SELECT id, role, login, email, email_verified, phone, language, status FROM users WHERE operator_id = $1",
      [operatorId],
    );

  it("creates operator, owner, credential, trial, counters, settings and one audit event", async () => {
    const request = input();
    const mobile = (request.owner.phone ?? "").replace("+91 ", "");
    const rt = runtime();
    const result = await provisionTenant(rt, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tenant = result.value;
    expect(tenant).toMatchObject({
      status: "created",
      operatorId: request.operatorId,
      ownerLogin: mobile,
      trialEndsAt: new Date("2026-11-12T18:30:00Z"),
    });

    const operator = await t.current.admin.query(
      "SELECT name, phone, status, settings FROM operators WHERE id = $1",
      [request.operatorId],
    );
    expect(operator.rows).toEqual([
      {
        name: "Anmol Cable Network",
        phone: mobile,
        status: "active",
        settings: {
          mid_month_start_policy: "start_next_month",
          invoice_prefix: "INV",
          receipt_footer: null,
          office_phone: mobile,
          default_language: "hi",
        },
      },
    ]);
    expect((await ownerRows(request.operatorId)).rows).toEqual([
      {
        id: tenant.ownerUserId,
        role: "owner",
        login: mobile,
        email: `owner-${mobile}@cable.test`,
        email_verified: true,
        phone: mobile,
        language: "hi",
        status: "active",
      },
    ]);
    const account = await t.current.admin.query(
      "SELECT provider_id, account_id, password FROM accounts WHERE user_id = $1",
      [tenant.ownerUserId],
    );
    expect(account.rows).toEqual([
      { provider_id: "credential", account_id: tenant.ownerUserId, password: passwordHash },
    ]);
    const subscription = await t.current.admin.query(
      "SELECT status, trial_ends_at FROM subscriptions WHERE operator_id = $1",
      [request.operatorId],
    );
    expect(subscription.rows).toEqual([
      { status: "trialing", trial_ends_at: new Date("2026-11-12T18:30:00Z") },
    ]);
    const counterRows = await t.current.admin.query(
      "SELECT name::text, next_value FROM counters WHERE operator_id = $1 ORDER BY name",
      [request.operatorId],
    );
    expect(counterRows.rows).toEqual([
      { name: "customer_code", next_value: "1" },
      { name: "invoice", next_value: "1" },
      { name: "receipt", next_value: "1" },
    ]);
    const first = await t.current.db.withTenant(request.operatorId, (tx) =>
      nextCounter(tx, request.operatorId, "receipt"),
    );
    expect(first).toBe(1);

    const audit = await t.current.admin.query(
      "SELECT action, actor_id, actor_role, entity_type, entity_id, after, host(ip) AS ip, user_agent, request_id FROM audit_events WHERE operator_id = $1",
      [request.operatorId],
    );
    expect(audit.rows).toEqual([
      {
        action: "tenant.provisioned",
        actor_id: tenant.ownerUserId,
        actor_role: "owner",
        entity_type: "operator",
        entity_id: request.operatorId,
        after: {
          source: "self_signup",
          owner_user_id: tenant.ownerUserId,
          subscription_status: "trialing",
          trial_ends_at: "2026-11-12T18:30:00.000Z",
        },
        ip: "203.0.113.7",
        user_agent: "vitest",
        request_id: request.request?.requestId,
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(mobile);
    expect(JSON.stringify(rt.records)).not.toContain(mobile);
    expect(rt.records.map((r) => r.event)).toContain("tenant.provisioned");
  });

  it("gives a working tenant: the owner signs in (by mobile and email) and gets a context", async () => {
    const request = input();
    const result = await provisionTenant(runtime(), request);
    if (!result.ok) throw new Error("provisioning failed");
    const auth = createAuthService({
      db: t.current.db,
      secret: "provision-test-secret-0123456789-abcdefghij",
      baseURL: "http://localhost:3000",
      rateLimiter: createMemoryRateLimiter(),
      sendPasswordResetEmail: async () => {},
      logger: runtime().logger,
    });
    const headers = new Headers({ "x-real-ip": "203.0.113.8" });
    for (const login of [result.value.ownerLogin, request.owner.email ?? ""]) {
      const signedIn = await auth.signIn({ login, password: PASSWORD, headers });
      expect(signedIn).toMatchObject({ ok: true, value: { status: "signed_in", role: "owner" } });
    }
    const context = await resolveTenantContext(runtime(), {
      userId: result.value.ownerUserId,
      channel: "web",
      requestId: uuidv7(),
    });
    expect(context).toMatchObject({
      ok: true,
      value: { operatorId: request.operatorId, role: "owner" },
    });
  });

  it("is idempotent on retry: the same id gives the same tenant and writes nothing", async () => {
    const request = input();
    const first = await provisionTenant(runtime(), request);
    if (!first.ok) throw new Error("provisioning failed");
    const before = await databaseFingerprint(t.current);
    const later = testRuntime(t.current.db, { now: () => new Date("2026-10-14T04:30:00Z") });
    const again = await provisionTenant(later, request);
    expect(again).toEqual({
      ok: true,
      value: { ...first.value, status: "already_provisioned" },
    });
    expect(changedTables(before, await databaseFingerprint(t.current))).toEqual([]);
  });

  it("concurrent calls with one id create exactly one tenant", async () => {
    const request = input();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => provisionTenant(runtime(), request)),
    );
    const statuses = results.map((r) => (r.ok ? r.value.status : r.error.code));
    expect(statuses.filter((s) => s === "created")).toHaveLength(1);
    expect(statuses.filter((s) => s === "already_provisioned")).toHaveLength(5);
    const owners = new Set(results.map((r) => (r.ok ? r.value.ownerUserId : "")));
    expect(owners.size).toBe(1);
    expect((await ownerRows(request.operatorId)).rows).toHaveLength(1);
    const counts = await t.current.admin.query(
      `SELECT (SELECT count(*) FROM operators WHERE id = $1)::int AS operators,
              (SELECT count(*) FROM subscriptions WHERE operator_id = $1)::int AS subscriptions,
              (SELECT count(*) FROM counters WHERE operator_id = $1)::int AS counters,
              (SELECT count(*) FROM audit_events WHERE operator_id = $1)::int AS audit`,
      [request.operatorId],
    );
    expect(counts.rows).toEqual([{ operators: 1, subscriptions: 1, counters: 3, audit: 1 }]);
  }, 60_000);

  it("is all-or-nothing: a taken email leaves no trace, and the same id can be retried", async () => {
    const taken = input();
    if (!(await provisionTenant(runtime(), taken)).ok) throw new Error("setup failed");
    const request = input({ owner: { ...input().owner, email: taken.owner.email } });
    const before = await databaseFingerprint(t.current);
    const refused = await provisionTenant(runtime(), request);
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", details: { reason: "email_taken" } },
    });
    expect(changedTables(before, await databaseFingerprint(t.current))).toEqual([]);

    const fixed = await provisionTenant(runtime(), {
      ...request,
      owner: { ...request.owner, email: `fixed-${uuidv7()}@cable.test` },
    });
    expect(fixed).toMatchObject({ ok: true, value: { status: "created" } });
  });

  it("falls back to <mobile>-2 when the mobile number is already someone's user name", async () => {
    const request = input();
    const mobile = (request.owner.phone ?? "").replace("+91 ", "");
    const other = await seedTenant(t.current);
    await createUser(t.current, { operatorId: other.operatorId, role: "lineman", login: mobile });
    const result = await provisionTenant(runtime(), request);
    expect(result).toMatchObject({ ok: true, value: { ownerLogin: `${mobile}-2` } });
  });

  it("an explicit login that is taken is refused; no login and no mobile is invalid", async () => {
    const other = await seedTenant(t.current);
    const taken = await createUser(t.current, { operatorId: other.operatorId, role: "staff" });
    const base = input();
    expect(
      await provisionTenant(runtime(), { ...base, owner: { ...base.owner, login: taken.login } }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT", details: { reason: "login_taken" } } });
    expect(
      await provisionTenant(runtime(), { ...base, owner: { ...base.owner, phone: null } }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(
      await provisionTenant(runtime(), {
        ...base,
        owner: { ...base.owner, passwordHash: "plain text password" },
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(await provisionTenant(runtime(), { ...base, operatorId: "not-a-uuid" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    const none = await t.current.admin.query("SELECT 1 FROM operators WHERE id = $1", [
      base.operatorId,
    ]);
    expect(none.rowCount).toBe(0);
  });

  it("another tenant's id is refused without changing or revealing that tenant", async () => {
    const victim = await seedTenant(t.current);
    const before = await databaseFingerprint(t.current);
    const result = await provisionTenant(runtime(), input({ operatorId: victim.operatorId }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", details: { reason: "operator_id_in_use" } },
    });
    const text = JSON.stringify(result);
    for (const id of Object.values(victim.users)) expect(text).not.toContain(id);
    expect(changedTables(before, await databaseFingerprint(t.current))).toEqual([]);
  });

  it("new tenants are invisible to other tenants", async () => {
    const result = await provisionTenant(runtime(), input());
    if (!result.ok) throw new Error("provisioning failed");
    const other = await seedTenant(t.current);
    const seen = await t.current.db.withTenant(other.operatorId, async (tx) => ({
      operators: await tx.select().from(operators).where(eq(operators.id, result.value.operatorId)),
      users: await tx.select().from(users).where(eq(users.id, result.value.ownerUserId)),
      subscriptions: await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.operatorId, result.value.operatorId)),
      counters: await tx
        .select()
        .from(counters)
        .where(eq(counters.operatorId, result.value.operatorId)),
      audit: await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operatorId, result.value.operatorId)),
    }));
    expect(seen).toEqual({ operators: [], users: [], subscriptions: [], counters: [], audit: [] });
  });

  it("admin console and migration callers: their actor, no password, own login, trial length", async () => {
    const admin = await createUser(t.current, { operatorId: null });
    const byAdmin = input({
      actor: { kind: "platform_admin", userId: admin.userId },
      trialDays: 60,
    });
    const created = await provisionTenant(runtime(), {
      ...byAdmin,
      owner: {
        ...byAdmin.owner,
        emailVerified: false,
        passwordHash: null,
        login: `Owner-${byAdmin.operatorId.slice(-8)}`,
      },
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        ownerLogin: `owner-${byAdmin.operatorId.slice(-8)}`,
        trialEndsAt: new Date("2026-12-12T18:30:00Z"),
      },
    });
    if (!created.ok) return;
    const accountsOf = await t.current.admin.query("SELECT 1 FROM accounts WHERE user_id = $1", [
      created.value.ownerUserId,
    ]);
    expect(accountsOf.rowCount).toBe(0);
    const adminAudit = await t.current.admin.query(
      "SELECT actor_id, actor_role, after->>'source' AS source FROM audit_events WHERE operator_id = $1",
      [byAdmin.operatorId],
    );
    expect(adminAudit.rows).toEqual([
      { actor_id: admin.userId, actor_role: "platform_admin", source: "platform_admin" },
    ]);

    const migrated = input({ actor: { kind: "system", job: "legacy_migration" } });
    const result = await provisionTenant(runtime(), {
      ...migrated,
      business: { name: "Old Cable", legacySource: "mariadb", legacyId: "42" },
      owner: { ...migrated.owner, email: null, passwordHash: null },
    });
    expect(result).toMatchObject({ ok: true, value: { status: "created" } });
    const migratedAudit = await t.current.admin.query(
      "SELECT actor_id, actor_role, after->>'source' AS source FROM audit_events WHERE operator_id = $1",
      [migrated.operatorId],
    );
    expect(migratedAudit.rows).toEqual([
      { actor_id: null, actor_role: null, source: "legacy_migration" },
    ]);
    // Retrying the migration (no email) is idempotent too: matched on the owner's mobile.
    const retry = await provisionTenant(runtime(), {
      ...migrated,
      business: { name: "Old Cable", legacySource: "mariadb", legacyId: "42" },
      owner: { ...migrated.owner, email: null, passwordHash: null },
    });
    expect(retry).toMatchObject({ ok: true, value: { status: "already_provisioned" } });
    expect(
      await provisionTenant(runtime(), input({ actor: { kind: "system", job: "Bad Job!" } })),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
});

describe("provisionTenant without a database", () => {
  it("validates before touching the database", async () => {
    const db = {
      withTenant: () => {
        throw new Error("no database expected");
      },
      withPlatform: () => {
        throw new Error("no database expected");
      },
    } as unknown as Parameters<typeof testRuntime>[0];
    const result = await provisionTenant(testRuntime(db), {
      operatorId: uuidv7(),
      business: { name: " " },
      owner: {
        name: "",
        email: "not an email",
        phone: "9876543210",
        language: "en",
        passwordHash: null,
      },
      actor: { kind: "self_signup" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    if (result.ok) return;
    const fields = ((result.error.details?.fields ?? []) as { path: string }[]).map((f) => f.path);
    expect(fields).toEqual(expect.arrayContaining(["business.name", "owner.name", "owner.email"]));
    expect(JSON.stringify(result)).not.toContain("not an email");
  });
});
