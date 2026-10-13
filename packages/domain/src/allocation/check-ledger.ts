/**
 * The ledger invariant checker (PLAN §8.4 invariants 1–4), shared by the property tests here and
 * the nightly invariants job (T-052, PLAN §14).
 *
 * It checks **one customer's account**: credit (invariant 2) and the stored balance are kept per
 * customer in `customer_balances`. The job loads each customer's rows and calls this.
 */
import { addPaise, isPaise, type Paise, subtractPaise, sumPaise, ZERO_PAISE } from "../money";
import { invoiceOutstanding, unallocatedRemainder } from "./balances";
import { compareIds } from "./order";
import type { AllocationRow } from "./types";

/** `ledger_entries.type` (PLAN §7.2). */
export type LedgerEntryType =
  | "invoice"
  | "debit_adjustment"
  | "credit_adjustment"
  | "payment"
  | "payment_reversal"
  | "opening_balance";

/** A `ledger_entries` row. `amountPaise` is signed: + increases what the customer owes. */
export type LedgerEntry = {
  readonly type: LedgerEntryType;
  readonly amountPaise: Paise;
};

/** Everything `checkLedger` needs about one customer, read from the T-023 tables. */
export type LedgerState = {
  /**
   * Every issued invoice. `chargesPaise` is what the invoice added to the ledger and what its
   * allocations settle: `invoices.charges_paise` for a regular invoice, the opening amount for an
   * `opening_balance` invoice. Never `total_due_paise` (that repeats earlier months' dues).
   */
  readonly invoices: readonly { readonly id: string; readonly chargesPaise: Paise }[];
  /** Every posted payment. `reversed`: it has a `payment_reversals` row. */
  readonly payments: readonly {
    readonly id: string;
    readonly amountPaise: Paise;
    readonly reversed: boolean;
  }[];
  /** Every credit adjustment (`adjustments` with `direction = 'credit'`); amounts are > 0. */
  readonly creditAdjustments: readonly { readonly id: string; readonly amountPaise: Paise }[];
  /** Every `allocations` row of this customer, including reversal rows. */
  readonly allocations: readonly AllocationRow[];
  /** Every `ledger_entries` row of this customer. */
  readonly ledgerEntries: readonly LedgerEntry[];
  /** The stored read model `customer_balances.balance_paise`. */
  readonly balancePaise: Paise;
  /** The stored read model `customer_balances.credit_paise`. */
  readonly creditPaise: Paise;
};

/** Machine codes for {@link LedgerViolation}. Stable: T-052 stores and alerts on them. */
export const LEDGER_VIOLATION_CODES = [
  // PLAN §8.4 invariants 1–4.
  "ALLOCATIONS_EXCEED_PAYMENT",
  "CREDIT_MISMATCH",
  "LEDGER_MISMATCH",
  "NEGATIVE_OUTSTANDING",
  // Supporting consistency checks (PLAN §7.2 / §8.6 / §14), reported with `invariant: null`.
  "ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT",
  "NEGATIVE_SOURCE_ALLOCATIONS",
  "REVERSED_PAYMENT_STILL_ALLOCATED",
  "NEGATIVE_ALLOCATION_WITHOUT_REVERSAL",
  "OUTSTANDING_EXCEEDS_CHARGES",
  "BALANCE_MISMATCH",
  "UNKNOWN_INVOICE",
  "UNKNOWN_SOURCE",
  "DUPLICATE_ID",
  "INVALID_AMOUNT",
] as const;

export type LedgerViolationCode = (typeof LEDGER_VIOLATION_CODES)[number];

/** One broken rule. Ids and amounts only: no names or phone numbers (safe to log and store). */
export type LedgerViolation = {
  readonly code: LedgerViolationCode;
  /** The PLAN §8.4 invariant number, or `null` for a supporting check. */
  readonly invariant: 1 | 2 | 3 | 4 | null;
  /** Developer-facing; never shown to users. */
  readonly message: string;
  readonly details: Readonly<Record<string, string | number>>;
};

