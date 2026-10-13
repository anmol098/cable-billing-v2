/**
 * The two tenant-level invariants of PLAN §14 that constraints already enforce: no overlapping VC
 * assignments (RULE-06, `vc_assignments_no_overlap`) and one regular invoice per customer and
 * period (RULE-05, `invoices_one_regular_per_period`). To show the nightly check would notice if
 * a constraint were ever dropped or bypassed, this file drops both **in its own throwaway test
 * database** (every test file gets a fresh clone) and injects the rows they would refuse.
 */
import { uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, expect, it } from "vitest";
import { checkTenantInvariants } from "./check";
import { insertAssignment, seedHealthyBooks } from "./test-support";

const NOW = new Date("2026-11-10T06:00:00.000Z");

describeDb("checkTenantInvariants without the database's own guards", () => {
  const t = useTestDatabase();
  const q = (text: string, params: unknown[] = []) => t.current.admin.query(text, params);
  const check = (operatorId: string) =>
    t.current.db.withTenant(operatorId, (tx) => checkTenantInvariants(tx, operatorId), {
      accessMode: "read only",
    });

  beforeAll(async () => {
    await q("ALTER TABLE vc_assignments DROP CONSTRAINT vc_assignments_no_overlap");
    await q("DROP INDEX invoices_one_regular_per_period");
  });

  it("reports overlapping assignments of one VC (closed and open-ended), not touching ones", async () => {
    const books = await seedHealthyBooks(t.current, NOW);
    const other = await seedHealthyBooks(t.current, NOW);
    expect((await check(books.operatorId)).violationCount).toBe(0);
    const { assetId, customerId, assignmentIds } = books.connected;
    // [10 Jan … 31 May] and [1 Jun …) are on this VC. Add [31 May … 2 Jun]: overlaps both
    // (inclusive ends), and an open-ended one from 1 Sep: overlaps the open [1 Jun …).
    const bridging = await insertAssignment(t.current, {
      operatorId: books.operatorId,
      customerId,
      assetId,
      startDate: "2026-05-31",
      endDate: "2026-06-02",
    });
    const openEnded = await insertAssignment(t.current, {
      operatorId: books.operatorId,
      customerId,
      assetId,
      startDate: "2026-09-01",
    });
    const report = await check(books.operatorId);
    expect(report.counts).toEqual({ OVERLAPPING_ASSIGNMENTS: 3 });
    const pairs = report.samples.map((s) => [s.entityId, s.details.overlapsAssignmentId]);
    const [first, reuse] = assignmentIds;
    expect(pairs).toEqual(
      expect.arrayContaining([
        [bridging, first],
        [bridging, reuse],
        [openEnded, reuse],
      ]),
    );
    for (const s of report.samples) {
      expect(s).toMatchObject({
        entityType: "vc_assignment",
        customerId,
        details: { vcAssetId: assetId },
      });
    }
    expect((await check(other.operatorId)).violationCount).toBe(0);
  }, 60_000);

  it("reports a second regular invoice for the same customer and period", async () => {
    const books = await seedHealthyBooks(t.current, NOW);
    const other = await seedHealthyBooks(t.current, NOW);
    await q(
      `INSERT INTO invoices (id, operator_id, customer_id, period, invoice_number, kind,
                             opening_balance_paise, charges_paise, total_due_paise)
       VALUES ($1, $2, $3, '2026-10-01', 'INV-DUP-00001', 'regular', 0, 0, 0)`,
      [uuidv7(), books.operatorId, books.partly.customerId],
    );
    // An opening-balance invoice in the same period is allowed (not a regular bill).
    await q(
      `INSERT INTO invoices (id, operator_id, customer_id, period, invoice_number, kind,
                             opening_balance_paise, charges_paise, total_due_paise)
       VALUES ($1, $2, $3, '2026-10-01', 'OB-00001', 'opening_balance', 0, 0, 0)`,
      [uuidv7(), books.operatorId, books.advance.customerId],
    );
    const report = await check(books.operatorId);
    expect(report.counts).toEqual({ DUPLICATE_REGULAR_INVOICE: 1 });
    expect(report.samples).toEqual([
      {
        code: "DUPLICATE_REGULAR_INVOICE",
        entityType: "customer",
        entityId: books.partly.customerId,
        customerId: books.partly.customerId,
        details: { period: "2026-10-01", invoiceCount: 2 },
      },
    ]);
    expect((await check(other.operatorId)).violationCount).toBe(0);
  }, 60_000);
});
