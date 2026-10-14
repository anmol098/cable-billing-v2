import type { RunContext } from "../context";
import { runBilling } from "./billing";
import { plannedLinemen, runPayments, runSync } from "./mobile";
import {
  plannedCounterUsers,
  plannedExportOwners,
  plannedWebUsers,
  runCounter,
  runExports,
  runReports,
} from "./web";

/** In run order: the 00:15 billing run, the morning phone burst, the office day, the evening push. */
export const SCENARIO_NAMES = [
  "billing",
  "sync",
  "counter",
  "reports",
  "exports",
  "payments",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export interface Scenario {
  readonly name: ScenarioName;
  readonly description: string;
  /** Whether it changes data on the target (payments, bills). */
  readonly writes: boolean;
  /** The logins it signs in (for planning the sign-in budget). */
  logins(ctx: Pick<RunContext, "personas" | "profile">): string[];
  run(ctx: RunContext): Promise<void>;
}

export const SCENARIOS: Readonly<Record<ScenarioName, Scenario>> = {
  billing: {
    name: "billing",
    description: "Monthly billing run via the billing-scheduler and job-worker crons",
    writes: true,
    logins: () => [],
    run: runBilling,
  },
  sync: {
    name: "sync",
    description: "Morning burst: phones load config, full roster sync, customer detail, delta sync",
    writes: false,
    logins: plannedLinemen,
    run: runSync,
  },
  counter: {
    name: "counter",
    description: "Counter payments: find customer + take payment (Server Actions)",
    writes: true,
    logins: plannedCounterUsers,
    run: runCounter,
  },
  reports: {
    name: "reports",
    description: "Office users read lists, search and reports (server-rendered pages)",
    writes: false,
    logins: plannedWebUsers,
    run: runReports,
  },
  exports: {
    name: "exports",
    description: "Owners download CSV files (≤ 25 per Owner per run)",
    writes: false,
    logins: plannedExportOwners,
    run: runExports,
  },
  payments: {
    name: "payments",
    description:
      "Evening burst: phones push 50-payment batches, a replay, receipt actions, day totals",
    writes: true,
    logins: plannedLinemen,
    run: runPayments,
  },
};

/** The requested scenarios in run order (`SCENARIO_NAMES`), whatever order was asked. */
export function orderScenarios(names: readonly ScenarioName[]): ScenarioName[] {
  return SCENARIO_NAMES.filter((name) => names.includes(name));
}

/** Every distinct login the given scenarios sign in (one sign-in each per run). */
export function plannedLogins(
  names: readonly ScenarioName[],
  ctx: Pick<RunContext, "personas" | "profile">,
): string[] {
  return [...new Set(names.flatMap((name) => SCENARIOS[name].logins(ctx)))].sort();
}