/**
 * Checks one customer's account and returns every violation found (empty = healthy), in a
 * deterministic order: by check, then by id.
 *
 * The four invariants of PLAN §8.4, exactly as written there:
 *
 * 1. "Σ allocations of a payment ≤ payment amount." Checked per payment over all its rows
 *    (posting, credit application and reversal rows).
 * 2. "Unallocated remainder = credit." The stored `credit_paise` must equal Σ over the customer's
 *    payments that are not reversed and credit adjustments of (amount − Σ their allocations).
 * 3. "Σ ledger = Σ invoice charges − Σ payments − Σ credit adj + Σ reversals." Σ of the ledger
 *    entries must equal Σ invoice charges − Σ payment amounts − Σ credit-adjustment amounts
 *    + Σ amounts of reversed payments.
 * 4. "Invoice outstanding never goes below 0." For each invoice, charges − Σ its allocations ≥ 0.
 *
 * Supporting checks (`invariant: null`), from the rest of the plan:
 * - PLAN §7.2 `allocations`: "Σ allocations per source ≤ source amount" also for credit
 *   adjustments, Σ per source ≥ 0, and "negative rows only from reversals" (a negative row needs
 *   a `reversalId` and a reversed payment as its source).
 * - PLAN §8.6: a reversed payment's rows must cancel out exactly (Σ = 0).
 * - Σ allocations of an invoice ≥ 0 (a reversal can't hand back more than was paid).
 * - PLAN §14 / T-052: Σ ledger = the stored `balance_paise`.
 * - Every allocation points at a known invoice and source; ids are unique; amounts are safe
 *   integers, and payment / credit-adjustment amounts are > 0 (`CHECK amount_paise > 0`).
 */
