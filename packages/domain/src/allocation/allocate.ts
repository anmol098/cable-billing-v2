/**
 * Payment allocation (PLAN §8.4) and credit application (PLAN §8.5).
 *
 * Rules, from the source documents:
 * - BRD B-010 / RULE-12, PRD BR-09 / FR-014: allocate to the **oldest outstanding invoice first**.
 * - PRD §13.2 step 3, PLAN §8.4: order by period (oldest first), then invoice id as the stable
 *   tie-break.
 * - BRD RULE-11, PRD §13.2 step 4: partial settlement is allowed, across one or more invoices.
 * - BRD B-011 / RULE-13, PRD FR-014: the remainder becomes **customer credit**, shown separately.
 * - PLAN §8.5 (D-14): credit is applied to the oldest outstanding invoices, **oldest source first**.
 *
 * Both functions are pure: they never mutate their inputs and return new arrays in a deterministic
 * order (the order in which money was applied).
 */
import { isPaise, minPaise, type Paise, subtractPaise, sumPaise } from "../money";
import { domainError, err, ok, type Result } from "../result";
import { isPeriod } from "../time";
import { compareInvoicesOldestFirst, compareSourcesOldestFirst, instantMs } from "./order";
import {
  ALLOCATION_SOURCE_TYPES,
  type AllocationError,
  type CreditAllocation,
  type CreditSource,
  type InvoiceAllocation,
  type OpenInvoice,
} from "./types";

export type AllocateResult = {
  /** Allocation rows to insert, oldest invoice first. Every amount is > 0. */
  readonly allocations: readonly InvoiceAllocation[];
  /** Σ `allocations`. */
  readonly allocatedPaise: Paise;
  /** The unallocated remainder: the customer's new credit from this payment (RULE-13). ≥ 0. */
  readonly creditPaise: Paise;
  /** The invoices still owed after this payment, oldest first (outstanding > 0 only). */
  readonly openInvoices: readonly OpenInvoice[];
};

/**
 * Allocates a payment of `amountPaise` to `openInvoices`, oldest first (PLAN §8.4):
 *
 * ```text
 * open = invoices with outstanding > 0 ORDER BY period ASC, id ASC
 * for inv in open while remaining > 0:
 *    a = min(remaining, inv.outstanding); allocation(inv, a); remaining -= a
 * remaining > 0 → customer credit
 * ```
 *
 * Errors: `VALIDATION` when the amount is not > 0 (PRD §13.2 step 1; the `payments` table has
 * `CHECK amount_paise > 0`) or an invoice is malformed or listed twice; `INVARIANT_VIOLATION`
 * when an invoice's outstanding is negative (invariant 4 is already broken).
 */
export function allocate(
  amountPaise: Paise,
  openInvoices: readonly OpenInvoice[],
): Result<AllocateResult, AllocationError> {
  if (!isPaise(amountPaise) || amountPaise <= 0) {
    return err(
      domainError("VALIDATION", "payment amount must be a positive integer of paise", {
        field: "amountPaise",
      }),
    );
  }
  const prepared = prepareInvoices(openInvoices);
  if (!prepared.ok) return prepared;
  const invoices = prepared.value;

  const allocations: InvoiceAllocation[] = [];
  let remaining = amountPaise;
  for (const invoice of invoices) {
    if (remaining === 0) break;
    const amount = minPaise(remaining, invoice.outstandingPaise);
    allocations.push({ invoiceId: invoice.id, amountPaise: amount });
    invoice.outstandingPaise = subtractPaise(invoice.outstandingPaise, amount);
    remaining = subtractPaise(remaining, amount);
  }

  return ok({
    allocations,
    allocatedPaise: subtractPaise(amountPaise, remaining),
    creditPaise: remaining,
    openInvoices: stillOpen(invoices),
  });
}

/** A credit source after {@link applyCredit}: what it still has unallocated. */
export type RemainingCredit = {
  readonly sourceType: CreditSource["sourceType"];
  readonly sourceId: string;
  readonly availablePaise: Paise;
};

export type ApplyCreditResult = {
  /** Allocation rows to insert, in the order applied (oldest source, then oldest invoice). */
  readonly allocations: readonly CreditAllocation[];
  /** Σ `allocations`: how much the customer's credit went down. The ledger does not change. */
  readonly appliedPaise: Paise;
  /** Every source with something left, oldest first. */
  readonly remainingSources: readonly RemainingCredit[];
  /** Σ `remainingSources`: the customer's credit afterwards. */
  readonly remainingCreditPaise: Paise;
  /** The invoices still owed afterwards, oldest first (outstanding > 0 only). */
  readonly openInvoices: readonly OpenInvoice[];
};

