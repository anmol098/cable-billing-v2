/**
 * Connections (VC) lifecycle (T-034): add (find-or-create the VC, reuse after removal), stop,
 * start again, remove, plan change, "Add customer" with connections, the timeline, form options,
 * the rules behind the effect text, and the hooks contract T-045 implements. See ./services.ts
 * (writes), ./queries.ts (reads), ./rules.ts (pure rules) and ./hooks-contract.ts.
 */

export { connectionHooks } from "./hooks";
export type {
  AssignmentPlanChangedEvent,
  AssignmentReactivatedEvent,
  AssignmentStartedEvent,
  ConnectionHookContext,
  ConnectionHookResult,
  ConnectionHooks,
  HookAssignment,
} from "./hooks-contract";
export {
  type AddConnectionCommand,
  AddConnectionInput,
  ChangeConnectionPlanInput,
  ConnectionFields,
  type ConnectionFieldsCommand,
  ConnectionFormOptionsInput,
  CreateCustomerWithConnectionsInput,
  DisconnectConnectionInput,
  ListConnectionsInput,
  ReactivateConnectionInput,
  SuspendConnectionInput,
} from "./inputs";
export { connectionFormOptions, listConnections } from "./queries";
export {
  allowedActions,
  billedFrom,
  CONNECTION_ACTIONS,
  CONNECTION_LIMITS,
  type ConnectionAction,
  changeDateProblem,
  type DateProblem,
  EARLIEST_BUSINESS_DATE,
  earliestAllowedDate,
  eventTypeOf,
  formatStopReason,
  isMidMonth,
  latestStartDate,
  MAX_START_DAYS_AHEAD,
  nextStatus,
  parseStopReason,
  reachesBilledPeriod,
  rentStopsFrom,
  STOP_REASONS,
  type StatusAction,
  type StopReason,
  startDateProblem,
  VC_NUMBER_PATTERN,
} from "./rules";
export {
  addConnection,
  addConnectionInTx,
  type ConnectionWriteEnv,
  type ConnectionWriteOptions,
  changeConnectionPlan,
  changePlanInTx,
  changeStatusInTx,
  createCustomerWithConnections,
  disconnectConnection,
  isVcOverlapConflict,
  type PlanChangeCommand,
  reactivateConnection,
  type StatusChangeCommand,
  suspendConnection,
} from "./services";
export type {
  AddConnectionResult,
  ChangeConnectionResult,
  ConnectionDetail,
  ConnectionEventView,
  ConnectionFormOptions,
  ConnectionPlanOption,
  ConnectionReason,
  ConnectionView,
  CreateCustomerWithConnectionsResult,
  CustomerConnections,
  PreviousHolder,
} from "./types";
