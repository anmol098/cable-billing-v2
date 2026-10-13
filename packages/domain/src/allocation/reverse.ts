/**
 * Payment reversal (PLAN §8.6; BRD RULE-20; PRD BR-13, FR-013).
 *
 * "This inserts a `payment_reversal`, a ledger entry (+amount), and negative allocation rows that
 * cancel the payment's allocations. Credit stays consistent. … The original rows are never
 * touched." Financial records are append-only (CLAUDE.md), so a reversal only ever **adds** rows.
 */
import { isPaise, negatePaise, type Paise, subtractPaise, sumPaise } from "../money";
import { domainError, err, ok, type Result } from "../result";
import { compareIds } from "./order";
import type { AllocationRow, ReversalError } from "./types";

/** The payment being reversed. `reversed`: a `payment_reversals` row already exists for it. */
export type ReversiblePayment = {
  readonly id: string;
  readonly amountPaise: Paise;
  readonly reversed: boolean;
};

/** A negative allocation row that cancels one original row. Store it with the reversal's id. */
export type ReversalAllocation = {
  readonly sourceType: "payment";
  readonly sourceId: string;
  readonly invoiceId: string;
  /** Always < 0: minus the original row's amount. */
  readonly amountPaise: Paise;
  /** The `allocations.id` this row cancels (for the audit trail; the DB keeps `reversal_id`). */
  readonly reversesAllocationId: string;
};

export type ReverseResult = {
  /** Rows to insert, one per original positive row, ordered by the original row's id. */
  readonly allocations: readonly ReversalAllocation[];
  /** Σ of the original rows: how much becomes owed again on invoices. ≥ 0. */
  readonly deallocatedPaise: Paise;
  /** The ledger entry to append (`payment_reversal`): +payment amount ("+ increases due"). */
  readonly ledgerDeltaPaise: Paise;
  /**
   * How the customer's credit changes: minus the payment's unallocated remainder (≤ 0). A reversed
   * payment's remainder stops being credit, so the customer can't spend money they didn't pay.
   */
  readonly creditDeltaPaise: Paise;
};

/**
 * Builds the rows that reverse `payment`. `allocations` must be **all** the payment's stored
 * allocation rows: those from posting (PLAN §8.4) and those from later credit application
 * (PLAN §8.5, where the payment's remainder was the source). Every one is cancelled, so the
 * invoices it paid are owed again and its credit is gone.
 *
 * Errors: `CONFLICT` when the payment is already reversed (one reversal per payment:
 * `payment_reversals.payment_id` is unique), including when a negative or reversal-linked row is
 * present; `VALIDATION` when a row belongs to another source or is malformed or repeated;
 * `INVARIANT_VIOLATION` when the rows add up to more than the payment (invariant 1 broken).
 */
export function reverse(
  payment: ReversiblePayment,
  allocations: readonly AllocationRow[],
): Result<ReverseResult, ReversalError> {
  if (typeof payment.id !== "string" || payment.id === "") {
    return err(domainError("VALIDATION", "payment id is required", { field: "id" }));
  }
  if (!isPaise(payment.amountPaise) || payment.amountPaise <= 0) {
    return err(
      domainError("VALIDATION", "payment amount must be a positive integer of paise", {
        paymentId: payment.id,
      }),
    );
  }
  if (payment.reversed) {
    return err(domainError("CONFLICT", "payment is already reversed", { paymentId: payment.id }));
  }

  const seen = new Set<string>();
  const originals: AllocationRow[] = [];
  for (const row of allocations) {
    if (typeof row.id !== "string" || row.id === "" || !isPaise(row.amountPaise)) {
      return err(domainError("VALIDATION", "malformed allocation row", { paymentId: payment.id }));
    }
    if (seen.has(row.id)) {
      return err(
        domainError("VALIDATION", "allocation row listed twice", { allocationId: row.id }),
      );
    }
    seen.add(row.id);
    if (row.sourceType !== "payment" || row.sourceId !== payment.id) {
      return err(
        domainError("VALIDATION", "allocation row belongs to another source", {
          paymentId: payment.id,
          allocationId: row.id,
        }),
      );
    }
    if (row.amountPaise < 0 || (row.reversalId ?? null) !== null) {
      return err(
        domainError("CONFLICT", "payment already has reversal rows", {
          paymentId: payment.id,
          allocationId: row.id,
        }),
      );
    }
    // A zero row cancels nothing; we never create one, but it is harmless if present.
    if (row.amountPaise > 0) originals.push(row);
  }

  const deallocatedPaise = sumPaise(originals.map((row) => row.amountPaise));
  if (deallocatedPaise > payment.amountPaise) {
    return err(
      domainError("INVARIANT_VIOLATION", "allocations exceed the payment (invariant 1)", {
        paymentId: payment.id,
        allocatedPaise: deallocatedPaise,
        amountPaise: payment.amountPaise,
      }),
    );
  }

  const rows = [...originals]
    .sort((a, b) => compareIds(a.id, b.id))
    .map(
      (row): ReversalAllocation => ({
        sourceType: "payment",
        sourceId: payment.id,
        invoiceId: row.invoiceId,
        amountPaise: negatePaise(row.amountPaise),
        reversesAllocationId: row.id,
      }),
    );

  return ok({
    allocations: rows,
    deallocatedPaise,
    ledgerDeltaPaise: payment.amountPaise,
    creditDeltaPaise: negatePaise(subtractPaise(payment.amountPaise, deallocatedPaise)),
  });
}
