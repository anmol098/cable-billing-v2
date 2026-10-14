/**
 * CSV exports (T-082) against a real database: two scripted tenants (T-080's report world and
 * T-081's operations world). Every export has exactly the rows the on-screen service shows for the
 * same filters (walked here in pages of 2 to cross many page edges), Owner only, one audit event per
 * export (none for a refused one), another tenant's ids NOT_FOUND, rate limit, row cap, read-only
 * mode, and no row of one tenant in the other's export.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryRateLimiter, type RateLimiter } from "../auth/rate-limit";
import type { AnyService } from "../context/service";
import { searchCustomers } from "../customers/queries";
import { listPayments } from "../payment-register/queries";
import { duesReport } from "../reports/dues/queries";
import { buildReportWorld, type ReportWorld } from "../reports/dues/test-world";
import { billingRunReport } from "../reports/operations/billing-runs";
import { collectionsReport } from "../reports/operations/collections";
import { connectionsReport } from "../reports/operations/connections";
import { handoverReport } from "../reports/operations/handover";
import { buildOperationsWorld, type OperationsWorld } from "../reports/operations/test-world";
import { billRegisterReport } from "../reports/registers/bills";
import { contextFor, seedTenant, testRuntime } from "../testing/fixtures";
import { collectUuids } from "../testing/isolation";
import type { ExportInput, ExportKind } from "./kinds";
import { type AnyExportHandle, type OpenExportOptions, openExport } from "./open";
import { startExport } from "./service";

const TIMEOUT = 180_000;
const NOW = new Date("2026-11-02T04:30:00.000Z");
const SMALL: OpenExportOptions = { limits: { reportPageSize: 2, listPageSize: 2 } };

async function rowsOf(handle: AnyExportHandle): Promise<unknown[]> {
  const rows: unknown[] = [];
  for await (const page of handle.pages() as AsyncGenerator<readonly unknown[]>) rows.push(...page);
  return rows;
}

describeDb("exports (T-082)", () => {
  const t = useTestDatabase();
  let money: ReportWorld;
  let ops: OperationsWorld;

  beforeAll(async () => {
    money = await buildReportWorld(t.current);
    ops = await buildOperationsWorld(t.current);
  }, TIMEOUT);

  const world = (kind: ExportKind) =>
    ["customers", "bills", "payments", "dues"].includes(kind) ? money : ops;

  async function exportRows(input: ExportInput, options: OpenExportOptions = SMALL) {
    const w = world(input.kind);
    const result = await openExport(w.rt(NOW), w.owner, input, options);
    if (!result.ok) throw new Error(`export ${input.kind}: ${result.error.code}`);
    const rows = await rowsOf(result.value);
    return { handle: result.value, rows };
  }

  /** The on-screen service's rows for the same filters, walked at its own page size. */
  async function screenRows(input: ExportInput): Promise<unknown[]> {
    const w = world(input.kind);
    const rt = w.rt(NOW);
    const out: unknown[] = [];
    const list = async (service: AnyService) => {
      for (let offset = 0; ; offset += 50) {
        const r = await service.call(rt, w.owner, { ...input.filters, limit: 50, offset });
        if (!r.ok) throw new Error(`${service.name}: ${r.error.code}`);
        out.push(...r.value.rows);
        if (!r.value.hasMore) return out;
      }
    };
    const report = async (service: AnyService) => {
      for (let page = 1; ; page += 1) {
        const r = await service.call(rt, w.owner, { ...input.filters, page });
        if (!r.ok) throw new Error(`${service.name}: ${r.error.code}`);
        out.push(...r.value.rows);
        const total = r.value.rowCount as number | undefined;
        const more =
          total === undefined ? r.value.rows.length === r.value.pageSize : page * 50 < total;
        if (!more) return out;
      }
    };
    switch (input.kind) {
      case "customers":
        return list(searchCustomers);
      case "payments":
        return list(listPayments);
      case "bills":
        return report(billRegisterReport);
      case "dues":
        return report(duesReport);
      case "collections":
        return report(collectionsReport);
      case "handover":
        return report(handoverReport);
      case "connections":
        return report(connectionsReport);
      case "billing_runs":
        return report(billingRunReport);
    }
  }

  async function auditCount(operatorId: string): Promise<number> {
    const r = await t.current.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE operator_id = $1 AND action = 'exports.download'",
      [operatorId],
    );
    return r.rows[0]?.n ?? 0;
  }

  async function lastAudit(operatorId: string) {
    const r = await t.current.admin.query<{
      actor_id: string;
      actor_role: string;
      entity_type: string;
      entity_id: string | null;
      after: Record<string, unknown>;
      request_id: string | null;
    }>(
      `SELECT actor_id, actor_role, entity_type, entity_id, after, request_id FROM audit_events
        WHERE operator_id = $1 AND action = 'exports.download' ORDER BY at DESC, id DESC LIMIT 1`,
      [operatorId],
    );
    return r.rows[0];
  }

  const CASES: readonly { name: string; input: ExportInput; min: number }[] = [
    { name: "customers, everyone", input: { kind: "customers", filters: {} }, min: 6 },
    {
      name: "customers without an area",
      input: { kind: "customers", filters: { areaId: "none" } },
      min: 1,
    },
    {
      name: "bills over 5 months",
      input: { kind: "bills", filters: { from: "2026-06-01", to: "2026-10-01" } },
      min: 6,
    },
    { name: "payments, all", input: { kind: "payments", filters: {} }, min: 5 },
    { name: "payments, cash", input: { kind: "payments", filters: { method: "cash" } }, min: 3 },
    { name: "dues now", input: { kind: "dues", filters: {} }, min: 3 },
    {
      name: "dues at the end of 31 Oct",
      input: { kind: "dues", filters: { asOfDate: "2026-10-31" } },
      min: 3,
    },
    { name: "credit list", input: { kind: "dues", filters: { kind: "advance" } }, min: 1 },
    {
      name: "collections over 31 days",
      input: { kind: "collections", filters: { from: "2026-10-03", to: "2026-11-02" } },
      min: 3,
    },
    {
      name: "handovers over 31 days",
      input: { kind: "handover", filters: { from: "2026-10-03", to: "2026-11-02" } },
      min: 2,
    },
    {
      name: "connections on 1 Nov",
      input: { kind: "connections", filters: { date: "2026-11-01" } },
      min: 3,
    },
    {
      name: "the November bill run",
      input: { kind: "billing_runs", filters: { period: "2026-11-01" } },
      min: 3,
    },
  ];

  describe("rows", () => {
    for (const { name, input, min } of CASES) {
      it(`${name}: the export has exactly the on-screen rows, in order`, async () => {
        const screen = await screenRows(input);
        expect(screen.length).toBeGreaterThanOrEqual(min);
        const { rows, handle } = await exportRows(input);
        expect(rows).toEqual(screen);
        expect(handle.truncated).toBe(false);
        // Default page sizes give the same rows.
        const { rows: big } = await exportRows(input, {});
        expect(big).toEqual(screen);
      }, 60_000);
    }

    it("an export never has a row of another tenant", async () => {
      const moneyIds = new Set<string>([money.tenant.operatorId]);
      const opsIds = new Set<string>([ops.tenant.operatorId]);
      for (const { input } of CASES) {
        const { rows } = await exportRows(input, {});
        const mine = world(input.kind) === money ? moneyIds : opsIds;
        for (const id of collectUuids(rows)) mine.add(id);
      }
      for (const kind of ["customers", "payments", "dues"] as const) {
        const result = await openExport(ops.rt(NOW), ops.owner, { kind, filters: {} }, {});
        if (!result.ok) throw new Error(result.error.code);
        const leaked = [...collectUuids(await rowsOf(result.value))].filter((id) =>
          moneyIds.has(id),
        );
        expect(leaked, kind).toEqual([]);
      }
      const result = await openExport(money.rt(NOW), money.owner, {
        kind: "connections",
        filters: { date: "2026-11-01" },
      });
      if (!result.ok) throw new Error(result.error.code);
      const leaked = [...collectUuids(await rowsOf(result.value))].filter((id) => opsIds.has(id));
      expect(leaked).toEqual([]);
    }, 120_000);

    it("says when the numbers are from", async () => {
      const dues = await exportRows({ kind: "dues", filters: { asOfDate: "2026-10-31" } });
      // The end of 31 Oct IST (the next 00:00 IST).
      expect(dues.handle.asOf.toISOString()).toBe("2026-10-31T18:30:00.000Z");
      const now = await exportRows({ kind: "customers", filters: {} });
      expect(now.handle.asOf).toEqual(NOW);
    });

    it("stops at the row cap and says so", async () => {
      const all = await screenRows({ kind: "customers", filters: {} });
      const capped = await exportRows(
        { kind: "customers", filters: {} },
        { limits: { listPageSize: 2, maxRows: 3 } },
      );
      expect(capped.rows).toEqual(all.slice(0, 3));
      expect(capped.handle.truncated).toBe(true);
      const exact = await exportRows(
        { kind: "customers", filters: {} },
        { limits: { listPageSize: 2, maxRows: all.length } },
      );
      expect(exact.rows).toEqual(all);
      expect(exact.handle.truncated).toBe(false);
      const report = await exportRows(
        { kind: "bills", filters: { from: "2026-06-01", to: "2026-10-01" } },
        { limits: { reportPageSize: 2, maxRows: 5 } },
      );
      expect(report.rows).toHaveLength(5);
      expect(report.handle.truncated).toBe(true);
    });

    it("reads its pages once", async () => {
      const result = await openExport(money.rt(NOW), money.owner, {
        kind: "customers",
        filters: {},
      });
      if (!result.ok) throw new Error(result.error.code);
      await rowsOf(result.value);
      await expect(rowsOf(result.value)).rejects.toThrow(/only once/);
    });
  });

  describe("who and the audit", () => {
    it("Staff and linemen are refused before anything is read or written", async () => {
      const before = await auditCount(money.tenant.operatorId);
      for (const ctx of [money.staff, money.lineman]) {
        const result = await openExport(money.rt(NOW), ctx, { kind: "customers", filters: {} });
        expect(result.ok ? "ok" : result.error.code).toBe("FORBIDDEN");
        // The service refuses on its own too (the gate is not only in openExport).
        const direct = await startExport.call(money.rt(NOW), ctx, {
          kind: "customers",
          filters: {},
        });
        expect(direct.ok ? "ok" : direct.error.code).toBe("FORBIDDEN");
      }
      expect(await auditCount(money.tenant.operatorId)).toBe(before);
    });

    it("records one audit event per export: who, what and which filters, never the search text", async () => {
      const op = money.tenant.operatorId;
      const before = await auditCount(op);
      await exportRows({ kind: "payments", filters: { method: "upi", from: "2026-07-01" } });
      expect(await auditCount(op)).toBe(before + 1);
      const payments = await lastAudit(op);
      expect(payments).toMatchObject({
        actor_id: money.tenant.users.owner,
        actor_role: "owner",
        entity_type: "export",
        entity_id: null,
        request_id: money.owner.requestId,
      });
      expect(payments?.after).toEqual({
        report: "payments",
        method: "upi",
        from: "2026-07-01",
        status: "all",
      });

      await exportRows({ kind: "customers", filters: { q: "9876543", areaId: money.north } });
      expect(await auditCount(op)).toBe(before + 2);
      const customers = await lastAudit(op);
      expect(customers?.after).toEqual({
        report: "customers",
        area_id: money.north,
        status: "all",
        searched: true,
      });
      expect(JSON.stringify(customers?.after)).not.toContain("9876543");

      await exportRows({ kind: "dues", filters: { kind: "advance" } });
      expect((await lastAudit(op))?.after).toEqual({ report: "dues", kind: "advance" });
    });

    it("another tenant's area, person, customer or plan is NOT_FOUND and nothing is written", async () => {
      const op = money.tenant.operatorId;
      const before = await auditCount(op);
      const refused: ExportInput[] = [
        { kind: "customers", filters: { areaId: ops.north } },
        { kind: "dues", filters: { areaId: ops.north } },
        { kind: "payments", filters: { collectorId: ops.ravi.userId } },
        { kind: "payments", filters: { customerId: ops.customers.asha } },
        { kind: "collections", filters: { collectorId: ops.ravi.userId } },
        { kind: "handover", filters: { linemanId: ops.ravi.userId } },
        { kind: "connections", filters: { plan: ops.basic } },
        { kind: "billing_runs", filters: { areaId: ops.south } },
      ];
      for (const input of refused) {
        const result = await openExport(money.rt(NOW), money.owner, input);
        expect(result.ok ? "ok" : result.error.code, input.kind).toBe("NOT_FOUND");
      }
      expect(await auditCount(op)).toBe(before);
    });

    it("bad filters are VALIDATION and nothing is written", async () => {
      const op = money.tenant.operatorId;
      const before = await auditCount(op);
      const bad = [
        { kind: "bills", filters: { from: "2025-01-01", to: "2026-10-01" } },
        { kind: "collections", filters: { from: "2026-09-01", to: "2026-11-02" } },
        { kind: "dues", filters: { asOfDate: "2099-01-01" } },
        { kind: "everything", filters: {} },
        { kind: "payments", filters: { method: "cheque" } },
      ] as unknown as ExportInput[];
      for (const input of bad) {
        const result = await openExport(money.rt(NOW), money.owner, input);
        expect(result.ok ? "ok" : result.error.code, JSON.stringify(input)).toBe("VALIDATION");
      }
      expect(await auditCount(op)).toBe(before);
    });

    it("is rate-limited per person; a limiter that is down lets the export through", async () => {
      const op = money.tenant.operatorId;
      const limiter = createMemoryRateLimiter();
      const rule = { limit: 2, windowSeconds: 600 };
      const input: ExportInput = { kind: "customers", filters: {} };
      const before = await auditCount(op);
      const codes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await openExport(money.rt(NOW), money.owner, input, {
          rateLimiter: limiter,
          rateLimit: rule,
        });
        codes.push(r.ok ? "ok" : r.error.code);
        if (!r.ok && r.error.code === "RATE_LIMITED") {
          expect(r.error.details?.retryAfterSeconds).toBeGreaterThan(0);
        }
      }
      expect(codes).toEqual(["ok", "ok", "RATE_LIMITED"]);
      expect(await auditCount(op)).toBe(before + 2);
      // Another person (another business's owner) has their own count.
      const other = await openExport(ops.rt(NOW), ops.owner, input, {
        rateLimiter: limiter,
        rateLimit: rule,
      });
      expect(other.ok).toBe(true);
      const broken: RateLimiter = {
        kind: "upstash",
        hit: async () => {
          throw new Error("redis down");
        },
      };
      const through = await openExport(money.rt(NOW), money.owner, input, {
        rateLimiter: broken,
      });
      expect(through.ok).toBe(true);
    });

    it("works in read-only mode (the data stays the business's to take)", async () => {
      const tenant = await seedTenant(t.current, { subscription: "read_only" });
      const rt = testRuntime(t.current.db, { now: () => NOW });
      const owner = await contextFor(rt, tenant, "owner");
      const result = await openExport(rt, owner, { kind: "customers", filters: {} });
      if (!result.ok) throw new Error(result.error.code);
      expect(await rowsOf(result.value)).toEqual([]);
      expect(await auditCount(tenant.operatorId)).toBe(1);
    });
  });
});
