import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Paise, paise, sumPaise } from "../money";
import { unwrap } from "../result";
import { addPeriods, type Period, period } from "../time";
import { allocate, applyCredit } from "./allocate";
import { compareInvoicesOldestFirst } from "./order";
import type { CreditSource, OpenInvoice } from "./types";

const OCT = period("2026-10-01");
const NOV = period("2026-11-01");
const DEC = period("2026-12-01");

function inv(id: string, p: Period, outstanding: number): OpenInvoice {
  return { id, period: p, outstandingPaise: paise(outstanding) };
}

function src(
  sourceId: string,
  available: number,
  at: number,
  sourceType: CreditSource["sourceType"] = "payment",
): CreditSource {
  return { sourceType, sourceId, availablePaise: paise(available), at };
}

/** Deep-freezes test inputs: any mutation inside the domain then throws (ES modules are strict). */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const key of Object.keys(value)) frozen((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("allocate()", () => {
  it("puts everything into credit when nothing is owed (zero open invoices)", () => {
    expect(unwrap(allocate(paise(50_000), []))).toEqual({
      allocations: [],
      allocatedPaise: 0,
      creditPaise: 50_000,
      openInvoices: [],
    });
  });

  it("pays an invoice off exactly, leaving no credit", () => {
    expect(unwrap(allocate(paise(45_000), [inv("a", OCT, 45_000)]))).toEqual({
      allocations: [{ invoiceId: "a", amountPaise: 45_000 }],
      allocatedPaise: 45_000,
      creditPaise: 0,
      openInvoices: [],
    });
  });

  it("settles partially, oldest period first (RULE-11, RULE-12)", () => {
    const result = unwrap(
      allocate(paise(60_000), [
        inv("c", DEC, 45_000),
        inv("a", OCT, 45_000),
        inv("b", NOV, 45_000),
      ]),
    );
    expect(result.allocations).toEqual([
      { invoiceId: "a", amountPaise: 45_000 },
      { invoiceId: "b", amountPaise: 15_000 },
    ]);
    expect(result.creditPaise).toBe(0);
    expect(result.openInvoices).toEqual([inv("b", NOV, 30_000), inv("c", DEC, 45_000)]);
  });

  it("keeps the excess as credit after paying everything (RULE-13)", () => {
    const result = unwrap(allocate(paise(100_000), [inv("b", NOV, 30_000), inv("a", OCT, 20_000)]));
    expect(result.allocations).toEqual([
      { invoiceId: "a", amountPaise: 20_000 },
      { invoiceId: "b", amountPaise: 30_000 },
    ]);
    expect(result.allocatedPaise).toBe(50_000);
    expect(result.creditPaise).toBe(50_000);
    expect(result.openInvoices).toEqual([]);
  });

  it("breaks a same-period tie by invoice id, by code unit (like Postgres uuid order)", () => {
    const ids = ["0199f2c4-9e1a-7000-8000-00000000000b", "0199f2c4-9e1a-7000-8000-00000000000a"];
    const result = unwrap(
      allocate(paise(100), [inv(ids[0] ?? "", OCT, 100), inv(ids[1] ?? "", OCT, 100)]),
    );
    expect(result.allocations).toEqual([{ invoiceId: ids[1], amountPaise: 100 }]);
    // Code-unit order, not locale order: "B" < "a".
    const mixed = unwrap(allocate(paise(1), [inv("a", OCT, 1), inv("B", OCT, 1)]));
    expect(mixed.allocations[0]?.invoiceId).toBe("B");
  });

  it("skips invoices that are already paid (outstanding 0)", () => {
    const result = unwrap(allocate(paise(500), [inv("old", OCT, 0), inv("new", NOV, 300)]));
    expect(result.allocations).toEqual([{ invoiceId: "new", amountPaise: 300 }]);
    expect(result.creditPaise).toBe(200);
  });

  it("handles many tiny invoices (1 paise each)", () => {
    const invoices = Array.from({ length: 2_000 }, (_, i) =>
      inv(`i${String(i).padStart(5, "0")}`, addPeriods(OCT, -(i % 240)), 1),
    );
    const result = unwrap(allocate(paise(1_500), invoices));
    expect(result.allocations).toHaveLength(1_500);
    expect(result.allocations.every((a) => a.amountPaise === 1)).toBe(true);
    expect(result.openInvoices).toHaveLength(500);
    expect(result.creditPaise).toBe(0);
    // The ones paid are exactly the 1,500 oldest.
    const oldest = [...invoices].sort(compareInvoicesOldestFirst).slice(0, 1_500);
    expect(result.allocations.map((a) => a.invoiceId)).toEqual(oldest.map((i) => i.id));
  });

  it("never mutates its input", () => {
    const invoices = frozen([inv("b", NOV, 300), inv("a", OCT, 200)]);
    unwrap(allocate(paise(400), invoices));
    expect(invoices).toEqual([inv("b", NOV, 300), inv("a", OCT, 200)]);
  });

  it.each([0, -100])("refuses a payment of %s paise (VALIDATION)", (amount) => {
    const result = allocate(paise(amount), [inv("a", OCT, 100)]);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("refuses a fractional amount (VALIDATION)", () => {
    const result = allocate(12.5 as Paise, []);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("refuses an invoice listed twice, or a malformed one (VALIDATION)", () => {
    expect(allocate(paise(1), [inv("a", OCT, 1), inv("a", NOV, 1)])).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { invoiceId: "a" } },
    });
    expect(
      allocate(paise(1), [{ id: "a", period: "2026-10-15" as Period, outstandingPaise: paise(1) }]),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(allocate(paise(1), [inv("", OCT, 1)])).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
  });

  it("refuses a negative outstanding (INVARIANT_VIOLATION: invariant 4 already broken)", () => {
    expect(allocate(paise(1), [inv("a", OCT, -1)])).toMatchObject({
      ok: false,
      error: { code: "INVARIANT_VIOLATION", details: { invoiceId: "a" } },
    });
  });
});

// ── Properties ────────────────────────────────────────────────────────────────────────────────

const arbInvoices = fc
  .uniqueArray(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      month: fc.integer({ min: 0, max: 30 }),
      outstanding: fc.integer({ min: 0, max: 100_000 }),
    }),
    { selector: (r) => r.id, maxLength: 25 },
  )
  .map((rows) => rows.map((r) => inv(r.id, addPeriods(OCT, r.month), r.outstanding)));

describe("allocate() properties", () => {
  it("conserves money, fills the oldest invoices first and leaves credit only when all is paid", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_000_000 }), arbInvoices, (amount, invoices) => {
        const result = unwrap(allocate(paise(amount), invoices));
        const ordered = invoices
          .filter((i) => i.outstandingPaise > 0)
          .sort(compareInvoicesOldestFirst);
        const owed = sumPaise(ordered.map((i) => i.outstandingPaise));

        // Invariant 1 and 2 for one payment: allocated ≤ amount, remainder = credit.
        expect(result.allocatedPaise).toBe(sumPaise(result.allocations.map((a) => a.amountPaise)));
        expect(result.allocatedPaise + result.creditPaise).toBe(amount);
        expect(result.allocatedPaise).toBe(Math.min(amount, owed));
        // Every row is positive and never more than the invoice owed (invariant 4).
        result.allocations.forEach((a, i) => {
          const target = ordered[i];
          expect(a.invoiceId).toBe(target?.id);
          expect(a.amountPaise).toBeGreaterThan(0);
          expect(a.amountPaise).toBeLessThanOrEqual(target?.outstandingPaise ?? 0);
          // All but the last row pay their invoice off completely.
          if (i < result.allocations.length - 1)
            expect(a.amountPaise).toBe(target?.outstandingPaise);
        });
        // Credit only when every invoice is paid.
        if (result.creditPaise > 0) expect(result.openInvoices).toEqual([]);
        // What's left owed is consistent.
        expect(sumPaise(result.openInvoices.map((i) => i.outstandingPaise))).toBe(
          owed - result.allocatedPaise,
        );
      }),
      { numRuns: 2_000 },
    );
  });

  it("does not depend on the order invoices are passed in", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000 }),
        arbInvoices,
        fc.infiniteStream(fc.nat()),
        (amount, invoices, randoms) => {
          const shuffled = [...invoices];
          for (let i = shuffled.length - 1; i > 0; i -= 1) {
            const j = randoms.next().value % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j] as OpenInvoice, shuffled[i] as OpenInvoice];
          }
          expect(allocate(paise(amount), shuffled)).toEqual(allocate(paise(amount), invoices));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("applyCredit()", () => {
  it("does nothing without sources or without open invoices", () => {
    expect(unwrap(applyCredit([], [inv("a", OCT, 100)]))).toEqual({
      allocations: [],
      appliedPaise: 0,
      remainingSources: [],
      remainingCreditPaise: 0,
      openInvoices: [inv("a", OCT, 100)],
    });
    expect(unwrap(applyCredit([src("p1", 500, 1)], []))).toEqual({
      allocations: [],
      appliedPaise: 0,
      remainingSources: [{ sourceType: "payment", sourceId: "p1", availablePaise: 500 }],
      remainingCreditPaise: 500,
      openInvoices: [],
    });
  });

  it("uses the oldest source first, on the oldest invoice first (PLAN §8.5)", () => {
    const result = unwrap(
      applyCredit(
        [src("newer", 400, 2_000), src("older", 300, 1_000, "credit_adjustment")],
        [inv("nov", NOV, 500), inv("oct", OCT, 100)],
      ),
    );
    expect(result.allocations).toEqual([
      { sourceType: "credit_adjustment", sourceId: "older", invoiceId: "oct", amountPaise: 100 },
      { sourceType: "credit_adjustment", sourceId: "older", invoiceId: "nov", amountPaise: 200 },
      { sourceType: "payment", sourceId: "newer", invoiceId: "nov", amountPaise: 300 },
    ]);
    expect(result.appliedPaise).toBe(600);
    expect(result.remainingSources).toEqual([
      { sourceType: "payment", sourceId: "newer", availablePaise: 100 },
    ]);
    expect(result.remainingCreditPaise).toBe(100);
    expect(result.openInvoices).toEqual([]);
  });

  it("accepts Date instants and breaks exact ties by type, then id", () => {
    const at = new Date("2026-10-05T06:00:00Z");
    const result = unwrap(
      applyCredit(
        [
          { sourceType: "payment", sourceId: "b", availablePaise: paise(1), at },
          { sourceType: "payment", sourceId: "a", availablePaise: paise(1), at: at.getTime() },
          { sourceType: "credit_adjustment", sourceId: "z", availablePaise: paise(1), at },
        ],
        [inv("x", OCT, 2)],
      ),
    );
    expect(result.allocations.map((a) => a.sourceId)).toEqual(["z", "a"]);
  });

  it("leaves part of an invoice owed when credit runs out", () => {
    const result = unwrap(
      applyCredit([src("p", 150, 1)], [inv("a", OCT, 100), inv("b", NOV, 100)]),
    );
    expect(result.openInvoices).toEqual([inv("b", NOV, 50)]);
    expect(result.remainingCreditPaise).toBe(0);
    expect(result.remainingSources).toEqual([]);
  });

  it("never mutates its input", () => {
    const sources = frozen([src("p", 150, 1), src("q", 10, 0)]);
    const invoices = frozen([inv("a", OCT, 100), inv("b", NOV, 100)]);
    unwrap(applyCredit(sources, invoices));
    expect(sources[0]?.availablePaise).toBe(150);
    expect(invoices[0]?.outstandingPaise).toBe(100);
  });

  it("refuses duplicate, malformed or over-allocated sources", () => {
    expect(applyCredit([src("p", 1, 1), src("p", 2, 2)], [])).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    // The same id as two different source types is fine.
    expect(applyCredit([src("p", 1, 1), src("p", 2, 2, "credit_adjustment")], []).ok).toBe(true);
    expect(applyCredit([src("p", 1, Number.NaN)], [])).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(
      applyCredit([{ ...src("p", 1, 1), sourceType: "refund" as CreditSource["sourceType"] }], []),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(applyCredit([src("p", -1, 1)], [])).toMatchObject({
      ok: false,
      error: { code: "INVARIANT_VIOLATION" },
    });
    expect(applyCredit([src("p", 1, 1)], [inv("a", OCT, -5)])).toMatchObject({
      ok: false,
      error: { code: "INVARIANT_VIOLATION" },
    });
  });

  it("applies min(credit, owed) in total, whatever the inputs", () => {
    const arbSources = fc.uniqueArray(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 4 }),
        available: fc.integer({ min: 0, max: 50_000 }),
        at: fc.integer({ min: 0, max: 100 }),
      }),
      { selector: (r) => r.id, maxLength: 10 },
    );
    fc.assert(
      fc.property(arbSources, arbInvoices, (rows, invoices) => {
        const sources = rows.map((r) => src(r.id, r.available, r.at));
        const result = unwrap(applyCredit(sources, invoices));
        const credit = sumPaise(sources.map((s) => s.availablePaise));
        const owed = sumPaise(invoices.map((i) => i.outstandingPaise));
        expect(result.appliedPaise).toBe(Math.min(credit, owed));
        expect(result.remainingCreditPaise).toBe(credit - result.appliedPaise);
        expect(result.allocations.every((a) => a.amountPaise > 0)).toBe(true);
        // Never both credit left and an invoice owed.
        expect(result.remainingCreditPaise > 0 && result.openInvoices.length > 0).toBe(false);
      }),
      { numRuns: 1_000 },
    );
  });
});
