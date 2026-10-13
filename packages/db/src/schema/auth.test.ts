/**
 * Identity tables: user constraints (role ↔ tenant, globally unique lower-cased login), RLS for
 * tenant and auth (platform) paths, devices and hashed mobile refresh tokens, and Better Auth
 * (Drizzle adapter, username + two-factor plugins) running against these exact tables.
 */
import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor, username } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import type { Tx } from "../tenant";
import {
  createTenant,
  createUser,
  describeDb,
  type TestTenant,
  type TestUser,
  useTestDatabase,
} from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import {
  accounts,
  authSchema,
  devices,
  mobileRefreshTokens,
  sessions,
  twoFactors,
  users,
  verifications,
} from "./auth";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";
const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * A Better Auth instance over one transaction, configured the way T-026 is expected to: the
 * schema map from @cb/db, the username plugin's fields mapped to `login`/`displayLogin`, the
 * tenant fields declared as additional fields, UUIDv7 ids. (Here `operatorId`, `role` and
 * `language` are `input: true` so the test can sign users up directly; in the app they must be
 * `input: false` and set on the server.)
 */
function authOver(tx: Tx) {
  return betterAuth({
    secret: "t021-test-secret-not-for-production-0123456789",
    baseURL: "http://localhost:3000",
    telemetry: { enabled: false },
    logger: { disabled: true },
    database: drizzleAdapter(tx, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true },
    advanced: { database: { generateId: () => uuidv7() } },
    user: {
      additionalFields: {
        operatorId: { type: "string", required: false, input: true },
        role: { type: "string", required: true, input: true },
        language: { type: "string", required: true, input: true },
        phone: { type: "string", required: false, input: false },
        status: { type: "string", required: false, input: false, defaultValue: "active" },
        legacySource: { type: "string", required: false, input: false },
        legacyId: { type: "string", required: false, input: false },
      },
    },
    plugins: [
      username({
        schema: { user: { fields: { username: "login", displayUsername: "displayLogin" } } },
      }),
      twoFactor(),
    ],
  });
}

