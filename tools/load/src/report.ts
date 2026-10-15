/**
 * Run results: `summary.json` (machine-readable, schema `cb-load-result/1`, what a CI job gates on)
 * and `summary.md` (the same for people; paste it into a PR or docs/testing/performance.md).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUDGET_RULES, type BudgetResult, evaluateBudget } from "./budget";
import type { ProfileName } from "./profiles";
import type { MetricSummary } from "./stats";

export const RESULT_SCHEMA = "cb-load-result/1";

export const LOCAL_DISCLAIMER =
  "Tooling smoke results on a local or shared machine, not a capacity measurement. Only a run against a deployed preview + Neon branch (docs/testing/performance.md §4) measures capacity.";

export interface RunResult {
  readonly schema: typeof RESULT_SCHEMA;
  readonly label: string;
  readonly target: {
    readonly origin: string;
    readonly local: boolean;
    readonly version: string | null;
    readonly commit: string | null;
    /** Fastest of 5 `/api/health` round trips before the run: the floor under every timing. */
    readonly baselineMs: number;
  };
  readonly profile: ProfileName;
  readonly seedScale: string;
  readonly scenarios: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly machine: {
    readonly cpus: number;
    readonly loadavgStart: readonly number[];
    readonly loadavgEnd: readonly number[];
    readonly node: string;
  };
  readonly signIns: { readonly real: number; readonly refreshes: number };
  /** Scenarios that stopped with an error (setup problems, refused sign-ins …). */
  readonly scenarioErrors: Readonly<Record<string, string>>;
  readonly metrics: readonly MetricSummary[];
  readonly counters: Readonly<Record<string, number>>;
  readonly budget: readonly BudgetResult[];
  /** True when no budget line failed and no scenario stopped with an error. */
  readonly pass: boolean;
  readonly disclaimer: string | null;
}

