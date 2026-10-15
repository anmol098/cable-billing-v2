/**
 * `billing`: the monthly billing run at the target's size, driven exactly as production drives it
 * (PLAN §14): the `billing-scheduler` cron queues a run per billable tenant, then `job-worker`
 * invocations (each ≤ 240 s of work, Vercel maxDuration 300 s) bill customers until the queue is
 * empty. Measures the wall time from the scheduler call to an empty queue, every worker invocation,
 * and failed jobs.
 *
 * Needs the target's `CRON_SECRET` (`LOAD_CRON_SECRET`), and a month the target has not billed yet:
 * seed with `--as-of <last day of the previous month>` (docs/testing/performance.md §4). The
 * scheduler's catch-up rule then queues the current month for every tenant. Each run is one-shot
 * per seeded database: a second run finds every tenant `done`.
 */
import type { RunContext } from "../context";
import { jsonOf, reasonOf, Session } from "../http";

interface ScheduleReport {
  readonly period: string;
  readonly billingDay: boolean;
  readonly tenants: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly errors: number;
}

interface WorkerReport {
  readonly claimed: number;
  readonly succeeded: number;
  readonly continued: number;
  readonly retried: number;
  readonly failed: number;
  readonly stoppedBy: "queue_empty" | "budget" | "max_jobs";
  readonly durationMs: number;
}

export class BillingSetupError extends Error {
  override readonly name = "BillingSetupError";
}

export async function runBilling(ctx: RunContext): Promise<void> {
  if (!ctx.cronSecret) {
    throw new BillingSetupError(
      "the billing scenario needs the target's CRON_SECRET (LOAD_CRON_SECRET)",
    );
  }
  const cron = new Session(ctx.baseUrl, ctx.recorder, {
    defaultHeaders: { authorization: `Bearer ${ctx.cronSecret}` },
  });
  const started = performance.now();
  const scheduled = await cron.request("/api/cron/billing-scheduler", {
    metric: "billing.scheduler",
    timeoutMs: 330_000,
  });
  const schedule = scheduled.ok ? jsonOf<ScheduleReport>(scheduled) : undefined;
  if (!schedule) {
    throw new BillingSetupError(`billing-scheduler answered ${reasonOf(scheduled)}`);
  }
  const queued =
    (schedule.outcomes.queued ?? 0) +
    (schedule.outcomes.requeued ?? 0) +
    (schedule.outcomes.in_progress ?? 0);
  ctx.log(
    `  scheduler: period ${schedule.period}, ${schedule.tenants} tenants, outcomes ${JSON.stringify(schedule.outcomes)}`,
  );
  ctx.recorder.count("billing.tenants", schedule.tenants);
  ctx.recorder.count("billing.runs_queued", queued);
  if (queued === 0) {
    ctx.recorder.count("billing.nothing_to_bill");
    ctx.log(
      "  nothing to bill: every tenant's run for this month is done. Re-seed with --as-of <last day of the previous month>.",
    );
    return;
  }

  const deadline = started + ctx.profile.billingTimeoutMinutes * 60_000;
  const pollMs = ctx.billingPollMs ?? 5_000;
  let finished = false;
  let invocations = 0;
  let final: ScheduleReport | undefined;
  while (!finished && performance.now() < deadline) {
    const reports = await Promise.all(
      Array.from({ length: ctx.billingWorkers }, async () => {
        const answer = await cron.request("/api/cron/job-worker", {
          metric: "billing.worker",
          timeoutMs: 330_000,
        });
        return answer.ok ? jsonOf<WorkerReport>(answer) : undefined;
      }),
    );
    invocations += reports.length;
    for (const report of reports) {
      if (!report) continue;
      ctx.recorder.count("billing.jobs_succeeded", report.succeeded);
      ctx.recorder.count("billing.jobs_continued", report.continued);
      ctx.recorder.count("billing.jobs_retried", report.retried);
      ctx.recorder.count("billing.failed_jobs", report.failed);
    }
    // Nothing left to claim now. A job waiting on a retry backoff is not claimable yet, so ask the
    // scheduler (idempotent) whether any run is still unfinished before calling it done.
    const empty = reports.some((r) => r?.stoppedBy === "queue_empty" && r.claimed === 0);
    if (empty) {
      const check = await cron.request("/api/cron/billing-scheduler", {
        metric: "billing.scheduler",
      });
      final = check.ok ? jsonOf<ScheduleReport>(check) : undefined;
      const open = (final?.outcomes.in_progress ?? 0) + (final?.outcomes.requeued ?? 0);
      finished = final !== undefined && open === 0;
    }
    if (!finished && (empty || reports.every((report) => report === undefined))) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  const wallMs = performance.now() - started;
  ctx.recorder.gauge("billing.run.wall", wallMs, finished);
  ctx.recorder.count("billing.worker_invocations", invocations);
  const done = final?.outcomes.done ?? 0;
  const expected = (schedule.outcomes.done ?? 0) + queued;
  ctx.recorder.count("billing.runs_done", done);
  ctx.recorder.count("billing.runs_not_done", Math.max(0, expected - done));
  ctx.log(
    `  ${finished ? "finished" : "TIMED OUT"} after ${(wallMs / 1000).toFixed(1)} s and ${invocations} worker invocation(s); runs done: ${done} of ${expected} expected`,
  );
}
