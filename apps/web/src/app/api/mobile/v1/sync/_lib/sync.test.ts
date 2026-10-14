// @vitest-environment node
/**
 * `GET /api/mobile/v1/sync/customers` (T-060) against a real database, the real T-028 sign-in and
 * an injected clock. Every 200 body is parsed with the contract (`SyncCustomersResponse`), every
 * error with `ErrorResponse`.
 *
 * Covered: full sync in pages, delta with tombstones, the cursor's refusals (CURSOR_INVALID),
 * query validation, gzip, the 1,000-customer size budget (< 1 MB gzipped, PLAN §10.3), read-only
 * tenants, the version gate and auth, and isolation (another tenant's customers never appear).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  ErrorResponse,
  ROSTER_PAGE_MAX,
  RosterCustomer,
  SyncCustomersResponse,
} from "@cb/contracts";
import { revokeDevice, setCustomerStatus, updateCustomer } from "@cb/core";
import { contextFor } from "@cb/core/testing";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  insertCustomer,
  issueBill,
  type MobileApiHarness,
  mobileApiHarness,
  mobileRequest,
  tenantWithLineman,
} from "../../payments/_lib/test-support";
import { acceptsGzip, syncCustomersHandler } from "./sync";

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

/** Every key path of a JSON value (arrays by their first element). */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.length > 0 ? keyPaths(value[0], `${prefix}[]`) : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keyPaths(nested, path)];
  });
}

