/**
 * `customers.search` ranking and filters against a real database (T-033, PLAN §12.1): code,
 * phone, VC number (current and past holders) and name (prefix, word, contains, typos, Hindi),
 * the natural code order, area/status filters and pages.
 */
import { areas, customers, type Tx, uuidv7, vcAssets, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { contextFor, seedTenant, testRuntime } from "../testing/fixtures";
import { searchCustomers } from "./queries";
import type { CustomerListRow } from "./types";

describeDb("customers.search", () => {
  const t = useTestDatabase();
  let rt: ServiceRuntime;
  let staff: TenantContext;
  let lineman: TenantContext;
  let north: string;
  let south: string;

  interface Spec {
    code: string;
    name: string;
    phone?: string;
    altPhone?: string;
    area?: "north" | "south";
    status?: "active" | "inactive";
  }

  const SPECS: Spec[] = [
    { code: "1", name: "Ramesh Kumar", phone: "9876543210", area: "north" },
    { code: "2", name: "Suresh Ramesh", phone: "9876500000", area: "north" },
    { code: "10", name: "Paramesh Yadav", phone: "9123498765", area: "south" },
    { code: "12", name: "Sunita Devi", altPhone: "9876543211", area: "south" },
    { code: "101", name: "Rakesh Gupta", area: "south", status: "inactive" },
    { code: "A-1", name: "रमेश शर्मा" },
    { code: "555", name: "Code Five", phone: "5551234567" },
    { code: "B-9", name: "Old Holder", status: "inactive" },
    { code: "B-10", name: "New Holder" },
    { code: "50% off", name: "Percent Shop" },
  ];

  const ids = new Map<string, string>();

  beforeAll(async () => {
    const tenant = await seedTenant(t.current);
    rt = testRuntime(t.current.db);
    staff = await contextFor(rt, tenant, "staff");
    lineman = await contextFor(rt, tenant, "lineman");
    north = uuidv7();
    south = uuidv7();
    const op = tenant.operatorId;
    await t.current.db.withTenant(op, async (tx: Tx) => {
      await tx.insert(areas).values([
        { id: north, operatorId: op, name: "North" },
        { id: south, operatorId: op, name: "South" },
      ]);
      for (const spec of SPECS) {
        const id = uuidv7();
        ids.set(spec.code, id);
        await tx.insert(customers).values({
          id,
          operatorId: op,
          customerCode: spec.code,
          name: spec.name,
          phone: spec.phone ?? null,
          altPhone: spec.altPhone ?? null,
          areaId: spec.area === "north" ? north : spec.area === "south" ? south : null,
          status: spec.status ?? "active",
        });
      }
      // VC "0001 2345 6789": B-9 had it until June, B-10 has it now. "0001 2399 0000": code 12.
      const [shared, other] = [uuidv7(), uuidv7()];
      await tx.insert(vcAssets).values([
        { id: shared, operatorId: op, vcNumber: "0001 2345-6789" },
        { id: other, operatorId: op, vcNumber: "0001 2399 0000" },
      ]);
      await tx.insert(vcAssignments).values([
        {
          operatorId: op,
          vcAssetId: shared,
          customerId: ids.get("B-9") ?? "",
          startDate: "2025-01-01",
          endDate: "2026-06-30",
          status: "disconnected",
          rentalAmountPaise: 25_000,
        },
        {
          operatorId: op,
          vcAssetId: shared,
          customerId: ids.get("B-10") ?? "",
          startDate: "2026-07-01",
          rentalAmountPaise: 25_000,
        },
        {
          operatorId: op,
          vcAssetId: other,
          customerId: ids.get("12") ?? "",
          startDate: "2026-07-01",
          rentalAmountPaise: 25_000,
        },
      ]);
    });
    // Another tenant with look-alike customers must never show up.
    const otherTenant = await seedTenant(t.current);
    await t.current.db.withTenant(otherTenant.operatorId, (tx) =>
      tx.insert(customers).values({
        operatorId: otherTenant.operatorId,
        customerCode: "1",
        name: "Ramesh Kumar",
        phone: "9876543210",
      }),
    );
  }, 60_000);

  async function search(input: Parameters<typeof searchCustomers.call>[2], ctx = staff) {
    const result = await searchCustomers.call(rt, ctx, input);
    if (!result.ok) throw new Error(`search failed: ${JSON.stringify(result.error)}`);
    return result.value;
  }
  const codes = (rows: readonly CustomerListRow[]) => rows.map((r) => r.customerCode);

  it("lists everyone in natural code order without search text", async () => {
    const { rows, hasMore } = await search({});
    expect(codes(rows)).toEqual([
      "1",
      "2",
      "10",
      "12",
      "101",
      "555",
      "50% off",
      "A-1",
      "B-10",
      "B-9",
    ]);
    expect(hasMore).toBe(false);
    expect(rows.every((r) => r.match === "all")).toBe(true);
    expect(rows[0]).toMatchObject({ name: "Ramesh Kumar", areaName: "North", balancePaise: 0 });
  });

  it("puts the exact code first, then codes that start with it", async () => {
    expect(codes((await search({ q: "1" })).rows)).toEqual(["1", "10", "12", "101"]);
    expect(codes((await search({ q: "10" })).rows)).toEqual(["10", "101"]);
    expect(codes((await search({ q: "a-1" })).rows)[0]).toBe("A-1");
  });

  it("finds a phone or alternate phone by its digits, the exact number first", async () => {
    const exact = await search({ q: "+91 98765 43210" });
    expect(codes(exact.rows)[0]).toBe("1");
    expect(exact.rows[0]?.match).toBe("phone");
    // Prefix "98765": main and alternate numbers; "…98765" in the middle comes after.
    expect(codes((await search({ q: "98765" })).rows)).toEqual(["1", "2", "12", "10"]);
  });

  it("ranks an exact code above a phone that starts with the same digits", async () => {
    expect(codes((await search({ q: "555" })).rows)[0]).toBe("555");
  });

  it("finds a VC number typed with or without spaces; the current holder before the past one", async () => {
    const result = await search({ q: "000123456789" });
    expect(codes(result.rows)).toEqual(["B-10", "B-9"]);
    expect(result.rows[0]).toMatchObject({ match: "vc", matchedVcNumber: "0001 2345-6789" });
    expect(codes((await search({ q: "0001 23" })).rows)).toEqual(["12", "B-10", "B-9"]);
  });

  it("ranks names: starts with, then a word starts with, then contains, then typos", async () => {
    const ramesh = codes((await search({ q: "ramesh" })).rows);
    // "Rakesh" (word similarity 0.4) stays out.
    expect(ramesh).toEqual(["1", "2", "10"]);
    const typo = await search({ q: "ramsh" });
    expect(codes(typo.rows).slice(0, 2)).toEqual(["2", "1"]);
    expect(typo.rows[0]?.match).toBe("name");
    expect(codes((await search({ q: "sunta" })).rows)).toEqual(["12"]);
    expect(codes((await search({ q: "रमेश" })).rows)).toEqual(["A-1"]);
  });

  it("treats LIKE wildcards as plain characters", async () => {
    expect(codes((await search({ q: "50%" })).rows)).toEqual(["50% off"]);
    expect(codes((await search({ q: "%" })).rows)).toEqual([]);
    expect(codes((await search({ q: "_" })).rows)).toEqual([]);
  });

  it("filters by status and area (or no area)", async () => {
    expect(codes((await search({ status: "inactive" })).rows)).toEqual(["101", "B-9"]);
    expect(codes((await search({ q: "r", status: "active", areaId: north })).rows)).toEqual(["1"]);
    expect(codes((await search({ areaId: south })).rows)).toEqual(["10", "12", "101"]);
    expect(codes((await search({ areaId: "none", status: "active" })).rows)).toEqual([
      "555",
      "50% off",
      "A-1",
      "B-10",
    ]);
  });

  it("pages with limit and offset", async () => {
    const first = await search({ limit: 4 });
    expect(codes(first.rows)).toEqual(["1", "2", "10", "12"]);
    expect(first.hasMore).toBe(true);
    const last = await search({ limit: 4, offset: 8 });
    expect(codes(last.rows)).toEqual(["B-10", "B-9"]);
    expect(last.hasMore).toBe(false);
  });

  it("works for the lineman and never shows another tenant's customers", async () => {
    const result = await search({ q: "Ramesh Kumar" }, lineman);
    expect(result.rows[0]?.id).toBe(ids.get("1"));
    const own = new Set(ids.values());
    expect(result.rows.every((r) => own.has(r.id))).toBe(true);
  });
});
