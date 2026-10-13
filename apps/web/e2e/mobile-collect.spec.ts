/**
 * The lineman's collect path over HTTP (T-061) against `next start` and a real, migrated database:
 * sign in → push a payment batch to the literal `/payments:batch` route (and replay it, also in
 * parallel) → the day's totals → cash handover → receipt link → receipt actions on the literal
 * `/receipts/actions:batch` route. Every body is parsed with the contract (`@cb/contracts`).
 *
 * The route handlers are tested in depth (concurrency, failures, isolation, deactivation) with an
 * injected clock in `src/app/api/mobile/v1/**\/_lib/*.test.ts`; this spec proves the routes are
 * wired as the phone calls them.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `mobile-auth.spec.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  CollectionDayResponse,
  ErrorResponse,
  HandoverResponse,
  LoginResponse,
  PaymentBatchResponse,
  ReceiptActionsResponse,
  ReceiptLinkResponse,
} from "@cb/contracts";
import { hashPassword } from "@cb/core";
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
import { businessDateOf } from "@cb/domain";
import { type APIRequestContext, expect, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e collect 6161";
const API = "/api/mobile/v1";

test.describe("mobile collect API", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");
  test.describe.configure({ mode: "serial" });

  const run = randomBytes(4).toString("hex");
  const login = `e2e-collect-${run}`;
  const ip = `203.0.113.${(Number.parseInt(run.slice(0, 2), 16) % 200) + 30}`;
  const headers = { "x-app-version-code": "5", "x-real-ip": ip };
  let db: DbClient;
  let operatorId: string;
  let customerId: string;

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
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    customerId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({
        id: operatorId,
        name: `E2E Collect Cable ${run}`,
        settings: parseOperatorSettings({ office_phone: "9800000001" }),
      });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
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
      await tx.insert(customers).values({
        id: customerId,
        operatorId,
        customerCode: `E2E-${run}`,
        name: "Ramesh Kumar",
      });
    });
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("push payments, replay them, read the day, hand over, share and log receipts", async ({
    request,
  }) => {
    const signedIn = await signIn(request);
    const auth = { ...headers, authorization: `Bearer ${signedIn.tokens.access_token}` };
    const code = signedIn.device.device_code;
    const recordedAt = new Date(Date.now() - 60_000).toISOString();
    const today = businessDateOf(new Date(recordedAt));
    const payments = [
      { amount: 50_000, method: "cash" },
      { amount: 20_000, method: "upi" },
    ].map((p, i) => ({
      id: uuidv7(),
      customer_id: customerId,
      amount_paise: p.amount,
      method: p.method,
      recorded_at: recordedAt,
      provisional_ref: `P-${code}-${String(i + 1).padStart(4, "0")}`,
      collector_id: signedIn.user.id,
      device_id: signedIn.device.id,
    }));

    // The phone's URL is literally `…/payments:batch` (Retrofit "./payments:batch").
    const push = () => request.post(`${API}/payments:batch`, { headers: auth, data: { payments } });
    const first = await push();
    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toBe("no-store");
    const posted = PaymentBatchResponse.parse(await first.json());
    expect(posted.results.map((r) => [r.id, r.outcome])).toEqual(
      payments.map((p) => [p.id, "posted"]),
    );
    expect(posted.results.map((r) => r.payment?.provisional_ref)).toEqual(
      payments.map((p) => p.provisional_ref),
    );

    // Replayed five times at once (a flaky network): duplicates with the same payments.
    const replays = await Promise.all(Array.from({ length: 5 }, push));
    for (const replay of replays) {
      expect(replay.status()).toBe(200);
      const body = PaymentBatchResponse.parse(await replay.json());
      expect(body.results.map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
      expect(body.results.map((r) => r.payment)).toEqual(posted.results.map((r) => r.payment));
    }

    const dayResponse = await request.get(`${API}/collections/${today}`, { headers: auth });
    expect(dayResponse.status()).toBe(200);
    const day = CollectionDayResponse.parse(await dayResponse.json()).session;
    expect(day).toMatchObject({
      business_date: today,
      cash_total_paise: 50_000,
      upi_total_paise: 20_000,
      payment_count: 2,
      status: "open",
    });

    const handover = await request.post(`${API}/collections/${today}/handover`, {
      headers: auth,
      data: {
        submission_id: uuidv7(),
        cash_handed_over_paise: 50_000,
        unsynced_payment_count: 0,
        unsynced_cash_paise: 0,
      },
    });
    expect(handover.status()).toBe(200);
    expect(HandoverResponse.parse(await handover.json()).session).toMatchObject({
      status: "submitted",
      handover: { cash_expected_paise: 50_000, discrepancy_paise: 0 },
    });

    const paymentId = payments[0]?.id ?? "";
    const link = await request.post(`${API}/receipts/${paymentId}/link`, { headers: auth });
    // The server's receipt origin (`baseUrls()`): RECEIPT_BASE_URL, else APP_BASE_URL, else local.
    const origin = process.env.RECEIPT_BASE_URL || process.env.APP_BASE_URL || "";
    if (origin.startsWith("https://")) {
      expect(link.status()).toBe(200);
      const body = ReceiptLinkResponse.parse(await link.json());
      expect(body.link.receipt_number).toBe(posted.results[0]?.payment?.receipt_number);
      const missing = await request.post(`${API}/receipts/${uuidv7()}/link`, { headers: auth });
      expect(missing.status()).toBe(404);
      expect(ErrorResponse.parse(await missing.json()).error.code).toBe("PAYMENT_NOT_FOUND");
    } else {
      // Locally the receipt origin is http://localhost and the contract's link is https only:
      // the server refuses before making a link (PAYMENT_NOT_FOUND is covered by the unit tests).
      expect(link.status()).toBe(500);
      expect(ErrorResponse.parse(await link.json()).error.code).toBe("INTERNAL");
    }

    const actions = [
      { id: uuidv7(), payment_id: paymentId, action: "printed", at: new Date().toISOString() },
      { id: uuidv7(), payment_id: paymentId, action: "sent", at: new Date().toISOString() },
    ];
    const logged = await request.post(`${API}/receipts/actions:batch`, {
      headers: auth,
      data: { actions },
    });
    expect(logged.status()).toBe(200);
    expect(ReceiptActionsResponse.parse(await logged.json()).results.map((r) => r.outcome)).toEqual(
      ["recorded", "rejected"],
    );

    // Without a token nothing is accepted.
    const anonymous = await request.post(`${API}/payments:batch`, { headers, data: { payments } });
    expect(anonymous.status()).toBe(401);
    expect(ErrorResponse.parse(await anonymous.json()).error.code).toBe("UNAUTHENTICATED");
  });
});
