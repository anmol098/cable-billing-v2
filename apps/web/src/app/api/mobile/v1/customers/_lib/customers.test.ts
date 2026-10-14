// @vitest-environment node
/**
 * `GET /api/mobile/v1/customers/{id}` and `PATCH …/{id}/phone` (T-060) against a real database,
 * the real T-028 sign-in and an injected clock. Every 200 body is parsed with the contract
 * (`CustomerDetailResponse` / `UpdatePhoneResponse`), every error with `ErrorResponse`.
 *
 * Covered: the detail (roster row, open bills oldest first, latest payments newest first, a closed
 * customer), the phone correction (audited once with source android, idempotent repeat, invalid
 * numbers, read-only tenants), 404 CUSTOMER_NOT_FOUND for unknown and other tenants' ids with
 * nothing written, the version gate and auth.
 */
import { readFileSync } from "node:fs";
import { CustomerDetailResponse, ErrorResponse, UpdatePhoneResponse } from "@cb/contracts";
import { getRosterCustomerDetail, setCustomerStatus } from "@cb/core";
import { contextFor } from "@cb/core/testing";
import { uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { paymentBatchHandler } from "../../payments/_lib/batch";
import {
  insertCustomer,
  issueBill,
  type MobileApiHarness,
  mobileApiHarness,
  mobileRequest,
  paymentItem,
  routeParams,
  tenantWithLineman,
} from "../../payments/_lib/test-support";
import { customerDetailHandler, updatePhoneHandler } from "./customers";
import { rosterCustomerWire } from "./wire";

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

describeDb("customer detail and phone API (T-060)", () => {
  const t = useTestDatabase();
  let h: MobileApiHarness;
  let DETAIL: ReturnType<typeof customerDetailHandler>;
  let PHONE: ReturnType<typeof updatePhoneHandler>;
  let PUSH: ReturnType<typeof paymentBatchHandler>;

  beforeAll(() => {
    h = mobileApiHarness(t.current, NOW);
    DETAIL = customerDetailHandler(h.getDeps);
    PHONE = updatePhoneHandler(h.getDeps);
    PUSH = paymentBatchHandler(h.getDeps);
  });

  const detail = (token: string | null, id: string, version?: string | null) =>
    DETAIL(
      mobileRequest(`/customers/${id}`, {
        method: "GET",
        token,
        ...(version === undefined ? {} : { version }),
      }),
      routeParams({ id }),
    );

  function patchPhone(token: string | null, id: string, body: unknown) {
    const base = mobileRequest(`/customers/${id}/phone`, { method: "GET", token });
    return PHONE(
      new Request(base.url, {
        method: "PATCH",
        headers: base.headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      routeParams({ id }),
    );
  }

  async function failure(response: Response, status: number) {
    expect(response.status).toBe(status);
    return ErrorResponse.parse(await response.json()).error;
  }

  const contactChanges = async (customerId: string) =>
    (
      await t.current.admin.query(
        "SELECT old_value, new_value, source, actor_id FROM customer_contact_changes WHERE customer_id = $1 ORDER BY at",
        [customerId],
      )
    ).rows;
  const phoneAudits = async (customerId: string) =>
    (
      await t.current.admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'customers.update_phone'",
        [customerId],
      )
    ).rows[0]?.n;
  const phoneOf = async (customerId: string) =>
    (await t.current.admin.query("SELECT phone FROM customers WHERE id = $1", [customerId])).rows[0]
      ?.phone;

  describe("GET /customers/{id}", () => {
    it("answers the roster row, open bills oldest first and the latest payments", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const id = await insertCustomer(t.current, tenant.operatorId, { name: "Ramesh Kumar" });
      await issueBill(t.current, tenant.operatorId, id, "2026-09-01", 45_000);
      await issueBill(t.current, tenant.operatorId, id, "2026-10-01", 45_000);
      const items = [
        paymentItem(
          lineman,
          id,
          { amount_paise: 20_000, recorded_at: "2026-10-13T04:00:00.000Z" },
          1,
        ),
        paymentItem(
          lineman,
          id,
          { amount_paise: 30_000, recorded_at: "2026-10-13T05:00:00.000Z" },
          2,
        ),
      ];
      const pushed = await PUSH(
        mobileRequest("/payments:batch", { token: lineman.accessToken, body: { payments: items } }),
      );
      expect(pushed.status).toBe(200);

      const response = await detail(lineman.accessToken, id);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const json = await response.json();
      const body = CustomerDetailResponse.parse(json);
      expect(Object.keys(json).sort()).toEqual(Object.keys(fixture("getCustomer.response")).sort());
      // 2 × ₹450 billed, ₹500 paid oldest first: September is paid, October has ₹400 left.
      expect(body.customer).toMatchObject({
        id,
        name: "Ramesh Kumar",
        active: true,
        balance_paise: 40_000,
        credit_paise: 0,
        open_bills: { count: 1, outstanding_paise: 40_000, oldest_period: "2026-10-01" },
      });
      expect(body.open_bills.map((b) => [b.period, b.charges_paise, b.outstanding_paise])).toEqual([
        ["2026-10-01", 45_000, 40_000],
      ]);
      expect(body.recent_payments.map((p) => [p.payment_id, p.amount_paise, p.reversed])).toEqual([
        [items[1]?.id, 30_000, false],
        [items[0]?.id, 20_000, false],
      ]);
      expect(body.recent_payments[0]).toMatchObject({
        method: "cash",
        provisional_ref: items[1]?.provisional_ref,
        recorded_at: "2026-10-13T05:00:00.000Z",
      });
      expect(body.recent_payments[0]?.receipt_number).toMatch(/^R-2610-\d{5}$/);
      expect(body.recent_payments[0]?.collected_by_name).toBeTruthy();

      // The wire body is exactly the core service's answer, mapped.
      const ctx = await contextFor(h.getDeps().runtime, tenant, "lineman");
      const core = await getRosterCustomerDetail.call(h.getDeps().runtime, ctx, { customerId: id });
      expect(core.ok && rosterCustomerWire(core.value.customer)).toEqual(body.customer);
    });

    it("answers a closed customer with active: false", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const id = await insertCustomer(t.current, tenant.operatorId, { status: "inactive" });
      const body = CustomerDetailResponse.parse(
        await (await detail(lineman.accessToken, id)).json(),
      );
      expect(body.customer.active).toBe(false);
      expect(body.open_bills).toEqual([]);
      expect(body.recent_payments).toEqual([]);
    });

    it("404 CUSTOMER_NOT_FOUND for unknown and other tenants' ids, 400 for a non-UUID", async () => {
      const a = await tenantWithLineman(t.current, h);
      const b = await tenantWithLineman(t.current, h);
      const theirs = await insertCustomer(t.current, b.tenant.operatorId, { name: "Secret Singh" });
      for (const id of [theirs, uuidv7()]) {
        const error = await failure(await detail(a.lineman.accessToken, id), 404);
        expect(error.code).toBe("CUSTOMER_NOT_FOUND");
        expect(JSON.stringify(error)).not.toContain(theirs);
        expect(JSON.stringify(error)).not.toContain("Secret");
      }
      const bad = await failure(await detail(a.lineman.accessToken, "1045"), 400);
      expect(bad).toMatchObject({ code: "VALIDATION", fields: [{ path: "id" }] });
    });

    it("checks the app version and the token first", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const id = await insertCustomer(t.current, tenant.operatorId);
      expect((await failure(await detail(null, id), 401)).code).toBe("UNAUTHENTICATED");
      expect((await failure(await detail(lineman.accessToken, id, null), 400)).code).toBe(
        "VALIDATION",
      );
      expect((await failure(await detail(lineman.accessToken, id, "1"), 426)).code).toBe(
        "APP_TOO_OLD",
      );
    });
  });

  describe("PATCH /customers/{id}/phone", () => {
    it("corrects the phone once (audited, source android) and is idempotent", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const id = await insertCustomer(t.current, tenant.operatorId);
      await t.current.admin.query("UPDATE customers SET phone = '9876543210' WHERE id = $1", [id]);
      const request = fixture("updateCustomerPhone.request");

      h.clock.advance(60_000);
      const first = await patchPhone(lineman.accessToken, id, request);
      expect(first.status).toBe(200);
      const json = await first.json();
      const body = UpdatePhoneResponse.parse(json);
      expect(Object.keys(json).sort()).toEqual(
        Object.keys(fixture("updateCustomerPhone.response")).sort(),
      );
      expect(body.changed).toBe(true);
      expect(body.customer).toMatchObject({ id, phone: request.phone });
      expect(await contactChanges(id)).toEqual([
        {
          old_value: "9876543210",
          new_value: request.phone,
          source: "android",
          actor_id: lineman.userId,
        },
      ]);
      expect(await phoneAudits(id)).toBe(1);

      // The phone resends after a lost answer: same number → nothing changes.
      for (let i = 0; i < 3; i += 1) {
        const again = UpdatePhoneResponse.parse(
          await (await patchPhone(lineman.accessToken, id, request)).json(),
        );
        expect(again.changed).toBe(false);
        expect(again.customer).toEqual(body.customer);
      }
      expect(await contactChanges(id)).toHaveLength(1);
      expect(await phoneAudits(id)).toBe(1);
    });

    it("refuses an invalid number with 400 VALIDATION and changes nothing", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const id = await insertCustomer(t.current, tenant.operatorId);
      for (const body of [
        { phone: "+919876543210" },
        { phone: "987654321" },
        { phone: "5876543210" },
        {},
        "not json",
      ]) {
        const error = await failure(await patchPhone(lineman.accessToken, id, body), 400);
        expect(error.code).toBe("VALIDATION");
        expect(JSON.stringify(error)).not.toContain("987654");
      }
      expect(await phoneOf(id)).toBeNull();
      expect(await contactChanges(id)).toEqual([]);
    });

    it("404 for another tenant's customer with nothing written; 403 TENANT_READ_ONLY when read-only", async () => {
      const a = await tenantWithLineman(t.current, h);
      const b = await tenantWithLineman(t.current, h);
      const theirs = await insertCustomer(t.current, b.tenant.operatorId);
      const error = await failure(
        await patchPhone(a.lineman.accessToken, theirs, { phone: "9876543299" }),
        404,
      );
      expect(error.code).toBe("CUSTOMER_NOT_FOUND");
      expect(await phoneOf(theirs)).toBeNull();
      expect(await contactChanges(theirs)).toEqual([]);

      const ro = await tenantWithLineman(t.current, h, { subscription: "read_only" });
      const id = await insertCustomer(t.current, ro.tenant.operatorId);
      const refused = await failure(
        await patchPhone(ro.lineman.accessToken, id, { phone: "9876543298" }),
        403,
      );
      expect(refused.code).toBe("TENANT_READ_ONLY");
      expect(await phoneOf(id)).toBeNull();
      // Viewing still works in read-only mode.
      expect((await detail(ro.lineman.accessToken, id)).status).toBe(200);
    });

    it("works for a closed customer (queued receipts may still be shared)", async () => {
      const { tenant, lineman } = await tenantWithLineman(t.current, h);
      const id = await insertCustomer(t.current, tenant.operatorId);
      const owner = await contextFor(h.getDeps().runtime, tenant, "owner");
      await setCustomerStatus.call(h.getDeps().runtime, owner, {
        customerId: id,
        status: "inactive",
      });
      const body = UpdatePhoneResponse.parse(
        await (await patchPhone(lineman.accessToken, id, { phone: "9876543297" })).json(),
      );
      expect(body).toMatchObject({
        changed: true,
        customer: { active: false, phone: "9876543297" },
      });
    });

    it("checks the token before reading the body", async () => {
      const { tenant } = await tenantWithLineman(t.current, h);
      const id = await insertCustomer(t.current, tenant.operatorId);
      expect((await failure(await patchPhone(null, id, { phone: "9876543296" }), 401)).code).toBe(
        "UNAUTHENTICATED",
      );
      expect(await phoneOf(id)).toBeNull();
    });
  });
});
