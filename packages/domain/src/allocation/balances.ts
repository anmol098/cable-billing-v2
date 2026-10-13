/**
 * The two derived figures allocation works from. Both are sums of append-only rows, so they can be
 * recomputed from the database at any time (and `checkLedger` does exactly that).
 */
import { type Paise, subtractPaise, sumPaise, ZERO_PAISE } from "../money";

type HasAmount = { readonly amountPaise: Paise };

/**
 * What is still owed on one invoice: its charges − Σ its allocation rows (negative reversal rows
 * add back). Pass only the rows whose `invoiceId` is this invoice. Invariant 4 says this is never
 * below 0.
 */
export function invoiceOutstanding(chargesPaise: Paise, allocations: Iterable<HasAmount>): Paise {
  return subtractPaise(chargesPaise, sumPaise(amounts(allocations)));
}

/**
 * What a payment or credit adjustment still has unallocated: its amount − Σ its allocation rows,
 * or 0 once the payment is reversed (a reversed payment is no longer anyone's money to apply).
 * Pass only the rows whose source is this one. Summed over a customer's sources this is the
 * customer's credit (invariant 2).
 */
export function unallocatedRemainder(
  source: { readonly amountPaise: Paise; readonly reversed?: boolean },
  allocations: Iterable<HasAmount>,
): Paise {
  if (source.reversed === true) return ZERO_PAISE;
  return subtractPaise(source.amountPaise, sumPaise(amounts(allocations)));
}

function* amounts(rows: Iterable<HasAmount>): Generator<Paise> {
  for (const row of rows) yield row.amountPaise;
}
