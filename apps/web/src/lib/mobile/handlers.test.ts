// @vitest-environment node
/**
 * The T-028 route handlers over a stub `MobileAuthService` (no database; the service itself is
 * tested against Postgres in @cb/core): every response is parsed with the contract's schema
 * (`@cb/contracts`), success bodies reproduce the contract fixtures exactly, errors carry the
 * contract code, HTTP status, request id and extras, and anything unexpected becomes INTERNAL.
 */
import { readFileSync } from "node:fs";
import {
  AppConfigResponse,
  ENDPOINTS,
  ErrorResponse,
  httpStatusForError,
  LoginResponse,
  LogoutResponse,
  RefreshResponse,
} from "@cb/contracts";
import {
  createLogger,
  createServiceRuntime,
  type LogRecord,
  type MobileAuthFailure,
  type MobileAuthService,
  type TenantContext,
} from "@cb/core";
import type { DbClient } from "@cb/db";
import { err, ok } from "@cb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appConfigHandler, loginHandler, logoutHandler, refreshHandler } from "./handlers";
import type { MobileDeps } from "./http";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../../packages/contracts/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

const loginFixture = fixture("login.response");
const refreshFixture = fixture("refreshTokens.response");
const configFixture = fixture("getAppConfig.response");
const NOW = new Date("2026-10-13T04:30:00.000Z");
const VERCEL_ID = "bom1::iad1::abcd1-1760329800000-0123456789ab";

/** Builds core results that should map back to the fixtures. */
const tokensFrom = (wire: typeof loginFixture.tokens) => ({
  accessToken: wire.access_token,
  accessTokenExpiresAt: new Date(wire.access_token_expires_at),
  refreshToken: wire.refresh_token,
  refreshTokenExpiresAt: new Date(wire.refresh_token_expires_at),
});
const operatorFrom = (wire: typeof loginFixture.operator) => ({
  id: wire.id,
  name: wire.name,
  officePhone: wire.office_phone,
  receiptFooter: wire.receipt_footer,
});

function stubService(): MobileAuthService & {
  [K in keyof MobileAuthService]: ReturnType<typeof vi.fn>;
} {
  return {
    minAppVersionCode: 3,
    login: vi.fn(async () =>
      ok({
        tokens: tokensFrom(loginFixture.tokens),
        user: { ...loginFixture.user },
        operator: operatorFrom(loginFixture.operator),
        device: { id: loginFixture.device.id, deviceCode: loginFixture.device.device_code },
      }),
    ),
    refresh: vi.fn(async () => ok({ tokens: tokensFrom(refreshFixture.tokens) })),
    logout: vi.fn(async () => ok({ revoked: true })),
    authenticate: vi.fn(async () =>
      ok({
        ctx: { operatorId: configFixture.operator.id } as unknown as TenantContext,
        claims: {} as never,
        appVersionCode: 5,
      }),
    ),
    appConfig: vi.fn(async () => ({
      minAppVersionCode: configFixture.min_app_version_code,
      operator: operatorFrom(configFixture.operator),
      tenantMode: configFixture.tenant_mode,
      features: {},
    })),
  } as never;
}

let service: ReturnType<typeof stubService>;
let records: LogRecord[];
let deps: MobileDeps;

