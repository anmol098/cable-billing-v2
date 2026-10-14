/**
 * Connection (VC) write services (T-034; FR-005, FR-006, BR-03, BR-04, RULE-06, RULE-07,
 * PRD §15 #6, J-02, J-06, PLAN §7.2, §8.1, §8.3).
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `connections.add` | `customers.manage` (Owner, Staff) | A VC on a customer: find-or-create the VC asset, a new assignment (plan or own amount, start date), its `activated` event |
 * | `connections.suspend` | `connections.status.change` (Owner, Staff) | Stop: active → suspended |
 * | `connections.reactivate` | `connections.status.change` | Start again: suspended → active |
 * | `connections.disconnect` | `connections.status.change` | Remove for good: active/suspended → disconnected, `end_date` = effective date, reason required |
 * | `connections.change_plan` | `customers.manage` | New plan or own amount from an effective date (T-045 builds its screen) |
 * | `customers.create_with_connections` | `customers.manage` | "Add customer" with its connections, in one transaction |
 *
 * **Never rewrite history.** Every change appends an `assignment_events` row and updates only the
 * current-state columns T-022 allows (`status`, `end_date`, `plan_id`, `rental_amount_paise`).
 * Reusing a VC is `connections.add` on the new customer: a **new** assignment; the old one, its
 * invoice lines, adjustments and payments stay with the old customer (RULE-07, PRD §15 #6). There
 * is no "move" and no delete.
 *
 * **Refusals** (nothing is written):
 * - another tenant's or a made-up customer / assignment / plan id → NOT_FOUND;
 * - VALIDATION `details.fields[{ path, code }]`: `planId`/`retired` (a retired plan),
 *   `startDate` | `effectiveDate` / `in_future` | `too_old` | `before_start` | `before_last_change`
 *   (rules.ts);
 * - CONFLICT `details.reason`:
 *   - `invalid_transition` (`from`, `action`): e.g. reactivating a removed connection;
 *   - `customer_closed`: adding a connection to a closed customer;
 *   - `vc_retired`: the VC asset is out of service;
 *   - `vc_in_use` (`holderCustomerId`, `holderCustomerCode`, `holderName`, `holderStatus`,
 *     `until` = its end date or null, `earliestStart` = the day after, or null, `sameCustomer`):
 *     the VC is still with someone on the start date (RULE-06; the EXCLUDE constraint is the
 *     backstop for a race, CONFLICT with `details.constraint = "vc_assignments_no_overlap"`);
 *   - `billed_period` (`field`, `period` = the latest billed month, `earliestDate`): the date
 *     reaches back into a month already billed for the customer (PLAN §8.3). Refused for Staff
 *     **and** for the Owner here: the Owner's guided flow with an explicit adjustment is T-045's,
 *     which calls the `…InTx` functions with `allowBilledPeriod`.
 *
 * **Hooks** (T-045): after a start, a reactivation or a plan change the service calls
 * `connectionHooks.onAssignment…` in the same transaction (contract: ./hooks-contract.ts).
 *
 * Every write locks the customer, its balance row and the VC (./store.ts lock order), bumps
 * `customers.updated_at` (roster sync) and records one audit event (`vc_assignment`).
 */
import {
  type AssignmentStatus,
  assignmentEvents,
  plans,
  type Tx,
  uuidv7,
  vcAssignments,
} from "@cb/db";
import {
  addDays,
  type BusinessDate,
  businessDate,
  businessDateOf,
  err,
  ok,
  type Period,
  type Result,
  toPaise,
  validateAssignmentTimeline,
} from "@cb/domain";
import { and, eq } from "drizzle-orm";
import type { AuditRecorder } from "../audit/audit";
import { defineService } from "../context/service";
import type { TenantContext } from "../context/tenant-context";
import { createCustomerInTx } from "../customers/customers";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../errors/errors";
import type { Logger } from "../logging/logger";
import { connectionHooks } from "./hooks";
import type { ConnectionHookContext, HookAssignment } from "./hooks-contract";
import {
  type AddConnectionCommand,
  AddConnectionInput,
  ChangeConnectionPlanInput,
  CreateCustomerWithConnectionsInput,
  DisconnectConnectionInput,
  ReactivateConnectionInput,
  SuspendConnectionInput,
} from "./inputs";
import {
  changeDateProblem,
  earliestAllowedDate,
  eventTypeOf,
  formatStopReason,
  nextStatus,
  reachesBilledPeriod,
  type StatusAction,
  type StopReason,
  startDateProblem,
} from "./rules";
import {
  type AssignmentEventRow,
  type AssignmentRow,
  customerLabel,
  eventsOf,
  findAssignment,
  findOrCreateVcAsset,
  holderFrom,
  lastChangeDate,
  latestAssignmentOf,
  latestBilledPeriod,
  lockCustomerForConnections,
  lockVcAsset,
  toTimeline,
  touchCustomer,
} from "./store";
import type {
  AddConnectionResult,
  ChangeConnectionResult,
  ConnectionView,
  CreateCustomerWithConnectionsResult,
} from "./types";

