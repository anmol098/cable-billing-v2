/**
 * Pure statement arithmetic (T-049): the date range in IST and the running balance. No I/O, so the
 * IST boundaries and the "closing = opening + Σ lines" rule are unit-tested without a database.
 *
 * - A line belongs to the day of its `ledger_entries.at` in IST (`businessDateOf`). The range
 *   `[from, to]` covers `[istStartOfDay(from), istStartOfDay(to + 1 day))`.
 * - The opening balance is Σ every entry before `istStartOfDay(from)` (0 without `from`).
 * - Lines run in posting order (`seq`, PLAN §7.2 "running balance = Σ amount ORDER BY seq");
 *   each line's balance is the opening plus every earlier line of the range.
 * - closing = opening + Σ lines, so it equals Σ every entry up to the end of `to`; with `to` =
 *   today that is Σ every entry, which is `customer_balances.balance_paise` (T-052 checks it).
 */
import {
  addDays,
  addPaise,
  type BusinessDate,
  compareBusinessDates,
  istStartOfDay,
  type Paise,
  sumPaise,
  toPaise,
} from "@cb/domain";
import type { StatementLineType, StatementTotals } from "./types";

/** Lines a statement shows at most (the newest); older ones fold into the opening balance. */
export const STATEMENT_MAX_LINES = 1000;

/** What a statement asks for. */
export interface StatementRangeRequest {
  readonly from?: BusinessDate | undefined;
  readonly to?: BusinessDate | undefined;
}

/** The resolved range and its UTC bounds. */
export interface ResolvedStatementRange {
  readonly from: BusinessDate | null;
  readonly to: BusinessDate;
  readonly today: BusinessDate;
  readonly asOfNow: boolean;
  /** Entries at or after this instant are in the range (null: from the start). */
  readonly startsAt: Date | null;
  /** Entries before this instant are in the range (null: up to now, nothing left out). */
  readonly endsBefore: Date | null;
}

/**
 * Resolves `{ from?, to? }` against today (IST): `to` defaults to today and is never later than
 * today (a statement can't show the future); `from` may not be after `to` (the caller validates
 * that first, so here it is a programming error).
 */
export function resolveStatementRange(
  request: StatementRangeRequest,
  today: BusinessDate,
): ResolvedStatementRange {
  const wantedTo = request.to ?? today;
  const to = compareBusinessDates(wantedTo, today) > 0 ? today : wantedTo;
  const from = request.from ?? null;
  if (from !== null && compareBusinessDates(from, to) > 0) {
    throw new RangeError("statement range: from is after to");
  }
  const asOfNow = to === today;
  return {
    from,
    to,
    today,
    asOfNow,
    startsAt: from === null ? null : istStartOfDay(from),
    // As of now: every entry counts, also one posted a moment "after" the clock we were given.
    endsBefore: asOfNow ? null : istStartOfDay(addDays(to, 1)),
  };
}

/** A ledger entry as the statement needs it (posting order). */
export interface LedgerAmount {
  readonly seq: number;
  readonly type: StatementLineType;
  readonly amountPaise: Paise;
}

/** The running balance over a range's entries. */
export interface RunningBalance<T extends LedgerAmount> {
  /** The opening balance plus the sum of the hidden lines. */
  readonly openingBalancePaise: Paise;
  /** The shown lines with the balance after each. */
  readonly lines: readonly (T & { readonly balanceAfterPaise: Paise })[];
  readonly hiddenLines: number;
  readonly totals: StatementTotals;
  readonly closingBalancePaise: Paise;
}

/**
 * Running balance: `entries` are the range's entries (any order: they are sorted by `seq` here).
 * With more than `maxLines`, the oldest are hidden and their sum moves into the opening balance.
 * Totals cover every entry of the range (hidden ones too).
 */
export function runningBalance<T extends LedgerAmount>(
  openingPaise: Paise,
  entries: readonly T[],
  maxLines = STATEMENT_MAX_LINES,
): RunningBalance<T> {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const hidden = Math.max(0, sorted.length - maxLines);
  const hiddenSum = sumPaise(sorted.slice(0, hidden).map((entry) => entry.amountPaise));
  const opening = addPaise(openingPaise, hiddenSum);
  let balance = opening;
  const lines = sorted.slice(hidden).map((entry) => {
    balance = addPaise(balance, entry.amountPaise);
    return { ...entry, balanceAfterPaise: balance };
  });
  return {
    openingBalancePaise: opening,
    lines,
    hiddenLines: hidden,
    totals: statementTotals(sorted),
    closingBalancePaise: balance,
  };
}

/** Σ per kind, as positive amounts. */
export function statementTotals(entries: readonly LedgerAmount[]): StatementTotals {
  let billed = 0;
  let paid = 0;
  let undone = 0;
  let discount = 0;
  for (const entry of entries) {
    const amount = entry.amountPaise as number;
    switch (entry.type) {
      case "invoice":
      case "opening_balance":
      case "debit_adjustment":
        billed += amount;
        break;
      case "payment":
        paid -= amount;
        break;
      case "payment_reversal":
        undone += amount;
        break;
      case "credit_adjustment":
        discount -= amount;
        break;
    }
  }
  return {
    billedPaise: toPaise(billed),
    paidPaise: toPaise(paid),
    undonePaise: toPaise(undone),
    discountPaise: toPaise(discount),
  };
}
