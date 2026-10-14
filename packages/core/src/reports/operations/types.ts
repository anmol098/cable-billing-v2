/**
 * What the operations reports return (T-081, BRD §12). Amounts are integer paise, instants UTC
 * `Date`s, days IST `BusinessDate`s and months `Period`s. Every report says when its numbers are
 * from (`asOf`), and its `totals` cover every row that matches the filters, not only the page.
 */
import type {
  AssignmentStatus,
  BillingRunItemOutcome,
  BillingRunSkipReason,
  BillingRunStatus,
  BillingRunTrigger,
  CollectionSessionStatus,
  DiscrepancyReason,
  UserRole,
} from "@cb/db";
import type { BusinessDate, Paise, Period } from "@cb/domain";
import type { HandoverEventView } from "../../collections/types";
import type { ReportAsOf } from "../dues/as-of";

/** A user of the business as a filter option. */
export interface ReportPerson {
  readonly id: string;
  readonly name: string;
  readonly role: UserRole;
  /** False for a switched-off user. */
  readonly active: boolean;
}

// ---------------------------------------------------------------------------------------------
// Daily collections

/** Money taken, cash and UPI apart (never added into one number by the service). */
export interface CollectionAmounts {
  /** Cash payments, not cancelled. */
  readonly cashPaise: Paise;
  /** UPI payments, not cancelled. */
  readonly upiPaise: Paise;
  /** Payments counted (not cancelled). */
  readonly count: number;
  /** Payments the owner cancelled (listed apart, never counted). */
  readonly cancelledCount: number;
  readonly cancelledPaise: Paise;
}

/** Who took the money: a user, or `null` for payments brought from the old app (no collector). */
export interface CollectionPerson {
  readonly collectorId: string | null;
  readonly name: string | null;
  readonly role: UserRole | null;
  readonly active: boolean;
}

/** One person's money for one IST day. */
export interface CollectionDayRow extends CollectionAmounts, CollectionPerson {
  readonly businessDate: BusinessDate;
}

/** One person's money over the chosen days. */
export interface CollectionPersonRow extends CollectionAmounts, CollectionPerson {
  /** Days with at least one payment (counted or cancelled). */
  readonly days: number;
}

/** `reports.collections`. */
export interface CollectionsReport {
  readonly asOf: ReportAsOf;
  readonly from: BusinessDate;
  readonly to: BusinessDate;
  /** Every user of the business, by name (the "Taken by" filter). */
  readonly collectors: readonly ReportPerson[];
  readonly totals: CollectionAmounts & {
    /** People (incl. the old app) with a payment in the days. */
    readonly people: number;
  };
  /** Per person over the days, by name (never paged: one row per person). */
  readonly byCollector: readonly CollectionPersonRow[];
  /** Per person per day: newest day first, then by name. */
  readonly rows: readonly CollectionDayRow[];
  /** Day rows over every page. */
  readonly rowCount: number;
  readonly page: number;
  readonly pageSize: number;
}

// ---------------------------------------------------------------------------------------------
// Cash handover

/** The latest handover of a lineman's day (the session row). */
export interface HandoverReportHandover {
  /** Cash expected when it was handed over (the server's snapshot; UPI not included). */
  readonly cashExpectedPaise: Paise;
  readonly cashHandedOverPaise: Paise;
  /** handed − expected (snapshot). Negative = short. */
  readonly discrepancyPaise: number;
  readonly discrepancyReason: DiscrepancyReason | null;
  /** The lineman's note. */
  readonly note: string | null;
  readonly submittedAt: Date;
  /** The office's decision (accepted / returned), else null. */
  readonly reviewedAt: Date | null;
  readonly reviewedByName: string | null;
  readonly reviewNote: string | null;
}

/** One lineman's day (one `collection_sessions` row). */
export interface HandoverReportRow {
  readonly sessionId: string;
  readonly linemanId: string;
  readonly linemanName: string;
  readonly linemanActive: boolean;
  readonly businessDate: BusinessDate;
  readonly status: CollectionSessionStatus;
  /** Cash the office expects now: the day's phone cash payments, not cancelled (T-062 rule). */
  readonly cashExpectedPaise: Paise;
  /** UPI of the day: never part of the cash handover. */
  readonly upiTotalPaise: Paise;
  readonly paymentCount: number;
  readonly handover: HandoverReportHandover | null;
  /** The cash total moved after the handover (a late phone payment or a cancelled one). */
  readonly changedSinceHandover: boolean;
  /** What happened, oldest first (`handover_events`, with names). */
  readonly history: readonly HandoverEventView[];
}

