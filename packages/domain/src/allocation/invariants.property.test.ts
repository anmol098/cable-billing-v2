/**
 * Acceptance (T-041): PLAN §8.4 invariants 1–4 hold under fast-check over ≥ 10,000 random
 * sequences of invoices, payments, credit adjustments and reversals.
 *
 * The test drives a small in-memory model of one customer's account the way the services will
 * (T-044 billing, T-045 adjustments, T-046 posting and reversal): every money row it stores comes
 * from `allocate`, `applyCredit` or `reverse`, and it keeps the `customer_balances` read model up
 * to date incrementally. After every step `checkLedger` (the T-052 checker) must find nothing.
 * A second property corrupts a healthy account and checks that `checkLedger` notices.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addPaise,
  minPaise,
  type Paise,
  paise,
  subtractPaise,
  sumPaise,
  ZERO_PAISE,
} from "../money";
import { unwrap } from "../result";
import { nextPeriod, type Period, period } from "../time";
import { allocate, applyCredit } from "./allocate";
import { invoiceOutstanding, unallocatedRemainder } from "./balances";
import { checkLedger, type LedgerEntry, type LedgerState } from "./check-ledger";
import { reverse } from "./reverse";
import type { AllocationRow, CreditSource, OpenInvoice } from "./types";

// ── The model: one customer's rows, append-only except for the read model and the reversed flag. ─

type Model = {
  invoices: { id: string; period: Period; chargesPaise: Paise }[];
  payments: { id: string; amountPaise: Paise; reversed: boolean; at: number }[];
  creditAdjustments: { id: string; amountPaise: Paise; at: number }[];
  allocations: AllocationRow[];
  ledgerEntries: LedgerEntry[];
  balancePaise: Paise;
  creditPaise: Paise;
  clock: number;
  seq: number;
  /** Test bookkeeping only: ids of rows written by `applyCredit`. */
  appliedCreditRowIds: Set<string>;
};

function emptyModel(): Model {
  return {
    invoices: [],
    payments: [],
    creditAdjustments: [],
    allocations: [],
    ledgerEntries: [],
    balancePaise: ZERO_PAISE,
    creditPaise: ZERO_PAISE,
    clock: Date.UTC(2026, 9, 1),
    seq: 0,
    appliedCreditRowIds: new Set(),
  };
}

function nextId(m: Model, prefix: string): string {
  m.seq += 1;
  return `${prefix}-${String(m.seq).padStart(6, "0")}`;
}

function rowsOf(m: Model, predicate: (row: AllocationRow) => boolean): AllocationRow[] {
  return m.allocations.filter(predicate);
}

/** Every invoice with its outstanding, **including** paid ones (the domain must skip them). */
function openInvoices(m: Model): OpenInvoice[] {
  return m.invoices.map((invoice) => ({
    id: invoice.id,
    period: invoice.period,
    outstandingPaise: invoiceOutstanding(
      invoice.chargesPaise,
      rowsOf(m, (row) => row.invoiceId === invoice.id),
    ),
  }));
}

/** Every live source with what it has left, **including** empty ones. */
function creditSources(m: Model): CreditSource[] {
  return [
    ...m.payments
      .filter((payment) => !payment.reversed)
      .map((payment) => ({
        sourceType: "payment" as const,
        sourceId: payment.id,
        at: payment.at,
        availablePaise: unallocatedRemainder(
          payment,
          rowsOf(m, (row) => row.sourceType === "payment" && row.sourceId === payment.id),
        ),
      })),
    ...m.creditAdjustments.map((adjustment) => ({
      sourceType: "credit_adjustment" as const,
      sourceId: adjustment.id,
      at: adjustment.at,
      availablePaise: unallocatedRemainder(
        adjustment,
        rowsOf(
          m,
          (row) => row.sourceType === "credit_adjustment" && row.sourceId === adjustment.id,
        ),
      ),
    })),
  ];
}

