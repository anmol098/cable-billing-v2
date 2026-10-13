/**
 * Billing run services (T-044; PLAN §8.2, §13; J-03; FR-009, FR-011, FR-012; D-13, D-16, D-25).
 *
 * | Service | Capability | What |
 * |---|---|---|
 * | `previewBillingRun` (`billing.preview`) | `billing.preview` (Owner, Staff; read) | The run computed read-only: counts, total, problems. |
 * | `startBillingRun` (`billing.start_run`) | `billing.run` (Owner; blocked in read-only mode) | Creates or restarts the period's run and queues its job. |
 * | `retryFailedItems` (`billing.retry_failed`) | `billing.run` | Re-runs only the run's `failed` items. |
 * | `missedRuns` (`billing.missed_runs`) | `billing.preview` | Periods whose run was skipped while read-only (D-25). |
 *
 * The services only decide and queue; the `billing.run` job (job.ts) does the billing, one
 * customer per transaction. Every status change and enqueue happens under the run row lock.
 */
import {
  type BillingRunTrigger,
  billingRunItems,
  billingRuns,
  customerBalances,
  invoices,
  ledgerEntries,
  type Tx,
} from "@cb/db";
import {
  buildInvoice,
  err,
  isPeriod,
  ok,
  type Paise,
  type Period,
  sumPaise,
  toPaise,
  period as toPeriod,
} from "@cb/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuditRecorder } from "../audit/audit";
import { readTenantMode } from "../authz/writable";
import { defineService } from "../context/service";
import { notFound, serviceError } from "../errors/errors";
import { loadBillingInputs } from "./inputs";
import { queueRunJob } from "./job";
import {
  type BillingRunRow,
  candidateCustomers,
  checkRunnablePeriod,
  ensureRun,
  isInProgress,
  lockRunById,
  reopenRun,
  toRunView,
} from "./runs";
import type {
  BillingPreview,
  BillingProblem,
  MissedRun,
  RetryFailedItemsResult,
  StartBillingRunResult,
} from "./types";

/** A billing period: `YYYY-MM-01` (an IST month). */
export const BillingPeriodInput = z
  .string()
  .refine((value) => isPeriod(value), { message: "period must be YYYY-MM-01" })
  .transform((value) => toPeriod(value));

export const PreviewBillingRunInput = z.object({ period: BillingPeriodInput });
export const StartBillingRunInput = z.object({ period: BillingPeriodInput });
export const RetryFailedItemsInput = z.object({
  runId: z.uuid().transform((value) => value.toLowerCase()),
});
export const MissedRunsInput = z.object({}).strict();

/** Customers read per page by the preview. */
const PREVIEW_PAGE_SIZE = 500;

async function auditRunChange(
  audit: AuditRecorder,
  run: BillingRunRow,
  action: string,
  extra: Record<string, unknown> = {},
) {
  await audit.record({
    action,
    entityType: "billing_run",
    entityId: run.id,
    after: { period: run.period, trigger: run.trigger, status: run.status, ...extra },
  });
}

/**
 * The run for `period`, computed read-only (PLAN §8.2 "Preview = the same function, executed
 * read-only"): the same candidates, the same inputs and T-040's `buildInvoice`, with the opening
 * balance from `customer_balances`. Nothing is written or locked. In read-only mode the preview
 * still works (the Owner previews missed runs, D-25) and says so in `tenantMode`.
 */
