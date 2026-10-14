/**
 * Adjustments (T-045): the connection hooks' money rules (plan-change netting, D-18 mid-month
 * start), the Owner's manual bill changes and back-dated changes, the effect preview and the bill
 * changes list. See ./services.ts (services), ./effects.ts (pure rules), ./apply.ts (hooks and
 * back-dated months) and ./store.ts (rows, ledger, credit).
 */
export { type ChangeKind, expectedRentPaise, type MonthEffect } from "./effects";
export {
  ADJUSTMENT_LIMITS,
  ADJUSTMENT_STATES,
  BackDatedChangeInput,
  ConnectionChange,
  type ConnectionChangeCommand,
  ConnectionChargedMonthsInput,
  type CreateManualAdjustmentCommand,
  CreateManualAdjustmentInput,
  ListAdjustmentsInput,
  PreviewConnectionChangeInput,
} from "./inputs";
export {
  backDatedConnectionChange,
  connectionChargedMonths,
  createManualAdjustment,
  listAdjustments,
  previewConnectionChange,
} from "./services";
export type {
  AdjustmentListRow,
  AdjustmentListView,
  AdjustmentView,
  BackDatedChangeResult,
  ConnectionChangeKind,
  ConnectionChangePreview,
  ConnectionChargedMonths,
  ManualAdjustmentResult,
  MonthEffectView,
} from "./types";
