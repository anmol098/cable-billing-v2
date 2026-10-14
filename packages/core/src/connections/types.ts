/**
 * What the connection services return (T-034). Money is integer paise (`number`, safe range);
 * dates are IST business dates as `YYYY-MM-DD`; instants are `Date` (UTC).
 */
import type { AssignmentStatus } from "@cb/db";
import type { AssignmentStatusOnDate } from "@cb/domain";
import type { CustomerView } from "../customers/types";
import type { ConnectionAction, StopReason } from "./rules";

/** One VC assignment after a write. */
export interface ConnectionView {
  readonly assignmentId: string;
  readonly customerId: string;
  readonly vcAssetId: string;
  /** As typed when the VC was first entered (shown to people). */
  readonly vcNumber: string;
  readonly status: AssignmentStatus;
  /** NULL = own amount (no plan). */
  readonly planId: string | null;
  readonly rentalPaise: number;
  readonly startDate: string;
  /** Last day of service (inclusive), set when removed. */
  readonly endDate: string | null;
}

/** The assignment a reused VC had before (same business; RULE-07: its bills stay there). */
export interface PreviousHolder {
  readonly assignmentId: string;
  readonly customerId: string;
  readonly endDate: string;
}

/** `connections.add` result. */
export interface AddConnectionResult {
  readonly connection: ConnectionView;
  /** True when the VC number was new to this business (a `vc_assets` row was created). */
  readonly vcAssetCreated: boolean;
  /** The VC's previous assignment when it is being reused, else null. */
  readonly previous: PreviousHolder | null;
}

/** `connections.suspend` / `reactivate` / `disconnect` / `change_plan` result. */
export interface ChangeConnectionResult {
  readonly connection: ConnectionView;
  /** The new `assignment_events` row (null when a plan change changed nothing). */
  readonly eventId: string | null;
  readonly changed: boolean;
}

/** `customers.create_with_connections` result. */
export interface CreateCustomerWithConnectionsResult {
  readonly customer: CustomerView;
  readonly autoCode: boolean;
  readonly connections: readonly AddConnectionResult[];
}

/** A stored stop/remove reason, read back. */
export interface ConnectionReason {
  /** A known reason code, or null for free text (e.g. migrated rows). */
  readonly code: StopReason | null;
  readonly note: string | null;
}

/** One row of a connection's timeline (FR-006). */
export interface ConnectionEventView {
  readonly id: string;
  readonly type: "activated" | "suspended" | "reactivated" | "disconnected" | "plan_changed";
  readonly effectiveDate: string;
  /** When it was recorded. */
  readonly at: Date;
  readonly reason: ConnectionReason | null;
  /** Who recorded it (null: system / migration). */
  readonly actorName: string | null;
  /** `plan_changed` only. */
  readonly fromPlanName: string | null;
  readonly toPlanName: string | null;
  readonly fromRentalPaise: number | null;
  readonly toRentalPaise: number | null;
}

/** A connection on the Connections tab, with its timeline. */
export interface ConnectionDetail {
  readonly assignmentId: string;
  readonly vcAssetId: string;
  readonly vcNumber: string;
  /** After the latest change (it may take effect at the end of today). */
  readonly status: AssignmentStatus;
  /** What applies today (T-040 `assignmentStatusOn`): a change effective today still shows the old status. */
  readonly statusToday: AssignmentStatusOnDate;
  readonly planId: string | null;
  readonly planName: string | null;
  readonly rentalPaise: number;
  readonly startDate: string;
  readonly endDate: string | null;
  /** Imported with unknown earlier history (RULE-21). */
  readonly historyLimited: boolean;
  /** What may be done now (empty for a removed connection). */
  readonly actions: readonly ConnectionAction[];
  /** The earliest effective date a change may have now (start, latest change, billed months). */
  readonly earliestChangeDate: string;
  /** Oldest first, in recorded order. */
  readonly events: readonly ConnectionEventView[];
}

/** `connections.list`: everything the Connections tab shows. */
export interface CustomerConnections {
  readonly customerId: string;
  readonly customerActive: boolean;
  /** Today (IST) at the time of the read. */
  readonly today: string;
  /** The customer's latest billed month (`YYYY-MM-01`), or null. */
  readonly latestBilledPeriod: string | null;
  /** Active and stopped connections, newest start first. */
  readonly current: readonly ConnectionDetail[];
  /** Removed connections, newest end first. */
  readonly past: readonly ConnectionDetail[];
}

/** An active plan for the connection forms. */
export interface ConnectionPlanOption {
  readonly id: string;
  readonly name: string;
  readonly monthlyAmountPaise: number;
}

/** `connections.form_options`. */
export interface ConnectionFormOptions {
  readonly plans: readonly ConnectionPlanOption[];
  readonly today: string;
  /** The latest start date allowed (tomorrow). */
  readonly latestStartDate: string;
  /** With a customer: the earliest start that does not reach into a billed month (else null). */
  readonly earliestStartDate: string | null;
}
