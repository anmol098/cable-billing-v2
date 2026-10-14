/**
 * @cb/load: load-test scenarios and the performance budget gate (T-095).
 * Command: `pnpm load --help`. Runbook and budget: docs/testing/performance.md.
 */
export { type CliOptions, parseCli } from "./args";
export { SessionCache, SignInBudgetError, SignInGovernor } from "./auth";
export { BUDGET_RULES, type BudgetResult, type BudgetRule, evaluateBudget } from "./budget";
export { PROFILES, type Profile, type ProfileName } from "./profiles";
export {
  isLocalTarget,
  LOCAL_DISCLAIMER,
  RESULT_SCHEMA,
  type RunResult,
  recheck,
  renderMarkdown,
  writeResult,
} from "./report";
export { preflight, runLoad, TargetNotReadyError, warmSessions } from "./run";
export { SCENARIO_NAMES, SCENARIOS, type ScenarioName } from "./scenarios";
export { type MetricSummary, percentile, Recorder } from "./stats";