export const previewBillingRun = defineService({
  name: "billing.preview",
  capability: "billing.preview",
  input: PreviewBillingRunInput,
  async run({ ctx, input, tx, now }) {
    const { operatorId } = ctx;
    const { period } = input;
    const runnable = await checkRunnablePeriod(tx, operatorId, period, now);
    if (!runnable.ok) return runnable;
    const [runRow] = await tx
      .select()
      .from(billingRuns)
      .where(and(eq(billingRuns.operatorId, operatorId), eq(billingRuns.period, period)));

    let customerCount = 0;
    let willBillCount = 0;
    let alreadyBilledCount = 0;
    let nothingToBillCount = 0;
    const charges: Paise[] = [];
    const problems: BillingProblem[] = [];
    let cursor: string | null = null;
    for (;;) {
      const ids = await candidateCustomers(tx, {
        operatorId,
        period,
        runId: null,
        mode: "run",
        cursor,
        limit: PREVIEW_PAGE_SIZE,
      });
      if (ids.length === 0) break;
      cursor = ids[ids.length - 1] ?? null;
      customerCount += ids.length;
      const page = await previewPage(tx, operatorId, period, ids);
      for (const id of ids) {
        const entry = page.get(id);
        if (!entry || entry.kind === "nothing") nothingToBillCount += 1;
        else if (entry.kind === "billed") alreadyBilledCount += 1;
        else if (entry.kind === "problem") problems.push(entry.problem);
        else {
          willBillCount += 1;
          charges.push(entry.chargesPaise);
        }
      }
      if (ids.length < PREVIEW_PAGE_SIZE) break;
    }
    const preview: BillingPreview = {
      period,
      tenantMode: await readTenantMode(tx),
      run: runRow ? toRunView(runRow) : null,
      customerCount,
      willBillCount,
      totalChargesPaise: sumPaise(charges),
      alreadyBilledCount,
      nothingToBillCount,
      problems,
    };
    return ok(preview);
  },
});

type PreviewEntry =
  | { kind: "billed" }
  | { kind: "nothing" }
  | { kind: "invoice"; chargesPaise: Paise }
  | { kind: "problem"; problem: BillingProblem };

async function previewPage(
  tx: Tx,
  operatorId: string,
  period: Period,
  ids: string[],
): Promise<Map<string, PreviewEntry>> {
  const result = new Map<string, PreviewEntry>();
  const billed = await tx
    .select({ customerId: invoices.customerId })
    .from(invoices)
    .where(
      and(
        eq(invoices.operatorId, operatorId),
        inArray(invoices.customerId, ids),
        eq(invoices.period, period),
        eq(invoices.kind, "regular"),
      ),
    );
  for (const row of billed) result.set(row.customerId, { kind: "billed" });
  const balances = new Map<string, Paise>();
  for (const row of await tx
    .select({ customerId: customerBalances.customerId, balance: customerBalances.balancePaise })
    .from(customerBalances)
    .where(
      and(eq(customerBalances.operatorId, operatorId), inArray(customerBalances.customerId, ids)),
    )) {
    balances.set(row.customerId, toPaise(row.balance));
  }
  const ledger = new Map<string, Paise>();
  for (const row of await tx
    .select({
      customerId: ledgerEntries.customerId,
      total: sql<string>`sum(${ledgerEntries.amountPaise})`,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.operatorId, operatorId), inArray(ledgerEntries.customerId, ids)))
    .groupBy(ledgerEntries.customerId)) {
    ledger.set(row.customerId, toPaise(row.total));
  }
  const inputs = await loadBillingInputs(tx, operatorId, ids, period);
  for (const id of ids) {
    if (result.has(id)) continue;
    const balancePaise = balances.get(id) ?? (0 as Paise);
    const ledgerPaise = ledger.get(id) ?? (0 as Paise);
    if (balancePaise !== ledgerPaise) {
      result.set(id, {
        kind: "problem",
        problem: {
          customerId: id,
          reason: "balance_mismatch",
          details: { balancePaise, ledgerPaise },
        },
      });
      continue;
    }
    const input = inputs.get(id);
    const built = buildInvoice({
      customer: { id },
      assignments: input?.assignments ?? [],
      pendingAdjustments: input?.pendingAdjustments ?? [],
      openingBalancePaise: balancePaise,
      period,
    });
    if (!built.ok) {
      const details = built.error.details ?? {};
      const reason = typeof details.reason === "string" ? details.reason : "invalid_input";
      result.set(id, { kind: "problem", problem: { customerId: id, reason, details } });
    } else if (built.value.outcome === "nothing_to_bill") {
      result.set(id, { kind: "nothing" });
    } else {
      result.set(id, { kind: "invoice", chargesPaise: built.value.chargesPaise });
    }
  }
  return result;
}

/**
 * Starts the period's run by hand (Owner, D-16): a new run, or a finished / skipped one again
 * (the same row: UNIQUE per period; billed customers are skipped, so running twice never bills
 * twice, PRD §15 #4). This is also how a missed run is billed after reactivation (D-25). While the
 * run is pending or running, nothing new starts (`already_running`; a lost job is re-queued).
 * Refused in read-only mode (TENANT_READ_ONLY, D-13) and for periods `checkRunnablePeriod` refuses.
 */
