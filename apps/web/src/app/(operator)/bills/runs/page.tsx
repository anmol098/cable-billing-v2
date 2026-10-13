/**
 * `/bills/runs?month=YYYY-MM-01[&preview=1]` (T-047, PLAN §8.2, §12.1, J-03; D-13, D-16, D-25):
 * one month's bills. What the run did (or that it hasn't run), "Preview" (Owner and Staff: the
 * run computed read-only, "N customers will get a bill, total ₹X, K problems" with the problem
 * list), and for the Owner only "Make bills now" / "Try problems again" (the services refuse
 * everyone else too). While bills are being made the page refreshes itself. Missed months (the
 * app was view-only) are listed so the Owner can check and make them by hand.
 */

import {
  billingCustomerLabels,
  billingMonths,
  billingRunProblems,
  can as canDo,
  missedRuns,
  previewBillingRun,
} from "@cb/core";
import { type DisplayLocale, type Period, periodOfInstant } from "@cb/domain";
import { Button, PAGE_ACTION_CLEARANCE } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/bills/auto-refresh";
import {
  isRunInProgress,
  monthText,
  pickMonth,
  type RunState,
  registerHref,
  runsHref,
  rupees,
  type Translate,
} from "@/components/bills/format";
import {
  MissedRunsCard,
  MonthNav,
  PausedNotice,
  PreviewSummary,
  ProblemList,
  type ProblemRowData,
  RunSummary,
} from "@/components/bills/parts";
import { RunActions } from "@/components/bills/run-actions";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { retryRunAction, startRunAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.bills_runs") };
}

export default async function BillRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getTenantContext();
  const can = roleCan(ctx.role);
  if (!can("billing.preview")) notFound();
  const runtime = getServerRuntime();
  const params = await searchParams;
  const current = periodOfInstant(runtime.now());
  const base = await billingMonths.call(runtime, ctx, { from: current, to: current });
  if (!base.ok) throw new Error(`bills months: ${base.error.code}`);
  const first = base.value.firstPeriod;
  const period: Period = pickMonth(params.month, current, first);
  const wantsPreview = params.preview === "1";

  const [monthResult, missed, shell, tr, locale] = await Promise.all([
    period === current
      ? Promise.resolve(base)
      : billingMonths.call(runtime, ctx, { from: period, to: period }),
    missedRuns.call(runtime, ctx, {}),
    getTranslations("shell"),
    getTranslations("bills"),
    getLocale(),
  ]);
  if (!monthResult.ok) throw new Error(`bills month: ${monthResult.error.code}`);
  if (!missed.ok) throw new Error(`missed runs: ${missed.error.code}`);
  const t = tr as unknown as Translate;
  const displayLocale = locale as DisplayLocale;
  const month = monthResult.value.months[0];
  const run = month?.run ?? null;
  const state: RunState = run?.status ?? "none";
  const inProgress = isRunInProgress(state);
  const readOnly = base.value.tenantMode === "read_only";
  const isOwner = canDo(ctx.role, "billing.run");
  const monthLabel = monthText(period, displayLocale);

  // The run's own problems (failed items), with names.
  let runProblems: ProblemRowData[] = [];
  let runProblemTotal = 0;
  if (run && run.failedCount > 0) {
    const problems = await billingRunProblems.call(runtime, ctx, { runId: run.id });
    if (!problems.ok) throw new Error(`run problems: ${problems.error.code}`);
    runProblemTotal = problems.value.failedCount;
    runProblems = problems.value.problems.map((p) => ({
      key: `run-${p.customer.id}`,
      customerId: p.customer.id,
      name: p.customer.name,
      code: p.customer.code,
      areaName: p.customer.areaName,
      reason: p.reason,
      attempts: p.attempts,
    }));
  }

  // The preview, on request (it computes the whole run read-only).
  let preview = null;
  let previewError: string | null = null;
  let previewProblems: ProblemRowData[] = [];
  if (wantsPreview) {
    const result = await previewBillingRun.call(runtime, ctx, { period });
    if (result.ok) {
      preview = result.value;
      const ids = preview.problems.slice(0, 500).map((p) => p.customerId);
      const labels = ids.length
        ? await billingCustomerLabels.call(runtime, ctx, { customerIds: ids })
        : null;
      const byId = new Map((labels?.ok ? labels.value : []).map((l) => [l.id, l]));
      previewProblems = preview.problems.slice(0, 500).map((p) => {
        const label = byId.get(p.customerId);
        return {
          key: `preview-${p.customerId}`,
          customerId: p.customerId,
          name: label?.name ?? "",
          code: label?.code ?? "",
          areaName: label?.areaName ?? null,
          reason: p.reason,
        };
      });
    } else {
      previewError = result.error.code === "VALIDATION" ? tr("error.period") : tr("error.generic");
    }
  }

  const canStart = isOwner && !readOnly && !inProgress;
  const retryRunId =
    isOwner && !readOnly && run && !inProgress && run.status !== "skipped" && run.failedCount > 0
      ? run.id
      : null;
  const otherMissed = missed.value.filter((m) => m.period !== period);

  return (
    <div className={`flex flex-col gap-6 ${PAGE_ACTION_CLEARANCE}`}>
      <ShellPageHeader
        title={shell("routes.bills_runs")}
        description={tr("runs_description")}
        {...(wantsPreview
          ? {}
          : {
              action: (
                <Button asChild size="lg" icon="show" variant={canStart ? "secondary" : "primary"}>
                  <Link href={runsHref(period, { preview: true })}>
                    {tr("preview.button", { month: monthLabel })}
                  </Link>
                </Button>
              ),
            })}
      />
      <MonthNav
        t={t}
        period={period}
        current={current}
        first={first}
        locale={displayLocale}
        href={(p) => runsHref(p, { preview: wantsPreview })}
      />
      {readOnly ? <PausedNotice t={t} isOwner={ctx.role === "owner"} /> : null}

      <RunSummary t={t} run={run} period={period} locale={displayLocale} />
      {inProgress ? <AutoRefresh /> : null}

      {isOwner ? (
        <RunActions
          period={period}
          monthLabel={monthLabel}
          canStart={canStart}
          retryRunId={retryRunId}
          failedCount={run?.failedCount ?? 0}
          preview={
            preview
              ? { count: preview.willBillCount, amount: rupees(preview.totalChargesPaise) }
              : null
          }
          start={startRunAction}
          retry={retryRunAction}
        />
      ) : null}

      <ProblemList t={t} id="run-problems" rows={runProblems} total={runProblemTotal} />

      {previewError ? (
        <p role="alert" className="text-base text-danger">
          {previewError}
        </p>
      ) : null}
      {preview ? (
        <>
          <PreviewSummary
            t={t}
            preview={preview}
            locale={displayLocale}
            hideHref={runsHref(period)}
          />
          <ProblemList
            t={t}
            id="preview-problems"
            rows={previewProblems}
            total={preview.problems.length}
          />
        </>
      ) : null}

      {month && month.billCount > 0 ? (
        <div>
          <Button asChild variant="secondary" icon="bill">
            <Link href={registerHref(period)}>{tr("see_bills", { month: monthLabel })}</Link>
          </Button>
        </div>
      ) : null}

      <MissedRunsCard t={t} missed={otherMissed} locale={displayLocale} />
    </div>
  );
}