/**
 * Applies unallocated credit to outstanding invoices (PLAN §8.5, D-14): the oldest source pays the
 * oldest invoice first, and each source is used up before the next one starts. Applying credit
 * moves no money, so the ledger balance does not change; the rows only make "which bill is paid"
 * explicit.
 *
 * PLAN §8.5 runs this "whenever a new invoice or debit-adjusted invoice is issued". Sources and
 * invoices with nothing left (0) may be passed and are skipped.
 *
 * Errors: `VALIDATION` for a malformed or duplicate source or invoice; `INVARIANT_VIOLATION` for a
 * negative `availablePaise` (invariant 1 broken) or a negative outstanding (invariant 4 broken).
 */
export function applyCredit(
  creditSources: readonly CreditSource[],
  openInvoices: readonly OpenInvoice[],
): Result<ApplyCreditResult, AllocationError> {
  const preparedSources = prepareSources(creditSources);
  if (!preparedSources.ok) return preparedSources;
  const prepared = prepareInvoices(openInvoices);
  if (!prepared.ok) return prepared;
  const sources = preparedSources.value;
  const invoices = prepared.value;

  const allocations: CreditAllocation[] = [];
  let next = 0; // index of the oldest invoice that may still be owed
  for (const source of sources) {
    while (source.availablePaise > 0 && next < invoices.length) {
      const invoice = invoices[next];
      if (invoice === undefined) break;
      const amount = minPaise(source.availablePaise, invoice.outstandingPaise);
      allocations.push({
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        invoiceId: invoice.id,
        amountPaise: amount,
      });
      source.availablePaise = subtractPaise(source.availablePaise, amount);
      invoice.outstandingPaise = subtractPaise(invoice.outstandingPaise, amount);
      if (invoice.outstandingPaise === 0) next += 1;
    }
  }

  const remainingSources = sources
    .filter((source) => source.availablePaise > 0)
    .map(({ sourceType, sourceId, availablePaise }) => ({ sourceType, sourceId, availablePaise }));
  return ok({
    allocations,
    appliedPaise: sumPaise(allocations.map((allocation) => allocation.amountPaise)),
    remainingSources,
    remainingCreditPaise: sumPaise(remainingSources.map((source) => source.availablePaise)),
    openInvoices: stillOpen(invoices),
  });
}

// ── Input checks. Each returns fresh, mutable copies in allocation order. ───────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function prepareInvoices(
  openInvoices: readonly OpenInvoice[],
): Result<Mutable<OpenInvoice>[], AllocationError> {
  const seen = new Set<string>();
  const invoices: Mutable<OpenInvoice>[] = [];
  for (const invoice of openInvoices) {
    const { id, period, outstandingPaise } = invoice;
    if (typeof id !== "string" || id === "" || !isPeriod(period) || !isPaise(outstandingPaise)) {
      return err(domainError("VALIDATION", "malformed open invoice", { invoiceId: String(id) }));
    }
    if (seen.has(id)) {
      return err(domainError("VALIDATION", "invoice listed twice", { invoiceId: id }));
    }
    seen.add(id);
    if (outstandingPaise < 0) {
      return err(
        domainError("INVARIANT_VIOLATION", "invoice outstanding is negative (invariant 4)", {
          invoiceId: id,
          outstandingPaise,
        }),
      );
    }
    if (outstandingPaise > 0) invoices.push({ id, period, outstandingPaise });
  }
  return ok(invoices.sort(compareInvoicesOldestFirst));
}

function prepareSources(
  creditSources: readonly CreditSource[],
): Result<Mutable<CreditSource>[], AllocationError> {
  const seen = new Set<string>();
  const sources: Mutable<CreditSource>[] = [];
  for (const source of creditSources) {
    const { sourceType, sourceId, availablePaise, at } = source;
    const key = `${sourceType}:${sourceId}`;
    if (
      !(ALLOCATION_SOURCE_TYPES as readonly string[]).includes(sourceType) ||
      typeof sourceId !== "string" ||
      sourceId === "" ||
      !isPaise(availablePaise) ||
      !(typeof at === "number" || at instanceof Date) ||
      !Number.isFinite(instantMs(at))
    ) {
      return err(
        domainError("VALIDATION", "malformed credit source", { sourceId: String(sourceId) }),
      );
    }
    if (seen.has(key)) {
      return err(domainError("VALIDATION", "credit source listed twice", { sourceType, sourceId }));
    }
    seen.add(key);
    if (availablePaise < 0) {
      return err(
        domainError("INVARIANT_VIOLATION", "credit source is over-allocated (invariant 1)", {
          sourceType,
          sourceId,
          availablePaise,
        }),
      );
    }
    if (availablePaise > 0) sources.push({ sourceType, sourceId, availablePaise, at });
  }
  return ok(sources.sort(compareSourcesOldestFirst));
}

function stillOpen(invoices: readonly Mutable<OpenInvoice>[]): OpenInvoice[] {
  return invoices
    .filter((invoice) => invoice.outstandingPaise > 0)
    .map(({ id, period, outstandingPaise }) => ({ id, period, outstandingPaise }));
}