/** localhost, loopback and private addresses: results from there are tooling checks only. */
export function isLocalTarget(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export function passOf(
  budget: readonly BudgetResult[],
  scenarioErrors: Readonly<Record<string, string>>,
) {
  return budget.every((line) => line.status !== "fail") && Object.keys(scenarioErrors).length === 0;
}

/** Re-evaluates a stored result against the current budget (for `load check`). */
export function recheck(result: RunResult): RunResult {
  const completed = result.scenarios.filter((name) => !(name in result.scenarioErrors));
  const budget = evaluateBudget(
    result.metrics,
    result.counters,
    result.profile,
    new Set(completed),
  );
  return { ...result, budget, pass: passOf(budget, result.scenarioErrors) };
}

const fmt = (value: number | null, unit = "ms") =>
  value === null
    ? "–"
    : unit === "ms"
      ? `${Math.round(value).toLocaleString("en-US")} ms`
      : String(value);

function limitText(line: BudgetResult): string {
  switch (line.stat) {
    case "errorRate":
      return `≤ ${(line.limit * 100).toFixed(line.limit < 0.01 ? 0 : 1)} %`;
    case "count":
      return `≤ ${line.limit}`;
    case "bytesMax":
      return `≤ ${(line.limit / 1024).toFixed(0)} KiB`;
    default:
      return `≤ ${fmt(line.limit)}`;
  }
}

function actualText(line: BudgetResult): string {
  if (line.actual === null) return "–";
  switch (line.stat) {
    case "errorRate":
      return `${(line.actual * 100).toFixed(2)} %`;
    case "count":
      return String(line.actual);
    case "bytesMax":
      return `${(line.actual / 1024).toFixed(1)} KiB`;
    default:
      return fmt(line.actual);
  }
}

/**
 * The budget for people: a rule that passed on several metrics (`web.page.*`) is one row with the
 * worst value; every failing metric keeps its own row. `not_measured` rules are left out.
 */
export function condensed(budget: readonly BudgetResult[]): BudgetResult[] {
  const rows: BudgetResult[] = [];
  const ids = [...new Set(budget.map((line) => line.id))];
  for (const id of ids) {
    const measured = budget.filter((line) => line.id === id && line.status !== "not_measured");
    if (measured.length === 0) continue;
    const failed = measured.filter((line) => line.status === "fail");
    if (failed.length > 0 || measured.length === 1) {
      rows.push(...(failed.length > 0 ? failed : measured));
      continue;
    }
    const worst = measured.reduce((a, b) => ((b.actual ?? 0) > (a.actual ?? 0) ? b : a));
    const pattern = BUDGET_RULES.find((rule) => rule.id === id)?.metric ?? worst.metric;
    rows.push({
      ...worst,
      metric: `${pattern} (${measured.length} metrics; worst ${worst.metric})`,
    });
  }
  return rows;
}

export function renderMarkdown(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`# Load run: ${result.label}`, "");
  if (result.disclaimer) lines.push(`> **${result.disclaimer}**`, "");
  lines.push(
    `| | |`,
    `|---|---|`,
    `| Target | ${result.target.origin} (version ${result.target.version ?? "?"}, commit ${result.target.commit ?? "?"}) |`,
    `| Baseline round trip | ${fmt(result.target.baselineMs)} (fastest of 5 \`/api/health\` calls; included in every timing) |`,
    `| Profile / seed | ${result.profile} / ${result.seedScale} |`,
    `| Scenarios | ${result.scenarios.join(", ")} |`,
    `| When | ${result.startedAt} → ${result.finishedAt} (${(result.durationMs / 1000).toFixed(1)} s) |`,
    `| Load generator | ${result.machine.cpus} CPUs, load ${result.machine.loadavgStart.map((n) => n.toFixed(1)).join("/")} → ${result.machine.loadavgEnd.map((n) => n.toFixed(1)).join("/")}, Node ${result.machine.node} |`,
    `| Sign-ins | ${result.signIns.real} real, ${result.signIns.refreshes} token refreshes |`,
    `| Result | **${result.pass ? "PASS" : "FAIL"}** |`,
    "",
  );
  const crashed = Object.entries(result.scenarioErrors);
  if (crashed.length > 0) {
    lines.push("## Scenarios that stopped", "");
    for (const [name, error] of crashed) lines.push(`- **${name}**: ${error}`);
    lines.push("");
  }
  lines.push(
    "## Budget",
    "",
    "| Rule | Metric | Stat | Limit | Actual | Status |",
    "|---|---|---|---|---|---|",
  );
  for (const line of condensed(result.budget)) {
    const status = line.status === "pass" ? "pass" : "**FAIL**";
    lines.push(
      `| ${line.id} | \`${line.metric}\` | ${line.stat} | ${limitText(line)} | ${actualText(line)} | ${status} |`,
    );
  }
  const skipped = [
    ...new Set(result.budget.filter((l) => l.status === "not_measured").map((l) => l.id)),
  ];
  if (skipped.length > 0) lines.push("", `Not measured in this run: ${skipped.join(", ")}.`);
  lines.push(
    "",
    "## Timings",
    "",
    "| Metric | n | errors | p50 | p95 | p99 | max | max bytes |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const m of result.metrics) {
    const reasons = Object.entries(m.reasons)
      .map(([reason, n]) => `${reason}×${n}`)
      .join(", ");
    lines.push(
      `| \`${m.name}\` | ${m.count} | ${m.errors}${reasons ? ` (${reasons})` : ""} | ${fmt(m.p50)} | ${fmt(m.p95)} | ${fmt(m.p99)} | ${fmt(m.max)} | ${m.bytesMax === null ? "–" : m.bytesMax.toLocaleString("en-US")} |`,
    );
  }
  const counters = Object.entries(result.counters);
  if (counters.length > 0) {
    lines.push("", "## Counts", "", "| Counter | Value |", "|---|---:|");
    for (const [name, value] of counters) lines.push(`| \`${name}\` | ${value} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** Writes `summary.json` and `summary.md` into `dir`; returns their paths. */
export function writeResult(dir: string, result: RunResult): { json: string; markdown: string } {
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "summary.json");
  const markdown = join(dir, "summary.md");
  writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(markdown, renderMarkdown(result));
  return { json, markdown };
}