function ledgerState(m: Model): LedgerState {
  return {
    invoices: m.invoices,
    payments: m.payments,
    creditAdjustments: m.creditAdjustments,
    allocations: m.allocations,
    ledgerEntries: m.ledgerEntries,
    balancePaise: m.balancePaise,
    creditPaise: m.creditPaise,
  };
}

function postLedger(m: Model, type: LedgerEntry["type"], amountPaise: Paise): void {
  m.ledgerEntries.push({ type, amountPaise });
  m.balancePaise = addPaise(m.balancePaise, amountPaise);
}

// ── Operations, each doing what the matching service will do. ──────────────────────────────────

type Op =
  | { kind: "invoice"; charges: number; samePeriod: boolean; salt: string }
  | { kind: "payment"; amount: number }
  | { kind: "creditAdjustment"; amount: number }
  | { kind: "reverse"; pick: number }
  | { kind: "zeroPayment" };

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("invoice" as const),
      charges: fc.integer({ min: 1, max: 120_000 }),
      // Two invoices in one period happen with opening-balance invoices; it tests the id tie-break.
      samePeriod: fc.boolean(),
      salt: fc.constantFrom("a", "m", "z"),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("payment" as const),
      amount: fc.oneof(fc.integer({ min: 1, max: 200_000 }), fc.integer({ min: 1, max: 100 })),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("creditAdjustment" as const),
      amount: fc.integer({ min: 1, max: 50_000 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reverse" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "zeroPayment" as const }) },
);

/** What the sequences exercised, so the acceptance test can't pass vacuously. */
const coverage = {
  steps: 0,
  longestSequence: 0,
  sameMonthInvoices: 0,
  creditApplied: 0,
  partialPayments: 0,
  paymentsWithCredit: 0,
  reversals: 0,
  reversalsWithCredit: 0,
  reversalsOfAppliedCredit: 0,
};

function apply(m: Model, op: Op): void {
  coverage.steps += 1;
  m.clock += 60_000;
  switch (op.kind) {
    case "invoice": {
      // PLAN §8.2: insert the invoice, ledger += charges, then apply available credit (§8.5).
      const last = m.invoices.at(-1);
      const p =
        last === undefined
          ? period("2026-10-01")
          : op.samePeriod
            ? last.period
            : nextPeriod(last.period);
      if (last !== undefined && op.samePeriod) coverage.sameMonthInvoices += 1;
      const id = `inv-${op.salt}-${nextId(m, "x")}`;
      m.invoices.push({ id, period: p, chargesPaise: paise(op.charges) });
      postLedger(m, "invoice", paise(op.charges));

      const sources = creditSources(m);
      const open = openInvoices(m);
      const result = unwrap(applyCredit(sources, open));
      const credit = sumPaise(sources.map((s) => s.availablePaise));
      const owed = sumPaise(open.map((i) => i.outstandingPaise));
      same(credit, m.creditPaise, "credit sources = stored credit");
      same(result.appliedPaise, minPaise(credit, owed), "applied = min(credit, owed)");
      for (const a of result.allocations) {
        const rowId = nextId(m, "al");
        m.appliedCreditRowIds.add(rowId);
        m.allocations.push({ id: rowId, ...a, reversalId: null });
      }
      if (result.appliedPaise > 0) coverage.creditApplied += 1;
      m.creditPaise = subtractPaise(m.creditPaise, result.appliedPaise);
      same(result.remainingCreditPaise, m.creditPaise, "remaining credit");
      return;
    }
    case "payment": {
      // PLAN §8.4: insert payment, ledger(−amount), allocate oldest first, remainder → credit.
      const id = nextId(m, "pay");
      const amount = paise(op.amount);
      const result = unwrap(allocate(amount, openInvoices(m)));
      m.payments.push({ id, amountPaise: amount, reversed: false, at: m.clock });
      postLedger(m, "payment", subtractPaise(ZERO_PAISE, amount));
      for (const a of result.allocations) {
        m.allocations.push({
          id: nextId(m, "al"),
          invoiceId: a.invoiceId,
          sourceType: "payment",
          sourceId: id,
          amountPaise: a.amountPaise,
          reversalId: null,
        });
      }
      m.creditPaise = addPaise(m.creditPaise, result.creditPaise);
      if (result.creditPaise > 0) coverage.paymentsWithCredit += 1;
      if (result.openInvoices.length > 0 && result.allocatedPaise > 0)
        coverage.partialPayments += 1;
      return;
    }
    case "creditAdjustment": {
      // PLAN §7.2 / §8.3: a credit adjustment lowers the balance and is credit until applied.
      const amount = paise(op.amount);
      m.creditAdjustments.push({ id: nextId(m, "adj"), amountPaise: amount, at: m.clock });
      postLedger(m, "credit_adjustment", subtractPaise(ZERO_PAISE, amount));
      m.creditPaise = addPaise(m.creditPaise, amount);
      return;
    }
    case "reverse": {
      // PLAN §8.6: payment_reversal, ledger(+amount), negative rows cancelling every allocation.
      const live = m.payments.filter((payment) => !payment.reversed);
      const target = live[op.pick % Math.max(live.length, 1)];
      if (target === undefined) return;
      const rows = rowsOf(m, (row) => row.sourceType === "payment" && row.sourceId === target.id);
      const result = unwrap(reverse(target, rows));
      coverage.reversals += 1;
      if (result.creditDeltaPaise < 0) coverage.reversalsWithCredit += 1;
      if (rows.some((row) => m.appliedCreditRowIds.has(row.id))) {
        coverage.reversalsOfAppliedCredit += 1;
      }
      const reversalId = nextId(m, "rev");
      for (const a of result.allocations) {
        m.allocations.push({
          id: nextId(m, "al"),
          invoiceId: a.invoiceId,
          sourceType: a.sourceType,
          sourceId: a.sourceId,
          amountPaise: a.amountPaise,
          reversalId,
        });
      }
      target.reversed = true;
      postLedger(m, "payment_reversal", result.ledgerDeltaPaise);
      m.creditPaise = addPaise(m.creditPaise, result.creditDeltaPaise);
      // One reversal per payment.
      const after = rowsOf(m, (row) => row.sourceType === "payment" && row.sourceId === target.id);
      const again = reverse(target, after);
      same(again.ok ? "ok" : again.error.code, "CONFLICT", "second reversal");
      return;
    }
    case "zeroPayment": {
      // PRD §13.2 step 1: a zero payment is refused and nothing is stored.
      const refused = allocate(ZERO_PAISE, openInvoices(m));
      same(refused.ok ? "ok" : refused.error.code, "VALIDATION", "zero payment");
      return;
    }
  }
}

/**
 * A cheap `expect(actual).toBe(expected)` for the hot loop (about 300,000 calls), where vitest's
 * matchers would dominate the run time. Failures still go through `expect` for a readable diff.
 */
function same<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) expect({ what, actual }).toEqual({ what, actual: expected });
}

