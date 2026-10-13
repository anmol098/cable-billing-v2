// @vitest-environment node
/**
 * `POST /api/mobile/v1/receipts/{paymentId}/link` and `POST /api/mobile/v1/receipts/actions:batch`
 * (T-061 over T-050 and core `recordReceiptAction`) against a real database, the real T-028 auth
 * and an injected clock. Every 200 body is parsed with the contract (`ReceiptLinkResponse` /
 * `ReceiptActionsResponse`), every error with `ErrorResponse`.
 */
import { readFileSync } from "node:fs";
import { ErrorResponse, ReceiptActionsResponse, ReceiptLinkResponse } from "@cb/contracts";
import { hashReceiptLinkToken, RECEIPT_LINK_MAX_LIVE, RECEIPT_LINK_TTL_MS } from "@cb/core";
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
  type TenantWithLineman,
  tenantWithLineman,
} from "../../payments/_lib/test-support";
import { UNUSABLE_ITEM_ID } from "../../payments/_lib/wire-errors";
import {
  receiptActionsHandler,
  receiptLinkHandler,
  TOO_MANY_LINKS_RETRY_AFTER_SECONDS,
} from "./receipts";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const NOW = new Date("2026-10-13T06:00:00.000Z");
const ORIGIN = "https://receipts.cable.test";
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