export const startBillingRun = defineService({
  name: "billing.start_run",
  capability: "billing.run",
  input: StartBillingRunInput,
  async run({ ctx, input, tx, audit, now }) {
    const { operatorId } = ctx;
    const runnable = await checkRunnablePeriod(tx, operatorId, input.period, now);
    if (!runnable.ok) return runnable;
    const trigger: BillingRunTrigger = "manual";
    const { row, created } = await ensureRun(tx, {
      operatorId,
      period: input.period,
      trigger,
      actorId: ctx.userId,
      now,
    });
    if (!created && isInProgress(row.status)) {
      const requeued = await queueRunJob(tx, row, { mode: "run", now, onlyIfIdle: true });
      if (requeued) await auditRunChange(audit, row, "billing.run_requeued");
      else audit.skip("no_change");
      const result: StartBillingRunResult = { outcome: "already_running", run: toRunView(row) };
      return ok(result);
    }
    const run = created ? row : await reopenRun(tx, row.id, { trigger, actorId: ctx.userId, now });
    await queueRunJob(tx, run, { mode: "run", now, onlyIfIdle: false });
    await auditRunChange(audit, run, "billing.run_started", {
      previous_status: created ? null : row.status,
    });
    const result: StartBillingRunResult = { outcome: "started", run: toRunView(run) };
    return ok(result);
  },
});

/**
 * Re-runs only the run's `failed` items (PLAN §8.2 "Retry re-runs only failed items", J-03;
 * Owner only). A skipped run is not retried (start it instead: its customers were never looked
 * at). NOT_FOUND for another tenant's run.
 */
export const retryFailedItems = defineService({
  name: "billing.retry_failed",
  capability: "billing.run",
  input: RetryFailedItemsInput,
  async run({ ctx, input, tx, audit, now }) {
    const run = await lockRunById(tx, ctx.operatorId, input.runId);
    if (!run) return err(notFound());
    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(billingRunItems)
      .where(
        and(
          eq(billingRunItems.operatorId, ctx.operatorId),
          eq(billingRunItems.runId, run.id),
          eq(billingRunItems.outcome, "failed"),
        ),
      );
    const failedCount = counted?.n ?? 0;
    if (isInProgress(run.status)) {
      audit.skip("no_change");
      const result: RetryFailedItemsResult = {
        outcome: "already_running",
        run: toRunView(run),
        failedCount,
      };
      return ok(result);
    }
    if (run.status === "skipped") {
      return err(
        serviceError("CONFLICT", "A skipped run is started, not retried", {
          reason: "run_skipped",
        }),
      );
    }
    if (failedCount === 0) {
      audit.skip("no_change");
      const result: RetryFailedItemsResult = {
        outcome: "nothing_to_retry",
        run: toRunView(run),
        failedCount,
      };
      return ok(result);
    }
    const reopened = await reopenRun(tx, run.id, { now });
    await queueRunJob(tx, reopened, { mode: "retry", now, onlyIfIdle: false });
    await auditRunChange(audit, reopened, "billing.run_retry_started", {
      failed_count: failedCount,
    });
    const result: RetryFailedItemsResult = {
      outcome: "started",
      run: toRunView(reopened),
      failedCount,
    };
    return ok(result);
  },
});

/**
 * The periods whose run was skipped because the tenant was read-only (PLAN §13 "Missed bill
 * runs", D-25), oldest first. They are never billed automatically: the Owner previews them and
 * starts them with `startBillingRun`, after which they leave this list.
 */
export const missedRuns = defineService({
  name: "billing.missed_runs",
  capability: "billing.preview",
  input: MissedRunsInput,
  async run({ ctx, tx }) {
    const rows = await tx
      .select()
      .from(billingRuns)
      .where(and(eq(billingRuns.operatorId, ctx.operatorId), eq(billingRuns.status, "skipped")))
      .orderBy(asc(billingRuns.period));
    const result: MissedRun[] = rows.map((row) => ({
      runId: row.id,
      period: toPeriod(row.period),
      skipReason: row.skipReason,
      skippedAt: row.finishedAt,
    }));
    return ok(result);
  },
});