function assertHealthy(m: Model): void {
  const violations = checkLedger(ledgerState(m));
  if (violations.length > 0) expect(violations).toEqual([]);
  // Corollary of invariants 2 and 3: balance = Σ outstanding − credit.
  const outstanding = openInvoices(m).map((invoice) => invoice.outstandingPaise);
  same(
    outstanding.every((value) => value >= 0),
    true,
    "outstanding >= 0",
  );
  same(
    m.balancePaise,
    subtractPaise(sumPaise(outstanding), m.creditPaise),
    "balance = owed - credit",
  );
}

// `size: "max"`: without it fast-check keeps arrays short (about 10), whatever `maxLength` says.
const arbOps = fc.array(arbOp, { minLength: 1, maxLength: 30, size: "max" });

describe("PLAN §8.4 invariants over random sequences", () => {
  it("hold after every step of 10,000 random sequences (acceptance)", () => {
    fc.assert(
      fc.property(arbOps, (ops) => {
        coverage.longestSequence = Math.max(coverage.longestSequence, ops.length);
        const m = emptyModel();
        for (const op of ops) {
          apply(m, op);
          assertHealthy(m);
        }
      }),
      { numRuns: 10_000 },
    );
    // Every interesting path ran many times (10,000 runs produce thousands of each).
    const { longestSequence, ...paths } = coverage;
    expect(longestSequence).toBe(30);
    for (const [path, count] of Object.entries(paths)) {
      expect({ path, count }).toEqual({ path, count: expect.toSatisfy((n: number) => n > 100) });
    }
  }, 300_000); // About 4 s on an idle machine; a loaded shared runner was seen at ~100 s.

  it("are reported by checkLedger when a healthy account is corrupted", () => {
    type Corruption = (m: Model, pick: number, delta: number) => boolean;
    const corruptions: Record<string, Corruption> = {
      // Each returns false when the account has nothing to corrupt that way.
      storedCredit: (m, _pick, delta) => {
        m.creditPaise = addPaise(m.creditPaise, paise(delta));
        return true;
      },
      storedBalance: (m, _pick, delta) => {
        m.balancePaise = addPaise(m.balancePaise, paise(delta));
        return true;
      },
      dropLedgerEntry: (m, pick) => {
        const index = pick % Math.max(m.ledgerEntries.length, 1);
        if (m.ledgerEntries[index] === undefined) return false;
        m.ledgerEntries.splice(index, 1);
        return true;
      },
      dropAllocation: (m, pick) => {
        const index = pick % Math.max(m.allocations.length, 1);
        if (m.allocations[index] === undefined) return false;
        m.allocations.splice(index, 1);
        return true;
      },
      extraAllocation: (m, pick, delta) => {
        const invoice = m.invoices[pick % Math.max(m.invoices.length, 1)];
        const source = m.payments[pick % Math.max(m.payments.length, 1)];
        if (invoice === undefined || source === undefined) return false;
        m.allocations.push({
          id: "al-extra",
          invoiceId: invoice.id,
          sourceType: "payment",
          sourceId: source.id,
          amountPaise: paise(delta),
          reversalId: null,
        });
        return true;
      },
      changeAllocationAmount: (m, pick, delta) => {
        const index = pick % Math.max(m.allocations.length, 1);
        const row = m.allocations[index];
        if (row === undefined) return false;
        m.allocations[index] = { ...row, amountPaise: addPaise(row.amountPaise, paise(delta)) };
        return true;
      },
      flipReversed: (m, pick) => {
        const payment = m.payments[pick % Math.max(m.payments.length, 1)];
        if (payment === undefined) return false;
        payment.reversed = !payment.reversed;
        return true;
      },
      changeInvoiceCharges: (m, pick, delta) => {
        const index = pick % Math.max(m.invoices.length, 1);
        const invoice = m.invoices[index];
        if (invoice === undefined) return false;
        m.invoices[index] = {
          ...invoice,
          chargesPaise: addPaise(invoice.chargesPaise, paise(delta)),
        };
        return true;
      },
    };
    const delta = fc.oneof(
      fc.integer({ min: 1, max: 10_000 }),
      fc.integer({ min: -10_000, max: -1 }),
    );

    fc.assert(
      fc.property(
        arbOps,
        fc.constantFrom(...Object.keys(corruptions)),
        fc.nat(),
        delta,
        (ops, name, pick, amount) => {
          const m = emptyModel();
          for (const op of ops) apply(m, op);
          const corrupt = corruptions[name];
          fc.pre(corrupt?.(m, pick, amount) === true);
          expect(checkLedger(ledgerState(m)).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 2_000 },
    );
  }, 120_000); // Under a second when idle; 2,000 runs blew Vitest's 5 s default under load.
});