export function checkLedger(state: LedgerState): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  const report = (
    code: LedgerViolationCode,
    invariant: LedgerViolation["invariant"],
    message: string,
    details: Record<string, string | number>,
  ) => {
    violations.push({ code, invariant, message, details });
  };
  // A malformed amount is reported once, then counted as 0 so every other check still runs.
  const checked = (value: Paise, where: Record<string, string | number>): Paise => {
    if (isPaise(value)) return value;
    report("INVALID_AMOUNT", null, "amount is not a safe integer of paise", where);
    return ZERO_PAISE;
  };
  const positive = (value: Paise, where: Record<string, string | number>): Paise => {
    const result = checked(value, where);
    if (isPaise(value) && result <= 0) {
      report("INVALID_AMOUNT", null, "amount must be > 0", { ...where, amountPaise: result });
    }
    return result;
  };

  // ── Normalise: sorted by id (deterministic output), amounts checked once. ──
  const invoices = sortById(state.invoices).map((invoice) => ({
    id: invoice.id,
    chargesPaise: checked(invoice.chargesPaise, { invoiceId: invoice.id }),
  }));
  const payments = sortById(state.payments).map((payment) => ({
    id: payment.id,
    amountPaise: positive(payment.amountPaise, { paymentId: payment.id }),
    reversed: payment.reversed,
  }));
  const creditAdjustments = sortById(state.creditAdjustments).map((adjustment) => ({
    id: adjustment.id,
    amountPaise: positive(adjustment.amountPaise, { creditAdjustmentId: adjustment.id }),
  }));
  const allocations = sortById(state.allocations).map((row) => ({
    ...row,
    amountPaise: checked(row.amountPaise, { allocationId: row.id }),
  }));
  const ledgerAmounts = state.ledgerEntries.map((entry, index) =>
    checked(entry.amountPaise, { ledgerEntryIndex: index }),
  );
  const storedBalance = checked(state.balancePaise, { field: "balancePaise" });
  const storedCredit = checked(state.creditPaise, { field: "creditPaise" });

  for (const [collection, list] of [
    ["invoices", invoices],
    ["payments", payments],
    ["creditAdjustments", creditAdjustments],
    ["allocations", allocations],
  ] as const) {
    for (const id of duplicateIds(list)) {
      report("DUPLICATE_ID", null, `id appears more than once in ${collection}`, {
        collection,
        id,
      });
    }
  }

  // ── Allocation rows: references, "negative rows only from reversals", grouping. ──
  const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
  const reversedPaymentIds = new Set(payments.filter((p) => p.reversed).map((p) => p.id));
  const knownSources = new Set([
    ...payments.map((payment) => sourceKey("payment", payment.id)),
    ...creditAdjustments.map((adjustment) => sourceKey("credit_adjustment", adjustment.id)),
  ]);
  const rowsByInvoice = new Map<string, Paise[]>();
  const rowsBySource = new Map<string, Paise[]>();
  for (const row of allocations) {
    if (!invoiceIds.has(row.invoiceId)) {
      report("UNKNOWN_INVOICE", null, "allocation points at an unknown invoice", {
        allocationId: row.id,
        invoiceId: row.invoiceId,
      });
    }
    if (!knownSources.has(sourceKey(row.sourceType, row.sourceId))) {
      report("UNKNOWN_SOURCE", null, "allocation points at an unknown source", {
        allocationId: row.id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
      });
    }
    const fromReversal =
      (row.reversalId ?? null) !== null &&
      row.sourceType === "payment" &&
      reversedPaymentIds.has(row.sourceId);
    if (row.amountPaise < 0 && !fromReversal) {
      report(
        "NEGATIVE_ALLOCATION_WITHOUT_REVERSAL",
        null,
        "a negative allocation must come from a payment reversal",
        { allocationId: row.id, sourceType: row.sourceType, sourceId: row.sourceId },
      );
    }
    append(rowsByInvoice, row.invoiceId, row.amountPaise);
    append(rowsBySource, sourceKey(row.sourceType, row.sourceId), row.amountPaise);
  }
  const rowsOf = (map: Map<string, Paise[]>, key: string) =>
    (map.get(key) ?? []).map((amountPaise) => ({ amountPaise }));
  const allocatedTo = (map: Map<string, Paise[]>, key: string): Paise =>
    sumPaise(map.get(key) ?? []);

  // ── Invariant 1: Σ allocations of a payment ≤ payment amount. ──
  for (const payment of payments) {
    const allocated = allocatedTo(rowsBySource, sourceKey("payment", payment.id));
    if (allocated > payment.amountPaise) {
      report("ALLOCATIONS_EXCEED_PAYMENT", 1, "Σ allocations of a payment > payment amount", {
        paymentId: payment.id,
        allocatedPaise: allocated,
        amountPaise: payment.amountPaise,
      });
    }
    if (allocated < 0) {
      report("NEGATIVE_SOURCE_ALLOCATIONS", null, "Σ allocations of a payment < 0", {
        paymentId: payment.id,
        allocatedPaise: allocated,
      });
    }
    if (payment.reversed && allocated !== 0) {
      report("REVERSED_PAYMENT_STILL_ALLOCATED", null, "a reversed payment's rows must net to 0", {
        paymentId: payment.id,
        allocatedPaise: allocated,
      });
    }
  }
  // PLAN §7.2: the same bound for every source, so credit adjustments too.
  for (const adjustment of creditAdjustments) {
    const allocated = allocatedTo(rowsBySource, sourceKey("credit_adjustment", adjustment.id));
    if (allocated > adjustment.amountPaise) {
      report(
        "ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT",
        null,
        "Σ allocations of a credit adjustment > its amount",
        {
          creditAdjustmentId: adjustment.id,
          allocatedPaise: allocated,
          amountPaise: adjustment.amountPaise,
        },
      );
    }
    if (allocated < 0) {
      report("NEGATIVE_SOURCE_ALLOCATIONS", null, "Σ allocations of a credit adjustment < 0", {
        creditAdjustmentId: adjustment.id,
        allocatedPaise: allocated,
      });
    }
  }

  // ── Invariant 2: unallocated remainder = credit. ──
  const expectedCredit = sumPaise([
    ...payments.map((payment) =>
      unallocatedRemainder(payment, rowsOf(rowsBySource, sourceKey("payment", payment.id))),
    ),
    ...creditAdjustments.map((adjustment) =>
      unallocatedRemainder(
        adjustment,
        rowsOf(rowsBySource, sourceKey("credit_adjustment", adjustment.id)),
      ),
    ),
  ]);
  if (storedCredit !== expectedCredit) {
    report("CREDIT_MISMATCH", 2, "stored credit ≠ Σ unallocated remainders", {
      expectedPaise: expectedCredit,
      storedPaise: storedCredit,
    });
  }

  // ── Invariant 3: Σ ledger = Σ invoice charges − Σ payments − Σ credit adj + Σ reversals. ──
  const ledgerTotal = sumPaise(ledgerAmounts);
  const invoiceCharges = sumPaise(invoices.map((invoice) => invoice.chargesPaise));
  const paymentTotal = sumPaise(payments.map((payment) => payment.amountPaise));
  const creditAdjustmentTotal = sumPaise(creditAdjustments.map((a) => a.amountPaise));
  const reversalTotal = sumPaise(payments.filter((p) => p.reversed).map((p) => p.amountPaise));
  const expectedLedger = addPaise(
    subtractPaise(subtractPaise(invoiceCharges, paymentTotal), creditAdjustmentTotal),
    reversalTotal,
  );
  if (ledgerTotal !== expectedLedger) {
    report("LEDGER_MISMATCH", 3, "Σ ledger ≠ charges − payments − credit adj + reversals", {
      ledgerPaise: ledgerTotal,
      expectedPaise: expectedLedger,
      invoiceChargesPaise: invoiceCharges,
      paymentsPaise: paymentTotal,
      creditAdjustmentsPaise: creditAdjustmentTotal,
      reversalsPaise: reversalTotal,
    });
  }
  // PLAN §14 / T-052: the read model agrees with the ledger.
  if (storedBalance !== ledgerTotal) {
    report("BALANCE_MISMATCH", null, "stored balance ≠ Σ ledger", {
      ledgerPaise: ledgerTotal,
      storedPaise: storedBalance,
    });
  }

  // ── Invariant 4: invoice outstanding never goes below 0 (and never above its charges). ──
  for (const invoice of invoices) {
    const outstanding = invoiceOutstanding(invoice.chargesPaise, rowsOf(rowsByInvoice, invoice.id));
    if (outstanding < 0) {
      report("NEGATIVE_OUTSTANDING", 4, "invoice outstanding < 0", {
        invoiceId: invoice.id,
        outstandingPaise: outstanding,
        chargesPaise: invoice.chargesPaise,
      });
    }
    if (outstanding > invoice.chargesPaise) {
      report("OUTSTANDING_EXCEEDS_CHARGES", null, "Σ allocations of an invoice < 0", {
        invoiceId: invoice.id,
        outstandingPaise: outstanding,
        chargesPaise: invoice.chargesPaise,
      });
    }
  }

  // Stable sort: by check, then in the id order the checks ran in.
  const rank = (code: LedgerViolationCode) => LEDGER_VIOLATION_CODES.indexOf(code);
  return violations.sort((a, b) => rank(a.code) - rank(b.code));
}

function sourceKey(type: AllocationRow["sourceType"], id: string): string {
  return `${type}:${id}`;
}

function append(map: Map<string, Paise[]>, key: string, value: Paise): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareIds(a.id, b.id));
}

function duplicateIds(items: readonly { readonly id: string }[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}
