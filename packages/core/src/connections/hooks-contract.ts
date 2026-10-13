/**
 * The connection hooks (T-034 emits them, T-045 implements them in `./hooks/`).
 *
 * After a connection **starts**, is **reactivated** or **changes plan**, the service calls the
 * matching hook so T-045 can create the adjustment PLAN §8.3 asks for (D-18 mid-month start,
 * plan-change netting). The defaults in `./hooks/index.ts` do nothing.
 *
 * **Contract** (what a hook may rely on and must keep):
 * - It runs **inside the service's tenant transaction**, after the assignment row and its
 *   `assignment_events` row are written, and before the transaction commits.
 * - The transaction already holds, in this order, the customer row lock (`FOR NO KEY UPDATE`), the
 *   customer's `customer_balances` lock (`lockCustomerBalance`, T-046) and the VC asset row lock.
 *   So adjustments created here are serialised with payments and the billing run (T-044's note:
 *   "create adjustments under the customer's balance row lock"). A hook must not take locks on
 *   another customer.
 * - `event.effectiveDate` is the change's effective date; the month it falls in is the one the
 *   hook may adjust (`periodOf(effectiveDate)`). The months **after** it were checked by the
 *   service: none of them is billed for the customer (otherwise the change was refused, see
 *   `rules.ts` "Back-dating"), unless the caller passed `allowBilledPeriod` (T-045's Owner flow).
 * - Returning `err(...)` rolls back the whole change (the service returns that error). Throwing
 *   is a bug (INTERNAL).
 * - It may write audit events with `hc.audit.record` (the service records its own event too).
 * - It must not change the assignment or its events.
 */
import type { AssignmentStatus, Tx } from "@cb/db";
import type { BusinessDate, Paise, Result } from "@cb/domain";
import type { AuditRecorder } from "../audit/audit";
import type { TenantContext } from "../context/tenant-context";
import type { ServiceError } from "../errors/errors";
import type { Logger } from "../logging/logger";

/** Where a hook runs. */
export interface ConnectionHookContext {
  readonly tx: Tx;
  readonly ctx: TenantContext;
  /** The service call's time. */
  readonly now: Date;
  /** `businessDateOf(now)`. */
  readonly today: BusinessDate;
  readonly audit: AuditRecorder;
  readonly log: Logger;
}

/** The assignment as it is after the change. */
export interface HookAssignment {
  readonly id: string;
  readonly customerId: string;
  readonly vcAssetId: string;
  readonly startDate: BusinessDate;
  readonly endDate: BusinessDate | null;
  readonly status: AssignmentStatus;
  readonly planId: string | null;
  readonly rentalPaise: Paise;
}

export interface AssignmentStartedEvent {
  readonly assignment: HookAssignment;
  /** The `activated` event's id. */
  readonly eventId: string;
  /** = the assignment's start date. */
  readonly effectiveDate: BusinessDate;
}

export interface AssignmentReactivatedEvent {
  readonly assignment: HookAssignment;
  /** The `reactivated` event's id. */
  readonly eventId: string;
  readonly effectiveDate: BusinessDate;
}

export interface AssignmentPlanChangedEvent {
  readonly assignment: HookAssignment;
  /** The `plan_changed` event's id. */
  readonly eventId: string;
  readonly effectiveDate: BusinessDate;
  readonly fromPlanId: string | null;
  readonly toPlanId: string | null;
  readonly fromRentalPaise: Paise;
  readonly toRentalPaise: Paise;
}

export type ConnectionHookResult = Result<void, ServiceError<string>>;

export interface ConnectionHooks {
  onAssignmentStarted(
    hc: ConnectionHookContext,
    event: AssignmentStartedEvent,
  ): Promise<ConnectionHookResult>;
  onAssignmentReactivated(
    hc: ConnectionHookContext,
    event: AssignmentReactivatedEvent,
  ): Promise<ConnectionHookResult>;
  onAssignmentPlanChanged(
    hc: ConnectionHookContext,
    event: AssignmentPlanChangedEvent,
  ): Promise<ConnectionHookResult>;
}
