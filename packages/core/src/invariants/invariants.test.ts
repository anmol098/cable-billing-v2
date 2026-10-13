/**
 * The tenant-wide invariant check against a real database (T-052, PLAN §14, §8.4). Healthy books
 * built through the real services report nothing; each kind of corruption injected afterwards
 * (straight inserts and updates through the admin pool, or with triggers switched off on one test
 * connection where the database would refuse the row) is reported with the right ids and
 * amounts; the SQL agrees customer by customer with T-041's `checkLedger`; and one tenant's breach
 * never shows up in another tenant's report.
 */
import { uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { checkLedger } from "@cb/domain";
import { describe, expect, it } from "vitest";
import { readLedgerState } from "../payments/test-support";
import { checkTenantInvariants } from "./check";
import { type InvariantCode, LEDGER_INVARIANT_CODES, type TenantInvariantReport } from "./codes";
import {
  type HealthyBooks,
  insertAllocation,
  seedHealthyBooks,
  withTriggersOff,
} from "./test-support";

const NOW = new Date("2026-11-10T06:00:00.000Z");

describeDb("checkTenantInvariants", () => {
  const t = useTestDatabase();

  const check = (operatorId: string, sampleLimit = 100) =>
    t.current.db.withTenant(
      operatorId,
      (tx) => checkTenantInvariants(tx, operatorId, { sampleLimit }),
      { accessMode: "read only" },
    );
  const q = (text: string, params: unknown[] = []) => t.current.admin.query(text, params);
  const seed = () => seedHealthyBooks(t.current, NOW);

  /** Customer by customer, the SQL finds exactly the ledger codes `checkLedger` finds. */
  async function expectSameAsCheckLedger(books: HealthyBooks, report: TenantInvariantReport) {
    const ledgerCodes = new Set<string>(LEDGER_INVARIANT_CODES);
    const { rows } = await q("SELECT id FROM customers WHERE operator_id = $1 ORDER BY id", [
      books.operatorId,
    ]);
    expect(rows.length).toBe(5);
    for (const { id } of rows as { id: string }[]) {
      const state = await t.current.db.withTenant(books.operatorId, (tx) =>
        readLedgerState(tx, id),
      );
      const domain = [...new Set(checkLedger(state).map((v) => v.code))].sort();
      const fromSql = [
        ...new Set(
          report.samples
            .filter((s) => s.customerId === id && ledgerCodes.has(s.code))
            .map((s) => s.code),
        ),
      ].sort();
      expect(fromSql, `customer ${id}`).toEqual(domain);
    }
  }

  /** A snapshot of every financial row of the tenant (the check must not change any). */
  async function snapshot(operatorId: string) {
    const out: Record<string, unknown> = {};
    for (const table of [
      "invoices",
      "payments",
      "payment_reversals",
      "adjustments",
      "allocations",
      "ledger_entries",
      "customer_balances",
      "vc_assignments",
    ]) {
      const { rows } = await q(
        `SELECT to_jsonb(x) AS row FROM ${table} x WHERE operator_id = $1 ORDER BY to_jsonb(x)::text`,
        [operatorId],
      );
      out[table] = rows;
    }
    return out;
  }

  it("healthy books report nothing, agree with checkLedger, and nothing is written", async () => {
    const books = await seed();
    const before = await snapshot(books.operatorId);
    const report = await check(books.operatorId);
    expect(report).toEqual({
      operatorId: books.operatorId,
      violationCount: 0,
      counts: {},
      samples: [],
    });
    await expectSameAsCheckLedger(books, report);
    expect(await snapshot(books.operatorId)).toEqual(before);
    // The seeded books really do contain what the checks look at.
    const { rows } = await q(
      `SELECT (SELECT count(*) FROM payment_reversals WHERE operator_id = $1)::int AS reversals,
              (SELECT count(*) FROM allocations WHERE operator_id = $1 AND amount_paise < 0)::int
                AS reversal_rows,
              (SELECT count(*) FROM allocations WHERE operator_id = $1
                 AND kind = 'credit_application')::int AS credit_applications,
              (SELECT count(*) FROM adjustments WHERE operator_id = $1)::int AS adjustments,
              (SELECT count(*) FROM vc_assignments WHERE operator_id = $1)::int AS assignments`,
      [books.operatorId],
    );
    expect(rows[0]).toEqual({
      reversals: 1,
      reversal_rows: 1,
      credit_applications: 1,
      adjustments: 1,
      assignments: 3,
    });
  }, 60_000);

  interface Case {
    readonly name: string;
    readonly inject: (b: HealthyBooks) => Promise<void>;
    /** Exactly the counts the tenant must report. */
    readonly counts: Partial<Record<InvariantCode, number>>;
    /** One expected sample (subset match). */
    readonly sample: (b: HealthyBooks) => {
      code: InvariantCode;
      entityType: string;
      entityId: string;
      customerId: string;
      details?: Record<string, unknown>;
    };
  }

  const cases: Case[] = [
    {
      name: "a drifted balance read model",
      inject: async (b) => {
        await q(
          "UPDATE customer_balances SET balance_paise = balance_paise + 123 WHERE customer_id = $1",
          [b.partly.customerId],
        );
      },
      counts: { BALANCE_MISMATCH: 1 },
      sample: (b) => ({
        code: "BALANCE_MISMATCH",
        entityType: "customer",
        entityId: b.partly.customerId,
        customerId: b.partly.customerId,
        details: { ledgerPaise: 30_000, storedPaise: 30_123 },
      }),
    },
    {
      name: "a drifted credit read model (invariant 2)",
      inject: async (b) => {
        await q(
          "UPDATE customer_balances SET credit_paise = credit_paise + 500 WHERE customer_id = $1",
          [b.advance.customerId],
        );
      },
      counts: { CREDIT_MISMATCH: 1 },
      sample: (b) => ({
        code: "CREDIT_MISMATCH",
        entityType: "customer",
        entityId: b.advance.customerId,
        customerId: b.advance.customerId,
        details: { expectedPaise: 0, storedPaise: 500 },
      }),
    },
    {
      name: "a ledger entry no document explains (invariant 3), balance kept in step",
      inject: async (b) => {
        const adjustmentId = uuidv7();
        await q(
          `INSERT INTO adjustments (id, operator_id, customer_id, direction, amount_paise, source,
                                    reason, created_by)
           VALUES ($1, $2, $3, 'debit', 700, 'manual', 'Injected', $4)`,
          [adjustmentId, b.operatorId, b.partly.customerId, b.tenant.users.owner],
        );
        await q(
          `INSERT INTO ledger_entries (id, operator_id, customer_id, type, amount_paise,
                                       adjustment_id)
           VALUES ($1, $2, $3, 'debit_adjustment', 700, $4)`,
          [uuidv7(), b.operatorId, b.partly.customerId, adjustmentId],
        );
        await q(
          "UPDATE customer_balances SET balance_paise = balance_paise + 700 WHERE customer_id = $1",
          [b.partly.customerId],
        );
      },
      counts: { LEDGER_MISMATCH: 1 },
      sample: (b) => ({
        code: "LEDGER_MISMATCH",
        entityType: "customer",
        entityId: b.partly.customerId,
        customerId: b.partly.customerId,
        details: { ledgerPaise: 30_700, expectedPaise: 30_000 },
      }),
    },
    {
      name: "a payment's ledger entry deleted behind the append-only trigger",
      inject: async (b) => {
        await withTriggersOff(t.current, [
          ["DELETE FROM ledger_entries WHERE payment_id = $1", [b.partly.paymentId]],
        ]);
      },
      counts: { LEDGER_MISMATCH: 1, BALANCE_MISMATCH: 1 },
      sample: (b) => ({
        code: "BALANCE_MISMATCH",
        entityType: "customer",
        entityId: b.partly.customerId,
        customerId: b.partly.customerId,
        details: { ledgerPaise: 50_000, storedPaise: 30_000 },
      }),
    },
    {
      name: "a payment allocated beyond its amount (invariant 1)",
      inject: async (b) => {
        await insertAllocation(t.current, {
          operatorId: b.operatorId,
          customerId: b.partly.customerId,
          invoiceId: b.partly.invoiceId,
          paymentId: b.partly.paymentId,
          amountPaise: 10_000,
        });
      },
      counts: { ALLOCATIONS_EXCEED_PAYMENT: 1, CREDIT_MISMATCH: 1 },
      sample: (b) => ({
        code: "ALLOCATIONS_EXCEED_PAYMENT",
        entityType: "payment",
        entityId: b.partly.paymentId,
        customerId: b.partly.customerId,
        details: { allocatedPaise: 30_000, amountPaise: 20_000 },
      }),
    },
    {
      name: "a credit adjustment allocated beyond its amount and beyond the bill (invariant 4)",
      inject: async (b) => {
        await insertAllocation(t.current, {
          operatorId: b.operatorId,
          customerId: b.credited.customerId,
          invoiceId: b.credited.invoiceId,
          creditAdjustmentId: b.credited.adjustmentId,
          amountPaise: 30_000,
        });
      },
      counts: {
        CREDIT_MISMATCH: 1,
        NEGATIVE_OUTSTANDING: 1,
        ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT: 1,
      },
      sample: (b) => ({
        code: "NEGATIVE_OUTSTANDING",
        entityType: "invoice",
        entityId: b.credited.invoiceId,
        customerId: b.credited.customerId,
        details: { outstandingPaise: -5_000, chargesPaise: 25_000 },
      }),
    },
    {
      name: "a reversed payment that still pays a bill",
      inject: async (b) => {
        await insertAllocation(t.current, {
          operatorId: b.operatorId,
          customerId: b.reversed.customerId,
          invoiceId: b.reversed.invoiceId,
          paymentId: b.reversed.paymentId,
          amountPaise: 5_000,
        });
      },
      counts: { REVERSED_PAYMENT_STILL_ALLOCATED: 1 },
      sample: (b) => ({
        code: "REVERSED_PAYMENT_STILL_ALLOCATED",
        entityType: "payment",
        entityId: b.reversed.paymentId,
        customerId: b.reversed.customerId,
        details: { allocatedPaise: 5_000 },
      }),
    },
    {
      name: "a reversal row that cancels more than was paid (trigger bypassed)",
      inject: async (b) => {
        const { rows } = await q("SELECT id FROM payment_reversals WHERE payment_id = $1", [
          b.reversed.paymentId,
        ]);
        await withTriggersOff(t.current, [
          [
            `INSERT INTO allocations (id, operator_id, customer_id, invoice_id, source_type,
                                      payment_id, kind, amount_paise, outstanding_after_paise,
                                      reversal_id, reverses_allocation_id)
             VALUES ($1, $2, $3, $4, 'payment', $5, 'reversal', -40000, 0, $6, $7)`,
            [
              uuidv7(),
              b.operatorId,
              b.reversed.customerId,
              b.reversed.invoiceId,
              b.reversed.paymentId,
              (rows[0] as { id: string }).id,
              uuidv7(),
            ],
          ],
        ]);
      },
      counts: {
        NEGATIVE_SOURCE_ALLOCATIONS: 1,
        REVERSED_PAYMENT_STILL_ALLOCATED: 1,
        OUTSTANDING_EXCEEDS_CHARGES: 1,
      },
      sample: (b) => ({
        code: "OUTSTANDING_EXCEEDS_CHARGES",
        entityType: "invoice",
        entityId: b.reversed.invoiceId,
        customerId: b.reversed.customerId,
        details: { outstandingPaise: 80_000, chargesPaise: 40_000 },
      }),
    },
    {
      name: "a negative allocation that no reversal explains (trigger and FK bypassed)",
      inject: async (b) => {
        await withTriggersOff(t.current, [
          [
            `INSERT INTO allocations (id, operator_id, customer_id, invoice_id, source_type,
                                      payment_id, kind, amount_paise, outstanding_after_paise,
                                      reversal_id, reverses_allocation_id)
             VALUES ($1, $2, $3, $4, 'payment', $5, 'reversal', -5000, 0, $6, $7)`,
            [
              uuidv7(),
              b.operatorId,
              b.partly.customerId,
              b.partly.invoiceId,
              b.partly.paymentId,
              uuidv7(),
              uuidv7(),
            ],
          ],
        ]);
      },
      counts: { NEGATIVE_ALLOCATION_WITHOUT_REVERSAL: 1, CREDIT_MISMATCH: 1 },
      sample: (b) => ({
        code: "NEGATIVE_ALLOCATION_WITHOUT_REVERSAL",
        entityType: "allocation",
        entityId: expect.any(String) as unknown as string,
        customerId: b.partly.customerId,
        details: { amountPaise: -5_000, sourceId: b.partly.paymentId },
      }),
    },
  ];

  describe("injected corruption is reported", () => {
    for (const c of cases) {
      it(c.name, async () => {
        const books = await seed();
        const other = await seed(); // a clean tenant next door
        await c.inject(books);
        const report = await check(books.operatorId);
        expect(report.counts).toEqual(c.counts);
        expect(report.violationCount).toBe(
          Object.values(c.counts).reduce((sum, n) => sum + (n ?? 0), 0),
        );
        expect(report.samples).toContainEqual(expect.objectContaining(c.sample(books)));
        // Every sample belongs to the broken tenant's customers.
        const ids = new Set(
          [books.partly, books.advance, books.reversed, books.credited, books.connected].map(
            (x) => x.customerId,
          ),
        );
        for (const s of report.samples) expect(ids.has(String(s.customerId))).toBe(true);
        await expectSameAsCheckLedger(books, report);
        // The tenant next door is untouched by it.
        expect((await check(other.operatorId)).violationCount).toBe(0);
      }, 60_000);
    }
  });

  it("one tenant's breach is never attributed to another", async () => {
    const a = await seed();
    const b = await seed();
    await q("UPDATE customer_balances SET balance_paise = 1 WHERE customer_id = $1", [
      a.partly.customerId,
    ]);
    await q("UPDATE customer_balances SET credit_paise = 7 WHERE customer_id = $1", [
      b.credited.customerId,
    ]);
    const reportA = await check(a.operatorId);
    const reportB = await check(b.operatorId);
    expect(reportA.counts).toEqual({ BALANCE_MISMATCH: 1 });
    expect(reportA.samples.map((s) => s.customerId)).toEqual([a.partly.customerId]);
    expect(reportB.counts).toEqual({ CREDIT_MISMATCH: 1 });
    expect(reportB.samples.map((s) => s.customerId)).toEqual([b.credited.customerId]);
    // Run inside A's transaction, a check for B sees none of B's rows (RLS), so it can't report
    // B's breach under A, nor A's under B.
    const crossed = await t.current.db.withTenant(a.operatorId, (tx) =>
      checkTenantInvariants(tx, b.operatorId),
    );
    expect(crossed).toMatchObject({ violationCount: 0, counts: {} });
  }, 60_000);

  it("counts are exact while samples are capped per code", async () => {
    const books = await seed();
    const customers = [
      books.partly,
      books.advance,
      books.reversed,
      books.credited,
      books.connected,
    ].map((x) => x.customerId);
    await q(
      "UPDATE customer_balances SET balance_paise = balance_paise + 1 WHERE customer_id = ANY($1)",
      [customers],
    );
    const report = await check(books.operatorId, 2);
    // `connected` has no money rows and no balance row, so it has nothing to drift.
    expect(report.counts).toEqual({ BALANCE_MISMATCH: 4 });
    expect(report.violationCount).toBe(4);
    expect(report.samples).toHaveLength(2);
    const none = await check(books.operatorId, 0);
    expect(none).toMatchObject({ violationCount: 4, counts: { BALANCE_MISMATCH: 4 }, samples: [] });
  }, 60_000);
});
