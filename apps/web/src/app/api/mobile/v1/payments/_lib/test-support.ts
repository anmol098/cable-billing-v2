/**
 * Test support for the T-061 route-handler tests (Vitest only; never imported by app code).
 *
 * Runs the real handlers over the real stack: a migrated test database (`@cb/db/testing`), the
 * T-028 mobile auth service (real sign-in with a password, real access tokens, per-request
 * user/device/family checks), the core services and an injected clock. Requests are plain
 * `Request` objects, so what is tested is exactly what the route files export.
 */
import { randomBytes } from "node:crypto";
import {
  createMemoryRateLimiter,
  createMobileAuthService,
  hashPassword,
  type MobileAuthService,
  newRequestId,
} from "@cb/core";
import {
  captureLogs,
  type LogCapture,
  type SeededTenant,
  seedTenant,
  testRuntime,
} from "@cb/core/testing";
import { type DbClient, uuidv7 } from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import type { MobileDeps } from "@/lib/mobile/http";

export const TEST_SECRET = "t061-test-secret-not-for-production-0123456789abcdef";
export const MIN_APP_VERSION_CODE = 3;
const PASSWORD = "lineman pass 61";
let ipCounter = 0;

export interface Clock {
  now: Date;
  advance(ms: number): void;
}

export interface MobileApiHarness {
  readonly clock: Clock;
  readonly logs: LogCapture;
  readonly auth: MobileAuthService;
  /** What the route factories take (`getDeps`). */
  readonly getDeps: () => MobileDeps;
}

/**
 * A harness over `database` with a clock starting at `start`. `db` replaces the database client
 * (a bigger pool for parallel requests, or a wrapper that injects faults). Without
 * `afterResponse`, after-the-answer work (T-086a metrics) runs inline before the reply.
 */
export function mobileApiHarness(
  database: TestDatabase,
  start: Date,
  options: { db?: DbClient; afterResponse?: MobileDeps["afterResponse"] } = {},
): MobileApiHarness {
  const clock: Clock = {
    now: start,
    advance(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const logs = captureLogs();
  const runtime = testRuntime(options.db ?? database.db, { now: () => clock.now, logs });
  const auth = createMobileAuthService({
    runtime,
    secret: TEST_SECRET,
    rateLimiter: createMemoryRateLimiter({ now: () => clock.now.getTime() }),
    minAppVersionCode: MIN_APP_VERSION_CODE,
  });
  const deps: MobileDeps = {
    auth,
    runtime,
    logger: runtime.logger,
    ...(options.afterResponse ? { afterResponse: options.afterResponse } : {}),
  };
  return { clock, logs, auth, getDeps: () => deps };
}

export interface SignedInLineman {
  readonly userId: string;
  /** The device registered by this sign-in (contract `RegisteredDevice.id`). */
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly accessToken: string;
}

/** Gives `userId` a password and signs them in on a new phone through the real login. */
export async function signInLineman(
  database: TestDatabase,
  harness: MobileApiHarness,
  userId: string,
): Promise<SignedInLineman> {
  await database.admin.query(
    `INSERT INTO accounts (id, user_id, account_id, provider_id, password)
     VALUES ($1, $2::uuid, $2::text, 'credential', $3)
     ON CONFLICT (provider_id, account_id) DO UPDATE SET password = EXCLUDED.password`,
    [uuidv7(), userId, await hashPassword(PASSWORD)],
  );
  const login = (
    await database.admin.query<{ login: string }>("SELECT login FROM users WHERE id = $1", [userId])
  ).rows[0]?.login;
  if (!login) throw new Error("signInLineman: unknown user");
  const result = await harness.auth.login(
    {
      login,
      password: PASSWORD,
      device: {
        installId: uuidv7(),
        model: "Xiaomi Redmi 9A",
        os: "Android 13 (API 33)",
        appVersion: "1.0.3",
        appVersionCode: 5,
      },
    },
    {
      headers: new Headers({ "x-real-ip": nextIp(), "x-app-version-code": "5" }),
      requestId: newRequestId(),
    },
  );
  if (!result.ok) throw new Error(`signInLineman: ${result.error.code}`);
  return {
    userId,
    deviceId: result.value.device.id,
    deviceCode: result.value.device.deviceCode,
    accessToken: result.value.tokens.accessToken,
  };
}

export interface TenantWithLineman {
  readonly tenant: SeededTenant;
  readonly lineman: SignedInLineman;
}

/** A seeded tenant (owner, staff, lineman) with its lineman signed in on a phone. */
export async function tenantWithLineman(
  database: TestDatabase,
  harness: MobileApiHarness,
  options: { subscription?: "active" | "read_only" } = {},
): Promise<TenantWithLineman> {
  const tenant = await seedTenant(database, { subscription: options.subscription ?? "active" });
  return { tenant, lineman: await signInLineman(database, harness, tenant.users.lineman) };
}

function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly token?: string | null;
  /** A value is sent as JSON; a string as is. */
  readonly body?: unknown;
  /** `null`: no `x-app-version-code` header. Default "5". */
  readonly version?: string | null;
}

/** A request to `/api/mobile/v1<path>` as the phone sends it. */
export function mobileRequest(path: string, options: RequestOptions = {}): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "okhttp/5.1.0",
    "x-real-ip": nextIp(),
  });
  const version = options.version === undefined ? "5" : options.version;
  if (version !== null) headers.set("x-app-version-code", version);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  return new Request(`http://localhost/api/mobile/v1${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

/** The second argument Next passes to a dynamic route handler. */
export function routeParams<P>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

/** Inserts an active (or inactive) customer of the tenant; returns its id. */
export async function insertCustomer(
  database: TestDatabase,
  operatorId: string,
  options: { status?: "active" | "inactive"; name?: string } = {},
): Promise<string> {
  const id = uuidv7();
  await database.admin.query(
    `INSERT INTO customers (id, operator_id, customer_code, name, status) VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      operatorId,
      `C-${randomBytes(4).toString("hex")}`,
      options.name ?? "Ramesh Kumar",
      options.status ?? "active",
    ],
  );
  return id;
}

