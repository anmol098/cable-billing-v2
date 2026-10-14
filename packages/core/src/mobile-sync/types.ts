/**
 * What the mobile sync services return (camelCase; the web routes map them to the contract's
 * `RosterCustomer`, `OpenBill` and `RecentPayment`).
 */
import type { InvoiceKind, PaymentMethod } from "@cb/db";
import type { Paise, Period } from "@cb/domain";

export interface RosterArea {
  readonly id: string;
  readonly name: string;
}

/** A current connection (disconnected ones are never sent to the phone). */
export interface RosterConnection {
  readonly vcNumber: string;
  readonly status: "active" | "suspended";
}

export interface RosterOpenBills {
  readonly count: number;
  readonly outstandingPaise: Paise;
  readonly oldestPeriod: Period | null;
}

/** One customer as the phone caches it (contract `RosterCustomer`). */
export interface RosterRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly altPhone: string | null;
  readonly address: string | null;
  readonly area: RosterArea | null;
  readonly active: boolean;
  /** Oldest first. */
  readonly connections: readonly RosterConnection[];
  /** Signed ledger balance: > 0 owes. */
  readonly balancePaise: Paise;
  readonly creditPaise: Paise;
  readonly openBills: RosterOpenBills;
  /** `roster_versions.changed_at`: strictly increasing per customer. */
  readonly updatedAt: Date;
}

/** One page of `GET /sync/customers`. */
export interface RosterPage {
  /** Active customers new or changed since the cursor. */
  readonly customers: readonly RosterRow[];
  /** Tombstones: customers that are inactive now (delta passes only). */
  readonly removedCustomerIds: readonly string[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface RosterOpenBill {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly kind: InvoiceKind;
  readonly period: Period;
  readonly chargesPaise: Paise;
  readonly outstandingPaise: Paise;
}

export interface RosterRecentPayment {
  readonly paymentId: string;
  readonly amountPaise: Paise;
  readonly method: PaymentMethod;
  readonly recordedAt: Date;
  readonly postedAt: Date;
  readonly receiptNumber: string;
  readonly provisionalRef: string | null;
  readonly collectedByName: string | null;
  readonly reversed: boolean;
}

/** `GET /customers/{id}`. */
export interface RosterCustomerDetail {
  readonly customer: RosterRow;
  /** Unpaid bills, oldest first (period, then id: the order payments are applied). */
  readonly openBills: readonly RosterOpenBill[];
  /** Latest first, at most {@link RECENT_PAYMENTS_LIMIT}. */
  readonly recentPayments: readonly RosterRecentPayment[];
}

/** How many recent payments the customer detail carries (the contract allows up to 20). */
export const RECENT_PAYMENTS_LIMIT = 10;