beforeEach(() => {
  service = stubService();
  records = [];
  const logger = createLogger({ sink: (r) => records.push(r), strict: true });
  deps = {
    auth: service,
    runtime: createServiceRuntime({ db: {} as DbClient, logger, now: () => NOW }),
    logger,
  };
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/mobile/v1/auth/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-version-code": "5",
      "x-vercel-id": VERCEL_ID,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function errorOf(response: Response) {
  const body = ErrorResponse.parse(await response.json());
  expect(response.status).toBe(httpStatusForError(body.error.code));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.server_time).toBe(NOW.toISOString());
  return body.error;
}

const loginBody = fixture("login.request");

describe("POST /auth/login", () => {
  it("maps the request to the service and answers exactly the contract fixture", async () => {
    const response = await loginHandler(() => deps)(post(loginBody));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    // Valid against the contract, nothing extra, and equal to the fixture (apart from the clock).
    expect(LoginResponse.parse(json)).toEqual(json);
    expect(json).toEqual({ ...loginFixture, server_time: NOW.toISOString() });

    expect(service.login).toHaveBeenCalledWith(
      {
        login: loginBody.login,
        password: loginBody.password,
        device: {
          installId: loginBody.device.install_id,
          model: loginBody.device.model,
          os: loginBody.device.os,
          appVersion: loginBody.device.app_version,
          appVersionCode: loginBody.device.app_version_code,
        },
      },
      expect.objectContaining({ requestId: VERCEL_ID }),
    );
  });

  it("answers VALIDATION for a body that is not JSON or not the contract", async () => {
    const notJson = await errorOf(await loginHandler(() => deps)(post("{nope")));
    expect(notJson).toMatchObject({
      code: "VALIDATION",
      request_id: VERCEL_ID,
      fields: [{ path: "body", issue: "invalid_json" }],
    });
    const { device: _device, ...noDevice } = loginBody;
    const missing = await errorOf(
      await loginHandler(() => deps)(post({ ...noDevice, password: "" })),
    );
    expect(missing.code).toBe("VALIDATION");
    expect(missing.fields?.map((f) => f.path).sort()).toEqual(["device", "password"]);
    expect(JSON.stringify(missing)).not.toContain(loginBody.login);
    expect(service.login).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "INVALID_CREDENTIALS" }, 401, {}],
    [{ code: "ROLE_NOT_ALLOWED", reason: "role_not_allowed" }, 403, {}],
    [{ code: "ACCOUNT_DISABLED", reason: "user_disabled" }, 403, {}],
    [{ code: "APP_TOO_OLD", minAppVersionCode: 7 }, 426, { min_app_version_code: 7 }],
    [{ code: "RATE_LIMITED", retryAfterSeconds: 120 }, 429, { retry_after_seconds: 120 }],
    [
      {
        code: "VALIDATION",
        fields: [{ path: "header.x-app-version-code", issue: "invalid_format" }],
      },
      400,
      { fields: [{ path: "header.x-app-version-code", issue: "invalid_format" }] },
    ],
  ] satisfies [MobileAuthFailure, number, Record<string, unknown>][])(
    "maps %o to its contract status and extras",
    async (failure, status, extras) => {
      service.login.mockResolvedValueOnce(err(failure));
      const response = await loginHandler(() => deps)(post(loginBody));
      expect(response.status).toBe(status);
      const error = await errorOf(response);
      expect(error).toMatchObject({ code: failure.code, request_id: VERCEL_ID, ...extras });
      if (failure.code === "RATE_LIMITED") expect(response.headers.get("retry-after")).toBe("120");
      if (failure.code !== "APP_TOO_OLD") expect(error.min_app_version_code).toBeUndefined();
    },
  );

  it("turns an exception into INTERNAL with the request id, logged without PII", async () => {
    service.login.mockRejectedValueOnce(new Error("connection reset"));
    const error = await errorOf(await loginHandler(() => deps)(post(loginBody)));
    expect(error).toMatchObject({ code: "INTERNAL", request_id: VERCEL_ID });
    expect(records.some((r) => r.event === "mobile_api.failed")).toBe(true);
  });

  it("never sends a response that breaks the contract (INTERNAL instead)", async () => {
    service.login.mockResolvedValueOnce(
      ok({
        tokens: tokensFrom(loginFixture.tokens),
        user: { ...loginFixture.user },
        operator: operatorFrom(loginFixture.operator),
        device: { id: loginFixture.device.id, deviceCode: "toolong" },
      }),
    );
    const error = await errorOf(await loginHandler(() => deps)(post(loginBody)));
    expect(error.code).toBe("INTERNAL");
    expect(records.find((r) => r.event === "mobile_api.response_invalid")).toMatchObject({
      first_path: "device.device_code",
    });
  });

  it("answers INTERNAL when the server is not configured", async () => {
    const response = await loginHandler(() => {
      throw new Error("Missing environment variables: BETTER_AUTH_SECRET");
    })(post(loginBody));
    expect(response.status).toBe(500);
    expect(ErrorResponse.parse(await response.json()).error).toMatchObject({
      code: "INTERNAL",
      request_id: VERCEL_ID,
    });
  });
});

describe("POST /auth/refresh", () => {
  it("rotates and answers the contract fixture", async () => {
    const body = fixture("refreshTokens.request");
    const response = await refreshHandler(() => deps)(post(body));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(RefreshResponse.parse(json)).toEqual(json);
    expect(json).toEqual({ ...refreshFixture, server_time: NOW.toISOString() });
    expect(service.refresh).toHaveBeenCalledWith(
      { refreshToken: body.refresh_token, installId: body.install_id },
      expect.objectContaining({ requestId: VERCEL_ID }),
    );
  });

  it.each([
    ["REFRESH_TOKEN_INVALID", 401],
    ["DEVICE_REVOKED", 401],
    ["ACCOUNT_DISABLED", 403],
  ] as const)("answers %s with %i", async (code, status) => {
    service.refresh.mockResolvedValueOnce(err({ code, reason: "test" }));
    const response = await refreshHandler(() => deps)(post(fixture("refreshTokens.request")));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).code).toBe(code);
  });
});

describe("POST /auth/logout", () => {
  it("answers 200 with only server_time, even without a version header", async () => {
    const response = await logoutHandler(() => deps)(
      new Request("http://localhost/api/mobile/v1/auth/logout", {
        method: "POST",
        body: JSON.stringify(fixture("logout.request")),
      }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(LogoutResponse.parse(json)).toEqual(json);
    expect(json).toEqual({ server_time: NOW.toISOString() });
    expect(ENDPOINTS.logout.appVersionGate).toBe(false);
  });
});

describe("GET /app/config", () => {
  const get = (headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/mobile/v1/app/config", { headers });

  it("authenticates without the version gate and answers the contract fixture", async () => {
    const response = await appConfigHandler(() => deps)(
      get({ authorization: "Bearer x", "x-app-version-code": "1" }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(AppConfigResponse.parse(json)).toEqual(json);
    expect(json).toEqual({ ...configFixture, server_time: NOW.toISOString() });
    expect(service.authenticate).toHaveBeenCalledWith(expect.anything(), {
      appVersionGate: false,
    });
  });

  it.each([
    ["UNAUTHENTICATED", 401],
    ["DEVICE_REVOKED", 401],
    ["ACCOUNT_DISABLED", 403],
    ["ROLE_NOT_ALLOWED", 403],
  ] as const)("refuses with %s (%i) before running the handler", async (code, status) => {
    service.authenticate.mockResolvedValueOnce(err({ code, reason: "test" }));
    const response = await appConfigHandler(() => deps)(get());
    expect(response.status).toBe(status);
    expect((await errorOf(response)).code).toBe(code);
    expect(service.appConfig).not.toHaveBeenCalled();
  });
});
