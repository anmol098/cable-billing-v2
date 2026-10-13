/**
 * What the collection services return (T-062). camelCase, integer paise, `Date` instants, IST
 * `BusinessDate`s. T-061 maps {@link CollectionDayView} onto the contract's `CollectionDay`
 * (field by field below); the web Linemen page renders {@link LinemenDayView} and
 * {@link LinemanDayView}.
 */
import type {
  CollectionSessionStatus,
  DiscrepancyReason,
  HandoverEventType,
  PaymentMethod,
} from "@cb/db";
import type { BusinessDate } from "@cb/domain";

/**
 * The latest handover of a day (contract `Handover`):
 * `cash_expected_paise` = `cashExpectedPaise` (the snapshot at submission), `cash_handed_over_paise`,
 * `discrepancy_paise`, `discrepancy_reason`, `note`, `unsynced_payment_count`,
 * `unsynced_cash_paise`, `submitted_at`, `reviewed_at`, `review_note` (ISO strings on the wire).
 */
export interface HandoverView {
  readonly submissionId: string;
  /** Cash the server expected when the handover was submitted (snapshot; UPI excluded). */
  readonly cashExpectedPaise: number;
  readonly cashHandedOverPaise: number;
  /** `cashHandedOverPaise − cashExpectedPaise` (server-computed). Negative = short. */
  readonly discrepancyPaise: number;
  readonly discrepancyReason: DiscrepancyReason | null;
  /** The lineman's note. */
  readonly note: string | null;
  /** Payments still on the phone at submission, as the phone reported them. */
  readonly unsyncedPaymentCount: number;
  readonly unsyncedCashPaise: number;
  readonly submittedAt: Date;
  /** The office's decision (`accepted` / `returned`), else null. */
  readonly reviewedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly reviewNote: string | null;
}

/** One payment of the day (contract `DayPayment`, plus `needsReview` for the office). */
export interface DayPaymentView {
  readonly paymentId: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly amountPaise: number;
  readonly method: PaymentMethod;
  readonly recordedAt: Date;
  readonly postedAt: Date;
  readonly receiptNumber: string;
  readonly provisionalRef: string | null;
  /** Reversed by the owner: listed, but not in the totals. */
  readonly reversed: boolean;
  /** Flagged for the office (T-046 review reasons). */
  readonly needsReview: boolean;
}

/**
 * A lineman's day (contract `CollectionDay`): `business_date`, `cash_total_paise` =
 * `cashExpectedPaise`, `upi_total_paise`, `payment_count`, `status`, `handover`, `payments`.
 * All zero with status `open` (and `sessionId: null`) when the server has nothing for that day.
 */
export interface CollectionDayView {
  /** The `collection_sessions` row, or null when the day has no session yet. */
  readonly sessionId: string | null;
  readonly collectorId: string;
  readonly businessDate: BusinessDate;
  /** Cash the office expects now: server-known cash payments, not reversed (running total). */
  readonly cashExpectedPaise: number;
  /** UPI collected (server-known, not reversed). Never part of the cash handover. */
  readonly upiTotalPaise: number;
  /** Server-known payments, not reversed. */
  readonly paymentCount: number;
  readonly status: CollectionSessionStatus;
  readonly handover: HandoverView | null;
  /** Newest first (by `recordedAt`), reversed ones included and flagged. */
  readonly payments: readonly DayPaymentView[];
}

/**
 * Whether the server's totals may be missing payments still on the lineman's phone (PLAN §8.7
 * "Unsynced payments on the device are shown as a warning"). See `rules.ts`.
 */
export interface PhoneWarningView {
  /** Newest `last_seen_at` of the lineman's phones that are not signed out; null = no phone. */
  readonly lastSeenAt: Date | null;
  /** Later of `lastSeenAt` and the latest handover submission (both are contacts). */
  readonly lastContactAt: Date | null;
  /** The phone has not been in touch since the day could have ended (`phoneMayHoldPayments`). */
  readonly phoneNotSeen: boolean;
  /** As reported with the latest handover (0 without a handover). */
  readonly reportedUnsyncedCount: number;
  readonly reportedUnsyncedCashPaise: number;
}

/** One lineman's card on the Linemen page for one day. */
export interface LinemanDayCard {
  readonly linemanId: string;
  readonly name: string;
  /** False for a deactivated lineman (listed only when the day has a session). */
  readonly active: boolean;
  readonly sessionId: string | null;
  readonly cashExpectedPaise: number;
  readonly upiTotalPaise: number;
  readonly paymentCount: number;
  readonly status: CollectionSessionStatus;
  readonly handover: HandoverView | null;
  /**
   * The running cash total moved after the handover was submitted (a late-synced or reversed
   * payment): `cashExpectedPaise ≠ handover.cashExpectedPaise`.
   */
  readonly changedSinceHandover: boolean;
  readonly phone: PhoneWarningView;
}

/** The Linemen page for one day. */
export interface LinemenDayView {
  readonly businessDate: BusinessDate;
  /** True when `businessDate` is today in IST. */
  readonly isToday: boolean;
  /** Waiting for the office first, then returned, open and accepted; by name within each. */
  readonly linemen: readonly LinemanDayCard[];
  readonly totals: {
    readonly cashExpectedPaise: number;
    readonly upiTotalPaise: number;
    readonly paymentCount: number;
    /** Handovers with status `submitted`. */
    readonly waitingCount: number;
  };
}

/** One step of a day's handover history (`handover_events`). */
export interface HandoverEventView {
  readonly id: string;
  readonly type: HandoverEventType;
  readonly submissionId: string;
  readonly at: Date;
  readonly actorId: string;
  readonly actorName: string;
  /** Submitted only (else null). */
  readonly cashExpectedPaise: number | null;
  readonly cashHandedOverPaise: number | null;
  readonly discrepancyPaise: number | null;
  readonly discrepancyReason: DiscrepancyReason | null;
  readonly unsyncedPaymentCount: number | null;
  readonly unsyncedCashPaise: number | null;
  /** The lineman's note (submitted) or the office's note (accepted / returned). */
  readonly note: string | null;
}

/** The review screen: one lineman's day with payments, history and the phone warning. */
export interface LinemanDayView {
  readonly linemanId: string;
  readonly name: string;
  readonly active: boolean;
  readonly isToday: boolean;
  readonly day: CollectionDayView;
  readonly changedSinceHandover: boolean;
  readonly phone: PhoneWarningView;
  /** Oldest first. */
  readonly history: readonly HandoverEventView[];
}

/** `handover.submit` result. `duplicate`: the same submission was already stored (nothing written). */
export interface SubmitHandoverResult {
  readonly outcome: "submitted" | "duplicate";
  readonly day: CollectionDayView;
}

/** `handover.accept` / `handover.return` result. */
export interface ReviewHandoverResult {
  readonly sessionId: string;
  readonly submissionId: string;
  readonly status: "accepted" | "returned";
  readonly reviewedAt: Date;
  readonly reviewedBy: string;
  readonly reviewNote: string | null;
}