describeDb("roster sync API (T-060)", () => {
  const t = useTestDatabase();
  let h: MobileApiHarness;
  let GET: ReturnType<typeof syncCustomersHandler>;

  beforeAll(() => {
    h = mobileApiHarness(t.current, NOW);
    GET = syncCustomersHandler(h.getDeps);
  });

  function request(
    token: string | null,
    query: Record<string, string> = {},
    options: { gzip?: boolean; version?: string | null } = {},
  ): Request {
    const search = new URLSearchParams(query).toString();
    const base = mobileRequest(`/sync/customers${search ? `?${search}` : ""}`, {
      method: "GET",
      token,
      ...(options.version === undefined ? {} : { version: options.version }),
    });
    const headers = new Headers(base.headers);
    if (options.gzip) headers.set("accept-encoding", "gzip");
    return new Request(base.url, { method: "GET", headers });
  }

  async function body(response: Response): Promise<unknown> {
    const bytes = Buffer.from(await response.arrayBuffer());
    const text =
      response.headers.get("content-encoding") === "gzip"
        ? gunzipSync(bytes).toString("utf8")
        : bytes.toString("utf8");
    return JSON.parse(text);
  }

  async function okPage(response: Response) {
    expect(response.status).toBe(200);
    return SyncCustomersResponse.parse(await body(response));
  }

  async function failure(response: Response, status: number) {
    expect(response.status).toBe(status);
    return ErrorResponse.parse(await body(response)).error;
  }

  /** All pages of one sync. */
  async function syncAll(token: string, cursor?: string, limit?: number) {
    const pages = [];
    let next = cursor;
    for (let i = 0; i < 50; i += 1) {
      const query: Record<string, string> = {};
      if (next) query.cursor = next;
      if (limit) query.limit = String(limit);
      const page = await okPage(await GET(request(token, query)));
      pages.push(page);
      next = page.next_cursor;
      if (!page.has_more) return pages;
    }
    throw new Error("sync did not finish");
  }

  it("pages a full sync, then sends changes with tombstones; every page matches the contract", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await insertCustomer(t.current, tenant.operatorId, { name: `Grahak ${i}` }));
    }
    const closed = await insertCustomer(t.current, tenant.operatorId, { status: "inactive" });
    await issueBill(t.current, tenant.operatorId, ids[0] as string, "2026-10-01", 45_000);

    const full = await syncAll(lineman.accessToken, undefined, 2);
    expect(
      full.map((p) => [p.customers.length, p.removed_customer_ids.length, p.has_more]),
    ).toEqual([
      [2, 0, true],
      [2, 0, true],
      [1, 0, false],
    ]);
    const rows = full.flatMap((p) => p.customers);
    expect(rows.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(rows.map((c) => c.id)).not.toContain(closed);
    const billed = rows.find((c) => c.id === ids[0]);
    expect(billed).toMatchObject({
      active: true,
      balance_paise: 45_000,
      open_bills: { count: 1, outstanding_paise: 45_000, oldest_period: "2026-10-01" },
    });
    // Same fields as the contract fixture (no more, no fewer).
    const sample = fixture("syncCustomers.response");
    expect(Object.keys(full[0] ?? {}).sort()).toEqual(Object.keys(sample).sort());
    expect(keyPaths(billed).sort()).toEqual(
      keyPaths(sample.customers[1])
        .filter((p) => !p.startsWith("area.") && !p.startsWith("connections[]"))
        .sort(),
    );
    for (const row of rows) RosterCustomer.parse(row);

    // Changes: one edit, one close, one reopen.
    const owner = await contextFor(h.getDeps().runtime, tenant, "owner");
    h.clock.advance(60_000);
    const rt = h.getDeps().runtime;
    expect(
      (await updateCustomer.call(rt, owner, { customerId: ids[1] as string, name: "Naya Naam" }))
        .ok,
    ).toBe(true);
    expect(
      (
        await setCustomerStatus.call(rt, owner, {
          customerId: ids[2] as string,
          status: "inactive",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await setCustomerStatus.call(rt, owner, { customerId: closed, status: "active" })).ok,
    ).toBe(true);
    const delta = await syncAll(lineman.accessToken, full.at(-1)?.next_cursor);
    const changed = delta.flatMap((p) => p.customers);
    expect(changed.find((c) => c.id === ids[1])?.name).toBe("Naya Naam");
    expect(changed.map((c) => c.id)).toContain(closed);
    expect(delta.flatMap((p) => p.removed_customer_ids)).toEqual([ids[2]]);
    expect(changed.map((c) => c.id)).not.toContain(ids[2]);
  });

  it("refuses bad cursors with CURSOR_INVALID and a bad limit with VALIDATION", async () => {
    const { lineman } = await tenantWithLineman(t.current, h);
    const other = await tenantWithLineman(t.current, h);
    await insertCustomer(t.current, other.tenant.operatorId);
    const [theirs] = await syncAll(other.lineman.accessToken);
    for (const cursor of ["garbage", "e30", theirs?.next_cursor ?? ""]) {
      const error = await failure(await GET(request(lineman.accessToken, { cursor })), 400);
      expect(error.code).toBe("CURSOR_INVALID");
      expect(JSON.stringify(error)).not.toContain(other.tenant.operatorId);
    }
    for (const limit of ["0", String(ROSTER_PAGE_MAX + 1), "abc", "1.5"]) {
      const error = await failure(await GET(request(lineman.accessToken, { limit })), 400);
      expect(error).toMatchObject({ code: "VALIDATION", fields: [{ path: "query.limit" }] });
    }
    const tooLong = await failure(
      await GET(request(lineman.accessToken, { cursor: "x".repeat(513) })),
      400,
    );
    expect(tooLong.code).toBe("VALIDATION");
    // Exactly the maximum is fine.
    await okPage(await GET(request(lineman.accessToken, { limit: String(ROSTER_PAGE_MAX) })));
  });

  it("gzips the body when the phone accepts it", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    for (let i = 0; i < 20; i += 1) await insertCustomer(t.current, tenant.operatorId);
    const zipped = await GET(request(lineman.accessToken, {}, { gzip: true }));
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toContain("Accept-Encoding");
    expect(zipped.headers.get("cache-control")).toBe("no-store");
    expect((await okPage(zipped)).customers).toHaveLength(20);
    const plain = await GET(request(lineman.accessToken));
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect((await okPage(plain)).customers).toHaveLength(20);

    const accepts = (value: string) =>
      acceptsGzip(new Request("http://x", { headers: { "accept-encoding": value } }));
    expect(accepts("gzip")).toBe(true);
    expect(accepts("br, gzip;q=0.5")).toBe(true);
    expect(accepts("*")).toBe(true);
    expect(accepts("gzip;q=0")).toBe(false);
    expect(accepts("identity")).toBe(false);
  });

  it("keeps the full roster of 1,000 customers under 1 MB gzipped", {
    timeout: 120_000,
  }, async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    await t.current.admin.query(
      `INSERT INTO areas (id, operator_id, name)
       SELECT gen_random_uuid(), $1, 'Mohalla ' || g FROM generate_series(1, 12) g`,
      [tenant.operatorId],
    );
    // Realistic rows: Hindi and English names, phones, addresses, an area, 1–2 VCs, a balance and
    // two unpaid bills each (the largest roster row the phone normally gets).
    await t.current.admin.query(
      `WITH a AS (SELECT array_agg(id ORDER BY name) AS ids FROM areas WHERE operator_id = $1)
       INSERT INTO customers (id, operator_id, customer_code, name, phone, alt_phone, address, area_id)
       SELECT gen_random_uuid(), $1, (1000 + g)::text,
         (ARRAY['Ramesh Kumar','सुनीता देवी','Mohammad Iqbal','राजेश शर्मा','Pooja Verma','अनिल यादव','Suresh Prajapati','गीता कुमारी'])[1 + g % 8] || ' ' || g,
         '9' || lpad(((g * 7919) % 1000000000)::text, 9, '0'),
         CASE WHEN g % 4 = 0 THEN '8' || lpad(((g * 104729) % 1000000000)::text, 9, '0') END,
         'House ' || g || ', Gali No. ' || (g % 23) || ', Near Shiv Mandir, Ward ' || (g % 30),
         a.ids[1 + g % 12]
       FROM generate_series(1, 1000) g, a`,
      [tenant.operatorId],
    );
    await t.current.admin.query(
      `INSERT INTO vc_assets (id, operator_id, vc_number)
       SELECT gen_random_uuid(), $1, lpad((100000000000 + row_number() OVER (ORDER BY c.id) * 2 + k)::text, 12, '0')
       FROM customers c CROSS JOIN generate_series(0, 1) k
       WHERE c.operator_id = $1 AND (k = 0 OR c.customer_code::int % 3 = 0)`,
      [tenant.operatorId],
    );
    await t.current.admin.query(
      `INSERT INTO vc_assignments (id, operator_id, vc_asset_id, customer_id, start_date, rental_amount_paise)
       SELECT gen_random_uuid(), $1, v.id, c.id, '2026-01-01', 30000
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM vc_assets WHERE operator_id = $1) v
       JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM customers WHERE operator_id = $1) c
         ON c.n = 1 + (v.n - 1) % 1000`,
      [tenant.operatorId],
    );
    await t.current.admin.query(
      `INSERT INTO invoices (id, operator_id, customer_id, period, invoice_number, opening_balance_paise, charges_paise, total_due_paise)
       SELECT gen_random_uuid(), $1, c.id, p.period::date,
         'INV-' || to_char(p.period::date, 'YYMM') || '-' || lpad(c.customer_code, 5, '0'),
         0, 30000, 30000
       FROM customers c CROSS JOIN (VALUES ('2026-09-01'), ('2026-10-01')) p(period)
       WHERE c.operator_id = $1`,
      [tenant.operatorId],
    );
    await t.current.admin.query(
      `INSERT INTO customer_balances (customer_id, operator_id, balance_paise, oldest_due_period)
       SELECT id, $1, 60000, '2026-09-01' FROM customers WHERE operator_id = $1`,
      [tenant.operatorId],
    );

    let gzipped = 0;
    let raw = 0;
    let customers = 0;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await GET(
        request(lineman.accessToken, cursor ? { cursor } : {}, { gzip: true }),
      );
      expect(response.headers.get("content-encoding")).toBe("gzip");
      const bytes = Buffer.from(await response.arrayBuffer());
      gzipped += bytes.length;
      const text = gunzipSync(bytes).toString("utf8");
      raw += Buffer.byteLength(text);
      const page = SyncCustomersResponse.parse(JSON.parse(text));
      customers += page.customers.length;
      pages += 1;
      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);

    expect(customers).toBe(1000);
    expect(pages).toBe(2);
    expect(gzipped).toBeLessThan(1_000_000);
    // Measured when written (T-060 completion notes): 55,127 bytes gzipped, 520,776 bytes JSON.
    // The unzipped JSON stays near half a megabyte, so gzip gives a wide margin.
    expect(raw).toBeLessThan(2_000_000);
  });

  it("works in a read-only tenant (D-13: viewing and collecting go on)", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h, {
      subscription: "read_only",
    });
    const id = await insertCustomer(t.current, tenant.operatorId);
    const [page] = await syncAll(lineman.accessToken);
    expect(page?.customers.map((c) => c.id)).toEqual([id]);
  });

  it("checks the app version and the token before reading anything", async () => {
    const { tenant, lineman } = await tenantWithLineman(t.current, h);
    await insertCustomer(t.current, tenant.operatorId);
    expect((await failure(await GET(request(null)), 401)).code).toBe("UNAUTHENTICATED");
    expect((await failure(await GET(request("cbm1.forged.token")), 401)).code).toBe(
      "UNAUTHENTICATED",
    );
    expect(
      (await failure(await GET(request(lineman.accessToken, {}, { version: null })), 400)).code,
    ).toBe("VALIDATION");
    const old = await failure(await GET(request(lineman.accessToken, {}, { version: "2" })), 426);
    expect(old).toMatchObject({ code: "APP_TOO_OLD", min_app_version_code: 3 });

    const owner = await contextFor(h.getDeps().runtime, tenant, "owner");
    const revoked = await revokeDevice.call(h.getDeps().runtime, owner, {
      deviceId: lineman.deviceId,
    });
    expect(revoked.ok).toBe(true);
    expect((await failure(await GET(request(lineman.accessToken)), 401)).code).toBe(
      "DEVICE_REVOKED",
    );
  });

  describe("isolation", () => {
    it("never shows another tenant's customers, in a full sync or a delta", async () => {
      const a = await tenantWithLineman(t.current, h);
      const b = await tenantWithLineman(t.current, h);
      const mine = await insertCustomer(t.current, a.tenant.operatorId);
      const theirs = await insertCustomer(t.current, b.tenant.operatorId);
      const full = await syncAll(a.lineman.accessToken);
      const ownerB = await contextFor(h.getDeps().runtime, b.tenant, "owner");
      await updateCustomer.call(h.getDeps().runtime, ownerB, {
        customerId: theirs,
        name: "Changed",
      });
      const delta = await syncAll(a.lineman.accessToken, full.at(-1)?.next_cursor);
      const text = JSON.stringify([full, delta]);
      expect(text).toContain(mine);
      expect(text).not.toContain(theirs);
      expect(text).not.toContain(b.tenant.operatorId);
    });
  });
});
