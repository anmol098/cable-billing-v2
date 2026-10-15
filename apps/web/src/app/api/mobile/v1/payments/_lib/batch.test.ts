// @vitest-environment node
/**
 * `POST /api/mobile/v1/payments:batch` (T-061) against a real database, the real T-028 auth and
 * T-046 `postPayment`, with an injected clock. Every 200 body is parsed with the contract's
 * `PaymentBatchResponse` (and every error with `ErrorResponse`).
 *
 * Covered: the posted payment's shape (allocations, credit, snapshots, review reason, echoed id and
 * provisional ref), results in request order, a malformed item never sinking the batch, the same
 * batch replayed 10× concurrently (identical results, nothing doubled), a timeout followed by a
 * retry, transient per-item failures (`retry_later`) and the retry that posts them once, the time
 * budget, read-only tenants (D-13), the version gate and auth failures (nothing written), a
 * deactivated lineman's queue, held payments of another lineman, and tenant isolation.
 */
import { readFileSync } from "node:fs";
import {
  ErrorResponse,
  PAYMENT_BATCH_MAX,
  PaymentBatchRequest,
  PaymentBatchResponse,
} from "@cb/contracts";
import { revokeDevice, revokeMobileRefreshTokens } from "@cb/core";
import { contextFor, setSubscriptionStatus } from "@cb/core/testing";
import {
  createDb,
  type DbClient,
  PAYMENT_SYNC_BATCH_MAX,
  PAYMENT_SYNC_REJECT_CODES,
  PAYMENT_SYNC_RETRY_CODES,
  uuidv7,
} from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { paymentBatchHandler, syncMetricItem } from "./batch";
import {
  insertCustomer,
  issueBill,
  type MobileApiHarness,
  mobileApiHarness,
  mobileRequest,
  moneyRowCounts,
  paymentItem,
  signInLineman,
  tenantWithLineman,
} from "./test-support";
import { UNUSABLE_ITEM_ID } from "./wire-errors";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const NOW = new Date("2026-10-13T06:00:00.000Z");
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../../../../../../packages/contracts/fixtures/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );

type BatchResponse = ReturnType<typeof PaymentBatchResponse.parse>;

