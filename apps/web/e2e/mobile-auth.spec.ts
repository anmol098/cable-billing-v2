/**
 * Mobile API sign-in end to end (T-028) against `next start` and a real, migrated database: every
 * response body is parsed with the contract's schema (`@cb/contracts`).
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET` for the test runner and the server (the
 * CI "Web e2e" job sets them). Seeds its own operator and users with random names.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  AppConfigResponse,
  ErrorResponse,
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
} from "@cb/contracts";
import {
  createServiceRuntime,
  hashPassword,
  newRequestId,
  resolveTenantContext,
  revokeDevice,
} from "@cb/core";
import {
  accounts,
  createDb,
  type DbClient,
  operators,
  parseOperatorSettings,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { type APIRequestContext, type APIResponse, expect, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e lineman 4321";
const API = "/api/mobile/v1";

test.describe("mobile auth API", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");
  test.describe.configure({ mode: "serial" });

  const run = randomBytes(4).toString("hex");
  const login = (who: string) => `e2e-mobile-${who}-${run}`;
  // Own address for the in-memory per-IP limits (the server trusts x-real-ip outside Vercel).
  const ip = `203.0.113.${(Number.parseInt(run.slice(0, 2), 16) % 200) + 20}`;
  const headers = { "x-app-version-code": "5", "x-real-ip": ip };
  let db: DbClient;
  let operatorId: string;
  let ownerId = "";

  const device = (installId: string) => ({
    install_id: installId,
    model: "Xiaomi Redmi 9A",
    os: "Android 13 (API 33)",
    app_version: "1.0.3",
    app_version_code: 5,
  });

  async function errorCode(response: APIResponse, status: number) {
    expect(response.status()).toBe(status);
    const body = ErrorResponse.parse(await response.json());
    expect(body.error.request_id).toBeTruthy();
    return body.error.code;
  }

  async function signIn(request: APIRequestContext, who = "lineman", installId = randomUUID()) {
    const response = await request.post(`${API}/auth/login`, {
      headers,
      data: { login: login(who), password: PASSWORD, device: device(installId) },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    return { body: LoginResponse.parse(await response.json()), installId };
  }

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({
        id: operatorId,
        name: `E2E Mobile Cable ${run}`,
        settings: parseOperatorSettings({ office_phone: "9800000001" }),
      });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const role of ["lineman", "owner"] as const) {
        const id = uuidv7();
        if (role === "owner") ownerId = id;
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${role}`,
          login: login(role),
          email: role === "owner" ? `${login(role)}@cable.test` : null,
          language: "hi",
        });
        await tx.insert(accounts).values({
          id: uuidv7(),
          userId: id,
          accountId: id,
          providerId: "credential",
          password: hash,
        });
      }
    });
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a lineman signs in, reads the app config and refreshes; reuse is caught", async ({
    request,
  }) => {
    const { body, installId } = await signIn(request);
    expect(body.user.login).toBe(login("lineman"));
    expect(body.operator).toMatchObject({ id: operatorId, office_phone: "9800000001" });
    expect(body.device.device_code).toMatch(/^[A-Z0-9]{3}$/);

    const config = await request.get(`${API}/app/config`, {
      headers: { ...headers, authorization: `Bearer ${body.tokens.access_token}` },
    });
    expect(config.status()).toBe(200);
    expect(AppConfigResponse.parse(await config.json())).toMatchObject({
      min_app_version_code: 1,
      tenant_mode: "normal",
      operator: { id: operatorId },
    });

    // Rotation: A → B. A again right away (a lost response) is accepted once → C.
    const refresh = (token: string) =>
      request.post(`${API}/auth/refresh`, {
        headers,
        data: { refresh_token: token, install_id: installId },
      });
    const b = await refresh(body.tokens.refresh_token);
    expect(b.status()).toBe(200);
    const pairB = RefreshResponse.parse(await b.json()).tokens;
    expect(pairB.refresh_token).not.toBe(body.tokens.refresh_token);
    const c = await refresh(body.tokens.refresh_token);
    expect(c.status()).toBe(200);
    const pairC = RefreshResponse.parse(await c.json()).tokens;

    // A a third time is reuse: the whole family dies, C included.
    expect(await errorCode(await refresh(body.tokens.refresh_token), 401)).toBe(
      "REFRESH_TOKEN_INVALID",
    );
    expect(await errorCode(await refresh(pairC.refresh_token), 401)).toBe("REFRESH_TOKEN_INVALID");
    const dead = await request.get(`${API}/app/config`, {
      headers: { ...headers, authorization: `Bearer ${pairC.access_token}` },
    });
    expect(await errorCode(dead, 401)).toBe("UNAUTHENTICATED");
  });

  test("owners are refused on the phone; wrong passwords and bad requests get contract errors", async ({
    request,
  }) => {
    const owner = await request.post(`${API}/auth/login`, {
      headers,
      data: { login: login("owner"), password: PASSWORD, device: device(randomUUID()) },
    });
    expect(await errorCode(owner, 403)).toBe("ROLE_NOT_ALLOWED");

    const wrong = await request.post(`${API}/auth/login`, {
      headers,
      data: { login: login("lineman"), password: "not it", device: device(randomUUID()) },
    });
    expect(await errorCode(wrong, 401)).toBe("INVALID_CREDENTIALS");

    const noVersion = await request.post(`${API}/auth/refresh`, {
      headers: { "x-real-ip": ip },
      data: { refresh_token: "x", install_id: randomUUID() },
    });
    expect(await errorCode(noVersion, 400)).toBe("VALIDATION");

    const noToken = await request.get(`${API}/app/config`, { headers });
    expect(await errorCode(noToken, 401)).toBe("UNAUTHENTICATED");
  });

  test("logout and 'sign out this phone' end the session", async ({ request }) => {
    const first = await signIn(request);
    const logout = await request.post(`${API}/auth/logout`, {
      headers: { "x-real-ip": ip },
      data: { refresh_token: first.body.tokens.refresh_token },
    });
    expect(logout.status()).toBe(200);
    LogoutResponse.parse(await logout.json());
    const after = await request.post(`${API}/auth/refresh`, {
      headers,
      data: { refresh_token: first.body.tokens.refresh_token, install_id: first.installId },
    });
    expect(await errorCode(after, 401)).toBe("REFRESH_TOKEN_INVALID");

    const second = await signIn(request);
    // The owner's "Sign out this phone" (the service T-032's button calls).
    const runtime = createServiceRuntime({ db });
    const owner = await resolveTenantContext(runtime, {
      userId: ownerId,
      channel: "web",
      requestId: newRequestId(),
    });
    if (!owner.ok) throw new Error(owner.error.code);
    const revoked = await revokeDevice.call(runtime, owner.value, {
      deviceId: second.body.device.id,
    });
    expect(revoked.ok).toBe(true);
    const config = await request.get(`${API}/app/config`, {
      headers: { ...headers, authorization: `Bearer ${second.body.tokens.access_token}` },
    });
    expect(await errorCode(config, 401)).toBe("DEVICE_REVOKED");
    const refreshed = await request.post(`${API}/auth/refresh`, {
      headers,
      data: { refresh_token: second.body.tokens.refresh_token, install_id: second.installId },
    });
    expect(await errorCode(refreshed, 401)).toBe("DEVICE_REVOKED");
  });
});
