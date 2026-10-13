// @vitest-environment node
/**
 * `GET /api/mobile/v1/collections/{date}` and `POST …/{date}/handover` (T-061 over T-062) against a
 * real database, the real T-028 auth and an injected clock. Every 200 body is parsed with the
 * contract (`CollectionDayResponse` / `HandoverResponse`), every error with `ErrorResponse`.
 *
 * Covered: the day's totals and payments as the phone pushed them, empty / bad / future dates, the
 * handover (server-computed discrepancy, reason required, idempotent submission id, ID_REUSED,
 * returned → resubmitted → accepted → HANDOVER_ALREADY_ACCEPTED), read-only tenants (D-13), the
 * version gate and auth, and isolation (another tenant's or lineman's day never leaks).
 */
import { readFileSync } from "node:fs";
import { CollectionDayResponse, ErrorResponse, HandoverResponse } from "@cb/contracts";
import { acceptHandover, returnHandover } from "@cb/core";
import { contextFor, type SeededTenant } from "@cb/core/testing";
import { uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { paymentBatchHandler } from "../../payments/_lib/batch";
import {
  insertCustomer,
  type MobileApiHarness,
  mobileApiHarness,
  mobileRequest,
  moneyRowCounts,
  paymentItem,
  routeParams,
  type SignedInLineman,
  signInLineman,
  tenantWithLineman,
} from "../../payments/_lib/test-support";
import { collectionDayHandler, submitHandoverHandler } from "./collections";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

/** 11:30 in India on 13 Oct 2026. */
const NOW = new Date("2026-10-13T06:00:00.000Z");
const TODAY = "2026-10-13";
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

describeDb("collections API (T-061)", () => {
  const t = useTestDatabase();
  let h: MobileApiHarness;
  let GET: ReturnType<typeof collectionDayHandler>;
  let HANDOVER: ReturnType<typeof submitHandoverHandler>;
  let PUSH: ReturnType<typeof paymentBatchHandler>;

  beforeAll(() => {
    h = mobileApiHarness(t.current, NOW);
    GET = collectionDayHandler(h.getDeps);
    HANDOVER = submitHandoverHandler(h.getDeps);
    PUSH = paymentBatchHandler(h.getDeps);
  });

  const readDay = (token: string | null, date: string, version?: string | null) =>
    GET(
      mobileRequest(`/collections/${date}`, {
        method: "GET",
        token,
        ...(version === undefined ? {} : { version }),
      }),
      routeParams({ date }),
    );
  const handOver = (token: string | null, date: string, body: unknown) =>
    HANDOVER(
      mobileRequest(`/collections/${date}/handover`, { token, body }),
      routeParams({ date }),
    );

  async function day(response: Response) {
    expect(response.status).toBe(200);
    return CollectionDayResponse.parse(await response.json()).session;
  }
  async function afterHandover(response: Response) {
    expect(response.status).toBe(200);
    return HandoverResponse.parse(await response.json()).session;
  }
  async function failure(response: Response, status: number) {
    expect(response.status).toBe(status);
    return ErrorResponse.parse(await response.json()).error;
  }

  /** The lineman pushes `items` through the real batch endpoint. */
  async function push(lineman: SignedInLineman, items: Record<string, unknown>[]) {
    const response = await PUSH(
      mobileRequest("/payments:batch", { token: lineman.accessToken, body: { payments: items } }),
    );
    expect(response.status).toBe(200);
  }

  async function collectedDay(tenant: SeededTenant, lineman: SignedInLineman) {
    const customer = await insertCustomer(t.current, tenant.operatorId, { name: "Ramesh Kumar" });
    const items = [
      paymentItem(
        lineman,
        customer,
        { amount_paise: 50_000, recorded_at: "2026-10-13T04:00:00.000Z" },
        1,
      ),
      paymentItem(
        lineman,
        customer,
        { amount_paise: 20_000, method: "upi", recorded_at: "2026-10-13T04:30:00.000Z" },
        2,
      ),
      paymentItem(
        lineman,
        customer,
        { amount_paise: 30_000, recorded_at: "2026-10-13T05:00:00.000Z" },
        3,
      ),
    ];
    await push(lineman, items);
    return { customer, items };
  }

  const sessionIdOf = async (operatorId: string, collectorId: string) =>
    (
      await t.current.admin.query<{ id: string }>(
        "SELECT id FROM collection_sessions WHERE operator_id = $1 AND collector_id = $2 AND business_date = $3",
        [operatorId, collectorId, TODAY],
      )
    ).rows[0]?.id ?? "";

  it("answers the lineman's day: server totals and payments, newest first", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const { customer, items } = await collectedDay(tenant, lineman);

    const session = await day(await readDay(lineman.accessToken, TODAY));
    expect(session).toMatchObject({
      business_date: TODAY,
      cash_total_paise: 80_000,
      upi_total_paise: 20_000,
      payment_count: 3,
      status: "open",
      handover: null,
    });
    expect(session.payments.map((p) => p.payment_id)).toEqual(
      [items[2], items[1], items[0]].map((i) => i?.id),
    );
    expect(session.payments[0]).toEqual({
      payment_id: items[2]?.id,
      customer_id: customer,
      customer_code: expect.stringMatching(/^C-/),
      customer_name: "Ramesh Kumar",
      amount_paise: 30_000,
      method: "cash",
      recorded_at: "2026-10-13T05:00:00.000Z",
      posted_at: NOW.toISOString(),
      receipt_number: "R-2610-00003",
      provisional_ref: items[2]?.provisional_ref,
      reversed: false,
    });
    // Same keys as the contract fixture.
    const expected = CollectionDayResponse.parse(fixture("getCollectionDay.response")).session;
    expect(Object.keys(session).sort()).toEqual(Object.keys(expected).sort());
  }, 60_000);

  it("an empty day is all zero and open; bad and future dates are VALIDATION", async () => {
    const { lineman } = await tenantWithLineman(t.current, h);
    expect(await day(await readDay(lineman.accessToken, "2026-10-12"))).toEqual({
      business_date: "2026-10-12",
      cash_total_paise: 0,
      upi_total_paise: 0,
      payment_count: 0,
      status: "open",
      handover: null,
      payments: [],
    });
    const future = await failure(await readDay(lineman.accessToken, "2026-10-14"), 400);
    expect(future).toMatchObject({
      code: "VALIDATION",
      fields: [{ path: "date", issue: "future" }],
    });
    for (const bad of ["2026-13-01", "today", "13-10-2026", "2026-02-30"]) {
      const error = await failure(await readDay(lineman.accessToken, bad), 400);
      expect(error.code, bad).toBe("VALIDATION");
      expect(error.fields?.[0]?.path, bad).toBe("date");
    }
    // Late evening in India is already the next business date.
    h.clock.now = new Date("2026-10-13T19:00:00.000Z");
    try {
      const evening = await signInLineman(t.current, h, lineman.userId);
      expect((await day(await readDay(evening.accessToken, "2026-10-14"))).business_date).toBe(
        "2026-10-14",
      );
    } finally {
      h.clock.now = NOW;
    }
  }, 60_000);

  it("hands over the cash: server discrepancy, reason when it differs, idempotent submission id", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    await collectedDay(tenant, lineman);
    const op = tenant.operatorId;

    // ₹750 handed over against ₹800 expected: a reason is required.
    const short = {
      submission_id: uuidv7(),
      cash_handed_over_paise: 75_000,
      unsynced_payment_count: 0,
      unsynced_cash_paise: 0,
    };
    const missing = await failure(await handOver(lineman.accessToken, TODAY, short), 400);
    expect(missing).toMatchObject({
      code: "VALIDATION",
      fields: [{ path: "discrepancy_reason", issue: "required" }],
    });

    const body = { ...short, discrepancy_reason: "short", note: "₹50 kam" };
    const submitted = await afterHandover(await handOver(lineman.accessToken, TODAY, body));
    expect(submitted).toMatchObject({
      status: "submitted",
      cash_total_paise: 80_000,
      handover: {
        submission_id: body.submission_id,
        cash_expected_paise: 80_000,
        cash_handed_over_paise: 75_000,
        discrepancy_paise: -5_000,
        discrepancy_reason: "short",
        note: "₹50 kam",
        unsynced_payment_count: 0,
        unsynced_cash_paise: 0,
        submitted_at: NOW.toISOString(),
        reviewed_at: null,
        review_note: null,
      },
    });
    const events = async () => (await moneyRowCounts(t.current, op)).handover_events;
    expect(await events()).toBe(1);

    // The same submission again (a retry after a timeout): the same day, nothing new written.
    h.clock.advance(60_000);
    const again = await afterHandover(await handOver(lineman.accessToken, TODAY, body));
    expect(again).toEqual(submitted);
    expect(await events()).toBe(1);

    // The same submission id with other numbers: refused, names only.
    const reused = await failure(
      await handOver(lineman.accessToken, TODAY, { ...body, cash_handed_over_paise: 70_000 }),
      409,
    );
    expect(reused.code).toBe("ID_REUSED_WITH_DIFFERENT_DATA");
    expect(reused.message).toContain("cash_handed_over_paise");
    expect(reused.message).not.toContain("70000");
    expect(reused.fields).toBeUndefined();
    h.clock.now = NOW;
  }, 60_000);

  it("returned → submitted again → accepted; after that HANDOVER_ALREADY_ACCEPTED", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    await collectedDay(tenant, lineman);
    const runtime = h.getDeps().runtime;
    const owner = await contextFor(runtime, tenant, "owner");
    const sessionId = await sessionIdOf(tenant.operatorId, lineman.userId);

    const first = {
      submission_id: uuidv7(),
      cash_handed_over_paise: 80_000,
      unsynced_payment_count: 0,
      unsynced_cash_paise: 0,
    };
    await afterHandover(await handOver(lineman.accessToken, TODAY, first));
    const returned = await returnHandover.call(runtime, owner, {
      sessionId,
      submissionId: first.submission_id,
      note: "Count again",
    });
    expect(returned.ok).toBe(true);
    expect(await day(await readDay(lineman.accessToken, TODAY))).toMatchObject({
      status: "returned",
      handover: { submission_id: first.submission_id, review_note: "Count again" },
    });

    const second = { ...first, submission_id: uuidv7() };
    expect((await afterHandover(await handOver(lineman.accessToken, TODAY, second))).status).toBe(
      "submitted",
    );
    const accepted = await acceptHandover.call(runtime, owner, {
      sessionId,
      submissionId: second.submission_id,
    });
    expect(accepted.ok).toBe(true);
    const final = await day(await readDay(lineman.accessToken, TODAY));
    expect(final).toMatchObject({
      status: "accepted",
      handover: { submission_id: second.submission_id, reviewed_at: NOW.toISOString() },
    });

    const third = { ...first, submission_id: uuidv7() };
    expect((await failure(await handOver(lineman.accessToken, TODAY, third), 409)).code).toBe(
      "HANDOVER_ALREADY_ACCEPTED",
    );
    // A stale retry of the accepted submission still answers the current day.
    expect((await afterHandover(await handOver(lineman.accessToken, TODAY, second))).status).toBe(
      "accepted",
    );
  }, 60_000);

  it("takes the contract fixture's handover and refuses off-contract bodies", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    await collectedDay(tenant, lineman);
    const request = { ...fixture("submitHandover.request"), submission_id: uuidv7() };
    const session = await afterHandover(await handOver(lineman.accessToken, TODAY, request));
    expect(session.handover).toMatchObject({
      cash_handed_over_paise: 80_000,
      discrepancy_paise: 0,
      // A matching amount stores no reason (T-062).
      discrepancy_reason: null,
      unsynced_payment_count: 1,
      unsynced_cash_paise: 10_000,
    });
    for (const bad of [
      { ...request, submission_id: "x" },
      { ...request, cash_handed_over_paise: -1 },
      { ...request, cash_handed_over_paise: 10.5 },
      { ...request, discrepancy_reason: "lost" },
      "nope",
    ]) {
      expect((await failure(await handOver(lineman.accessToken, TODAY, bad), 400)).code).toBe(
        "VALIDATION",
      );
    }
    expect(
      (await failure(await handOver(lineman.accessToken, "2026-10-14", request), 400)).code,
    ).toBe("VALIDATION");
  }, 60_000);

  it("works in a read-only tenant (D-13)", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h, {
      subscription: "read_only",
    });
    await collectedDay(tenant, lineman);
    expect((await day(await readDay(lineman.accessToken, TODAY))).payment_count).toBe(3);
    const submitted = await afterHandover(
      await handOver(lineman.accessToken, TODAY, {
        submission_id: uuidv7(),
        cash_handed_over_paise: 80_000,
        unsynced_payment_count: 0,
        unsynced_cash_paise: 0,
      }),
    );
    expect(submitted.status).toBe("submitted");
  }, 60_000);

  it("only ever shows the signed-in lineman's own day (other linemen, other tenants)", async () => {
    const a = await tenantWithLineman(t.current, h);
    const { items } = await collectedDay(a.tenant, a.lineman);
    const b = await tenantWithLineman(t.current, h);
    const empty = {
      cash_total_paise: 0,
      upi_total_paise: 0,
      payment_count: 0,
      status: "open",
      handover: null,
      payments: [],
    };
    const bResponse = await readDay(b.lineman.accessToken, TODAY);
    const bText = await bResponse.clone().text();
    expect(await day(bResponse)).toMatchObject(empty);
    for (const item of items) expect(bText).not.toContain(String(item.id));

    // Another lineman of the same tenant.
    const { rows } = await t.current.admin.query<{ id: string }>(
      `INSERT INTO users (id, operator_id, role, name, login, language)
       VALUES ($1, $2, 'lineman', 'Suresh', $3, 'hi') RETURNING id`,
      [uuidv7(), a.tenant.operatorId, `suresh-${uuidv7().slice(-8)}`],
    );
    const suresh = await signInLineman(t.current, h, rows[0]?.id ?? "");
    expect(await day(await readDay(suresh.accessToken, TODAY))).toMatchObject(empty);

    // B's handover never touches A's session.
    const before = await moneyRowCounts(t.current, a.tenant.operatorId);
    await afterHandover(
      await handOver(b.lineman.accessToken, TODAY, {
        submission_id: uuidv7(),
        cash_handed_over_paise: 0,
        unsynced_payment_count: 0,
        unsynced_cash_paise: 0,
      }),
    );
    expect(await moneyRowCounts(t.current, a.tenant.operatorId)).toEqual(before);
  }, 60_000);

  describe("version gate and auth", () => {
    it("refuses old apps, missing headers and bad tokens before reading anything", async () => {
      const { lineman } = await tenantWithLineman(t.current, h);
      const body = {
        submission_id: uuidv7(),
        cash_handed_over_paise: 0,
        unsynced_payment_count: 0,
        unsynced_cash_paise: 0,
      };
      expect((await failure(await readDay(null, TODAY), 401)).code).toBe("UNAUTHENTICATED");
      expect((await failure(await readDay(lineman.accessToken, TODAY, "2"), 426)).code).toBe(
        "APP_TOO_OLD",
      );
      expect((await failure(await readDay(lineman.accessToken, TODAY, null), 400)).code).toBe(
        "VALIDATION",
      );
      expect((await failure(await handOver("cbm1.bad.token", TODAY, body), 401)).code).toBe(
        "UNAUTHENTICATED",
      );
      const old = await HANDOVER(
        mobileRequest(`/collections/${TODAY}/handover`, {
          token: lineman.accessToken,
          body,
          version: "1",
        }),
        routeParams({ date: TODAY }),
      );
      expect((await failure(old, 426)).code).toBe("APP_TOO_OLD");
    }, 60_000);
  });
});
