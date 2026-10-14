/**
 * Client-safe helpers of the import page (T-084): running the import steps a few at a time,
 * merging their results into the preview, counting, and downloading a generated file.
 */
import type { ImportLine, ImportLineResult, ImportLineStatus } from "@cb/core";
import type { ImportFileKind, StepResponse } from "./types";

export type StatusCounts = Record<ImportLineStatus, number>;

/** Customers (groups) per status, and connections that are ready or added. */
export function countCustomers(results: readonly ImportLineResult[]): {
  customers: StatusCounts;
  connections: number;
} {
  const customers: StatusCounts = { ready: 0, created: 0, exists: 0, problem: 0 };
  const seen = new Set<number>();
  let connections = 0;
  for (const result of results) {
    if (!seen.has(result.group)) {
      seen.add(result.group);
      customers[result.status] += 1;
    }
    if (result.hasConnection && (result.status === "ready" || result.status === "created")) {
      connections += 1;
    }
  }
  return { customers, connections };
}

export interface StepRunOptions {
  readonly steps: readonly (readonly number[])[];
  readonly lines: ReadonlyMap<number, ImportLine>;
  readonly parallel: number;
  readonly importStep: (lines: ImportLine[]) => Promise<StepResponse>;
  /** Called with each step's line results as soon as it finishes. */
  readonly onStep: (results: readonly ImportLineResult[]) => void;
}

/**
 * Sends the steps, `parallel` at a time. Stops starting new steps after the first failure (a
 * refused step, a network error) and returns why; the lines of steps that did not run stay
 * "ready" (not added), and uploading the same file again adds them (existing codes are skipped).
 */
export async function runSteps(options: StepRunOptions): Promise<"ok" | "stopped" | "read_only"> {
  const queue = [...options.steps];
  let outcome: "ok" | "stopped" | "read_only" = "ok";
  const worker = async () => {
    for (let step = queue.shift(); step && outcome === "ok"; step = queue.shift()) {
      const lines = step
        .map((n) => options.lines.get(n))
        .filter((line): line is ImportLine => line !== undefined);
      let response: StepResponse;
      try {
        response = await options.importStep(lines);
      } catch {
        outcome = "stopped";
        return;
      }
      if (!response.ok) {
        outcome = response.error === "read_only" ? "read_only" : "stopped";
        return;
      }
      options.onStep(response.result.lines);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.parallel) }, worker));
  return outcome;
}

/**
 * Merges a step's results into the page's results. A step numbers its customers from 0, so the
 * preview's `group` is kept (it is what ties a customer's lines together on the page).
 */
export function mergeResults(
  current: ReadonlyMap<number, ImportLineResult>,
  step: readonly ImportLineResult[],
): Map<number, ImportLineResult> {
  const next = new Map(current);
  for (const result of step) {
    const before = current.get(result.line);
    next.set(result.line, before ? { ...result, group: before.group } : result);
  }
  return next;
}

/** The file name from `Content-Disposition` (`filename*` first). */
export function fileNameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through to the plain name
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

/** Asks the server for the "lines with problems" file and saves it. */
export async function downloadProblemFile(
  kind: ImportFileKind,
  lines: readonly { line: ImportLine; result: ImportLineResult }[],
): Promise<boolean> {
  const response = await fetch("/customers/import/problems", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind,
      lines: lines.map(({ line, result }) => ({
        line: line.line,
        values: line.values,
        problems: result.problems,
      })),
    }),
  });
  if (!response.ok) return false;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileNameFrom(response.headers.get("content-disposition"), `problems.${kind}`);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