describeDb("users, auth tables, devices, refresh tokens", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  let ownerA: TestUser;
  let linemanA: TestUser;
  let linemanB: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    ownerA = await createUser(t.current, { operatorId: a.operatorId });
    linemanA = await createUser(t.current, { operatorId: a.operatorId, role: "lineman" });
    linemanB = await createUser(t.current, { operatorId: b.operatorId, role: "lineman" });
    admin = await createUser(t.current, { operatorId: null });
  });

  const insertUser = (values: Record<string, unknown>) => {
    const row = {
      id: uuidv7(),
      operator_id: a.operatorId,
      role: "staff",
      name: "Someone",
      login: `login_${randomBytes(4).toString("hex")}`,
      email: null,
      language: "en",
      ...values,
    };
    return t.current.admin.query(
      `INSERT INTO users (id, operator_id, role, name, login, email, language)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.operator_id, row.role, row.name, row.login, row.email, row.language],
    );
  };

  it("ties role to tenant: only platform admins have no operator, and they need an email", async () => {
    await expect(insertUser({ operator_id: null, role: "owner" })).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
    await expect(insertUser({ role: "platform_admin", email: "x@admin.test" })).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
    await expect(insertUser({ operator_id: null, role: "platform_admin" })).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
    await insertUser({ operator_id: null, role: "platform_admin", email: "ok@admin.test" });
  });

  it("logins are globally unique, lower-cased and without spaces", async () => {
    await insertUser({ login: "9876500001" });
    await expect(insertUser({ operator_id: b.operatorId, login: "9876500001" })).rejects.toSatisfy(
      failsWith(UNIQUE_VIOLATION),
    );
    for (const bad of ["Ramesh", "ram esh", "ab", "x".repeat(101), " ramesh"]) {
      await expect(insertUser({ login: bad })).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    }
  });

  it("emails are unique and lower-cased", async () => {
    await insertUser({ email: "owner@cable.test" });
    await expect(insertUser({ email: "owner@cable.test" })).rejects.toSatisfy(
      failsWith(UNIQUE_VIOLATION),
    );
    await expect(insertUser({ email: "Owner2@cable.test" })).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
  });

  it("a user's id and tenant can never change, even for the owner role", async () => {
    const error = await t.current.admin
      .query("UPDATE users SET operator_id = $1 WHERE id = $2", [b.operatorId, linemanA.userId])
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isImmutableRowError(error)).toBe(true);
    await t.current.admin.query("UPDATE users SET name = 'Renamed' WHERE id = $1", [
      linemanA.userId,
    ]);
  });

  it("a tenant sees only its own users (never platform admins) and can't create users elsewhere", async () => {
    const seen = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select({ id: users.id, operatorId: users.operatorId }).from(users),
    );
    expect(seen.map((u) => u.id)).toEqual(expect.arrayContaining([ownerA.userId, linemanA.userId]));
    expect(new Set(seen.map((u) => u.operatorId))).toEqual(new Set([a.operatorId]));
    expect(seen.map((u) => u.id)).not.toContain(admin.userId);
    const newUser = (operatorId: string | null, role: "staff" | "platform_admin") => ({
      id: uuidv7(),
      operatorId,
      role,
      name: "New",
      login: `new_${randomBytes(4).toString("hex")}`,
      email: role === "platform_admin" ? `${randomBytes(4).toString("hex")}@admin.test` : null,
      language: "en" as const,
    });
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(users).values(newUser(b.operatorId, "staff")),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(users).values(newUser(null, "platform_admin")),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(users).values(newUser(a.operatorId, "staff")),
    );
  });

  it("the auth path (platform role) reads and updates all users but can't delete them", async () => {
    const all = await t.current.db.withPlatform((tx) => tx.select({ id: users.id }).from(users));
    expect(all.map((u) => u.id)).toEqual(
      expect.arrayContaining([ownerA.userId, linemanB.userId, admin.userId]),
    );
    const deleted = await t.current.db.withPlatform((tx) =>
      tx.delete(users).where(eq(users.id, linemanB.userId)).returning(),
    );
    expect(deleted).toEqual([]);
  });

  it("tenants see and write only their own users' sessions and accounts", async () => {
    const accountFor = (user: TestUser) => ({
      id: uuidv7(),
      userId: user.userId,
      accountId: user.userId,
      providerId: "credential",
      password: "hash-of-a-password",
    });
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(accounts).values(accountFor(linemanA)),
    );
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(accounts).values(accountFor(linemanB)),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    await t.current.db.withPlatform((tx) => tx.insert(accounts).values(accountFor(linemanB)));
    await t.current.db.withPlatform((tx) =>
      tx.insert(sessions).values([
        {
          id: uuidv7(),
          userId: ownerA.userId,
          token: randomBytes(16).toString("hex"),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        {
          id: uuidv7(),
          userId: linemanB.userId,
          token: randomBytes(16).toString("hex"),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      ]),
    );
    const seenA = await t.current.db.withTenant(a.operatorId, async (tx) => ({
      accounts: await tx.select({ userId: accounts.userId }).from(accounts),
      sessions: await tx.select({ userId: sessions.userId }).from(sessions),
    }));
    expect(seenA.accounts).toEqual([{ userId: linemanA.userId }]);
    expect(seenA.sessions).toEqual([{ userId: ownerA.userId }]);
    const revokedOther = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.delete(sessions).where(eq(sessions.userId, linemanB.userId)).returning(),
    );
    expect(revokedOther).toEqual([]);
  });

  it("verifications and two-factor secrets are reachable only on the auth path", async () => {
    await t.current.db.withPlatform(async (tx) => {
      await tx.insert(verifications).values({
        id: uuidv7(),
        identifier: "reset-password:abc",
        value: "x",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await tx
        .insert(twoFactors)
        .values({ id: uuidv7(), userId: admin.userId, secret: "enc", backupCodes: "enc" });
    });
    const seen = await t.current.db.withTenant(a.operatorId, async (tx) => ({
      verifications: await tx.select().from(verifications),
      twoFactors: await tx.select().from(twoFactors),
    }));
    expect(seen).toEqual({ verifications: [], twoFactors: [] });
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(twoFactors).values({
          id: uuidv7(),
          userId: ownerA.userId,
          secret: "enc",
          backupCodes: "enc",
        }),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
  });

  const device = (tenant: TestTenant, user: TestUser, code: string) => ({
    id: uuidv7(),
    operatorId: tenant.operatorId,
    userId: user.userId,
    installId: uuidv7(),
    deviceCode: code,
    model: "Xiaomi Redmi 9A",
    osVersion: "Android 13 (API 33)",
    appVersion: "1.0.0",
    appVersionCode: 1,
  });

  it("device codes are 3 upper-case characters, unique per operator, reusable across operators", async () => {
    const add = (tenant: TestTenant, user: TestUser, code: string) =>
      t.current.db.withTenant(tenant.operatorId, (tx) =>
        tx.insert(devices).values(device(tenant, user, code)),
      );
    await add(a, linemanA, "K7Q");
    await add(b, linemanB, "K7Q");
    await expect(add(a, linemanA, "K7Q")).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
    for (const bad of ["k7q", "K7", "K7QX", "K-Q"]) {
      await expect(add(a, linemanA, bad)).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    }
    const first = device(a, linemanA, "AB1");
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(devices).values(first));
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(devices).values({ ...device(a, linemanA, "AB2"), installId: first.installId }),
      ),
    ).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
  });

  it("composite foreign keys stop a device or token from pointing at another tenant's rows", async () => {
    // Inserted as the owner (RLS bypassed) so the foreign key itself must reject it.
    await expect(
      t.current.admin.query(
        `INSERT INTO devices (id, operator_id, user_id, install_id, device_code)
         VALUES ($1, $2, $3, $4, 'ZZ9')`,
        [uuidv7(), a.operatorId, linemanB.userId, uuidv7()],
      ),
    ).rejects.toSatisfy(failsWith(FK_VIOLATION));
    const deviceB = device(b, linemanB, "QQ1");
    await t.current.db.withTenant(b.operatorId, (tx) => tx.insert(devices).values(deviceB));
    await expect(
      t.current.admin.query(
        `INSERT INTO mobile_refresh_tokens (id, operator_id, user_id, device_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $1, $5, now() + interval '180 days')`,
        [uuidv7(), a.operatorId, linemanA.userId, deviceB.id, sha256Hex("x")],
      ),
    ).rejects.toSatisfy(failsWith(FK_VIOLATION));
  });

  it("refresh tokens are stored only as SHA-256 hex hashes, findable by hash on the auth path", async () => {
    const deviceA = device(a, linemanA, "RT1");
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(devices).values(deviceA));
    const rawToken = randomBytes(32).toString("base64url");
    const tokenId = uuidv7();
    const token = (overrides: Partial<typeof mobileRefreshTokens.$inferInsert> = {}) => ({
      id: tokenId,
      operatorId: a.operatorId,
      userId: linemanA.userId,
      deviceId: deviceA.id,
      familyId: tokenId,
      tokenHash: sha256Hex(rawToken),
      expiresAt: new Date(Date.now() + 180 * 86_400_000),
      ...overrides,
    });
    for (const tokenHash of [rawToken, sha256Hex(rawToken).toUpperCase(), "abc"]) {
      await expect(
        t.current.db.withTenant(a.operatorId, (tx) =>
          tx.insert(mobileRefreshTokens).values(token({ tokenHash })),
        ),
      ).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    }
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(mobileRefreshTokens).values(token({ revokedAt: new Date() })),
      ),
    ).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(mobileRefreshTokens).values(token()),
    );
    // Rotation: the successor in the same family, linked to its parent.
    const nextId = uuidv7();
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx
        .insert(mobileRefreshTokens)
        .values(token({ id: nextId, parentId: tokenId, tokenHash: sha256Hex(`${rawToken}-next`) })),
    );
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(mobileRefreshTokens).values(token({ id: uuidv7() })),
      ),
    ).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));

    const found = await t.current.db.withPlatform((tx) =>
      tx
        .select({
          operatorId: mobileRefreshTokens.operatorId,
          familyId: mobileRefreshTokens.familyId,
        })
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.tokenHash, sha256Hex(rawToken))),
    );
    expect(found).toEqual([{ operatorId: a.operatorId, familyId: tokenId }]);
    const platformUpdate = await t.current.db.withPlatform((tx) =>
      tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date(), revokedReason: "logout" })
        .returning(),
    );
    expect(platformUpdate).toEqual([]);
    await expect(
      t.current.db.withPlatform((tx) =>
        tx
          .insert(mobileRefreshTokens)
          .values(token({ id: uuidv7(), tokenHash: sha256Hex("platform") })),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    const otherTenant = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(mobileRefreshTokens),
    );
    expect(otherTenant).toEqual([]);
    // Reuse detection revokes the whole family, in the tenant's own transaction.
    const revoked = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date(), revokedReason: "reuse_detected" })
        .where(eq(mobileRefreshTokens.familyId, tokenId))
        .returning({ id: mobileRefreshTokens.id }),
    );
    expect(revoked.map((r) => r.id).sort()).toEqual([tokenId, nextId].sort());
  });

  it("Better Auth signs users up and in against these tables (username → login, uuid ids)", async () => {
    const password = "correct horse battery";
    const signedUp = await t.current.db.withPlatform((tx) =>
      authOver(tx).api.signUpEmail({
        body: {
          name: "Ramesh Kumar",
          email: "Ramesh@Example.COM",
          password,
          username: "Ramesh.Owner",
          operatorId: a.operatorId,
          role: "owner",
          language: "en",
        },
      }),
    );
    const userId = signedUp.user.id;
    const [stored] = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select().from(users).where(eq(users.id, userId)),
    );
    expect(stored).toMatchObject({
      operatorId: a.operatorId,
      role: "owner",
      login: "ramesh.owner",
      displayLogin: "Ramesh.Owner",
      email: "ramesh@example.com",
      emailVerified: false,
      language: "en",
      status: "active",
      twoFactorEnabled: false,
    });

    const signedIn = await t.current.db.withPlatform((tx) =>
      authOver(tx).api.signInUsername({ body: { username: "RAMESH.owner", password } }),
    );
    expect(signedIn?.user.id).toBe(userId);
    const byEmail = await t.current.db.withPlatform((tx) =>
      authOver(tx).api.signInEmail({ body: { email: "ramesh@example.com", password } }),
    );
    expect(byEmail.user.id).toBe(userId);

    // The tenant sees its owner's credential account (hashed) and sessions; another tenant doesn't.
    const seenA = await t.current.db.withTenant(a.operatorId, async (tx) => ({
      account: await tx.select().from(accounts).where(eq(accounts.userId, userId)),
      sessions: await tx.select().from(sessions).where(eq(sessions.userId, userId)),
    }));
    expect(seenA.account).toHaveLength(1);
    expect(seenA.account[0]?.providerId).toBe("credential");
    expect(seenA.account[0]?.password).toBeTruthy();
    expect(seenA.account[0]?.password).not.toContain(password);
    expect(seenA.sessions.map((s) => s.token)).toEqual(
      expect.arrayContaining([signedIn?.token, byEmail.token]),
    );
    const seenB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(sessions).where(eq(sessions.userId, userId)),
    );
    expect(seenB).toEqual([]);

    // A platform admin (no tenant) through the same path; a tenant role without a tenant fails.
    const platformAdmin = await t.current.db.withPlatform((tx) =>
      authOver(tx).api.signUpEmail({
        body: {
          name: "Platform Admin",
          email: "root@platform.test",
          password,
          username: "root.admin",
          role: "platform_admin",
          language: "en",
        },
      }),
    );
    const [adminRow] = await t.current.db.withPlatform((tx) =>
      tx.select().from(users).where(eq(users.id, platformAdmin.user.id)),
    );
    expect(adminRow).toMatchObject({ operatorId: null, role: "platform_admin" });
    await expect(
      t.current.db.withPlatform((tx) =>
        authOver(tx).api.signUpEmail({
          body: {
            name: "Orphan Owner",
            email: "orphan@cable.test",
            password,
            username: "orphan.owner",
            role: "owner",
            language: "en",
          },
        }),
      ),
    ).rejects.toThrow();
    const orphan = await t.current.admin.query("SELECT 1 FROM users WHERE login = 'orphan.owner'");
    expect(orphan.rowCount).toBe(0);
  });
});