type ConnectionError = ServiceError<CoreErrorCode>;

/** What the in-transaction functions need besides `tx` (a service's `run` arguments fit). */
export interface ConnectionWriteEnv {
  readonly ctx: TenantContext;
  readonly now: Date;
  readonly audit: AuditRecorder;
  readonly log: Logger;
}

export interface ConnectionWriteOptions {
  /**
   * Skip the "back-dated into a billed month" refusal. Only for T-045's Owner flow, which creates
   * the explicit adjustment (with a reason) in the same transaction.
   */
  readonly allowBilledPeriod?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function conflict(reason: string, message: string, details: Record<string, unknown> = {}) {
  return serviceError("CONFLICT", message, { reason, ...details }) as ConnectionError;
}

function fieldProblem(path: string, code: string): ConnectionError {
  return serviceError("VALIDATION", "Input failed validation", { fields: [{ path, code }] });
}

function billedPeriod(field: string, latest: Period): ConnectionError {
  return conflict("billed_period", "The date reaches back into a month that is already billed", {
    field,
    period: latest,
    earliestDate: earliestAllowedDate(latest),
  });
}

/** True for the CONFLICT a racing writer gets from the EXCLUDE constraint. */
export function isVcOverlapConflict(error: ServiceError<string>): boolean {
  return (
    error.code === "CONFLICT" &&
    (error.details?.reason === "vc_in_use" ||
      error.details?.constraint === "vc_assignments_no_overlap")
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function toView(row: AssignmentRow, vcNumber: string): ConnectionView {
  return {
    assignmentId: row.id,
    customerId: row.customerId,
    vcAssetId: row.vcAssetId,
    vcNumber,
    status: row.status,
    planId: row.planId,
    rentalPaise: row.rentalAmountPaise,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

function hookAssignment(row: AssignmentRow): HookAssignment {
  return {
    id: row.id,
    customerId: row.customerId,
    vcAssetId: row.vcAssetId,
    startDate: businessDate(row.startDate),
    endDate: row.endDate === null ? null : businessDate(row.endDate),
    status: row.status,
    planId: row.planId,
    rentalPaise: toPaise(row.rentalAmountPaise),
  };
}

function hookContext(tx: Tx, env: ConnectionWriteEnv): ConnectionHookContext {
  return {
    tx,
    ctx: env.ctx,
    now: env.now,
    today: businessDateOf(env.now),
    audit: env.audit,
    log: env.log,
  };
}

/**
 * Plan or own amount → what the assignment stores. NOT_FOUND for another tenant's plan. Also used by
 * T-045a's back-dated new connection preview (../adjustments/back-dated-add).
 */
export async function resolveRental(
  tx: Tx,
  operatorId: string,
  input: { readonly planId?: string | null; readonly rentalPaise?: number | null },
): Promise<Result<{ planId: string | null; rentalPaise: number }, ConnectionError>> {
  if (input.planId) {
    const [plan] = await tx
      .select({
        id: plans.id,
        status: plans.status,
        monthlyAmountPaise: plans.monthlyAmountPaise,
      })
      .from(plans)
      .where(and(eq(plans.operatorId, operatorId), eq(plans.id, input.planId)));
    if (!plan) return err(notFound());
    if (plan.status !== "active") return err(fieldProblem("planId", "retired"));
    return ok({ planId: plan.id, rentalPaise: plan.monthlyAmountPaise });
  }
  return ok({ planId: null, rentalPaise: input.rentalPaise ?? 0 });
}

// ---------------------------------------------------------------------------------------------
// Add (and reuse)
// ---------------------------------------------------------------------------------------------

/**
 * Adds a connection to a customer inside the caller's tenant transaction (audit + hook
 * included). Public for composite services (`customers.create_with_connections`, T-045, T-084's
 * import); plain callers use {@link addConnection}.
 */
export async function addConnectionInTx(
  tx: Tx,
  env: ConnectionWriteEnv,
  input: AddConnectionCommand,
  options: ConnectionWriteOptions = {},
): Promise<Result<AddConnectionResult, ConnectionError>> {
  const { ctx, now, audit } = env;
  const op = ctx.operatorId;
  const today = businessDateOf(now);

  const customer = await lockCustomerForConnections(tx, op, input.customerId);
  if (!customer) return err(notFound());
  const rental = await resolveRental(tx, op, input);
  if (!rental.ok) return rental;
  if (customer.status !== "active") {
    return err(conflict("customer_closed", "The customer is closed"));
  }

  const dateProblem = startDateProblem({ date: input.startDate, today });
  if (dateProblem) return err(fieldProblem("startDate", dateProblem));
  if (!options.allowBilledPeriod) {
    const latest = await latestBilledPeriod(tx, op, customer.id);
    if (latest !== null && reachesBilledPeriod(input.startDate, latest)) {
      return err(billedPeriod("startDate", latest));
    }
  }

  const { asset, created } = await findOrCreateVcAsset(tx, op, input.vcNumber, now);
  if (asset.lifecycleStatus !== "in_service") {
    return err(conflict("vc_retired", "The VC is out of service", { vcAssetId: asset.id }));
  }
  const holder = await holderFrom(tx, op, asset.id, input.startDate);
  if (holder) {
    const label = await customerLabel(tx, op, holder.customerId);
    return err(
      conflict("vc_in_use", "The VC is still with a customer on that date", {
        vcAssetId: asset.id,
        holderAssignmentId: holder.id,
        holderCustomerId: holder.customerId,
        holderCustomerCode: label?.customerCode ?? null,
        holderName: label?.name ?? null,
        holderStatus: holder.status,
        until: holder.endDate,
        earliestStart: holder.endDate === null ? null : addDays(businessDate(holder.endDate), 1),
        sameCustomer: holder.customerId === customer.id,
      }),
    );
  }
  const previous = created ? null : await latestAssignmentOf(tx, op, asset.id);

  const assignmentId = uuidv7();
  const [row] = await tx
    .insert(vcAssignments)
    .values({
      id: assignmentId,
      operatorId: op,
      vcAssetId: asset.id,
      customerId: customer.id,
      startDate: input.startDate,
      status: "active",
      planId: rental.value.planId,
      rentalAmountPaise: rental.value.rentalPaise,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("assignment insert returned no row");
  const eventId = uuidv7();
  await tx.insert(assignmentEvents).values({
    id: eventId,
    operatorId: op,
    assignmentId,
    type: "activated",
    effectiveDate: input.startDate,
    actorId: ctx.userId,
    at: now,
  });
  await touchCustomer(tx, op, customer.id, now);

  await audit.record({
    action: "connections.add",
    entityType: "vc_assignment",
    entityId: assignmentId,
    after: {
      customerId: customer.id,
      vcAssetId: asset.id,
      vcNumber: asset.vcNumber,
      vcAssetCreated: created,
      planId: row.planId,
      rentalPaise: row.rentalAmountPaise,
      startDate: row.startDate,
      ...(previous ? { previousAssignmentId: previous.id } : {}),
    },
  });

  const hooked = await connectionHooks.onAssignmentStarted(hookContext(tx, env), {
    assignment: hookAssignment(row),
    eventId,
    effectiveDate: businessDate(row.startDate),
  });
  if (!hooked.ok) return err(hooked.error as ConnectionError);

  return ok({
    connection: toView(row, asset.vcNumber),
    vcAssetCreated: created,
    previous:
      previous && previous.endDate !== null
        ? {
            assignmentId: previous.id,
            customerId: previous.customerId,
            endDate: previous.endDate,
          }
        : null,
  });
}

export const addConnection = defineService({
  name: "connections.add",
  capability: "customers.manage",
  input: AddConnectionInput,
  async run({ input, tx, ...env }) {
    return addConnectionInTx(tx, env, input);
  },
});

// ---------------------------------------------------------------------------------------------
// Status changes and plan change
// ---------------------------------------------------------------------------------------------

/** Everything a change needs, locked (./store.ts lock order). */
interface LockedAssignment {
  readonly row: AssignmentRow;
  readonly vcNumber: string;
  readonly events: Awaited<ReturnType<typeof eventsOf>>;
}

async function lockAssignment(
  tx: Tx,
  operatorId: string,
  assignmentId: string,
): Promise<LockedAssignment | null> {
  // The customer and the VC never change on an assignment (T-022 trigger), so a plain read finds
  // what to lock first; the row itself is read again under its lock.
  const peek = await findAssignment(tx, operatorId, assignmentId);
  if (!peek) return null;
  const customer = await lockCustomerForConnections(tx, operatorId, peek.customerId);
  if (!customer) return null;
  const asset = await lockVcAsset(tx, operatorId, peek.vcAssetId);
  if (!asset) return null;
  const row = await findAssignment(tx, operatorId, assignmentId, { lock: true });
  if (!row) return null;
  return { row, vcNumber: asset.vcNumber, events: await eventsOf(tx, operatorId, assignmentId) };
}

interface DateCheck {
  readonly field: "effectiveDate";
  readonly date: BusinessDate;
}

/** The date rules of a change on a locked assignment. */
async function checkChangeDate(
  tx: Tx,
  env: ConnectionWriteEnv,
  locked: LockedAssignment,
  { field, date }: DateCheck,
  options: ConnectionWriteOptions,
): Promise<ConnectionError | null> {
  const problem = changeDateProblem({
    date,
    today: businessDateOf(env.now),
    startDate: businessDate(locked.row.startDate),
    lastChangeDate: lastChangeDate(locked.row.startDate, locked.events),
  });
  if (problem) return fieldProblem(field, problem);
  if (!options.allowBilledPeriod) {
    const latest = await latestBilledPeriod(tx, env.ctx.operatorId, locked.row.customerId);
    if (latest !== null && reachesBilledPeriod(date, latest)) return billedPeriod(field, latest);
  }
  return null;
}

/** T-040's timeline rules on the timeline with the new event: the final guard. */
function checkTimeline(
  locked: LockedAssignment,
  next: {
    readonly endDate: string | null;
    readonly event: {
      type: AssignmentEventRow["type"];
      effectiveDate: string;
      toRentalPaise: number | null;
    };
  },
): ConnectionError | null {
  const timeline = toTimeline({ startDate: locked.row.startDate, endDate: next.endDate }, [
    ...locked.events,
    next.event,
  ]);
  const checked = validateAssignmentTimeline(timeline);
  if (checked.ok) return null;
  return conflict("invalid_transition", "The change does not fit the connection's history", {
    from: locked.row.status,
    timelineReason: checked.error.details?.reason ?? null,
  });
}

export interface StatusChangeCommand {
  readonly assignmentId: string;
  readonly action: StatusAction;
  readonly effectiveDate: BusinessDate;
  readonly reason?: StopReason | null;
  readonly note?: string | null;
}

/**
 * Suspends, reactivates or disconnects inside the caller's transaction (audit + hook included).
 * Public for T-045's Owner back-date flow (`allowBilledPeriod`); plain callers use the services.
 */
export async function changeStatusInTx(
  tx: Tx,
  env: ConnectionWriteEnv,
  command: StatusChangeCommand,
  options: ConnectionWriteOptions = {},
): Promise<Result<ChangeConnectionResult, ConnectionError>> {
  const { ctx, now, audit } = env;
  const op = ctx.operatorId;
  const locked = await lockAssignment(tx, op, command.assignmentId);
  if (!locked) return err(notFound());
  const before = locked.row;

  const to = nextStatus(before.status, command.action);
  if (to === null) {
    return err(
      conflict("invalid_transition", "This change is not allowed from the current status", {
        from: before.status,
        action: command.action,
      }),
    );
  }
  const dateError = await checkChangeDate(
    tx,
    env,
    locked,
    { field: "effectiveDate", date: command.effectiveDate },
    options,
  );
  if (dateError) return err(dateError);

  const type = eventTypeOf(command.action) as "suspended" | "reactivated" | "disconnected";
  const endDate = command.action === "disconnect" ? command.effectiveDate : null;
  const timelineError = checkTimeline(locked, {
    endDate,
    event: { type, effectiveDate: command.effectiveDate, toRentalPaise: null },
  });
  if (timelineError) return err(timelineError);

  const reason =
    command.reason === undefined || command.reason === null
      ? null
      : formatStopReason(command.reason, command.note);

  const [after] = await tx
    .update(vcAssignments)
    .set({ status: to as AssignmentStatus, endDate, updatedAt: now })
    .where(and(eq(vcAssignments.operatorId, op), eq(vcAssignments.id, before.id)))
    .returning();
  if (!after) throw new Error("assignment update returned no row");
  const eventId = uuidv7();
  await tx.insert(assignmentEvents).values({
    id: eventId,
    operatorId: op,
    assignmentId: before.id,
    type,
    effectiveDate: command.effectiveDate,
    reason,
    actorId: ctx.userId,
    at: now,
  });
  await touchCustomer(tx, op, before.customerId, now);

  await audit.record({
    action: `connections.${command.action}`,
    entityType: "vc_assignment",
    entityId: before.id,
    before: { status: before.status },
    after: {
      status: after.status,
      effectiveDate: command.effectiveDate,
      ...(reason === null ? {} : { reason }),
      ...(endDate === null ? {} : { endDate }),
    },
  });

  if (command.action === "reactivate") {
    const hooked = await connectionHooks.onAssignmentReactivated(hookContext(tx, env), {
      assignment: hookAssignment(after),
      eventId,
      effectiveDate: command.effectiveDate,
    });
    if (!hooked.ok) return err(hooked.error as ConnectionError);
  }

  return ok({ connection: toView(after, locked.vcNumber), eventId, changed: true });
}

export const suspendConnection = defineService({
  name: "connections.suspend",
  capability: "connections.status.change",
  input: SuspendConnectionInput,
  async run({ input, tx, ...env }) {
    return changeStatusInTx(tx, env, { ...input, action: "suspend" });
  },
});

export const reactivateConnection = defineService({
  name: "connections.reactivate",
  capability: "connections.status.change",
  input: ReactivateConnectionInput,
  async run({ input, tx, ...env }) {
    return changeStatusInTx(tx, env, { ...input, action: "reactivate" });
  },
});

export const disconnectConnection = defineService({
  name: "connections.disconnect",
  capability: "connections.status.change",
  input: DisconnectConnectionInput,
  async run({ input, tx, ...env }) {
    return changeStatusInTx(tx, env, { ...input, action: "disconnect" });
  },
});

export interface PlanChangeCommand {
  readonly assignmentId: string;
  readonly effectiveDate: BusinessDate;
  readonly planId?: string | null;
  readonly rentalPaise?: number | null;
}

/**
 * Changes a connection's plan / own amount from `effectiveDate` inside the caller's transaction
 * (audit + `onAssignmentPlanChanged` hook). The same plan and amount again changes nothing
 * (`changed: false`, no event, no audit row).
 */
export async function changePlanInTx(
  tx: Tx,
  env: ConnectionWriteEnv,
  command: PlanChangeCommand,
  options: ConnectionWriteOptions = {},
): Promise<Result<ChangeConnectionResult, ConnectionError>> {
  const { ctx, now, audit } = env;
  const op = ctx.operatorId;
  const locked = await lockAssignment(tx, op, command.assignmentId);
  if (!locked) return err(notFound());
  const before = locked.row;
  const rental = await resolveRental(tx, op, command);
  if (!rental.ok) return rental;

  if (nextStatus(before.status, "change_plan") === null) {
    return err(
      conflict("invalid_transition", "This change is not allowed from the current status", {
        from: before.status,
        action: "change_plan",
      }),
    );
  }
  if (
    before.planId === rental.value.planId &&
    before.rentalAmountPaise === rental.value.rentalPaise
  ) {
    audit.skip("no_change");
    return ok({ connection: toView(before, locked.vcNumber), eventId: null, changed: false });
  }
  const dateError = await checkChangeDate(
    tx,
    env,
    locked,
    { field: "effectiveDate", date: command.effectiveDate },
    options,
  );
  if (dateError) return err(dateError);
  const timelineError = checkTimeline(locked, {
    endDate: before.endDate,
    event: {
      type: "plan_changed",
      effectiveDate: command.effectiveDate,
      toRentalPaise: rental.value.rentalPaise,
    },
  });
  if (timelineError) return err(timelineError);

  const [after] = await tx
    .update(vcAssignments)
    .set({
      planId: rental.value.planId,
      rentalAmountPaise: rental.value.rentalPaise,
      updatedAt: now,
    })
    .where(and(eq(vcAssignments.operatorId, op), eq(vcAssignments.id, before.id)))
    .returning();
  if (!after) throw new Error("assignment update returned no row");
  const eventId = uuidv7();
  await tx.insert(assignmentEvents).values({
    id: eventId,
    operatorId: op,
    assignmentId: before.id,
    type: "plan_changed",
    effectiveDate: command.effectiveDate,
    fromPlanId: before.planId,
    toPlanId: after.planId,
    fromRentalPaise: before.rentalAmountPaise,
    toRentalPaise: after.rentalAmountPaise,
    actorId: ctx.userId,
    at: now,
  });
  await touchCustomer(tx, op, before.customerId, now);

  await audit.record({
    action: "connections.change_plan",
    entityType: "vc_assignment",
    entityId: before.id,
    before: { planId: before.planId, rentalPaise: before.rentalAmountPaise },
    after: {
      planId: after.planId,
      rentalPaise: after.rentalAmountPaise,
      effectiveDate: command.effectiveDate,
    },
  });

  const hooked = await connectionHooks.onAssignmentPlanChanged(hookContext(tx, env), {
    assignment: hookAssignment(after),
    eventId,
    effectiveDate: command.effectiveDate,
    fromPlanId: before.planId,
    toPlanId: after.planId,
    fromRentalPaise: toPaise(before.rentalAmountPaise),
    toRentalPaise: toPaise(after.rentalAmountPaise),
  });
  if (!hooked.ok) return err(hooked.error as ConnectionError);

  return ok({ connection: toView(after, locked.vcNumber), eventId, changed: true });
}

export const changeConnectionPlan = defineService({
  name: "connections.change_plan",
  capability: "customers.manage",
  input: ChangeConnectionPlanInput,
  async run({ input, tx, ...env }) {
    return changePlanInTx(tx, env, input);
  },
});

// ---------------------------------------------------------------------------------------------
// Add customer + connections (one transaction)
// ---------------------------------------------------------------------------------------------

/**
 * "Add customer" with its connections (J-02, PLAN §12.2 step 2): T-033's `createCustomerInTx`,
 * then {@link addConnectionInTx} for each connection, in one transaction, so a refused VC leaves
 * no half-saved customer. A connection's error carries `details.connectionIndex`; field paths
 * are `connections.<i>.<field>`.
 */
export const createCustomerWithConnections = defineService({
  name: "customers.create_with_connections",
  capability: "customers.manage",
  input: CreateCustomerWithConnectionsInput,
  async run({ input, tx, ...env }) {
    const created = await createCustomerInTx(tx, env.ctx, input.customer, env.now, env.audit);
    if (!created.ok) return created;
    const results: AddConnectionResult[] = [];
    for (const [index, connection] of input.connections.entries()) {
      const added = await addConnectionInTx(tx, env, {
        ...connection,
        customerId: created.value.customer.id,
      });
      if (!added.ok) return err(withConnectionIndex(added.error, index));
      results.push(added.value);
    }
    const value: CreateCustomerWithConnectionsResult = {
      customer: created.value.customer,
      autoCode: created.value.autoCode,
      connections: results,
    };
    return ok(value);
  },
});

function withConnectionIndex(error: ConnectionError, index: number): ConnectionError {
  const details: Record<string, unknown> = { ...(error.details ?? {}), connectionIndex: index };
  const fields = details.fields;
  if (Array.isArray(fields)) {
    details.fields = (fields as { path?: unknown; code?: unknown }[]).map((issue) => ({
      ...issue,
      path: `connections.${index}.${String(issue.path ?? "")}`,
    }));
  }
  return { ...error, details };
}