describeDb("POST /payments:batch (T-061)", () => {
  const t = useTestDatabase();
  let h: MobileApiHarness;
  let POST: (request: Request) => Promise<Response>;

  beforeAll(() => {
    h = mobileApiHarness(t.current, NOW);
    POST = paymentBatchHandler(h.getDeps);
  });

  async function send(token: string | null, body: unknown, handler = POST) {
    return handler(mobileRequest("/payments:batch", { token, body }));
  }

  /** A 200 parsed with the contract (and the results matched to the request by position). */
  async function ok(response: Response, sent?: readonly { id?: unknown }[]) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = PaymentBatchResponse.parse(await response.json());
    if (sent) {
      expect(body.results.map((r) => r.id)).toEqual(
        sent.map((s) => (typeof s.id === "string" ? s.id.toLowerCase() : UNUSABLE_ITEM_ID)),
      );
    }
    return body;
  }

  /** Another active lineman in the tenant; returns the user id. */
  async function addLineman(operatorId: string): Promise<string> {
    const { rows } = await t.current.admin.query<{ id: string }>(
      `INSERT INTO users (id, operator_id, role, name, login, language)
       VALUES ($1, $2, 'lineman', 'Suresh', $3, 'hi') RETURNING id`,
      [uuidv7(), operatorId, `suresh-${uuidv7().slice(-8)}`],
    );
    return rows[0]?.id ?? "";
  }

  async function failure(response: Response, status: number) {
    expect(response.status).toBe(status);
    return ErrorResponse.parse(await response.json()).error;
  }

  /** Runs one query as the platform role (`app_platform`, what `withPlatform` uses). */
  async function asPlatform(text: string, values: unknown[] = []) {
    const client = await t.current.admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_platform");
      return (await client.query(text, values)).rows;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  /** The tenant's summed sync counters, read on the platform path (counts only). */
  async function platformCounters(operatorId: string) {
    const rows = await asPlatform(
      `SELECT count(*)::int AS batches, coalesce(sum(items), 0)::int AS items,
              coalesce(sum(posted + posted_needs_review), 0)::int AS accepted,
              coalesce(sum(duplicate), 0)::int AS duplicate,
              coalesce(sum(rejected_validation), 0)::int AS rejected_validation,
              coalesce(sum(rejected_customer_not_found), 0)::int AS rejected_customer_not_found,
              coalesce(sum(rejected_id_reused), 0)::int AS rejected_id_reused,
              coalesce(sum(rejected_without_id), 0)::int AS rejected_without_id,
              coalesce(sum(rejected_new_ids), 0)::int AS rejected_new_ids,
              coalesce(sum(accepted_after_rejection), 0)::int AS accepted_after_rejection,
              coalesce(sum(retry_later_conflict + retry_later_internal
                           + retry_later_rate_limited), 0)::int AS retry_later
         FROM payment_sync_batches WHERE operator_id = $1`,
      [operatorId],
    );
    return rows[0];
  }

  it("posts each payment and answers the posted payment the phone prints", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const op = tenant.operatorId;
    const ramesh = await insertCustomer(t.current, op);
    const sep = await issueBill(t.current, op, ramesh, "2026-09-01", 45_000);
    const oct = await issueBill(t.current, op, ramesh, "2026-10-01", 45_000);
    const suresh = await insertCustomer(t.current, op, { name: "Suresh" });
    const gone = await insertCustomer(t.current, op, { status: "inactive" });

    const items = [
      paymentItem(lineman, ramesh, { amount_paise: 50_000 }, 1),
      paymentItem(
        lineman,
        suresh,
        { amount_paise: 30_000, method: "upi", upi_reference: "4321", notes: "paid on phone" },
        2,
      ),
      paymentItem(lineman, gone, { amount_paise: 20_000 }, 3),
    ];
    expect(PaymentBatchRequest.safeParse({ payments: items }).success).toBe(true);
    const body = await ok(await send(lineman.accessToken, { payments: items }), items);

    const [first, second, third] = body.results;
    expect(first).toEqual({
      id: items[0]?.id,
      outcome: "posted",
      payment: {
        id: items[0]?.id,
        customer_id: ramesh,
        amount_paise: 50_000,
        method: "cash",
        receipt_number: "R-2610-00001",
        provisional_ref: items[0]?.provisional_ref,
        recorded_at: "2026-10-13T05:15:00.000Z",
        posted_at: NOW.toISOString(),
        business_date: "2026-10-13",
        allocations: [
          {
            invoice_id: sep.invoiceId,
            invoice_number: sep.invoiceNumber,
            kind: "regular",
            period: "2026-09-01",
            amount_paise: 45_000,
            outstanding_after_paise: 0,
          },
          {
            invoice_id: oct.invoiceId,
            invoice_number: oct.invoiceNumber,
            kind: "regular",
            period: "2026-10-01",
            amount_paise: 5_000,
            outstanding_after_paise: 40_000,
          },
        ],
        credit_added_paise: 0,
        balance_after_paise: 40_000,
        credit_after_paise: 0,
      },
      review_reason: null,
      error: null,
    });
    expect(second).toMatchObject({
      outcome: "posted",
      review_reason: null,
      payment: {
        method: "upi",
        receipt_number: "R-2610-00002",
        allocations: [],
        credit_added_paise: 30_000,
        balance_after_paise: -30_000,
        credit_after_paise: 30_000,
      },
    });
    expect(third).toMatchObject({
      outcome: "posted_needs_review",
      review_reason: "customer_inactive",
      payment: { receipt_number: "R-2610-00003", provisional_ref: items[2]?.provisional_ref },
    });

    // Stored once each, with the token's identity; the session counts the cash only.
    const stored = await t.current.admin.query<{
      id: string;
      collector_id: string;
      device_id: string;
      source: string;
    }>("SELECT id, collector_id, device_id, source FROM payments WHERE operator_id = $1", [op]);
    expect(stored.rows).toHaveLength(3);
    for (const row of stored.rows) {
      expect(row).toMatchObject({
        collector_id: lineman.userId,
        device_id: lineman.deviceId,
        source: "android",
      });
    }
    const session = await t.current.admin.query<{ cash: string; upi: string; n: number }>(
      `SELECT cash_expected_paise AS cash, upi_total_paise AS upi, payment_count AS n
         FROM collection_sessions WHERE operator_id = $1`,
      [op],
    );
    expect(session.rows[0]).toMatchObject({ cash: "70000", upi: "30000", n: 3 });

    // One summary line per batch, counts only.
    const summary = h.logs.records.findLast((r) => r.event === "mobile_api.payment_batch");
    expect(summary).toMatchObject({ items: 3, posted: 2, posted_needs_review: 1, rejected: 0 });
  }, 60_000);

  it("answers the contract fixture's batch with the fixture's shape", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const request = fixture("postPaymentBatch.request");
    const expected = PaymentBatchResponse.parse(fixture("postPaymentBatch.response"));
    const customers = new Map<string, string>();
    const payments = [];
    for (const item of request.payments as Record<string, unknown>[]) {
      const from = String(item.customer_id);
      if (!customers.has(from))
        customers.set(from, await insertCustomer(t.current, tenant.operatorId));
      payments.push({
        ...item,
        id: uuidv7(),
        customer_id: customers.get(from),
        collector_id: lineman.userId,
        device_id: lineman.deviceId,
      });
    }
    const body = await ok(await send(lineman.accessToken, { payments }), payments);
    for (const result of body.results) {
      expect(result.outcome).toBe("posted");
      expect(Object.keys(result).sort()).toEqual(Object.keys(expected.results[0] ?? {}).sort());
      expect(Object.keys(result.payment ?? {}).sort()).toEqual(
        Object.keys(expected.results[0]?.payment ?? {}).sort(),
      );
    }
  }, 60_000);

  it("rejects bad items one by one and posts the rest (a malformed item never sinks the batch)", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const other = await tenantWithLineman(t.current, h);
    const op = tenant.operatorId;
    const customer = await insertCustomer(t.current, op);
    const theirs = await insertCustomer(t.current, other.tenant.operatorId);

    const earlier = paymentItem(lineman, customer, { amount_paise: 10_000 }, 1);
    await ok(await send(lineman.accessToken, { payments: [earlier] }));
    const before = await moneyRowCounts(t.current, op);

    const { id: _dropped, ...withoutId } = paymentItem(lineman, customer, {}, 9);
    const items: Record<string, unknown>[] = [
      paymentItem(lineman, customer, { amount_paise: 20_000 }, 2), // fine
      paymentItem(lineman, customer, { amount_paise: 12.5 }, 3), // fractional paise
      paymentItem(lineman, customer, { upi_reference: "99" }, 4), // UPI ref on cash
      withoutId, // no id: answered with the unusable id
      paymentItem(lineman, uuidv7(), {}, 5), // unknown customer
      paymentItem(lineman, theirs, {}, 6), // another tenant's customer
      { ...earlier, amount_paise: 25_000 }, // id reused with other data
      { ...earlier }, // the same payment again
      paymentItem(lineman, customer, { recorded_at: "2026-10-13T11:00:00+05:30" }, 7), // offset
      paymentItem(lineman, customer, { amount_paise: 30_000 }, 8), // fine
    ];
    const body = await ok(await send(lineman.accessToken, { payments: items }), items);
    expect(body.results.map((r) => r.outcome)).toEqual([
      "posted",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "duplicate",
      "rejected",
      "posted",
    ]);
    const errors = body.results.map((r) => r.error);
    expect(errors[1]).toMatchObject({
      code: "VALIDATION",
      fields: [{ path: "payments.1.amount_paise" }],
    });
    expect(errors[2]).toMatchObject({
      code: "VALIDATION",
      fields: [{ path: "payments.2.upi_reference" }],
    });
    expect(errors[3]?.code).toBe("VALIDATION");
    expect(body.results[3]?.id).toBe(UNUSABLE_ITEM_ID);
    expect(errors[4]?.code).toBe("CUSTOMER_NOT_FOUND");
    expect(errors[5]?.code).toBe("CUSTOMER_NOT_FOUND");
    expect(errors[6]).toEqual({
      code: "ID_REUSED_WITH_DIFFERENT_DATA",
      message: "payment id already used with different data (amount_paise)",
    });
    expect(errors[8]).toMatchObject({
      code: "VALIDATION",
      fields: [{ path: "payments.8.recorded_at" }],
    });
    // Rejected items never carry a payment, and none of them was written anywhere.
    for (const r of body.results.filter((x) => x.outcome === "rejected")) {
      expect(r.payment).toBeNull();
    }
    const after = await moneyRowCounts(t.current, op);
    expect(after.payments - before.payments).toBe(2);
    expect(after.receipts - before.receipts).toBe(2);
    expect((await moneyRowCounts(t.current, other.tenant.operatorId)).payments).toBe(0);
    // No customer id or other value of another tenant in the answer.
    expect(JSON.stringify(body)).not.toContain(theirs);
  }, 60_000);

  it("refuses an item whose id is UUID-shaped but not an RFC UUID on its own; the rest post and the answer is 200", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const op = tenant.operatorId;
    const customer = await insertCustomer(t.current, op);
    // Hex in UUID shape, but the version (0) and variant (0) digits are not RFC 9562.
    const notRfc = "12345678-1234-0234-0234-123456789abc";
    const items: Record<string, unknown>[] = [
      paymentItem(lineman, customer, { amount_paise: 20_000 }, 1),
      { ...paymentItem(lineman, customer, { amount_paise: 15_000 }, 2), id: notRfc },
      { ...paymentItem(lineman, customer, { amount_paise: 5_000 }, 3), id: notRfc.toUpperCase() },
      paymentItem(lineman, customer, { amount_paise: 30_000 }, 4),
    ];
    const body = await ok(await send(lineman.accessToken, { payments: items }));
    expect(body.results.map((r) => r.outcome)).toEqual([
      "posted",
      "rejected",
      "rejected",
      "posted",
    ]);
    // The refused items carry the unusable id (the contract can't echo theirs) and say why.
    expect(body.results.map((r) => r.id)).toEqual([
      items[0]?.id,
      UNUSABLE_ITEM_ID,
      UNUSABLE_ITEM_ID,
      items[3]?.id,
    ]);
    expect(body.results[1]?.error).toMatchObject({
      code: "VALIDATION",
      fields: [{ path: "payments.1.id" }],
    });
    expect(body.results[2]?.error).toMatchObject({
      code: "VALIDATION",
      fields: [{ path: "payments.2.id" }],
    });
    // Only the two valid payments were written.
    const counts = await moneyRowCounts(t.current, op);
    expect(counts.payments).toBe(2);
    expect(counts.receipts).toBe(2);

    // The phone sends the queue again: the valid payments are duplicates, nothing new is written.
    const replay = await ok(await send(lineman.accessToken, { payments: items }));
    expect(replay.results.map((r) => r.outcome)).toEqual([
      "duplicate",
      "rejected",
      "rejected",
      "duplicate",
    ]);
    expect((await moneyRowCounts(t.current, op)).payments).toBe(2);
  }, 60_000);

  it("answers the time budget's retry_later with the unusable id for a non-RFC item id", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const customer = await insertCustomer(t.current, tenant.operatorId);
    const items = [
      paymentItem(lineman, customer, {}, 1),
      { ...paymentItem(lineman, customer, {}, 2), id: "12345678-1234-0234-0234-123456789abc" },
    ];
    const noBudget = paymentBatchHandler(h.getDeps, { timeBudgetMs: 0 });
    const body = await ok(await send(lineman.accessToken, { payments: items }, noBudget));
    expect(body.results.map((r) => [r.id, r.outcome, r.error?.code])).toEqual([
      [items[0]?.id, "retry_later", "RATE_LIMITED"],
      [UNUSABLE_ITEM_ID, "retry_later", "RATE_LIMITED"],
    ]);
    expect((await moneyRowCounts(t.current, tenant.operatorId)).payments).toBe(0);
  }, 60_000);

  it("refuses a whole request that isn't a batch (400 VALIDATION, nothing written)", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const customer = await insertCustomer(t.current, tenant.operatorId);
    const many = Array.from({ length: PAYMENT_BATCH_MAX + 1 }, (_, i) =>
      paymentItem(lineman, customer, {}, i + 1),
    );
    for (const body of [{ payments: [] }, { payments: many }, { items: [] }, "not json", []]) {
      const error = await failure(await send(lineman.accessToken, body), 400);
      expect(error.code).toBe("VALIDATION");
    }
    expect((await moneyRowCounts(t.current, tenant.operatorId)).payments).toBe(0);
    // Exactly 50 is fine.
    const fifty = many.slice(0, PAYMENT_BATCH_MAX);
    const body = await ok(await send(lineman.accessToken, { payments: fifty }), fifty);
    expect(body.results.every((r) => r.outcome === "posted")).toBe(true);
  }, 120_000);

  describe("idempotency", () => {
    let pool: DbClient;
    beforeAll(() => {
      pool = createDb({
        connectionString: t.current.url,
        driver: "pg",
        max: 16,
        onIdleError: () => {},
      });
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("the same batch sent 10× at once: identical results, every payment posted exactly once", async () => {
      const parallel = mobileApiHarness(t.current, NOW, { db: pool });
      const handler = paymentBatchHandler(parallel.getDeps);
      const { tenant, lineman } = await tenantWithLineman(t.current, parallel);
      const op = tenant.operatorId;
      const a = await insertCustomer(t.current, op);
      const b = await insertCustomer(t.current, op);
      await issueBill(t.current, op, a, "2026-09-01", 45_000);
      await issueBill(t.current, op, a, "2026-10-01", 45_000);
      // Several payments of one customer (serialised by its balance lock) and of another.
      const items = [
        paymentItem(lineman, a, { amount_paise: 30_000 }, 1),
        paymentItem(lineman, b, { amount_paise: 20_000, method: "upi" }, 2),
        paymentItem(lineman, a, { amount_paise: 40_000 }, 3),
        paymentItem(lineman, a, { amount_paise: 50_000 }, 4),
        paymentItem(lineman, b, { amount_paise: 10_000 }, 5),
      ];
      const counter = async () =>
        Number(
          (
            await t.current.admin.query<{ v: string }>(
              "SELECT coalesce(sum(next_value - 1), 0) AS v FROM counters WHERE operator_id = $1 AND name = 'receipt'",
              [op],
            )
          ).rows[0]?.v ?? 0,
        );
      const counterBefore = await counter();

      // A real race, not a matter of timing: an admin connection holds customer a's balance
      // row lock until all ten requests are blocked on it (each at its first item), then lets
      // them all go at once.
      const holder = await t.current.admin.connect();
      let bodies: BatchResponse[];
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM customer_balances WHERE customer_id = $1 FOR UPDATE", [
          a,
        ]);
        const pending = Promise.all(
          Array.from({ length: 10 }, async () =>
            ok(await send(lineman.accessToken, { payments: items }, handler), items),
          ),
        );
        const deadline = Date.now() + 30_000;
        for (;;) {
          const { rows } = await t.current.admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          if ((rows[0]?.n ?? 0) >= 10) break;
          if (Date.now() > deadline) throw new Error("the requests never blocked on the lock");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await holder.query("COMMIT");
        bodies = await pending;
      } finally {
        holder.release();
      }

      // Per item: exactly one request posted it, the other nine got `duplicate`, and every
      // request got the very same payment (receipt number, snapshots, allocations).
      items.forEach((item, i) => {
        const results = bodies.map((body) => body.results[i]);
        const outcomes = results.map((r) => r?.outcome);
        expect(
          outcomes.filter((o) => o === "posted"),
          String(item.id),
        ).toHaveLength(1);
        expect(
          outcomes.filter((o) => o === "duplicate"),
          String(item.id),
        ).toHaveLength(9);
        for (const r of results) expect(r?.payment).toEqual(results[0]?.payment);
      });
      const receiptNumbers = bodies[0]?.results.map((r) => r.payment?.receipt_number).sort();
      expect(receiptNumbers).toEqual([
        "R-2610-00001",
        "R-2610-00002",
        "R-2610-00003",
        "R-2610-00004",
        "R-2610-00005",
      ]);
      // Customer a's snapshots are a strict sequence: no lost update.
      const aBalances = bodies[0]?.results
        .filter((r) => r.payment?.customer_id === a)
        .map((r) => r.payment?.balance_after_paise)
        .sort((x, y) => (y ?? 0) - (x ?? 0));
      expect(aBalances).toEqual([60_000, 20_000, -30_000]);

      const counts = await moneyRowCounts(t.current, op);
      expect(counts).toMatchObject({ payments: 5, receipts: 5, collection_sessions: 1 });
      expect(counts.ledger_entries).toBe(2 + 5); // two bills + five payments
      expect((await counter()) - counterBefore).toBe(5);

      // Sent again 10× one after another: all duplicates, byte-identical results every time.
      const replays: BatchResponse[] = [];
      for (let i = 0; i < 10; i += 1) {
        replays.push(
          await ok(await send(lineman.accessToken, { payments: items }, handler), items),
        );
      }
      for (const replay of replays) {
        expect(replay.results.every((r) => r.outcome === "duplicate")).toBe(true);
        expect(JSON.stringify(replay.results)).toBe(JSON.stringify(replays[0]?.results));
        expect(replay.results.map((r) => r.payment)).toEqual(
          bodies[0]?.results.map((r) => r.payment),
        );
      }
      expect(await moneyRowCounts(t.current, op)).toEqual(counts);

      // T-086a: 20 batches of 5 counted once each; each payment accepted once, the other 9 + 10
      // sends of it are duplicates. No double counting under concurrent replays.
      expect(await platformCounters(op)).toMatchObject({
        batches: 20,
        items: 100,
        accepted: 5,
        duplicate: 95,
        rejected_new_ids: 0,
        retry_later: 0,
      });
    }, 120_000);

    it("a timeout after the office saved the batch: the retry gets the same payments, nothing doubles", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const op = tenant.operatorId;
      const customer = await insertCustomer(t.current, op);
      await issueBill(t.current, op, customer, "2026-10-01", 45_000);
      const items = [
        paymentItem(lineman, customer, { amount_paise: 20_000 }, 1),
        paymentItem(lineman, customer, { amount_paise: 30_000 }, 2),
      ];

      // The phone's request reaches the office and commits; the answer is lost (timeout).
      const lost = await ok(await send(lineman.accessToken, { payments: items }), items);
      const counts = await moneyRowCounts(t.current, op);

      // Two minutes later the phone sends the identical batch again.
      h.clock.advance(2 * 60_000);
      const retry = await ok(await send(lineman.accessToken, { payments: items }), items);
      expect(retry.results.map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
      expect(retry.results.map((r) => r.payment)).toEqual(lost.results.map((r) => r.payment));
      expect(retry.results[0]?.payment?.posted_at).toBe(NOW.toISOString());

      // Even after a later bill, a replay still answers the snapshots taken at posting.
      await issueBill(t.current, op, customer, "2026-11-01", 45_000);
      const later = await ok(await send(lineman.accessToken, { payments: items }), items);
      expect(later.results.map((r) => r.payment)).toEqual(lost.results.map((r) => r.payment));
      expect(later.results[1]?.payment?.balance_after_paise).toBe(-5_000);

      const after = await moneyRowCounts(t.current, op);
      expect(after.payments).toBe(counts.payments);
      expect(after.receipts).toBe(counts.receipts);
    }, 60_000);

    it("a temporary failure on one item is retry_later; the retry posts it once", async () => {
      // A database client that fails the 2nd and 3rd payment transactions once each.
      let writes = 0;
      const failOn = new Map<number, Error>([
        [2, Object.assign(new Error("could not serialize access"), { code: "40001" })],
        [3, new Error("connection reset")],
      ]);
      const flaky: DbClient = {
        ...t.current.db,
        withTenant: (operatorId, fn, options) => {
          if (options?.accessMode !== "read only") {
            writes += 1;
            const fault = failOn.get(writes);
            if (fault) return Promise.reject(fault);
          }
          return t.current.db.withTenant(operatorId, fn, options);
        },
      };
      const faulty = mobileApiHarness(t.current, NOW, { db: flaky });
      const handler = paymentBatchHandler(faulty.getDeps);
      const { tenant, lineman } = await tenantWithLineman(t.current, faulty);
      writes = 0;
      const customer = await insertCustomer(t.current, tenant.operatorId);
      const items = [1, 2, 3, 4].map((n) =>
        paymentItem(lineman, customer, { amount_paise: n * 10_000 }, n),
      );

      const first = await ok(await send(lineman.accessToken, { payments: items }, handler), items);
      expect(first.results.map((r) => r.outcome)).toEqual([
        "posted",
        "retry_later",
        "retry_later",
        "posted",
      ]);
      expect(first.results[1]).toMatchObject({ payment: null, error: { code: "CONFLICT" } });
      expect(first.results[2]).toMatchObject({ payment: null, error: { code: "INTERNAL" } });
      expect((await moneyRowCounts(t.current, tenant.operatorId)).payments).toBe(2);

      const retry = await ok(await send(lineman.accessToken, { payments: items }, handler), items);
      expect(retry.results.map((r) => r.outcome)).toEqual([
        "duplicate",
        "posted",
        "posted",
        "duplicate",
      ]);
      expect((await moneyRowCounts(t.current, tenant.operatorId)).payments).toBe(4);
    }, 60_000);

    it("stops starting items when the time budget is used up; the rest go next time", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const customer = await insertCustomer(t.current, tenant.operatorId);
      const items = [1, 2, 3, 4, 5, 6].map((n) => paymentItem(lineman, customer, {}, n));
      // A clock that moves one second every time anything reads it.
      const slow = paymentBatchHandler(
        () => {
          const deps = h.getDeps();
          return {
            ...deps,
            runtime: {
              ...deps.runtime,
              now: () => {
                h.clock.advance(1_000);
                return h.clock.now;
              },
            },
          };
        },
        { timeBudgetMs: 4_000 },
      );
      const first = await ok(await send(lineman.accessToken, { payments: items }, slow), items);
      const outcomes = first.results.map((r) => r.outcome);
      const posted = outcomes.filter((o) => o === "posted").length;
      expect(posted).toBeGreaterThan(0);
      expect(posted).toBeLessThan(items.length);
      expect(outcomes).toEqual([
        ...Array(posted).fill("posted"),
        ...Array(items.length - posted).fill("retry_later"),
      ]);
      expect(first.results.at(-1)?.error?.code).toBe("RATE_LIMITED");

      const rest = await ok(await send(lineman.accessToken, { payments: items }), items);
      expect(rest.results.map((r) => r.outcome)).toEqual([
        ...Array(posted).fill("duplicate"),
        ...Array(items.length - posted).fill("posted"),
      ]);
      expect((await moneyRowCounts(t.current, tenant.operatorId)).payments).toBe(items.length);
    }, 60_000);
  });

  it("accepts payments in a read-only tenant (D-13)", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h, {
      subscription: "read_only",
    });
    const customer = await insertCustomer(t.current, tenant.operatorId);
    const items = [paymentItem(lineman, customer)];
    const body = await ok(await send(lineman.accessToken, { payments: items }), items);
    expect(body.results[0]?.outcome).toBe("posted");
    await setSubscriptionStatus(t.current, tenant.operatorId, "cancelled");
    const more = [paymentItem(lineman, customer, {}, 2)];
    expect(
      (await ok(await send(lineman.accessToken, { payments: more }), more)).results[0]?.outcome,
    ).toBe("posted");
  }, 60_000);

  it("refuses the whole request on the version gate and on every auth failure, writing nothing", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const op = tenant.operatorId;
    const customer = await insertCustomer(t.current, op);
    const body = { payments: [paymentItem(lineman, customer)] };
    const call = (options: Parameters<typeof mobileRequest>[1]) =>
      POST(mobileRequest("/payments:batch", { body, ...options }));

    expect((await failure(await call({ token: null }), 401)).code).toBe("UNAUTHENTICATED");
    expect(
      (await failure(await call({ token: lineman.accessToken, version: null }), 400)).code,
    ).toBe("VALIDATION");
    const old = await failure(await call({ token: lineman.accessToken, version: "2" }), 426);
    expect(old).toMatchObject({ code: "APP_TOO_OLD", min_app_version_code: 3 });
    const [head, payload, signature] = lineman.accessToken.split(".");
    const forged = `${head}.${payload}.${(signature ?? "").split("").reverse().join("")}`;
    expect((await failure(await call({ token: forged }), 401)).code).toBe("UNAUTHENTICATED");
    // Expired: 15 minutes later.
    h.clock.advance(15 * 60_000);
    expect((await failure(await call({ token: lineman.accessToken }), 401)).code).toBe(
      "UNAUTHENTICATED",
    );
    h.clock.advance(-15 * 60_000);
    expect((await moneyRowCounts(t.current, op)).payments).toBe(0);

    // "Sign out this phone" by the owner: the phone's token is dead at once.
    const ownerCtx = await contextFor(h.getDeps().runtime, tenant, "owner");
    const revoked = await revokeDevice.call(h.getDeps().runtime, ownerCtx, {
      deviceId: lineman.deviceId,
    });
    expect(revoked.ok).toBe(true);
    expect((await failure(await call({ token: lineman.accessToken }), 401)).code).toBe(
      "DEVICE_REVOKED",
    );
    expect((await moneyRowCounts(t.current, op)).payments).toBe(0);
  }, 60_000);

  describe("a deactivated lineman's queue (T-032 contract)", () => {
    it("their own token posts nothing; another lineman's sign-in posts it for review; replays stay identical", async () => {
      const { tenant, lineman: ravi } = await tenantWithLineman(t.current, h);
      const op = tenant.operatorId;
      const customer = await insertCustomer(t.current, op);
      const queued = [
        paymentItem(ravi, customer, { amount_paise: 20_000 }, 1),
        paymentItem(ravi, customer, { amount_paise: 15_000, method: "upi" }, 2),
      ];

      // The owner deactivates Ravi (T-032: status + revoke his phone's sign-ins in one go). His
      // still-unexpired access token is refused on the very next request: nothing is posted, the
      // payments stay on the phone.
      await t.current.admin.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
        ravi.userId,
      ]);
      expect((await failure(await send(ravi.accessToken, { payments: queued }), 403)).code).toBe(
        "ACCOUNT_DISABLED",
      );
      await t.current.db.withTenant(op, (tx) =>
        revokeMobileRefreshTokens(tx, { userId: ravi.userId, reason: "user_disabled", now: NOW }),
      );
      expect((await failure(await send(ravi.accessToken, { payments: queued }), 403)).code).toBe(
        "ACCOUNT_DISABLED",
      );
      expect((await moneyRowCounts(t.current, op)).payments).toBe(0);

      // Another (active) lineman of the tenant signs in and sends Ravi's queue as it was saved
      // (Ravi's collector_id and device_id): posted, flagged for the office.
      const suresh = await signInLineman(t.current, h, await addLineman(op));
      const sent = await ok(await send(suresh.accessToken, { payments: queued }), queued);
      expect(sent.results.map((r) => [r.outcome, r.review_reason])).toEqual([
        ["posted_needs_review", "collector_inactive"],
        ["posted_needs_review", "collector_inactive"],
      ]);
      const rows = await t.current.admin.query<{
        collector_id: string;
        review_status: string;
        review_reason: string;
      }>("SELECT collector_id, review_status, review_reason FROM payments WHERE operator_id = $1", [
        op,
      ]);
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        // Attributed to the signed-in sender (T-046 decision 2); the review flag tells the office.
        expect(row).toMatchObject({
          collector_id: suresh.userId,
          review_reason: "collector_inactive",
        });
      }

      // Ravi is switched back on and signs in again: his phone resends the same queue → duplicates
      // with the very same payments (the claimed collector is not part of idempotency).
      await t.current.admin.query("UPDATE users SET status = 'active' WHERE id = $1", [
        ravi.userId,
      ]);
      const raviAgain = await signInLineman(t.current, h, ravi.userId);
      const replay = await ok(await send(raviAgain.accessToken, { payments: queued }), queued);
      expect(replay.results.map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
      expect(replay.results.map((r) => r.payment)).toEqual(sent.results.map((r) => r.payment));
      expect((await moneyRowCounts(t.current, op)).payments).toBe(2);
    }, 60_000);

    it("an active lineman's held payments sent under another sign-in are flagged collector_mismatch", async () => {
      const { tenant, lineman: ravi } = await tenantWithLineman(t.current, h);
      const customer = await insertCustomer(t.current, tenant.operatorId);
      const suresh = await signInLineman(t.current, h, await addLineman(tenant.operatorId));
      const held = [paymentItem(ravi, customer)];
      const body = await ok(await send(suresh.accessToken, { payments: held }), held);
      expect(body.results[0]).toMatchObject({
        outcome: "posted_needs_review",
        review_reason: "collector_mismatch",
      });
    }, 60_000);
  });

  it("keeps tenants apart: the same payment id in two tenants is two payments", async () => {
    const a = await tenantWithLineman(t.current, h);
    const b = await tenantWithLineman(t.current, h);
    const customerA = await insertCustomer(t.current, a.tenant.operatorId);
    const customerB = await insertCustomer(t.current, b.tenant.operatorId);
    const id = uuidv7();
    const inA = [paymentItem(a.lineman, customerA, { id, amount_paise: 10_000 })];
    const inB = [paymentItem(b.lineman, customerB, { id, amount_paise: 99_000 })];
    expect(
      (await ok(await send(a.lineman.accessToken, { payments: inA }), inA)).results[0]?.outcome,
    ).toBe("posted");
    const bBody = await ok(await send(b.lineman.accessToken, { payments: inB }), inB);
    expect(bBody.results[0]).toMatchObject({
      outcome: "posted",
      payment: { amount_paise: 99_000, customer_id: customerB },
    });
    // B's lineman sending A's customer: not found, and A's rows are untouched.
    const before = await moneyRowCounts(t.current, a.tenant.operatorId);
    const cross = [paymentItem(b.lineman, customerA)];
    const crossBody = await ok(await send(b.lineman.accessToken, { payments: cross }), cross);
    expect(crossBody.results[0]?.error?.code).toBe("CUSTOMER_NOT_FOUND");
    expect(await moneyRowCounts(t.current, a.tenant.operatorId)).toEqual(before);
  }, 60_000);

  describe("PRD §16 sync metrics (T-086a)", () => {
    it("a batch with new, replayed and refused payments moves the counters once per payment id", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const other = await tenantWithLineman(t.current, h);
      const op = tenant.operatorId;
      const customer = await insertCustomer(t.current, op);
      const theirs = await insertCustomer(t.current, other.tenant.operatorId);
      const { id: _dropped, ...withoutId } = paymentItem(lineman, customer, {}, 9);
      const a = paymentItem(lineman, customer, { amount_paise: 10_000 }, 1);
      const b = paymentItem(lineman, customer, { amount_paise: 20_000 }, 2);
      const batch = [
        a, // new
        b, // new
        paymentItem(lineman, theirs, {}, 3), // another tenant's customer: CUSTOMER_NOT_FOUND
        paymentItem(lineman, customer, { amount_paise: 12.5 }, 4), // VALIDATION
        withoutId, // VALIDATION, no usable id
      ];
      const first = await ok(await send(lineman.accessToken, { payments: batch }), batch);
      expect(first.results.map((r) => r.outcome)).toEqual([
        "posted",
        "posted",
        "rejected",
        "rejected",
        "rejected",
      ]);
      // The phone lost the answer and sends the whole batch again, twice.
      for (let i = 0; i < 2; i += 1) {
        const replay = await ok(await send(lineman.accessToken, { payments: batch }), batch);
        expect(replay.results.map((r) => r.outcome)).toEqual([
          "duplicate",
          "duplicate",
          "rejected",
          "rejected",
          "rejected",
        ]);
      }
      // Then a new payment, a replay and the same id with other data.
      const c = paymentItem(lineman, customer, { amount_paise: 30_000 }, 5);
      const last = [c, a, { ...b, amount_paise: 25_000 }];
      const lastBody = await ok(await send(lineman.accessToken, { payments: last }), last);
      expect(lastBody.results.map((r) => r.outcome)).toEqual(["posted", "duplicate", "rejected"]);

      expect(await platformCounters(op)).toEqual({
        batches: 4,
        items: 18,
        accepted: 3, // a, b, c: once each
        duplicate: 5, // a, b twice, then a
        rejected_validation: 3, // the fractional item, three sends
        rejected_customer_not_found: 3,
        rejected_id_reused: 1,
        rejected_without_id: 3,
        rejected_new_ids: 2, // the two refused ids, once each; b's reuse is a saved payment
        accepted_after_rejection: 0,
        retry_later: 0,
      });
      // Payment ids with a final answer: a, b, c accepted + 2 refused = 5; 3 ÷ 5 = 60 %.
      const { rows: keys } = await t.current.admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM payment_sync_rejections WHERE operator_id = $1",
        [op],
      );
      expect(keys[0]?.n).toBe(2);
      // The other tenant's counters are untouched.
      expect((await platformCounters(other.tenant.operatorId))?.batches).toBe(0);

      // The platform reads the counts but no row id, time or refused payment id.
      for (const statement of [
        "SELECT * FROM payment_sync_batches",
        "SELECT id, received_at FROM payment_sync_batches",
      ]) {
        const error = await asPlatform(statement).catch((e: unknown) => e);
        expect((error as { code?: string }).code, statement).toBe("42501");
      }
      expect(await asPlatform("SELECT count(*)::int AS n FROM payment_sync_rejections")).toEqual([
        { n: 0 },
      ]);
    }, 60_000);

    it("retry_later answers are counted by code, and the later post counts the id once", async () => {
      let writes = 0;
      const flaky: DbClient = {
        ...t.current.db,
        withTenant: (operatorId, fn, options) => {
          if (options?.accessMode !== "read only") {
            writes += 1;
            if (writes === 2) return Promise.reject(new Error("connection reset"));
          }
          return t.current.db.withTenant(operatorId, fn, options);
        },
      };
      const faulty = mobileApiHarness(t.current, NOW, { db: flaky });
      const handler = paymentBatchHandler(faulty.getDeps);
      const { tenant, lineman } = await tenantWithLineman(t.current, faulty);
      writes = 0;
      const customer = await insertCustomer(t.current, tenant.operatorId);
      const items = [1, 2].map((n) => paymentItem(lineman, customer, {}, n));
      const first = await ok(await send(lineman.accessToken, { payments: items }, handler), items);
      expect(first.results.map((r) => r.outcome)).toEqual(["posted", "retry_later"]);
      const retry = await ok(await send(lineman.accessToken, { payments: items }, handler), items);
      expect(retry.results.map((r) => r.outcome)).toEqual(["duplicate", "posted"]);
      expect(await platformCounters(tenant.operatorId)).toMatchObject({
        batches: 2,
        items: 4,
        accepted: 2,
        duplicate: 1,
        retry_later: 1,
        rejected_new_ids: 0,
      });
    }, 60_000);

    it("a failure to record the counts never changes the answer", async () => {
      // A database client whose metrics transaction (the last write of the batch) fails.
      let writes = 0;
      const flaky: DbClient = {
        ...t.current.db,
        withTenant: (operatorId, fn, options) => {
          if (options?.accessMode !== "read only") {
            writes += 1;
            if (writes === 2) return Promise.reject(new Error("connection reset"));
          }
          return t.current.db.withTenant(operatorId, fn, options);
        },
      };
      const faulty = mobileApiHarness(t.current, NOW, { db: flaky });
      const handler = paymentBatchHandler(faulty.getDeps);
      const { tenant, lineman } = await tenantWithLineman(t.current, faulty);
      writes = 0;
      const customer = await insertCustomer(t.current, tenant.operatorId);
      const items = [paymentItem(lineman, customer, {}, 1)];
      const body = await ok(await send(lineman.accessToken, { payments: items }, handler), items);
      expect(body.results[0]?.outcome).toBe("posted");
      expect((await moneyRowCounts(t.current, tenant.operatorId)).payments).toBe(1);
      expect((await platformCounters(tenant.operatorId))?.batches).toBe(0);
      expect(
        faulty.logs.records.some((r) => r.event === "mobile_api.payment_sync_metrics_failed"),
      ).toBe(true);
    }, 60_000);

    it("the answer never waits for the metrics write: a stalled one runs after the response", async () => {
      // The metrics transaction (the 2nd write of a one-item batch) never resolves.
      let writes = 0;
      const stalled: DbClient = {
        ...t.current.db,
        withTenant: (operatorId, fn, options) => {
          if (options?.accessMode !== "read only") {
            writes += 1;
            if (writes === 2) return new Promise<never>(() => {});
          }
          return t.current.db.withTenant(operatorId, fn, options);
        },
      };
      const deferred: Promise<void>[] = [];
      const harness = mobileApiHarness(t.current, NOW, {
        db: stalled,
        afterResponse: (task) => {
          deferred.push(task());
        },
      });
      const handler = paymentBatchHandler(harness.getDeps);
      const { tenant, lineman } = await tenantWithLineman(t.current, harness);
      writes = 0;
      const customer = await insertCustomer(t.current, tenant.operatorId);
      const items = [paymentItem(lineman, customer, {}, 1)];
      const answered = await Promise.race([
        send(lineman.accessToken, { payments: items }, handler),
        new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 10_000)),
      ]);
      expect(answered).not.toBe("timed out");
      const body = await ok(answered as Response, items);
      expect(body.results[0]?.outcome).toBe("posted");
      expect(deferred).toHaveLength(1); // handed to afterResponse, still pending
      expect((await moneyRowCounts(t.current, tenant.operatorId)).payments).toBe(1);
      expect((await platformCounters(tenant.operatorId))?.batches).toBe(0);
    }, 60_000);

    it("maps every answer code to a metrics code, and the batch limits agree", () => {
      expect(PAYMENT_SYNC_BATCH_MAX).toBe(PAYMENT_BATCH_MAX);
      const id = uuidv7();
      const answer = (outcome: "rejected" | "retry_later", code: string) =>
        syncMetricItem({
          id,
          outcome,
          payment: null,
          review_reason: null,
          // biome-ignore lint/suspicious/noExplicitAny: every code postItem answers.
          error: { code: code as any, message: "x" },
        });
      for (const code of PAYMENT_SYNC_REJECT_CODES) {
        expect(answer("rejected", code)).toEqual({
          item: { outcome: "rejected", id, code },
          unknownCode: false,
        });
      }
      for (const code of PAYMENT_SYNC_RETRY_CODES) {
        expect(answer("retry_later", code)).toEqual({
          item: { outcome: "retry_later", id, code },
          unknownCode: false,
        });
      }
      expect(answer("rejected", "DEVICE_REVOKED").unknownCode).toBe(true);
      // Every code batch.ts can answer for an item (string literals passed to itemError, plus
      // the ID_REUSED code passed through) is one the metrics know.
      const source = readFileSync(new URL("./batch.ts", import.meta.url), "utf8");
      const answered = new Set(
        [...source.matchAll(/itemError\(\s*"([A-Z_]+)"/g)].map((m) => m[1] ?? ""),
      );
      answered.add("ID_REUSED_WITH_DIFFERENT_DATA");
      expect([...answered].sort()).toEqual(
        [...PAYMENT_SYNC_REJECT_CODES, ...PAYMENT_SYNC_RETRY_CODES].sort(),
      );
      expect(source).toMatch(/case "ID_REUSED_WITH_DIFFERENT_DATA": \{[^}]*itemError\(\s*code,/);
    });

    it("a non-RFC item id is counted 'without id' and the batch's metrics row is still written", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const customer = await insertCustomer(t.current, tenant.operatorId);
      const items = [
        paymentItem(lineman, customer, {}, 1),
        paymentItem(lineman, customer, { id: "12345678-1234-0234-0234-123456789abc" }, 2),
      ];
      const response = await send(lineman.accessToken, { payments: items });
      expect(response.status).toBe(200);
      const body = PaymentBatchResponse.parse(await response.json());
      expect(body.results.map((r) => [r.outcome, r.error?.code ?? null])).toEqual([
        ["posted", null],
        ["rejected", "VALIDATION"],
      ]);
      expect(body.results[1]?.id).toBe(UNUSABLE_ITEM_ID);
      expect(await platformCounters(tenant.operatorId)).toMatchObject({
        batches: 1,
        items: 2,
        accepted: 1,
        rejected_validation: 0,
        rejected_without_id: 1,
        rejected_new_ids: 0,
      });
      expect(h.logs.records.some((r) => r.event === "mobile_api.payment_sync_metrics_failed")).toBe(
        false,
      );
    }, 60_000);
  });
});