/**
 * Issues a regular bill of `chargesPaise` for `period` the way the billing run posts one (invoice,
 * ledger entry, balance), for a customer with no earlier money rows. Returns the invoice id.
 */
export async function issueBill(
  database: TestDatabase,
  operatorId: string,
  customerId: string,
  period: string,
  chargesPaise: number,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const invoiceId = uuidv7();
  const invoiceNumber = `INV-${period.slice(2, 4)}${period.slice(5, 7)}-${randomBytes(3).toString("hex")}`;
  const before = (
    await database.admin.query<{ balance: string }>(
      "SELECT balance_paise AS balance FROM customer_balances WHERE customer_id = $1",
      [customerId],
    )
  ).rows[0];
  const opening = Number(before?.balance ?? 0);
  await database.admin.query(
    `INSERT INTO invoices (id, operator_id, customer_id, period, invoice_number, opening_balance_paise, charges_paise, total_due_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      invoiceId,
      operatorId,
      customerId,
      period,
      invoiceNumber,
      opening,
      chargesPaise,
      opening + chargesPaise,
    ],
  );
  await database.admin.query(
    `INSERT INTO ledger_entries (id, operator_id, customer_id, type, amount_paise, invoice_id)
     VALUES ($1, $2, $3, 'invoice', $4, $5)`,
    [uuidv7(), operatorId, customerId, chargesPaise, invoiceId],
  );
  await database.admin.query(
    `INSERT INTO customer_balances (customer_id, operator_id, balance_paise, oldest_due_period)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (customer_id) DO UPDATE
       SET balance_paise = customer_balances.balance_paise + $3,
           oldest_due_period = LEAST(customer_balances.oldest_due_period, $4::date)`,
    [customerId, operatorId, chargesPaise, period],
  );
  return { invoiceId, invoiceNumber };
}

const MONEY_TABLES = [
  "payments",
  "receipts",
  "ledger_entries",
  "allocations",
  "collection_sessions",
  "receipt_actions",
  "receipt_links",
  "handover_events",
] as const;

/** Row counts of everything a payment writes, for "nothing doubled / nothing written" checks. */
export async function moneyRowCounts(
  database: TestDatabase,
  operatorId: string,
): Promise<Record<(typeof MONEY_TABLES)[number], number>> {
  const counts = {} as Record<(typeof MONEY_TABLES)[number], number>;
  for (const table of MONEY_TABLES) {
    const { rows } = await database.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE operator_id = $1`,
      [operatorId],
    );
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

/** A payment item as the T-066 phone sends it. */
export function paymentItem(
  lineman: SignedInLineman,
  customerId: string,
  overrides: Record<string, unknown> = {},
  sequence = 1,
): Record<string, unknown> {
  return {
    id: uuidv7(),
    customer_id: customerId,
    amount_paise: 50_000,
    method: "cash",
    recorded_at: "2026-10-13T05:15:00.000Z",
    provisional_ref: `P-${lineman.deviceCode}-${String(sequence).padStart(4, "0")}`,
    collector_id: lineman.userId,
    device_id: lineman.deviceId,
    ...overrides,
  };
}