describeDb("receipts API (T-061)", () => {
  const t = useTestDatabase();
  let h: MobileApiHarness;
  let LINK: ReturnType<typeof receiptLinkHandler>;
  let ACTIONS: ReturnType<typeof receiptActionsHandler>;
  let PUSH: ReturnType<typeof paymentBatchHandler>;

  beforeAll(() => {
    h = mobileApiHarness(t.current, NOW);
    LINK = receiptLinkHandler(h.getDeps, { receiptOrigin: () => ORIGIN });
    ACTIONS = receiptActionsHandler(h.getDeps);
    PUSH = paymentBatchHandler(h.getDeps);
  });

  const askLink = (token: string | null, paymentId: string, handler = LINK, version?: string) =>
    handler(
      mobileRequest(`/receipts/${paymentId}/link`, {
        token,
        ...(version === undefined ? {} : { version }),
      }),
      routeParams({ paymentId }),
    );
  const sendActions = (token: string | null, body: unknown) =>
    ACTIONS(mobileRequest("/receipts/actions:batch", { token, body }));

  async function failure(response: Response, status: number) {
    expect(response.status).toBe(status);
    return ErrorResponse.parse(await response.json()).error;
  }
  async function actionResults(response: Response) {
    expect(response.status).toBe(200);
    return ReceiptActionsResponse.parse(await response.json()).results;
  }

  /** A tenant whose lineman has pushed one payment; returns its id. */
  async function withPayment(options: { subscription?: "active" | "read_only" } = {}) {
    const setup: TenantWithLineman = await tenantWithLineman(t.current, h, options);
    const customer = await insertCustomer(t.current, setup.tenant.operatorId);
    const item = paymentItem(setup.lineman, customer);
    const response = await PUSH(
      mobileRequest("/payments:batch", {
        token: setup.lineman.accessToken,
        body: { payments: [item] },
      }),
    );
    expect(response.status).toBe(200);
    return { ...setup, paymentId: String(item.id) };
  }

  describe("POST /receipts/{paymentId}/link", () => {
    it("makes a 90-day https link for a synced payment; only the token's hash is stored", async () => {
      const { tenant, lineman, paymentId } = await withPayment();
      const response = await askLink(lineman.accessToken, paymentId);
      expect(response.status).toBe(200);
      const { link } = ReceiptLinkResponse.parse(await response.json());
      expect(link.receipt_number).toBe("R-2610-00001");
      expect(link.expires_at).toBe(new Date(NOW.getTime() + RECEIPT_LINK_TTL_MS).toISOString());
      const match = /^https:\/\/receipts\.cable\.test\/r\/([A-Za-z0-9_-]{43})$/.exec(link.url);
      expect(match).not.toBeNull();
      const token = match?.[1] ?? "";
      const rows = await t.current.admin.query<{ token_hash: string; created_by: string }>(
        "SELECT token_hash, created_by FROM receipt_links WHERE operator_id = $1",
        [tenant.operatorId],
      );
      expect(rows.rows).toEqual([
        { token_hash: hashReceiptLinkToken(token), created_by: lineman.userId },
      ]);
      expect(JSON.stringify(h.logs.records)).not.toContain(token);

      // Asking again makes a new link (T-050 keeps only hashes, so a URL can't be rebuilt).
      const again = ReceiptLinkResponse.parse(
        await (await askLink(lineman.accessToken, paymentId)).json(),
      );
      expect(again.link.url).not.toBe(link.url);
      // Same keys as the contract fixture.
      expect(Object.keys(link).sort()).toEqual(
        Object.keys(ReceiptLinkResponse.parse(fixture("createReceiptLink.response")).link).sort(),
      );
    }, 60_000);

    it("PAYMENT_NOT_FOUND for a payment not synced yet or of another tenant; nothing written", async () => {
      const a = await withPayment();
      const b = await withPayment();
      for (const paymentId of [uuidv7(), b.paymentId]) {
        const error = await failure(await askLink(a.lineman.accessToken, paymentId), 404);
        expect(error.code).toBe("PAYMENT_NOT_FOUND");
        expect(JSON.stringify(error)).not.toContain(b.paymentId);
      }
      expect((await moneyRowCounts(t.current, a.tenant.operatorId)).receipt_links).toBe(0);
      expect((await moneyRowCounts(t.current, b.tenant.operatorId)).receipt_links).toBe(0);
      const bad = await failure(await askLink(a.lineman.accessToken, "not-a-uuid"), 400);
      expect(bad).toMatchObject({ code: "VALIDATION", fields: [{ path: "paymentId" }] });
    }, 60_000);

    it("429 after 20 live links on one receipt; works in a read-only tenant (D-13)", async () => {
      const { lineman, paymentId } = await withPayment({ subscription: "read_only" });
      for (let i = 0; i < RECEIPT_LINK_MAX_LIVE; i += 1) {
        expect((await askLink(lineman.accessToken, paymentId)).status).toBe(200);
      }
      const response = await askLink(lineman.accessToken, paymentId);
      const error = await failure(response, 429);
      expect(error).toMatchObject({
        code: "RATE_LIMITED",
        retry_after_seconds: TOO_MANY_LINKS_RETRY_AFTER_SECONDS,
      });
      expect(response.headers.get("retry-after")).toBe(String(TOO_MANY_LINKS_RETRY_AFTER_SECONDS));
    }, 60_000);

    it("500 without making a link when the receipt origin is not https", async () => {
      const { tenant, lineman, paymentId } = await withPayment();
      const local = receiptLinkHandler(h.getDeps, { receiptOrigin: () => "http://localhost:3000" });
      expect((await failure(await askLink(lineman.accessToken, paymentId, local), 500)).code).toBe(
        "INTERNAL",
      );
      expect((await moneyRowCounts(t.current, tenant.operatorId)).receipt_links).toBe(0);
    }, 60_000);

    it("version gate and auth come first", async () => {
      const { lineman, paymentId } = await withPayment();
      expect((await failure(await askLink(null, paymentId), 401)).code).toBe("UNAUTHENTICATED");
      expect(
        (await failure(await askLink(lineman.accessToken, paymentId, LINK, "2"), 426)).code,
      ).toBe("APP_TOO_OLD");
    }, 60_000);
  });

  describe("POST /receipts/actions:batch", () => {
    const rowsOf = async (operatorId: string) =>
      (
        await t.current.admin.query<{
          id: string;
          action: string;
          actor_id: string;
          device_id: string;
        }>(
          "SELECT id, action, actor_id, device_id FROM receipt_actions WHERE operator_id = $1 ORDER BY id",
          [operatorId],
        )
      ).rows;

    it("records honest actions per item; bad items are rejected on their own; replays are duplicates", async () => {
      const { tenant, lineman, paymentId } = await withPayment();
      const other = await withPayment();
      const printed = {
        id: uuidv7(),
        payment_id: paymentId,
        action: "printed",
        at: "2026-10-13T05:16:10.000Z",
      };
      const actions: Record<string, unknown>[] = [
        printed,
        {
          id: uuidv7(),
          payment_id: paymentId,
          action: "whatsapp_opened",
          at: "2026-10-13T05:16:30.000Z",
        },
        {
          id: uuidv7(),
          payment_id: uuidv7(),
          action: "sms_opened",
          at: "2026-10-13T05:17:00.000Z",
        }, // not synced yet
        {
          id: uuidv7(),
          payment_id: other.paymentId,
          action: "printed",
          at: "2026-10-13T05:17:00.000Z",
        }, // other tenant
        { id: uuidv7(), payment_id: paymentId, action: "sent", at: "2026-10-13T05:17:00.000Z" }, // dishonest
        {
          id: uuidv7(),
          payment_id: paymentId,
          action: "delivered",
          at: "2026-10-13T05:17:00.000Z",
        },
        { payment_id: paymentId, action: "printed", at: "2026-10-13T05:17:00.000Z" }, // no id
        { ...printed, action: "print_failed" }, // id reused with other data
        { ...printed }, // the same action again
        {
          id: uuidv7(),
          payment_id: paymentId,
          action: "pdf_shared",
          at: "2026-10-13T05:18:00+05:30",
        }, // offset
      ];
      const results = await actionResults(await sendActions(lineman.accessToken, { actions }));
      expect(results.map((r) => r.outcome)).toEqual([
        "recorded",
        "recorded",
        "retry_later",
        "retry_later",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "duplicate",
        "rejected",
      ]);
      expect(results.map((r) => r.id)).toEqual(
        actions.map((a) => (typeof a.id === "string" ? a.id : UNUSABLE_ITEM_ID)),
      );
      expect(results[2]?.error?.code).toBe("PAYMENT_NOT_FOUND");
      expect(results[3]?.error?.code).toBe("PAYMENT_NOT_FOUND");
      expect(results[4]?.error).toMatchObject({
        code: "VALIDATION",
        fields: [{ path: "actions.4.action" }],
      });
      expect(results[7]?.error).toEqual({
        code: "ID_REUSED_WITH_DIFFERENT_DATA",
        message: "action id already used with different data (action)",
      });
      expect(results[9]?.error).toMatchObject({
        code: "VALIDATION",
        fields: [{ path: "actions.9.at" }],
      });

      const stored = await rowsOf(tenant.operatorId);
      expect(stored.map((r) => r.action).sort()).toEqual(["printed", "whatsapp_opened"]);
      for (const row of stored) {
        expect(row).toMatchObject({ actor_id: lineman.userId, device_id: lineman.deviceId });
      }
      expect(await rowsOf(other.tenant.operatorId)).toHaveLength(0);

      // The phone resends the whole outbox: duplicates, nothing new.
      const replay = await actionResults(
        await sendActions(lineman.accessToken, { actions: actions.slice(0, 2) }),
      );
      expect(replay.map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
      expect(await rowsOf(tenant.operatorId)).toHaveLength(2);
    }, 60_000);

    it("takes the contract fixture's actions once their payments are synced; read-only is fine", async () => {
      const { tenant, lineman, paymentId } = await withPayment({ subscription: "read_only" });
      const request = fixture("postReceiptActions.request");
      const actions = (request.actions as Record<string, unknown>[]).map((a) => ({
        ...a,
        id: uuidv7(),
        payment_id: paymentId,
      }));
      const results = await actionResults(await sendActions(lineman.accessToken, { actions }));
      expect(results.every((r) => r.outcome === "recorded")).toBe(true);
      expect(await rowsOf(tenant.operatorId)).toHaveLength(actions.length);
    }, 60_000);

    it("refuses a whole request that isn't a batch, and auth failures, writing nothing", async () => {
      const { tenant, lineman, paymentId } = await withPayment();
      const one = {
        id: uuidv7(),
        payment_id: paymentId,
        action: "printed",
        at: "2026-10-13T05:16:10.000Z",
      };
      for (const body of [{ actions: [] }, { actions: Array(101).fill(one) }, "nope"]) {
        expect((await failure(await sendActions(lineman.accessToken, body), 400)).code).toBe(
          "VALIDATION",
        );
      }
      expect((await failure(await sendActions(null, { actions: [one] }), 401)).code).toBe(
        "UNAUTHENTICATED",
      );
      const old = await ACTIONS(
        mobileRequest("/receipts/actions:batch", {
          token: lineman.accessToken,
          body: { actions: [one] },
          version: "1",
        }),
      );
      expect((await failure(old, 426)).code).toBe("APP_TOO_OLD");
      expect(await rowsOf(tenant.operatorId)).toHaveLength(0);
    }, 60_000);
  });
});
