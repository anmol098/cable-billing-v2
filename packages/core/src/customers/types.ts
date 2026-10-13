/**
 * What the customer services return (T-033). Money is integer paise (`number`, safe range);
 * dates are IST business dates as `YYYY-MM-DD`; instants are `Date` (UTC).
 */
import type { AssignmentStatus, CustomerStatus } from "@cb/db";
import type { SearchMatchKind } from "./rules";

/** A customer row as the services return it after a write. */
export interface CustomerView {
  readonly id: string;
  /** As typed (shown to people). */
  readonly customerCode: string;
  readonly name: string;
  readonly phone: string | null;
  readonly altPhone: string | null;
  readonly address: string | null;
  readonly areaId: string | null;
  readonly status: CustomerStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `customers.create` result. */
export interface CreateCustomerResult {
  readonly customer: CustomerView;
  /** True when the code was taken from the `customer_code` counter (the code field was empty). */
  readonly autoCode: boolean;
}

/** `customers.update` / `customers.set_status` / `customers.phone.update` result. */
export interface UpdateCustomerResult {
  readonly customer: CustomerView;
  /** Field names that changed (empty when nothing changed: no audit row, no history row). */
  readonly changed: readonly string[];
}

/** One row of `customers.search` (the list page and any customer picker). */
export interface CustomerListRow {
  readonly id: string;
  readonly customerCode: string;
  readonly name: string;
  readonly phone: string | null;
  readonly areaId: string | null;
  readonly areaName: string | null;
  readonly status: CustomerStatus;
  /** Σ ledger (signed): > 0 the customer owes this much; < 0 is credit. 0 when never billed. */
  readonly balancePaise: number;
  /** Unused credit (≥ 0). */
  readonly creditPaise: number;
  /** Why the row matched (`all` when there was no search text). */
  readonly match: SearchMatchKind;
  /** The VC number that matched, as typed, when `match` is `vc`. */
  readonly matchedVcNumber: string | null;
}

export interface CustomerSearchResult {
  readonly rows: readonly CustomerListRow[];
  /** More rows exist after this page (`offset + limit`). */
  readonly hasMore: boolean;
}

/** A connection on the profile summary (T-034 owns the full connections tab). */
export interface CustomerConnectionSummary {
  readonly assignmentId: string;
  readonly vcAssetId: string;
  readonly vcNumber: string;
  readonly status: AssignmentStatus;
  readonly planId: string | null;
  /** NULL for a custom amount (no plan). */
  readonly planName: string | null;
  readonly rentalPaise: number;
  readonly startDate: string;
  readonly endDate: string | null;
}

export interface CustomerLastPayment {
  readonly id: string;
  readonly amountPaise: number;
  readonly method: "cash" | "upi";
  /** IST business date of the payment. */
  readonly businessDate: string;
  readonly reversed: boolean;
}

/** `customers.get`: the profile header and the Summary tab. */
export interface CustomerProfile extends CustomerView {
  readonly areaName: string | null;
  readonly balancePaise: number;
  readonly creditPaise: number;
  /** Oldest month with something unpaid (`YYYY-MM-01`), or null. */
  readonly oldestDuePeriod: string | null;
  /** Connections that are not disconnected (active and stopped), newest first. */
  readonly connections: readonly CustomerConnectionSummary[];
  /** How many past (disconnected) connections there are. */
  readonly pastConnections: number;
  readonly lastPayment: CustomerLastPayment | null;
}

/** An area for the customer form and the list filter. */
export interface CustomerAreaOption {
  readonly id: string;
  readonly name: string;
  /** Archived areas stay on old customers; the form does not offer them for new ones. */
  readonly archived: boolean;
}

export interface CustomerFormOptions {
  readonly areas: readonly CustomerAreaOption[];
  /** What the code would be if the code field is left empty (a preview; may be taken by then). */
  readonly nextAutoCode: string;
}