/** `reports.handover`. */
export interface HandoverReport {
  readonly asOf: ReportAsOf;
  readonly from: BusinessDate;
  readonly to: BusinessDate;
  /** Linemen (any status) and anyone with a day in the range, by name (the filter). */
  readonly linemen: readonly ReportPerson[];
  readonly totals: {
    /** Days listed. */
    readonly days: number;
    /** Σ cash expected now. */
    readonly cashExpectedPaise: Paise;
    /** Σ UPI (not part of the cash). */
    readonly upiTotalPaise: Paise;
    /** Σ cash handed over (days with a handover). */
    readonly cashHandedOverPaise: Paise;
    /** Σ cash expected of days not handed over yet (status `open`). */
    readonly notHandedOverPaise: Paise;
    /** Σ of the short differences, as a positive amount. */
    readonly shortPaise: Paise;
    /** Σ of the extra differences. */
    readonly extraPaise: Paise;
    /** Days whose handover has a difference. */
    readonly differenceCount: number;
    readonly byStatus: Readonly<Record<CollectionSessionStatus, number>>;
  };
  /** Newest day first; on one day: waiting, sent back, not handed over, accepted; then name. */
  readonly rows: readonly HandoverReportRow[];
  readonly page: number;
  readonly pageSize: number;
}

// ---------------------------------------------------------------------------------------------
// Connections

/** One connection (VC assignment) on the chosen day. */
export interface ConnectionReportRow {
  readonly assignmentId: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly areaId: string | null;
  readonly areaName: string | null;
  readonly vcNumber: string;
  /** The status **during** the day (T-040 `assignmentStatusOn`: changes count from the next day). */
  readonly status: AssignmentStatus;
  /** The first day of that status (start, or the day after the change). */
  readonly since: BusinessDate;
  readonly startDate: BusinessDate;
  /** Last day of service (removed connections). */
  readonly endDate: BusinessDate | null;
  /** The plan of the day's month (null = own amount). */
  readonly planId: string | null;
  readonly planName: string | null;
  /** The monthly rent of the day's month (T-040 `rentalForPeriod`). */
  readonly rentPaise: Paise;
}

/** `reports.connections`. */
export interface ConnectionsReport {
  readonly asOf: ReportAsOf;
  /** The day the statuses are for. */
  readonly date: BusinessDate;
  readonly isToday: boolean;
  readonly areas: readonly { readonly id: string; readonly name: string }[];
  /** Every plan (also retired ones: old connections keep them), by name. */
  readonly plans: readonly {
    readonly id: string;
    readonly name: string;
    readonly monthlyAmountPaise: Paise;
    readonly retired: boolean;
  }[];
  readonly totals: {
    readonly connections: number;
    readonly byStatus: Readonly<Record<AssignmentStatus, number>>;
    /** Σ monthly rent of the active connections (what the month's bills charge for them). */
    readonly activeRentPaise: Paise;
    /** Customers with at least one active connection. */
    readonly activeCustomers: number;
  };
  /** By customer code, then VC number. */
  readonly rows: readonly ConnectionReportRow[];
  readonly page: number;
  readonly pageSize: number;
}

// ---------------------------------------------------------------------------------------------
// Billing runs

/** A month's bill run (the `billing_runs` row). */
export interface BillingRunReportRun {
  readonly id: string;
  readonly period: Period;
  readonly status: BillingRunStatus;
  readonly trigger: BillingRunTrigger;
  readonly skipReason: BillingRunSkipReason | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
  /** Who started a manual run. */
  readonly startedByName: string | null;
  /** The run's own counters (kept by T-044), for the reconciliation. */
  readonly customerCount: number;
  readonly createdCount: number;
  readonly alreadyExistsCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly totalChargesPaise: Paise;
}

/** One customer the run looked at (`billing_run_items`). */
export interface BillingRunReportRow {
  readonly itemId: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly areaName: string | null;
  readonly outcome: BillingRunItemOutcome;
  /** Machine code for skipped / failed customers (shown in plain words by the page). */
  readonly reason: string | null;
  /** The month's bill (new or already there). */
  readonly invoiceId: string | null;
  readonly invoiceNumber: string | null;
  readonly chargesPaise: Paise | null;
  readonly attempts: number;
  /** When the customer was last tried. */
  readonly lastTriedAt: Date;
}

/** `reports.billing_runs`. */
export interface BillingRunReport {
  readonly asOf: ReportAsOf;
  /** The month shown. */
  readonly period: Period;
  /** Every run of the business, newest month first (the month picker). */
  readonly runs: readonly {
    readonly id: string;
    readonly period: Period;
    readonly status: BillingRunStatus;
  }[];
  readonly areas: readonly { readonly id: string; readonly name: string }[];
  /** Null when the month has no run. */
  readonly run: BillingRunReportRun | null;
  readonly totals: {
    readonly customers: number;
    readonly byOutcome: Readonly<Record<BillingRunItemOutcome, number>>;
    /** Σ charges of the bills this run made. */
    readonly createdChargesPaise: Paise;
    /** Σ charges of the bills that were already there. */
    readonly alreadyExistsChargesPaise: Paise;
  };
  /** Problems first (failed, nothing to bill), then new bills, then already billed; by code. */
  readonly rows: readonly BillingRunReportRow[];
  readonly page: number;
  readonly pageSize: number;
}
