/**
 * The lineman's roster over HTTP (T-060) against `next start` and a real, migrated database: sign
 * in → full roster sync in pages (gzip) → delta after a change with a tombstone → customer detail →
 * phone correction (and its idempotent repeat) → CURSOR_INVALID and 404 answers. Every body is
 * parsed with the contract (`@cb/contracts`).
 *
 * The handlers are tested in depth (cursor correctness under concurrency, the 1,000-customer size
 * budget, isolation, read-only) in `src/app/api/mobile/v1/{sync,customers}/_lib/*.test.ts` and
 * `packages/core/src/mobile-sync/*.test.ts`; this spec proves the routes are wired as the phone
 * calls them.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `mobile-auth.spec.ts`.
 */
import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { gunzipSync } from "node:zlib";
import {
  CustomerDetailResponse,
  ErrorResponse,
  LoginResponse,
  SyncCustomersResponse,
  UpdatePhoneResponse,
} from "@cb/contracts";
import {
  createServiceRuntime,
  hashPassword,
  newRequestId,
  resolveTenantContext,
  setCustomerStatus,
  silentLogger,
  updateCustomer,
} from "@cb/core";
import {
  accounts,
  createDb,
  customers,
  type DbClient,
  operators,
  parseOperatorSettings,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e roster 6060";
const API = "/api/mobile/v1";

test.describe("mobile roster API", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");
  test.describe.configure({ mode: "serial" });

  // Made inside beforeAll (e2e/_support/unique.ts): a worker may seed this file more than once.
  let run: string;
  let login: string;
  let headers: Record<string, string>;
  let db: DbClient;
  let operatorId: string;
  let ownerId: string;
  let customerIds: string[];

  async function signIn(request: APIRequestContext) {
    const response = await request.post(`${API}/auth/login`, {
      headers,
      data: {
        login,
        password: PASSWORD,
        device: {
          install_id: randomUUID(),
          model: "Xiaomi Redmi 9A",
          os: "Android 13 (API 33)",
          app_version: "1.0.3",
          app_version_code: 5,
        },
      },
    });
    expect(response.status()).toBe(200);
    return LoginResponse.parse(await response.json());
  }

  test.beforeAll(async () => {
    run = newSeedId();
    login = `e2e-roster-${run}`;
    const ip = `203.0.113.${(Number.parseInt(run.slice(0, 2), 16) % 200) + 30}`;
    headers = { "x-app-version-code": "5", "x-real-ip": ip };
    ownerId = uuidv7();
    customerIds = [];
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({
        id: operatorId,
        name: `E2E Roster Cable ${run}`,
        settings: parseOperatorSettings({ office_phone: "9800000002" }),
      });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await tx.insert(users).values({
        id: ownerId,
        operatorId,
        role: "owner",
        name: "E2E Owner",
        login: `${login}-owner`,
        language: "en",
      });
      const linemanId = uuidv7();
      await tx.insert(users).values({
        id: linemanId,
        operatorId,
        role: "lineman",
        name: "E2E Ravi",
        login,
        language: "hi",
      });
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId: linemanId,
        accountId: linemanId,
        providerId: "credential",
        password: hash,
      });
      for (let i = 0; i < 5; i += 1) {
        const id = uuidv7();
        customerIds.push(id);
        await tx.insert(customers).values({
          id,
          operatorId,
          customerCode: `E2E-${run}-${i}`,
          name: `Grahak ${i} ${"Ramesh Kumar ".repeat(8)}`,
          phone: `98765432${10 + i}`,
          address: "House 12, Gali 3, Shiv Nagar ".repeat(4),
        });
      }
    });
  });

  test.afterAll(async () => {
    await db?.end();
  });

  /** A GET without any client-side decompression: the bytes and Content-Encoding as sent. */
  function rawGet(url: string, requestHeaders: Record<string, string>) {
    return new Promise<{ body: Buffer; encoding: string | undefined }>((resolve, reject) => {
      httpGet(url, { headers: requestHeaders }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const encoding = response.headers["content-encoding"];
          resolve({ body: Buffer.concat(chunks), encoding: encoding || undefined });
        });
        response.on("error", reject);
      }).on("error", reject);
    });
  }

  test("full sync in pages, delta with a tombstone, detail and phone correction", async ({
    request,
    baseURL,
  }) => {
    const { tokens } = await signIn(request);
    const auth = { ...headers, authorization: `Bearer ${tokens.access_token}` };

    // Full sync: 2 per page → 3 pages. The body is gzipped for a gzip-accepting client.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await request.get(`${API}/sync/customers`, {
        headers: { ...auth, "accept-encoding": "gzip" },
        params: { limit: "2", ...(cursor ? { cursor } : {}) },
      });
      expect(response.status()).toBe(200);
      const body = SyncCustomersResponse.parse(await response.json());
      seen.push(...body.customers.map((c) => c.id));
      cursor = body.next_cursor;
      if (!body.has_more) break;
    }
    expect(seen.sort()).toEqual([...customerIds].sort());

    // Raw bytes on the wire: gzip once (the server must not encode twice), and plain without it.
    const { body: zipped, encoding } = await rawGet(`${baseURL}${API}/sync/customers`, {
      ...auth,
      "accept-encoding": "gzip",
    });
    expect(encoding).toBe("gzip");
    SyncCustomersResponse.parse(JSON.parse(gunzipSync(zipped).toString("utf8")));
    const plain = await rawGet(`${baseURL}${API}/sync/customers`, auth);
    expect(plain.encoding).toBeUndefined();
    SyncCustomersResponse.parse(JSON.parse(plain.body.toString("utf8")));

    // Close one customer and rename another: the delta brings both (one as a tombstone).
    const [closed, renamed] = customerIds as [string, string];
    const runtime = createServiceRuntime({ db, logger: silentLogger });
    const owner = await resolveTenantContext(runtime, {
      userId: ownerId,
      channel: "web",
      requestId: newRequestId(),
    });
    if (!owner.ok) throw new Error(`owner context: ${owner.error.code}`);
    expect(
      (
        await setCustomerStatus.call(runtime, owner.value, {
          customerId: closed,
          status: "inactive",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await updateCustomer.call(runtime, owner.value, { customerId: renamed, name: "Naya Naam" }))
        .ok,
    ).toBe(true);
    const delta = SyncCustomersResponse.parse(
      await (
        await request.get(`${API}/sync/customers`, {
          headers: auth,
          params: { cursor: cursor ?? "" },
        })
      ).json(),
    );
    expect(delta.removed_customer_ids).toContain(closed);
    expect(delta.customers.find((c) => c.id === renamed)?.name).toBe("Naya Naam");

    // Detail.
    const detail = await request.get(`${API}/customers/${renamed}`, { headers: auth });
    expect(detail.status()).toBe(200);
    const body = CustomerDetailResponse.parse(await detail.json());
    expect(body.customer).toMatchObject({ id: renamed, name: "Naya Naam", active: true });

    // Phone correction, then the same number again.
    for (const changed of [true, false]) {
      const response = await request.patch(`${API}/customers/${renamed}/phone`, {
        headers: auth,
        data: { phone: "9123456789" },
      });
      expect(response.status()).toBe(200);
      expect(UpdatePhoneResponse.parse(await response.json())).toMatchObject({
        changed,
        customer: { id: renamed, phone: "9123456789" },
      });
    }

    // Refusals.
    const badCursor = await request.get(`${API}/sync/customers`, {
      headers: auth,
      params: { cursor: "garbage" },
    });
    expect(badCursor.status()).toBe(400);
    expect(ErrorResponse.parse(await badCursor.json()).error.code).toBe("CURSOR_INVALID");
    const missing = await request.get(`${API}/customers/${uuidv7()}`, { headers: auth });
    expect(missing.status()).toBe(404);
    expect(ErrorResponse.parse(await missing.json()).error.code).toBe("CUSTOMER_NOT_FOUND");
    const noToken = await request.get(`${API}/sync/customers`, { headers });
    expect(noToken.status()).toBe(401);
  });
});
