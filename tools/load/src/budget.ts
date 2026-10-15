/**
 * The performance budget (docs/testing/performance.md §2): every rule, its number and where the
 * number comes from. `evaluateBudget` turns a run's measurements into pass/fail lines that a CI job
 * can gate on (`load run --gate` exits 1 when a rule fails).
 *
 * Changing a number here is a product decision: change docs/testing/performance.md in the same PR
 * (a test checks that every rule id is documented there).
 */
import type { ProfileName } from "./profiles";
import type { MetricSummary } from "./stats";

export type BudgetStat = "p95" | "max" | "errorRate" | "bytesMax" | "count";

export interface BudgetRule {
  /** Stable id, used in reports and the docs (e.g. `B-WEB-LIST`). */
  readonly id: string;
  /** A metric name, or a prefix ending in `*` (each matching metric is checked on its own). */
  readonly metric: string;
  /** For `count` rules: the counter name (counters are plain numbers, not timings). */
  readonly stat: BudgetStat;
  /** The limit (inclusive): ms for timings, a ratio for errorRate, bytes, or a count. */
  readonly limit: number;
  /** Per-profile limits where the scale changes the number (the billing run). */
  readonly limitByProfile?: Partial<Record<ProfileName, number>>;
  /** Where the number comes from. */
  readonly source: string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const BUDGET_RULES: readonly BudgetRule[] = [
  {
    id: "B-WEB-LIST",
    metric: "web.page.*",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 Performance: common list/search operations p95 < 2 s (whole HTML response).",
  },
  {
    id: "B-WEB-SEARCH",
    metric: "web.search.*",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 Performance: search p95 < 2 s (customer search page, by code/name/phone/VC).",
  },
  {
    id: "B-COUNTER-FIND",
    metric: "counter.find_customer",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11: search p95 < 2 s (the counter's Find customer box).",
  },
  {
    id: "B-COUNTER-SAVE",
    metric: "counter.take_payment",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 common operation; J-04/FR-013 counter payment while the customer waits.",
  },
  {
    id: "B-SYNC-PAGE",
    metric: "mobile.sync.page",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 list operation: one roster page (≤ 500 customers, T-060).",
  },
  {
    id: "B-SYNC-FULL",
    metric: "mobile.sync.full",
    stat: "p95",
    limit: 10 * SECOND,
    source:
      "PLAN §10.3: whole-tenant roster on app open; ≈1,000–1,400 customers = 2–3 pages of 2 s.",
  },
  {
    id: "B-SYNC-BYTES",
    metric: "mobile.sync.full",
    stat: "bytesMax",
    limit: 1024 * 1024,
    source:
      "PLAN §10.3: the roster is under 1 MB gzipped at the known scale (low-bandwidth phones).",
  },
  {
    id: "B-SYNC-DELTA",
    metric: "mobile.sync.delta",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 list operation (delta sync after every push and every 30 min).",
  },
  {
    id: "B-MOBILE-DETAIL",
    metric: "mobile.customer.detail",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 common operation (customer detail when online).",
  },
  {
    id: "B-MOBILE-DAY",
    metric: "mobile.collections.day",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 common operation (the lineman's day totals).",
  },
  {
    id: "B-RECEIPT-ACTIONS",
    metric: "mobile.receipts.actions",
    stat: "p95",
    limit: 2 * SECOND,
    source: "PRD §11 common operation (receipt-action outbox push).",
  },
  {
    id: "B-PAY-BATCH",
    metric: "mobile.payments.batch",
    stat: "p95",
    limit: 10 * SECOND,
    source:
      "PLAN §10.2/§10.4: a batch holds up to 50 payments; T-061's server budget is 30 s per batch. 10 s keeps a 3× margin.",
  },
  {
    id: "B-PAY-RETRY",
    metric: "mobile.payments.retry_later",
    stat: "count",
    limit: 0,
    source:
      "T-061: items not started within the 30 s batch budget come back retry_later. Under budget load none should.",
  },
  {
    id: "B-PAY-REJECTED",
    metric: "mobile.payments.rejected",
    stat: "count",
    limit: 0,
    source: "Every generated payment is valid: a rejection is a bug, not load.",
  },
  {
    id: "B-PAY-IDEMPOTENT",
    metric: "mobile.payments.replay_not_duplicate",
    stat: "count",
    limit: 0,
    source: "FR-015 / T-061: a re-sent batch (lost answer) is answered `duplicate` for every item.",
  },
  {
    id: "B-COUNTER-REFUSED",
    metric: "counter.payments_refused",
    stat: "count",
    limit: 0,
    source: "Every generated counter payment is valid: a refusal is a bug, not load.",
  },
  {
    id: "B-EXPORT",
    metric: "export.*",
    stat: "p95",
    limit: 60 * SECOND,
    source:
      "Proposed (no PRD number): a whole CSV file within 60 s; the route's maxDuration is 300 s (T-082).",
  },
  {
    id: "B-BILLING-RUN",
    metric: "billing.run.wall",
    stat: "max",
    limit: 30 * MINUTE,
    limitByProfile: { "10x": 5 * 60 * MINUTE },
    source:
      "Proposed: the 00:15 IST run (PLAN §14) finishes for every tenant within 30 min at legacy size, and before 05:15 IST (5 h) at 10×, i.e. before linemen start.",
  },
  {
    id: "B-BILLING-INVOCATION",
    metric: "billing.worker",
    stat: "max",
    limit: 300 * SECOND,
    source: "Vercel maxDuration of /api/cron/job-worker (300 s); the worker's own budget is 240 s.",
  },
  {
    id: "B-BILLING-FAILED",
    metric: "billing.failed_jobs",
    stat: "count",
    limit: 0,
    source:
      "T-043/T-044: no billing job fails under load (a failed job alerts the platform admin).",
  },
  {
    id: "B-BILLING-DONE",
    metric: "billing.runs_not_done",
    stat: "count",
    limit: 0,
    source:
      "PLAN §14: every queued tenant run is finished (scheduler reports it done) when the queue empties.",
  },
  {
    id: "B-MONEY-ERRORS",
    metric: "mobile.payments.batch",
    stat: "errorRate",
    limit: 0,
    source: "BRD money rules: a payment request never fails under budget load.",
  },
  {
    id: "B-COUNTER-ERRORS",
    metric: "counter.take_payment",
    stat: "errorRate",
    limit: 0,
    source: "BRD money rules: a counter payment never fails under budget load.",
  },
  {
    id: "B-ERRORS",
    metric: "*",
    stat: "errorRate",
    limit: 0.01,
    source: "PRD §11 Reliability: at most 1 % failed requests of any kind.",
  },
];

export type BudgetStatus = "pass" | "fail" | "not_measured";

export interface BudgetResult {
  readonly id: string;
  readonly metric: string;
  readonly stat: BudgetStat;
  readonly limit: number;
  readonly actual: number | null;
  readonly status: BudgetStatus;
  readonly source: string;
}

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function limitOf(rule: BudgetRule, profile: ProfileName): number {
  return rule.limitByProfile?.[profile] ?? rule.limit;
}

/**
 * One result per (rule, matching metric). A rule nothing matched is `not_measured` (the scenario
 * did not run), which does not fail the gate; a matching metric with no successful sample does.
 */
export function evaluateBudget(
  summaries: readonly MetricSummary[],
  counters: Readonly<Record<string, number>>,
  profile: ProfileName,
  scenariosRun: ReadonlySet<string>,
  rules: readonly BudgetRule[] = BUDGET_RULES,
): BudgetResult[] {
  const results: BudgetResult[] = [];
  for (const rule of rules) {
    const limit = limitOf(rule, profile);
    const base = { id: rule.id, stat: rule.stat, limit, source: rule.source };
    if (rule.stat === "count") {
      const ran = scenariosRun.has(scenarioOfMetric(rule.metric));
      const actual = counters[rule.metric] ?? (ran ? 0 : null);
      results.push({
        ...base,
        metric: rule.metric,
        actual,
        status: actual === null ? "not_measured" : actual <= limit ? "pass" : "fail",
      });
      continue;
    }
    const matched = summaries.filter((summary) => matches(rule.metric, summary.name));
    if (matched.length === 0) {
      results.push({ ...base, metric: rule.metric, actual: null, status: "not_measured" });
      continue;
    }
    for (const summary of matched) {
      const actual = statOf(summary, rule.stat);
      const status: BudgetStatus = actual !== null && actual <= limit ? "pass" : "fail";
      results.push({ ...base, metric: summary.name, actual, status });
    }
  }
  return results;
}

function statOf(summary: MetricSummary, stat: BudgetStat): number | null {
  switch (stat) {
    case "p95":
      return summary.p95;
    case "max":
      return summary.max;
    case "errorRate":
      return summary.count === 0 ? null : summary.errorRate;
    case "bytesMax":
      return summary.bytesMax;
    case "count":
      return null;
  }
}

/** Which scenario produces a metric (by its first segment), for `count` rules. */
export function scenarioOfMetric(metric: string): string {
  const head = metric.split(".")[0] ?? "";
  if (head === "mobile") return metric.startsWith("mobile.payments") ? "payments" : "sync";
  if (head === "web") return "reports";
  if (head === "export") return "exports";
  if (head === "billing") return "billing";
  return head;
}
